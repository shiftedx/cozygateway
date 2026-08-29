import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliIo, type CliRuntime } from "../src/cli.ts";
import type { NetworkModeAdapter, OnboardingIo, PreparedEndpoint } from "../src/network-onboarding.ts";
import type { NetworkOnboardingState, NetworkOnboardingStateProjection } from "../src/onboarding-state.ts";
import { openStorage, Storage, type OnboardingMode } from "../src/storage.ts";
import {
  AdvancedModeAdapter,
  WindowsLanSafetyAdapter,
  WindowsTailscaleAdapter,
  createWindowsOnboardingController,
  reconcileWindowsOwnedNetworkState,
} from "../src/windows-onboarding.ts";
import type { WindowsNetworkSafety } from "../src/windows-helper.ts";
import type { WindowsLanInventory } from "../src/lan.ts";
import type { TailscaleCliRunner } from "../src/tailscale-cli.ts";
import type { OperatorPhoneStatus } from "../src/operator-onboarding.ts";
import { SqliteLanOwnershipStore, type LanListenerOwnership } from "../src/lan-mode.ts";
import {
  compareAndSwapManagedListener,
  readManagedListenerSnapshot,
} from "../src/configure.ts";
import { TailscaleModeAdapter } from "../src/tailscale-mode.ts";
import { WindowsHelperClient, type WindowsHelperRunner } from "../src/windows-helper.ts";

const roots: string[] = [];
const tailscaleFixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./fixtures/tailscale/${name}`, import.meta.url)), "utf8",
);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cozygateway-windows-controller-"));
  roots.push(root);
  const localRoot = join(root, "local");
  const hermesRoot = join(root, "hermes");
  mkdirSync(localRoot, { recursive: true });
  mkdirSync(hermesRoot, { recursive: true });
  const configPath = join(localRoot, "cozygateway.config.json");
  const dbPath = join(localRoot, "gateway.sqlite");
  writeFileSync(configPath, `${JSON.stringify({
    name: "controller-test", host: "127.0.0.1", port: 18787, dbPath,
    onboardingControlTokenFile: join(localRoot, "operator-control.token"),
    turnTimeoutSeconds: 0,
    hermes: {
      url: "ws://127.0.0.1:9119/api/ws", tokenEnv: "HERMES_CONTROL",
      profiles: { default: { tokenEnv: "HERMES_ATTACH" } },
    },
  }, null, 2)}\n`);
  writeFileSync(join(localRoot, "install-state"),
    `profiles=default\nhermes_root=${hermesRoot}\nhermes_bin=${join(hermesRoot, "hermes.exe")}\n`);
  writeFileSync(join(hermesRoot, ".env"),
    "COZYGATEWAY_URL=http://127.0.0.1:18787\nCOZYGATEWAY_TOKEN=do-not-print\n");
  const storage = openStorage(dbPath);
  storage.beginGatewayBoot({
    bootGeneration: "boot-1", verificationEpoch: "epoch-0",
    canonicalOrigin: "http://127.0.0.1:18787", durableFingerprint: "initial", startedAt: 1,
  });
  return { root, localRoot, configPath, storage };
}

function stateProjection(initial?: NetworkOnboardingState): NetworkOnboardingStateProjection & { current?: NetworkOnboardingState } {
  return {
    current: initial,
    async read() { return this.current; },
    async write(state) { this.current = structuredClone(state); },
  };
}

function cliIo(answers: string[] = []): CliIo {
  return {
    interactive: true,
    question: vi.fn(async () => answers.shift() ?? ""),
    close: vi.fn(),
  };
}

function onboardingIo(mode: OnboardingMode): OnboardingIo {
  return {
    chooseNetworkMode: vi.fn(async () => mode),
    showNetworkDisclosure: vi.fn(async () => undefined),
    showPhoneConnectionCheck: vi.fn(),
    showAuthoritativePhrase: vi.fn(),
    confirmPhone: vi.fn(async () => "yes"),
  };
}

function phoneControl(storage: Storage, clock: () => number, namespace = "") {
  let sequence = 0;
  const live = new Map<string, { phrase: string; expiresAt: number }>();
  return {
    begin: vi.fn((mode: OnboardingMode, endpoint: { canonicalOrigin: string; durableFingerprint: string }) => {
      sequence += 1;
      const now = clock();
      const context = storage.onboardingRuntimeContext();
      const verificationEpoch = `epoch-${sequence}`;
      storage.beginOperatorVerificationContext({
        ...endpoint, bootGeneration: context.bootGeneration, verificationEpoch, startedAt: now,
      });
      const sessionId = `session-${namespace}${sequence}`;
      const challengeId = `challenge-${namespace}${sequence}`;
      const capability = createHash("sha256").update(`${namespace}:${sequence}`).digest("base64url");
      const capabilityHash = createHash("sha256").update(capability).digest("hex");
      const expiresAt = now + 600_000;
      const proof = {
        ...endpoint, bootGeneration: context.bootGeneration, verificationEpoch,
        sessionId, mode, createdAt: now,
      };
      expect(storage.beginSetupSession(proof).outcome).toBe("created");
      expect(storage.createVerificationChallenge({
        ...proof, challengeId, capabilityHash, phrase: "silver maple", expiresAt,
      }).outcome).toBe("created");
      const transition = { ...endpoint, bootGeneration: context.bootGeneration, verificationEpoch, capabilityHash, now };
      storage.recordVerificationProbe(transition);
      storage.recordPhoneConfirmation(transition);
      live.set(challengeId, { phrase: "silver maple", expiresAt });
      return {
        state: "pending" as const, challengeId, sessionId,
        verificationUrl: `${endpoint.canonicalOrigin}/cozy/onboarding/${capability}`, expiresAt,
      };
    }),
    status: vi.fn(async (challengeId: string): Promise<OperatorPhoneStatus> => {
      const proof = live.get(challengeId);
      return proof === undefined
        ? { state: "not_found" as const }
        : { state: "confirmed" as const, phrase: proof.phrase, expiresAt: proof.expiresAt };
    }),
    cancel: vi.fn(async (challengeId: string) => {
      live.delete(challengeId);
      storage.cancelVerificationChallenge(challengeId, clock());
      return { state: "cancelled" as const };
    }),
  };
}

function runtime() {
  const value: CliRuntime = {
    restartHermesProfile: vi.fn(async () => undefined),
    waitForGatewayReady: vi.fn(async () => undefined),
  };
  return value;
}

function helper(inventory: WindowsLanInventory) {
  return {
    protectPath: vi.fn(async () => undefined),
    adapterInventory: vi.fn(async () => structuredClone(inventory)),
    inspectNetworkSafety: vi.fn(async (): Promise<WindowsNetworkSafety> => ({
      networkCategory: "private" as const,
      firewallEnabled: true,
      defaultInboundAction: "block" as const,
    })),
    discoverTailscale: vi.fn(async () => ({
      state: "ready" as const, cliPath: "C:\\Program Files\\Tailscale\\tailscale.exe",
      daemonPath: "C:\\Program Files\\Tailscale\\tailscaled.exe",
    })),
    installTailscale: vi.fn(async () => undefined),
    setPreference: vi.fn(async () => undefined),
    openBrowser: vi.fn(async () => undefined),
  };
}

function installedCleanupHelper(): WindowsHelperClient {
  const runner: WindowsHelperRunner = async (_file, args) => {
    const command = args.at(-1)!;
    const result = command === "discover-tailscale"
      ? {
          state: "ready", cliPath: "C:\\Program Files\\Tailscale\\tailscale.exe",
          daemonPath: "C:\\Program Files\\Tailscale\\tailscaled.exe",
        }
      : command === "adapter-inventory"
        ? structuredClone(oneLan)
        : command === "inspect-network-safety"
          ? { networkCategory: "private", firewallEnabled: true, defaultInboundAction: "block" }
          : { applied: true };
    return {
      exitCode: 0,
      stdout: JSON.stringify({ schemaVersion: 1, ok: true, command, result }),
      stderr: "",
    };
  };
  return new WindowsHelperClient({
    helperPath: "C:\\CozyGateway\\bin\\cozygateway-windows-helper.ps1",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    runner,
  });
}

function reconcileInstalledNetworkState(
  configPath: string,
  hostRuntime: CliRuntime,
  signal?: AbortSignal,
): Promise<void> {
  return reconcileWindowsOwnedNetworkState(
    configPath, hostRuntime, signal, { helper: installedCleanupHelper() },
  );
}

const oneLan: WindowsLanInventory = {
  schemaVersion: 1,
  adapters: [{
    id: "ethernet", displayName: "Trusted Ethernet", kind: "ethernet", hardwareInterface: true,
    status: "up", ipv4Addresses: ["192.168.1.20"],
  }],
};

function dependencies(storage: Storage, inventory: WindowsLanInventory, control: ReturnType<typeof phoneControl>, clock: () => number) {
  return {
    storage,
    control,
    helper: helper(inventory),
    state: stateProjection(),
    health: vi.fn(async () => ({ ok: true, attachReady: true })),
    websocket: vi.fn(async () => true),
    tlsProbe: vi.fn(async (host: string) => ({ authorized: true, dnsNames: [host], alpn: "http/1.1" as const })),
    preflightListener: vi.fn(async () => undefined),
    now: clock,
    delay: vi.fn(async () => undefined),
    createSetupCode: vi.fn(() => "COZY-1234"),
    renderPairingOutput: vi.fn((input: { setupCode: string }) => ({
      setupCode: input.setupCode, payloadJson: "{}", terminalOutput: "pairing\n",
    })),
    writePairingOutput: vi.fn(),
  };
}

describe("createWindowsOnboardingController composition", () => {
  it("uses the injected installed helper during cross-platform cleanup", async () => {
    const { configPath, storage } = fixture();
    storage.close();
    const injected = installedCleanupHelper();
    const protect = vi.spyOn(injected, "protectPath");
    vi.spyOn(TailscaleModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);
    vi.spyOn((await import("../src/lan-mode.ts")).LanModeAdapter.prototype, "reconcileOwned")
      .mockResolvedValue(undefined);
    vi.spyOn(AdvancedModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);

    await expect(reconcileWindowsOwnedNetworkState(
      configPath, runtime(), undefined, { helper: injected },
    )).resolves.toBeUndefined();
    expect(protect).toHaveBeenCalledWith(
      dirname(dirname(configPath)), join(dirname(configPath), "gateway.sqlite"), expect.any(AbortSignal),
    );
  });

  it("forwards durable reconciliation through Windows wrappers", async () => {
    const { configPath, storage } = fixture();
    const delegate: NetworkModeAdapter = {
      mode: "tailscale",
      prepare: vi.fn(),
      inspect: vi.fn(),
      rollbackOwned: vi.fn(async () => undefined),
      reconcileOwned: vi.fn(async () => undefined),
    };
    const hostRuntime = runtime();
    const hostHelper = helper(oneLan);
    const signal = new AbortController().signal;
    const tailscale = new WindowsTailscaleAdapter({
      delegate, configPath, installRoot: dirname(dirname(configPath)), helper: hostHelper, runtime: hostRuntime,
    });
    const lan = new WindowsLanSafetyAdapter({ ...delegate, mode: "lan" }, hostHelper);
    const advanced = new AdvancedModeAdapter({
      configPath, installRoot: dirname(dirname(configPath)), helper: hostHelper, runtime: hostRuntime, storage,
    });

    await tailscale.reconcileOwned(signal);
    await lan.reconcileOwned(signal);
    await advanced.reconcileOwned(signal);

    expect(delegate.reconcileOwned).toHaveBeenNthCalledWith(1, signal);
    expect(delegate.reconcileOwned).toHaveBeenNthCalledWith(2, signal);
    expect(readFileSync(configPath, "utf8")).toContain('"host": "127.0.0.1"');
    storage.close();
  });

  it("constructs real installed adapters for bounded cleanup, closes SQLite, and propagates failure", async () => {
    const { configPath, storage } = fixture();
    storage.close();
    const events: string[] = [];
    const tailscale = vi.spyOn(TailscaleModeAdapter.prototype, "reconcileOwned")
      .mockImplementationOnce(async () => { events.push("tailscale"); })
      .mockImplementationOnce(async () => { throw new Error("tailscale cleanup failed"); });
    const lan = vi.spyOn((await import("../src/lan-mode.ts")).LanModeAdapter.prototype, "reconcileOwned")
      .mockImplementation(async () => { events.push("lan"); });
    const advanced = vi.spyOn(AdvancedModeAdapter.prototype, "reconcileOwned")
      .mockImplementation(async () => { events.push("advanced"); });
    const close = vi.spyOn(Storage.prototype, "close");
    vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);

    await expect(reconcileInstalledNetworkState(configPath, runtime())).resolves.toBeUndefined();
    expect(events).toEqual(["tailscale", "lan", "advanced"]);
    expect(close).toHaveBeenCalledTimes(1);

    await expect(reconcileInstalledNetworkState(configPath, runtime())).rejects.toThrow("tailscale cleanup failed");
    expect(lan).toHaveBeenCalledTimes(2);
    expect(advanced).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(tailscale).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ reason: "not_running" }, "tailscale_not_running"],
    [{ reason: "not_installed" }, "tailscale_not_running"],
    [{ reason: "status_unavailable", detail: "command_failed" }, "tailscale_not_running"],
    [{ reason: "logged_out" }, "logged_out"],
    [{ reason: "unsupported_install" }, "old_version"],
    [{ reason: "unsupported_version" }, "old_version"],
    [{ reason: "tailscale_legacy_unsupported" }, "tailscale_legacy_unsupported"],
    [{ reason: "tailscale_service_mismatch" }, "tailscale_service_mismatch"],
    [{ reason: "tailscale_signature_invalid" }, "tailscale_signature_invalid"],
    [{ reason: "tailscale_publisher_invalid" }, "tailscale_signature_invalid"],
    [{ reason: "tailscale_prerequisite_disabled" }, "tailscale_prerequisite_disabled"],
  ] as const)("maps cleanup failure %o to the safe diagnostic %s", async (failure, code) => {
    const { configPath, storage } = fixture();
    storage.close();
    vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);
    vi.spyOn(TailscaleModeAdapter.prototype, "reconcileOwned").mockRejectedValue(Object.assign(new Error("fixture"), failure));
    vi.spyOn((await import("../src/lan-mode.ts")).LanModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);
    vi.spyOn(AdvancedModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);

    await expect(reconcileInstalledNetworkState(configPath, runtime())).rejects.toMatchObject({ code });
  });

  it("settles each timed-out adapter before attempting the next and closing SQLite", async () => {
    vi.useFakeTimers();
    const { configPath, storage } = fixture();
    storage.close();
    const events: string[] = [];
    vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);
    vi.spyOn(TailscaleModeAdapter.prototype, "reconcileOwned").mockImplementation(async (signal) => {
      events.push("tailscale:attempted");
      await new Promise<void>((resolve) => {
        const abort = () => {
          events.push("tailscale:aborted");
          setTimeout(() => { events.push("tailscale:settled"); resolve(); }, 1_000);
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    });
    vi.spyOn((await import("../src/lan-mode.ts")).LanModeAdapter.prototype, "reconcileOwned")
      .mockImplementation(async () => { events.push("lan:attempted"); });
    vi.spyOn(AdvancedModeAdapter.prototype, "reconcileOwned")
      .mockImplementation(async () => { events.push("advanced:attempted"); });
    const originalClose = Storage.prototype.close;
    vi.spyOn(Storage.prototype, "close").mockImplementation(function (this: Storage) {
      events.push("storage:closed");
      return originalClose.call(this);
    });

    const cleanup = reconcileInstalledNetworkState(configPath, runtime());
    const settled = cleanup.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(events).toEqual(["tailscale:attempted", "tailscale:aborted"]);
      await vi.advanceTimersByTimeAsync(999);
      expect(events).not.toContain("lan:attempted");
      await vi.advanceTimersByTimeAsync(1);
      const result = await settled;
      expect(result).toMatchObject({ status: "rejected", error: expect.objectContaining({ code: "timeout" }) });
      expect(events).toEqual([
        "tailscale:attempted", "tailscale:aborted", "tailscale:settled",
        "lan:attempted", "advanced:attempted", "storage:closed",
      ]);
    } finally {
      await vi.advanceTimersByTimeAsync(121_000);
      await cleanup.catch(() => undefined);
    }
  });

  it("refuses missing authority without creating a blank SQLite database", async () => {
    const { configPath, storage } = fixture();
    const dbPath = join(dirname(configPath), "gateway.sqlite");
    storage.close();
    rmSync(dbPath, { force: true });
    vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);
    vi.spyOn(TailscaleModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);
    vi.spyOn((await import("../src/lan-mode.ts")).LanModeAdapter.prototype, "reconcileOwned")
      .mockResolvedValue(undefined);
    vi.spyOn(AdvancedModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);

    await expect(reconcileInstalledNetworkState(configPath, runtime())).rejects.toThrow();
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses a non-regular authority path before invoking the helper or opening SQLite", async () => {
    const { configPath, storage } = fixture();
    const dbPath = join(dirname(configPath), "gateway.sqlite");
    storage.close();
    rmSync(dbPath, { force: true });
    mkdirSync(dbPath);
    const protect = vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);

    await expect(reconcileInstalledNetworkState(configPath, runtime())).rejects.toThrow(/existing.*database/i);
    expect(protect).not.toHaveBeenCalled();
  });

  it("requires helper/DACL proof before opening an existing authority database", async () => {
    const { configPath, storage } = fixture();
    storage.close();
    const protect = vi.spyOn(WindowsHelperClient.prototype, "protectPath")
      .mockRejectedValue(new Error("authority path is unsafe or unreadable"));
    vi.spyOn(TailscaleModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);
    vi.spyOn((await import("../src/lan-mode.ts")).LanModeAdapter.prototype, "reconcileOwned")
      .mockResolvedValue(undefined);
    vi.spyOn(AdvancedModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);

    await expect(reconcileInstalledNetworkState(configPath, runtime())).rejects.toThrow(/repair.*path.*permission/i);
    expect(protect).toHaveBeenCalledWith(
      dirname(dirname(configPath)), join(dirname(configPath), "gateway.sqlite"), expect.any(AbortSignal),
    );
  });

  it("rejects authority path indirection and existing databases outside the protected install root", async () => {
    const first = fixture();
    first.storage.close();
    const targetDirectory = dirname(first.configPath);
    const linkDirectory = join(first.root, "authority-link");
    symlinkSync(targetDirectory, linkDirectory, "junction");
    const linkPath = join(linkDirectory, "gateway.sqlite");
    const linkedConfig = JSON.parse(readFileSync(first.configPath, "utf8")) as Record<string, unknown>;
    linkedConfig.dbPath = linkPath;
    writeFileSync(first.configPath, `${JSON.stringify(linkedConfig, null, 2)}\n`);
    vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);
    vi.spyOn(TailscaleModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);
    vi.spyOn((await import("../src/lan-mode.ts")).LanModeAdapter.prototype, "reconcileOwned")
      .mockResolvedValue(undefined);
    vi.spyOn(AdvancedModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);
    await expect(reconcileInstalledNetworkState(first.configPath, runtime())).rejects.toThrow();

    vi.restoreAllMocks();
    const second = fixture();
    const outside = join(second.root, "outside-authority.sqlite");
    second.storage.close();
    renameSync(join(dirname(second.configPath), "gateway.sqlite"), outside);
    const outsideConfig = JSON.parse(readFileSync(second.configPath, "utf8")) as Record<string, unknown>;
    outsideConfig.dbPath = outside;
    writeFileSync(second.configPath, `${JSON.stringify(outsideConfig, null, 2)}\n`);
    const protect = vi.spyOn(WindowsHelperClient.prototype, "protectPath")
      .mockRejectedValue(new Error("outside protected root"));
    await expect(reconcileInstalledNetworkState(second.configPath, runtime())).rejects.toThrow(/repair.*path.*permission/i);
    expect(protect).toHaveBeenCalled();
  });

  it("preserves a configured existing custom authority database inside the protected install root", async () => {
    const { configPath, storage } = fixture();
    storage.close();
    const custom = join(dirname(configPath), "custom-authority.sqlite");
    renameSync(join(dirname(configPath), "gateway.sqlite"), custom);
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.dbPath = custom;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const protect = vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);
    vi.spyOn(TailscaleModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);
    vi.spyOn((await import("../src/lan-mode.ts")).LanModeAdapter.prototype, "reconcileOwned")
      .mockResolvedValue(undefined);
    vi.spyOn(AdvancedModeAdapter.prototype, "reconcileOwned").mockResolvedValue(undefined);

    await expect(reconcileInstalledNetworkState(configPath, runtime())).resolves.toBeUndefined();
    expect(protect).toHaveBeenCalledWith(dirname(dirname(configPath)), custom, expect.any(AbortSignal));
    expect(existsSync(custom)).toBe(true);
  });

  it("recovers a real post-CAS crash from SQLite and restores the exact managed listener snapshot", async () => {
    const { configPath, storage } = fixture();
    const originalConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    originalConfig.publicUrl = "https://remote.example.com";
    writeFileSync(configPath, `${JSON.stringify(originalConfig, null, 2)}\n`);
    const beforeSnapshot = readManagedListenerSnapshot(configPath);
    const beforeRevision = createHash("sha256").update(JSON.stringify(beforeSnapshot)).digest("hex");
    const before = {
      bindHost: "127.0.0.1",
      port: 18_787,
      hermesTargets: [{ profile: "default", url: "http://127.0.0.1:18787" }],
      persistenceRevision: beforeRevision,
      persistenceConfig: beforeSnapshot.configText,
    };
    const ownership: LanListenerOwnership = {
      schemaVersion: 1,
      phase: "provisional",
      ownershipSubtype: "wizard-listener-cas",
      before,
      after: {
        bindHost: "0.0.0.0", port: 18_787,
        hermesTargets: [{ profile: "default", url: "http://127.0.0.1:18787" }],
      },
      createdAt: 123,
    };
    await new SqliteLanOwnershipStore(storage).write(ownership);
    expect(storage.onboardingOwnership("lan:listener")?.ownedStateJson).not.toContain("do-not-print");
    expect(compareAndSwapManagedListener(configPath, beforeSnapshot, "0.0.0.0", 18_787, { clearPublicUrl: true }))
      .toBe(true);
    storage.close();
    vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);
    const hostRuntime = runtime();

    await reconcileInstalledNetworkState(configPath, hostRuntime);

    expect(readManagedListenerSnapshot(configPath)).toEqual(beforeSnapshot);
    expect(hostRuntime.restartHermesProfile).toHaveBeenCalledTimes(1);
    const reopened = openStorage(join(dirname(configPath), "gateway.sqlite"));
    expect(reopened.onboardingOwnership("lan:listener")).toBeUndefined();
    reopened.close();
  });

  it("completes the remote route through the live control boundary and SQLite gate", async () => {
    const { configPath, storage } = fixture();
    let now = 10;
    let unattendedReads = 0;
    const control = phoneControl(storage, () => now);
    const runner = vi.fn<TailscaleCliRunner>(async (_file, argv) => {
      const command = argv.join(" ");
      if (command === "version --json")
        return { exitCode: 0, stdout: tailscaleFixture("version-supported.json"), stderr: "" };
      if (command === "debug prefs")
        return { exitCode: 0, stdout: '{"ControlURL":"https://controlplane.tailscale.com"}', stderr: "" };
      if (command === "status --json")
        return { exitCode: 0, stdout: tailscaleFixture("status-running.json"), stderr: "" };
      if (command === "get --json unattended")
        return { exitCode: 0, stdout: JSON.stringify({ unattended: unattendedReads++ > 0 }), stderr: "" };
      if (command === "get --json shields-up")
        return { exitCode: 0, stdout: '{"shields-up":false}', stderr: "" };
      if (command === "serve status --json")
        return { exitCode: 0, stdout: tailscaleFixture("serve-compatible.json"), stderr: "" };
      if (command === "funnel status --json")
        return { exitCode: 0, stdout: tailscaleFixture("funnel-empty.json"), stderr: "" };
      return { exitCode: 64, stdout: "", stderr: "unexpected test command" };
    });
    const deps = { ...dependencies(storage, oneLan, control, () => now), tailscaleCliRunner: runner };
    const io = cliIo(["yes", "yes"]);
    const controller = createWindowsOnboardingController(configPath, io, runtime(), deps)!;

    const outcome = await controller.run(onboardingIo("tailscale"));
    expect(outcome).toMatchObject({ outcome: "complete" });
    expect(control.begin).toHaveBeenCalledWith("tailscale", {
      canonicalOrigin: "https://cozy.fixture-tailnet.ts.net", durableFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(deps.writePairingOutput).toHaveBeenCalledWith("pairing\n");
    expect(vi.mocked(io.question).mock.calls.flat().join(" ")).not.toMatch(/after logout/i);
    expect(vi.mocked(io.question).mock.calls.flat().join(" ")).toMatch(/background/i);
    await expect(controller.status()).resolves.toMatchObject({
      stage: "complete", authority: "complete", mode: "tailscale", healthy: true,
    });
    now += 700_000;
    await expect(controller.status()).resolves.not.toHaveProperty("expiresAt");
    controller.close();
  });

  it("uses an explicit candidate for ambiguous LAN and retries invalid input", async () => {
    const { configPath, storage } = fixture();
    const inventory: WindowsLanInventory = {
      schemaVersion: 1,
      adapters: [
        oneLan.adapters[0]!,
        { ...oneLan.adapters[0]!, id: "wifi", displayName: "Trusted Wi-Fi", kind: "wifi", ipv4Addresses: ["10.0.0.8"] },
      ],
    };
    const control = phoneControl(storage, () => 10);
    const projection = stateProjection();
    const deps = { ...dependencies(storage, inventory, control, () => 10), state: projection };
    const io = cliIo(["invalid", "2"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const controller = createWindowsOnboardingController(configPath, io, runtime(), deps)!;

    await expect(controller.run(onboardingIo("lan"))).resolves.toMatchObject({
      outcome: "complete", endpoint: { physicalAdapterId: "wifi", dhcpAddress: "10.0.0.8" },
    });
    expect(io.question).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(join(dirname(configPath), "network-onboarding-lan-adapter"), "utf8")))
      .toEqual({ adapterId: "wifi", address: "10.0.0.8" });
    controller.close();

    const resumedStorage = openStorage(join(dirname(configPath), "gateway.sqlite"));
    const resumedControl = phoneControl(resumedStorage, () => 10);
    const resumedIo = cliIo();
    const resumed = createWindowsOnboardingController(configPath, resumedIo, runtime(), {
      ...dependencies(resumedStorage, inventory, resumedControl, () => 10), state: projection,
    })!;
    await expect(resumed.status()).resolves.toMatchObject({
      stage: "complete", healthy: true, mode: "lan",
    });
    expect(resumedIo.question).not.toHaveBeenCalled();
    resumed.close();

    const replacementStorage = openStorage(join(dirname(configPath), "gateway.sqlite"));
    const replacementControl = phoneControl(replacementStorage, () => 20, "replacement-");
    const replacementIo = cliIo(["invalid", "1"]);
    const replacementDeps = {
      ...dependencies(replacementStorage, oneLan, replacementControl, () => 20),
      state: projection,
      createSetupCode: vi.fn(() => "COZY-5678"),
    };
    const replacement = createWindowsOnboardingController(
      configPath, replacementIo, runtime(), replacementDeps,
    )!;
    await expect(replacement.status()).resolves.toMatchObject({ stage: "changed", healthy: false, mode: "lan" });
    await expect(replacement.resume(onboardingIo("lan"))).resolves.toMatchObject({
      outcome: "complete", endpoint: { physicalAdapterId: "ethernet", dhcpAddress: "192.168.1.20" },
    });
    expect(replacementIo.question).toHaveBeenCalledTimes(2);
    const selectionPath = join(dirname(configPath), "network-onboarding-lan-adapter");
    expect(JSON.parse(readFileSync(selectionPath, "utf8")))
      .toEqual({ adapterId: "ethernet", address: "192.168.1.20" });
    expect(replacementDeps.helper.protectPath).toHaveBeenCalledWith(dirname(dirname(configPath)), selectionPath, undefined);
    replacement.close();
  });

  it("preserves Unicode adapter names in selection output", async () => {
    const { configPath, storage } = fixture();
    const unicodeName = "Café 网络";
    const inventory: WindowsLanInventory = {
      schemaVersion: 1,
      adapters: [
        { ...oneLan.adapters[0]!, displayName: unicodeName },
        { ...oneLan.adapters[0]!, id: "wifi", displayName: "Wi-Fi", kind: "wifi", ipv4Addresses: ["10.0.0.8"] },
      ],
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const controller = createWindowsOnboardingController(
      configPath, cliIo(["1"]), runtime(), dependencies(storage, inventory, phoneControl(storage, () => 10), () => 10),
    )!;

    await expect(controller.run(onboardingIo("lan"))).resolves.toMatchObject({ outcome: "complete" });
    expect(log.mock.calls.flat().join("\n")).toContain(unicodeName);
    controller.close();
  });

  it("inspects Windows profile/firewall posture and gives bounded LAN guidance without mutating it", async () => {
    const { configPath, storage } = fixture();
    const deps = dependencies(storage, oneLan, phoneControl(storage, () => 10), () => 10);
    deps.helper.inspectNetworkSafety.mockResolvedValue({
      networkCategory: "public", firewallEnabled: true, defaultInboundAction: "block",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const controller = createWindowsOnboardingController(configPath, cliIo(), runtime(), deps)!;

    await expect(controller.run(onboardingIo("lan"))).resolves.toMatchObject({ outcome: "complete" });
    expect(deps.helper.inspectNetworkSafety).toHaveBeenCalledWith("ethernet", undefined);
    const copy = log.mock.calls.flat().join("\n");
    expect(copy).toMatch(/Windows.*Public/i);
    expect(copy).toMatch(/Settings.*Private/i);
    expect(copy).toMatch(/do not disable.*firewall/i);
    expect(copy).toMatch(/Windows Security.*Firewall & network protection.*Advanced settings.*Inbound Rules/i);
    expect(copy).toContain("TCP port 18787");
    controller.close();
  });

  it("applies real advanced bind settings and restarts managed Hermes", async () => {
    const { configPath, storage } = fixture();
    const control = phoneControl(storage, () => 10);
    const deps = dependencies(storage, oneLan, control, () => 10);
    const hostRuntime = runtime();
    const controller = createWindowsOnboardingController(
      configPath, cliIo(["192.168.1.50", "19000"]), hostRuntime, deps,
    )!;

    await expect(controller.run(onboardingIo("advanced"))).resolves.toMatchObject({
      outcome: "complete", endpoint: { bindHost: "192.168.1.50", port: 19000 },
    });
    expect(hostRuntime.restartHermesProfile).toHaveBeenCalledOnce();
    expect(storage.onboardingOwnership("advanced:listener")).toBeDefined();
    controller.close();
  });

  it("durably recovers Advanced when the process is lost after listener CAS", async () => {
    const { configPath, storage } = fixture();
    const before = readManagedListenerSnapshot(configPath);
    const deps = {
      ...dependencies(storage, oneLan, phoneControl(storage, () => 10), () => 10),
      afterAdvancedListenerCas: vi.fn(async () => { throw new Error("simulated process loss"); }),
    };
    const controller = createWindowsOnboardingController(
      configPath, cliIo(["192.168.1.50", "19000"]), runtime(), deps,
    )!;

    await expect(controller.run(onboardingIo("advanced"))).resolves.toEqual({
      outcome: "failed", reason: "readiness",
    });
    expect(readManagedListenerSnapshot(configPath)).not.toEqual(before);
    const durable = storage.onboardingOwnership("advanced:listener")!;
    expect(durable.ownedStateJson).not.toContain("do-not-print");
    expect(JSON.parse(durable.ownedStateJson)).toMatchObject({
      phase: "provisional",
      after: { persistenceRevision: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    controller.close();

    vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);
    const recovery = runtime();
    await reconcileInstalledNetworkState(configPath, recovery);
    expect(readManagedListenerSnapshot(configPath)).toEqual(before);
    expect(recovery.restartHermesProfile).toHaveBeenCalledOnce();
    const reopened = openStorage(join(dirname(configPath), "gateway.sqlite"));
    expect(reopened.onboardingOwnership("advanced:listener")).toBeUndefined();
    reopened.close();
  });

  it("conditionally restores Advanced listener state after phone rejection", async () => {
    const { configPath, storage } = fixture();
    const before = readManagedListenerSnapshot(configPath);
    const control = phoneControl(storage, () => 10);
    control.status.mockResolvedValue({ state: "cancelled" });
    const controller = createWindowsOnboardingController(
      configPath,
      cliIo(["192.168.1.50", "19000"]),
      runtime(),
      dependencies(storage, oneLan, control, () => 10),
    )!;

    await expect(controller.run(onboardingIo("advanced"))).resolves.toEqual({
      outcome: "not_confirmed", reason: "phone", mode: "advanced",
    });
    expect(readManagedListenerSnapshot(configPath)).toEqual(before);
    expect(storage.onboardingOwnership("advanced:listener")).toBeUndefined();
    controller.close();
  });

  it("retains Advanced restart authority when reverse CAS succeeds but restart fails", async () => {
    const { configPath, storage } = fixture();
    const before = readManagedListenerSnapshot(configPath);
    const control = phoneControl(storage, () => 10);
    control.status.mockResolvedValue({ state: "cancelled" });
    const failingRuntime = runtime();
    vi.mocked(failingRuntime.restartHermesProfile)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("restart failed"));
    const controller = createWindowsOnboardingController(
      configPath,
      cliIo(["192.168.1.50", "19000"]),
      failingRuntime,
      dependencies(storage, oneLan, control, () => 10),
    )!;

    await expect(controller.run(onboardingIo("advanced"))).resolves.toEqual({
      outcome: "failed", reason: "rollback_failed",
    });
    expect(readManagedListenerSnapshot(configPath)).toEqual(before);
    expect(JSON.parse(storage.onboardingOwnership("advanced:listener")!.ownedStateJson)).toMatchObject({
      phase: "rollback-restart-required",
    });
    controller.close();

    vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);
    const recovery = runtime();
    await reconcileInstalledNetworkState(configPath, recovery);
    expect(recovery.restartHermesProfile).toHaveBeenCalledOnce();
    const reopened = openStorage(join(dirname(configPath), "gateway.sqlite"));
    expect(reopened.onboardingOwnership("advanced:listener")).toBeUndefined();
    reopened.close();
  });

  it("restores a paused Advanced route when choosing Later", async () => {
    const { configPath, storage } = fixture();
    const before = readManagedListenerSnapshot(configPath);
    const projection = stateProjection();
    const control = phoneControl(storage, () => 10);
    control.begin.mockRejectedValueOnce(Object.assign(new Error("restart"), {
      retryable: true as const, reason: "gateway_restarting",
    }));
    const deps = {
      ...dependencies(storage, oneLan, control, () => 10),
      state: projection,
    };
    const controller = createWindowsOnboardingController(
      configPath, cliIo(["192.168.1.50", "19000"]), runtime(), deps,
    )!;
    await expect(controller.run(onboardingIo("advanced"))).resolves.toMatchObject({ outcome: "paused" });

    await expect(controller.resume({
      ...onboardingIo("advanced"),
      chooseNetworkMode: vi.fn(async () => "later" as const),
    })).resolves.toEqual({ outcome: "deferred" });
    expect(readManagedListenerSnapshot(configPath)).toEqual(before);
    expect(storage.onboardingOwnership("advanced:listener")).toBeUndefined();
    controller.close();
  });

  it("restores a paused Advanced route before switching to LAN", async () => {
    const { configPath, storage } = fixture();
    const control = phoneControl(storage, () => 10);
    control.begin.mockRejectedValueOnce(Object.assign(new Error("restart"), {
      retryable: true as const, reason: "gateway_restarting",
    }));
    const projection = stateProjection();
    const controller = createWindowsOnboardingController(
      configPath,
      cliIo(["192.168.1.50", "19000"]),
      runtime(),
      { ...dependencies(storage, oneLan, control, () => 10), state: projection },
    )!;
    await expect(controller.run(onboardingIo("advanced"))).resolves.toMatchObject({ outcome: "paused" });
    await expect(controller.resume(onboardingIo("lan"))).resolves.toMatchObject({
      outcome: "complete", mode: "lan",
    });
    expect(storage.onboardingOwnership("advanced:listener")).toBeUndefined();
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ host: "0.0.0.0", port: 18787 });
    controller.close();
  });

  it("fails closed without overwriting an external Advanced config change", async () => {
    const { configPath, storage } = fixture();
    const control = phoneControl(storage, () => 10);
    control.begin.mockRejectedValueOnce(Object.assign(new Error("restart"), {
      retryable: true as const, reason: "gateway_restarting",
    }));
    const controller = createWindowsOnboardingController(
      configPath,
      cliIo(["192.168.1.50", "19000"]),
      runtime(),
      dependencies(storage, oneLan, control, () => 10),
    )!;
    await expect(controller.run(onboardingIo("advanced"))).resolves.toMatchObject({ outcome: "paused" });
    const external = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    external.turnTimeoutSeconds = 1;
    writeFileSync(configPath, `${JSON.stringify(external, null, 2)}\n`);
    const externalSnapshot = readManagedListenerSnapshot(configPath);
    controller.close();

    vi.spyOn(WindowsHelperClient.prototype, "protectPath").mockResolvedValue(undefined);
    await expect(reconcileInstalledNetworkState(configPath, runtime())).rejects.toMatchObject({
      code: "listener_changed",
    });
    expect(readManagedListenerSnapshot(configPath)).toEqual(externalSnapshot);
    const reopened = openStorage(join(dirname(configPath), "gateway.sqlite"));
    expect(JSON.parse(reopened.onboardingOwnership("advanced:listener")!.ownedStateJson)).toMatchObject({
      phase: "rollback-restart-required",
    });
    reopened.close();
  });

  it("requires a concrete phone-reachable Advanced origin instead of loopback or wildcard", async () => {
    const { configPath, storage } = fixture();
    const rejected = [
      "127.0.0.1", "127.1", "2130706433", "0x7f000001", "localhost.",
      "0.0.0.0", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1",
    ];
    const io = cliIo([...rejected, "192.168.1.50", "19000"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const controller = createWindowsOnboardingController(
      configPath, io, runtime(), dependencies(storage, oneLan, phoneControl(storage, () => 10), () => 10),
    )!;

    await expect(controller.run(onboardingIo("advanced"))).resolves.toMatchObject({
      outcome: "complete",
      endpoint: { canonicalOrigin: "http://192.168.1.50:19000" },
    });
    expect(io.question).toHaveBeenCalledTimes(rejected.length + 2);
    controller.close();
  });

  it("preserves a prepared remote route across a transient Gateway restart and resumes", async () => {
    const { configPath, storage } = fixture();
    const stable = phoneControl(storage, () => 10);
    stable.begin.mockRejectedValueOnce(Object.assign(new Error("restart"), {
      retryable: true as const, reason: "gateway_restarting",
    }));
    const endpoint: PreparedEndpoint = {
      mode: "tailscale", canonicalOrigin: "https://personal.example.ts.net", bindHost: "127.0.0.1",
      port: 18787, durableFingerprint: "tailscale-posture", ready: true,
    };
    const remote: NetworkModeAdapter = {
      mode: "tailscale", prepare: vi.fn(async () => endpoint), inspect: vi.fn(async () => endpoint),
      rollbackOwned: vi.fn(async () => undefined),
      reconcileOwned: vi.fn(async () => undefined),
    };
    const deps = { ...dependencies(storage, oneLan, stable, () => 10), tailscaleAdapter: remote };
    const controller = createWindowsOnboardingController(configPath, cliIo(), runtime(), deps)!;

    await expect(controller.run(onboardingIo("tailscale"))).resolves.toEqual({
      outcome: "paused", mode: "tailscale", reason: "gateway_restarting",
    });
    expect(remote.rollbackOwned).not.toHaveBeenCalled();
    await expect(controller.resume(onboardingIo("tailscale"))).resolves.toMatchObject({ outcome: "complete" });
    controller.close();
  });

  it("preserves the prepared route when the Gateway restarts entirely between post-begin polls", async () => {
    const { configPath, storage } = fixture();
    const control = phoneControl(storage, () => 10);
    let polls = 0;
    control.status.mockImplementation(async (challengeId: string) => {
      polls += 1;
      if (polls === 1) return { state: "pending" as const, expiresAt: 600_010 };
      return storage.onboardingVerificationStatus(challengeId, 12);
    });
    const endpoint: PreparedEndpoint = {
      mode: "tailscale", canonicalOrigin: "https://personal.example.ts.net", bindHost: "127.0.0.1",
      port: 18787, durableFingerprint: "tailscale-posture", ready: true,
    };
    const remote: NetworkModeAdapter = {
      mode: "tailscale", prepare: vi.fn(async () => endpoint), inspect: vi.fn(async () => endpoint),
      rollbackOwned: vi.fn(async () => undefined),
      reconcileOwned: vi.fn(async () => undefined),
    };
    const deps = {
      ...dependencies(storage, oneLan, control, () => 12),
      tailscaleAdapter: remote,
      delay: vi.fn(async () => {
        storage.beginGatewayBoot({
          bootGeneration: "boot-2", verificationEpoch: "epoch-2",
          canonicalOrigin: endpoint.canonicalOrigin, durableFingerprint: endpoint.durableFingerprint, startedAt: 11,
        });
      }),
    };
    const controller = createWindowsOnboardingController(configPath, cliIo(), runtime(), deps)!;

    await expect(controller.run(onboardingIo("tailscale"))).resolves.toEqual({
      outcome: "paused", mode: "tailscale", reason: "gateway_restarting",
    });
    expect(control.begin).toHaveBeenCalledOnce();
    expect(control.status).toHaveBeenCalledTimes(2);
    expect(remote.rollbackOwned).not.toHaveBeenCalled();
    expect(deps.createSetupCode).not.toHaveBeenCalled();
    expect(deps.writePairingOutput).not.toHaveBeenCalled();
    controller.close();
  });

  it("reports live SQLite expiry, clears it after expiry, and enforces the fresh pair gate", async () => {
    const { configPath, storage } = fixture();
    let now = 10;
    const control = phoneControl(storage, () => now);
    const projection = stateProjection({ version: 1, stage: "pending_choice", updatedAt: 2 });
    const deps = { ...dependencies(storage, oneLan, control, () => now), state: projection };
    const controller = createWindowsOnboardingController(configPath, cliIo(), runtime(), deps)!;

    const proof = await control.begin("lan", {
      canonicalOrigin: "http://192.168.1.20:18787", durableFingerprint: "lan-posture",
    });
    await expect(controller.status()).resolves.toHaveProperty("expiresAt", proof.expiresAt);
    now = proof.expiresAt + 1;
    await expect(controller.status()).resolves.not.toHaveProperty("expiresAt");
    controller.close();

    const fresh = fixture();
    const freshControl = phoneControl(fresh.storage, () => 10);
    const freshController = createWindowsOnboardingController(
      fresh.configPath, cliIo(), runtime(), {
        ...dependencies(fresh.storage, oneLan, freshControl, () => 10),
        state: stateProjection({ version: 1, stage: "pending_choice", updatedAt: 2 }),
      },
    )!;
    await expect(runCli(["pair", "--config", fresh.configPath], undefined, undefined, freshController))
      .rejects.toThrow(/cozygateway setup/);
    freshController.close();
  });

  it("fails LAN CAS on a concurrent full-config edit and preserves that writer exactly", async () => {
    const { configPath, storage } = fixture();
    const control = phoneControl(storage, () => 10);
    let concurrentText = "";
    const deps = {
      ...dependencies(storage, oneLan, control, () => 10),
      beforeListenerCas: vi.fn(async () => {
        const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
        config.futureSetting = { owner: "other-window" };
        concurrentText = `${JSON.stringify(config, null, 2)}\n`;
        writeFileSync(configPath, concurrentText);
      }),
    };
    const hostRuntime = runtime();
    const controller = createWindowsOnboardingController(configPath, cliIo(), hostRuntime, deps)!;

    await expect(controller.run(onboardingIo("lan"))).resolves.toMatchObject({
      outcome: "paused", reason: "listener_changed",
    });
    expect(readFileSync(configPath, "utf8")).toBe(concurrentText);
    expect(hostRuntime.restartHermesProfile).not.toHaveBeenCalled();
    controller.close();
  });

  it("turns an actual live listener writer lock into a typed resumable pause", async () => {
    const { configPath, storage } = fixture();
    const lockPath = `${configPath}.listener.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      version: 1, pid: process.pid, nonce: "b".repeat(32),
    })}\n`);
    const control = phoneControl(storage, () => 10);
    const hostRuntime = runtime();
    const controller = createWindowsOnboardingController(
      configPath, cliIo(), hostRuntime, dependencies(storage, oneLan, control, () => 10),
    )!;

    await expect(controller.run(onboardingIo("lan"))).resolves.toEqual({
      outcome: "paused", mode: "lan", reason: "listener_changed",
    });
    expect(hostRuntime.restartHermesProfile).not.toHaveBeenCalled();
    expect(control.begin).not.toHaveBeenCalled();
    controller.close();
  });
});

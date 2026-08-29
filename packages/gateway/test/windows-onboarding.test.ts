import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliIo, type CliRuntime } from "../src/cli.ts";
import type { NetworkModeAdapter, OnboardingIo, PreparedEndpoint } from "../src/network-onboarding.ts";
import type { NetworkOnboardingState, NetworkOnboardingStateProjection } from "../src/onboarding-state.ts";
import { openStorage, type OnboardingMode, type Storage } from "../src/storage.ts";
import { createWindowsOnboardingController } from "../src/windows-onboarding.ts";
import type { WindowsNetworkSafety } from "../src/windows-helper.ts";
import type { WindowsLanInventory } from "../src/lan.ts";
import type { TailscaleCliRunner } from "../src/tailscale-cli.ts";
import type { OperatorPhoneStatus } from "../src/operator-onboarding.ts";

const roots: string[] = [];
const tailscaleFixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./fixtures/tailscale/${name}`, import.meta.url)), "utf8",
);

afterEach(() => {
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
    expect(readFileSync(join(dirname(configPath), "network-onboarding-lan-adapter"), "utf8")).toBe("wifi\n");
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
    expect(readFileSync(selectionPath, "utf8")).toBe("ethernet\n");
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
    controller.close();
  });

  it("requires a concrete phone-reachable Advanced origin instead of loopback or wildcard", async () => {
    const { configPath, storage } = fixture();
    const io = cliIo(["127.0.0.1", "0.0.0.0", "192.168.1.50", "19000"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const controller = createWindowsOnboardingController(
      configPath, io, runtime(), dependencies(storage, oneLan, phoneControl(storage, () => 10), () => 10),
    )!;

    await expect(controller.run(onboardingIo("advanced"))).resolves.toMatchObject({
      outcome: "complete",
      endpoint: { canonicalOrigin: "http://192.168.1.50:19000" },
    });
    expect(io.question).toHaveBeenCalledTimes(4);
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

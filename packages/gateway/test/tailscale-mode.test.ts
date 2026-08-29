import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SqliteTailscaleOwnershipStore,
  TailscaleModeAdapter,
  inspectTailscaleMappings,
  type TailscaleMappingOwnership,
  type TailscaleModeProbes,
} from "../src/tailscale-mode.ts";
import { TailscaleCliError, TailscaleLocalApiError, type TailscaleCliRunner, type TailscaleServeConfigClient } from "../src/tailscale-cli.ts";
import { openStorage } from "../src/storage.ts";
import { WindowsHelperError, type TailscaleDiscovery } from "../src/windows-helper.ts";

const fixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./fixtures/tailscale/${name}`, import.meta.url)),
  "utf8",
);
const executable = "C:\\Program Files\\Tailscale\\tailscale.exe";
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function happyDependencies(options: {
  serve?: string;
  funnel?: string;
  status?: string[];
  login?: string;
  preferences?: { unattended: boolean; shieldsUp: boolean };
  serveSequence?: string[];
  controlUrl?: string;
} = {}) {
  const calls: string[] = [];
  let serveState = options.serve ?? fixture("serve-compatible.json");
  const serveSequence = options.serveSequence === undefined ? undefined : [...options.serveSequence];
  const statuses = [...(options.status ?? [fixture("status-running.json")])];
  const preferenceState = {
    unattended: options.preferences?.unattended ?? true,
    shieldsUp: options.preferences?.shieldsUp ?? false,
  };
  const runner = vi.fn<TailscaleCliRunner>(async (_file, argv) => {
    const command = argv.join(" ");
    calls.push(command);
    if (command === "version --json") return { exitCode: 0, stdout: fixture("version-supported.json"), stderr: "" };
    if (command === "debug prefs") return {
      exitCode: 0,
      stdout: JSON.stringify({ ControlURL: options.controlUrl ?? "https://controlplane.tailscale.com" }),
      stderr: "",
    };
    if (command === "status --json") return { exitCode: 0, stdout: statuses.length > 1 ? statuses.shift()! : statuses[0]!, stderr: "" };
    if (command === "up --json --timeout=5s") return {
      exitCode: 1,
      stdout: options.login ?? '{"AuthURL":"https://login.tailscale.com/a/fixture-opaque","BackendState":"NeedsLogin"}',
      stderr: "",
    };
    if (command === "get --json unattended") return { exitCode: 0, stdout: JSON.stringify({ unattended: preferenceState.unattended }), stderr: "" };
    if (command === "get --json shields-up") return { exitCode: 0, stdout: JSON.stringify({ "shields-up": preferenceState.shieldsUp }), stderr: "" };
    if (command === "serve status --json") return {
      exitCode: 0,
      stdout: serveSequence !== undefined && serveSequence.length > 0 ? serveSequence.shift()! : serveState,
      stderr: "",
    };
    if (command === "funnel status --json") return { exitCode: 0, stdout: options.funnel ?? fixture("funnel-empty.json"), stderr: "" };
    if (command === "serve --https=8443 text:CozyGateway HTTPS consent") return {
      exitCode: 0,
      stdout: "https://console.tailscale.com/admin/feature/fixture\n",
      stderr: "",
    };
    return { exitCode: 64, stdout: "", stderr: "unexpected fixture command" };
  });
  const helper = {
    discoverTailscale: vi.fn<(_signal?: AbortSignal) => Promise<TailscaleDiscovery>>(async () => ({
      state: "ready" as const,
      cliPath: executable,
      daemonPath: "C:\\Program Files\\Tailscale\\tailscaled.exe",
    })),
    installTailscale: vi.fn(async () => undefined),
    setPreference: vi.fn(async (preference: "unattended" | "shields-up", enabled: boolean) => {
      if (preference === "unattended") preferenceState.unattended = enabled;
      else preferenceState.shieldsUp = enabled;
    }),
    openBrowser: vi.fn(async () => undefined),
  };
  const io = {
    offerInstall: vi.fn(async () => false),
    confirmCurrentAccount: vi.fn(async () => true),
    confirmPreference: vi.fn(async () => true),
    confirmCertificateTransparency: vi.fn(async () => true),
    chooseHttpsConsentPort: vi.fn(async () => 8_443),
  };
  const probes = {
    loopback: vi.fn<TailscaleModeProbes["loopback"]>(async () => ({ bounded: true, health: true, attachReady: true, webSocket: true })),
    remote: vi.fn<TailscaleModeProbes["remote"]>(async () => ({
      bounded: true,
      requestedHost: "cozy.fixture-tailnet.ts.net",
      tlsVerification: "system" as const,
      tlsAuthorized: true,
      certificateDnsNames: ["cozy.fixture-tailnet.ts.net"],
      redirected: false,
      healthStatus: 200,
      alpn: "http/1.1",
      webSocketEcho: true,
      webSocketOpenMs: 1_000,
    })),
  };
  const ownership = {
    identityHmacKey: vi.fn(async () => Buffer.alloc(32, 7)),
    read: vi.fn(async (_signal?: AbortSignal): Promise<TailscaleMappingOwnership | undefined> => undefined),
    write: vi.fn(async (_ownership: TailscaleMappingOwnership, _signal?: AbortSignal) => "written" as const),
    replace: vi.fn(async (_expected: TailscaleMappingOwnership, _replacement: TailscaleMappingOwnership, _signal?: AbortSignal) => true),
    remove: vi.fn(async (_ownership: TailscaleMappingOwnership, _signal?: AbortSignal) => true),
  };
  const removeExactTlsTerminatedMapping = vi.fn<TailscaleServeConfigClient["removeExactTlsTerminatedMapping"]>(async (input) => {
      calls.push("localapi remove exact mapping");
      const config = JSON.parse(serveState) as { TCP?: Record<string, unknown> };
      const handler = config.TCP?.["443"] as { TCPForward?: unknown; TerminateTLS?: unknown } | undefined;
      if (handler === undefined) return "absent" as const;
      if (handler.TCPForward !== input.target || handler.TerminateTLS !== input.dnsName)
        return "conflict" as const;
      delete config.TCP!["443"];
      serveState = JSON.stringify(config);
      return "removed" as const;
    });
  const createExactTlsTerminatedMapping = vi.fn<TailscaleServeConfigClient["createExactTlsTerminatedMapping"]>(async (input) => {
    calls.push("localapi create exact mapping");
    const config = JSON.parse(serveState) as { TCP?: Record<string, unknown> };
    config.TCP ??= {};
    if (config.TCP["443"] !== undefined) return "conflict";
    config.TCP["443"] = { TCPForward: input.target, TerminateTLS: input.dnsName };
    serveState = JSON.stringify(config);
    return "created";
  });
  const serveConfigClient = { createExactTlsTerminatedMapping, removeExactTlsTerminatedMapping };
  return { calls, runner, helper, io, probes, ownership, preferenceState, serveConfigClient };
}

describe("TailscaleModeAdapter", () => {
  it("rejects a custom login server before preference, login, certificate, or Serve mutation", async () => {
    const dependencies = happyDependencies({
      controlUrl: "https://headscale.example.test",
      serve: fixture("serve-empty.json"),
      preferences: { unattended: false, shieldsUp: true },
    });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787,
      cliRunner: dependencies.runner,
      helper: dependencies.helper,
      io: dependencies.io,
      probes: dependencies.probes,
      ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });

    await expect(adapter.prepare()).rejects.toMatchObject({
      reason: "custom_control_server",
      detail: "custom_control_server",
      retryable: true,
    });
    expect(dependencies.calls).toEqual(["version --json", "debug prefs"]);
    expect(dependencies.helper.setPreference).not.toHaveBeenCalled();
    expect(dependencies.io.confirmCertificateTransparency).not.toHaveBeenCalled();
  });

  it("reuses an exact no-PROXY mapping with a durable non-removal subtype after account confirmation", async () => {
    const dependencies = happyDependencies();
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787,
      cliRunner: dependencies.runner,
      helper: dependencies.helper,
      io: dependencies.io,
      probes: dependencies.probes,
      ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });

    await expect(adapter.prepare()).resolves.toMatchObject({
      mode: "tailscale",
      canonicalOrigin: "https://cozy.fixture-tailnet.ts.net",
      bindHost: "127.0.0.1",
      port: 18_787,
      ready: true,
      createdByWizard: false,
    });
    expect(dependencies.io.confirmCurrentAccount).toHaveBeenCalledWith({
      accountLabel: "fixture@example.com",
      tailnetName: "fixture@example.com",
    }, undefined);
    expect(dependencies.calls).not.toContain("serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:18787");
    expect(dependencies.ownership.write).toHaveBeenCalledWith(expect.objectContaining({
      ownershipSubtype: "reused",
      phase: "preferences",
    }), undefined);
  });

  it("uses the local ownership authority key for opaque account identity instead of plain SHA-256", async () => {
    const first = happyDependencies();
    const second = happyDependencies();
    second.ownership.identityHmacKey.mockResolvedValue(Buffer.alloc(32, 8));
    const firstEndpoint = await new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: first.runner, helper: first.helper,
      io: first.io, probes: first.probes, ownership: first.ownership, serveConfigClient: first.serveConfigClient,
    }).prepare();
    const secondEndpoint = await new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: second.runner, helper: second.helper,
      io: second.io, probes: second.probes, ownership: second.ownership, serveConfigClient: second.serveConfigClient,
    }).prepare();
    const plain = createHash("sha256").update(JSON.stringify({
      accountId: "42",
      accountLabel: "fixture@example.com",
      tailnetName: "fixture@example.com",
      magicDnsSuffix: "fixture-tailnet.ts.net",
    })).digest("hex");

    expect(firstEndpoint.accountTailnetHash).not.toBe(plain);
    expect(firstEndpoint.accountTailnetHash).not.toBe(secondEndpoint.accountTailnetHash);
    expect(first.ownership.identityHmacKey).toHaveBeenCalled();
  });

  it("creates only the exact L4 mapping, proves it, and records wizard ownership", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787,
      cliRunner: dependencies.runner,
      helper: dependencies.helper,
      io: dependencies.io,
      probes: dependencies.probes,
      ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
      now: () => 1_700_000_000_000,
    });

    await expect(adapter.prepare()).resolves.toMatchObject({ ready: true, createdByWizard: true });
    expect(dependencies.calls).toContain("localapi create exact mapping");
    expect(dependencies.ownership.write).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 2,
      phase: "preferences",
      ownershipSubtype: "wizard-created",
      dnsName: "cozy.fixture-tailnet.ts.net",
      target: "127.0.0.1:18787",
      createdAt: 1_700_000_000_000,
    }), undefined);
  });

  it("retains provisional ownership and reports mapping when LocalAPI creation loses the ETag race", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    let stored: TailscaleMappingOwnership | undefined;
    dependencies.ownership.read.mockImplementation(async () => stored);
    dependencies.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
    dependencies.ownership.replace.mockImplementation(async (expected, replacement) => {
      if (stored !== expected) return false;
      stored = replacement;
      return true;
    });
    dependencies.serveConfigClient.createExactTlsTerminatedMapping.mockResolvedValue("concurrent");
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
      serveConfigClient: dependencies.serveConfigClient,
    });

    await expect(adapter.prepare()).rejects.toMatchObject({ reason: "mapping" });
    expect(stored).toMatchObject({ phase: "provisional", ownershipSubtype: "wizard-created" });
    expect(dependencies.calls.some((call) => call.startsWith("serve --bg "))).toBe(false);
  });

  it("binds mapping and durable fingerprints to wizard-created versus reused ownership", async () => {
    const created = happyDependencies({ serve: fixture("serve-empty.json") });
    const reused = happyDependencies();
    const createdEndpoint = await new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: created.runner, helper: created.helper,
      io: created.io, probes: created.probes, ownership: created.ownership, serveConfigClient: created.serveConfigClient,
    }).prepare();
    const reusedEndpoint = await new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: reused.runner, helper: reused.helper,
      io: reused.io, probes: reused.probes, ownership: reused.ownership, serveConfigClient: reused.serveConfigClient,
    }).prepare();

    expect(createdEndpoint.createdByWizard).toBe(true);
    expect(reusedEndpoint.createdByWizard).toBe(false);
    expect(createdEndpoint.serveMappingFingerprint).not.toBe(reusedEndpoint.serveMappingFingerprint);
    expect(createdEndpoint.durableFingerprint).not.toBe(reusedEndpoint.durableFingerprint);
  });

  it("refuses every conflicting Serve, Funnel, and PROXY use of port 443 without mutation", async () => {
    const proxy = fixture("serve-compatible.json").replace(
      '"TerminateTLS":"cozy.fixture-tailnet.ts.net"',
      '"TerminateTLS":"cozy.fixture-tailnet.ts.net","ProxyProtocol":2',
    );
    for (const options of [
      { serve: fixture("serve-conflicting-tcp.json") },
      { serve: fixture("serve-conflicting-web.json") },
      { serve: fixture("serve-conflicting-foreground.json") },
      { serve: fixture("serve-conflicting-service.json") },
      { funnel: fixture("funnel-443.json") },
      { serve: proxy },
    ]) {
      const dependencies = happyDependencies(options);
      const adapter = new TailscaleModeAdapter({
        gatewayPort: 18_787,
        cliRunner: dependencies.runner,
        helper: dependencies.helper,
        io: dependencies.io,
        probes: dependencies.probes,
        ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
      });

      await expect(adapter.prepare()).rejects.toMatchObject({ reason: "mapping_conflict", retryable: true });
      expect(dependencies.calls.some((call) => call.startsWith("serve --bg "))).toBe(false);
      expect(dependencies.calls.some((call) => call.endsWith(" off"))).toBe(false);
    }
  });

  it("accepts the current full-config Funnel status shape when AllowFunnel has no port 443 entry", async () => {
    const dependencies = happyDependencies({ funnel: fixture("serve-compatible.json") });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });
    await expect(adapter.prepare()).resolves.toMatchObject({ ready: true, createdByWizard: false });
  });

  it("collects occupied consent ports from the complete Funnel document", () => {
    const funnel = JSON.parse(fixture("funnel-empty.json")) as Record<string, unknown>;
    funnel.Services = { "svc:fixture": { TCP: { "9443": { TCPForward: "127.0.0.1:9000" } } } };
    expect(inspectTailscaleMappings(
      JSON.parse(fixture("serve-empty.json")) as Record<string, unknown>,
      funnel,
      "cozy.fixture-tailnet.ts.net",
      18_787,
    )).toMatchObject({ outcome: "empty", occupiedPorts: [9_443] });
  });

  it("resumes public-CLI login through the exact validated URL and independent status polling", async () => {
    const dependencies = happyDependencies({
      status: [fixture("status-needs-login.json"), fixture("status-running.json")],
    });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787,
      cliRunner: dependencies.runner,
      helper: dependencies.helper,
      io: dependencies.io,
      probes: dependencies.probes,
      ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
      loginPollAttempts: 2,
      loginPollDelayMs: 0,
    });

    await expect(adapter.prepare()).resolves.toMatchObject({ ready: true });
    expect(dependencies.helper.openBrowser).toHaveBeenCalledWith(
      "login",
      "https://login.tailscale.com/a/fixture-opaque",
      undefined,
    );
    expect(dependencies.calls).toContain("up --json --timeout=5s");
  });

  it("never switches a running account and pauses machine approval with no mapping mutation", async () => {
    const unconfirmed = happyDependencies();
    unconfirmed.io.confirmCurrentAccount.mockResolvedValue(false);
    const accountAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: unconfirmed.runner, helper: unconfirmed.helper,
      io: unconfirmed.io, probes: unconfirmed.probes, ownership: unconfirmed.ownership, serveConfigClient: unconfirmed.serveConfigClient,
    });
    await expect(accountAdapter.prepare()).rejects.toMatchObject({ reason: "account_not_confirmed" });
    expect(unconfirmed.calls).not.toContain("up --json --timeout=5s");

    const machine = happyDependencies({ status: [fixture("status-machine-auth.json")] });
    const machineAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: machine.runner, helper: machine.helper,
      io: machine.io, probes: machine.probes, ownership: machine.ownership, serveConfigClient: machine.serveConfigClient,
    });
    await expect(machineAdapter.prepare()).rejects.toMatchObject({ reason: "machine_auth_required" });
    expect(machine.calls.some((call) => call.startsWith("serve --bg "))).toBe(false);
  });

  it("offers installation once, resumes discovery, and treats cancellation as a safe pause", async () => {
    const cancelled = happyDependencies();
    cancelled.helper.discoverTailscale.mockResolvedValue({ state: "paused", reason: "tailscale_not_installed" });
    const cancelledAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: cancelled.runner, helper: cancelled.helper,
      io: cancelled.io, probes: cancelled.probes, ownership: cancelled.ownership, serveConfigClient: cancelled.serveConfigClient,
    });
    await expect(cancelledAdapter.prepare()).rejects.toMatchObject({ reason: "not_installed" });
    expect(cancelled.helper.installTailscale).not.toHaveBeenCalled();

    const installed = happyDependencies();
    installed.io.offerInstall.mockResolvedValue(true);
    installed.helper.discoverTailscale
      .mockResolvedValueOnce({ state: "paused", reason: "tailscale_not_installed" })
      .mockResolvedValue({ state: "ready", cliPath: executable, daemonPath: "C:\\Program Files\\Tailscale\\tailscaled.exe" });
    const installedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: installed.runner, helper: installed.helper,
      io: installed.io, probes: installed.probes, ownership: installed.ownership, serveConfigClient: installed.serveConfigClient,
    });
    await expect(installedAdapter.prepare()).resolves.toMatchObject({ ready: true });
    expect(installed.helper.installTailscale).toHaveBeenCalledTimes(1);
  });

  it("changes only consented unattended and shields-up preferences and verifies each targeted value", async () => {
    const dependencies = happyDependencies({ preferences: { unattended: false, shieldsUp: true } });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });
    await expect(adapter.prepare()).resolves.toMatchObject({ ready: true });
    expect(dependencies.helper.setPreference.mock.calls).toEqual([
      ["unattended", true, undefined],
      ["shields-up", false, undefined],
    ]);
    expect(dependencies.io.confirmPreference.mock.calls).toEqual([
      ["unattended", true, undefined],
      ["shields-up", false, undefined],
    ]);
    expect(dependencies.calls.some((call) => call.startsWith("up --unattended"))).toBe(false);
    expect(dependencies.calls.some((call) => call === "logout")).toBe(false);
  });

  it("journals each preference restoration before mutation so process-loss recovery is conditional", async () => {
    for (const scenario of [
      {
        name: "unattended" as const,
        initial: { unattended: false, shieldsUp: false },
        changed: { unattended: true, shieldsUp: false },
        restored: { unattended: false, shieldsUp: false },
      },
      {
        name: "shields-up" as const,
        initial: { unattended: true, shieldsUp: true },
        changed: { unattended: true, shieldsUp: false },
        restored: { unattended: true, shieldsUp: true },
      },
    ]) {
      const dependencies = happyDependencies({ preferences: scenario.initial });
      let stored: TailscaleMappingOwnership | undefined;
      let journalAtMutation: TailscaleMappingOwnership | undefined;
      let journalAtFailure: TailscaleMappingOwnership | undefined;
      dependencies.ownership.read.mockImplementation(async () => stored);
      dependencies.ownership.write.mockImplementation(async (value) => { stored = structuredClone(value); return "written"; });
      dependencies.ownership.replace.mockImplementation(async (expected, replacement) => {
        if (JSON.stringify(stored) !== JSON.stringify(expected)) return false;
        stored = structuredClone(replacement);
        return true;
      });
      const setPreference = dependencies.helper.setPreference.getMockImplementation()!;
      dependencies.helper.setPreference.mockImplementation(async (...args) => {
        if (args[0] === scenario.name) journalAtMutation = structuredClone(stored);
        await setPreference(...args);
      });
      await expect(new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
        injectFailure: (boundary) => {
          if (boundary === `${scenario.name.replace("-", "_")}_write`) {
            journalAtFailure = structuredClone(stored);
            throw new Error(`simulated process loss at ${scenario.name}`);
          }
        },
      }).prepare()).rejects.toThrow(`simulated process loss at ${scenario.name}`);

      expect(journalAtMutation).toMatchObject({
        phase: "preferences",
        preferenceRestorations: [expect.objectContaining({ name: scenario.name })],
      });
      expect(journalAtFailure).toEqual(journalAtMutation);

      const recovered = happyDependencies({ preferences: scenario.changed });
      let recoveredStored = journalAtFailure;
      recovered.ownership.read.mockImplementation(async () => recoveredStored);
      recovered.ownership.remove.mockImplementation(async () => { recoveredStored = undefined; return true; });
      await new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: recovered.runner, helper: recovered.helper,
        io: recovered.io, probes: recovered.probes, ownership: recovered.ownership, serveConfigClient: recovered.serveConfigClient,
      }).reconcileOwned();
      expect(recovered.preferenceState).toEqual(scenario.restored);
      expect(recoveredStored).toBeUndefined();
    }
  });

  it("does not claim a compatible mapping created externally while preferences are being changed", async () => {
    const dependencies = happyDependencies({
      preferences: { unattended: false, shieldsUp: false },
      serveSequence: [fixture("serve-empty.json"), fixture("serve-compatible.json"), fixture("serve-compatible.json")],
    });
    let stored: TailscaleMappingOwnership | undefined;
    dependencies.ownership.read.mockImplementation(async () => stored);
    dependencies.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
    dependencies.ownership.replace.mockImplementation(async (expected, replacement) => {
      if (stored !== expected) return false;
      stored = replacement;
      return true;
    });
    dependencies.ownership.remove.mockImplementation(async () => { stored = undefined; return true; });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });

    await expect(adapter.prepare()).rejects.toMatchObject({ reason: "mapping_conflict" });
    expect(dependencies.calls).not.toContain("localapi remove exact mapping");
    expect(dependencies.preferenceState.unattended).toBe(false);
    expect(stored).toBeUndefined();
  });

  it("conditionally restores a wizard-changed preference when a later preference is rejected", async () => {
    const dependencies = happyDependencies({ preferences: { unattended: false, shieldsUp: true } });
    dependencies.io.confirmPreference
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });

    await expect(adapter.prepare()).rejects.toMatchObject({ reason: "incoming_consent_required" });
    expect(dependencies.helper.setPreference.mock.calls).toEqual([
      ["unattended", true, undefined],
      ["unattended", false, expect.any(AbortSignal)],
    ]);
    expect(dependencies.calls.some((call) => call.startsWith("serve --bg "))).toBe(false);
  });

  it("restores changed preferences in reverse on failure without overwriting an external edit", async () => {
    const dependencies = happyDependencies({
      serve: fixture("serve-empty.json"),
      preferences: { unattended: false, shieldsUp: true },
    });
    dependencies.probes.remote.mockImplementation(async () => {
      dependencies.preferenceState.unattended = false;
      throw new Error("remote probe failed after external preference edit");
    });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });

    await expect(adapter.prepare()).rejects.toThrow("remote probe failed");
    expect(dependencies.preferenceState).toEqual({ unattended: false, shieldsUp: true });
    expect(dependencies.helper.setPreference.mock.calls).toEqual([
      ["unattended", true, undefined],
      ["shields-up", false, undefined],
      ["shields-up", true, expect.any(AbortSignal)],
    ]);
  });

  it("retains ownership and never touches rollback preferences after an account switch", async () => {
    const original = fixture("status-running.json");
    const switched = original.replaceAll("fixture@example.com", "other@example.com");
    const dependencies = happyDependencies({
      status: [original, switched],
      serve: fixture("serve-empty.json"),
      preferences: { unattended: false, shieldsUp: true },
    });
    let stored: TailscaleMappingOwnership | undefined;
    dependencies.ownership.read.mockImplementation(async () => stored);
    dependencies.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
    dependencies.ownership.replace.mockImplementation(async (expected, replacement) => {
      if (stored !== expected) return false;
      stored = replacement;
      return true;
    });
    dependencies.ownership.remove.mockImplementation(async () => { stored = undefined; return true; });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });

    await expect(adapter.prepare()).rejects.toMatchObject({ reason: "account_changed" });
    expect(dependencies.helper.setPreference.mock.calls).toEqual([
      ["unattended", true, undefined],
      ["shields-up", false, undefined],
    ]);
    expect(dependencies.preferenceState).toEqual({ unattended: true, shieldsUp: false });
    expect(stored).toBeDefined();
    expect(dependencies.ownership.remove).not.toHaveBeenCalled();
  });

  it("rechecks account ownership immediately before each rollback preference read", async () => {
    const original = fixture("status-running.json");
    const switched = original.replaceAll("fixture@example.com", "other@example.com");
    const dependencies = happyDependencies({
      status: [original, original, switched],
      preferences: { unattended: true, shieldsUp: false },
    });
    const accountTailnetHash = createHmac("sha256", Buffer.alloc(32, 7)).update(JSON.stringify({
      accountId: "42",
      accountLabel: "fixture@example.com",
      tailnetName: "fixture@example.com",
      magicDnsSuffix: "fixture-tailnet.ts.net",
    })).digest("hex");
    const owned: TailscaleMappingOwnership = {
      schemaVersion: 2,
      phase: "preferences",
      ownershipSubtype: "wizard-created",
      mappingFingerprint: "a".repeat(64),
      mappingStateFingerprint: "b".repeat(64),
      accountTailnetHash,
      dnsName: "cozy.fixture-tailnet.ts.net",
      target: "127.0.0.1:18787",
      preferenceRestorations: [{ name: "unattended", before: false, after: true }],
      createdAt: 1,
    };
    dependencies.ownership.read.mockResolvedValue(owned);
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });

    await expect(adapter.reconcileOwned()).rejects.toMatchObject({ reason: "account_changed" });
    expect(dependencies.calls).not.toContain("get --json unattended");
    expect(dependencies.helper.setPreference).not.toHaveBeenCalled();
    expect(dependencies.ownership.remove).not.toHaveBeenCalled();
  });

  it("awaits both mapping-status commands before propagating either failure", async () => {
    const dependencies = happyDependencies();
    const defaultRun = dependencies.runner.getMockImplementation()!;
    let releaseFunnel: (() => void) | undefined;
    dependencies.runner.mockImplementation(async (...args) => {
      const command = args[1].join(" ");
      if (command === "serve status --json") throw new Error("serve status failed");
      if (command === "funnel status --json") return await new Promise((resolve) => {
        releaseFunnel = () => resolve({ exitCode: 0, stdout: fixture("funnel-empty.json"), stderr: "" });
      });
      return await defaultRun(...args);
    });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });

    let settled = false;
    const outcome = adapter.inspect().then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    ).finally(() => { settled = true; });
    await vi.waitFor(() => expect(releaseFunnel).toBeTypeOf("function"));
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFunnel!();
    expect((await outcome).error).toBeDefined();
  });

  it("refuses ready and certificate-missing port-443 conflicts before consent or preference mutation", async () => {
    for (const status of [[fixture("status-running.json")], [fixture("status-cert-unavailable.json")]]) {
      const dependencies = happyDependencies({
        status,
        serve: fixture("serve-conflicting-web.json"),
        preferences: { unattended: false, shieldsUp: true },
      });
      const adapter = new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
      });

      await expect(adapter.prepare()).rejects.toMatchObject({ reason: "mapping_conflict" });
      expect(dependencies.helper.setPreference).not.toHaveBeenCalled();
      expect(dependencies.io.confirmCertificateTransparency).not.toHaveBeenCalled();
      expect(dependencies.calls.some((call) => call.startsWith("serve --https="))).toBe(false);
    }
  });

  it("requires separate preference consent and pauses precisely when policy prevents a verified change", async () => {
    const declined = happyDependencies({ preferences: { unattended: false, shieldsUp: false } });
    declined.io.confirmPreference.mockResolvedValue(false);
    const declinedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: declined.runner, helper: declined.helper,
      io: declined.io, probes: declined.probes, ownership: declined.ownership, serveConfigClient: declined.serveConfigClient,
    });
    await expect(declinedAdapter.prepare()).rejects.toMatchObject({ reason: "unattended_consent_required" });
    expect(declined.helper.setPreference).not.toHaveBeenCalled();

    const managed = happyDependencies({ preferences: { unattended: false, shieldsUp: false } });
    managed.helper.setPreference.mockRejectedValue(new Error("fixture policy refusal"));
    const managedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: managed.runner, helper: managed.helper,
      io: managed.io, probes: managed.probes, ownership: managed.ownership, serveConfigClient: managed.serveConfigClient,
    });
    await expect(managedAdapter.prepare()).rejects.toMatchObject({ reason: "managed_policy" });
    expect(managed.calls.some((call) => call.startsWith("serve --bg "))).toBe(false);
  });

  it("uses only an approved unused temporary foreground text mapping for HTTPS consent, then re-inspects", async () => {
    const dependencies = happyDependencies({
      status: [fixture("status-cert-unavailable.json"), fixture("status-running.json")],
    });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
      loginPollAttempts: 2, loginPollDelayMs: 0,
    });

    await expect(adapter.prepare()).resolves.toMatchObject({ ready: true });
    expect(dependencies.io.confirmCertificateTransparency).toHaveBeenCalledTimes(1);
    expect(dependencies.io.chooseHttpsConsentPort).toHaveBeenCalledWith([443], undefined);
    expect(dependencies.calls).toContain("serve --https=8443 text:CozyGateway HTTPS consent");
    expect(dependencies.helper.openBrowser).toHaveBeenCalledWith(
      "https-consent",
      "https://console.tailscale.com/admin/feature/fixture",
      undefined,
    );
    expect(dependencies.calls).not.toContain("funnel --bg --https=8443 text:CozyGateway HTTPS consent");
  });

  it("rejects TLS bypass, wrong SAN, redirects, h2, health loss, and short or broken WSS", async () => {
    const cases = [
      { tlsVerification: "system", tlsAuthorized: false },
      { certificateDnsNames: ["wrong.fixture-tailnet.ts.net"] },
      { redirected: true },
      { alpn: "h2" },
      { healthStatus: 503 },
      { webSocketEcho: false },
      { webSocketOpenMs: 999 },
    ] as const;
    for (const override of cases) {
      const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
      const baseline = await dependencies.probes.remote("", "");
      dependencies.probes.remote.mockResolvedValue({ ...baseline, ...override } as never);
      const adapter = new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
      });
      await expect(adapter.prepare()).rejects.toBeInstanceOf(Error);
      expect(dependencies.calls).toContain("localapi remove exact mapping");
      expect(dependencies.ownership.write).toHaveBeenCalledTimes(1);
      expect(dependencies.ownership.remove).toHaveBeenCalledTimes(1);
    }
  });

  it("rolls back exact wizard-owned live state after every post-create failure boundary", async () => {
    for (const boundary of ["mapping_create", "mapping_reinspect", "remote_probe", "ownership_write"] as const) {
      const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
      const adapter = new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
        injectFailure: (current) => {
          if (current === boundary) throw new Error(`fixture failure: ${boundary}`);
        },
      });
      await expect(adapter.prepare()).rejects.toThrow(`fixture failure: ${boundary}`);
      expect({
        boundary,
        removals: dependencies.calls.filter((call) => call === "localapi remove exact mapping").length,
        ownershipRemovals: dependencies.ownership.remove.mock.calls.length,
      }).toEqual({ boundary, removals: boundary === "ownership_write" ? 0 : 1, ownershipRemovals: 1 });
    }
  });

  it("conditionally rolls back durable owned state but preserves concurrent or reused mappings", async () => {
    const owned = happyDependencies({ serve: fixture("serve-empty.json") });
    const ownedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: owned.runner, helper: owned.helper,
      io: owned.io, probes: owned.probes, ownership: owned.ownership, serveConfigClient: owned.serveConfigClient,
    });
    const endpoint = await ownedAdapter.prepare();
    await ownedAdapter.rollbackOwned(endpoint);
    expect(owned.calls.filter((call) => call === "localapi remove exact mapping")).toHaveLength(1);
    expect(owned.ownership.remove).toHaveBeenCalledTimes(1);

    const reused = happyDependencies();
    const reusedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: reused.runner, helper: reused.helper,
      io: reused.io, probes: reused.probes, ownership: reused.ownership, serveConfigClient: reused.serveConfigClient,
    });
    const reusedEndpoint = await reusedAdapter.prepare();
    await reusedAdapter.rollbackOwned(reusedEndpoint);
    expect(reused.calls).not.toContain("localapi remove exact mapping");

    const concurrent = happyDependencies({
      serve: fixture("serve-empty.json"),
      serveSequence: [
        fixture("serve-empty.json"),
        fixture("serve-empty.json"),
        fixture("serve-compatible.json"),
        fixture("serve-conflicting-tcp.json"),
      ],
    });
    const concurrentAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: concurrent.runner, helper: concurrent.helper,
      io: concurrent.io, probes: concurrent.probes, ownership: concurrent.ownership, serveConfigClient: concurrent.serveConfigClient,
    });
    const concurrentEndpoint = await concurrentAdapter.prepare();
    await concurrentAdapter.rollbackOwned(concurrentEndpoint);
    expect(concurrent.calls).not.toContain("localapi remove exact mapping");
  });

  it("reconciles a timed-out create that applied and records exact ownership", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    const originalCreate = dependencies.serveConfigClient.createExactTlsTerminatedMapping.getMockImplementation()!;
    dependencies.serveConfigClient.createExactTlsTerminatedMapping.mockImplementation(async (...args) => {
      await originalCreate(...args);
      throw new TailscaleLocalApiError("timeout");
    });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });

    await expect(adapter.prepare()).resolves.toMatchObject({ createdByWizard: true });
    expect(dependencies.ownership.write).toHaveBeenCalledTimes(1);
  });

  it("durably records provisional creation before Serve mutation and promotes only after proof", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    const sequence: string[] = [];
    let stored: TailscaleMappingOwnership | undefined;
    const originalCreate = dependencies.serveConfigClient.createExactTlsTerminatedMapping.getMockImplementation()!;
    dependencies.serveConfigClient.createExactTlsTerminatedMapping.mockImplementation(async (...args) => {
      sequence.push("serve:create");
      return originalCreate(...args);
    });
    dependencies.ownership.write.mockImplementation(async (value) => {
      sequence.push(`ownership:${value.phase}`);
      stored = value;
      return "written";
    });
    dependencies.ownership.replace.mockImplementation(async (expected, replacement) => {
      expect(stored).toEqual(expected);
      sequence.push(`ownership:${replacement.phase}`);
      stored = replacement;
      return true;
    });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });

    await expect(adapter.prepare()).resolves.toMatchObject({ createdByWizard: true });
    expect(sequence).toEqual([
      "ownership:preferences", "ownership:provisional", "serve:create", "ownership:active",
    ]);
    expect(stored).toMatchObject({ phase: "active", ownershipSubtype: "wizard-created" });
  });

  it("reconciles an exact live mapping from durable provisional ownership after process loss", async () => {
    const source = happyDependencies({ serve: fixture("serve-empty.json") });
    await new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: source.runner, helper: source.helper,
      io: source.io, probes: source.probes, ownership: source.ownership, serveConfigClient: source.serveConfigClient,
    }).prepare();
    const provisional = source.ownership.replace.mock.calls
      .find((call) => call[1].phase === "provisional")?.[1];
    expect(provisional).toMatchObject({ phase: "provisional", ownershipSubtype: "wizard-created" });

    const resumed = happyDependencies();
    let stored = provisional;
    resumed.ownership.read.mockImplementation(async () => stored);
    resumed.ownership.replace.mockImplementation(async (expected, replacement) => {
      if (stored !== expected) return false;
      stored = replacement;
      return true;
    });
    const endpoint = await new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: resumed.runner, helper: resumed.helper,
      io: resumed.io, probes: resumed.probes, ownership: resumed.ownership, serveConfigClient: resumed.serveConfigClient,
    }).prepare();

    expect(endpoint.createdByWizard).toBe(true);
    expect(stored).toMatchObject({ phase: "active" });
    expect(resumed.calls.some((call) => call.startsWith("serve --bg "))).toBe(false);
    expect(resumed.calls).not.toContain("localapi remove exact mapping");
  });

  it("conditionally removes exact provisional Serve state during crash or uninstall recovery", async () => {
    const source = happyDependencies({ serve: fixture("serve-empty.json") });
    await new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: source.runner, helper: source.helper,
      io: source.io, probes: source.probes, ownership: source.ownership, serveConfigClient: source.serveConfigClient,
    }).prepare();
    const provisional = source.ownership.replace.mock.calls
      .find((call) => call[1].phase === "provisional")![1];

    const recovered = happyDependencies();
    let stored: TailscaleMappingOwnership | undefined = provisional;
    recovered.ownership.read.mockImplementation(async () => stored);
    recovered.ownership.remove.mockImplementation(async (expected) => {
      if (stored !== expected) return false;
      stored = undefined;
      return true;
    });
    await new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: recovered.runner, helper: recovered.helper,
      io: recovered.io, probes: recovered.probes, ownership: recovered.ownership, serveConfigClient: recovered.serveConfigClient,
    }).reconcileOwned();

    expect(recovered.calls.filter((call) => call === "localapi remove exact mapping")).toHaveLength(1);
    expect(stored).toBeUndefined();

    const concurrent = happyDependencies({ serve: fixture("serve-conflicting-tcp.json") });
    let concurrentStored: TailscaleMappingOwnership | undefined = provisional;
    concurrent.ownership.read.mockImplementation(async () => concurrentStored);
    concurrent.ownership.remove.mockImplementation(async () => { concurrentStored = undefined; return true; });
    await new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: concurrent.runner, helper: concurrent.helper,
      io: concurrent.io, probes: concurrent.probes, ownership: concurrent.ownership, serveConfigClient: concurrent.serveConfigClient,
    }).reconcileOwned();
    expect(concurrent.calls).not.toContain("localapi remove exact mapping");
    expect(concurrentStored).toBeUndefined();
  });

  it("CAS-adds newly changed preferences to active ownership for later conditional rollback", async () => {
    const initial = happyDependencies({ serve: fixture("serve-empty.json") });
    let stored: TailscaleMappingOwnership | undefined;
    initial.ownership.read.mockImplementation(async () => stored);
    initial.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
    initial.ownership.replace.mockImplementation(async (expected, replacement) => {
      if (stored !== expected) return false;
      stored = replacement;
      return true;
    });
    initial.ownership.remove.mockImplementation(async () => { stored = undefined; return true; });
    await new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: initial.runner, helper: initial.helper,
      io: initial.io, probes: initial.probes, ownership: initial.ownership, serveConfigClient: initial.serveConfigClient,
    }).prepare();
    expect(stored).toMatchObject({ phase: "active", preferenceRestorations: [] });

    const repeated = happyDependencies({ preferences: { unattended: true, shieldsUp: true } });
    repeated.ownership.read.mockImplementation(async () => stored);
    repeated.ownership.replace.mockImplementation(async (expected, replacement) => {
      if (stored !== expected) return false;
      stored = replacement;
      return true;
    });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: repeated.runner, helper: repeated.helper,
      io: repeated.io, probes: repeated.probes, ownership: repeated.ownership, serveConfigClient: repeated.serveConfigClient,
    });
    const endpoint = await adapter.prepare();

    expect(stored).toMatchObject({
      phase: "active",
      preferenceRestorations: [{ name: "shields-up", before: true, after: false }],
    });
    await adapter.rollbackOwned(endpoint);
    expect(repeated.preferenceState.shieldsUp).toBe(true);
  });

  it("uses fresh bounded recovery reads when create applies as the caller aborts", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    const controller = new AbortController();
    const originalCreate = dependencies.serveConfigClient.createExactTlsTerminatedMapping.getMockImplementation()!;
    dependencies.serveConfigClient.createExactTlsTerminatedMapping.mockImplementation(async (...args) => {
      const result = await originalCreate(...args);
      controller.abort();
      return result;
    });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
      cliTimeoutMs: 100,
    });

    await expect(adapter.prepare(controller.signal)).rejects.toMatchObject({ retryable: true });
    expect(dependencies.calls).toContain("localapi remove exact mapping");
    expect(dependencies.ownership.write).toHaveBeenCalledTimes(1);
    expect(dependencies.ownership.remove).toHaveBeenCalledTimes(1);
  });

  it("reconciles uncertain removal and stale ownership after removal failure injection", async () => {
    for (const boundary of ["mapping_remove", "ownership_remove"] as const) {
      const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
      let stored: Awaited<ReturnType<typeof dependencies.ownership.read>>;
      dependencies.ownership.read.mockImplementation(async () => stored);
      dependencies.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
      dependencies.ownership.remove.mockImplementation(async () => { stored = undefined; return true; });
      const adapter = new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
        injectFailure: (current) => {
          if (current === boundary) throw new Error(`fixture failure: ${boundary}`);
        },
      });
      const endpoint = await adapter.prepare();
      await expect(adapter.rollbackOwned(endpoint)).rejects.toThrow(`fixture failure: ${boundary}`);

      const resumed = new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
      });
      await expect(resumed.rollbackOwned(endpoint)).resolves.toBeUndefined();
      expect(stored).toBeUndefined();
      expect(dependencies.calls.filter((call) => call === "localapi remove exact mapping")).toHaveLength(1);
    }

    const timedOut = happyDependencies({ serve: fixture("serve-empty.json") });
    let stored: Awaited<ReturnType<typeof timedOut.ownership.read>>;
    timedOut.ownership.read.mockImplementation(async () => stored);
    timedOut.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
    timedOut.ownership.remove.mockImplementation(async () => { stored = undefined; return true; });
    const timedOutAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: timedOut.runner, helper: timedOut.helper,
      io: timedOut.io, probes: timedOut.probes, ownership: timedOut.ownership, serveConfigClient: timedOut.serveConfigClient,
    });
    const endpoint = await timedOutAdapter.prepare();
    const originalRemoval = timedOut.serveConfigClient.removeExactTlsTerminatedMapping.getMockImplementation()!;
    timedOut.serveConfigClient.removeExactTlsTerminatedMapping.mockImplementation(async (...args) => {
      await originalRemoval(...args);
      throw new TailscaleCliError("timeout");
    });
    await expect(timedOutAdapter.rollbackOwned(endpoint)).resolves.toBeUndefined();
    expect(stored).toBeUndefined();

    const aborted = happyDependencies({ serve: fixture("serve-empty.json") });
    let abortedStored: Awaited<ReturnType<typeof aborted.ownership.read>>;
    aborted.ownership.read.mockImplementation(async () => abortedStored);
    aborted.ownership.write.mockImplementation(async (value) => { abortedStored = value; return "written"; });
    aborted.ownership.remove.mockImplementation(async () => { abortedStored = undefined; return true; });
    const abortedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: aborted.runner, helper: aborted.helper,
      io: aborted.io, probes: aborted.probes, ownership: aborted.ownership, serveConfigClient: aborted.serveConfigClient,
      cliTimeoutMs: 100,
    });
    const abortedEndpoint = await abortedAdapter.prepare();
    const controller = new AbortController();
    const abortedOriginal = aborted.serveConfigClient.removeExactTlsTerminatedMapping.getMockImplementation()!;
    aborted.serveConfigClient.removeExactTlsTerminatedMapping.mockImplementation(async (...args) => {
      const result = await abortedOriginal(...args);
      controller.abort();
      return result;
    });
    await expect(abortedAdapter.rollbackOwned(abortedEndpoint, controller.signal)).rejects.toBeDefined();
    expect(abortedStored).toBeDefined();
  });

  it("does not start fresh recovery commands after cleanup cancellation during removal", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    let stored: Awaited<ReturnType<typeof dependencies.ownership.read>>;
    dependencies.ownership.read.mockImplementation(async () => stored);
    dependencies.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
    dependencies.ownership.replace.mockImplementation(async (expected, replacement) => {
      if (stored !== expected) return false;
      stored = replacement;
      return true;
    });
    dependencies.ownership.remove.mockImplementation(async () => { stored = undefined; return true; });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });
    await adapter.prepare();
    const controller = new AbortController();
    const original = dependencies.serveConfigClient.removeExactTlsTerminatedMapping.getMockImplementation()!;
    dependencies.serveConfigClient.removeExactTlsTerminatedMapping.mockImplementation(async (...args) => {
      const result = await original(...args);
      controller.abort();
      return result;
    });

    await expect(adapter.reconcileOwned(controller.signal)).rejects.toBeDefined();
    expect(stored).toBeDefined();
    const removal = dependencies.calls.lastIndexOf("localapi remove exact mapping");
    expect(dependencies.calls.slice(removal + 1)).not.toContain("serve status --json");
    expect(dependencies.calls.slice(removal + 1)).not.toContain("funnel status --json");
  });

  it("fails closed and retains ownership when Serve reports removal success but exact state remains", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    let stored: Awaited<ReturnType<typeof dependencies.ownership.read>>;
    dependencies.ownership.read.mockImplementation(async () => stored);
    dependencies.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
    dependencies.ownership.replace.mockImplementation(async (expected, replacement) => {
      if (stored !== expected) return false;
      stored = replacement;
      return true;
    });
    dependencies.ownership.remove.mockImplementation(async () => { stored = undefined; return true; });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });
    const endpoint = await adapter.prepare();
    dependencies.serveConfigClient.removeExactTlsTerminatedMapping.mockResolvedValue("removed");

    await expect(adapter.rollbackOwned(endpoint)).rejects.toMatchObject({ reason: "mapping" });
    expect(stored).toMatchObject({ phase: "active", ownershipSubtype: "wizard-created" });
  });

  it("retains ownership and never invokes CLI off when LocalAPI reports a concurrent ServeConfig swap", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    let stored: Awaited<ReturnType<typeof dependencies.ownership.read>>;
    dependencies.ownership.read.mockImplementation(async () => stored);
    dependencies.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
    dependencies.ownership.replace.mockImplementation(async (expected, replacement) => {
      if (stored !== expected) return false;
      stored = replacement;
      return true;
    });
    dependencies.ownership.remove.mockImplementation(async () => { stored = undefined; return true; });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
      serveConfigClient: dependencies.serveConfigClient,
    });
    const endpoint = await adapter.prepare();
    dependencies.serveConfigClient.removeExactTlsTerminatedMapping.mockResolvedValue("concurrent");

    await expect(adapter.rollbackOwned(endpoint)).rejects.toMatchObject({ reason: "mapping" });
    expect(stored).toMatchObject({ phase: "active", ownershipSubtype: "wizard-created" });
    expect(dependencies.calls).not.toContain("serve --tls-terminated-tcp=443 off");
  });

  it("throws typed mapping failure immediately when prepare rollback cannot remove exact Serve state", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    let stored: TailscaleMappingOwnership | undefined;
    dependencies.ownership.read.mockImplementation(async () => stored);
    dependencies.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
    dependencies.ownership.replace.mockImplementation(async (expected, replacement) => {
      if (stored !== expected) return false;
      stored = replacement;
      return true;
    });
    dependencies.serveConfigClient.removeExactTlsTerminatedMapping.mockResolvedValue("removed");
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
      injectFailure: (boundary) => {
        if (boundary === "mapping_create") throw new Error("simulated post-create process loss");
      },
    });

    await expect(adapter.prepare()).rejects.toMatchObject({ reason: "mapping" });
    expect(stored).toMatchObject({ phase: "provisional", ownershipSubtype: "wizard-created" });
  });

  it("maps helper failures to precise typed retryable pauses", async () => {
    for (const [helperReason, pauseReason] of [
      ["installer_cancelled", "install_cancelled"],
      ["installer_reboot_required", "install_reboot_required"],
      ["installer_signature_invalid", "install_verification_failed"],
    ] as const) {
      const dependencies = happyDependencies();
      dependencies.io.offerInstall.mockResolvedValue(true);
      dependencies.helper.discoverTailscale.mockResolvedValue({ state: "paused", reason: "tailscale_not_installed" });
      dependencies.helper.installTailscale.mockRejectedValue(new WindowsHelperError(helperReason));
      const adapter = new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
      });
      await expect(adapter.prepare()).rejects.toMatchObject({
        retryable: true, reason: pauseReason, detail: helperReason,
      });
    }

    const browser = happyDependencies({ status: [fixture("status-needs-login.json")] });
    browser.helper.openBrowser.mockRejectedValue(new WindowsHelperError("browser_open_failed"));
    const browserAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: browser.runner, helper: browser.helper,
      io: browser.io, probes: browser.probes, ownership: browser.ownership, serveConfigClient: browser.serveConfigClient,
    });
    await expect(browserAdapter.prepare()).rejects.toMatchObject({
      reason: "login_browser_failed", detail: "browser_open_failed", retryable: true,
    });

    const policy = happyDependencies({ preferences: { unattended: false, shieldsUp: false } });
    policy.helper.setPreference.mockRejectedValue(new WindowsHelperError("preference_cancelled"));
    const policyAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: policy.runner, helper: policy.helper,
      io: policy.io, probes: policy.probes, ownership: policy.ownership, serveConfigClient: policy.serveConfigClient,
    });
    await expect(policyAdapter.prepare()).rejects.toMatchObject({
      reason: "preference_cancelled", detail: "preference_cancelled", retryable: true,
    });

    const verification = happyDependencies({ preferences: { unattended: false, shieldsUp: false } });
    verification.helper.setPreference.mockResolvedValue(undefined);
    const verificationAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: verification.runner, helper: verification.helper,
      io: verification.io, probes: verification.probes, ownership: verification.ownership, serveConfigClient: verification.serveConfigClient,
    });
    await expect(verificationAdapter.prepare()).rejects.toMatchObject({
      reason: "preference_verification_failed", detail: "preference_verification_failed", retryable: true,
    });
  });

  it("maps CLI login, status, and HTTPS-consent failures to redacted typed pauses", async () => {
    const login = happyDependencies({
      status: [fixture("status-needs-login.json")],
      login: fixture("login-malformed.txt"),
    });
    const loginAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: login.runner, helper: login.helper,
      io: login.io, probes: login.probes, ownership: login.ownership, serveConfigClient: login.serveConfigClient,
    });
    await expect(loginAdapter.prepare()).rejects.toMatchObject({
      reason: "login_failed", detail: "malformed_json", retryable: true,
    });

    const status = happyDependencies({ status: [fixture("status-unverifiable.json")] });
    const statusAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: status.runner, helper: status.helper,
      io: status.io, probes: status.probes, ownership: status.ownership, serveConfigClient: status.serveConfigClient,
    });
    await expect(statusAdapter.prepare()).rejects.toMatchObject({
      reason: "status_unavailable", detail: "invalid_status", retryable: true,
    });

    const consent = happyDependencies({ status: [fixture("status-cert-unavailable.json")] });
    const original = consent.runner.getMockImplementation()!;
    consent.runner.mockImplementation(async (...args) => args[1].join(" ").startsWith("serve --https=")
      ? { exitCode: 0, stdout: "https://console.tailscale.com.evil/admin/feature/secret\n", stderr: "" }
      : original(...args));
    const consentAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: consent.runner, helper: consent.helper,
      io: consent.io, probes: consent.probes, ownership: consent.ownership, serveConfigClient: consent.serveConfigClient,
    });
    const error = await consentAdapter.prepare().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "https_consent_failed", detail: "unexpected_output", retryable: true });
    expect(String(error)).not.toContain("secret");
  });

  it("persists exact mapping ownership in SQLite with conflict-safe write and conditional remove", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-tailscale-ownership-"));
    tempDirectories.push(directory);
    const storage = openStorage(join(directory, "gateway.sqlite"));
    const ownership = new SqliteTailscaleOwnershipStore(storage);
    const value = {
      schemaVersion: 2 as const,
      phase: "provisional" as const,
      ownershipSubtype: "wizard-created" as const,
      mappingFingerprint: "a".repeat(64),
      mappingStateFingerprint: "d".repeat(64),
      accountTailnetHash: "b".repeat(64),
      dnsName: "cozy.fixture-tailnet.ts.net",
      target: "127.0.0.1:18787",
      preferenceRestorations: [{ name: "unattended" as const, before: false, after: true }],
      createdAt: 123,
    };
    try {
      const key = await ownership.identityHmacKey();
      expect(key).toHaveLength(32);
      await expect(ownership.identityHmacKey()).resolves.toEqual(key);
      await expect(ownership.write(value)).resolves.toBe("written");
      const ownedStateJson = storage.onboardingOwnership("tailscale:443")!.ownedStateJson;
      expect(ownedStateJson).not.toContain(Buffer.from(key).toString("hex"));
      expect(ownedStateJson).not.toContain(Buffer.from(key).toString("base64"));
      await expect(ownership.write(value)).resolves.toBe("existing");
      await expect(ownership.write({ ...value, mappingFingerprint: "c".repeat(64) })).resolves.toBe("conflict");
      await expect(ownership.read()).resolves.toEqual(value);
      const active = { ...value, phase: "active" as const };
      await expect(ownership.replace(value, active)).resolves.toBe(true);
      await expect(ownership.read()).resolves.toEqual(active);
      await expect(ownership.remove({ ...active, createdAt: 124 })).resolves.toBe(false);
      await expect(ownership.remove(active)).resolves.toBe(true);
      await expect(ownership.read()).resolves.toBeUndefined();
    } finally {
      storage.close();
    }
  });

  it("keeps inspect read-only and reports changed preferences without offering install or repair", async () => {
    const absent = happyDependencies();
    absent.helper.discoverTailscale.mockResolvedValue({ state: "paused", reason: "tailscale_not_installed" });
    const absentAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: absent.runner, helper: absent.helper,
      io: absent.io, probes: absent.probes, ownership: absent.ownership, serveConfigClient: absent.serveConfigClient,
    });
    await expect(absentAdapter.inspect()).rejects.toMatchObject({ reason: "not_installed" });
    expect(absent.io.offerInstall).not.toHaveBeenCalled();
    expect(absent.helper.installTailscale).not.toHaveBeenCalled();

    const changed = happyDependencies({ preferences: { unattended: true, shieldsUp: true } });
    const changedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: changed.runner, helper: changed.helper,
      io: changed.io, probes: changed.probes, ownership: changed.ownership, serveConfigClient: changed.serveConfigClient,
    });
    await expect(changedAdapter.inspect()).rejects.toMatchObject({ reason: "status" });
    expect(changed.helper.setPreference).not.toHaveBeenCalled();
  });

  it("requires the supplied endpoint to match durable ownership before conditional rollback", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership, serveConfigClient: dependencies.serveConfigClient,
    });
    const endpoint = await adapter.prepare();
    await adapter.rollbackOwned({ ...endpoint, accountTailnetHash: "f".repeat(64) });
    expect(dependencies.calls).not.toContain("localapi remove exact mapping");
  });
});

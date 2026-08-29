import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { TailscaleCliError, type TailscaleCliRunner } from "../src/tailscale-cli.ts";
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
} = {}) {
  const calls: string[] = [];
  let serveState = options.serve ?? fixture("serve-compatible.json");
  const serveSequence = options.serveSequence === undefined ? undefined : [...options.serveSequence];
  const statuses = [...(options.status ?? [fixture("status-running.json")])];
  let unattended = options.preferences?.unattended ?? true;
  let shieldsUp = options.preferences?.shieldsUp ?? false;
  const runner = vi.fn<TailscaleCliRunner>(async (_file, argv) => {
    const command = argv.join(" ");
    calls.push(command);
    if (command === "version --json") return { exitCode: 0, stdout: fixture("version-supported.json"), stderr: "" };
    if (command === "status --json") return { exitCode: 0, stdout: statuses.length > 1 ? statuses.shift()! : statuses[0]!, stderr: "" };
    if (command === "up --json --timeout=5s") return {
      exitCode: 1,
      stdout: options.login ?? '{"AuthURL":"https://login.tailscale.com/a/fixture-opaque","BackendState":"NeedsLogin"}',
      stderr: "",
    };
    if (command === "get --json unattended") return { exitCode: 0, stdout: JSON.stringify({ unattended }), stderr: "" };
    if (command === "get --json shields-up") return { exitCode: 0, stdout: JSON.stringify({ "shields-up": shieldsUp }), stderr: "" };
    if (command === "serve status --json") return {
      exitCode: 0,
      stdout: serveSequence !== undefined && serveSequence.length > 0 ? serveSequence.shift()! : serveState,
      stderr: "",
    };
    if (command === "funnel status --json") return { exitCode: 0, stdout: options.funnel ?? fixture("funnel-empty.json"), stderr: "" };
    if (command === "serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:18787") {
      serveState = fixture("serve-compatible.json");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "serve --tls-terminated-tcp=443 off") {
      serveState = fixture("serve-empty.json");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
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
      if (preference === "unattended") unattended = enabled;
      else shieldsUp = enabled;
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
    read: vi.fn(async (_signal?: AbortSignal): Promise<TailscaleMappingOwnership | undefined> => undefined),
    write: vi.fn(async (_ownership: TailscaleMappingOwnership, _signal?: AbortSignal) => "written" as const),
    remove: vi.fn(async (_ownership: TailscaleMappingOwnership, _signal?: AbortSignal) => true),
  };
  return { calls, runner, helper, io, probes, ownership };
}

describe("TailscaleModeAdapter", () => {
  it("reuses an exact no-PROXY mapping as unowned after explicit current-account confirmation", async () => {
    const dependencies = happyDependencies();
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787,
      cliRunner: dependencies.runner,
      helper: dependencies.helper,
      io: dependencies.io,
      probes: dependencies.probes,
      ownership: dependencies.ownership,
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
    expect(dependencies.ownership.write).not.toHaveBeenCalled();
  });

  it("creates only the exact L4 mapping, proves it, and records wizard ownership", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787,
      cliRunner: dependencies.runner,
      helper: dependencies.helper,
      io: dependencies.io,
      probes: dependencies.probes,
      ownership: dependencies.ownership,
      now: () => 1_700_000_000_000,
    });

    await expect(adapter.prepare()).resolves.toMatchObject({ ready: true, createdByWizard: true });
    expect(dependencies.calls).toContain("serve --bg --tls-terminated-tcp=443 tcp://127.0.0.1:18787");
    expect(dependencies.ownership.write).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      dnsName: "cozy.fixture-tailnet.ts.net",
      target: "127.0.0.1:18787",
      createdAt: 1_700_000_000_000,
    }), undefined);
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
        ownership: dependencies.ownership,
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
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
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
      ownership: dependencies.ownership,
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
      io: unconfirmed.io, probes: unconfirmed.probes, ownership: unconfirmed.ownership,
    });
    await expect(accountAdapter.prepare()).rejects.toMatchObject({ reason: "account_not_confirmed" });
    expect(unconfirmed.calls).not.toContain("up --json --timeout=5s");

    const machine = happyDependencies({ status: [fixture("status-machine-auth.json")] });
    const machineAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: machine.runner, helper: machine.helper,
      io: machine.io, probes: machine.probes, ownership: machine.ownership,
    });
    await expect(machineAdapter.prepare()).rejects.toMatchObject({ reason: "machine_auth_required" });
    expect(machine.calls.some((call) => call.startsWith("serve --bg "))).toBe(false);
  });

  it("offers installation once, resumes discovery, and treats cancellation as a safe pause", async () => {
    const cancelled = happyDependencies();
    cancelled.helper.discoverTailscale.mockResolvedValue({ state: "paused", reason: "tailscale_not_installed" });
    const cancelledAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: cancelled.runner, helper: cancelled.helper,
      io: cancelled.io, probes: cancelled.probes, ownership: cancelled.ownership,
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
      io: installed.io, probes: installed.probes, ownership: installed.ownership,
    });
    await expect(installedAdapter.prepare()).resolves.toMatchObject({ ready: true });
    expect(installed.helper.installTailscale).toHaveBeenCalledTimes(1);
  });

  it("changes only consented unattended and shields-up preferences and verifies each targeted value", async () => {
    const dependencies = happyDependencies({ preferences: { unattended: false, shieldsUp: true } });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
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

  it("refuses ready and certificate-missing port-443 conflicts before consent or preference mutation", async () => {
    for (const status of [[fixture("status-running.json")], [fixture("status-cert-unavailable.json")]]) {
      const dependencies = happyDependencies({
        status,
        serve: fixture("serve-conflicting-web.json"),
        preferences: { unattended: false, shieldsUp: true },
      });
      const adapter = new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
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
      io: declined.io, probes: declined.probes, ownership: declined.ownership,
    });
    await expect(declinedAdapter.prepare()).rejects.toMatchObject({ reason: "unattended_consent_required" });
    expect(declined.helper.setPreference).not.toHaveBeenCalled();

    const managed = happyDependencies({ preferences: { unattended: false, shieldsUp: false } });
    managed.helper.setPreference.mockRejectedValue(new Error("fixture policy refusal"));
    const managedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: managed.runner, helper: managed.helper,
      io: managed.io, probes: managed.probes, ownership: managed.ownership,
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
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
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
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
      });
      await expect(adapter.prepare()).rejects.toBeInstanceOf(Error);
      expect(dependencies.calls).toContain("serve --tls-terminated-tcp=443 off");
      expect(dependencies.ownership.write).not.toHaveBeenCalled();
    }
  });

  it("rolls back exact wizard-owned live state after every post-create failure boundary", async () => {
    for (const boundary of ["mapping_create", "mapping_reinspect", "remote_probe", "ownership_write"] as const) {
      const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
      const adapter = new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
        injectFailure: (current) => {
          if (current === boundary) throw new Error(`fixture failure: ${boundary}`);
        },
      });
      await expect(adapter.prepare()).rejects.toThrow(`fixture failure: ${boundary}`);
      expect(dependencies.calls.filter((call) => call === "serve --tls-terminated-tcp=443 off")).toHaveLength(1);
      if (boundary === "ownership_write") expect(dependencies.ownership.remove).toHaveBeenCalledTimes(1);
    }
  });

  it("conditionally rolls back durable owned state but preserves concurrent or reused mappings", async () => {
    const owned = happyDependencies({ serve: fixture("serve-empty.json") });
    const ownedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: owned.runner, helper: owned.helper,
      io: owned.io, probes: owned.probes, ownership: owned.ownership,
    });
    const endpoint = await ownedAdapter.prepare();
    await ownedAdapter.rollbackOwned(endpoint);
    expect(owned.calls.filter((call) => call === "serve --tls-terminated-tcp=443 off")).toHaveLength(1);
    expect(owned.ownership.remove).toHaveBeenCalledTimes(1);

    const reused = happyDependencies();
    const reusedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: reused.runner, helper: reused.helper,
      io: reused.io, probes: reused.probes, ownership: reused.ownership,
    });
    const reusedEndpoint = await reusedAdapter.prepare();
    await reusedAdapter.rollbackOwned(reusedEndpoint);
    expect(reused.calls).not.toContain("serve --tls-terminated-tcp=443 off");

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
      io: concurrent.io, probes: concurrent.probes, ownership: concurrent.ownership,
    });
    const concurrentEndpoint = await concurrentAdapter.prepare();
    await concurrentAdapter.rollbackOwned(concurrentEndpoint);
    expect(concurrent.calls).not.toContain("serve --tls-terminated-tcp=443 off");
  });

  it("reconciles a timed-out create that applied and records exact ownership", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    const original = dependencies.runner.getMockImplementation()!;
    dependencies.runner.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].join(" ").startsWith("serve --bg --tls-terminated-tcp=443 "))
        throw new TailscaleCliError("timeout");
      return result;
    });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
    });

    await expect(adapter.prepare()).resolves.toMatchObject({ createdByWizard: true });
    expect(dependencies.ownership.write).toHaveBeenCalledTimes(1);
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
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
        injectFailure: (current) => {
          if (current === boundary) throw new Error(`fixture failure: ${boundary}`);
        },
      });
      const endpoint = await adapter.prepare();
      await expect(adapter.rollbackOwned(endpoint)).rejects.toThrow(`fixture failure: ${boundary}`);

      const resumed = new TailscaleModeAdapter({
        gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
      });
      await expect(resumed.rollbackOwned(endpoint)).resolves.toBeUndefined();
      expect(stored).toBeUndefined();
      expect(dependencies.calls.filter((call) => call === "serve --tls-terminated-tcp=443 off")).toHaveLength(1);
    }

    const timedOut = happyDependencies({ serve: fixture("serve-empty.json") });
    let stored: Awaited<ReturnType<typeof timedOut.ownership.read>>;
    timedOut.ownership.read.mockImplementation(async () => stored);
    timedOut.ownership.write.mockImplementation(async (value) => { stored = value; return "written"; });
    timedOut.ownership.remove.mockImplementation(async () => { stored = undefined; return true; });
    const timedOutAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: timedOut.runner, helper: timedOut.helper,
      io: timedOut.io, probes: timedOut.probes, ownership: timedOut.ownership,
    });
    const endpoint = await timedOutAdapter.prepare();
    const original = timedOut.runner.getMockImplementation()!;
    timedOut.runner.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].join(" ") === "serve --tls-terminated-tcp=443 off") throw new TailscaleCliError("timeout");
      return result;
    });
    await expect(timedOutAdapter.rollbackOwned(endpoint)).resolves.toBeUndefined();
    expect(stored).toBeUndefined();
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
        io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
      });
      await expect(adapter.prepare()).rejects.toMatchObject({
        retryable: true, reason: pauseReason, detail: helperReason,
      });
    }

    const browser = happyDependencies({ status: [fixture("status-needs-login.json")] });
    browser.helper.openBrowser.mockRejectedValue(new WindowsHelperError("browser_open_failed"));
    const browserAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: browser.runner, helper: browser.helper,
      io: browser.io, probes: browser.probes, ownership: browser.ownership,
    });
    await expect(browserAdapter.prepare()).rejects.toMatchObject({
      reason: "login_browser_failed", detail: "browser_open_failed", retryable: true,
    });

    const policy = happyDependencies({ preferences: { unattended: false, shieldsUp: false } });
    policy.helper.setPreference.mockRejectedValue(new WindowsHelperError("preference_cancelled"));
    const policyAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: policy.runner, helper: policy.helper,
      io: policy.io, probes: policy.probes, ownership: policy.ownership,
    });
    await expect(policyAdapter.prepare()).rejects.toMatchObject({
      reason: "preference_cancelled", detail: "preference_cancelled", retryable: true,
    });

    const verification = happyDependencies({ preferences: { unattended: false, shieldsUp: false } });
    verification.helper.setPreference.mockResolvedValue(undefined);
    const verificationAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: verification.runner, helper: verification.helper,
      io: verification.io, probes: verification.probes, ownership: verification.ownership,
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
      io: login.io, probes: login.probes, ownership: login.ownership,
    });
    await expect(loginAdapter.prepare()).rejects.toMatchObject({
      reason: "login_failed", detail: "malformed_json", retryable: true,
    });

    const status = happyDependencies({ status: [fixture("status-unverifiable.json")] });
    const statusAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: status.runner, helper: status.helper,
      io: status.io, probes: status.probes, ownership: status.ownership,
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
      io: consent.io, probes: consent.probes, ownership: consent.ownership,
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
      schemaVersion: 1 as const,
      mappingFingerprint: "a".repeat(64),
      accountTailnetHash: "b".repeat(64),
      dnsName: "cozy.fixture-tailnet.ts.net",
      target: "127.0.0.1:18787",
      createdAt: 123,
    };
    try {
      await expect(ownership.write(value)).resolves.toBe("written");
      await expect(ownership.write(value)).resolves.toBe("existing");
      await expect(ownership.write({ ...value, mappingFingerprint: "c".repeat(64) })).resolves.toBe("conflict");
      await expect(ownership.read()).resolves.toEqual(value);
      await expect(ownership.remove({ ...value, createdAt: 124 })).resolves.toBe(false);
      await expect(ownership.remove(value)).resolves.toBe(true);
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
      io: absent.io, probes: absent.probes, ownership: absent.ownership,
    });
    await expect(absentAdapter.inspect()).rejects.toMatchObject({ reason: "not_installed" });
    expect(absent.io.offerInstall).not.toHaveBeenCalled();
    expect(absent.helper.installTailscale).not.toHaveBeenCalled();

    const changed = happyDependencies({ preferences: { unattended: true, shieldsUp: true } });
    const changedAdapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: changed.runner, helper: changed.helper,
      io: changed.io, probes: changed.probes, ownership: changed.ownership,
    });
    await expect(changedAdapter.inspect()).rejects.toMatchObject({ reason: "status" });
    expect(changed.helper.setPreference).not.toHaveBeenCalled();
  });

  it("requires the supplied endpoint to match durable ownership before conditional rollback", async () => {
    const dependencies = happyDependencies({ serve: fixture("serve-empty.json") });
    const adapter = new TailscaleModeAdapter({
      gatewayPort: 18_787, cliRunner: dependencies.runner, helper: dependencies.helper,
      io: dependencies.io, probes: dependencies.probes, ownership: dependencies.ownership,
    });
    const endpoint = await adapter.prepare();
    await adapter.rollbackOwned({ ...endpoint, accountTailnetHash: "f".repeat(64) });
    expect(dependencies.calls).not.toContain("serve --tls-terminated-tcp=443 off");
  });
});

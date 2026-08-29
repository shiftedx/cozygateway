import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect as tlsConnect } from "node:tls";

import { WebSocket } from "ws";

import { newSetupCode } from "./auth.ts";
import { loadConfig } from "./config.ts";
import {
  listenerOrigin,
  SqliteOnboardingAuthority,
  syncManagedListenerTargets,
  updateListenerConfig,
} from "./configure.ts";
import type { CliIo, CliOnboardingController, CliRuntime } from "./cli.ts";
import { LanModeAdapter, type LanListenerState, type LanModeRuntime } from "./lan-mode.ts";
import {
  NetworkOnboarding,
  type NetworkModeAdapter,
  type OnboardingIo,
  type PreparedEndpoint,
} from "./network-onboarding.ts";
import { NetworkOnboardingStateFile } from "./onboarding-state.ts";
import { OperatorOnboardingClient, loadOperatorControlToken } from "./operator-onboarding.ts";
import { preparePairingOutput } from "./pairing-output.ts";
import { gatewayPostureFingerprint } from "./phone-verification.ts";
import { openStorage } from "./storage.ts";
import {
  SqliteTailscaleOwnershipStore,
  TailscaleModeAdapter,
  type TailscaleModeIo,
  type TailscaleModeProbes,
} from "./tailscale-mode.ts";
import { gatewayScheme } from "./tls.ts";
import { WindowsHelperClient } from "./windows-helper.ts";

function installState(configPath: string): Map<string, string> {
  const values = new Map<string, string>();
  const text = readFileSync(join(dirname(configPath), "install-state"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function sameListener(left: LanListenerState, right: LanListenerState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function health(origin: string, signal?: AbortSignal): Promise<{ ok: boolean; attachReady: boolean }> {
  const response = await fetch(`${origin}/health`, { redirect: "manual", signal: signal ?? AbortSignal.timeout(5_000) });
  if (response.status !== 200) return { ok: false, attachReady: false };
  const body = await response.json() as { attach?: { configured?: number; online?: number; deadLetters?: number } };
  const configured = body.attach?.configured ?? 0;
  return {
    ok: true,
    attachReady: configured > 0 && body.attach?.online === configured && body.attach?.deadLetters === 0,
  };
}

function websocket(origin: string, holdMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws`, { handshakeTimeout: 5_000 });
    let settled = false;
    let openedTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => finish(false);
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (openedTimer !== undefined) clearTimeout(openedTimer);
      signal?.removeEventListener("abort", abort);
      socket.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 5_000);
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("open", () => { openedTimer = setTimeout(() => finish(true), holdMs); });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

function tlsProbe(host: string, signal?: AbortSignal): Promise<{
  authorized: boolean; dnsNames: string[]; alpn: string | false;
}> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port: 443, servername: host, ALPNProtocols: ["h2", "http/1.1"] });
    const timer = setTimeout(() => socket.destroy(new Error("timeout")), 5_000);
    const abort = () => socket.destroy(new Error("cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const certificate = socket.getPeerCertificate();
      const dnsNames = (certificate.subjectaltname ?? "").split(/,\s*/)
        .filter((entry) => entry.startsWith("DNS:"))
        .map((entry) => entry.slice(4));
      const alpn: string | false = typeof socket.alpnProtocol === "string" ? socket.alpnProtocol : false;
      const result = {
        authorized: socket.authorized,
        dnsNames,
        alpn,
      };
      socket.end(); resolve(result);
    });
    socket.once("error", reject);
  });
}

class AdvancedModeAdapter implements NetworkModeAdapter {
  readonly mode = "advanced" as const;
  readonly #configPath: string;

  constructor(configPath: string) { this.#configPath = configPath; }
  prepare(signal?: AbortSignal) { return this.inspect(signal); }
  async inspect(signal?: AbortSignal): Promise<PreparedEndpoint> {
    const config = loadConfig(this.#configPath);
    const bindHost = config.host ?? "127.0.0.1";
    const local = listenerOrigin(bindHost, config.port, gatewayScheme(config));
    const canonicalOrigin = config.publicUrl ?? local;
    const checked = await health(canonicalOrigin, signal).catch(() => ({ ok: false, attachReady: false }));
    const ws = checked.ok ? await websocket(canonicalOrigin, 0, signal) : false;
    return {
      mode: "advanced", canonicalOrigin, bindHost, port: config.port,
      durableFingerprint: gatewayPostureFingerprint({ host: bindHost, port: config.port, canonicalOrigin }),
      ready: checked.ok && checked.attachReady && ws,
    };
  }
  async rollbackOwned(): Promise<void> {}
}

class WindowsTailscaleAdapter implements NetworkModeAdapter {
  readonly mode = "tailscale" as const;
  readonly #delegate: TailscaleModeAdapter;
  readonly #configPath: string;
  readonly #installRoot: string;
  readonly #helper: WindowsHelperClient;
  readonly #runtime: CliRuntime;

  constructor(input: {
    delegate: TailscaleModeAdapter;
    configPath: string;
    installRoot: string;
    helper: WindowsHelperClient;
    runtime: CliRuntime;
  }) {
    this.#delegate = input.delegate;
    this.#configPath = input.configPath;
    this.#installRoot = input.installRoot;
    this.#helper = input.helper;
    this.#runtime = input.runtime;
  }

  async #ensureLoopback(): Promise<void> {
    const config = loadConfig(this.#configPath);
    if ((config.host ?? "127.0.0.1") === "127.0.0.1" && config.publicUrl === undefined) return;
    updateListenerConfig(this.#configPath, "127.0.0.1", config.port, { clearPublicUrl: true });
    const profiles = syncManagedListenerTargets(this.#configPath);
    await this.#helper.protectPath(this.#installRoot, this.#configPath);
    await Promise.all(profiles.map((profile) =>
      this.#runtime.restartHermesProfile(profile.executable, profile.profile)));
    await this.#runtime.waitForGatewayReady(this.#configPath);
  }

  async prepare(signal?: AbortSignal): Promise<PreparedEndpoint> {
    await this.#ensureLoopback();
    return this.#delegate.prepare(signal);
  }

  async inspect(signal?: AbortSignal): Promise<PreparedEndpoint> {
    const endpoint = await this.#delegate.inspect(signal);
    const config = loadConfig(this.#configPath);
    return (config.host ?? "127.0.0.1") === "127.0.0.1" ? endpoint : { ...endpoint, ready: false };
  }

  rollbackOwned(endpoint: PreparedEndpoint, signal?: AbortSignal): Promise<void> {
    return this.#delegate.rollbackOwned(endpoint, signal);
  }
}

function tailscaleIo(io?: CliIo): TailscaleModeIo {
  const yes = async (prompt: string) => io !== undefined && /^(?:y|yes)$/i.test((await io.question(prompt)).trim());
  return {
    offerInstall: () => yes("Install the official signed Tailscale app? Windows may show UAC. [y/N] "),
    confirmCurrentAccount: ({ accountLabel, tailnetName }) =>
      yes(`Use the currently signed-in Tailscale account ${accountLabel} on ${tailnetName}? [y/N] `),
    confirmPreference: (preference, desired) => yes(
      preference === "unattended"
        ? "Keep this PC reachable after logout (sleep still disconnects it)? [y/N] "
        : `${desired ? "Enable" : "Allow"} incoming Tailscale connections? [y/N] `,
    ),
    confirmCertificateTransparency: () => yes(
      "Enable Tailscale HTTPS? This publishes the machine/tailnet DNS name in Certificate Transparency. [y/N] ",
    ),
    chooseHttpsConsentPort: async (occupied) => {
      for (let port = 49_152; port <= 65_535; port += 1) if (!occupied.includes(port)) return port;
      return undefined;
    },
  };
}

export function createWindowsOnboardingController(
  configPath: string,
  io: CliIo | undefined,
  runtime: CliRuntime,
): CliOnboardingController | undefined {
  const config = loadConfig(configPath);
  if (config.onboardingControlTokenFile === undefined) return undefined;
  const localRoot = dirname(configPath);
  const installRoot = dirname(localRoot);
  const helper = new WindowsHelperClient({ helperPath: join(installRoot, "bin", "cozygateway-windows-helper.ps1") });
  const storage = openStorage(config.dbPath);
  const authority = new SqliteOnboardingAuthority(storage);
  const control = new OperatorOnboardingClient({
    localOrigin: listenerOrigin("127.0.0.1", config.port, gatewayScheme(config)),
    token: loadOperatorControlToken(config.onboardingControlTokenFile),
  });
  const state = new NetworkOnboardingStateFile({
    localRoot,
    platform: "win32",
    protectWindowsAcl: (path) => helper.protectPath(installRoot, path),
  });

  const readListener = (): LanListenerState => {
    const current = loadConfig(configPath);
    const values = installState(configPath);
    const profiles = (values.get("profiles") ?? "").split(",").filter(Boolean);
    return {
      bindHost: current.host ?? "127.0.0.1",
      port: current.port,
      hermesTargets: profiles.map((profile) => ({
        profile,
        url: listenerOrigin("127.0.0.1", current.port, "http"),
      })),
    };
  };
  const lanRuntime: LanModeRuntime = {
    readAdapterInventory: (signal) => helper.adapterInventory(signal),
    readListenerState: async () => readListener(),
    compareAndSwapListener: async (expected, replacement) => {
      if (!sameListener(readListener(), expected)) return false;
      updateListenerConfig(configPath, replacement.bindHost, replacement.port, { clearPublicUrl: true });
      syncManagedListenerTargets(configPath);
      await helper.protectPath(installRoot, configPath);
      return true;
    },
    restartAndWait: async () => {
      const profiles = syncManagedListenerTargets(configPath);
      const results = await Promise.allSettled(profiles.map((profile) =>
        runtime.restartHermesProfile(profile.executable, profile.profile)));
      if (results.some((result) => result.status === "rejected")) throw new Error("Hermes restart failed");
      await runtime.waitForGatewayReady(configPath);
    },
    probeEndpoint: async (origin, signal) => {
      const checked = await health(origin, signal).catch(() => ({ ok: false, attachReady: false }));
      return { health: checked.ok, attachReady: checked.attachReady, webSocket: checked.ok && await websocket(origin, 0, signal) };
    },
  };
  const probes: TailscaleModeProbes = {
    loopback: async (port, signal) => {
      const origin = `http://127.0.0.1:${port}`;
      const checked = await health(origin, signal).catch(() => ({ ok: false, attachReady: false }));
      return { bounded: true, health: checked.ok, attachReady: checked.attachReady, webSocket: checked.ok && await websocket(origin, 0, signal) };
    },
    remote: async (origin, expectedDnsName, signal) => {
      const tls = await tlsProbe(expectedDnsName, signal).catch(() => ({ authorized: false, dnsNames: [], alpn: false as const }));
      const response = await fetch(`${origin}/health`, { redirect: "manual", signal }).catch(() => undefined);
      const openedAt = Date.now();
      const ws = response?.status === 200 && await websocket(origin, 1_000, signal);
      return {
        bounded: true, requestedHost: expectedDnsName, tlsVerification: "system", tlsAuthorized: tls.authorized,
        certificateDnsNames: tls.dnsNames, redirected: response !== undefined && response.status >= 300 && response.status < 400,
        healthStatus: response?.status ?? 0, alpn: tls.alpn, webSocketEcho: ws, webSocketOpenMs: ws ? Math.max(1_000, Date.now() - openedAt) : 0,
      };
    },
  };
  const advanced = new AdvancedModeAdapter(configPath);
  const tailscale = new TailscaleModeAdapter({
    gatewayPort: config.port, helper, io: tailscaleIo(io), probes,
    ownership: new SqliteTailscaleOwnershipStore(storage),
  });
  const adapters: NetworkModeAdapter[] = [
    new WindowsTailscaleAdapter({ delegate: tailscale, configPath, installRoot, helper, runtime }),
    new LanModeAdapter(lanRuntime),
    advanced,
  ];
  let activeExpiresAt: number | undefined;
  const onboarding = new NetworkOnboarding({
    adapters, state, authority,
    phoneVerification: {
      begin: async (mode, endpoint) => {
        const begun = await control.begin(mode, {
          canonicalOrigin: endpoint.canonicalOrigin,
          durableFingerprint: endpoint.durableFingerprint,
        });
        activeExpiresAt = begun.expiresAt;
        return begun;
      },
      waitForConfirmation: async (challenge, signal) => {
        for (;;) {
          if (signal?.aborted) {
            await control.cancel(challenge.challengeId).catch(() => undefined);
            return undefined;
          }
          const current = await control.status(challenge.challengeId, signal).catch(() => ({ state: "not_found" as const }));
          if (current.state === "confirmed") return current.phrase;
          if (current.state !== "pending" || Date.now() > current.expiresAt) return undefined;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      },
    },
    runtimeContext: () => authority.runtimeContext(),
    createSetupCode: newSetupCode,
    renderPairingOutput: preparePairingOutput,
    writePairingOutput: (output) => { process.stdout.write(output); },
    color: process.stdout.isTTY === true,
  });
  let legacyChecked = false;
  const ensureLegacyProjection = async (): Promise<void> => {
    if (legacyChecked) return;
    legacyChecked = true;
    if ((await authority.status()).state !== "none" || await state.read() !== undefined) return;
    const endpoint = await advanced.inspect().catch(() => undefined);
    if (endpoint === undefined) return;
    await state.write({
      version: 1,
      stage: "legacy_unreviewed",
      mode: "advanced",
      deploymentFingerprint: endpoint.durableFingerprint,
      updatedAt: Date.now(),
    });
  };
  return {
    status: async (signal) => {
      await ensureLegacyProjection();
      return { ...await onboarding.status(signal), ...(activeExpiresAt === undefined ? {} : { expiresAt: activeExpiresAt }) };
    },
    run: async (onboardingIo: OnboardingIo, signal) => {
      await ensureLegacyProjection();
      return onboarding.run(onboardingIo, signal);
    },
    resume: async (onboardingIo: OnboardingIo, signal) => {
      await ensureLegacyProjection();
      return onboarding.resume(onboardingIo, signal);
    },
    close: () => { storage.close(); },
  };
}

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect as tlsConnect } from "node:tls";

import { WebSocket } from "ws";

import { newSetupCode } from "./auth.ts";
import { loadConfig } from "./config.ts";
import {
  compareAndSwapManagedListener,
  compareAndSwapManagedListenerSnapshot,
  listenerOrigin,
  parseListenerPort,
  readManagedListenerSnapshot,
  SqliteOnboardingAuthority,
  validateListenerHost,
} from "./configure.ts";
import type { CliIo, CliOnboardingController, CliRuntime } from "./cli.ts";
import { LanModeAdapter, SqliteLanOwnershipStore, type LanListenerState, type LanModeRuntime } from "./lan-mode.ts";
import {
  NetworkOnboarding,
  type NetworkModeAdapter,
  type OnboardingIo,
  type PreparedEndpoint,
} from "./network-onboarding.ts";
import { NetworkOnboardingStateFile, type NetworkOnboardingStateProjection } from "./onboarding-state.ts";
import {
  OperatorOnboardingClient,
  OperatorOnboardingUnavailableError,
  loadOperatorControlToken,
  type OperatorBeginResult,
  type OperatorPhoneStatus,
} from "./operator-onboarding.ts";
import { preparePairingOutput } from "./pairing-output.ts";
import { gatewayPostureFingerprint } from "./phone-verification.ts";
import { openStorage, type Storage } from "./storage.ts";
import {
  SqliteTailscaleOwnershipStore,
  TailscaleModeAdapter,
  type TailscaleModeIo,
  type TailscaleModeProbes,
} from "./tailscale-mode.ts";
import type { TailscaleCliRunner } from "./tailscale-cli.ts";
import { gatewayScheme } from "./tls.ts";
import { WindowsHelperClient } from "./windows-helper.ts";

type WindowsOnboardingHelper = Pick<WindowsHelperClient,
  "protectPath" | "adapterInventory" | "inspectNetworkSafety" | "discoverTailscale" | "installTailscale" | "setPreference" | "openBrowser">;

interface OperatorClient {
  begin(
    mode: Parameters<OperatorOnboardingClient["begin"]>[0],
    context: Parameters<OperatorOnboardingClient["begin"]>[1],
    signal?: AbortSignal,
  ): OperatorBeginResult | Promise<OperatorBeginResult>;
  status(challengeId: string, signal?: AbortSignal): OperatorPhoneStatus | Promise<OperatorPhoneStatus>;
  cancel(challengeId: string, signal?: AbortSignal): { state: "cancelled" } | Promise<{ state: "cancelled" }>;
}

export interface WindowsOnboardingControllerDependencies {
  helper?: WindowsOnboardingHelper;
  storage?: Storage;
  control?: OperatorClient;
  state?: NetworkOnboardingStateProjection;
  tailscaleAdapter?: NetworkModeAdapter;
  tailscaleCliRunner?: TailscaleCliRunner;
  health?: typeof health;
  websocket?: typeof websocket;
  tlsProbe?: typeof tlsProbe;
  now?: () => number;
  delay?: typeof boundedDelay;
  createSetupCode?: () => string;
  renderPairingOutput?: typeof preparePairingOutput;
  writePairingOutput?: (output: string) => void | Promise<void>;
  beforeListenerCas?: () => void | Promise<void>;
}

function sameListener(left: LanListenerState, right: LanListenerState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function managedRevision(snapshot: ReturnType<typeof readManagedListenerSnapshot>): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

const SELECTED_LAN_ADAPTER_MAX_BYTES = 256;
const SELECTED_LAN_ADAPTER_FILE_MAX_BYTES = SELECTED_LAN_ADAPTER_MAX_BYTES + 2;
const SELECTED_LAN_ADAPTER_PATTERN = /^[\x20-\x7e]{1,256}$/;

function validSelectedLanAdapter(adapterId: string): boolean {
  return SELECTED_LAN_ADAPTER_PATTERN.test(adapterId)
    && Buffer.byteLength(adapterId, "utf8") <= SELECTED_LAN_ADAPTER_MAX_BYTES;
}

function isPhoneReachableHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "" || normalized === "localhost" || normalized === "0.0.0.0"
    || normalized === "::" || normalized === "::1") return false;
  return !/^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function hasPhoneReachableOrigin(bindHost: string, publicUrl?: string): boolean {
  if (publicUrl === undefined) return isPhoneReachableHost(bindHost);
  try { return isPhoneReachableHost(new URL(publicUrl).hostname); } catch { return false; }
}

function readSelectedLanAdapter(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).size > SELECTED_LAN_ADAPTER_FILE_MAX_BYTES)
    throw new Error("saved LAN adapter selection is invalid");
  const adapterId = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  if (!validSelectedLanAdapter(adapterId)) throw new Error("saved LAN adapter selection is invalid");
  return adapterId;
}

async function writeSelectedLanAdapter(
  path: string,
  adapterId: string,
  installRoot: string,
  helper: WindowsOnboardingHelper,
  signal?: AbortSignal,
): Promise<void> {
  if (!validSelectedLanAdapter(adapterId)) throw new Error("LAN adapter selection is invalid");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${adapterId}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await helper.protectPath(installRoot, temporary, signal);
    renameSync(temporary, path);
    await helper.protectPath(installRoot, path, signal);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function withDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (boundedSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const abort = () => deadline.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => deadline.abort(new Error("request timed out")), timeoutMs);
  try {
    return await operation(deadline.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function boundedDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("cancelled"));
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function health(origin: string, signal?: AbortSignal): Promise<{ ok: boolean; attachReady: boolean }> {
  return withDeadline(signal, 5_000, async (boundedSignal) => {
    const response = await fetch(`${origin}/health`, { redirect: "manual", signal: boundedSignal });
    if (response.status !== 200) return { ok: false, attachReady: false };
    const body = await response.json() as { attach?: { configured?: number; online?: number; deadLetters?: number } };
    const configured = body.attach?.configured ?? 0;
    return {
      ok: true,
      attachReady: configured > 0 && body.attach?.online === configured && body.attach?.deadLetters === 0,
    };
  });
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
    if (signal?.aborted) abort();
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
    if (signal?.aborted) abort();
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
    socket.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

class AdvancedModeAdapter implements NetworkModeAdapter {
  readonly mode = "advanced" as const;
  readonly #configPath: string;
  readonly #installRoot: string;
  readonly #helper: WindowsOnboardingHelper;
  readonly #io?: CliIo;
  readonly #runtime: CliRuntime;
  readonly #health: typeof health;
  readonly #websocket: typeof websocket;

  constructor(input: {
    configPath: string;
    installRoot: string;
    helper: WindowsOnboardingHelper;
    io?: CliIo;
    runtime: CliRuntime;
    health?: typeof health;
    websocket?: typeof websocket;
  }) {
    this.#configPath = input.configPath;
    this.#installRoot = input.installRoot;
    this.#helper = input.helper;
    this.#io = input.io;
    this.#runtime = input.runtime;
    this.#health = input.health ?? health;
    this.#websocket = input.websocket ?? websocket;
  }

  async prepare(signal?: AbortSignal): Promise<PreparedEndpoint> {
    if (this.#io === undefined)
      throw Object.assign(new Error("advanced listener input required"), {
        retryable: true as const, reason: "advanced_input_required",
      });
    const current = loadConfig(this.#configPath);
    const currentHost = current.host ?? "127.0.0.1";
    let host: string;
    for (;;) {
      const answer = await this.#io.question(`Bind address [${currentHost}]: `);
      try {
        host = validateListenerHost(answer.trim() === "" ? currentHost : answer);
        if (!hasPhoneReachableOrigin(host, current.publicUrl)) {
          console.log("Advanced setup requires a concrete hostname or IP address that the phone can reach; loopback and wildcard addresses cannot be used in a QR.");
          continue;
        }
        break;
      } catch {
        console.log("Enter a bind hostname or IP address without a URL or whitespace.");
      }
    }
    let port: number;
    for (;;) {
      const answer = await this.#io.question(`Port [${current.port}]: `);
      try {
        port = parseListenerPort(answer.trim() === "" ? String(current.port) : answer);
        break;
      } catch {
        console.log("Enter a whole port number from 1 through 65535.");
      }
    }
    if (host === currentHost && port === current.port) return this.inspect(signal);
    const before = readManagedListenerSnapshot(this.#configPath);
    if (!compareAndSwapManagedListener(this.#configPath, before, host, port))
      throw Object.assign(new Error("listener changed"), { retryable: true as const, reason: "listener_changed" });
    const after = readManagedListenerSnapshot(this.#configPath);
    try {
      await this.#helper.protectPath(this.#installRoot, this.#configPath, signal);
      const results = await Promise.allSettled(after.profiles.map((profile) =>
        this.#runtime.restartHermesProfile(profile.executable, profile.profile)));
      if (results.some((result) => result.status === "rejected")) throw new Error("Hermes restart failed");
      await this.#runtime.waitForGatewayReady(this.#configPath);
      return await this.inspect(signal);
    } catch (error) {
      if (compareAndSwapManagedListenerSnapshot(this.#configPath, after, before)) {
        await Promise.allSettled(before.profiles.map((profile) =>
          this.#runtime.restartHermesProfile(profile.executable, profile.profile)));
      }
      throw error;
    }
  }
  async inspect(signal?: AbortSignal): Promise<PreparedEndpoint> {
    const config = loadConfig(this.#configPath);
    const bindHost = config.host ?? "127.0.0.1";
    const local = listenerOrigin(bindHost, config.port, gatewayScheme(config));
    const canonicalOrigin = config.publicUrl ?? local;
    if (!hasPhoneReachableOrigin(bindHost, config.publicUrl)) {
      throw Object.assign(new Error("advanced phone-reachable origin required"), {
        retryable: true as const, reason: "phone_reachable_origin_required",
      });
    }
    const checked = await this.#health(canonicalOrigin, signal).catch(() => ({ ok: false, attachReady: false }));
    const ws = checked.ok ? await this.#websocket(canonicalOrigin, 0, signal) : false;
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
  readonly #delegate: NetworkModeAdapter;
  readonly #configPath: string;
  readonly #installRoot: string;
  readonly #helper: WindowsOnboardingHelper;
  readonly #runtime: CliRuntime;

  constructor(input: {
    delegate: NetworkModeAdapter;
    configPath: string;
    installRoot: string;
    helper: WindowsOnboardingHelper;
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
    const snapshot = readManagedListenerSnapshot(this.#configPath);
    if (!compareAndSwapManagedListener(
      this.#configPath, snapshot, "127.0.0.1", config.port, { clearPublicUrl: true },
    )) throw Object.assign(new Error("listener changed"), { retryable: true as const, reason: "listener_changed" });
    const profiles = readManagedListenerSnapshot(this.#configPath).profiles;
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

class WindowsLanSafetyAdapter implements NetworkModeAdapter {
  readonly mode = "lan" as const;
  readonly #delegate: NetworkModeAdapter;
  readonly #helper: WindowsOnboardingHelper;

  constructor(delegate: NetworkModeAdapter, helper: WindowsOnboardingHelper) {
    this.#delegate = delegate;
    this.#helper = helper;
  }

  async prepare(signal?: AbortSignal): Promise<PreparedEndpoint> {
    const endpoint = await this.#delegate.prepare(signal);
    if (endpoint.physicalAdapterId === undefined) return endpoint;
    try {
      const safety = await this.#helper.inspectNetworkSafety(endpoint.physicalAdapterId, signal);
      if (safety.networkCategory === "public") {
        console.log("Windows reports the selected adapter as a Public network. If this is your trusted home network, open Settings > Network & internet, open that connection, and set Network profile type to Private.");
      } else if (safety.networkCategory === "unknown") {
        console.log("Windows could not classify the selected connection. Confirm it is a trusted private network before continuing.");
      }
      if (!safety.firewallEnabled) {
        console.log("Windows Firewall is disabled for this network profile. Re-enable it in Windows Security before using LAN mode.");
      } else if (safety.defaultInboundAction === "block") {
        console.log("Windows Firewall blocks unsolicited inbound traffic by default. If the phone check fails, allow only CozyGateway's exact port on the Private profile; do not disable Windows Firewall or create a broad rule.");
      }
    } catch {
      console.log("Windows network profile/firewall inspection was unavailable. Review the active profile in Settings and Windows Security; use Private only for a trusted network and do not disable the firewall.");
    }
    return endpoint;
  }

  inspect(signal?: AbortSignal): Promise<PreparedEndpoint> {
    return this.#delegate.inspect(signal);
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
        ? "Allow Tailscale to run unattended in the background (sleep still disconnects it)? [y/N] "
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
  dependencies: WindowsOnboardingControllerDependencies = {},
): CliOnboardingController | undefined {
  const config = loadConfig(configPath);
  if (config.onboardingControlTokenFile === undefined) return undefined;
  const localRoot = dirname(configPath);
  const installRoot = dirname(localRoot);
  const helper = dependencies.helper ?? new WindowsHelperClient({ helperPath: join(installRoot, "bin", "cozygateway-windows-helper.ps1") });
  const storage = dependencies.storage ?? openStorage(config.dbPath);
  const authority = new SqliteOnboardingAuthority(storage);
  const control = dependencies.control ?? new OperatorOnboardingClient({
    localOrigin: listenerOrigin("127.0.0.1", config.port, gatewayScheme(config)),
    token: loadOperatorControlToken(config.onboardingControlTokenFile),
  });
  const state = dependencies.state ?? new NetworkOnboardingStateFile({
    localRoot,
    platform: "win32",
    protectWindowsAcl: (path) => helper.protectPath(installRoot, path),
  });
  const selectedLanAdapterPath = join(localRoot, "network-onboarding-lan-adapter");
  const listenerSnapshots = new Map<string, ReturnType<typeof readManagedListenerSnapshot>>();

  const readListener = (): LanListenerState => {
    const snapshot = readManagedListenerSnapshot(configPath);
    const revision = managedRevision(snapshot);
    listenerSnapshots.set(revision, snapshot);
    const current = JSON.parse(snapshot.configText) as { host?: string; port: number };
    return {
      bindHost: current.host ?? "127.0.0.1",
      port: current.port,
      hermesTargets: snapshot.profiles.map(({ profile, content }) => ({
        profile,
        url: /^COZYGATEWAY_URL=(.*)$/m.exec(content)?.[1] ?? "",
      })),
      persistenceRevision: revision,
    };
  };
  const lanRuntime: LanModeRuntime = {
    ownership: new SqliteLanOwnershipStore(storage),
    readAdapterInventory: (signal) => helper.adapterInventory(signal),
    readSelectedAdapter: async () => readSelectedLanAdapter(selectedLanAdapterPath),
    writeSelectedAdapter: (adapterId, signal) =>
      writeSelectedLanAdapter(selectedLanAdapterPath, adapterId, installRoot, helper, signal),
    chooseAdapter: async (candidates) => {
      if (io === undefined) return undefined;
      for (;;) {
        console.log("Choose the trusted physical adapter for Same Wi-Fi:");
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;
          const name = Array.from(candidate.displayName.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?"))
            .slice(0, 80).join("");
          console.log(`${index + 1}. ${name} (${candidate.kind}, ${candidate.address})`);
        }
        const answer = (await io.question(`Adapter [1-${candidates.length}]: `)).trim();
        if (answer.toLowerCase() === "q" || answer.toLowerCase() === "cancel") return undefined;
        if (/^\d+$/.test(answer)) {
          const selected = candidates[Number(answer) - 1];
          if (selected !== undefined) return selected.adapterId;
        }
        console.log(`Choose a number from 1 through ${candidates.length}.`);
      }
    },
    readListenerState: async () => readListener(),
    compareAndSwapListener: async (expected, replacement) => {
      await dependencies.beforeListenerCas?.();
      if (!sameListener(readListener(), expected)) return false;
      const snapshot = readManagedListenerSnapshot(configPath);
      if (managedRevision(snapshot) !== expected.persistenceRevision) return false;
      const exactReplacement = replacement.persistenceRevision === undefined
        ? undefined
        : listenerSnapshots.get(replacement.persistenceRevision);
      const applied = exactReplacement === undefined
        ? compareAndSwapManagedListener(
            configPath, snapshot, replacement.bindHost, replacement.port, { clearPublicUrl: true },
          )
        : compareAndSwapManagedListenerSnapshot(configPath, snapshot, exactReplacement);
      if (!applied) return false;
      replacement.persistenceRevision = managedRevision(readManagedListenerSnapshot(configPath));
      await helper.protectPath(installRoot, configPath);
      return true;
    },
    restartAndWait: async () => {
      const profiles = readManagedListenerSnapshot(configPath).profiles;
      const results = await Promise.allSettled(profiles.map((profile) =>
        runtime.restartHermesProfile(profile.executable, profile.profile)));
      if (results.some((result) => result.status === "rejected")) throw new Error("Hermes restart failed");
      await runtime.waitForGatewayReady(configPath);
    },
    probeEndpoint: async (origin, signal) => {
      const checked = await (dependencies.health ?? health)(origin, signal).catch(() => ({ ok: false, attachReady: false }));
      return {
        health: checked.ok,
        attachReady: checked.attachReady,
        webSocket: checked.ok && await (dependencies.websocket ?? websocket)(origin, 0, signal),
      };
    },
  };
  const probes: TailscaleModeProbes = {
    loopback: async (port, signal) => {
      const origin = `http://127.0.0.1:${port}`;
      const checked = await (dependencies.health ?? health)(origin, signal).catch(() => ({ ok: false, attachReady: false }));
      return {
        bounded: true,
        health: checked.ok,
        attachReady: checked.attachReady,
        webSocket: checked.ok && await (dependencies.websocket ?? websocket)(origin, 0, signal),
      };
    },
    remote: async (origin, expectedDnsName, signal) => {
      const tls = await (dependencies.tlsProbe ?? tlsProbe)(expectedDnsName, signal)
        .catch(() => ({ authorized: false, dnsNames: [], alpn: false as const }));
      const checked = await (dependencies.health ?? health)(origin, signal).catch(() => ({ ok: false, attachReady: false }));
      const openedAt = Date.now();
      const ws = checked.ok && await (dependencies.websocket ?? websocket)(origin, 1_000, signal);
      return {
        bounded: true, requestedHost: expectedDnsName, tlsVerification: "system", tlsAuthorized: tls.authorized,
        certificateDnsNames: tls.dnsNames, redirected: false,
        healthStatus: checked.ok ? 200 : 0, alpn: tls.alpn, webSocketEcho: ws,
        webSocketOpenMs: ws ? Math.max(1_000, Date.now() - openedAt) : 0,
      };
    },
  };
  const advanced = new AdvancedModeAdapter({
    configPath, installRoot, helper, io, runtime,
    ...(dependencies.health === undefined ? {} : { health: dependencies.health }),
    ...(dependencies.websocket === undefined ? {} : { websocket: dependencies.websocket }),
  });
  const tailscale = dependencies.tailscaleAdapter ?? new TailscaleModeAdapter({
    gatewayPort: config.port, helper, io: tailscaleIo(io), probes,
    ownership: new SqliteTailscaleOwnershipStore(storage),
    ...(dependencies.tailscaleCliRunner === undefined ? {} : { cliRunner: dependencies.tailscaleCliRunner }),
  });
  const adapters: NetworkModeAdapter[] = [
    new WindowsTailscaleAdapter({ delegate: tailscale, configPath, installRoot, helper, runtime }),
    new WindowsLanSafetyAdapter(new LanModeAdapter(lanRuntime), helper),
    advanced,
  ];
  const onboarding = new NetworkOnboarding({
    adapters, state, authority,
    phoneVerification: {
      begin: async (mode, endpoint) => {
        const begun = await control.begin(mode, {
          canonicalOrigin: endpoint.canonicalOrigin,
          durableFingerprint: endpoint.durableFingerprint,
        });
        return begun;
      },
      waitForConfirmation: async (challenge, signal) => {
        for (;;) {
          if (signal?.aborted) {
            await Promise.resolve(control.cancel(challenge.challengeId)).catch(() => undefined);
            return undefined;
          }
          const current = await control.status(challenge.challengeId, signal);
          if (current.state === "confirmed") return current.phrase;
          if (current.state === "gateway_restarted") throw new OperatorOnboardingUnavailableError();
          if (current.state !== "pending" || (dependencies.now ?? Date.now)() > current.expiresAt) return undefined;
          await (dependencies.delay ?? boundedDelay)(500, signal);
        }
      },
    },
    runtimeContext: () => authority.runtimeContext(),
    createSetupCode: dependencies.createSetupCode ?? newSetupCode,
    renderPairingOutput: dependencies.renderPairingOutput ?? preparePairingOutput,
    writePairingOutput: dependencies.writePairingOutput ?? ((output) => { process.stdout.write(output); }),
    color: process.stdout.isTTY === true,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
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
      const status = await onboarding.status(signal);
      const verification = storage.onboardingLiveVerification((dependencies.now ?? Date.now)());
      return { ...status, ...(verification === undefined ? {} : { expiresAt: verification.expiresAt }) };
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

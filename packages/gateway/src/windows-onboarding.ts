import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
  type ManagedListenerSnapshot,
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
import {
  openStorage,
  type OnboardingOwnershipInput,
  type OnboardingOwnershipWriteResult,
  type Storage,
} from "./storage.ts";
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
  afterAdvancedListenerCas?: () => void | Promise<void>;
}

function sameListener(left: LanListenerState, right: LanListenerState): boolean {
  return left.bindHost === right.bindHost
    && left.port === right.port
    && left.persistenceRevision === right.persistenceRevision
    && JSON.stringify(left.hermesTargets) === JSON.stringify(right.hermesTargets);
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
  const candidate = host.trim().replace(/^\[|\]$/g, "");
  if (candidate === "") return false;
  let normalized: string;
  try {
    const authority = isIP(candidate) === 6 ? `[${candidate}]` : candidate;
    normalized = new URL(`http://${authority}`).hostname
      .replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  } catch { return false; }
  if (normalized === "" || normalized === "localhost" || normalized === "0.0.0.0"
    || normalized === "::" || normalized === "::1") return false;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) return false;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (mapped !== null) {
    const ipv4 = (Number.parseInt(mapped[1]!, 16) * 0x10000) + Number.parseInt(mapped[2]!, 16);
    if (ipv4 === 0 || Math.floor(ipv4 / 0x1000000) === 127) return false;
  }
  return true;
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

interface AdvancedListenerOwnership {
  schemaVersion: 1;
  phase: "provisional" | "active" | "rollback-restart-required";
  ownershipSubtype: "advanced-listener-cas";
  before: LanListenerState;
  after: LanListenerState;
  endpointFingerprint?: string;
  createdAt: number;
}

const ADVANCED_OWNERSHIP_KEY = "advanced:listener";

class AdvancedModeRollbackError extends Error {
  readonly reason = "rollback_failed" as const;
  constructor() {
    super("Advanced listener rollback failed");
    this.name = "AdvancedModeRollbackError";
  }
}

function copyAdvancedState(state: LanListenerState): LanListenerState {
  return {
    bindHost: state.bindHost,
    port: state.port,
    hermesTargets: state.hermesTargets.map((target) => ({ ...target })),
    ...(state.persistenceRevision === undefined ? {} : { persistenceRevision: state.persistenceRevision }),
    ...(state.persistenceConfig === undefined ? {} : { persistenceConfig: state.persistenceConfig }),
  };
}

function sameAdvancedState(left: LanListenerState, right: LanListenerState): boolean {
  return left.bindHost === right.bindHost
    && left.port === right.port
    && JSON.stringify(left.hermesTargets) === JSON.stringify(right.hermesTargets);
}

function validAdvancedState(value: unknown): value is LanListenerState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.bindHost === "string"
    && Number.isSafeInteger(state.port) && (state.port as number) > 0 && (state.port as number) <= 65_535
    && (state.persistenceRevision === undefined || typeof state.persistenceRevision === "string")
    && (state.persistenceConfig === undefined || (
      typeof state.persistenceConfig === "string" && Buffer.byteLength(state.persistenceConfig, "utf8") <= 16 * 1024
    ))
    && Array.isArray(state.hermesTargets)
    && state.hermesTargets.every((target) => typeof target === "object" && target !== null && !Array.isArray(target)
      && typeof (target as Record<string, unknown>).profile === "string"
      && typeof (target as Record<string, unknown>).url === "string");
}

function validAdvancedOwnership(value: unknown): value is AdvancedListenerOwnership {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const owned = value as Record<string, unknown>;
  return owned.schemaVersion === 1
    && (owned.phase === "provisional" || owned.phase === "active" || owned.phase === "rollback-restart-required")
    && owned.ownershipSubtype === "advanced-listener-cas"
    && validAdvancedState(owned.before)
    && validAdvancedState(owned.after)
    && (owned.endpointFingerprint === undefined
      || (typeof owned.endpointFingerprint === "string" && /^[0-9a-f]{64}$/.test(owned.endpointFingerprint)))
    && Number.isSafeInteger(owned.createdAt) && (owned.createdAt as number) >= 0;
}

function advancedOwnershipJson(ownership: AdvancedListenerOwnership): string {
  return JSON.stringify({
    schemaVersion: ownership.schemaVersion,
    phase: ownership.phase,
    ownershipSubtype: ownership.ownershipSubtype,
    before: copyAdvancedState(ownership.before),
    after: copyAdvancedState(ownership.after),
    ...(ownership.endpointFingerprint === undefined ? {} : { endpointFingerprint: ownership.endpointFingerprint }),
    createdAt: ownership.createdAt,
  });
}

function advancedOwnershipInput(ownership: AdvancedListenerOwnership): OnboardingOwnershipInput {
  const ownedStateJson = advancedOwnershipJson(ownership);
  return {
    ownershipKey: ADVANCED_OWNERSHIP_KEY,
    mode: "advanced",
    durableFingerprint: createHash("sha256").update(ownedStateJson).digest("hex"),
    ownedStateJson,
    createdAt: ownership.createdAt,
  };
}

class SqliteAdvancedOwnershipStore {
  readonly #storage: Storage;
  constructor(storage: Storage) { this.#storage = storage; }

  async read(): Promise<AdvancedListenerOwnership | undefined> {
    const row = this.#storage.onboardingOwnership(ADVANCED_OWNERSHIP_KEY);
    if (row === undefined) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(row.ownedStateJson); } catch { throw new AdvancedModeRollbackError(); }
    if (row.mode !== "advanced" || !validAdvancedOwnership(parsed)) throw new AdvancedModeRollbackError();
    const input = advancedOwnershipInput(parsed);
    if (input.durableFingerprint !== row.durableFingerprint || input.ownedStateJson !== row.ownedStateJson)
      throw new AdvancedModeRollbackError();
    return parsed;
  }

  async write(ownership: AdvancedListenerOwnership): Promise<OnboardingOwnershipWriteResult> {
    if (!validAdvancedOwnership(ownership)) throw new AdvancedModeRollbackError();
    return this.#storage.recordOnboardingOwnership(advancedOwnershipInput(ownership));
  }

  async replace(expected: AdvancedListenerOwnership, replacement: AdvancedListenerOwnership): Promise<boolean> {
    if (!validAdvancedOwnership(expected) || !validAdvancedOwnership(replacement))
      throw new AdvancedModeRollbackError();
    return this.#storage.replaceOnboardingOwnership(
      advancedOwnershipInput(expected), advancedOwnershipInput(replacement),
    );
  }

  async remove(ownership: AdvancedListenerOwnership): Promise<boolean> {
    if (!validAdvancedOwnership(ownership)) throw new AdvancedModeRollbackError();
    return this.#storage.removeOnboardingOwnership(advancedOwnershipInput(ownership));
  }
}

function advancedPreparedState(before: LanListenerState, host: string, port: number, config: ReturnType<typeof loadConfig>): LanListenerState {
  return {
    bindHost: host,
    port,
    hermesTargets: before.hermesTargets.map((target) => {
      if (config.tls === undefined) return { profile: target.profile, url: listenerOrigin(host, port, "http") };
      const url = new URL(target.url);
      if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "")
        throw new Error(`Hermes profile ${target.profile} has no stable TLS origin`);
      url.port = String(port);
      return { profile: target.profile, url: url.origin };
    }),
  };
}

function advancedEndpointFingerprint(endpoint: Omit<PreparedEndpoint, "durableFingerprint">, subtype: string): string {
  return createHash("sha256").update(JSON.stringify({
    mode: endpoint.mode,
    canonicalOrigin: endpoint.canonicalOrigin,
    bindHost: endpoint.bindHost,
    port: endpoint.port,
    ownershipSubtype: subtype,
  })).digest("hex");
}

export class AdvancedModeAdapter implements NetworkModeAdapter {
  readonly mode = "advanced" as const;
  readonly #configPath: string;
  readonly #io?: CliIo;
  readonly #health: typeof health;
  readonly #websocket: typeof websocket;
  readonly #listener: LanModeRuntime;
  readonly #ownership: SqliteAdvancedOwnershipStore;
  readonly #afterListenerCas?: () => void | Promise<void>;
  #owned?: AdvancedListenerOwnership;

  constructor(input: {
    configPath: string;
    installRoot: string;
    helper: WindowsOnboardingHelper;
    io?: CliIo;
    runtime: CliRuntime;
    storage: Storage;
    health?: typeof health;
    websocket?: typeof websocket;
    afterListenerCas?: () => void | Promise<void>;
  }) {
    this.#configPath = input.configPath;
    this.#io = input.io;
    this.#health = input.health ?? health;
    this.#websocket = input.websocket ?? websocket;
    this.#ownership = new SqliteAdvancedOwnershipStore(input.storage);
    this.#listener = createWindowsLanRuntime(
      input.configPath, input.installRoot, input.io, input.runtime, input.helper, input.storage,
      {}, { clearPublicUrlOnForward: false, persistReplacementConfig: true },
    );
    this.#afterListenerCas = input.afterListenerCas;
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
    const before = await this.#listener.readListenerState(signal);
    const afterIntent = advancedPreparedState(before, host, port, current);
    const after = this.#listener.planListenerState === undefined
      ? afterIntent
      : await this.#listener.planListenerState(before, afterIntent, signal);
    let owned = await this.#ownership.read();
    let mutated = false;
    if (owned !== undefined) {
      if (owned.phase === "rollback-restart-required") {
        this.#owned = owned;
        await this.reconcileOwned(signal);
        return this.prepare(signal);
      }
      if (!sameAdvancedState(owned.after, after)) throw new AdvancedModeRollbackError();
      if (sameAdvancedState(before, owned.before)) {
        if (!await this.#listener.compareAndSwapListener(owned.before, owned.after, signal))
          throw Object.assign(new Error("listener changed"), { retryable: true as const, reason: "listener_changed" });
        await this.#afterListenerCas?.();
        owned = await this.#adoptExact(owned, "after", await this.#listener.readListenerState(signal));
        mutated = true;
      } else if (sameAdvancedState(before, owned.after)) {
        owned = await this.#adoptExact(owned, "after", before);
      } else throw new AdvancedModeRollbackError();
    } else if (!sameAdvancedState(before, after)) {
      owned = {
        schemaVersion: 1,
        phase: "provisional",
        ownershipSubtype: "advanced-listener-cas",
        before: copyAdvancedState(before),
        after: copyAdvancedState(after),
        createdAt: Date.now(),
      };
      if (await this.#ownership.write(owned) !== "written") throw new AdvancedModeRollbackError();
      this.#owned = owned;
      if (!await this.#listener.compareAndSwapListener(before, after, signal)) {
        await this.#removeOwnership(owned);
        throw Object.assign(new Error("listener changed"), { retryable: true as const, reason: "listener_changed" });
      }
      await this.#afterListenerCas?.();
      owned = await this.#adoptExact(owned, "after", await this.#listener.readListenerState(signal));
      mutated = true;
    }
    this.#owned = owned;
    if (owned !== undefined && (mutated || owned.phase === "provisional")) {
      try { await this.#listener.restartAndWait(owned.after, signal); }
      catch (error) { await this.reconcileOwned(signal); throw error; }
    }
    let endpoint: PreparedEndpoint;
    try {
      endpoint = await this.inspect(signal);
      if (!endpoint.ready) throw new Error("advanced endpoint is not ready");
    } catch (error) {
      await this.reconcileOwned(signal);
      throw error;
    }
    if (owned !== undefined && owned.phase === "provisional") {
      const active: AdvancedListenerOwnership = {
        ...owned, phase: "active", endpointFingerprint: endpoint.durableFingerprint,
      };
      if (!await this.#ownership.replace(owned, active)) {
        await this.reconcileOwned(signal);
        throw new AdvancedModeRollbackError();
      }
      this.#owned = active;
    }
    return endpoint;
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
    const endpoint = {
      mode: "advanced", canonicalOrigin, bindHost, port: config.port,
      ready: checked.ok && checked.attachReady && ws,
    } as const;
    const owned = await this.#ownership.read();
    return {
      ...endpoint,
      durableFingerprint: advancedEndpointFingerprint(
        endpoint,
        owned !== undefined && sameAdvancedState(await this.#listener.readListenerState(signal), owned.after)
          ? owned.ownershipSubtype
          : "preexisting-listener",
      ),
    };
  }
  async rollbackOwned(endpoint: PreparedEndpoint, signal?: AbortSignal): Promise<void> {
    const owned = this.#owned ?? await this.#ownership.read();
    if (owned?.endpointFingerprint !== endpoint.durableFingerprint) return;
    await this.reconcileOwned(signal);
  }

  /** SQLite-authoritative crash/uninstall recovery for Advanced listener/public-origin state. */
  async reconcileOwned(signal?: AbortSignal): Promise<void> {
    let owned = this.#owned ?? await this.#ownership.read();
    if (owned === undefined) return;
    if (owned.phase !== "rollback-restart-required") {
      const pending: AdvancedListenerOwnership = { ...owned, phase: "rollback-restart-required" };
      if (!await this.#ownership.replace(owned, pending)) throw new AdvancedModeRollbackError();
      owned = pending;
      this.#owned = pending;
    }
    const current = await this.#listener.readListenerState(signal);
    if (sameAdvancedState(current, owned.before)) {
      owned = await this.#adoptExact(owned, "before", current);
    } else {
      if (!sameAdvancedState(current, owned.after)) throw new AdvancedModeRollbackError();
      owned = await this.#adoptExact(owned, "after", current);
      if (!await this.#listener.compareAndSwapListener(owned.after, owned.before, signal))
        throw new AdvancedModeRollbackError();
      owned = await this.#adoptExact(owned, "before", await this.#listener.readListenerState(signal));
    }
    try { await this.#listener.restartAndWait(owned.before, signal); }
    catch { throw new AdvancedModeRollbackError(); }
    await this.#removeOwnership(owned);
    this.#owned = undefined;
  }

  async #adoptExact(
    owned: AdvancedListenerOwnership,
    side: "before" | "after",
    observed: LanListenerState,
  ): Promise<AdvancedListenerOwnership> {
    if (!sameAdvancedState(owned[side], observed)) throw new AdvancedModeRollbackError();
    const expectedRevision = owned[side].persistenceRevision;
    if (expectedRevision !== undefined && observed.persistenceRevision !== expectedRevision)
      throw new AdvancedModeRollbackError();
    const exact = copyAdvancedState(observed);
    if (side === "before" && owned.before.persistenceConfig !== undefined)
      exact.persistenceConfig = owned.before.persistenceConfig;
    if (JSON.stringify(owned[side]) === JSON.stringify(exact)) return owned;
    const replacement = { ...owned, [side]: exact };
    if (!await this.#ownership.replace(owned, replacement)) throw new AdvancedModeRollbackError();
    this.#owned = replacement;
    return replacement;
  }

  async #removeOwnership(owned: AdvancedListenerOwnership): Promise<void> {
    if (await this.#ownership.remove(owned)) return;
    if (await this.#ownership.read() !== undefined) throw new AdvancedModeRollbackError();
  }
}

export class WindowsTailscaleAdapter implements NetworkModeAdapter {
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

  reconcileOwned(signal?: AbortSignal): Promise<void> {
    return this.#delegate.reconcileOwned(signal);
  }
}

export class WindowsLanSafetyAdapter implements NetworkModeAdapter {
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
        console.log("Windows Firewall is disabled for this network profile. Open Windows Security > Firewall & network protection, select the active profile, and turn Microsoft Defender Firewall on before using LAN mode.");
      } else if (safety.defaultInboundAction === "block") {
        console.log(`Windows Firewall blocks unsolicited inbound traffic by default. If the phone check fails, open Windows Security > Firewall & network protection > Advanced settings > Inbound Rules and allow only TCP port ${endpoint.port} on the Private profile; do not disable Windows Firewall or create a broad rule.`);
      }
    } catch {
      console.log(`Windows network profile/firewall inspection was unavailable. Review Settings > Network & internet and Windows Security > Firewall & network protection; use Private only for a trusted network and, if needed, allow only TCP port ${endpoint.port}.`);
    }
    return endpoint;
  }

  inspect(signal?: AbortSignal): Promise<PreparedEndpoint> {
    return this.#delegate.inspect(signal);
  }

  rollbackOwned(endpoint: PreparedEndpoint, signal?: AbortSignal): Promise<void> {
    return this.#delegate.rollbackOwned(endpoint, signal);
  }

  reconcileOwned(signal?: AbortSignal): Promise<void> {
    return this.#delegate.reconcileOwned(signal);
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

function ownedListenerSnapshot(
  state: LanListenerState,
  current: ManagedListenerSnapshot,
): ManagedListenerSnapshot | undefined {
  if (state.persistenceConfig === undefined) return undefined;
  const targets = new Map(state.hermesTargets.map((target) => [target.profile, target.url]));
  if (targets.size !== state.hermesTargets.length || current.profiles.length !== targets.size)
    throw new Error("durable listener snapshot shape changed");
  const snapshot: ManagedListenerSnapshot = {
    configText: state.persistenceConfig,
    ...(current.installStateText === undefined ? {} : { installStateText: current.installStateText }),
    profiles: current.profiles.map((profile) => {
      const target = targets.get(profile.profile);
      if (target === undefined || !/^COZYGATEWAY_URL=.*$/m.test(profile.content))
        throw new Error("durable listener snapshot shape changed");
      return { ...profile, content: profile.content.replace(/^COZYGATEWAY_URL=.*$/m, `COZYGATEWAY_URL=${target}`) };
    }),
  };
  if (state.persistenceRevision === undefined || managedRevision(snapshot) !== state.persistenceRevision)
    throw new Error("durable listener snapshot revision mismatch");
  return snapshot;
}

function plannedListenerSnapshot(
  current: ManagedListenerSnapshot,
  replacement: LanListenerState,
  clearPublicUrl: boolean,
): ManagedListenerSnapshot {
  const parsed: unknown = JSON.parse(current.configText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("gateway configuration must be a JSON object");
  const config = { ...parsed, host: replacement.bindHost, port: replacement.port } as Record<string, unknown>;
  if (clearPublicUrl) delete config.publicUrl;
  const targets = new Map(replacement.hermesTargets.map((target) => [target.profile, target.url]));
  if (targets.size !== replacement.hermesTargets.length || current.profiles.length !== targets.size)
    throw new Error("planned listener snapshot shape changed");
  return {
    configText: `${JSON.stringify(config, null, 2)}\n`,
    ...(current.installStateText === undefined ? {} : { installStateText: current.installStateText }),
    profiles: current.profiles.map((profile) => {
      const target = targets.get(profile.profile);
      if (target === undefined || !/^COZYGATEWAY_URL=.*$/m.test(profile.content))
        throw new Error("planned listener snapshot shape changed");
      return { ...profile, content: profile.content.replace(/^COZYGATEWAY_URL=.*$/m, `COZYGATEWAY_URL=${target}`) };
    }),
  };
}

function createWindowsLanRuntime(
  configPath: string,
  installRoot: string,
  io: CliIo | undefined,
  runtime: CliRuntime,
  helper: WindowsOnboardingHelper,
  storage: Storage,
  dependencies: Pick<WindowsOnboardingControllerDependencies,
    "beforeListenerCas" | "health" | "websocket"> = {},
  options: { clearPublicUrlOnForward?: boolean; persistReplacementConfig?: boolean } = {
    clearPublicUrlOnForward: true,
  },
): LanModeRuntime {
  const localRoot = dirname(configPath);
  const selectedLanAdapterPath = join(localRoot, "network-onboarding-lan-adapter");
  const listenerSnapshots = new Map<string, ManagedListenerSnapshot>();
  const readListener = (): LanListenerState => {
    const snapshot = readManagedListenerSnapshot(configPath);
    if (Buffer.byteLength(snapshot.configText, "utf8") > 16 * 1024)
      throw new Error("managed listener config exceeded its durable bound");
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
      persistenceConfig: snapshot.configText,
    };
  };
  return {
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
    planListenerState: async (expected, replacement) => {
      const snapshot = readManagedListenerSnapshot(configPath);
      if (managedRevision(snapshot) !== expected.persistenceRevision)
        throw new Error("listener changed while planning persistence");
      const planned = plannedListenerSnapshot(
        snapshot, replacement, options.clearPublicUrlOnForward !== false,
      );
      const revision = managedRevision(planned);
      listenerSnapshots.set(revision, planned);
      return {
        ...copyAdvancedState(replacement),
        persistenceRevision: revision,
        ...(options.persistReplacementConfig === true ? { persistenceConfig: planned.configText } : {}),
      };
    },
    compareAndSwapListener: async (expected, replacement) => {
      await dependencies.beforeListenerCas?.();
      if (!sameListener(readListener(), expected)) return false;
      const snapshot = readManagedListenerSnapshot(configPath);
      if (managedRevision(snapshot) !== expected.persistenceRevision) return false;
      const exactReplacement = ownedListenerSnapshot(replacement, snapshot)
        ?? (replacement.persistenceRevision === undefined
          ? undefined
          : listenerSnapshots.get(replacement.persistenceRevision));
      const applied = exactReplacement === undefined
        ? compareAndSwapManagedListener(
            configPath, snapshot, replacement.bindHost, replacement.port,
            { clearPublicUrl: options.clearPublicUrlOnForward !== false },
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
      const checked = await (dependencies.health ?? health)(origin, signal)
        .catch(() => ({ ok: false, attachReady: false }));
      return {
        health: checked.ok,
        attachReady: checked.attachReady,
        webSocket: checked.ok && await (dependencies.websocket ?? websocket)(origin, 0, signal),
      };
    },
  };
}

/** Bounded pre-uninstall reconciliation. This operation deliberately has no dependency on the
 * operator token or onboarding projection and never deletes SQLite. */
export async function reconcileWindowsOwnedNetworkState(
  configPath: string,
  runtime: CliRuntime,
  signal?: AbortSignal,
): Promise<void> {
  const config = loadConfig(configPath);
  const localRoot = dirname(configPath);
  const installRoot = dirname(localRoot);
  const helper = new WindowsHelperClient({
    helperPath: join(installRoot, "bin", "cozygateway-windows-helper.ps1"),
  });
  const dbPath = isAbsolute(config.dbPath) ? config.dbPath : resolve(localRoot, config.dbPath);
  const storage = openStorage(dbPath);
  try {
    await withDeadline(signal, 120_000, async (boundedSignal) => {
      const unavailableProbe = async (): Promise<never> => {
        throw new Error("cleanup does not perform readiness probes");
      };
      const tailscale = new TailscaleModeAdapter({
        gatewayPort: config.port,
        helper,
        io: tailscaleIo(undefined),
        probes: { loopback: unavailableProbe, remote: unavailableProbe },
        ownership: new SqliteTailscaleOwnershipStore(storage),
      });
      const lan = new LanModeAdapter(
        createWindowsLanRuntime(configPath, installRoot, undefined, runtime, helper, storage),
      );
      const advanced = new AdvancedModeAdapter({
        configPath, installRoot, helper, runtime, storage,
      });
      const failures: unknown[] = [];
      try { await tailscale.reconcileOwned(boundedSignal); } catch (error) { failures.push(error); }
      try { await lan.reconcileOwned(boundedSignal); } catch (error) { failures.push(error); }
      try { await advanced.reconcileOwned(boundedSignal); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "network ownership cleanup failed");
    });
  } finally {
    storage.close();
  }
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
  const lanRuntime = createWindowsLanRuntime(configPath, installRoot, io, runtime, helper, storage, dependencies);
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
    configPath, installRoot, helper, io, runtime, storage,
    ...(dependencies.health === undefined ? {} : { health: dependencies.health }),
    ...(dependencies.websocket === undefined ? {} : { websocket: dependencies.websocket }),
    ...(dependencies.afterAdvancedListenerCas === undefined
      ? {} : { afterListenerCas: dependencies.afterAdvancedListenerCas }),
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

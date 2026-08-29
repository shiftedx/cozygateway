import { createHash } from "node:crypto";

import {
  TailscaleCli,
  type TailscaleCliRunner,
  type TailscaleStatus,
} from "./tailscale-cli.ts";
import type { NetworkModeAdapter, PreparedEndpoint } from "./network-onboarding.ts";
import type {
  OnboardingOwnershipInput,
  OnboardingOwnershipWriteResult,
} from "./storage.ts";
import type { TailscaleDiscovery } from "./windows-helper.ts";

export type TailscaleModePauseReason =
  | "not_installed"
  | "install_cancelled"
  | "unsupported_install"
  | "unsupported_version"
  | "login_pending"
  | "machine_auth_required"
  | "not_running"
  | "account_not_confirmed"
  | "unattended_consent_required"
  | "incoming_consent_required"
  | "managed_policy"
  | "https_consent_required"
  | "no_safe_consent_port"
  | "mapping_conflict";

export class TailscaleModePause extends Error {
  readonly retryable = true;
  readonly reason: TailscaleModePauseReason;

  constructor(reason: TailscaleModePauseReason) {
    super(`Personal Tailscale onboarding paused: ${reason}`);
    this.name = "TailscaleModePause";
    this.reason = reason;
  }
}

export type TailscaleModeReadinessReason =
  | "status"
  | "loopback"
  | "mapping"
  | "tls"
  | "certificate"
  | "redirect"
  | "health"
  | "alpn"
  | "websocket"
  | "ownership";

export class TailscaleModeReadinessError extends Error {
  readonly reason: TailscaleModeReadinessReason;

  constructor(reason: TailscaleModeReadinessReason) {
    super(`Personal Tailscale endpoint failed ${reason} verification`);
    this.name = "TailscaleModeReadinessError";
    this.reason = reason;
  }
}

export interface TailscaleModeHelper {
  discoverTailscale(signal?: AbortSignal): Promise<TailscaleDiscovery>;
  installTailscale(signal?: AbortSignal): Promise<void>;
  setPreference(preference: "unattended" | "shields-up", enabled: boolean, signal?: AbortSignal): Promise<void>;
  openBrowser(purpose: "login" | "https-consent", url: string, signal?: AbortSignal): Promise<void>;
}

export interface TailscaleModeIo {
  offerInstall(signal?: AbortSignal): Promise<boolean>;
  confirmCurrentAccount(
    account: { accountLabel: string; tailnetName: string },
    signal?: AbortSignal,
  ): Promise<boolean>;
  confirmPreference(
    preference: "unattended" | "shields-up",
    desired: boolean,
    signal?: AbortSignal,
  ): Promise<boolean>;
  confirmCertificateTransparency(signal?: AbortSignal): Promise<boolean>;
  chooseHttpsConsentPort?(occupiedPorts: readonly number[], signal?: AbortSignal): Promise<number | undefined>;
}

export interface TailscaleLoopbackProbe {
  bounded: boolean;
  health: boolean;
  attachReady: boolean;
  webSocket: boolean;
}

export interface TailscaleRemoteProbe {
  bounded: boolean;
  requestedHost: string;
  tlsVerification: "system";
  tlsAuthorized: boolean;
  certificateDnsNames: string[];
  redirected: boolean;
  healthStatus: number;
  alpn: string | false;
  webSocketEcho: boolean;
  webSocketOpenMs: number;
}

export interface TailscaleModeProbes {
  loopback(port: number, signal?: AbortSignal): Promise<TailscaleLoopbackProbe>;
  remote(origin: string, expectedDnsName: string, signal?: AbortSignal): Promise<TailscaleRemoteProbe>;
}

export interface TailscaleMappingOwnership {
  schemaVersion: 1;
  mappingFingerprint: string;
  accountTailnetHash: string;
  dnsName: string;
  target: string;
  createdAt: number;
}

export interface TailscaleOwnershipStore {
  read(signal?: AbortSignal): Promise<TailscaleMappingOwnership | undefined>;
  write(ownership: TailscaleMappingOwnership, signal?: AbortSignal): Promise<"written" | "existing" | "conflict">;
  remove(ownership: TailscaleMappingOwnership, signal?: AbortSignal): Promise<boolean>;
}

export interface OnboardingOwnershipAuthority {
  onboardingOwnership(ownershipKey: string): OnboardingOwnershipInput | undefined;
  recordOnboardingOwnership(input: OnboardingOwnershipInput): OnboardingOwnershipWriteResult;
  removeOnboardingOwnership(input: OnboardingOwnershipInput): boolean;
}

const TAILSCALE_OWNERSHIP_KEY = "tailscale:443";

function ownershipJson(value: TailscaleMappingOwnership): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    mappingFingerprint: value.mappingFingerprint,
    accountTailnetHash: value.accountTailnetHash,
    dnsName: value.dnsName,
    target: value.target,
    createdAt: value.createdAt,
  });
}

function validOwnership(value: unknown): value is TailscaleMappingOwnership {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "accountTailnetHash,createdAt,dnsName,mappingFingerprint,schemaVersion,target") return false;
  return value.schemaVersion === 1
    && typeof value.mappingFingerprint === "string" && /^[0-9a-f]{64}$/.test(value.mappingFingerprint)
    && typeof value.accountTailnetHash === "string" && /^[0-9a-f]{64}$/.test(value.accountTailnetHash)
    && typeof value.dnsName === "string" && /^[a-z0-9.-]+\.ts\.net$/.test(value.dnsName)
    && typeof value.target === "string" && /^127\.0\.0\.1:(?:[1-9]\d{0,4})$/.test(value.target)
    && Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0;
}

/** Concrete bridge to the existing STRICT `onboarding_ownership` SQLite table. */
export class SqliteTailscaleOwnershipStore implements TailscaleOwnershipStore {
  readonly #authority: OnboardingOwnershipAuthority;

  constructor(authority: OnboardingOwnershipAuthority) {
    this.#authority = authority;
  }

  async read(_signal?: AbortSignal): Promise<TailscaleMappingOwnership | undefined> {
    const row = this.#authority.onboardingOwnership(TAILSCALE_OWNERSHIP_KEY);
    if (row === undefined) return undefined;
    if (row.mode !== "tailscale" || row.durableFingerprint.length !== 64)
      throw new TailscaleModeReadinessError("ownership");
    let parsed: unknown;
    try { parsed = JSON.parse(row.ownedStateJson); } catch { throw new TailscaleModeReadinessError("ownership"); }
    if (!validOwnership(parsed) || parsed.mappingFingerprint !== row.durableFingerprint)
      throw new TailscaleModeReadinessError("ownership");
    return parsed;
  }

  async write(ownership: TailscaleMappingOwnership, _signal?: AbortSignal): Promise<"written" | "existing" | "conflict"> {
    if (!validOwnership(ownership)) throw new TailscaleModeReadinessError("ownership");
    return this.#authority.recordOnboardingOwnership({
      ownershipKey: TAILSCALE_OWNERSHIP_KEY,
      mode: "tailscale",
      durableFingerprint: ownership.mappingFingerprint,
      ownedStateJson: ownershipJson(ownership),
      createdAt: ownership.createdAt,
    });
  }

  async remove(ownership: TailscaleMappingOwnership, _signal?: AbortSignal): Promise<boolean> {
    if (!validOwnership(ownership)) throw new TailscaleModeReadinessError("ownership");
    return this.#authority.removeOnboardingOwnership({
      ownershipKey: TAILSCALE_OWNERSHIP_KEY,
      mode: "tailscale",
      durableFingerprint: ownership.mappingFingerprint,
      ownedStateJson: ownershipJson(ownership),
      createdAt: ownership.createdAt,
    });
  }
}

export type TailscaleFailureBoundary =
  | "install"
  | "login"
  | "login_browser"
  | "unattended_write"
  | "shields_up_write"
  | "https_consent"
  | "https_consent_browser"
  | "loopback_probe"
  | "mapping_create"
  | "mapping_reinspect"
  | "remote_probe"
  | "ownership_write"
  | "mapping_remove"
  | "ownership_remove";

export interface TailscaleModeDependencies {
  gatewayPort: number;
  helper: TailscaleModeHelper;
  io: TailscaleModeIo;
  probes: TailscaleModeProbes;
  ownership: TailscaleOwnershipStore;
  cliRunner?: TailscaleCliRunner;
  cliTimeoutMs?: number;
  loginPollAttempts?: number;
  loginPollDelayMs?: number;
  now?: () => number;
  injectFailure?: (boundary: TailscaleFailureBoundary) => void | Promise<void>;
}

export interface TailscalePreparedEndpoint extends PreparedEndpoint {
  mode: "tailscale";
  accountTailnetHash: string;
  serveMappingFingerprint: string;
  createdByWizard: boolean;
}

export type TailscaleMappingInspection =
  | { outcome: "empty"; occupiedPorts: number[] }
  | { outcome: "compatible"; occupiedPorts: number[]; mappingFingerprint: string }
  | { outcome: "conflict"; occupiedPorts: number[] };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portFromKey(key: string): number | undefined {
  const match = /(?:^|:)(\d{1,5})$/.exec(key);
  if (match === null) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function collectPorts(value: unknown, ports: Set<number>, path: readonly string[] = []): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPorts(item, ports, path);
    return;
  }
  if (!record(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const port = portFromKey(key);
    if (port !== undefined) ports.add(port);
    collectPorts(child, ports, [...path, key]);
  }
}

function hasPort443OutsideExactMapping(value: unknown, path: readonly string[] = []): boolean {
  if (Array.isArray(value)) return value.some((item) => hasPort443OutsideExactMapping(item, path));
  if (!record(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (portFromKey(key) === 443 && !(childPath.length === 2 && childPath[0] === "TCP" && childPath[1] === "443"))
      return true;
    if (childPath.length === 2 && childPath[0] === "TCP" && childPath[1] === "443") continue;
    if (hasPort443OutsideExactMapping(child, childPath)) return true;
  }
  return false;
}

function funnel443(value: Record<string, unknown>): boolean {
  return hasPort443OutsideExactMapping(value.AllowFunnel)
    || hasPort443OutsideExactMapping(value.Funnel)
    || (record(value.AllowFunnel) && Object.keys(value.AllowFunnel).some((key) => portFromKey(key) === 443));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactMapping(
  serve: Record<string, unknown>,
  dnsName: string,
  target: string,
): Record<string, unknown> | undefined {
  if (!record(serve.TCP) || !record(serve.TCP["443"])) return undefined;
  const handler = serve.TCP["443"];
  const keys = Object.keys(handler).sort();
  if (keys.length !== 2 || keys[0] !== "TCPForward" || keys[1] !== "TerminateTLS") return undefined;
  return handler.TCPForward === target && handler.TerminateTLS === dnsName ? handler : undefined;
}

export function inspectTailscaleMappings(
  serve: Record<string, unknown>,
  funnel: Record<string, unknown>,
  dnsName: string,
  gatewayPort: number,
): TailscaleMappingInspection {
  const target = `127.0.0.1:${gatewayPort}`;
  const ports = new Set<number>();
  collectPorts(serve, ports);
  collectPorts(funnel.AllowFunnel, ports);
  const occupiedPorts = [...ports].sort((left, right) => left - right);
  if (funnel443(funnel) || funnel443(serve) || hasPort443OutsideExactMapping(serve))
    return { outcome: "conflict", occupiedPorts };
  const mapping = exactMapping(serve, dnsName, target);
  if (mapping !== undefined) {
    return {
      outcome: "compatible",
      occupiedPorts,
      mappingFingerprint: sha256({ mode: "tls-terminated-tcp", port: 443, proxy: false, target, dnsName, funnel: false }),
    };
  }
  if (record(serve.TCP) && serve.TCP["443"] !== undefined)
    return { outcome: "conflict", occupiedPorts };
  return { outcome: "empty", occupiedPorts };
}

function accountHash(status: Extract<TailscaleStatus, { state: "running" }>): string {
  return sha256({
    accountId: status.accountId,
    accountLabel: status.accountLabel,
    tailnetName: status.tailnetName,
    magicDnsSuffix: status.magicDnsSuffix,
  });
}

function mappingFingerprint(dnsName: string, gatewayPort: number): string {
  return sha256({
    mode: "tls-terminated-tcp",
    port: 443,
    proxy: false,
    target: `127.0.0.1:${gatewayPort}`,
    dnsName,
    funnel: false,
  });
}

function endpoint(
  status: Extract<TailscaleStatus, { state: "running" }>,
  gatewayPort: number,
  createdByWizard: boolean,
): TailscalePreparedEndpoint {
  const accountTailnetHash = accountHash(status);
  const serveMappingFingerprint = mappingFingerprint(status.dnsName, gatewayPort);
  const durableFingerprint = sha256({
    mode: "tailscale",
    origin: `https://${status.dnsName}`,
    bindHost: "127.0.0.1",
    gatewayPort,
    accountTailnetHash,
    serveMappingFingerprint,
  });
  return {
    mode: "tailscale",
    canonicalOrigin: `https://${status.dnsName}`,
    bindHost: "127.0.0.1",
    port: gatewayPort,
    durableFingerprint,
    ready: true,
    accountTailnetHash,
    serveMappingFingerprint,
    createdByWizard,
  };
}

function verifyLoopback(probe: TailscaleLoopbackProbe): void {
  if (!probe.bounded || !probe.health || !probe.attachReady || !probe.webSocket)
    throw new TailscaleModeReadinessError("loopback");
}

function verifyRemote(probe: TailscaleRemoteProbe, dnsName: string): void {
  if (!probe.bounded) throw new TailscaleModeReadinessError("health");
  if (probe.requestedHost !== dnsName || probe.tlsVerification !== "system" || !probe.tlsAuthorized)
    throw new TailscaleModeReadinessError("tls");
  if (!probe.certificateDnsNames.includes(dnsName)) throw new TailscaleModeReadinessError("certificate");
  if (probe.redirected) throw new TailscaleModeReadinessError("redirect");
  if (probe.healthStatus !== 200) throw new TailscaleModeReadinessError("health");
  if (probe.alpn !== false && probe.alpn !== "" && probe.alpn !== "http/1.1")
    throw new TailscaleModeReadinessError("alpn");
  if (!probe.webSocketEcho || probe.webSocketOpenMs < 1_000)
    throw new TailscaleModeReadinessError("websocket");
}

/** Personal-account adapter. All host mutation stays behind the fixed Windows helper or the
 * exact public Tailscale CLI methods above; probes and SQLite ownership are explicit boundaries. */
export class TailscaleModeAdapter implements NetworkModeAdapter {
  readonly mode = "tailscale" as const;
  readonly #dependencies: TailscaleModeDependencies;
  readonly #now: () => number;
  #owned?: TailscaleMappingOwnership;

  constructor(dependencies: TailscaleModeDependencies) {
    if (!Number.isSafeInteger(dependencies.gatewayPort) || dependencies.gatewayPort < 1 || dependencies.gatewayPort > 65_535)
      throw new Error("invalid loopback Gateway port");
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? Date.now;
  }

  async prepare(signal?: AbortSignal): Promise<TailscalePreparedEndpoint> {
    const cli = await this.#cli(signal, true);
    try {
      await cli.requireSupportedVersion(signal);
    } catch (error) {
      if (error instanceof Error && "reason" in error && error.reason === "unsupported_version")
        throw new TailscaleModePause("unsupported_version");
      throw error;
    }
    let status = await cli.status(signal);
    if (status.state === "needs_login") {
      const login = await cli.beginLogin(signal);
      await this.#inject("login");
      if (login.outcome === "machine_auth_required") throw new TailscaleModePause("machine_auth_required");
      if (login.outcome === "auth_required") {
        await this.#dependencies.helper.openBrowser("login", login.authUrl, signal);
        await this.#inject("login_browser");
      }
      const attempts = this.#dependencies.loginPollAttempts ?? 30;
      const delayMs = this.#dependencies.loginPollDelayMs ?? 1_000;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0 && delayMs > 0) await this.#delay(delayMs, signal);
        status = await cli.status(signal);
        if (status.state === "running" || status.state === "needs_machine_auth") break;
      }
    }
    if (status.state !== "running") throw new TailscaleModePause(
      status.state === "needs_machine_auth" ? "machine_auth_required"
        : status.state === "needs_login" ? "login_pending" : "not_running",
    );
    const confirmed = await this.#dependencies.io.confirmCurrentAccount({
      accountLabel: status.accountLabel,
      tailnetName: status.tailnetName,
    }, signal);
    if (!confirmed) throw new TailscaleModePause("account_not_confirmed");
    if (!status.certificateReady) {
      if (!await this.#dependencies.io.confirmCertificateTransparency(signal))
        throw new TailscaleModePause("https_consent_required");
      const [beforeServe, beforeFunnel] = await Promise.all([cli.serveState(signal), cli.funnelState(signal)]);
      const before = inspectTailscaleMappings(beforeServe, beforeFunnel, status.dnsName, this.#dependencies.gatewayPort);
      const port = await this.#dependencies.io.chooseHttpsConsentPort?.(before.occupiedPorts, signal);
      if (port === undefined || !Number.isSafeInteger(port) || port < 1_024 || port > 65_535
        || port === 443 || before.occupiedPorts.includes(port))
        throw new TailscaleModePause("no_safe_consent_port");
      const consentUrl = await cli.beginHttpsConsent(port, signal);
      await this.#inject("https_consent");
      await this.#dependencies.helper.openBrowser("https-consent", consentUrl, signal);
      await this.#inject("https_consent_browser");
      const attempts = this.#dependencies.loginPollAttempts ?? 30;
      const delayMs = this.#dependencies.loginPollDelayMs ?? 1_000;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0 && delayMs > 0) await this.#delay(delayMs, signal);
        const current = await cli.status(signal);
        if (current.state === "needs_machine_auth") throw new TailscaleModePause("machine_auth_required");
        if (current.state === "running" && current.certificateReady) {
          if (accountHash(current) !== accountHash(status)) throw new TailscaleModeReadinessError("status");
          status = current;
          break;
        }
      }
      if (!status.certificateReady) throw new TailscaleModePause("https_consent_required");
      const [afterServe, afterFunnel] = await Promise.all([cli.serveState(signal), cli.funnelState(signal)]);
      const after = inspectTailscaleMappings(afterServe, afterFunnel, status.dnsName, this.#dependencies.gatewayPort);
      if (after.occupiedPorts.includes(port)) throw new TailscaleModePause("mapping_conflict");
    }
    if (!await cli.preference("unattended", signal)) {
      if (!await this.#dependencies.io.confirmPreference("unattended", true, signal))
        throw new TailscaleModePause("unattended_consent_required");
      try {
        await this.#dependencies.helper.setPreference("unattended", true, signal);
      } catch {
        throw new TailscaleModePause("managed_policy");
      }
      await this.#inject("unattended_write");
      if (!await cli.preference("unattended", signal)) throw new TailscaleModePause("managed_policy");
    }
    if (await cli.preference("shields-up", signal)) {
      if (!await this.#dependencies.io.confirmPreference("shields-up", false, signal))
        throw new TailscaleModePause("incoming_consent_required");
      try {
        await this.#dependencies.helper.setPreference("shields-up", false, signal);
      } catch {
        throw new TailscaleModePause("managed_policy");
      }
      await this.#inject("shields_up_write");
      if (await cli.preference("shields-up", signal)) throw new TailscaleModePause("managed_policy");
    }
    const localProbe = await this.#dependencies.probes.loopback(this.#dependencies.gatewayPort, signal);
    await this.#inject("loopback_probe");
    verifyLoopback(localProbe);
    const [serve, funnel] = await Promise.all([cli.serveState(signal), cli.funnelState(signal)]);
    const mapping = inspectTailscaleMappings(serve, funnel, status.dnsName, this.#dependencies.gatewayPort);
    if (mapping.outcome === "conflict") throw new TailscaleModePause("mapping_conflict");
    const expectedFingerprint = mappingFingerprint(status.dnsName, this.#dependencies.gatewayPort);
    const priorOwnership = await this.#dependencies.ownership.read(signal);
    let created: TailscaleMappingOwnership | undefined;
    let ownershipWritten = false;
    if (mapping.outcome === "empty") {
      await cli.createTlsTerminatedMapping(this.#dependencies.gatewayPort, signal);
      created = {
        schemaVersion: 1,
        mappingFingerprint: expectedFingerprint,
        accountTailnetHash: accountHash(status),
        dnsName: status.dnsName,
        target: `127.0.0.1:${this.#dependencies.gatewayPort}`,
        createdAt: this.#now(),
      };
      this.#owned = created;
      try {
        await this.#inject("mapping_create");
      } catch (error) {
        await this.#rollbackExact(cli, created, false, signal);
        throw error;
      }
    }
    try {
      const [finalStatus, finalServe, finalFunnel] = await Promise.all([
        cli.status(signal), cli.serveState(signal), cli.funnelState(signal),
      ]);
      if (finalStatus.state !== "running" || accountHash(finalStatus) !== accountHash(status))
        throw new TailscaleModeReadinessError("status");
      const finalMapping = inspectTailscaleMappings(finalServe, finalFunnel, status.dnsName, this.#dependencies.gatewayPort);
      await this.#inject("mapping_reinspect");
      if (finalMapping.outcome !== "compatible" || finalMapping.mappingFingerprint !== expectedFingerprint)
        throw new TailscaleModeReadinessError("mapping");
      const remoteProbe = await this.#dependencies.probes.remote(`https://${status.dnsName}`, status.dnsName, signal);
      await this.#inject("remote_probe");
      verifyRemote(remoteProbe, status.dnsName);
      if (created !== undefined) {
        const written = await this.#dependencies.ownership.write(created, signal);
        if (written === "conflict") throw new TailscaleModeReadinessError("ownership");
        ownershipWritten = true;
        await this.#inject("ownership_write");
      }
      const durableOwned = created !== undefined || (priorOwnership !== undefined
        && priorOwnership.mappingFingerprint === expectedFingerprint
        && priorOwnership.accountTailnetHash === accountHash(status)
        && priorOwnership.dnsName === status.dnsName
        && priorOwnership.target === `127.0.0.1:${this.#dependencies.gatewayPort}`);
      if (durableOwned && created === undefined) this.#owned = priorOwnership;
      return endpoint(status, this.#dependencies.gatewayPort, durableOwned);
    } catch (error) {
      if (created !== undefined) await this.#rollbackExact(cli, created, ownershipWritten, signal);
      throw error;
    }
  }

  async inspect(signal?: AbortSignal): Promise<TailscalePreparedEndpoint> {
    const cli = await this.#cli(signal, false);
    await cli.requireSupportedVersion(signal);
    const status = await cli.status(signal);
    if (status.state !== "running" || !status.certificateReady
      || !await cli.preference("unattended", signal)
      || await cli.preference("shields-up", signal))
      throw new TailscaleModeReadinessError("status");
    const localProbe = await this.#dependencies.probes.loopback(this.#dependencies.gatewayPort, signal);
    verifyLoopback(localProbe);
    const [serve, funnel] = await Promise.all([cli.serveState(signal), cli.funnelState(signal)]);
    const mapping = inspectTailscaleMappings(serve, funnel, status.dnsName, this.#dependencies.gatewayPort);
    if (mapping.outcome !== "compatible") throw new TailscaleModeReadinessError("mapping");
    const remoteProbe = await this.#dependencies.probes.remote(`https://${status.dnsName}`, status.dnsName, signal);
    verifyRemote(remoteProbe, status.dnsName);
    const owned = await this.#dependencies.ownership.read(signal);
    const durableOwned = owned !== undefined && owned.mappingFingerprint === mapping.mappingFingerprint
      && owned.accountTailnetHash === accountHash(status);
    if (durableOwned) this.#owned = owned;
    return endpoint(status, this.#dependencies.gatewayPort, durableOwned);
  }

  async rollbackOwned(endpoint: PreparedEndpoint, signal?: AbortSignal): Promise<void> {
    const owned = this.#owned ?? await this.#dependencies.ownership.read(signal);
    if (owned === undefined) return;
    if (
      endpoint.mode !== "tailscale"
      || endpoint.bindHost !== "127.0.0.1"
      || endpoint.port !== this.#dependencies.gatewayPort
      || endpoint.accountTailnetHash !== owned.accountTailnetHash
      || endpoint.serveMappingFingerprint !== owned.mappingFingerprint
      || endpoint.canonicalOrigin !== `https://${owned.dnsName}`
    ) return;
    const cli = await this.#cli(signal, false);
    const status = await cli.status(signal);
    if (status.state !== "running" || accountHash(status) !== owned.accountTailnetHash) return;
    const [serve, funnel] = await Promise.all([cli.serveState(signal), cli.funnelState(signal)]);
    const mapping = inspectTailscaleMappings(serve, funnel, owned.dnsName, this.#dependencies.gatewayPort);
    if (mapping.outcome !== "compatible" || mapping.mappingFingerprint !== owned.mappingFingerprint) return;
    await cli.removeTlsTerminatedMapping(signal);
    await this.#inject("mapping_remove");
    const [afterServe, afterFunnel] = await Promise.all([cli.serveState(signal), cli.funnelState(signal)]);
    if (inspectTailscaleMappings(afterServe, afterFunnel, owned.dnsName, this.#dependencies.gatewayPort).outcome !== "empty")
      throw new TailscaleModeReadinessError("mapping");
    if (!await this.#dependencies.ownership.remove(owned, signal))
      throw new TailscaleModeReadinessError("ownership");
    await this.#inject("ownership_remove");
    this.#owned = undefined;
  }

  async #cli(signal: AbortSignal | undefined, allowInstall: boolean): Promise<TailscaleCli> {
    let discovery = await this.#dependencies.helper.discoverTailscale(signal);
    if (discovery.state !== "ready" && discovery.reason === "tailscale_not_installed") {
      if (!allowInstall) throw new TailscaleModePause("not_installed");
      if (!await this.#dependencies.io.offerInstall(signal)) throw new TailscaleModePause("not_installed");
      try {
        await this.#dependencies.helper.installTailscale(signal);
      } catch (error) {
        const reason = error instanceof Error && "reason" in error ? error.reason : undefined;
        throw new TailscaleModePause(reason === "installer_cancelled" ? "install_cancelled" : "unsupported_install");
      }
      await this.#inject("install");
      discovery = await this.#dependencies.helper.discoverTailscale(signal);
    }
    if (discovery.state !== "ready") throw new TailscaleModePause(
      discovery.reason === "tailscale_not_installed" ? "not_installed" : "unsupported_install",
    );
    return new TailscaleCli({
      executable: discovery.cliPath,
      runner: this.#dependencies.cliRunner,
      timeoutMs: this.#dependencies.cliTimeoutMs,
    });
  }

  async #inject(boundary: TailscaleFailureBoundary): Promise<void> {
    await this.#dependencies.injectFailure?.(boundary);
  }

  async #delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? new Error("cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  async #rollbackExact(
    cli: TailscaleCli,
    owned: TailscaleMappingOwnership,
    ownershipWritten: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const status = await cli.status(signal);
    if (status.state !== "running" || accountHash(status) !== owned.accountTailnetHash) return;
    const [serve, funnel] = await Promise.all([cli.serveState(signal), cli.funnelState(signal)]);
    const mapping = inspectTailscaleMappings(serve, funnel, owned.dnsName, this.#dependencies.gatewayPort);
    if (mapping.outcome !== "compatible" || mapping.mappingFingerprint !== owned.mappingFingerprint) return;
    await cli.removeTlsTerminatedMapping(signal);
    const [afterServe, afterFunnel] = await Promise.all([cli.serveState(signal), cli.funnelState(signal)]);
    if (inspectTailscaleMappings(afterServe, afterFunnel, owned.dnsName, this.#dependencies.gatewayPort).outcome !== "empty")
      return;
    if (ownershipWritten) await this.#dependencies.ownership.remove(owned, signal);
    this.#owned = undefined;
  }
}

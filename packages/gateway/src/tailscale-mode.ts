import { createHash, createHmac } from "node:crypto";

import {
  TailscaleCli,
  TailscaleCliError,
  type TailscaleCliErrorReason,
  type TailscaleCliRunner,
  type TailscaleStatus,
} from "./tailscale-cli.ts";
import type { NetworkModeAdapter, PreparedEndpoint } from "./network-onboarding.ts";
import type {
  OnboardingOwnershipInput,
  OnboardingOwnershipWriteResult,
} from "./storage.ts";
import type { TailscaleDiscovery, WindowsHelperReason } from "./windows-helper.ts";

export type TailscaleModePauseReason =
  | "not_installed"
  | "install_cancelled"
  | "install_reboot_required"
  | "install_verification_failed"
  | "install_failed"
  | "unsupported_install"
  | "unsupported_version"
  | "custom_control_server"
  | "status_unavailable"
  | "login_failed"
  | "login_browser_failed"
  | "login_pending"
  | "machine_auth_required"
  | "not_running"
  | "account_not_confirmed"
  | "unattended_consent_required"
  | "incoming_consent_required"
  | "preference_cancelled"
  | "preference_verification_failed"
  | "preference_rollback_failed"
  | "managed_policy"
  | "https_consent_failed"
  | "https_consent_browser_failed"
  | "https_consent_required"
  | "no_safe_consent_port"
  | "mapping_inspection_failed"
  | "mapping_mutation_failed"
  | "mapping_conflict";

export type TailscaleModePauseDetail = WindowsHelperReason | TailscaleCliErrorReason;

export class TailscaleModePause extends Error {
  readonly retryable = true;
  readonly reason: TailscaleModePauseReason;
  readonly detail?: TailscaleModePauseDetail;

  constructor(reason: TailscaleModePauseReason, detail?: TailscaleModePauseDetail) {
    super(`Personal Tailscale onboarding paused: ${reason}`);
    this.name = "TailscaleModePause";
    this.reason = reason;
    this.detail = detail;
  }
}

function typedReason(error: unknown): TailscaleModePauseDetail | undefined {
  if (!(error instanceof Error) || !("reason" in error) || typeof error.reason !== "string") return undefined;
  return error.reason as TailscaleModePauseDetail;
}

function cliPause(reason: TailscaleModePauseReason, error: unknown): TailscaleModePause {
  return new TailscaleModePause(reason, error instanceof TailscaleCliError ? error.reason : undefined);
}

function preferencePause(error: unknown): TailscaleModePause {
  const detail = typedReason(error);
  if (detail === "preference_cancelled") return new TailscaleModePause("preference_cancelled", detail);
  if (detail === "preference_verification_failed")
    return new TailscaleModePause("preference_verification_failed", detail);
  if (detail === "preference_failed") return new TailscaleModePause("managed_policy", detail);
  return new TailscaleModePause("managed_policy", detail);
}

export type TailscaleModeReadinessReason =
  | "status"
  | "account_changed"
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

export type TailscaleOwnershipSubtype = "wizard-created" | "reused";

export interface TailscalePreferenceRestoration {
  name: "unattended" | "shields-up";
  before: boolean;
  after: boolean;
}

export interface TailscaleMappingOwnership {
  schemaVersion: 2;
  phase: "preferences" | "provisional" | "active";
  ownershipSubtype: TailscaleOwnershipSubtype;
  mappingFingerprint: string;
  mappingStateFingerprint: string;
  accountTailnetHash: string;
  dnsName: string;
  target: string;
  preferenceRestorations: TailscalePreferenceRestoration[];
  createdAt: number;
}

export interface TailscaleOwnershipStore {
  identityHmacKey(signal?: AbortSignal): Promise<Uint8Array>;
  read(signal?: AbortSignal): Promise<TailscaleMappingOwnership | undefined>;
  write(ownership: TailscaleMappingOwnership, signal?: AbortSignal): Promise<"written" | "existing" | "conflict">;
  replace(
    expected: TailscaleMappingOwnership,
    replacement: TailscaleMappingOwnership,
    signal?: AbortSignal,
  ): Promise<boolean>;
  remove(ownership: TailscaleMappingOwnership, signal?: AbortSignal): Promise<boolean>;
}

export interface OnboardingOwnershipAuthority {
  onboardingIdentityHmacKey(): Uint8Array;
  onboardingOwnership(ownershipKey: string): OnboardingOwnershipInput | undefined;
  recordOnboardingOwnership(input: OnboardingOwnershipInput): OnboardingOwnershipWriteResult;
  replaceOnboardingOwnership(expected: OnboardingOwnershipInput, replacement: OnboardingOwnershipInput): boolean;
  removeOnboardingOwnership(input: OnboardingOwnershipInput): boolean;
}

const TAILSCALE_OWNERSHIP_KEY = "tailscale:443";

function ownershipJson(value: TailscaleMappingOwnership): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    phase: value.phase,
    ownershipSubtype: value.ownershipSubtype,
    mappingFingerprint: value.mappingFingerprint,
    mappingStateFingerprint: value.mappingStateFingerprint,
    accountTailnetHash: value.accountTailnetHash,
    dnsName: value.dnsName,
    target: value.target,
    preferenceRestorations: value.preferenceRestorations,
    createdAt: value.createdAt,
  });
}

function validOwnership(value: unknown): value is TailscaleMappingOwnership {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "accountTailnetHash,createdAt,dnsName,mappingFingerprint,mappingStateFingerprint,ownershipSubtype,phase,preferenceRestorations,schemaVersion,target") return false;
  return value.schemaVersion === 2
    && (value.phase === "preferences" || value.phase === "provisional" || value.phase === "active")
    && (value.ownershipSubtype === "wizard-created" || value.ownershipSubtype === "reused")
    && typeof value.mappingFingerprint === "string" && /^[0-9a-f]{64}$/.test(value.mappingFingerprint)
    && typeof value.mappingStateFingerprint === "string" && /^[0-9a-f]{64}$/.test(value.mappingStateFingerprint)
    && typeof value.accountTailnetHash === "string" && /^[0-9a-f]{64}$/.test(value.accountTailnetHash)
    && typeof value.dnsName === "string" && /^[a-z0-9.-]+\.ts\.net$/.test(value.dnsName)
    && typeof value.target === "string" && /^127\.0\.0\.1:(?:[1-9]\d{0,4})$/.test(value.target)
    && Array.isArray(value.preferenceRestorations)
    && value.preferenceRestorations.length <= 2
    && value.preferenceRestorations.every((item) => record(item)
      && Object.keys(item).sort().join(",") === "after,before,name"
      && (item.name === "unattended" || item.name === "shields-up")
      && typeof item.before === "boolean" && typeof item.after === "boolean" && item.before !== item.after)
    && Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0;
}

/** Concrete bridge to the existing STRICT `onboarding_ownership` SQLite table. */
export class SqliteTailscaleOwnershipStore implements TailscaleOwnershipStore {
  readonly #authority: OnboardingOwnershipAuthority;

  constructor(authority: OnboardingOwnershipAuthority) {
    this.#authority = authority;
  }

  async identityHmacKey(_signal?: AbortSignal): Promise<Uint8Array> {
    return this.#authority.onboardingIdentityHmacKey();
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

  async replace(
    expected: TailscaleMappingOwnership,
    replacement: TailscaleMappingOwnership,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    if (!validOwnership(expected) || !validOwnership(replacement))
      throw new TailscaleModeReadinessError("ownership");
    return this.#authority.replaceOnboardingOwnership(
      this.#input(expected),
      this.#input(replacement),
    );
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

  #input(ownership: TailscaleMappingOwnership): OnboardingOwnershipInput {
    return {
      ownershipKey: TAILSCALE_OWNERSHIP_KEY,
      mode: "tailscale",
      durableFingerprint: ownership.mappingFingerprint,
      ownedStateJson: ownershipJson(ownership),
      createdAt: ownership.createdAt,
    };
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
  collectPorts(funnel, ports);
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

function accountHash(status: Extract<TailscaleStatus, { state: "running" }>, key: Uint8Array): string {
  return createHmac("sha256", key).update(JSON.stringify({
    accountId: status.accountId,
    accountLabel: status.accountLabel,
    tailnetName: status.tailnetName,
    magicDnsSuffix: status.magicDnsSuffix,
  })).digest("hex");
}

function mappingStateFingerprint(dnsName: string, gatewayPort: number): string {
  return sha256({
    mode: "tls-terminated-tcp",
    port: 443,
    proxy: false,
    target: `127.0.0.1:${gatewayPort}`,
    dnsName,
    funnel: false,
  });
}

function mappingFingerprint(
  dnsName: string,
  gatewayPort: number,
  ownershipSubtype: TailscaleOwnershipSubtype,
): string {
  return sha256({
    mode: "tls-terminated-tcp",
    port: 443,
    proxy: false,
    target: `127.0.0.1:${gatewayPort}`,
    dnsName,
    funnel: false,
    ownershipSubtype,
  });
}

function endpoint(
  status: Extract<TailscaleStatus, { state: "running" }>,
  gatewayPort: number,
  createdByWizard: boolean,
  identityKey: Uint8Array,
): TailscalePreparedEndpoint {
  const accountTailnetHash = accountHash(status, identityKey);
  const ownershipSubtype: TailscaleOwnershipSubtype = createdByWizard ? "wizard-created" : "reused";
  const serveMappingFingerprint = mappingFingerprint(status.dnsName, gatewayPort, ownershipSubtype);
  const durableFingerprint = sha256({
    mode: "tailscale",
    origin: `https://${status.dnsName}`,
    bindHost: "127.0.0.1",
    gatewayPort,
    accountTailnetHash,
    serveMappingFingerprint,
    ownershipSubtype,
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
  #identityKey?: Uint8Array;

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
      if (error instanceof TailscaleCliError && error.reason === "unsupported_version")
        throw new TailscaleModePause("unsupported_version", error.reason);
      throw cliPause("status_unavailable", error);
    }
    try {
      await cli.requireOfficialControlServer(signal);
    } catch (error) {
      if (error instanceof TailscaleCliError && error.reason === "custom_control_server")
        throw new TailscaleModePause("custom_control_server", error.reason);
      throw cliPause("status_unavailable", error);
    }
    const identityKey = await this.#loadIdentityKey(signal);
    let status: TailscaleStatus;
    try {
      status = await cli.status(signal);
    } catch (error) {
      throw cliPause("status_unavailable", error);
    }
    if (status.state === "needs_login") {
      let login;
      try {
        login = await cli.beginLogin(signal);
      } catch (error) {
        throw cliPause("login_failed", error);
      }
      await this.#inject("login");
      if (login.outcome === "machine_auth_required") throw new TailscaleModePause("machine_auth_required");
      if (login.outcome === "auth_required") {
        try {
          await this.#dependencies.helper.openBrowser("login", login.authUrl, signal);
        } catch (error) {
          throw new TailscaleModePause("login_browser_failed", typedReason(error));
        }
        await this.#inject("login_browser");
      }
      const attempts = this.#dependencies.loginPollAttempts ?? 30;
      const delayMs = this.#dependencies.loginPollDelayMs ?? 1_000;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0 && delayMs > 0) await this.#delay(delayMs, signal);
        try {
          status = await cli.status(signal);
        } catch (error) {
          throw cliPause("status_unavailable", error);
        }
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
    let preflight = await this.#mappingInspection(cli, status.dnsName, signal);
    if (preflight.outcome === "conflict") throw new TailscaleModePause("mapping_conflict");
    if (!status.certificateReady) {
      if (!await this.#dependencies.io.confirmCertificateTransparency(signal))
        throw new TailscaleModePause("https_consent_required");
      const port = await this.#dependencies.io.chooseHttpsConsentPort?.(preflight.occupiedPorts, signal);
      if (port === undefined || !Number.isSafeInteger(port) || port < 1_024 || port > 65_535
        || port === 443 || preflight.occupiedPorts.includes(port))
        throw new TailscaleModePause("no_safe_consent_port");
      let consentUrl: string;
      try {
        consentUrl = await cli.beginHttpsConsent(port, signal);
      } catch (error) {
        throw cliPause("https_consent_failed", error);
      }
      await this.#inject("https_consent");
      try {
        await this.#dependencies.helper.openBrowser("https-consent", consentUrl, signal);
      } catch (error) {
        throw new TailscaleModePause("https_consent_browser_failed", typedReason(error));
      }
      await this.#inject("https_consent_browser");
      const attempts = this.#dependencies.loginPollAttempts ?? 30;
      const delayMs = this.#dependencies.loginPollDelayMs ?? 1_000;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0 && delayMs > 0) await this.#delay(delayMs, signal);
        let current: TailscaleStatus;
        try {
          current = await cli.status(signal);
        } catch (error) {
          throw cliPause("status_unavailable", error);
        }
        if (current.state === "needs_machine_auth") throw new TailscaleModePause("machine_auth_required");
        if (current.state === "running" && current.certificateReady) {
          if (accountHash(current, identityKey) !== accountHash(status, identityKey))
            throw new TailscaleModeReadinessError("status");
          status = current;
          break;
        }
      }
      if (!status.certificateReady) throw new TailscaleModePause("https_consent_required");
      preflight = await this.#mappingInspection(cli, status.dnsName, signal);
      if (preflight.outcome === "conflict" || preflight.occupiedPorts.includes(port))
        throw new TailscaleModePause("mapping_conflict");
    }
    const expectedStateFingerprint = mappingStateFingerprint(status.dnsName, this.#dependencies.gatewayPort);
    const target = `127.0.0.1:${this.#dependencies.gatewayPort}`;
    let owned = await this.#dependencies.ownership.read(signal);
    const priorWasActive = owned?.phase === "active";
    if (owned !== undefined && (
      owned.mappingStateFingerprint !== expectedStateFingerprint
      || owned.mappingFingerprint !== mappingFingerprint(
        status.dnsName,
        this.#dependencies.gatewayPort,
        owned.ownershipSubtype,
      )
      || owned.accountTailnetHash !== accountHash(status, identityKey)
      || owned.dnsName !== status.dnsName
      || owned.target !== target
    )) throw new TailscaleModeReadinessError("ownership");
    if (owned === undefined) {
      const ownershipSubtype: TailscaleOwnershipSubtype = preflight.outcome === "empty" ? "wizard-created" : "reused";
      owned = {
        schemaVersion: 2,
        phase: "preferences",
        ownershipSubtype,
        mappingFingerprint: mappingFingerprint(status.dnsName, this.#dependencies.gatewayPort, ownershipSubtype),
        mappingStateFingerprint: expectedStateFingerprint,
        accountTailnetHash: accountHash(status, identityKey),
        dnsName: status.dnsName,
        target,
        preferenceRestorations: [],
        createdAt: this.#now(),
      };
      const written = await this.#dependencies.ownership.write(owned, signal);
      if (written === "conflict") throw new TailscaleModeReadinessError("ownership");
      try {
        await this.#inject("ownership_write");
      } catch (error) {
        await this.#withRecoverySignal((recoverySignal) =>
          this.#removeOwnershipIdempotently(owned!, recoverySignal));
        throw error;
      }
    }
    this.#owned = owned;
    const preferenceMutations: TailscalePreferenceRestoration[] = [];
    try {
    if (!await this.#preference(cli, "unattended", signal)) {
      if (!await this.#dependencies.io.confirmPreference("unattended", true, signal))
        throw new TailscaleModePause("unattended_consent_required");
      const mutation: TailscalePreferenceRestoration = { name: "unattended", before: false, after: true };
      preferenceMutations.push(mutation);
      owned = await this.#journalPreference(owned, mutation, signal);
      try {
        await this.#dependencies.helper.setPreference("unattended", true, signal);
      } catch (error) {
        throw preferencePause(error);
      }
      await this.#inject("unattended_write");
      if (!await this.#preference(cli, "unattended", signal))
        throw new TailscaleModePause("preference_verification_failed", "preference_verification_failed");
    }
    if (await this.#preference(cli, "shields-up", signal)) {
      if (!await this.#dependencies.io.confirmPreference("shields-up", false, signal))
        throw new TailscaleModePause("incoming_consent_required");
      const mutation: TailscalePreferenceRestoration = { name: "shields-up", before: true, after: false };
      preferenceMutations.push(mutation);
      owned = await this.#journalPreference(owned, mutation, signal);
      try {
        await this.#dependencies.helper.setPreference("shields-up", false, signal);
      } catch (error) {
        throw preferencePause(error);
      }
      await this.#inject("shields_up_write");
      if (await this.#preference(cli, "shields-up", signal))
        throw new TailscaleModePause("preference_verification_failed", "preference_verification_failed");
    }
    const localProbe = await this.#dependencies.probes.loopback(this.#dependencies.gatewayPort, signal);
    await this.#inject("loopback_probe");
    verifyLoopback(localProbe);
    const mapping = await this.#mappingInspection(cli, status.dnsName, signal);
    if (mapping.outcome === "conflict") throw new TailscaleModePause("mapping_conflict");
    if (owned.phase === "preferences") {
      if ((owned.ownershipSubtype === "wizard-created" && mapping.outcome !== "empty")
        || (owned.ownershipSubtype === "reused" && mapping.outcome !== "compatible"))
        throw new TailscaleModePause("mapping_conflict");
      const provisional: TailscaleMappingOwnership = { ...owned, phase: "provisional" };
      if (!await this.#dependencies.ownership.replace(owned, provisional, signal))
        throw new TailscaleModeReadinessError("ownership");
      owned = provisional;
      this.#owned = provisional;
    }
    if (mapping.outcome === "empty") {
      if (owned.ownershipSubtype !== "wizard-created" || owned.phase === "active")
        throw new TailscaleModeReadinessError("mapping");
      try {
        await cli.createTlsTerminatedMapping(this.#dependencies.gatewayPort, signal);
      } catch (error) {
        const reconciled = await this.#recoveryMappingInspection(cli, status.dnsName);
        if (reconciled.outcome !== "compatible" || reconciled.mappingFingerprint !== expectedStateFingerprint)
          throw cliPause("mapping_mutation_failed", error);
      }
      await this.#inject("mapping_create");
    } else if (owned.ownershipSubtype === "wizard-created" && owned.phase === "active") {
      // A durable active record proves that this exact compatible mapping was created by this
      // installation. This is the normal resume path after a completed setup.
    } else if (owned.ownershipSubtype === "wizard-created" && owned.phase === "provisional") {
      // Process loss after Serve mutation: the pre-existing provisional row is the authority that
      // distinguishes our exact mapping from a coincidentally compatible user mapping.
    } else if (owned.ownershipSubtype !== "reused") {
      throw new TailscaleModeReadinessError("ownership");
    }
    try {
      let finalStatus: TailscaleStatus;
      try {
        finalStatus = await cli.status(signal);
      } catch (error) {
        throw cliPause("status_unavailable", error);
      }
      if (finalStatus.state !== "running" || accountHash(finalStatus, identityKey) !== accountHash(status, identityKey))
        throw new TailscaleModeReadinessError("status");
      const finalMapping = await this.#mappingInspection(cli, status.dnsName, signal);
      await this.#inject("mapping_reinspect");
      if (finalMapping.outcome !== "compatible" || finalMapping.mappingFingerprint !== expectedStateFingerprint)
        throw new TailscaleModeReadinessError("mapping");
      const remoteProbe = await this.#dependencies.probes.remote(`https://${status.dnsName}`, status.dnsName, signal);
      await this.#inject("remote_probe");
      verifyRemote(remoteProbe, status.dnsName);
      if (owned.phase === "provisional") {
        const active: TailscaleMappingOwnership = { ...owned, phase: "active" };
        if (!await this.#dependencies.ownership.replace(owned, active, signal))
          throw new TailscaleModeReadinessError("ownership");
        owned = active;
        this.#owned = active;
      }
      return endpoint(
        status,
        this.#dependencies.gatewayPort,
        owned.ownershipSubtype === "wizard-created",
        identityKey,
      );
    } catch (error) {
      throw error;
    }
    } catch (error) {
      let rollbackError: unknown;
      if (!priorWasActive) {
        try {
          await this.#rollbackExact(cli, owned, signal);
        } catch (caught) {
          rollbackError = caught;
        }
      }
      if (rollbackError instanceof TailscaleModeReadinessError
        && rollbackError.reason === "account_changed") throw rollbackError;
      try {
        await this.#rollbackPreferences(cli, owned, preferenceMutations, signal);
      } catch (caught) {
        if (caught instanceof TailscaleModeReadinessError
          && caught.reason === "account_changed") throw caught;
        throw new TailscaleModePause("preference_rollback_failed");
      }
      if (rollbackError !== undefined) throw rollbackError;
      throw error;
    }
  }

  async inspect(signal?: AbortSignal): Promise<TailscalePreparedEndpoint> {
    const cli = await this.#cli(signal, false);
    await cli.requireSupportedVersion(signal);
    await cli.requireOfficialControlServer(signal);
    const identityKey = await this.#loadIdentityKey(signal);
    const status = await cli.status(signal);
    if (status.state !== "running" || !status.certificateReady
      || !await cli.preference("unattended", signal)
      || await cli.preference("shields-up", signal))
      throw new TailscaleModeReadinessError("status");
    const localProbe = await this.#dependencies.probes.loopback(this.#dependencies.gatewayPort, signal);
    verifyLoopback(localProbe);
    const [serve, funnel] = await this.#mappingStates(cli, signal);
    const mapping = inspectTailscaleMappings(serve, funnel, status.dnsName, this.#dependencies.gatewayPort);
    if (mapping.outcome !== "compatible") throw new TailscaleModeReadinessError("mapping");
    const remoteProbe = await this.#dependencies.probes.remote(`https://${status.dnsName}`, status.dnsName, signal);
    verifyRemote(remoteProbe, status.dnsName);
    const owned = await this.#dependencies.ownership.read(signal);
    const durableOwned = owned !== undefined && owned.phase === "active"
      && owned.mappingStateFingerprint === mapping.mappingFingerprint
      && owned.accountTailnetHash === accountHash(status, identityKey);
    if (durableOwned) this.#owned = owned;
    return endpoint(
      status,
      this.#dependencies.gatewayPort,
      durableOwned && owned?.ownershipSubtype === "wizard-created",
      identityKey,
    );
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
    await this.reconcileOwned(signal);
  }

  /** Crash/uninstall recovery entry point. It needs no sidecar endpoint: SQLite ownership and an
   * exact live-state comparison are the complete authority. Call this before deleting SQLite. */
  async reconcileOwned(signal?: AbortSignal): Promise<void> {
    const owned = this.#owned ?? await this.#dependencies.ownership.read(signal);
    if (owned === undefined) return;
    const cli = await this.#cli(signal, false);
    await cli.requireSupportedVersion(signal);
    await cli.requireOfficialControlServer(signal);
    const identityKey = await this.#loadIdentityKey(signal);
    let status: TailscaleStatus;
    try {
      status = await cli.status(signal);
    } catch (error) {
      throw cliPause("status_unavailable", error);
    }
    if (status.state !== "running") throw new TailscaleModeReadinessError("status");
    if (accountHash(status, identityKey) !== owned.accountTailnetHash)
      throw new TailscaleModeReadinessError("account_changed");
    if (owned.phase === "preferences") {
      await this.#rollbackPreferences(cli, owned, owned.preferenceRestorations, signal);
      await this.#removeOwnershipIdempotently(owned, signal);
      return;
    }
    const mapping = await this.#mappingInspection(cli, owned.dnsName, signal);
    if (mapping.outcome === "empty") {
      await this.#rollbackPreferences(cli, owned, owned.preferenceRestorations, signal);
      await this.#removeOwnershipIdempotently(owned, signal);
      return;
    }
    if (mapping.outcome !== "compatible" || mapping.mappingFingerprint !== owned.mappingStateFingerprint) {
      await this.#rollbackPreferences(cli, owned, owned.preferenceRestorations, signal);
      await this.#removeOwnershipIdempotently(owned, signal);
      return;
    }
    if (owned.ownershipSubtype === "reused") {
      await this.#rollbackPreferences(cli, owned, owned.preferenceRestorations, signal);
      await this.#removeOwnershipIdempotently(owned, signal);
      return;
    }
    let removalError: unknown;
    try {
      await cli.removeTlsTerminatedMapping(signal);
    } catch (error) {
      removalError = error;
    }
    await this.#withRecoverySignal(async (recoverySignal) => {
      const after = await this.#mappingInspection(cli, owned.dnsName, recoverySignal);
      if (after.outcome === "empty") {
        await this.#inject("mapping_remove");
        await this.#rollbackPreferences(cli, owned, owned.preferenceRestorations, recoverySignal);
        await this.#removeOwnershipIdempotently(owned, recoverySignal);
        return;
      }
      if (removalError !== undefined) throw cliPause("mapping_mutation_failed", removalError);
      throw new TailscaleModeReadinessError("mapping");
    }, signal);
  }

  async #cli(signal: AbortSignal | undefined, allowInstall: boolean): Promise<TailscaleCli> {
    let discovery = await this.#dependencies.helper.discoverTailscale(signal);
    if (discovery.state !== "ready" && discovery.reason === "tailscale_not_installed") {
      if (!allowInstall) throw new TailscaleModePause("not_installed");
      if (!await this.#dependencies.io.offerInstall(signal)) throw new TailscaleModePause("not_installed");
      try {
        await this.#dependencies.helper.installTailscale(signal);
      } catch (error) {
        const detail = typedReason(error);
        if (detail === "installer_cancelled") throw new TailscaleModePause("install_cancelled", detail);
        if (detail === "installer_reboot_required") throw new TailscaleModePause("install_reboot_required", detail);
        if (detail === "installer_signature_invalid")
          throw new TailscaleModePause("install_verification_failed", detail);
        throw new TailscaleModePause("install_failed", detail);
      }
      await this.#inject("install");
      discovery = await this.#dependencies.helper.discoverTailscale(signal);
    }
    if (discovery.state !== "ready") throw new TailscaleModePause(
      discovery.reason === "tailscale_not_installed" ? "not_installed" : "unsupported_install",
      discovery.reason,
    );
    return new TailscaleCli({
      executable: discovery.cliPath,
      runner: this.#dependencies.cliRunner,
      timeoutMs: this.#dependencies.cliTimeoutMs,
    });
  }

  async #mappingInspection(
    cli: TailscaleCli,
    dnsName: string,
    signal?: AbortSignal,
  ): Promise<TailscaleMappingInspection> {
    try {
      const [serve, funnel] = await this.#mappingStates(cli, signal);
      return inspectTailscaleMappings(serve, funnel, dnsName, this.#dependencies.gatewayPort);
    } catch (error) {
      if (error instanceof TailscaleModePause) throw error;
      throw cliPause("mapping_inspection_failed", error);
    }
  }

  async #mappingStates(
    cli: TailscaleCli,
    signal?: AbortSignal,
  ): Promise<readonly [Record<string, unknown>, Record<string, unknown>]> {
    const [serve, funnel] = await Promise.allSettled([
      cli.serveState(signal),
      cli.funnelState(signal),
    ]);
    if (serve.status === "rejected") throw serve.reason;
    if (funnel.status === "rejected") throw funnel.reason;
    return [serve.value, funnel.value];
  }

  async #withRecoverySignal<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const configured = this.#dependencies.cliTimeoutMs ?? 15_000;
    const milliseconds = Number.isFinite(configured)
      ? Math.min(30_000, Math.max(1, configured))
      : 15_000;
    const timer = setTimeout(() => controller.abort(), milliseconds);
    const abort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abort, { once: true });
    if (parentSignal?.aborted) abort();
    try {
      return await operation(controller.signal);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    }
  }

  #recoveryMappingInspection(cli: TailscaleCli, dnsName: string): Promise<TailscaleMappingInspection> {
    return this.#withRecoverySignal((recoverySignal) => this.#mappingInspection(cli, dnsName, recoverySignal));
  }

  async #preference(
    cli: TailscaleCli,
    name: "unattended" | "shields-up",
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      return await cli.preference(name, signal);
    } catch (error) {
      throw new TailscaleModePause(
        "preference_verification_failed",
        error instanceof TailscaleCliError ? error.reason : undefined,
      );
    }
  }

  async #removeOwnershipIdempotently(
    owned: TailscaleMappingOwnership,
    signal?: AbortSignal,
  ): Promise<void> {
    const removed = await this.#dependencies.ownership.remove(owned, signal);
    if (!removed && await this.#dependencies.ownership.read(signal) !== undefined)
      throw new TailscaleModeReadinessError("ownership");
    await this.#inject("ownership_remove");
    this.#owned = undefined;
  }

  async #loadIdentityKey(signal?: AbortSignal): Promise<Uint8Array> {
    if (this.#identityKey !== undefined) return this.#identityKey;
    const key = await this.#dependencies.ownership.identityHmacKey(signal);
    if (!(key instanceof Uint8Array) || key.byteLength < 32)
      throw new TailscaleModeReadinessError("ownership");
    this.#identityKey = Uint8Array.from(key);
    return this.#identityKey;
  }

  async #journalPreference(
    owned: TailscaleMappingOwnership,
    mutation: TailscalePreferenceRestoration,
    signal?: AbortSignal,
  ): Promise<TailscaleMappingOwnership> {
    const existing = owned.preferenceRestorations.find((item) => item.name === mutation.name);
    if (existing !== undefined) {
      if (existing.before !== mutation.before || existing.after !== mutation.after)
        throw new TailscaleModeReadinessError("ownership");
      return owned;
    }
    const replacement: TailscaleMappingOwnership = {
      ...owned,
      preferenceRestorations: [...owned.preferenceRestorations.map((item) => ({ ...item })), { ...mutation }],
    };
    if (!await this.#dependencies.ownership.replace(owned, replacement, signal))
      throw new TailscaleModeReadinessError("ownership");
    this.#owned = replacement;
    return replacement;
  }

  async #rollbackPreferences(
    cli: TailscaleCli,
    owned: TailscaleMappingOwnership,
    mutations: readonly { name: "unattended" | "shields-up"; before: boolean; after: boolean }[],
    outerSignal?: AbortSignal,
  ): Promise<void> {
    await this.#withRecoverySignal(async (signal) => {
      await this.#assertOwnedAccount(cli, owned, signal);
      for (const mutation of [...mutations].reverse()) {
        await this.#assertOwnedAccount(cli, owned, signal);
        const current = await cli.preference(mutation.name, signal);
        if (current !== mutation.after) continue;
        await this.#assertOwnedAccount(cli, owned, signal);
        await this.#dependencies.helper.setPreference(mutation.name, mutation.before, signal);
        await this.#assertOwnedAccount(cli, owned, signal);
        if (await cli.preference(mutation.name, signal) !== mutation.before)
          throw new TailscaleModeReadinessError("status");
      }
    }, outerSignal);
  }

  async #assertOwnedAccount(
    cli: TailscaleCli,
    owned: TailscaleMappingOwnership,
    signal?: AbortSignal,
  ): Promise<void> {
    const status = await cli.status(signal);
    const identityKey = await this.#loadIdentityKey(signal);
    if (status.state !== "running") throw new TailscaleModeReadinessError("status");
    if (accountHash(status, identityKey) !== owned.accountTailnetHash)
      throw new TailscaleModeReadinessError("account_changed");
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
    _signal?: AbortSignal,
  ): Promise<void> {
    await this.#withRecoverySignal((recoverySignal) => this.#rollbackExactWithSignal(
      cli,
      owned,
      recoverySignal,
    ));
  }

  async #rollbackExactWithSignal(
    cli: TailscaleCli,
    owned: TailscaleMappingOwnership,
    signal?: AbortSignal,
  ): Promise<void> {
    const status = await cli.status(signal);
    const identityKey = await this.#loadIdentityKey(signal);
    if (status.state !== "running") throw new TailscaleModeReadinessError("status");
    if (accountHash(status, identityKey) !== owned.accountTailnetHash)
      throw new TailscaleModeReadinessError("account_changed");
    if (owned.phase === "preferences") {
      await this.#rollbackPreferences(cli, owned, owned.preferenceRestorations, signal);
      await this.#removeOwnershipIdempotently(owned, signal);
      return;
    }
    const [serve, funnel] = await this.#mappingStates(cli, signal);
    const mapping = inspectTailscaleMappings(serve, funnel, owned.dnsName, this.#dependencies.gatewayPort);
    if (mapping.outcome === "empty") {
      await this.#rollbackPreferences(cli, owned, owned.preferenceRestorations, signal);
      await this.#removeOwnershipIdempotently(owned, signal);
      return;
    }
    if (mapping.outcome !== "compatible" || mapping.mappingFingerprint !== owned.mappingStateFingerprint) {
      await this.#rollbackPreferences(cli, owned, owned.preferenceRestorations, signal);
      await this.#removeOwnershipIdempotently(owned, signal);
      return;
    }
    if (owned.ownershipSubtype === "reused") {
      await this.#rollbackPreferences(cli, owned, owned.preferenceRestorations, signal);
      await this.#removeOwnershipIdempotently(owned, signal);
      return;
    }
    let removalError: unknown;
    try {
      await cli.removeTlsTerminatedMapping(signal);
    } catch (error) {
      removalError = error;
    }
    const after = await this.#mappingInspection(cli, owned.dnsName, signal);
    if (after.outcome !== "empty") {
      if (removalError !== undefined) throw cliPause("mapping_mutation_failed", removalError);
      throw new TailscaleModeReadinessError("mapping");
    }
    await this.#inject("mapping_remove");
    await this.#rollbackPreferences(cli, owned, owned.preferenceRestorations, signal);
    await this.#removeOwnershipIdempotently(owned, signal);
  }
}

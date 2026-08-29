import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

import { loadConfig } from "./config.ts";
import type { AuthoritativeOnboardingStatus, OnboardingAuthority, OnboardingRuntimeContext } from "./network-onboarding.ts";
import type { FinalizeInput, FinalizeResult, PublishedCode, SetupCodeOutputState, Storage, TransitionResult } from "./storage.ts";

/** Concrete Task 10 bridge: status and publication transitions share the same SQLite handle. */
export class SqliteOnboardingAuthority implements OnboardingAuthority {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  status(): AuthoritativeOnboardingStatus {
    return this.#storage.onboardingAuthorityStatus() as AuthoritativeOnboardingStatus;
  }

  runtimeContext(): OnboardingRuntimeContext {
    return this.#storage.onboardingRuntimeContext();
  }

  finalizeVerifiedSetupCode(input: FinalizeInput): FinalizeResult {
    return this.#storage.finalizeVerifiedSetupCode(input);
  }

  activatePendingSetupCode(input: PublishedCode): TransitionResult<SetupCodeOutputState> {
    return this.#storage.activatePendingSetupCode(input);
  }

  revokePendingSetupCode(input: PublishedCode): TransitionResult<SetupCodeOutputState> {
    return this.#storage.revokePendingSetupCode(input);
  }
}

const LISTENER_PORT_ERROR = "listener port must be a whole number from 1 through 65535";
const LISTENER_HOST_ERROR = "bind address must be a hostname or IP address, not a URL or whitespace";

export function validateListenerHost(raw: string): string {
  const host = raw.trim();
  if (host.length === 0 || /\s/.test(host) || /[:\[\]/?#]/.test(host) && isIP(host) === 0) {
    throw new Error(LISTENER_HOST_ERROR);
  }
  if (isIP(host) !== 0) return host;
  if (host.length > 253) throw new Error(LISTENER_HOST_ERROR);
  const labels = host.split(".");
  if (labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    throw new Error(LISTENER_HOST_ERROR);
  }
  return host;
}

export function parseListenerPort(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) throw new Error(LISTENER_PORT_ERROR);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(LISTENER_PORT_ERROR);
  return port;
}

function writeAtomic(path: string, content: string, validate?: (temporary: string) => void): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const mode = statSync(path).mode;
    const descriptor = openSync(temporary, "wx", mode);
    try {
      writeFileSync(descriptor, content, { encoding: "utf8" });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporary, mode);
    validate?.(temporary);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error;
  }
}

export class ManagedListenerBusyError extends Error {
  readonly retryable = true;
  readonly reason = "listener_changed";

  constructor() {
    super("managed listener is being changed by another process");
    this.name = "ManagedListenerBusyError";
  }
}

const LISTENER_LOCK_OWNER = "owner.json";
const LISTENER_LOCK_OWNER_MAX_BYTES = 256;
const LISTENER_LOCK_NONCE = /^[0-9a-f]{32}$/;

interface ListenerLockOwner {
  version: 1;
  pid: number;
  nonce: string;
}

function listenerLockOwnerText(owner: ListenerLockOwner): string {
  return `${JSON.stringify(owner)}\n`;
}

function readListenerLockOwner(lockPath: string): { owner: ListenerLockOwner; text: string } | undefined {
  const path = join(lockPath, LISTENER_LOCK_OWNER);
  try {
    if (statSync(path).size > LISTENER_LOCK_OWNER_MAX_BYTES) return undefined;
    const text = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "nonce,pid,version"
      || value.version !== 1
      || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1
      || typeof value.nonce !== "string" || !LISTENER_LOCK_NONCE.test(value.nonce)) return undefined;
    return { owner: value as unknown as ListenerLockOwner, text };
  } catch {
    return undefined;
  }
}

function pidDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function restoreQuarantinedLock(quarantinePath: string, lockPath: string): void {
  if (!existsSync(lockPath) && existsSync(quarantinePath)) {
    try { renameSync(quarantinePath, lockPath); } catch { /* Fail closed with the quarantine intact. */ }
  }
}

/** A stale lock is reclaimed once, and only after the exact owner bytes observed before the atomic
 * directory rename are observed inside quarantine. Unknown/malformed/live ownership fails closed. */
function reclaimDeadListenerLockOnce(lockPath: string): boolean {
  const observed = readListenerLockOwner(lockPath);
  if (observed === undefined || !pidDefinitelyDead(observed.owner.pid)) return false;
  const quarantinePath = `${lockPath}.stale.${randomUUID().replaceAll("-", "")}`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch {
    return false;
  }
  try {
    const quarantined = readListenerLockOwner(quarantinePath);
    if (quarantined === undefined || quarantined.text !== observed.text) {
      restoreQuarantinedLock(quarantinePath, lockPath);
      return false;
    }
    const entries = readdirSync(quarantinePath);
    if (entries.length !== 1 || entries[0] !== LISTENER_LOCK_OWNER) {
      restoreQuarantinedLock(quarantinePath, lockPath);
      return false;
    }
    unlinkSync(join(quarantinePath, LISTENER_LOCK_OWNER));
    rmdirSync(quarantinePath);
    return true;
  } catch {
    restoreQuarantinedLock(quarantinePath, lockPath);
    return false;
  }
}

function installListenerLock(lockPath: string, ownerText: string, nonce: string): boolean {
  const stagingPath = `${lockPath}.acquire.${nonce}`;
  const ownerPath = join(stagingPath, LISTENER_LOCK_OWNER);
  try {
    mkdirSync(stagingPath);
    const descriptor = openSync(ownerPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, ownerText, { encoding: "utf8" });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(stagingPath, lockPath);
      return true;
    } catch {
      return false;
    }
  } catch {
    throw new ManagedListenerBusyError();
  } finally {
    if (existsSync(stagingPath)) {
      try { unlinkSync(ownerPath); } catch { /* It may not have been created. */ }
      try { rmdirSync(stagingPath); } catch { /* Never remove anything recursively. */ }
    }
  }
}

function acquireListenerLock(lockPath: string): string {
  const nonce = randomUUID().replaceAll("-", "");
  const ownerText = listenerLockOwnerText({
    version: 1,
    pid: process.pid,
    nonce,
  });
  if (installListenerLock(lockPath, ownerText, nonce)) return ownerText;
  if (!reclaimDeadListenerLockOnce(lockPath)) throw new ManagedListenerBusyError();
  if (!installListenerLock(lockPath, ownerText, nonce)) throw new ManagedListenerBusyError();
  return ownerText;
}

function releaseListenerLock(lockPath: string, ownerText: string): void {
  const current = readListenerLockOwner(lockPath);
  const entries = (() => { try { return readdirSync(lockPath); } catch { return []; } })();
  if (current?.text !== ownerText || entries.length !== 1 || entries[0] !== LISTENER_LOCK_OWNER)
    throw new ManagedListenerBusyError();
  unlinkSync(join(lockPath, LISTENER_LOCK_OWNER));
  rmdirSync(lockPath);
}

function withListenerLock<T>(configPath: string, operation: () => T): T {
  const lockPath = `${configPath}.listener.lock`;
  const ownerText = acquireListenerLock(lockPath);
  try {
    return operation();
  } finally {
    releaseListenerLock(lockPath, ownerText);
  }
}

function updateListenerConfigUnlocked(
  path: string,
  requestedHost: string,
  requestedPort: number,
  options: { clearPublicUrl?: boolean } = {},
): void {
  const host = validateListenerHost(requestedHost);
  const port = parseListenerPort(String(requestedPort));
  const existing: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new Error("gateway configuration must be a JSON object");
  }

  const replacement = { ...existing, host, port } as Record<string, unknown>;
  if (options.clearPublicUrl === true) delete replacement.publicUrl;
  writeAtomic(path, `${JSON.stringify(replacement, null, 2)}\n`, loadConfig);
}

export function updateListenerConfig(
  path: string,
  requestedHost: string,
  requestedPort: number,
  options: { clearPublicUrl?: boolean } = {},
): void {
  withListenerLock(path, () => updateListenerConfigUnlocked(path, requestedHost, requestedPort, options));
}

export interface ManagedHermesProfile {
  profile: string;
  executable: string;
}

function nativeManagedPath(path: string): string {
  if (process.platform !== "win32") return path;
  const match = /^\/([A-Za-z])\/(.*)$/.exec(path);
  return match === null ? path : `${match[1]!.toUpperCase()}:\\${match[2]!.replaceAll("/", "\\")}`;
}

export function listenerOrigin(host: string, port: number, scheme: "http" | "https"): string {
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const urlHost = localHost.includes(":") && !localHost.startsWith("[") ? `[${localHost}]` : localHost;
  return `${scheme}://${urlHost}:${port}`;
}

export interface ManagedListenerSnapshot {
  configText: string;
  installStateText?: string;
  profiles: Array<{
    profile: string;
    executable: string;
    envPath: string;
    content: string;
  }>;
}

function managedProfileFiles(configPath: string): {
  installStateText?: string;
  profiles: ManagedListenerSnapshot["profiles"];
} {
  const statePath = join(dirname(configPath), "install-state");
  if (!existsSync(statePath)) return { profiles: [] };
  const installStateText = readFileSync(statePath, "utf8");
  const state = new Map<string, string>();
  for (const line of installStateText.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) state.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const names = (state.get("profiles") ?? "").split(",").filter(Boolean);
  const rawRoot = state.get("hermes_root") ?? "";
  const rawExecutable = state.get("hermes_bin") ?? "";
  if (names.length === 0 || rawRoot.length === 0 || rawExecutable.length === 0)
    throw new Error("managed install state is incomplete; rerun the CozyGateway installer");
  if (names.some((profile) => !/^[A-Za-z0-9._-]+$/.test(profile)))
    throw new Error("managed install state contains an invalid Hermes profile name");
  const hermesRoot = nativeManagedPath(rawRoot);
  const executable = nativeManagedPath(rawExecutable);
  return {
    installStateText,
    profiles: names.map((profile) => {
      const envPath = profile === "default"
        ? join(hermesRoot, ".env")
        : join(hermesRoot, "profiles", profile, ".env");
      return { profile, executable, envPath, content: readFileSync(envPath, "utf8") };
    }),
  };
}

function readManagedListenerSnapshotUnlocked(configPath: string): ManagedListenerSnapshot {
  const managed = managedProfileFiles(configPath);
  return { configText: readFileSync(configPath, "utf8"), ...managed };
}

export function readManagedListenerSnapshot(configPath: string): ManagedListenerSnapshot {
  return withListenerLock(configPath, () => readManagedListenerSnapshotUnlocked(configPath));
}

function sameManagedListenerSnapshot(left: ManagedListenerSnapshot, right: ManagedListenerSnapshot): boolean {
  return left.configText === right.configText
    && left.installStateText === right.installStateText
    && left.profiles.length === right.profiles.length
    && left.profiles.every((profile, index) => {
      const other = right.profiles[index];
      return other !== undefined
        && profile.profile === other.profile
        && profile.executable === other.executable
        && profile.envPath === other.envPath
        && profile.content === other.content;
    });
}

function replacementConfigText(
  existingText: string,
  requestedHost: string,
  requestedPort: number,
  options: { clearPublicUrl?: boolean },
): string {
  const host = validateListenerHost(requestedHost);
  const port = parseListenerPort(String(requestedPort));
  const existing: unknown = JSON.parse(existingText);
  if (typeof existing !== "object" || existing === null || Array.isArray(existing))
    throw new Error("gateway configuration must be a JSON object");
  const replacement = { ...existing, host, port } as Record<string, unknown>;
  if (options.clearPublicUrl === true) delete replacement.publicUrl;
  return `${JSON.stringify(replacement, null, 2)}\n`;
}

function loadReplacementConfig(configPath: string, text: string): ReturnType<typeof loadConfig> {
  const temporary = `${configPath}.${process.pid}.${Date.now()}.validate`;
  writeFileSync(temporary, text, "utf8");
  try {
    return loadConfig(temporary);
  } finally {
    unlinkSync(temporary);
  }
}

function replacementProfileContent(
  profile: ManagedListenerSnapshot["profiles"][number],
  config: ReturnType<typeof loadConfig>,
): string {
  const current = /^COZYGATEWAY_URL=(.*)$/m.exec(profile.content)?.[1];
  if (current === undefined)
    throw new Error(`Hermes profile ${profile.profile} is missing its installer-managed CozyGateway URL`);
  let target = listenerOrigin(config.host ?? "0.0.0.0", config.port, "http");
  if (config.tls !== undefined) {
    const url = new URL(current);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "")
      throw new Error(`Hermes profile ${profile.profile} needs an existing https CozyGateway origin with its certificate hostname before TLS listener changes`);
    url.port = String(config.port);
    target = url.origin;
  }
  return profile.content.replace(/^COZYGATEWAY_URL=.*$/m, `COZYGATEWAY_URL=${target}`);
}

export function compareAndSwapManagedListenerSnapshot(
  configPath: string,
  expected: ManagedListenerSnapshot,
  replacement: ManagedListenerSnapshot,
): boolean {
  return withListenerLock(configPath, () => {
    const current = readManagedListenerSnapshotUnlocked(configPath);
    if (!sameManagedListenerSnapshot(current, expected)) return false;
    if (current.installStateText !== replacement.installStateText
      || current.profiles.length !== replacement.profiles.length
      || current.profiles.some((profile, index) => {
        const other = replacement.profiles[index];
        return other === undefined || profile.profile !== other.profile || profile.executable !== other.executable
          || profile.envPath !== other.envPath;
      })) throw new Error("managed listener snapshot shape changed");
    loadReplacementConfig(configPath, replacement.configText);
    try {
      for (const profile of replacement.profiles) writeAtomic(profile.envPath, profile.content);
      writeAtomic(configPath, replacement.configText, loadConfig);
      return true;
    } catch (error) {
      for (const profile of current.profiles) writeAtomic(profile.envPath, profile.content);
      writeAtomic(configPath, current.configText, loadConfig);
      throw error;
    }
  });
}

export function compareAndSwapManagedListener(
  configPath: string,
  expected: ManagedListenerSnapshot,
  requestedHost: string,
  requestedPort: number,
  options: { clearPublicUrl?: boolean } = {},
): boolean {
  return withListenerLock(configPath, () => {
    const current = readManagedListenerSnapshotUnlocked(configPath);
    if (!sameManagedListenerSnapshot(current, expected)) return false;
    const configText = replacementConfigText(current.configText, requestedHost, requestedPort, options);
    const config = loadReplacementConfig(configPath, configText);
    const profiles = current.profiles.map((profile) => replacementProfileContent(profile, config));
    try {
      for (let index = 0; index < current.profiles.length; index += 1)
        writeAtomic(current.profiles[index]!.envPath, profiles[index]!);
      writeAtomic(configPath, configText, loadConfig);
      return true;
    } catch (error) {
      for (const profile of current.profiles) writeAtomic(profile.envPath, profile.content);
      writeAtomic(configPath, current.configText, loadConfig);
      throw error;
    }
  });
}

function syncManagedListenerTargetsUnlocked(configPath: string): ManagedHermesProfile[] {
  const config = loadConfig(configPath);
  const host = validateListenerHost(config.host ?? "0.0.0.0");
  const port = parseListenerPort(String(config.port));
  const statePath = join(dirname(configPath), "install-state");
  if (!existsSync(statePath)) return [];

  const state = new Map<string, string>();
  for (const line of readFileSync(statePath, "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) state.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const profiles = (state.get("profiles") ?? "").split(",").filter(Boolean);
  const rawRoot = state.get("hermes_root") ?? "";
  const rawExecutable = state.get("hermes_bin") ?? "";
  if (profiles.length === 0 || rawRoot.length === 0 || rawExecutable.length === 0) {
    throw new Error("managed install state is incomplete; rerun the CozyGateway installer");
  }
  if (profiles.some((profile) => !/^[A-Za-z0-9._-]+$/.test(profile))) {
    throw new Error("managed install state contains an invalid Hermes profile name");
  }

  const hermesRoot = nativeManagedPath(rawRoot);
  const executable = nativeManagedPath(rawExecutable);
  const updates = profiles.map((profile) => {
    const envPath = profile === "default" ? join(hermesRoot, ".env") : join(hermesRoot, "profiles", profile, ".env");
    const before = readFileSync(envPath, "utf8");
    const current = /^COZYGATEWAY_URL=(.*)$/m.exec(before)?.[1];
    if (current === undefined) {
      throw new Error(`Hermes profile ${profile} is missing its installer-managed CozyGateway URL`);
    }
    let target = listenerOrigin(host, port, "http");
    if (config.tls !== undefined) {
      const url = new URL(current);
      if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
        throw new Error(`Hermes profile ${profile} needs an existing https CozyGateway origin with its certificate hostname before TLS listener changes`);
      }
      url.port = String(port);
      target = url.origin;
    }
    return { profile, envPath, content: before.replace(/^COZYGATEWAY_URL=.*$/m, `COZYGATEWAY_URL=${target}`) };
  });
  for (const update of updates) writeAtomic(update.envPath, update.content);
  return updates.map(({ profile }) => ({ profile, executable }));
}

export function syncManagedListenerTargets(configPath: string): ManagedHermesProfile[] {
  return withListenerLock(configPath, () => syncManagedListenerTargetsUnlocked(configPath));
}

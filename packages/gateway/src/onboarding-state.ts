import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { OnboardingMode } from "./storage.ts";

export const NETWORK_ONBOARDING_STATE_MAX_BYTES = 4_096;
export const NETWORK_ONBOARDING_STATE_VERSION = 1 as const;

interface StateBase {
  version: typeof NETWORK_ONBOARDING_STATE_VERSION;
  updatedAt: number;
}

export type NetworkOnboardingState =
  | StateBase & { stage: "pending_choice" }
  | StateBase & { stage: "network_selected"; mode: OnboardingMode }
  | StateBase & {
      stage: "endpoint_ready" | "verifying_phone";
      mode: OnboardingMode;
      deploymentFingerprint: string;
    }
  | StateBase & {
      stage: "complete";
      mode: OnboardingMode;
      deploymentFingerprint: string;
      verifiedAt: number;
    }
  | StateBase & {
      stage: "legacy_unreviewed";
      mode: OnboardingMode;
      deploymentFingerprint: string;
    };

export interface NetworkOnboardingStateProjection {
  read(): Promise<NetworkOnboardingState | undefined>;
  write(state: NetworkOnboardingState): Promise<void>;
}

export interface NetworkOnboardingStateFileOptions {
  /** The already-created private local state directory. */
  localRoot: string;
  /** Defaults to `<localRoot>/network-onboarding.json`. */
  statePath?: string;
  platform?: NodeJS.Platform;
  /** Task 8 supplies the fixed Windows helper-backed implementation. */
  protectWindowsAcl?: (path: string) => Promise<void>;
}

export interface NetworkOnboardingStateReader {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

const MODES = new Set<OnboardingMode>(["tailscale", "lan", "advanced"]);
const FINGERPRINT_PATTERN = /^[\x21-\x7e]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function mode(value: unknown): value is OnboardingMode {
  return typeof value === "string" && MODES.has(value as OnboardingMode);
}

function fingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

/** Parse only the deliberately tiny, non-secret resume projection. Unknown fields are rejected so
 * a future caller cannot accidentally turn this sidecar into a capability or identity store. */
export function parseNetworkOnboardingState(text: string): NetworkOnboardingState {
  if (Buffer.byteLength(text, "utf8") > NETWORK_ONBOARDING_STATE_MAX_BYTES)
    throw new Error("network onboarding state is too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("network onboarding state does not match the bounded schema");
  }
  if (!isRecord(value) || value.version !== NETWORK_ONBOARDING_STATE_VERSION || !timestamp(value.updatedAt))
    throw new Error("network onboarding state does not match the bounded schema");

  if (value.stage === "pending_choice" && exactKeys(value, ["version", "stage", "updatedAt"]))
    return value as unknown as NetworkOnboardingState;
  if (
    value.stage === "network_selected"
    && exactKeys(value, ["version", "stage", "mode", "updatedAt"])
    && mode(value.mode)
  ) return value as unknown as NetworkOnboardingState;
  if (
    (value.stage === "endpoint_ready" || value.stage === "verifying_phone" || value.stage === "legacy_unreviewed")
    && exactKeys(value, ["version", "stage", "mode", "deploymentFingerprint", "updatedAt"])
    && mode(value.mode)
    && fingerprint(value.deploymentFingerprint)
  ) return value as unknown as NetworkOnboardingState;
  if (
    value.stage === "complete"
    && exactKeys(value, ["version", "stage", "mode", "deploymentFingerprint", "verifiedAt", "updatedAt"])
    && mode(value.mode)
    && fingerprint(value.deploymentFingerprint)
    && timestamp(value.verifiedAt)
  ) return value as unknown as NetworkOnboardingState;
  throw new Error("network onboarding state does not match the bounded schema");
}

/** Reads one byte beyond the schema cap and stops. The loop handles legal short reads without
 * ever falling back to an unbounded `readFile`, so growth after open cannot allocate or parse more
 * than 4,097 bytes. */
export async function readBoundedNetworkOnboardingState(
  reader: NetworkOnboardingStateReader,
): Promise<NetworkOnboardingState> {
  const buffer = Buffer.alloc(NETWORK_ONBOARDING_STATE_MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await reader.read(buffer, offset, buffer.length - offset, offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length - offset)
      throw new Error("network onboarding state read was invalid");
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > NETWORK_ONBOARDING_STATE_MAX_BYTES)
    throw new Error("network onboarding state is too large");
  return parseNetworkOnboardingState(buffer.subarray(0, offset).toString("utf8"));
}

function within(root: string, target: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => platform === "win32" ? value.toLowerCase() : value;
  const path = relative(normalize(root), normalize(target));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function existsLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export class NetworkOnboardingStateFile implements NetworkOnboardingStateProjection {
  readonly #localRoot: string;
  readonly #statePath: string;
  readonly #platform: NodeJS.Platform;
  readonly #protectWindowsAcl: ((path: string) => Promise<void>) | undefined;

  constructor(options: NetworkOnboardingStateFileOptions) {
    this.#platform = options.platform ?? process.platform;
    this.#localRoot = resolve(options.localRoot);
    this.#statePath = resolve(options.statePath ?? join(this.#localRoot, "network-onboarding.json"));
    this.#protectWindowsAcl = options.protectWindowsAcl;
    if (!within(this.#localRoot, this.#statePath, this.#platform))
      throw new Error("network onboarding state path is outside the local root");
  }

  get path(): string {
    return this.#statePath;
  }

  async #assertSafeTarget(): Promise<void> {
    const rootInfo = await existsLstat(this.#localRoot);
    if (rootInfo === undefined || !rootInfo.isDirectory())
      throw new Error("network onboarding local root is not a directory");
    if (rootInfo.isSymbolicLink()) throw new Error("network onboarding local root is a reparse or symbolic link");
    const canonicalRoot = await realpath(this.#localRoot);
    if (!within(canonicalRoot, canonicalRoot, this.#platform))
      throw new Error("network onboarding local root is invalid");

    const parent = dirname(this.#statePath);
    const relativeParent = relative(this.#localRoot, parent);
    let cursor = this.#localRoot;
    for (const part of relativeParent.split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      const info = await existsLstat(cursor);
      if (info?.isSymbolicLink())
        throw new Error("network onboarding state parent is a reparse or symbolic link");
      if (info === undefined || !info.isDirectory())
        throw new Error("network onboarding state parent is not a directory");
    }
    const canonicalParent = await realpath(parent);
    if (!within(canonicalRoot, canonicalParent, this.#platform))
      throw new Error("network onboarding state resolves outside the local root");
    const targetInfo = await existsLstat(this.#statePath);
    if (targetInfo?.isSymbolicLink())
      throw new Error("network onboarding state is a reparse or symbolic link");
    if (targetInfo !== undefined && !targetInfo.isFile())
      throw new Error("network onboarding state is not a regular file");
  }

  async read(): Promise<NetworkOnboardingState | undefined> {
    await this.#assertSafeTarget();
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.#statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("network onboarding state is not a regular file");
      return await readBoundedNetworkOnboardingState(handle);
    } finally {
      await handle.close();
    }
  }

  async write(state: NetworkOnboardingState): Promise<void> {
    if (this.#platform === "win32" && this.#protectWindowsAcl === undefined)
      throw new Error("an explicit Windows ACL protector is required for onboarding state");
    await this.#assertSafeTarget();
    const serialized = `${JSON.stringify(state)}\n`;
    parseNetworkOnboardingState(serialized);
    const tempPath = `${this.#statePath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        tempPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (this.#protectWindowsAcl !== undefined) await this.#protectWindowsAcl(tempPath);
      await rename(tempPath, this.#statePath);
      if (this.#protectWindowsAcl !== undefined) await this.#protectWindowsAcl(this.#statePath);
      // Flush the directory entry on platforms which permit opening directories. Windows rejects
      // this operation, while its atomic rename above remains the durability boundary available to Node.
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.#statePath), constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(tempPath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
      throw error;
    }
  }
}

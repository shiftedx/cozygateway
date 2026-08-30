import {
  WORKSPACE_FILE_MAX_BYTES,
  WORKSPACE_LIST_MAX_ENTRIES,
  WORKSPACE_PATH_MAX_BYTES,
  WORKSPACE_RANGE_MAX_BYTES,
  WORKSPACE_SEGMENT_MAX_BYTES,
  type GatewayHarness,
  type HarnessWorkspaceEntry,
  type HarnessWorkspaceList,
} from "cozygateway-contract";

import type { HermesClient } from "./client.ts";

export const WORKSPACE_DOWNLOAD_MAX_CONCURRENT = 4;
export const WORKSPACE_DOWNLOAD_TIMEOUT_MS = 30_000;
export const WORKSPACE_LIST_MAX_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_LIST_TIMEOUT_MS = 10_000;
export const WORKSPACE_RATE_CAPACITY = 30;
export const WORKSPACE_RATE_REFILL_MS = 2_000;
const WORKSPACE_RATE_MEMORY_MAX = 512;

const SENSITIVE_BASENAMES = new Set([
  "auth.json", "auth.lock", "credentials", ".anthropic_oauth.json",
  "google_token.json", "google_oauth_pending.json", "google_oauth.json",
  "webhook_subscriptions.json", "bws_cache.json", "bws_cache.enc.json",
  ".git-credentials", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519",
  "config.yaml", "config.yml", "config.json", "config.toml",
  "token", "tokens", "secret", "secrets", "credential", "private_key",
  "service-account.json", "service_account.json", "kubeconfig", ".dockerconfigjson",
]);
const SENSITIVE_TREES = new Set([
  "mcp-tokens", "pairing", "credentials", "secrets", "config",
  ".config", ".git", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker",
  ".password-store",
]);

export class WorkspaceInvalid extends Error {}
export class WorkspaceForbidden extends Error {}
export class WorkspaceNotFound extends Error {}
export class WorkspaceTooLarge extends Error {}
export class WorkspaceBusy extends Error {}
export class WorkspaceRangeInvalid extends Error {
  readonly size?: number;
  constructor(size?: number) {
    super("workspace byte range is invalid");
    this.size = size;
  }
}
export class WorkspaceRateLimited extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("workspace request rate exceeded");
    this.retryAfterMs = retryAfterMs;
  }
}
export class WorkspaceUnavailable extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isSensitiveName(name: string): boolean {
  const lowered = name.toLowerCase();
  return lowered === ".env" || lowered.startsWith(".env.") || lowered === ".envrc"
    || lowered.startsWith("credentials.") || lowered.startsWith("secret.")
    || /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/.test(lowered)
    || SENSITIVE_BASENAMES.has(lowered) || SENSITIVE_TREES.has(lowered);
}

/** Admits exactly one canonical root-relative syntax. Backslashes are refused rather than
 * normalized so a path cannot mean one thing on this host and another on a Windows Hermes host. */
export function workspacePath(raw: string | undefined, opts: { file?: boolean } = {}): string {
  const value = raw ?? "";
  if (value.includes("\0")) throw new WorkspaceInvalid("workspace path is invalid");
  if (utf8Bytes(value) > WORKSPACE_PATH_MAX_BYTES)
    throw new WorkspaceInvalid("workspace path is too long");
  if (/^(?:[A-Za-z]:|[\\/]|file:)/i.test(value) || value.includes("\\"))
    throw new WorkspaceInvalid("workspace path must be relative");
  if (value === "") {
    if (opts.file === true) throw new WorkspaceInvalid("a file path is required");
    return "";
  }
  const parts = value.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..")
      throw new WorkspaceInvalid("workspace path is invalid");
    if (utf8Bytes(part) > WORKSPACE_SEGMENT_MAX_BYTES)
      throw new WorkspaceInvalid("workspace path segment is too long");
    if (isSensitiveName(part))
      throw new WorkspaceForbidden("that workspace path is not available");
  }
  return parts.join("/");
}

function externalPath(value: string): { text: string; windows: boolean } | undefined {
  if (!value || value.includes("\0")) return undefined;
  let text = value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const windows = /^[A-Za-z]:\//.test(text);
  if (!text.startsWith("/") && !windows) return undefined;
  while (text.length > (windows ? 3 : 1) && text.endsWith("/")) text = text.slice(0, -1);
  return { text: windows ? text.toLowerCase() : text, windows };
}

function externalPathHasSensitiveComponent(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).some((part, index) =>
    !(index === 0 && /^[A-Za-z]:$/.test(part)) && isSensitiveName(part));
}

function exactExternalPath(root: string, relative: string): string | undefined {
  const normalized = externalPath(root);
  if (!normalized) return undefined;
  const suffix = relative === "" ? "" : `/${normalized.windows ? relative.toLowerCase() : relative}`;
  return `${normalized.text}${suffix}`;
}

function lockedProof(raw: unknown, expectedRoot?: string): string | undefined {
  const row = record(raw);
  if (!row || row["can_change_path"] !== false) return undefined;
  const root = typeof row["root"] === "string" ? row["root"] : undefined;
  const locked = typeof row["locked_root"] === "string" ? row["locked_root"] : undefined;
  const a = root ? externalPath(root) : undefined;
  const b = locked ? externalPath(locked) : undefined;
  if (!a || !b || a.windows !== b.windows || a.text !== b.text) return undefined;
  if (externalPathHasSensitiveComponent(b.text)) return undefined;
  if (expectedRoot !== undefined) {
    const expected = externalPath(expectedRoot);
    if (!expected || expected.windows !== a.windows || expected.text !== a.text) return undefined;
  }
  return locked;
}

function safeMime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+;-]*$/.test(value)
    ? value
    : undefined;
}

function entryFromUpstream(
  raw: unknown,
  root: string,
  directory: string,
): HarnessWorkspaceEntry | undefined {
  const row = record(raw);
  if (!row || typeof row["name"] !== "string") throw new WorkspaceUnavailable("invalid workspace response");
  const name = row["name"];
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")
    || name.includes("\0") || utf8Bytes(name) > WORKSPACE_SEGMENT_MAX_BYTES)
    throw new WorkspaceUnavailable("invalid workspace response");
  if (isSensitiveName(name)) return undefined;
  const relative = directory === "" ? name : `${directory}/${name}`;
  if (utf8Bytes(relative) > WORKSPACE_PATH_MAX_BYTES)
    throw new WorkspaceTooLarge("projected workspace path is too long");
  const upstreamPath = typeof row["path"] === "string" ? externalPath(row["path"]) : undefined;
  const expectedPath = exactExternalPath(root, relative);
  if (!upstreamPath || expectedPath === undefined || upstreamPath.text !== expectedPath)
    throw new WorkspaceForbidden("workspace path escaped its locked root");
  const directoryFlag = row["is_directory"];
  if (typeof directoryFlag !== "boolean") throw new WorkspaceUnavailable("invalid workspace response");
  const mtime = row["mtime"];
  if (typeof mtime !== "number" || !Number.isFinite(mtime) || mtime < 0)
    throw new WorkspaceUnavailable("invalid workspace response");
  const modifiedAt = Math.min(Number.MAX_SAFE_INTEGER, Math.round(mtime * 1000));
  if (directoryFlag) return { name, path: relative, kind: "directory", modifiedAt };
  const size = row["size"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
    throw new WorkspaceUnavailable("invalid workspace response");
  const mimeType = safeMime(row["mime_type"]);
  return { name, path: relative, kind: "file", size, modifiedAt, ...(mimeType ? { mimeType } : {}) };
}

function profileQuery(scope: string): string {
  return `profile=${encodeURIComponent(scope)}`;
}

function mapUpstreamStatus(status: number): never {
  if (status === 404) throw new WorkspaceNotFound("workspace item not found");
  if (status === 400) throw new WorkspaceInvalid("workspace request is invalid");
  if (status === 403) throw new WorkspaceForbidden("workspace item is not available");
  if (status === 413) throw new WorkspaceTooLarge("workspace file is over the size cap");
  throw new WorkspaceUnavailable("workspace upstream is unavailable");
}

async function workspaceJson(client: HermesClient, path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await client.dashboardResponse(path, {
      headers: { accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: WORKSPACE_LIST_TIMEOUT_MS,
    });
  } catch {
    throw new WorkspaceUnavailable("workspace upstream is unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    mapUpstreamStatus(response.status);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > WORKSPACE_LIST_MAX_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new WorkspaceTooLarge("workspace directory response is over the size cap");
  }
  if (response.body === null) throw new WorkspaceUnavailable("invalid workspace response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > WORKSPACE_LIST_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new WorkspaceTooLarge("workspace directory response is over the size cap");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WorkspaceTooLarge) throw error;
    throw new WorkspaceUnavailable("workspace upstream is unavailable");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new WorkspaceUnavailable("invalid workspace response");
  }
}

export interface WorkspaceDownload {
  body: ReadableStream<Uint8Array>;
  status: 200 | 206;
  size: number;
  start: number;
  end: number;
  mimeType: string;
  filename: string;
}

export class HermesWorkspaceAdapter {
  readonly #client: HermesClient;
  readonly #harness: GatewayHarness;
  readonly #root: string;

  constructor(client: HermesClient, harness: GatewayHarness, lockedRoot: string) {
    this.#client = client;
    this.#harness = harness;
    this.#root = lockedRoot;
  }

  descriptor(): GatewayHarness { return this.#harness; }

  #scope(scopeId: string): string {
    if (!this.#harness.scopes.some((scope) => scope.id === scopeId))
      throw new WorkspaceNotFound("workspace harness or scope not found");
    return scopeId;
  }

  async list(scopeId: string, rawPath?: string, signal?: AbortSignal): Promise<HarnessWorkspaceList> {
    const scope = this.#scope(scopeId);
    const path = workspacePath(rawPath);
    let raw: unknown;
    try {
      raw = await workspaceJson(this.#client,
        `/api/files?path=${encodeURIComponent(path || ".")}&${profileQuery(scope)}`,
        signal,
      );
    } catch (error) {
      if (error instanceof WorkspaceInvalid || error instanceof WorkspaceForbidden
        || error instanceof WorkspaceNotFound || error instanceof WorkspaceTooLarge
        || error instanceof WorkspaceUnavailable) throw error;
      throw new WorkspaceUnavailable("workspace upstream is unavailable");
    }
    if (lockedProof(raw, this.#root) === undefined)
      throw new WorkspaceUnavailable("workspace lock proof changed");
    const row = record(raw)!;
    if (!Array.isArray(row["entries"])) throw new WorkspaceUnavailable("invalid workspace response");
    if (row["entries"].length > WORKSPACE_LIST_MAX_ENTRIES)
      throw new WorkspaceTooLarge("workspace directory has too many entries");
    const entries = row["entries"].flatMap((value) => {
      const entry = entryFromUpstream(value, this.#root, path);
      return entry === undefined ? [] : [entry];
    });
    const slash = path.lastIndexOf("/");
    return { path, parent: path === "" ? null : (slash < 0 ? "" : path.slice(0, slash)), entries };
  }

  async openDownload(
    scopeId: string,
    rawPath: string | undefined,
    rangeHeader: string | undefined,
    signal: AbortSignal,
  ): Promise<WorkspaceDownload> {
    const scope = this.#scope(scopeId);
    const path = workspacePath(rawPath, { file: true });
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : path.slice(0, slash);
    const listing = await this.list(scope, parent, signal);
    const entry = listing.entries.find((candidate) => candidate.path === path);
    if (!entry || entry.kind !== "file" || entry.size === undefined)
      throw new WorkspaceNotFound("workspace file not found");
    if (entry.size > WORKSPACE_FILE_MAX_BYTES)
      throw new WorkspaceTooLarge("workspace file is over the size cap");
    const range = resolveWorkspaceRange(rangeHeader, entry.size);
    if (range === null) throw new WorkspaceRangeInvalid(entry.size);
    if (range && range.end - range.start + 1 > WORKSPACE_RANGE_MAX_BYTES)
      throw new WorkspaceTooLarge("workspace byte range is over the size cap");
    const provenTarget = exactExternalPath(this.#root, path);
    if (provenTarget === undefined) throw new WorkspaceUnavailable("workspace lock proof changed");
    let response: Response;
    try {
      response = await this.#client.dashboardResponse(
        // This absolute target is derived only from the trusted locked root and admitted relative
        // path. It binds Hermes to the preflight root instead of re-resolving the same name under
        // a root that might have changed; it is never returned to the paired device.
        `/api/files/download?path=${encodeURIComponent(provenTarget)}&${profileQuery(scope)}`,
        {
          headers: {
            accept: "application/octet-stream",
            ...(rangeHeader === undefined ? {} : { range: rangeHeader }),
          },
          signal,
          timeoutMs: WORKSPACE_DOWNLOAD_TIMEOUT_MS,
        },
      );
    } catch {
      throw new WorkspaceUnavailable("workspace upstream is unavailable");
    }
    if (response.status === 416) {
      await response.body?.cancel().catch(() => {});
      throw new WorkspaceRangeInvalid(entry.size);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      mapUpstreamStatus(response.status);
    }
    const expectedStatus = range === undefined ? 200 : 206;
    if (response.status !== expectedStatus || response.body === null) {
      await response.body?.cancel().catch(() => {});
      throw new WorkspaceUnavailable("workspace upstream returned an invalid stream");
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, entry.size - 1);
    const expectedLength = entry.size === 0 ? 0 : end - start + 1;
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expectedLength)) {
      await response.body.cancel().catch(() => {});
      throw new WorkspaceUnavailable("workspace upstream returned an invalid stream");
    }
    if (range !== undefined) {
      const contentRange = response.headers.get("content-range");
      if (contentRange !== `bytes ${start}-${end}/${entry.size}`) {
        await response.body.cancel().catch(() => {});
        throw new WorkspaceUnavailable("workspace upstream returned an invalid stream");
      }
    }
    try {
      // Re-prove the root and entry while the absolute-target response is held, before exposing
      // any of its bytes downstream.
      const verified = (await this.list(scope, parent, signal)).entries
        .find((candidate) => candidate.path === path);
      if (!verified || verified.kind !== "file"
        || verified.name !== entry.name || verified.path !== entry.path
        || verified.size !== entry.size || verified.modifiedAt !== entry.modifiedAt
        || verified.mimeType !== entry.mimeType)
        throw new WorkspaceUnavailable("workspace entry changed during download");
    } catch (error) {
      await response.body.cancel().catch(() => {});
      if (error instanceof WorkspaceUnavailable || error instanceof WorkspaceInvalid
        || error instanceof WorkspaceForbidden || error instanceof WorkspaceNotFound
        || error instanceof WorkspaceTooLarge) throw error;
      throw new WorkspaceUnavailable("workspace upstream is unavailable");
    }
    return {
      body: response.body,
      status: expectedStatus,
      size: entry.size,
      start,
      end,
      mimeType: entry.mimeType ?? "application/octet-stream",
      filename: entry.name,
    };
  }
}

export async function discoverHermesWorkspace(
  client: HermesClient,
  harness: GatewayHarness,
): Promise<HermesWorkspaceAdapter | undefined> {
  const scope = harness.scopes[0]?.id;
  if (scope === undefined) return undefined;
  try {
    const raw = await workspaceJson(client,
      `/api/files?path=.&${profileQuery(scope)}`,
    );
    const root = lockedProof(raw);
    return root === undefined ? undefined : new HermesWorkspaceAdapter(client, harness, root);
  } catch {
    return undefined;
  }
}

export type WorkspaceRateLimiter = {
  take(deviceId: string, now: number): { ok: true } | { ok: false; retryAfterMs: number };
};

export function createWorkspaceRateLimiter(opts: { capacity?: number; refillMs?: number } = {}): WorkspaceRateLimiter {
  const capacity = opts.capacity ?? WORKSPACE_RATE_CAPACITY;
  const refillMs = opts.refillMs ?? WORKSPACE_RATE_REFILL_MS;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(deviceId, now) {
      const bucket = buckets.get(deviceId) ?? { tokens: capacity, at: now };
      const elapsed = Math.max(0, now - bucket.at);
      bucket.tokens = Math.min(capacity, bucket.tokens + Math.floor(elapsed / refillMs));
      if (elapsed >= refillMs) bucket.at += Math.floor(elapsed / refillMs) * refillMs;
      if (bucket.tokens < 1) {
        buckets.set(deviceId, bucket);
        return { ok: false, retryAfterMs: Math.max(1, refillMs - (now - bucket.at)) };
      }
      bucket.tokens -= 1;
      buckets.delete(deviceId);
      buckets.set(deviceId, bucket);
      if (buckets.size > WORKSPACE_RATE_MEMORY_MAX)
        buckets.delete(buckets.keys().next().value!);
      return { ok: true };
    },
  };
}

export class GatewayHarnessWorkspace {
  readonly #adapters: ReadonlyMap<string, HermesWorkspaceAdapter>;
  readonly #rate: WorkspaceRateLimiter;
  readonly #now: () => number;
  #inFlight = 0;

  constructor(
    adapters: readonly HermesWorkspaceAdapter[],
    opts: { rate?: WorkspaceRateLimiter; now?: () => number } = {},
  ) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.descriptor().id, adapter]));
    if (this.#adapters.size !== adapters.length) throw new Error("duplicate workspace harness id");
    this.#rate = opts.rate ?? createWorkspaceRateLimiter();
    this.#now = opts.now ?? Date.now;
  }

  get available(): boolean { return this.#adapters.size > 0; }

  #adapter(harnessId: string): HermesWorkspaceAdapter {
    const adapter = this.#adapters.get(harnessId);
    if (!adapter) throw new WorkspaceNotFound("workspace harness or scope not found");
    return adapter;
  }

  async list(
    harnessId: string,
    scopeId: string,
    path: string | undefined,
    deviceId: string,
    requestSignal?: AbortSignal,
  ): Promise<HarnessWorkspaceList> {
    const rate = this.#rate.take(deviceId, this.#now());
    if (!rate.ok) throw new WorkspaceRateLimited(rate.retryAfterMs);
    return this.#adapter(harnessId).list(scopeId, path, requestSignal);
  }

  async download(
    harnessId: string,
    scopeId: string,
    path: string | undefined,
    range: string | undefined,
    deviceId: string,
    requestSignal: AbortSignal,
  ): Promise<WorkspaceDownload> {
    const rate = this.#rate.take(deviceId, this.#now());
    if (!rate.ok) throw new WorkspaceRateLimited(rate.retryAfterMs);
    if (this.#inFlight >= WORKSPACE_DOWNLOAD_MAX_CONCURRENT) throw new WorkspaceBusy("workspace is busy");
    this.#inFlight += 1;
    let released = false;
    const abort = new AbortController();
    let onAbort: () => void;
    const release = () => {
      if (released) return;
      released = true;
      requestSignal.removeEventListener("abort", onAbort);
      this.#inFlight -= 1;
    };
    onAbort = () => {
      abort.abort(requestSignal.reason);
    };
    requestSignal.addEventListener("abort", onAbort, { once: true });
    if (requestSignal.aborted) onAbort();
    try {
      if (abort.signal.aborted) throw new WorkspaceUnavailable("workspace request was cancelled");
      const opened = await this.#adapter(harnessId).openDownload(scopeId, path, range, abort.signal);
      const expectedBytes = opened.size === 0 ? 0 : opened.end - opened.start + 1;
      return { ...opened, body: boundedWorkspaceStream(opened.body, expectedBytes, abort, release) };
    } catch (error) {
      abort.abort();
      release();
      throw error;
    }
  }
}

function boundedWorkspaceStream(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
  abort: AbortController,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let delivered = 0;
  let cancellation: Promise<void> | undefined;
  const cancelSource = (reason?: unknown): Promise<void> => {
    if (cancellation === undefined) {
      abort.abort(reason);
      cancellation = reader.cancel(reason).catch(() => {}).then(release);
    }
    return cancellation;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          // A pending read resolves done as soon as cancellation starts, before an async
          // underlying cancel settles. The cancellation promise owns release in that case.
          if (abort.signal.aborted) {
            await cancelSource(abort.signal.reason);
            return;
          }
          if (delivered !== expectedBytes) throw new WorkspaceUnavailable("workspace stream ended early");
          release();
          controller.close();
          return;
        }
        delivered += value.byteLength;
        if (delivered > expectedBytes) throw new WorkspaceUnavailable("workspace stream exceeded its size");
        controller.enqueue(value);
      } catch (error) {
        await cancelSource(error);
        controller.error(error instanceof WorkspaceUnavailable
          ? error : new WorkspaceUnavailable("workspace stream failed"));
      }
    },
    async cancel(reason) {
      await cancelSource(reason);
    },
  });
}

export type WorkspaceByteRange = { start: number; end: number };

export function resolveWorkspaceRange(
  header: string | undefined,
  size: number,
): WorkspaceByteRange | null | undefined {
  if (header === undefined) return undefined;
  if (header.length > 128 || !header.startsWith("bytes=") || header.includes(",") || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

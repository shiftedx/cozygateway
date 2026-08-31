import {
  HERMES_SESSION_EXPORT_MAX_BYTES,
  HERMES_SESSION_EXPORT_MAX_MESSAGES,
  HERMES_SESSION_MESSAGES_MAX,
  HERMES_SESSION_OFFSET_MAX,
  HERMES_SESSION_TEXT_MAX_LENGTH,
  HERMES_SESSION_TITLE_MAX_LENGTH,
  type GatewayHarness,
  type HermesSessionListResponse,
  type HermesSessionDetailResponse,
  type HermesSessionMessage,
  type HermesSessionMessagesResponse,
  type HermesSessionMutationResponse,
  type HermesSessionPatch,
  type HermesSessionSearchResponse,
  type HermesSessionSummary,
} from "cozygateway-contract";

import { normalizeTimestamp, stripImageDirectives } from "./chat-messages.ts";
import { HermesRpcError, HermesTimeout, type HermesClient } from "./client.ts";

const SESSION_JSON_MAX_BYTES = 8 * 1024 * 1024;
const EXPORT_PAGE_SIZE = HERMES_SESSION_MESSAGES_MAX;

export class HermesSessionInvalid extends Error {}
export class HermesSessionNotFound extends Error {}
export class HermesSessionTooLarge extends Error {}
export class HermesSessionUnavailable extends Error {}
/** The write may have landed. A client must refresh instead of retrying or rolling back locally. */
export class HermesSessionMutationAmbiguous extends Error {}

const HAS_OWN = Object.prototype.hasOwnProperty;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function id(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value);
  return text.length > 0 && text.length <= 256 ? text : undefined;
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function time(row: Record<string, unknown>, fields: readonly string[]): number {
  for (const field of fields) {
    const normalized = normalizeTimestamp(row[field]);
    if (normalized !== null) return normalized;
  }
  return 0;
}

/** Text is the only transcript payload approved across this boundary. Control bytes, image
 * directives, and host paths are removed before a string enters any response shape. */
export function projectHermesSessionText(value: unknown, maxLength = HERMES_SESSION_TEXT_MAX_LENGTH): string {
  if (typeof value !== "string") return "";
  const clean = redactHermesSessionPaths(stripImageDirectives(value))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  return clean.slice(0, maxLength);
}

/** Session transcript text is a privacy boundary, so every absolute host-path family is removed,
 * including roots with one segment. HTTP(S) URLs and embedded ordinary slashes are left alone. */
export function redactHermesSessionPaths(value: string): string {
  const urls: string[] = [];
  const protectedValue = value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return candidate;
      const marker = `\u{e000}${urls.length}\u{e001}`;
      urls.push(candidate);
      return marker;
    } catch { return candidate; }
  });
  return protectedValue
    // Quoted paths may contain spaces; consume through the matching quote before token rules run.
    .replace(/(["'])(?:file:(?:\/\/)?|[A-Za-z]:[\\/]|\\\\|\/\/|\/(?!\/))[^"'\r\n]*\1/gi, "$1<path>$1")
    .replace(/\bfile:(?:\/\/)?(?:[A-Za-z]:)?[\\/]+[^\s"'<>]*/gi, "<path>")
    .replace(/(^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/])[^\s"'<>]*/g, "$1<path>")
    .replace(/(^|[^A-Za-z0-9:])(?:\\\\|\/\/)[^\s"'<>]*/g, "$1<path>")
    .replace(/(^|[^A-Za-z0-9/])\/(?![\/\s])[^\s"'<>]*/g, "$1<path>")
    .replace(/\u{e000}(\d+)\u{e001}/gu, (_marker, index: string) => urls[Number(index)] ?? "");
}

function summary(raw: unknown): HermesSessionSummary | undefined {
  const row = record(raw);
  if (!row) return undefined;
  const sessionId = id(row["id"] ?? row["session_id"]);
  if (!sessionId) return undefined;
  const lineageId = id(row["lineage_root"] ?? row["_lineage_root_id"]) ?? sessionId;
  const title = projectHermesSessionText(row["title"], HERMES_SESSION_TITLE_MAX_LENGTH);
  return {
    hermesSessionId: sessionId,
    hermesLineageId: lineageId,
    ...(title ? { title } : {}),
    startedAt: time(row, ["started_at", "session_started", "created_at"]),
    lastActiveAt: time(row, ["last_active", "last_active_at", "started_at", "session_started"]),
    messageCount: count(row["message_count"]),
    archived: row["archived"] === true || row["archived"] === 1,
    pinned: row["pinned"] === true || row["pinned"] === 1,
  };
}

/** Accept only ordinary text content parts. Tool calls/results, images, reasoning and every
 * unknown structured part contribute nothing even when they carry a tempting `content` string. */
function approvedContentText(content: unknown): string {
  const parts: string[] = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") { parts.push(part); continue; }
      const item = record(part);
      if (!item) continue;
      const kind = typeof item["type"] === "string" ? item["type"].trim().toLowerCase() : undefined;
      if (kind !== undefined && kind !== "text" && kind !== "input_text" && kind !== "output_text")
        continue;
      const text = item["text"] ?? (kind === undefined ? undefined : item["content"]);
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("").trim();
}

function approvedMessageText(row: Record<string, unknown>): string {
  // Hermes pins this display-only projection on compaction carriers. Presence is authoritative:
  // malformed/empty display content drops the row instead of falling back to model-only content.
  if (HAS_OWN.call(row, "display_content")) return approvedContentText(row["display_content"]);
  const content = approvedContentText(row["content"]);
  return content || (typeof row["text"] === "string" ? row["text"].trim() : "");
}

function message(raw: unknown): HermesSessionMessage | undefined {
  const row = record(raw);
  if (!row) return undefined;
  if (typeof row["display_kind"] === "string"
    && row["display_kind"].trim().toLowerCase() === "hidden") return undefined;
  const role = typeof row["role"] === "string" ? row["role"].trim().toLowerCase() : "";
  if (role !== "user" && role !== "assistant") return undefined;
  const text = projectHermesSessionText(approvedMessageText(row));
  if (!text) return undefined;
  const rawMessageId = row["id"] ?? row["row_id"] ?? row["message_id"];
  const messageId = rawMessageId === undefined ? undefined : String(rawMessageId);
  const createdAt = time(row, ["timestamp", "created_at", "created", "at", "ts", "time"]);
  return {
    role,
    text,
    ...(messageId && messageId.length <= 128 ? { hermesMessageId: messageId } : {}),
    ...(createdAt > 0 ? { createdAt } : {}),
  };
}

function messageEnvelope(raw: unknown, sessionId: string): unknown[] {
  const response = record(raw);
  if (!response || !Array.isArray(response["messages"]) || id(response["session_id"]) !== sessionId)
    throw new HermesSessionUnavailable("Hermes returned invalid session data");
  return response["messages"];
}

function profileQuery(scope: string): string {
  return `profile=${encodeURIComponent(scope)}`;
}

function timeout(error: unknown): boolean {
  return error instanceof HermesTimeout
    || (error instanceof HermesRpcError && (error.code === 408 || error.code === 504))
    || (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"))
    || (error instanceof Error && /timed?\s*out/i.test(error.message));
}

function status(error: unknown): number | undefined {
  return error instanceof HermesRpcError ? error.code : undefined;
}

function openApiOperation(
  document: Record<string, unknown>, path: string, method: string,
): Record<string, unknown> | undefined {
  return record(record(record(document["paths"])?.[path])?.[method]);
}

function hasQueryParameters(operation: Record<string, unknown>, required: readonly string[]): boolean {
  const parameters = operation["parameters"];
  if (!Array.isArray(parameters)) return false;
  const names = new Set(parameters.flatMap((parameter) => {
    const item = record(parameter);
    return item?.["in"] === "query" && typeof item["name"] === "string" ? [item["name"]] : [];
  }));
  return required.every((name) => names.has(name));
}

function hasPatchShape(document: Record<string, unknown>, operation: Record<string, unknown>): boolean {
  const schema = record(record(record(operation["requestBody"])?.["content"])?.["application/json"]);
  const reference = record(schema?.["schema"])?.["$ref"];
  if (typeof reference !== "string") return false;
  const schemaName = reference.split("/").at(-1);
  if (!schemaName) return false;
  const components = record(record(document["components"])?.["schemas"]);
  const properties = record(record(components?.[schemaName])?.["properties"]);
  return properties !== undefined
    && ["title", "archived", "pinned", "profile"].every((field) => field in properties);
}

async function readJsonBody(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new HermesSessionTooLarge("Hermes session response exceeded its size cap");
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HermesSessionTooLarge("Hermes session response exceeded its size cap");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HermesSessionUnavailable("Hermes returned invalid session data");
  }
}

async function dashboardJson(
  client: HermesClient,
  path: string,
  init: { method?: "GET" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  const response = await client.dashboardResponse(path, {
    ...(init.method === undefined ? {} : { method: init.method }),
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HermesRpcError("Hermes session request failed", response.status);
  }
  return readJsonBody(response, SESSION_JSON_MAX_BYTES);
}

function mapReadError(error: unknown): never {
  if (error instanceof HermesSessionInvalid || error instanceof HermesSessionNotFound
    || error instanceof HermesSessionTooLarge || error instanceof HermesSessionUnavailable) throw error;
  if (status(error) === 404) throw new HermesSessionNotFound("Hermes session was not found");
  if (status(error) === 400 || status(error) === 422)
    throw new HermesSessionInvalid("Hermes session request was invalid");
  if (timeout(error)) throw new HermesSessionUnavailable("Hermes session upstream timed out");
  throw new HermesSessionUnavailable("Hermes session upstream is unavailable");
}

export interface HermesSessionExportStream {
  body: ReadableStream<Uint8Array>;
  filename: string;
}

export class HermesSessionManagementAdapter {
  readonly #client: HermesClient;
  readonly #harness: GatewayHarness;
  readonly #exactDetail: boolean;
  readonly #exportMaxBytes: number;
  readonly #exportMaxMessages: number;
  readonly #writeTails = new Map<string, Promise<void>>();

  constructor(
    client: HermesClient,
    harness: GatewayHarness,
    opts: { exportMaxBytes?: number; exportMaxMessages?: number; exactDetail?: boolean } = {},
  ) {
    this.#client = client;
    this.#harness = harness;
    this.#exactDetail = opts.exactDetail ?? true;
    this.#exportMaxBytes = opts.exportMaxBytes ?? HERMES_SESSION_EXPORT_MAX_BYTES;
    this.#exportMaxMessages = opts.exportMaxMessages ?? HERMES_SESSION_EXPORT_MAX_MESSAGES;
  }

  descriptor(): GatewayHarness { return this.#harness; }
  capabilityVersion(): 1 | 2 { return this.#exactDetail ? 2 : 1; }

  #scope(scopeId: string): string {
    if (!this.#harness.scopes.some((scope) => scope.id === scopeId))
      throw new HermesSessionNotFound("Hermes harness or profile was not found");
    return scopeId;
  }

  async #detail(scope: string, sessionId: string, signal?: AbortSignal): Promise<HermesSessionSummary> {
    if (!this.#exactDetail)
      throw new HermesSessionUnavailable("Hermes exact session detail is unavailable");
    try {
      const raw = record(await dashboardJson(
        this.#client,
        `/api/sessions/${encodeURIComponent(sessionId)}?${profileQuery(scope)}`,
        { signal },
      ));
      const projected = summary(raw);
      // A successful response is never evidence of absence. It must correlate both identifiers;
      // otherwise an older or malicious Dashboard may have ignored the profile selector.
      if (!raw || raw["profile"] !== scope || !projected
        || projected.hermesSessionId !== sessionId)
        throw new HermesSessionUnavailable("Hermes returned uncorrelated session detail");
      return projected;
    } catch (error) { return mapReadError(error); }
  }

  async detail(scopeId: string, sessionId: string, signal?: AbortSignal): Promise<HermesSessionDetailResponse> {
    return { session: await this.#detail(this.#scope(scopeId), sessionId, signal) };
  }

  async list(
    scopeId: string,
    input: { limit: number; offset: number; archived: "exclude" | "include" | "only" },
    signal?: AbortSignal,
  ): Promise<HermesSessionListResponse> {
    const scope = this.#scope(scopeId);
    try {
      const raw = record(await dashboardJson(
        this.#client,
        `/api/sessions?limit=${input.limit}&offset=${input.offset}`
          + `&archived=${input.archived}&order=recent&${profileQuery(scope)}`,
        { signal },
      ));
      if (!raw || !Array.isArray(raw["sessions"]))
        throw new HermesSessionUnavailable("Hermes returned invalid session data");
      const sessions = raw["sessions"].flatMap((row) => {
        const projected = summary(row);
        return projected ? [projected] : [];
      }).slice(0, input.limit);
      return {
        sessions,
        pagination: {
          limit: input.limit,
          offset: input.offset,
          returned: sessions.length,
          total: count(raw["total"]),
        },
      };
    } catch (error) { return mapReadError(error); }
  }

  async search(scopeId: string, query: string, limit: number, signal?: AbortSignal): Promise<HermesSessionSearchResponse> {
    const scope = this.#scope(scopeId);
    try {
      const raw = record(await dashboardJson(
        this.#client,
        `/api/sessions/search?q=${encodeURIComponent(query)}&limit=${limit}&${profileQuery(scope)}`,
        { signal },
      ));
      if (!raw || !Array.isArray(raw["results"]))
        throw new HermesSessionUnavailable("Hermes returned invalid session data");
      const results: HermesSessionSearchResponse["results"] = [];
      for (const row of raw["results"]) {
        const item = record(row);
        const base = summary(row);
        if (!item || !base) continue;
        const rawRole = typeof item["role"] === "string" ? item["role"].trim().toLowerCase() : undefined;
        if (rawRole !== undefined && rawRole !== "user" && rawRole !== "assistant") continue;
        let authoritative: HermesSessionSummary;
        try {
          authoritative = await this.#detail(scope, base.hermesSessionId, signal);
        } catch (error) {
          if (error instanceof HermesSessionNotFound) continue;
          throw error;
        }
        // Hermes FTS also indexes tool_name/tool_calls and does not identify which indexed column
        // produced `snippet`. Never forward that ambiguous string: an assistant-role hit can still
        // be a hidden tool argument. The title + role is enough to navigate to projected messages.
        const snippet = rawRole === undefined
          ? "Session ID match"
          : `Matching ${rawRole} message`;
        results.push({
          ...authoritative,
          hermesLineageId: base.hermesLineageId,
          snippet,
          ...(rawRole === undefined ? {} : { matchedRole: rawRole as "user" | "assistant" }),
        });
        if (results.length === limit) break;
      }
      return { results };
    } catch (error) { return mapReadError(error); }
  }

  async messages(
    scopeId: string,
    sessionId: string,
    input: { limit: number; offset: number; order: "oldest" | "latest" },
    signal?: AbortSignal,
  ): Promise<HermesSessionMessagesResponse> {
    const scope = this.#scope(scopeId);
    await this.#detail(scope, sessionId, signal);
    try {
      const raw = await dashboardJson(
        this.#client,
        `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${input.limit}`
          + `&offset=${input.offset}&order=${input.order}&include_compacted=true&${profileQuery(scope)}`,
        { signal },
      );
      const physical = messageEnvelope(raw, sessionId);
      if (physical.length > input.limit || physical.length > HERMES_SESSION_MESSAGES_MAX)
        throw new HermesSessionUnavailable("Hermes returned an oversized session page");
      const messages = physical.flatMap((row) => {
        const projected = message(row);
        return projected ? [projected] : [];
      });
      const physicalReturned = physical.length;
      return {
        hermesSessionId: sessionId,
        messages,
        pagination: {
          limit: input.limit,
          offset: input.offset,
          order: input.order,
          returned: messages.length,
          nextOffset: physicalReturned < input.limit
            || input.offset + physicalReturned > HERMES_SESSION_OFFSET_MAX
            ? null : input.offset + physicalReturned,
        },
      };
    } catch (error) { return mapReadError(error); }
  }

  patch(scopeId: string, sessionId: string, patch: HermesSessionPatch): Promise<HermesSessionMutationResponse> {
    const scope = this.#scope(scopeId);
    return this.#serialize(scope, async () => {
      await this.#detail(scope, sessionId);
      try {
        await dashboardJson(this.#client, `/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          body: { ...patch, profile: scope },
        });
        const current = await this.#detail(scope, sessionId);
        if ((patch.archived !== undefined && current.archived !== patch.archived)
          || (patch.pinned !== undefined && current.pinned !== patch.pinned))
          throw new HermesSessionUnavailable("Hermes did not confirm the session update");
        return { status: "updated", session: current };
      } catch (error) {
        if (timeout(error)) throw new HermesSessionMutationAmbiguous("Hermes session update may have completed");
        if (status(error) === 404) throw new HermesSessionNotFound("Hermes session was not found");
        if (status(error) === 400 || status(error) === 422)
          throw new HermesSessionInvalid("Hermes refused the session update");
        return mapReadError(error);
      }
    });
  }

  delete(scopeId: string, sessionId: string): Promise<void> {
    const scope = this.#scope(scopeId);
    return this.#serialize(scope, async () => {
      try {
        await this.#detail(scope, sessionId);
      } catch (error) {
        if (error instanceof HermesSessionNotFound) return;
        throw error;
      }
      try {
        await dashboardJson(
          this.#client,
          `/api/sessions/${encodeURIComponent(sessionId)}?${profileQuery(scope)}`,
          { method: "DELETE" },
        );
        try {
          await this.#detail(scope, sessionId);
        } catch (error) {
          if (error instanceof HermesSessionNotFound) return;
          throw error;
        }
        throw new HermesSessionUnavailable("Hermes did not confirm the session deletion");
      } catch (error) {
        // Current Hermes DELETE is idempotent; preserve that promise against older upstreams too.
        if (status(error) === 404) return;
        if (timeout(error)) throw new HermesSessionMutationAmbiguous("Hermes session deletion may have completed");
        return mapReadError(error);
      }
    });
  }

  async export(scopeId: string, sessionId: string, requestSignal: AbortSignal): Promise<HermesSessionExportStream> {
    const scope = this.#scope(scopeId);
    const projectedSession = await this.#detail(scope, sessionId, requestSignal);
    const abort = new AbortController();
    const onAbort = () => abort.abort(requestSignal.reason);
    requestSignal.addEventListener("abort", onAbort, { once: true });
    if (requestSignal.aborted) onAbort();
    const encoder = new TextEncoder();
    const prefix = encoder.encode(`{"session":${JSON.stringify(projectedSession)},"messages":[`);
    let offset = 0;
    let delivered = 0;
    let first = true;
    let finished = false;
    let current: HermesSessionMessage[] = [];
    const client = this.#client;
    const exportMaxBytes = this.#exportMaxBytes;
    const exportMaxMessages = this.#exportMaxMessages;

    const close = () => {
      if (finished) return;
      finished = true;
      requestSignal.removeEventListener("abort", onAbort);
    };
    const account = (bytes: Uint8Array): Uint8Array => {
      delivered += bytes.byteLength;
      if (delivered > exportMaxBytes)
        throw new HermesSessionTooLarge("Hermes session export exceeded its size cap");
      return bytes;
    };
    const fetchPage = async (limit: number): Promise<unknown[]> => {
      const raw = await dashboardJson(
        client,
        `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`
          + `&offset=${offset}&order=oldest&include_compacted=true&${profileQuery(scope)}`,
        { signal: abort.signal },
      );
      const physical = messageEnvelope(raw, sessionId);
      if (physical.length > limit || physical.length > HERMES_SESSION_MESSAGES_MAX)
        throw new HermesSessionUnavailable("Hermes returned an oversized session page");
      return physical;
    };

    let upstreamDone = false;
    try {
      const remaining = exportMaxMessages - offset;
      const requestLimit = Math.min(EXPORT_PAGE_SIZE, remaining + 1);
      const physical = await fetchPage(requestLimit);
      if (physical.length > remaining)
        throw new HermesSessionTooLarge("Hermes session export exceeded its message cap");
      offset += physical.length;
      upstreamDone = physical.length < requestLimit;
      current = physical.flatMap((row) => {
        const projected = message(row);
        return projected ? [projected] : [];
      });
    } catch (error) {
      close();
      return mapReadError(error);
    }

    return {
      filename: `hermes-session-${sessionId.slice(0, 32).replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          try { controller.enqueue(account(prefix)); }
          catch (error) { close(); controller.error(error); }
        },
        async pull(controller) {
          try {
            while (current.length === 0 && !upstreamDone) {
              // Ask for one row beyond the remaining allowance when necessary. That proves an
              // exact-cap transcript is complete instead of rejecting every page-aligned export.
              const remaining = exportMaxMessages - offset;
              const requestLimit = Math.min(EXPORT_PAGE_SIZE, remaining + 1);
              const physical = await fetchPage(requestLimit);
              if (physical.length > remaining)
                throw new HermesSessionTooLarge("Hermes session export exceeded its message cap");
              offset += physical.length;
              upstreamDone = physical.length < requestLimit;
              current = physical.flatMap((row) => {
                const projected = message(row);
                return projected ? [projected] : [];
              });
            }
            if (current.length > 0) {
              const item = current.shift()!;
              const bytes = encoder.encode(`${first ? "" : ","}${JSON.stringify(item)}`);
              first = false;
              controller.enqueue(account(bytes));
              return;
            }
            controller.enqueue(account(encoder.encode("]}")));
            close();
            controller.close();
          } catch (error) {
            // Later pages are correlated before projection. Headers and prior correlated rows may
            // already be sent, so abort the stream; the mismatched page never enters it.
            abort.abort(error);
            close();
            controller.error(error instanceof HermesSessionTooLarge || error instanceof HermesSessionUnavailable
              ? error : new HermesSessionUnavailable("Hermes session export failed"));
          }
        },
        cancel(reason) {
          abort.abort(reason);
          close();
        },
      }),
    };
  }

  #serialize<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.#writeTails.get(scope) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    this.#writeTails.set(scope, result.then(() => undefined, () => undefined));
    return result;
  }
}

/** Pins the current Dashboard contract before exposing device routes. OpenAPI proves all
 * mutation/read route methods without changing state; bounded live reads prove the serving
 * profile and response envelopes. Older, unreachable, or shape-incompatible Hermes is omitted. */
export async function discoverHermesSessionManagement(
  client: HermesClient,
  harness: GatewayHarness,
): Promise<HermesSessionManagementAdapter | undefined> {
  const scope = harness.scopes[0]?.id;
  if (scope === undefined) return undefined;
  try {
    const document = record(await dashboardJson(client, "/openapi.json"));
    if (!document) return undefined;
    const list = openApiOperation(document, "/api/sessions", "get");
    const search = openApiOperation(document, "/api/sessions/search", "get");
    const detail = openApiOperation(document, "/api/sessions/{session_id}", "get");
    const patch = openApiOperation(document, "/api/sessions/{session_id}", "patch");
    const remove = openApiOperation(document, "/api/sessions/{session_id}", "delete");
    const messages = openApiOperation(document, "/api/sessions/{session_id}/messages", "get");
    if (!list || !search || !detail || !patch || !remove || !messages
      || !hasQueryParameters(list, ["limit", "offset", "archived", "order", "profile"])
      || !hasQueryParameters(search, ["q", "limit", "profile"])
      || !hasQueryParameters(messages, ["limit", "offset", "order", "include_compacted", "profile"])
      || !hasPatchShape(document, patch)) return undefined;
    const exactDetail = hasQueryParameters(detail, ["profile"]);

    const liveList = record(await dashboardJson(
      client,
      `/api/sessions?limit=1&offset=0&archived=include&order=recent&${profileQuery(scope)}`,
    ));
    const liveSearch = record(await dashboardJson(
      client,
      `/api/sessions/search?q=${encodeURIComponent("__cozygateway_route_probe__")}`
        + `&limit=1&${profileQuery(scope)}`,
    ));
    const liveSessions = liveList?.["sessions"];
    const liveResults = liveSearch?.["results"];
    if (!liveList || !Array.isArray(liveSessions) || liveSessions.length > 1
      || liveSessions.some((row) => summary(row) === undefined)
      || !Number.isSafeInteger(liveList["total"]) || Number(liveList["total"]) < 0
      || !liveSearch || !Array.isArray(liveResults) || liveResults.length > 1
      || liveResults.some((row) => summary(row) === undefined)) return undefined;
    return new HermesSessionManagementAdapter(client, harness, { exactDetail });
  } catch {
    return undefined;
  }
}

export class GatewayHermesSessionManagement {
  readonly #adapters: ReadonlyMap<string, HermesSessionManagementAdapter>;

  constructor(adapters: readonly HermesSessionManagementAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.descriptor().id, adapter]));
    if (this.#adapters.size !== adapters.length) throw new Error("duplicate session-management harness id");
  }

  get available(): boolean { return this.#adapters.size > 0; }
  get capabilityVersion(): 1 | 2 | undefined {
    if (!this.available) return undefined;
    return [...this.#adapters.values()].every((adapter) => adapter.capabilityVersion() === 2)
      ? 2 : 1;
  }

  adapter(harnessId: string): HermesSessionManagementAdapter {
    const adapter = this.#adapters.get(harnessId);
    if (!adapter) throw new HermesSessionNotFound("Hermes harness or profile was not found");
    return adapter;
  }
}

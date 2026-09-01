import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  type ErrorBody,
  type ErrorCode,
  BotChatPhotoFieldsSchema,
  BotCreateRequestSchema,
  BotChatAttachmentFieldsSchema,
  BotClarifyResolveRequestSchema,
  BotChatDisplayedRequestSchema,
  BotChatSendRequestSchema,
  BotFocusRequestSchema,
  BotGroupCreateRequestSchema,
  BotGroupSendRequestSchema,
  BotModelConfigPatchSchema,
  BotProfilePatchSchema,
  BotRoutineCreateRequestSchema,
  BotRoutinePatchSchema,
  BotMemoryWriteRequestSchema,
  BotMemoryDeleteRequestSchema,
  BotMemorySetupRequestSchema,
  ContractViolation,
  assertValid,
} from "cozygateway-contract";
import { MEMORY_KINDS, MemoryConflict, MemoryInvalidRequest, MemoryNotFound, createMemoryRateLimiter, type MemoryRateLimiter, type MemorySurface } from "./memory.ts";
import type { BotMemoryKind } from "cozygateway-contract";

import { BackendUnavailable, UnsupportedForRuntime } from "../errors.ts";
import { HermesRpcError, HermesTimeout, HermesUnavailable } from "./client.ts";
import { ModelConfigInvalid } from "./model-config.ts";
import {
  BotSessionConflict,
  BotSessionNotFound,
  type BotControlSurface,
  type BotsSurface,
} from "./bridge.ts";
import {
  BotNameInvalid,
  BotNameTaken,
  BotNotFound,
  BotTurnActive,
  PROFILE_ID_RE,
  normalizeProfileName,
} from "./crud.ts";
import { GroupExists, GroupInvalid, GroupNotFound } from "./group-rooms.ts";
import {
  MEDIA_CACHE_CONTROL,
  MEDIA_MAX_CONCURRENT,
  MediaBusy,
  MediaRefused,
  MediaTimedOut,
  MediaUpstreamFailed,
  type MediaFetch,
  type MediaLimiter,
  type MediaLookup,
  createMediaLimiter,
  fetchMedia,
  resolveMediaSource,
} from "./media.ts";
import {
  PHOTO_CACHE_CONTROL,
  PHOTO_DEFAULT_PROMPT,
  PHOTO_MAX_CONCURRENT,
  PHOTO_MAX_REQUEST_BYTES,
  PHOTO_QUEUE_WAIT_MS,
  PhotoAttachFailed,
  PhotoRefused,
  acceptPhoto,
  createPhotoRateLimiter,
  isFetchableAttachmentId,
  readCappedBody,
  redactHostPaths,
  type PhotoRateLimiter,
} from "./photos.ts";
import { FILE_MAX_BYTES, acceptFileBytes, attachmentDisposition, safeFilename } from "./documents.ts";
import {
  RoutineNotFound,
  RoutineRefused,
  RoutineUnconfirmed,
  patchNeedsRewrite,
} from "./routines.ts";

/** The `/bots` read path, vendor extension com.cozylabs.bots v1 (contract/ext-bots-v1.md). Same
 *  device-token auth as every other route; nothing here speaks a Hermes method name, that all
 *  lives behind `BotsSurface`.
 *
 *  Error shape: the ordinary `ErrorBody` plus a `hermesError` field carrying the gateway's own
 *  text VERBATIM. Client feature probes match `/unknown method/i` against it, so it is never
 *  reworded, and `error.message` stays a stable, human-readable summary. */

type Env = { Variables: { deviceId: string } };

/** How many sessions `GET /bots/:name/sessions` asks Hermes for. Matches the design's cap. */
export const SESSION_LIST_LIMIT = 200;

/** Longest skill-search query `GET /bots/catalog` accepts. The query is forwarded to a hub search
 *  upstream, and the answer is cached per query, so an unbounded one is both a pointless round trip
 *  and an unbounded query string. The NUMBER of cache entries is bounded separately, in the bridge
 *  (`CATALOG_CACHE_MAX`): a length cap bounds the key, never the key space. */
export const CATALOG_QUERY_MAX = 200;
export const ATTACHMENT_HISTORY_QUERY_MAX = 200;
export const ATTACHMENT_HISTORY_LIMIT_MAX = 100;
export const PENDING_APPROVALS_LIMIT = 100;

/** Hermes' JSON-RPC code for "no profile by that name". Mapped to a 404 rather than the blanket 502
 *  every other rejection gets, so the TOCTOU window between a roster-cache hit and the call behind
 *  it answers what the route promises instead of reading as a backend failure. */
export const HERMES_PROFILE_NOT_FOUND = 4064;

/** Local copy of http.ts's helper, duplicated rather than imported so this module does not close
 *  an import cycle back into the app it is registered on. */
function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/** Error codes this extension adds to the frozen core list (`contract/v1.md` section 4 keeps
 *  `error.code` a plain string precisely so an extension can). A client that does not know them
 *  treats them as a generic failure, which the HTTP status already conveys. */
function extensionErrorBody(
  code: "conflict" | "media_refused" | "rate_limited" | "unsupported_for_runtime",
  message: string,
): ErrorBody {
  return { error: { code, message } };
}

/** Longest `src` `GET /bots/:name/media` accepts. A URL in a bot's reply is an ordinary URL; the cap
 *  exists so an unbounded query string cannot be pushed through the route, and it is checked before
 *  anything is parsed. */
export const MEDIA_SRC_MAX = 2048;

export type ByteRange = { start: number; end: number };

/** Resolves one RFC 9110 byte range. Multi-range bodies are deliberately unsupported: AVPlayer
 *  asks for one range at a time, and multipart/byteranges would add parser surface with no product
 *  value. `undefined` means no Range header; `null` means 416. */
export function resolveByteRange(
  header: string | undefined,
  size: number,
): ByteRange | null | undefined {
  if (header === undefined) return undefined;
  if (!header.startsWith("bytes=") || header.includes(",") || size <= 0)
    return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** The ONE canonicalization every `/bots/:name` route applies to its path parameter, so a bot has
 *  exactly one identity no matter what casing or padding a client used in the URL.
 *
 *  Normalizing at the boundary, not in each handler, makes every route address the same profile
 *  identity regardless of casing or surrounding whitespace.
 *
 *  Returns the canonical name, or a 400 response for a name that cannot name a profile at all. */
function canonicalName(
  c: Context<Env>,
): { name: string } | { response: Response } {
  try {
    return { name: normalizeProfileName(c.req.param("name") ?? "") };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "invalid bot name";
    return { response: c.json(errorBody("invalid_request", detail), 400) };
  }
}

/** `canonicalName` plus the profile-name CHARSET rule, for the routes where the name is not merely
 *  an identity but a value that ends up inside a string other code parses.
 *
 *  A routine belongs to a bot through one convention and one only: its cron job is named
 *  `[bot:<name>] <title>`, and `BOT_TAG_RE` reads the bot back out of that with `[a-z0-9][a-z0-9_-]*`.
 *  A profile named `a]b` therefore writes `[bot:a]b] Title`, which parses as bot `a`. That is a
 *  namespace escape in both directions: bot `a` sees and can DELETE the other bot's routines, and
 *  `a]b`'s own routines are orphaned the moment they are created. The check runs before any Hermes
 *  call, so the escape is unreachable rather than merely unlikely.
 *
 *  The RESERVED-name half of `assertProfileNameRule` is deliberately not applied: `default` is a real,
 *  addressable profile that is always on the roster, and refusing to list its routines would break a
 *  bot rather than protect one. What makes the tag safe is the charset. */
function routineBotName(
  c: Context<Env>,
): { name: string } | { response: Response } {
  const resolved = canonicalName(c);
  if ("response" in resolved) return resolved;
  if (!PROFILE_ID_RE.test(resolved.name)) {
    return {
      response: c.json(
        errorBody(
          "invalid_request",
          `invalid bot name "${resolved.name}": it must match [a-z0-9][a-z0-9_-]{0,63} (lowercase letters, digits, - and _)`,
        ),
        400,
      ),
    };
  }
  return { name: resolved.name };
}

function failure(c: Context<Env>, err: unknown) {
  // Checked first: a name that names no Hermes profile is a 404, not a backend failure, on every
  // configured `/bots/:name/*` route.
  if (err instanceof BotNotFound)
    return c.json(errorBody("not_found", err.message), 404);
  if (err instanceof BotSessionNotFound)
    return c.json(errorBody("not_found", err.message), 404);
  if (err instanceof ModelConfigInvalid)
    return c.json(errorBody("invalid_request", err.message), 400);
  // The bot is real and its chat lane works; this surface simply has no backend for its runtime.
  // A 404 would say the bot does not exist, which is a lie a client would act on.
  if (err instanceof UnsupportedForRuntime)
    return c.json(
      { ...extensionErrorBody("unsupported_for_runtime", err.message), runtime: err.runtime, feature: err.feature },
      409,
    );
  if (err instanceof BotSessionConflict) {
    return c.json(extensionErrorBody("conflict", err.message), 409);
  }
  if (err instanceof BackendUnavailable)
    return c.json(errorBody("backend_unavailable", err.message), 503);
  // A routine id that names nothing in this bot's namespace is not found, not forbidden: this API
  // does not confirm jobs outside the bot that was asked about.
  if (err instanceof RoutineNotFound)
    return c.json(errorBody("not_found", err.message), 404);
  // A create the backend accepted whose stored row could not be read back. A 502 rather than a 201,
  // because there is no routine to put in a 201 body: the alternative is echoing the request, and
  // the request is not what the backend stores. `createdId` rides along when the `add` reported one,
  // so a client can list and find out whether the routine is really there.
  if (err instanceof RoutineUnconfirmed) {
    return c.json(
      {
        ...errorBody(
          "backend_unavailable",
          "hermes accepted the routine but its stored schedule could not be read back",
        ),
        hermesError: err.message,
        ...(err.createdId === undefined ? {} : { createdId: err.createdId }),
      },
      502,
    );
  }
  // A cron call the backend ANSWERED with a refusal: it arrives as a successful RPC result carrying
  // `success: false`, so nothing about the transport went wrong and the answer has to say what
  // actually did. That depends on the ACTION, not on the shape:
  //
  // - `add` carries a schedule, a title and an instruction the client composed. A refusal there is
  //   the client's input, and a 502 would tell a user to check their gateway when they should be
  //   checking what they typed.
  // - `list` carries no client input at all, and `pause`/`resume`/`remove` carry only a job id this
  //   gateway already resolved inside the bot's namespace. A refusal on one of those is the backend
  //   failing to do its job, and reporting it as `invalid_request` put "check what you typed" over a
  //   GET with no body: an older or scoping-hostile Hermes made the whole routines pane read as
  //   user error.
  //
  // The backend's text rides along verbatim in `hermesError` either way, because it is the only
  // description of what was actually wrong.
  if (err instanceof RoutineRefused) {
    return err.clientInput
      ? c.json(
          {
            ...errorBody(
              "invalid_request",
              `hermes refused the cron ${err.action}`,
            ),
            hermesError: err.message,
          },
          400,
        )
      : c.json(
          {
            ...errorBody(
              "backend_unavailable",
              `hermes refused the cron ${err.action}`,
            ),
            hermesError: err.message,
          },
          502,
        );
  }
  // Same news, said by Hermes instead of by the pre-check: a bot deleted between a roster-cache hit
  // and the call that followed it is the narrow window `#assertBotKnown` cannot close, and a 502
  // there contradicts what every one of these routes promises about a name that names no profile.
  if (err instanceof HermesRpcError && err.code === HERMES_PROFILE_NOT_FOUND) {
    return c.json(errorBody("not_found", err.message), 404);
  }
  if (err instanceof HermesRpcError) {
    return c.json(
      {
        ...errorBody(
          "backend_unavailable",
          "the hermes gateway rejected the request",
        ),
        hermesError: err.message,
        ...(err.code === undefined ? {} : { hermesErrorCode: err.code }),
      },
      502,
    );
  }
  // Checked BEFORE HermesUnavailable, which it subclasses. A call that went out and did not answer
  // in time is not "the bridge is not connected": the operation may still be running, and telling
  // a client nothing reached Hermes is factually wrong and invites a duplicate retry.
  if (err instanceof HermesTimeout) {
    return c.json(
      {
        ...errorBody(
          "backend_unavailable",
          "the hermes gateway did not answer in time; the operation may still be running",
        ),
        hermesError: err.message,
        timedOut: true,
      },
      504,
    );
  }
  if (err instanceof HermesUnavailable) {
    return c.json(
      {
        ...errorBody(
          "backend_unavailable",
          "the hermes bridge is not connected",
        ),
        hermesError: err.message,
      },
      503,
    );
  }
  throw err;
}

export function registerBotRoutes(
  app: Hono<Env>,
  requireDevice: MiddlewareHandler<Env>,
  bots: BotControlSurface | BotsSurface,
  mediaOptions: {
    fetchImpl?: MediaFetch;
    timeoutMs?: number;
    lookup?: MediaLookup;
    limiter?: MediaLimiter;
    queueWaitMs?: number;
  } = {},
  photoOptions: {
    /** Bounded in-flight photo sends, per gateway. Defaults to a fresh limiter at
     *  `PHOTO_MAX_CONCURRENT`; injected so a test can cap at one and watch the cap hold. */
    limiter?: MediaLimiter;
    queueWaitMs?: number;
    /** Per-device token bucket. Injected for the same reason. */
    rateLimiter?: PhotoRateLimiter;
    now?: () => number;
  } = {},
  memory?: MemorySurface,
  memoryOptions: {
    /** Per-device token bucket for the memory lane. Injected so a test can cap at one. */
    rateLimiter?: MemoryRateLimiter;
    now?: () => number;
  } = {},
): void {
  const chat = bots as BotsSurface;
  // One limiter per registered app, created here rather than at module scope so two gateways in one
  // process (which is what the test suite is) do not share a bound.
  const photoLimiter =
    photoOptions.limiter ?? createMediaLimiter(PHOTO_MAX_CONCURRENT);
  const photoRate = photoOptions.rateLimiter ?? createPhotoRateLimiter();
  const photoNow = photoOptions.now ?? (() => Date.now());
  const memoryRate = memoryOptions.rateLimiter ?? createMemoryRateLimiter();
  const memoryNow = memoryOptions.now ?? (() => Date.now());
  /** Spends this device's memory budget, answering `429` when it is empty. Every
   *  memory route pays, reads included: the cost being bounded is the attached
   *  plugin's single-in-flight scan, which a read occupies exactly as a write does. */
  const memoryTicket = (c: Context<Env>) => {
    const ticket = memoryRate.take(c.get("deviceId"), memoryNow());
    if (ticket.ok) return undefined;
    const seconds = Math.max(1, Math.ceil(ticket.retryAfterMs / 1000));
    return c.json(
      { ...extensionErrorBody("rate_limited", "this device has made too many memory requests; wait and try again"), retryAfterMs: ticket.retryAfterMs },
      429,
      { "retry-after": String(seconds) },
    );
  };
  const memoryFailure = (c: Context<Env>, error: unknown) => {
    if (error instanceof MemoryConflict)
      return c.json({ ...extensionErrorBody("conflict", error.message), ...(error.current === undefined ? {} : { current: error.current }) }, 409);
    if (error instanceof MemoryNotFound) return c.json(errorBody("not_found", error.message || "memory item not found"), 404);
    if (error instanceof MemoryInvalidRequest || error instanceof ContractViolation)
      return c.json(errorBody("invalid_request", error.message), 400);
    return failure(c, error);
  };
  const memoryQuery = (c: Context<Env>, maximumLimit = 100) => {
    const limitText = c.req.query("limit");
    const parsed = limitText === undefined ? undefined : Number(limitText);
    if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximumLimit)) throw new MemoryInvalidRequest(`limit must be an integer between 1 and ${maximumLimit}`);
    const timestamp = (name: "since" | "until") => {
      const text = c.req.query(name); if (text === undefined) return undefined;
      const value = Number(text); if (!Number.isSafeInteger(value) || value < 0) throw new MemoryInvalidRequest(`${name} must be a non-negative millisecond timestamp`);
      return value;
    };
    const since = timestamp("since"); const until = timestamp("until");
    const q = c.req.query("q"); const sourceId = c.req.query("source"); const kind = c.req.query("kind");
    if ((q !== undefined && q.length > 512) || (sourceId !== undefined && sourceId.length > 120)) throw new MemoryInvalidRequest("memory query is too long");
    if (kind !== undefined && !MEMORY_KINDS.includes(kind as BotMemoryKind)) throw new MemoryInvalidRequest("unknown memory kind");
    return { ...(q === undefined ? {} : { q }), ...(sourceId === undefined ? {} : { sourceId }), ...(kind === undefined ? {} : { kind: kind as BotMemoryKind }), ...(parsed === undefined ? {} : { limit: parsed }), ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) };
  };
  // Cache-first: the snapshot answers immediately, even on a cold link, and a refresh runs in the
  // background so the next read (or the /ws bot_roster frame) carries fresh state.
  app.get("/bots", requireDevice, (c) => {
    const view = bots.roster();
    bots.refreshSoon("GET /bots");
    return c.json({
      bots: view.bots,
      updatedAt: view.updatedAt,
      stale: view.stale,
    });
  });

  if (memory !== undefined) {
    app.patch("/bots/:name/memory/setup", requireDevice, async (c) => {
      const resolved = canonicalName(c); if ("response" in resolved) return resolved.response;
      const limited = memoryTicket(c); if (limited !== undefined) return limited;
      try {
        const body = assertValid(BotMemorySetupRequestSchema, await c.req.json());
        const result = await memory.setup(resolved.name, body);
        memory.auditSetup(c.get("deviceId"), resolved.name, body);
        return c.json(result);
      } catch (error) { return memoryFailure(c, error); }
    });
    app.get("/bots/:name/memory", requireDevice, async (c) => {
      const resolved = canonicalName(c); if ("response" in resolved) return resolved.response;
      const limited = memoryTicket(c); if (limited !== undefined) return limited;
      try { return c.json(await memory.overview(resolved.name)); } catch (error) { return memoryFailure(c, error); }
    });
    app.get("/bots/:name/memory/items", requireDevice, async (c) => {
      const resolved = canonicalName(c); if ("response" in resolved) return resolved.response;
      const limited = memoryTicket(c); if (limited !== undefined) return limited;
      try { return c.json(await memory.items(resolved.name, memoryQuery(c))); } catch (error) { return memoryFailure(c, error); }
    });
    app.get("/bots/:name/memory/graph", requireDevice, async (c) => {
      const resolved = canonicalName(c); if ("response" in resolved) return resolved.response;
      const limited = memoryTicket(c); if (limited !== undefined) return limited;
      try { return c.json(await memory.graph(resolved.name, memoryQuery(c, 200))); } catch (error) { return memoryFailure(c, error); }
    });
    app.get("/bots/:name/memory/sources/:source/items/:id", requireDevice, async (c) => {
      const resolved = canonicalName(c); if ("response" in resolved) return resolved.response;
      const limited = memoryTicket(c); if (limited !== undefined) return limited;
      try { return c.json(await memory.item(resolved.name, c.req.param("source"), c.req.param("id"))); } catch (error) { return memoryFailure(c, error); }
    });
    app.post("/bots/:name/memory/sources/:source/items", requireDevice, async (c) => {
      const resolved = canonicalName(c); if ("response" in resolved) return resolved.response;
      const limited = memoryTicket(c); if (limited !== undefined) return limited;
      try { const source = c.req.param("source"); const body = assertValid(BotMemoryWriteRequestSchema, await c.req.json()); const result = await memory.create(resolved.name, source, body); memory.audit(c.get("deviceId"), resolved.name, "create", source, result.item.id); return c.json(result, 201); } catch (error) { return memoryFailure(c, error); }
    });
    app.patch("/bots/:name/memory/sources/:source/items/:id", requireDevice, async (c) => {
      const resolved = canonicalName(c); if ("response" in resolved) return resolved.response;
      const limited = memoryTicket(c); if (limited !== undefined) return limited;
      try { const source = c.req.param("source"); const id = c.req.param("id"); const body = assertValid(BotMemoryWriteRequestSchema, await c.req.json()); if (body.expectedRevision === undefined) throw new MemoryInvalidRequest("expectedRevision is required"); const result = await memory.update(resolved.name, source, id, body); memory.audit(c.get("deviceId"), resolved.name, "update", source, result.item.id); return c.json(result); } catch (error) { return memoryFailure(c, error); }
    });
    app.delete("/bots/:name/memory/sources/:source/items/:id", requireDevice, async (c) => {
      const resolved = canonicalName(c); if ("response" in resolved) return resolved.response;
      const limited = memoryTicket(c); if (limited !== undefined) return limited;
      try { const source = c.req.param("source"); const id = c.req.param("id"); const body = assertValid(BotMemoryDeleteRequestSchema, await c.req.json()); const result = await memory.remove(resolved.name, source, id, body); memory.audit(c.get("deviceId"), resolved.name, "delete", source, id); return c.json(result); } catch (error) { return memoryFailure(c, error); }
    });
  }

  app.post("/bots", requireDevice, async (c) => {
    let input;
    try {
      input = assertValid(BotCreateRequestSchema, await c.req.json());
      return c.json(await bots.createBot(input), 201);
    } catch (error) {
      if (error instanceof ContractViolation || error instanceof BotNameInvalid)
        return c.json(errorBody("invalid_request", error.message), 400);
      if (error instanceof BotNameTaken)
        return c.json(extensionErrorBody("conflict", error.message), 409);
      return failure(c, error);
    }
  });

  // Capability 37, the inverse of POST /bots. `?force=1` overrides only the running-turn
  // refusal; everything else about the delete is unconditional. The 409 carries `turnId` so a
  // client can name the work it is about to kill in its confirmation copy. The 200 body reports
  // what was removed and what remains for the operator sweep; a bot neither Hermes nor this
  // gateway knows answers the ordinary not-found shape.
  app.delete("/bots/:name", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const force = c.req.query("force") === "1";
    try {
      return c.json(await bots.deleteBot(resolved.name, { force }));
    } catch (error) {
      if (error instanceof BotNameInvalid)
        return c.json(errorBody("invalid_request", error.message), 400);
      if (error instanceof BotTurnActive)
        return c.json(
          { ...extensionErrorBody("conflict", error.message), turnId: error.turnId },
          409,
        );
      return failure(c, error);
    }
  });

  // Approval verbs for a bot chat (capability 10, issue #19 bridge lane). Two sibling routes
  // rather than one route with a decision in the body, mirroring the core
  // `POST /threads/:id/approvals/:toolCallId/approve` exactly: the verb IS the request, there is
  // no body, and a notification action button maps to a URL with nothing to encode. Only per-call
  // scope exists on the wire (approve == the native `once`), so there is nothing else to say.
  //
  // The path carries a bot and a correlation id and NOTHING else. `turnId` travels outward on the
  // frames and is never accepted inward, and the internal attach-v1 binding is never on this wire
  // in either direction: the gateway derives the session, the turn and the pending state from its
  // own durable record, so a client cannot address an approval by any reference of its own. Same IDOR
  // posture as the core route, and the same status mapping.
  const botApprovalRoute =
    (decision: "approve" | "deny") =>
    async (c: Context<Env>): Promise<Response> => {
      const resolved = canonicalName(c);
      if ("response" in resolved) return resolved.response;
      const outcome = await chat.resolveApproval(
        resolved.name,
        // Read through a generic Context (this handler is shared by two routes), so the param is
        // typed as possibly absent; the router only reaches here with it present.
        c.req.param("toolCallId") ?? "",
        decision,
        c.get("deviceId"),
      );
      switch (outcome) {
        case "requested":
          return c.json({ status: "requested" }, 202);
        case "resolution_pending":
          return c.json(
            errorBody(
              "approval_resolution_pending",
              "a different decision is already awaiting confirmation",
            ),
            409,
          );
        case "unknown":
          return c.json(
            errorBody("not_found", "no such pending approval"),
            404,
          );
        case "expired":
          return c.json(
            errorBody(
              "approval_expired",
              "the approval expired before it was resolved",
            ),
            409,
          );
        case "not_pending":
          return c.json(
            errorBody(
              "approval_not_pending",
              "the approval is no longer pending",
            ),
            409,
          );
        case "unsupported":
          // The link could not carry the decision, or this hermes has no `approval.respond`. The
          // approval is still pending and its own timer is still what will end it, so this is
          // honestly a backend problem rather than a decision that was refused.
          return c.json(
            errorBody(
              "backend_unavailable",
              "hermes could not resolve the approval",
            ),
            503,
          );
      }
    };

  app.post(
    "/bots/:name/approvals/:toolCallId/approve",
    requireDevice,
    botApprovalRoute("approve"),
  );
  app.post(
    "/bots/:name/approvals/:toolCallId/deny",
    requireDevice,
    botApprovalRoute("deny"),
  );

  // Capability 27/29. This is recovery state for push taps, offline action failures, and an
  // explicit "Needs your approval" screen. Terminal receipts remain separate from pending work:
  // a decision POST is only an outbox admission, never proof that Hermes handled it.
  app.get("/bots/approvals", requireDevice, (c) => {
    const state = c.req.query("state");
    if (state !== undefined && state !== "pending") {
      return c.json(errorBody("invalid_request", "approval state must be pending"), 400);
    }
    return c.json({
      approvals: [...chat.pendingApprovals()].slice(0, PENDING_APPROVALS_LIMIT),
      clarifications: [...(chat.pendingClarifications?.() ?? [])].slice(0, PENDING_APPROVALS_LIMIT),
      settlements: [...(chat.terminalSettlements?.() ?? [])],
    });
  });

  app.post(
    "/bots/:name/clarifications/:clarifyId",
    requireDevice,
    async (c) => {
      const resolved = canonicalName(c);
      if ("response" in resolved) return resolved.response;
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        body = undefined;
      }
      let parsed;
      try {
        parsed = assertValid(BotClarifyResolveRequestSchema, body);
      } catch (err) {
        return c.json(
          errorBody(
            "invalid_request",
            err instanceof Error ? err.message : "malformed body",
          ),
          400,
        );
      }
      const outcome = await chat.resolveClarify(
        resolved.name,
        c.req.param("clarifyId") ?? "",
        parsed.optionId,
        c.get("deviceId"),
      );
      switch (outcome) {
        case "requested":
          return c.json({ outcome: "requested" }, 202);
        case "resolution_pending":
          return c.json(
            errorBody(
              "approval_resolution_pending",
              "a different selection is already awaiting confirmation",
            ),
            409,
          );
        case "unknown":
          return c.json(
            errorBody("not_found", "no such pending clarification"),
            404,
          );
        case "expired":
          return c.json(
            errorBody(
              "approval_expired",
              "the clarification expired before it was resolved",
            ),
            409,
          );
        case "not_pending":
          return c.json(
            errorBody(
              "approval_not_pending",
              "the clarification is no longer pending",
            ),
            409,
          );
        case "invalid_option":
          return c.json(
            errorBody(
              "invalid_request",
              "the option does not belong to this clarification",
            ),
            400,
          );
        case "unsupported":
          return c.json(
            errorBody(
              "backend_unavailable",
              "hermes could not resolve the clarification",
            ),
            503,
          );
      }
    },
  );

  app.post("/bots/focus", requireDevice, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    let parsed;
    try {
      parsed = assertValid(BotFocusRequestSchema, body);
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    bots.setFocus(c.get("deviceId"), parsed.screen);
    return c.json({ ok: true });
  });

  // Nothing here is per-bot: it is the menu the edit screen offers for ALL bots, which is why it is
  // one cached aggregate rather than three calls a client makes per screen open. There is no
  // routing ambiguity to resolve either way: `/bots/catalog` is two segments and every per-bot
  // route is three or more, so a bot literally named `catalog` stays fully addressable at
  // `/bots/catalog/profile` while this route serves the menu.
  app.get("/bots/catalog", requireDevice, async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (query.length > CATALOG_QUERY_MAX) {
      return c.json(
        errorBody(
          "invalid_request",
          `q must be at most ${CATALOG_QUERY_MAX} characters`,
        ),
        400,
      );
    }
    try {
      return c.json(await bots.catalog(query));
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/bots/:name/profile", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    try {
      return c.json(await bots.botProfile(resolved.name));
    } catch (err) {
      return failure(c, err);
    }
  });

  // PATCH, not PUT: every field is optional and only the fields present are written, which is the
  // desktop's "send only the dirty sections" rule. A body with none of them is refused rather than
  // answered with an empty `applied` map, because a client that sends nothing has a bug and an
  // empty success would hide it.
  app.patch("/bots/:name/profile", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    let parsed;
    try {
      parsed = assertValid(BotProfilePatchSchema, body);
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    if (
      parsed.soul === undefined &&
      parsed.disabledSkills === undefined &&
      parsed.enabledToolsets === undefined &&
      parsed.enabledMcpServers === undefined
    ) {
      return c.json(
        errorBody(
          "invalid_request",
          "at least one of soul, disabledSkills, enabledToolsets, enabledMcpServers is required",
        ),
        400,
      );
    }
    try {
      const result = await bots.configureProfile(name, parsed);
      return c.json({
        name,
        outcome: result.outcome,
        ok: result.ok,
        applied: result.applied,
        requested: result.requested,
      });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/bots/:name/model-config", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    try {
      return c.json(await bots.modelConfig(resolved.name));
    } catch (err) {
      return failure(c, err);
    }
  });

  app.put("/bots/:name/model-config", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    let parsed;
    try {
      parsed = assertValid(BotModelConfigPatchSchema, body);
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    if (parsed.model === undefined && parsed.effort === undefined) {
      return c.json(
        errorBody(
          "invalid_request",
          "at least one of model or effort is required",
        ),
        400,
      );
    }
    try {
      return c.json(await bots.configureModel(resolved.name, parsed));
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/bots/:name/chat", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    try {
      const result = await chat.canonicalChat(name);
      return c.json({
        name,
        sessionId: result.sessionId,
        adoption: result.adoption,
      });
    } catch (err) {
      return failure(c, err);
    }
  });

  // Capability 40. Profile creation and attach readiness are different facts: the Mac-side
  // provisioner may still be wiring the bot after POST /bots has returned 201. This read has no
  // chat/session side effect, so a client can poll it while showing the creation handoff.
  app.get("/bots/:name/readiness", requireDevice, (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    try {
      return c.json(chat.readiness(resolved.name));
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/bots/:name/commands", requireDevice, (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    try {
      return c.json({
        name: resolved.name,
        commands: [...chat.commands(resolved.name)],
      });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/bots/attachments", requireDevice, (c) => {
    const rawQuery = (c.req.query("q") ?? "").trim();
    if (rawQuery.length > ATTACHMENT_HISTORY_QUERY_MAX) {
      return c.json(errorBody("invalid_request", "attachment search is too long"), 400);
    }
    const rawKind = c.req.query("kind");
    const kind = rawKind === undefined || rawKind === "all" ? undefined : rawKind;
    if (kind !== undefined && !["image", "video", "audio", "file"].includes(kind)) {
      return c.json(errorBody("invalid_request", "unknown attachment kind"), 400);
    }
    const rawOffset = c.req.query("offset") ?? "0";
    const rawLimit = c.req.query("limit") ?? "50";
    const rawSince = c.req.query("since");
    const offset = Number(rawOffset);
    const limit = Number(rawLimit);
    const since = rawSince === undefined ? undefined : Number(rawSince);
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > ATTACHMENT_HISTORY_LIMIT_MAX ||
        (since !== undefined && (!Number.isSafeInteger(since) || since < 0))) {
      return c.json(errorBody("invalid_request", "invalid attachment history pagination or date"), 400);
    }
    const requestedBot = c.req.query("bot")?.trim().toLowerCase();
    try {
      return c.json(chat.attachmentHistory({
        ...(rawQuery === "" ? {} : { query: rawQuery }),
        ...(kind === undefined ? {} : { kind: kind as "image" | "video" | "audio" | "file" }),
        ...(requestedBot ? { bot: requestedBot } : {}),
        ...(since === undefined ? {} : { since }),
        offset,
        limit,
      }));
    } catch (err) {
      return failure(c, err);
    }
  });

  // Full duplex over the canonical chat. Both routes resolve the chat themselves, so the app never
  // has to hold a session id: `name` is the only identifier in this API.
  app.get("/bots/:name/chat/messages", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    try {
      const history = await chat.chatHistory(name);
      return c.json({ name, ...history });
    } catch (err) {
      return failure(c, err);
    }
  });

  // 202, not 200: the gateway committed the native user row and queued an attach-v1 turn. The
  // reply lands later over `/ws` as `bot_chat` frames, so the app can render the returned row now.
  app.post("/bots/:name/chat/messages", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    let parsed;
    try {
      parsed = assertValid(BotChatSendRequestSchema, body);
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    try {
      const sent = await chat.sendChatMessage(name, parsed.text, {
        ...(parsed.clientId === undefined ? {} : { clientId: parsed.clientId }),
        deviceId: c.get("deviceId"),
      });
      return c.json(
        { name, sessionId: sent.sessionId, message: sent.message },
        202,
      );
    } catch (err) {
      return failure(c, err);
    }
  });

  // Capability 31. The device reporting what it actually PUT ON SCREEN, which is the only proof of
  // human delivery this system has: a durable transcript row proves the gateway holds a message and
  // a push proves nothing at all.
  //
  // 202, not 200: recording the receipt is synchronous, but what the report SETS IN MOTION (telling
  // the plugin that produced a scheduled delivery that a human read it) rides the durable attach
  // outbox and is not finished when this answers.
  //
  // `recorded` counts new receipts only. A client MUST NOT read a low count as a failure and retry:
  // already-recorded ids and ids naming no durable row both count zero, and both are correct.
  app.post("/bots/:name/chat/messages/displayed", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    let parsed;
    try {
      parsed = assertValid(BotChatDisplayedRequestSchema, body);
    } catch (err) {
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    try {
      const recorded = chat.recordDisplayed(
        resolved.name,
        parsed.messageIds,
        c.get("deviceId"),
      );
      return c.json(recorded, 202);
    } catch (err) {
      return failure(c, err);
    }
  });

  // Capability 19. Stop is the hard escape. The gateway sends attach-v1 interrupt for its durable
  // native turn binding; this route never accepts a session id from a device.
  app.post("/bots/:name/chat/stop", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    try {
      const outcome = await chat.stopChat(resolved.name);
      if (outcome === "idle") {
        return c.json(
          extensionErrorBody("conflict", "no bot chat turn is running"),
          409,
        );
      }
      return c.json({ status: "stopped" });
    } catch (err) {
      return failure(c, err);
    }
  });

  // Select a fresh empty gateway-owned canonical chat. Capability 8. The previous local transcript
  // remains in `GET /bots/:name/sessions`; reset changes the selected chat and interrupts its active
  // attach-v1 turn when one exists.
  //
  // No ambiguity with `/bots/:name/chat/messages` above, though both patterns are four segments and
  // share the first three: the last segment is a LITERAL on both, so `reset` and `messages` can only
  // ever match their own route and the registration order does not matter. Registered here, after
  // the duplex pair, purely so the chat routes read in the order a client uses them.
  //
  // 200, not the 202 the send route answers with: the work this route describes is FINISHED when it
  // answers. The fresh local chat exists, every device has been told, and it stays empty until the
  // user writes in it (capability 11).
  //
  // No request body at all. There is nothing to parameterize: a reset is a reset.
  app.post("/bots/:name/chat/reset", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    try {
      const result = await chat.resetChat(name);
      return c.json({
        name,
        sessionId: result.sessionId,
        ...(result.previousSessionId === undefined
          ? {}
          : { previousSessionId: result.previousSessionId }),
      });
    } catch (err) {
      return failure(c, err);
    }
  });

  // One photo into the canonical chat. Capability 9.
  //
  // 202 and the same body as the text composer, on purpose: a photo send IS a send, and the reply
  // arrives over `bot_chat` exactly as it does for words. The only thing the body carries that a text
  // send's does not is the `attachment` block, and it carries it immediately so the sender's
  // optimistic bubble shows the picture rather than waiting a poll for it.
  //
  // Order of the checks below is the order the answers get expensive, and it is load bearing: the
  // declared length is read before the body is buffered, the rate limit is spent before a slot is
  // taken, and the slot is held across the hermes round trip because that is the part being bounded.
  app.post("/bots/:name/chat/photos", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;

    // Cheapest possible refusal, before a single byte of the body is read. `Content-Length` is a
    // claim, so it never decides acceptance; it only decides early rejection.
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > PHOTO_MAX_REQUEST_BYTES) {
      return c.json(
        {
          ...extensionErrorBody(
            "media_refused",
            `the upload declares ${declared} bytes, over the cap`,
          ),
          reason: "too_large",
        },
        413,
      );
    }

    // Spent BEFORE the body is read, the slot is taken, and anything is validated, so a device that
    // is probing pays for its probes. The cost of that choice, stated rather than discovered: a run
    // of 415s (a phone retrying an unconverted HEIC) burns the same budget a run of real sends does,
    // and a 503 busy burns it for something that was the gateway's fault rather than the device's.
    // That is the right way round for a bound whose purpose is to make a loop expensive, since a
    // limiter a caller can dodge by sending requests that fail cheaply is not a limiter. The budget
    // is generous enough (8, refilling) that an honest client hitting it has a bug worth noticing.
    const ticket = photoRate.take(c.get("deviceId"), photoNow());
    if (!ticket.ok) {
      const seconds = Math.max(1, Math.ceil(ticket.retryAfterMs / 1000));
      return c.json(
        {
          ...extensionErrorBody(
            "rate_limited",
            "this device has sent photos too quickly; wait and try again",
          ),
          retryAfterMs: ticket.retryAfterMs,
        },
        429,
        { "retry-after": String(seconds) },
      );
    }

    let slot;
    try {
      slot = await photoLimiter.acquire(
        photoOptions.queueWaitMs ?? PHOTO_QUEUE_WAIT_MS,
      );
    } catch (err) {
      if (err instanceof MediaBusy) {
        return c.json(
          {
            ...errorBody(
              "backend_unavailable",
              `the gateway is already sending ${PHOTO_MAX_CONCURRENT} photos`,
            ),
            busy: true,
            waitedMs: err.waitedMs,
          },
          503,
          { "retry-after": "1" },
        );
      }
      throw err;
    }
    try {
      // The body is read HERE, with a hard cap, rather than handed to a parse helper. A
      // `Content-Length` is optional, so a chunked upload declares nothing and a helper that simply
      // parses the body would buffer whatever arrives; the check above can only catch a sender that
      // volunteered its own size. Once the bytes are in hand and bounded, the platform's own
      // multipart parser does the parsing.
      let form: FormData;
      try {
        const raw = await readCappedBody(
          c.req.raw.body,
          PHOTO_MAX_REQUEST_BYTES,
        );
        form = await new Response(
          raw.buffer.slice(
            raw.byteOffset,
            raw.byteOffset + raw.byteLength,
          ) as ArrayBuffer,
          {
            headers: { "content-type": c.req.header("content-type") ?? "" },
          },
        ).formData();
      } catch (err) {
        if (err instanceof PhotoRefused) return photoFailure(c, err);
        return c.json(
          errorBody(
            "invalid_request",
            "the body is not a multipart/form-data upload",
          ),
          400,
        );
      }

      // ONE image per send, stated as a refusal rather than by taking the first. Hermes queues
      // attached images on the session and spends the whole queue on the next prompt, so a multi-file
      // upload would put several pictures on one turn with one attachment block to describe them.
      const parts = form.getAll("file");
      if (parts.length > 1) {
        return c.json(
          errorBody("invalid_request", "exactly one photo per send"),
          400,
        );
      }
      const file = parts[0];
      if (!(file instanceof File)) {
        return c.json(
          errorBody(
            "invalid_request",
            'a single file part named "file" is required',
          ),
          400,
        );
      }

      const textPart = form.get("text");
      const clientIdPart = form.get("clientId");
      let fields;
      try {
        fields = assertValid(BotChatPhotoFieldsSchema, {
          ...(typeof textPart === "string" ? { text: textPart } : {}),
          ...(typeof clientIdPart === "string"
            ? { clientId: clientIdPart }
            : {}),
        });
      } catch (err) {
        const detail =
          err instanceof ContractViolation ? err.message : "malformed fields";
        return c.json(errorBody("invalid_request", detail), 400);
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      let accepted;
      try {
        accepted = acceptPhoto({
          declaredType: file.type === "" ? undefined : file.type,
          declaredLength: file.size,
          bytes,
        });
      } catch (err) {
        return photoFailure(c, err);
      }

      const caption = (fields.text ?? "").trim();
      try {
        const sent = await chat.sendChatPhoto(name, {
          bytes,
          mime: accepted.mime,
          ext: accepted.ext,
          // A photo turn still needs words. The default is neutral and the native transcript shows
          // it honestly rather than leaving a queued attachment for a later send.
          text: caption === "" ? PHOTO_DEFAULT_PROMPT : caption,
          ...(fields.clientId === undefined
            ? {}
            : { clientId: fields.clientId }),
        }, { deviceId: c.get("deviceId") });
        return c.json(
          { name, sessionId: sent.sessionId, message: sent.message },
          202,
        );
      } catch (err) {
        return photoFailure(c, err);
      }
    } finally {
      slot();
    }
  });

  // Capability 24: the same one-file, one-turn pipeline as photos, with a deliberately small
  // document allow-list. Files remain gateway-owned attach-v1 media; no Hermes path or URL enters
  // the transcript.
  app.post("/bots/:name/chat/attachments", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    const maxRequestBytes = FILE_MAX_BYTES + 64 * 1024;
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxRequestBytes)
      return c.json({ ...extensionErrorBody("media_refused", "the upload declares bytes over the cap"), reason: "too_large" }, 413);
    const ticket = photoRate.take(c.get("deviceId"), photoNow());
    if (!ticket.ok)
      return c.json({ ...extensionErrorBody("rate_limited", "this device has sent attachments too quickly; wait and try again"), retryAfterMs: ticket.retryAfterMs }, 429, { "retry-after": String(Math.max(1, Math.ceil(ticket.retryAfterMs / 1000))) });
    let slot;
    try {
      slot = await photoLimiter.acquire(photoOptions.queueWaitMs ?? PHOTO_QUEUE_WAIT_MS);
    } catch (err) {
      if (err instanceof MediaBusy) return c.json({ ...errorBody("backend_unavailable", `the gateway is already sending ${PHOTO_MAX_CONCURRENT} attachments`), busy: true, waitedMs: err.waitedMs }, 503, { "retry-after": "1" });
      throw err;
    }
    try {
      let form: FormData;
      try {
        const raw = await readCappedBody(c.req.raw.body, maxRequestBytes);
        form = await new Response(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer, { headers: { "content-type": c.req.header("content-type") ?? "" } }).formData();
      } catch {
        return c.json(errorBody("invalid_request", "the body is not a multipart/form-data upload"), 400);
      }
      const parts = form.getAll("file");
      if (parts.length !== 1 || !(parts[0] instanceof File))
        return c.json(errorBody("invalid_request", 'exactly one file part named "file" is required'), 400);
      const file = parts[0];
      let fields;
      try {
        fields = assertValid(BotChatAttachmentFieldsSchema, {
          ...(typeof form.get("text") === "string" ? { text: form.get("text") } : {}),
          ...(typeof form.get("clientId") === "string" ? { clientId: form.get("clientId") } : {}),
        });
      } catch (err) {
        return c.json(errorBody("invalid_request", err instanceof ContractViolation ? err.message : "malformed fields"), 400);
      }
      const filename = safeFilename(file.name);
      if (filename === undefined) return c.json(errorBody("invalid_request", "invalid attachment filename"), 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let accepted;
      try { accepted = acceptFileBytes(file.type.toLowerCase(), bytes); } catch (err) {
        const message = err instanceof Error ? err.message : "invalid file";
        const status = /size cap/.test(message) ? 413 : /no bytes/.test(message) ? 400 : 415;
        return c.json({ ...extensionErrorBody("media_refused", message), reason: status === 413 ? "too_large" : status === 400 ? "empty" : "content_type" }, status);
      }
      try {
        const sent = await chat.sendChatAttachment(name, {
          bytes, mime: accepted.mime, name: filename,
          text: (fields.text ?? "").trim() || "Here is an attached file.",
          ...(fields.clientId === undefined ? {} : { clientId: fields.clientId }),
        }, { deviceId: c.get("deviceId") });
        return c.json({ name, sessionId: sent.sessionId, message: sent.message }, 202);
      } catch (err) { return failure(c, err); }
    } finally { slot(); }
  });

  // The gateway's own copy of chat media. User rows hold image bytes a device uploaded;
  // capability-20 assistant rows may also hold video/audio fetched through Hermes' authenticated,
  // guarded dashboard endpoints.
  // Both use an id this gateway minted, and neither exposes a host path.
  //
  // Scoped to the bot AND to a strict id shape, both before the lookup: a path parameter that could
  // be anything is how an id becomes a path.
  app.get("/bots/:name/chat/attachments/:fileId", requireDevice, (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const fileId = c.req.param("fileId") ?? "";
    if (!isFetchableAttachmentId(fileId)) {
      return c.json(
        errorBody("invalid_request", "fileId is not a gateway attachment id"),
        400,
      );
    }
    const info = chat.chatAttachmentInfo(resolved.name, fileId);
    if (info === undefined) {
      return c.json(
        errorBody("not_found", "no such attachment for this bot"),
        404,
      );
    }
    const range = resolveByteRange(c.req.header("range"), info.size);
    if (range === null) {
      return new Response(null, {
        status: 416,
        headers: {
          "content-range": `bytes */${info.size}`,
          "accept-ranges": "bytes",
        },
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    const bytes = chat.chatAttachmentSlice(
      resolved.name,
      fileId,
      start,
      end - start + 1,
    );
    if (bytes === undefined) {
      return c.json(
        errorBody("not_found", "no such attachment for this bot"),
        404,
      );
    }
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      status: range === undefined ? 200 : 206,
      headers: {
        "content-type": info.mime,
        "content-disposition": attachmentDisposition(info.name),
        "content-length": String(bytes.byteLength),
        "cache-control": PHOTO_CACHE_CONTROL,
        "accept-ranges": "bytes",
        ...(range === undefined
          ? {}
          : { "content-range": `bytes ${start}-${end}/${info.size}` }),
        // Same posture as the capability-7 proxy. The type came off an allow-list of raster formats
        // and was confirmed against the bytes, and this stops anything downstream from improving on
        // it.
        "x-content-type-options": "nosniff",
      },
    });
  });

  // Routines. Every one of these is scoped to the bot's `[bot:<name>]` cron namespace, which is the
  // only thing that makes a cron job a bot's routine: the operator's own unrelated cron jobs are
  // invisible here, and so are another bot's, whatever id a client sends.
  app.get("/bots/:name/routines", requireDevice, async (c) => {
    const resolved = routineBotName(c);
    if ("response" in resolved) return resolved.response;
    try {
      return c.json(await bots.routines(resolved.name));
    } catch (err) {
      return failure(c, err);
    }
  });

  // 201 with the routine the backend actually stored, not an echo of the request: the schedule is
  // normalized on the way in (`every 2h` is stored as `every 120m`) and the first run time is
  // computed, so a client that rendered its own request back would show a routine that does not
  // exist in those two fields.
  app.post("/bots/:name/routines", requireDevice, async (c) => {
    const resolved = routineBotName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    let parsed;
    try {
      parsed = assertValid(BotRoutineCreateRequestSchema, body);
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    try {
      const result = await bots.createRoutine(name, parsed);
      return c.json({ name, routine: result.routine }, 201);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.patch("/bots/:name/routines/:id", requireDevice, async (c) => {
    const resolved = routineBotName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    const id = c.req.param("id") ?? "";
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    let parsed;
    try {
      parsed = assertValid(BotRoutinePatchSchema, body);
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    if (
      !patchNeedsRewrite(parsed) &&
      parsed.enabled === undefined &&
      parsed.model === undefined &&
      parsed.effort === undefined
    ) {
      return c.json(
        errorBody(
          "invalid_request",
          "at least one of title, schedule, prompt, enabled, repeat, continuity, model or effort is required",
        ),
        400,
      );
    }
    // The one rule a client cannot discover from the shape: an edit to anything but the on/off
    // switch must carry the routine's instruction too. There is no update action on the backend, so
    // such an edit is a recreate, and the backend only ever reports a 100-character PREVIEW of a
    // stored prompt. Rebuilding a routine from that preview would silently truncate the user's own
    // instruction, so the request is refused instead of quietly damaging the routine.
    //
    // `repeat` and `continuity` are on this side of the line for the same reason `title` is: they
    // reach the backend only on an `add`, so a patch that named one without a rewrite used to answer
    // 200 and throw it away.
    if (patchNeedsRewrite(parsed) && parsed.prompt === undefined) {
      return c.json(
        errorBody(
          "invalid_request",
          "prompt is required when title, schedule, repeat or continuity changes: hermes has no cron update action and reports only a truncated prompt preview, so the routine is recreated",
        ),
        400,
      );
    }
    try {
      const result = await bots.patchRoutine(name, id, parsed);
      return c.json({
        name,
        routine: result.routine,
        ...(result.replacedId === undefined
          ? {}
          : { replacedId: result.replacedId }),
        ...(result.orphanedId === undefined
          ? {}
          : { orphanedId: result.orphanedId }),
      });
    } catch (err) {
      return failure(c, err);
    }
  });

  // 204, and NOT idempotent: a second delete of the same routine is a 404. A client that cannot
  // tell "already gone" from "the delete broke" cannot decide whether to retry.
  app.delete("/bots/:name/routines/:id", requireDevice, async (c) => {
    const resolved = routineBotName(c);
    if ("response" in resolved) return resolved.response;
    try {
      await bots.deleteRoutine(resolved.name, c.req.param("id") ?? "");
      return c.body(null, 204);
    } catch (err) {
      return failure(c, err);
    }
  });

  // The media proxy. `name` scopes the route to a bot for symmetry with everything else under
  // `/bots/:name`, and is validated the same way, but it is NOT resolved against Hermes: the answer
  // does not depend on which bot's reply carried the URL, and making an image load wait on a roster
  // round trip would put a Hermes outage between the user and a picture already sitting on a CDN.
  //
  // A range request is not supported and is not needed: the cap is 10 MB, so the answer is always a
  // single whole image, and `Accept-Ranges` is left off rather than implied.
  app.get("/bots/:name/media", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const src = c.req.query("src");
    if (src === undefined || src.trim() === "") {
      return c.json(errorBody("invalid_request", "src is required"), 400);
    }
    if (src.length > MEDIA_SRC_MAX) {
      return c.json(
        errorBody(
          "invalid_request",
          `src must be at most ${MEDIA_SRC_MAX} characters`,
        ),
        400,
      );
    }
    try {
      const source = resolveMediaSource(src);
      const media = await fetchMedia(source, mediaOptions);
      return new Response(media.body, {
        status: 200,
        headers: {
          "content-type": media.contentType,
          "cache-control": MEDIA_CACHE_CONTROL,
          // The bytes came from a host a bot's text named, and this is an authenticated same-origin
          // route, so the browser or web view is told to take the declared type and not go looking
          // for a better one. The type is already off an allow-list of raster formats; this stops a
          // sniffer from promoting something that slipped past it into markup.
          "x-content-type-options": "nosniff",
          // The app keys its cache on the source, not on this URL, so the source rides back on the
          // answer: a client that followed a redirect chain server-side otherwise has no way to know
          // what it actually got.
          "x-cozy-media-source": source.toString(),
          ...(media.contentLength === undefined
            ? {}
            : { "content-length": String(media.contentLength) }),
        },
      });
    } catch (err) {
      return mediaFailure(c, err);
    }
  });

  app.get("/bots/:name/sessions", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    try {
      return c.json(await chat.sessions(name, SESSION_LIST_LIMIT));
    } catch (err) {
      return failure(c, err);
    }
  });

  // Separately capability-gated desktop/TUI seam. It never extends the native `/sessions`
  // history and it is not an implicit fallback: only this explicit action can request the
  // plugin's exact, profile-local Hermes resume primitive.
  app.get("/bots/:name/desktop-sessions", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    try {
      return c.json({
        name: resolved.name,
        source: "hermes_desktop" as const,
        sessions: await chat.desktopSessions(resolved.name),
      });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/bots/:name/desktop-sessions/:hermesSessionId/resume", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const hermesSessionId = c.req.param("hermesSessionId") ?? "";
    if (hermesSessionId.length === 0 || hermesSessionId.length > 256) {
      return c.json(errorBody("invalid_request", "Hermes desktop session id is required"), 400);
    }
    try {
      return c.json(await chat.resumeDesktopSession(resolved.name, hermesSessionId), 202);
    } catch (err) {
      return failure(c, err);
    }
  });

  // Capability 19. Mint and adopt a fresh conversation without retiring the previous one. The
  // existing adoption frame is the cross-device reload signal, and the automatic pin written by
  // this action releases any capability-16 manual selection so follow-latest can resume.
  app.post("/bots/:name/sessions/new", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    try {
      const result = await chat.newSession(name);
      return c.json({
        name,
        sessionId: result.sessionId,
        previousSessionId: result.previousSessionId,
      });
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/bots/:name/sessions/:id/adopt", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const sessionId = c.req.param("id") ?? "";
    if (sessionId.length === 0) {
      return c.json(
        errorBody("invalid_request", "session id is required"),
        400,
      );
    }
    try {
      return c.json(
        await chat.adoptSession(resolved.name, sessionId, SESSION_LIST_LIMIT),
      );
    } catch (err) {
      return failure(c, err);
    }
  });

  // Group chats. Registered AFTER the per-bot routes on purpose: `/bots/groups/:name` and
  // `/bots/:name/<suffix>` are both three segments, and Hono runs matching handlers in registration
  // order, so a bot literally named `groups` keeps `/bots/groups/profile` and friends. The other
  // half of that bargain is `RESERVED_GROUP_NAMES`, which refuses those suffixes as room names, so
  // no room can be created at an address that would not reach it.
  //
  // `/bots/groups` itself is two segments and collides with no configured per-bot route.
  app.get("/bots/groups", requireDevice, (c) =>
    c.json({ groups: bots.groups() }),
  );

  app.post("/bots/groups", requireDevice, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    let parsed;
    try {
      parsed = assertValid(BotGroupCreateRequestSchema, body);
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    try {
      return c.json(
        { group: await bots.createGroup(parsed.name, parsed.members) },
        201,
      );
    } catch (err) {
      return groupFailure(c, err);
    }
  });

  app.get("/bots/groups/:group", requireDevice, (c) => {
    try {
      return c.json(bots.groupDetail(c.req.param("group") ?? ""));
    } catch (err) {
      return groupFailure(c, err);
    }
  });

  // 204: the gateway-owned room, transcript, and per-member turn bindings are gone.
  app.delete("/bots/groups/:group", requireDevice, (c) => {
    try {
      bots.deleteGroup(c.req.param("group") ?? "");
      return c.body(null, 204);
    } catch (err) {
      return groupFailure(c, err);
    }
  });

  // 202, like the 1:1 composer: the message is durable, and the deliberation it starts arrives later
  // as `bot_group` and `bot_group_state` frames. Nothing here waits on a member turn, which is the
  // whole point of hosting the room server-side.
  app.post("/bots/groups/:group/messages", requireDevice, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    let parsed;
    try {
      parsed = assertValid(BotGroupSendRequestSchema, body);
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    try {
      const group = c.req.param("group") ?? "";
      const message = bots.sendGroupMessage(group, parsed.text, {
        ...(parsed.clientId === undefined ? {} : { clientId: parsed.clientId }),
      });
      return c.json({ group, message }, 202);
    } catch (err) {
      return groupFailure(c, err);
    }
  });
}

/** Media-proxy errors. Nothing here reaches Hermes, so `failure`'s Hermes mapping does not apply and
 *  the statuses say what actually happened to the fetch:
 *
 *  - `400 media_refused`: the SOURCE is one this gateway will not dial (a local path, a non-https
 *    scheme, a non-public address, credentials in the URL). Nothing was fetched. A client shows its
 *    fallback chip and never retries: retrying cannot change the answer.
 *  - `415 media_refused`: something was fetched and it is not a proxied image type. Same finality.
 *  - `413 media_refused`: over the size cap, either declared or delivered.
 *  - `503 backend_unavailable` with `busy: true`: nothing was dialed, because this gateway was
 *    already fetching as many images as it will fetch at once and no slot came free. A retry is not
 *    just reasonable, it is expected: the client backs off and asks again.
 *  - `502 backend_unavailable`: the source host failed, did not resolve, or answered non-2xx. A retry
 *    is reasonable.
 *  - `504 backend_unavailable` with `timedOut: true`: it did not answer in time.
 *
 *  `reason` rides every refusal so a client can render a specific fallback ("this bot pointed at a
 *  file on its own machine") without parsing English out of `message`. */
function mediaFailure(c: Context<Env>, err: unknown) {
  if (err instanceof MediaRefused) {
    const status =
      err.reason === "content_type"
        ? 415
        : err.reason === "too_large"
          ? 413
          : 400;
    return c.json(
      {
        ...extensionErrorBody("media_refused", err.message),
        reason: err.reason,
      },
      status,
    );
  }
  if (err instanceof MediaBusy) {
    // `retry-after` in whole seconds, which is all the header allows, and 1 rather than 0 so a client
    // that obeys it literally does not spin. The wait already spent is in the body for a client that
    // wants to be smarter about it.
    return c.json(
      {
        ...errorBody(
          "backend_unavailable",
          `the gateway is already fetching ${MEDIA_MAX_CONCURRENT} images`,
        ),
        busy: true,
        waitedMs: err.waitedMs,
      },
      503,
      { "retry-after": "1" },
    );
  }
  if (err instanceof MediaTimedOut) {
    return c.json(
      {
        ...errorBody(
          "backend_unavailable",
          "the image source did not answer in time",
        ),
        timedOut: true,
      },
      504,
    );
  }
  if (err instanceof MediaUpstreamFailed) {
    return c.json(
      {
        ...errorBody(
          "backend_unavailable",
          "the image source could not be fetched",
        ),
        sourceError: err.message,
        ...(err.status === undefined ? {} : { sourceStatus: err.status }),
      },
      502,
    );
  }
  throw err;
}

/** Inbound-photo errors (capability 9). The refusals mirror the media proxy's statuses so a client
 *  has one mental model for "this gateway will not carry that image", pointed in either direction:
 *
 *  - `413 media_refused reason: "too_large"`: over the size cap, declared or delivered.
 *  - `415 media_refused reason: "content_type"`: the declared type is not one this gateway accepts,
 *    the BYTES are not an image it accepts, or the two disagree. The `message` names which, because
 *    "convert this HEIC" and "this is not an image" are different things for a user to do.
 *  - `400 media_refused reason: "empty"`: a file part with no bytes in it.
 *  - `502 backend_unavailable`: hermes would not take the photo. The distinction worth keeping is
 *    that this one is reported only when NOTHING was submitted, so a 502 here never means "your
 *    caption went without the picture".
 *
 *  Anything else falls through to the shared `failure` mapping, which already answers a bot that does
 *  not exist, a runtime session that could not be addressed, and every transport state. */
function photoFailure(c: Context<Env>, err: unknown) {
  if (err instanceof PhotoRefused) {
    const status =
      err.reason === "content_type"
        ? 415
        : err.reason === "too_large"
          ? 413
          : 400;
    return c.json(
      {
        ...extensionErrorBody("media_refused", err.message),
        reason: err.reason,
      },
      status,
    );
  }
  // Hermes' own text, with anything path-shaped redacted. Every other route on this surface passes
  // that text through verbatim on purpose and still does; this route is the exception because it is
  // the one whose ordinary failures NAME the images directory on the operator's box (a `5027 write
  // failure` carries the full path), and this capability's whole transcript-hygiene argument is that
  // no such path reaches a device. Redacting the transcript and then handing the same path back in an
  // error body would be pointless.
  if (err instanceof PhotoAttachFailed) {
    return c.json(
      {
        ...errorBody(
          "backend_unavailable",
          "the hermes gateway did not accept the photo; nothing was submitted",
        ),
        hermesError: redactHostPaths(err.message),
      },
      502,
    );
  }
  // Everything except the "no such profile" code, which `failure` answers as the 404 it is and which
  // carries a bot name rather than a path.
  if (err instanceof HermesRpcError && err.code !== HERMES_PROFILE_NOT_FOUND) {
    return c.json(
      {
        ...errorBody(
          "backend_unavailable",
          "the hermes gateway rejected the photo",
        ),
        hermesError: redactHostPaths(err.message),
        ...(err.code === undefined ? {} : { hermesErrorCode: err.code }),
      },
      502,
    );
  }
  return failure(c, err);
}

/** Room errors on top of the shared `failure` mapping. A room is this gateway's own object, so its
 *  failures are ordinary 4xx answers rather than anything about Hermes; only membership validation
 *  reaches Hermes at all, and that arrives here as `BotNotFound`, which `failure` already answers
 *  as the 404 it is. */
function groupFailure(c: Context<Env>, err: unknown) {
  if (err instanceof GroupNotFound)
    return c.json(errorBody("not_found", err.message), 404);
  if (err instanceof GroupExists)
    return c.json(extensionErrorBody("conflict", err.message), 409);
  if (err instanceof GroupInvalid)
    return c.json(errorBody("invalid_request", err.message), 400);
  if (err instanceof BotNameInvalid)
    return c.json(errorBody("invalid_request", err.message), 400);
  return failure(c, err);
}

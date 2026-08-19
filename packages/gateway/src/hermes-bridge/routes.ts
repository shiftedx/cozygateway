import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  type ErrorBody,
  type ErrorCode,
  BotChatSendRequestSchema,
  BotCreateRequestSchema,
  BotFocusRequestSchema,
  BotGroupCreateRequestSchema,
  BotGroupSendRequestSchema,
  BotProfilePatchSchema,
  BotRoutineCreateRequestSchema,
  BotRoutinePatchSchema,
  ContractViolation,
  assertValid,
} from "cozygateway-contract";

import { HermesRpcError, HermesTimeout, HermesUnavailable } from "./client.ts";
import { RuntimeSessionUnknown } from "./chat-turns.ts";
import type { BotsSurface } from "./bridge.ts";
import {
  BotDeleteBlocked,
  BotDeleteFailed,
  BotDeleteRefused,
  BotNameInvalid,
  BotNameTaken,
  BotNotFound,
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
  fetchMedia,
  resolveMediaSource,
} from "./media.ts";
import { RoutineNotFound, RoutineRefused, RoutineUnconfirmed, patchNeedsRewrite } from "./routines.ts";

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
function extensionErrorBody(code: "conflict" | "command_blocked" | "media_refused", message: string): ErrorBody {
  return { error: { code, message } };
}

/** Longest `src` `GET /bots/:name/media` accepts. A URL in a bot's reply is an ordinary URL; the cap
 *  exists so an unbounded query string cannot be pushed through the route, and it is checked before
 *  anything is parsed. */
export const MEDIA_SRC_MAX = 2048;

/** The ONE canonicalization every `/bots/:name` route applies to its path parameter, so a bot has
 *  exactly one identity no matter what casing or padding a client used in the URL.
 *
 *  Without it the routes disagreed with each other: `GET /bots/Scout/chat` pinned under the key
 *  `"Scout"` while `DELETE /bots/scout` forgot `"scout"`, leaving behind the orphan pin and meta row
 *  that `forgetBot` exists to prevent, and giving the same bot two independent inflight and pin
 *  identities depending on how it was spelled. Normalizing at the boundary, not in each handler, is
 *  what makes that unrepresentable.
 *
 *  Returns the canonical name, or a 400 response for a name that cannot name a profile at all. */
function canonicalName(c: Context<Env>): { name: string } | { response: Response } {
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
function routineBotName(c: Context<Env>): { name: string } | { response: Response } {
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
  // Checked first, ahead of every other mapping: a name that names no Hermes profile at all is not
  // a backend failure of any kind, it is a 404 that says so, on every `/bots/:name/*` route the
  // same way `DELETE /bots/:name` already answers it.
  if (err instanceof BotNotFound) return c.json(errorBody("not_found", err.message), 404);
  // A routine id that names nothing in this bot's namespace, which includes an id that belongs to
  // another bot or to an untagged cron job the operator owns. Not found, not forbidden: this API
  // does not confirm the existence of jobs outside the bot that was asked about.
  if (err instanceof RoutineNotFound) return c.json(errorBody("not_found", err.message), 404);
  // A create the backend accepted whose stored row could not be read back. A 502 rather than a 201,
  // because there is no routine to put in a 201 body: the alternative is echoing the request, and
  // the request is not what the backend stores. `createdId` rides along when the `add` reported one,
  // so a client can list and find out whether the routine is really there.
  if (err instanceof RoutineUnconfirmed) {
    return c.json(
      {
        ...errorBody("backend_unavailable", "hermes accepted the routine but its stored schedule could not be read back"),
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
          { ...errorBody("invalid_request", `hermes refused the cron ${err.action}`), hermesError: err.message },
          400,
        )
      : c.json(
          { ...errorBody("backend_unavailable", `hermes refused the cron ${err.action}`), hermesError: err.message },
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
        ...errorBody("backend_unavailable", "the hermes gateway rejected the request"),
        hermesError: err.message,
        ...(err.code === undefined ? {} : { hermesErrorCode: err.code }),
      },
      502,
    );
  }
  // A send whose runtime session id could not be established. Reported rather than degraded into a
  // submit against the stored id, which answers 202 for a message that goes nowhere.
  if (err instanceof RuntimeSessionUnknown) {
    return c.json(
      { ...errorBody("backend_unavailable", "the hermes gateway did not report a runtime session"), hermesError: err.message },
      502,
    );
  }
  // Checked BEFORE HermesUnavailable, which it subclasses. A call that went out and did not answer
  // in time is not "the bridge is not connected": the operation may be running to completion right
  // now (a profile delete stops a service and rmtrees a directory), and telling a client nothing
  // reached Hermes is factually wrong and invites a retry against work already in flight.
  if (err instanceof HermesTimeout) {
    return c.json(
      {
        ...errorBody("backend_unavailable", "the hermes gateway did not answer in time; the operation may still be running"),
        hermesError: err.message,
        timedOut: true,
      },
      504,
    );
  }
  if (err instanceof HermesUnavailable) {
    return c.json(
      { ...errorBody("backend_unavailable", "the hermes bridge is not connected"), hermesError: err.message },
      503,
    );
  }
  throw err;
}

export function registerBotRoutes(
  app: Hono<Env>,
  requireDevice: MiddlewareHandler<Env>,
  bots: BotsSurface,
  mediaOptions: {
    fetchImpl?: MediaFetch;
    timeoutMs?: number;
    lookup?: MediaLookup;
    limiter?: MediaLimiter;
    queueWaitMs?: number;
  } = {},
): void {
  // Cache-first: the snapshot answers immediately, even on a cold link, and a refresh runs in the
  // background so the next read (or the /ws bot_roster frame) carries fresh state.
  app.get("/bots", requireDevice, (c) => {
    const view = bots.roster();
    bots.refreshSoon("GET /bots");
    return c.json({ bots: view.bots, updatedAt: view.updatedAt, stale: view.stale });
  });

  // 201 with the bot's roster row, which is the same row the `bot_roster` frame that fires
  // alongside it carries: the bridge refreshes the roster before answering, so the app never sees
  // a bot it just made missing from its own list.
  app.post("/bots", requireDevice, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    let parsed;
    try {
      parsed = assertValid(BotCreateRequestSchema, body);
    } catch (err) {
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    try {
      const created = await bots.createBot(parsed);
      return c.json(
        {
          bot: created.bot,
          metaOutcome: created.metaOutcome,
          ...(created.metaError === undefined ? {} : { metaError: created.metaError }),
        },
        201,
      );
    } catch (err) {
      // The name rule is Hermes', but it is checked before the RPC, so it reads as the 400 it is
      // rather than as a backend failure.
      if (err instanceof BotNameInvalid) return c.json(errorBody("invalid_request", err.message), 400);
      if (err instanceof BotNameTaken) return c.json(extensionErrorBody("conflict", err.message), 409);
      return failure(c, err);
    }
  });

  // 204: the bot is gone, and there is nothing left to say about it. The roster frame that follows
  // is how every other device finds out.
  app.delete("/bots/:name", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    try {
      await bots.deleteBot(resolved.name);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof BotNameInvalid) return c.json(errorBody("invalid_request", err.message), 400);
      if (err instanceof BotDeleteRefused) return c.json(errorBody("invalid_request", err.message), 400);
      // Deliberately 404 rather than 204: this route is NOT idempotent, and a client that cannot
      // tell "already gone" from "the delete broke" cannot decide whether to retry.
      if (err instanceof BotNotFound) return c.json(errorBody("not_found", err.message), 404);
      // `blocked` is not a Hermes error, it is a successful `cli.exec` that refused to run the
      // command. The hint is the gateway's own text and is what tells an operator to widen the
      // allow-list, so it rides the body verbatim rather than being folded into the message.
      if (err instanceof BotDeleteBlocked) {
        return c.json({ ...extensionErrorBody("command_blocked", err.message), blocked: true, hint: err.hint }, 502);
      }
      if (err instanceof BotDeleteFailed) {
        return c.json(
          {
            ...errorBody("backend_unavailable", err.message),
            blocked: false,
            exitCode: err.exitCode,
            hermesError: err.output,
          },
          502,
        );
      }
      return failure(c, err);
    }
  });

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
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
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
      return c.json(errorBody("invalid_request", `q must be at most ${CATALOG_QUERY_MAX} characters`), 400);
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
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
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

  app.get("/bots/:name/chat", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    try {
      const result = await bots.canonicalChat(name);
      return c.json({ name, sessionId: result.sessionId, adoption: result.adoption });
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
      const history = await bots.chatHistory(name);
      return c.json({ name, ...history });
    } catch (err) {
      return failure(c, err);
    }
  });

  // 202, not 200: Hermes has accepted the prompt, and the reply lands later over `/ws` as
  // `bot_chat` frames. The body carries the user message the bridge committed, so the app can
  // render it at once instead of waiting for it to come back around the poll.
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
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    try {
      const sent = await bots.sendChatMessage(name, parsed.text, {
        ...(parsed.clientId === undefined ? {} : { clientId: parsed.clientId }),
      });
      return c.json({ name, sessionId: sent.sessionId, message: sent.message }, 202);
    } catch (err) {
      return failure(c, err);
    }
  });

  // Retire the canonical chat and pin a fresh one. Capability 8.
  //
  // NOTHING IS DELETED, and this is the first place a reader lands, so it is said here too. Hermes
  // exposes no session delete on this surface: the retired session and its whole transcript stay on
  // the Hermes host and keep appearing in `GET /bots/:name/sessions`. The only thing that changes is
  // which session the bot's canonical pin points at. The action a client hangs off this will be
  // labelled "clear chat", and that label is generous: what the user really gets is a fresh context
  // window for the bot and a clean screen, not a deletion.
  //
  // No ambiguity with `/bots/:name/chat/messages` above, though both patterns are four segments and
  // share the first three: the last segment is a LITERAL on both, so `reset` and `messages` can only
  // ever match their own route and the registration order does not matter. Registered here, after
  // the duplex pair, purely so the chat routes read in the order a client uses them.
  //
  // 200, not the 202 the send route answers with: the work this route describes is FINISHED when it
  // answers. The new chat exists, it is pinned, the old poll is cancelled, and every device has been
  // told. Only the kickoff reply is still in flight, and that reply is not what was asked for.
  //
  // No request body at all. There is nothing to parameterize: a reset is a reset.
  app.post("/bots/:name/chat/reset", requireDevice, async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const name = resolved.name;
    try {
      const result = await bots.resetChat(name);
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
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
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
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    if (!patchNeedsRewrite(parsed) && parsed.enabled === undefined) {
      return c.json(
        errorBody("invalid_request", "at least one of title, schedule, prompt, enabled, repeat, continuity is required"),
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
        ...(result.replacedId === undefined ? {} : { replacedId: result.replacedId }),
        ...(result.orphanedId === undefined ? {} : { orphanedId: result.orphanedId }),
      });
    } catch (err) {
      return failure(c, err);
    }
  });

  // 204, and NOT idempotent: a second delete of the same routine is a 404, by the same rule
  // `DELETE /bots/:name` follows. A client that cannot tell "already gone" from "the delete broke"
  // cannot decide whether to retry.
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
      return c.json(errorBody("invalid_request", `src must be at most ${MEDIA_SRC_MAX} characters`), 400);
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
          ...(media.contentLength === undefined ? {} : { "content-length": String(media.contentLength) }),
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
      return c.json({ sessions: await bots.sessions(name, SESSION_LIST_LIMIT) });
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
  // `/bots/groups` itself is two segments and collides with nothing: the only two-segment per-bot
  // route is `DELETE /bots/:name`, and rooms are deleted at `/bots/groups/:name`.
  app.get("/bots/groups", requireDevice, (c) => c.json({ groups: bots.groups() }));

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
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    try {
      return c.json({ group: await bots.createGroup(parsed.name, parsed.members) }, 201);
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

  // 204: the room is gone, along with its transcript and its per-member watermarks. The members'
  // own `Group: <name>` sessions in Hermes are left standing (see `GroupRooms.remove`).
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
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
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
    const status = err.reason === "content_type" ? 415 : err.reason === "too_large" ? 413 : 400;
    return c.json({ ...extensionErrorBody("media_refused", err.message), reason: err.reason }, status);
  }
  if (err instanceof MediaBusy) {
    // `retry-after` in whole seconds, which is all the header allows, and 1 rather than 0 so a client
    // that obeys it literally does not spin. The wait already spent is in the body for a client that
    // wants to be smarter about it.
    return c.json(
      {
        ...errorBody("backend_unavailable", `the gateway is already fetching ${MEDIA_MAX_CONCURRENT} images`),
        busy: true,
        waitedMs: err.waitedMs,
      },
      503,
      { "retry-after": "1" },
    );
  }
  if (err instanceof MediaTimedOut) {
    return c.json(
      { ...errorBody("backend_unavailable", "the image source did not answer in time"), timedOut: true },
      504,
    );
  }
  if (err instanceof MediaUpstreamFailed) {
    return c.json(
      {
        ...errorBody("backend_unavailable", "the image source could not be fetched"),
        sourceError: err.message,
        ...(err.status === undefined ? {} : { sourceStatus: err.status }),
      },
      502,
    );
  }
  throw err;
}

/** Room errors on top of the shared `failure` mapping. A room is this gateway's own object, so its
 *  failures are ordinary 4xx answers rather than anything about Hermes; only membership validation
 *  reaches Hermes at all, and that arrives here as `BotNotFound`, which `failure` already answers
 *  as the 404 it is. */
function groupFailure(c: Context<Env>, err: unknown) {
  if (err instanceof GroupNotFound) return c.json(errorBody("not_found", err.message), 404);
  if (err instanceof GroupExists) return c.json(extensionErrorBody("conflict", err.message), 409);
  if (err instanceof GroupInvalid) return c.json(errorBody("invalid_request", err.message), 400);
  if (err instanceof BotNameInvalid) return c.json(errorBody("invalid_request", err.message), 400);
  return failure(c, err);
}

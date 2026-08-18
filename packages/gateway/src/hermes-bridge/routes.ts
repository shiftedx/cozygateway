import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  type ErrorBody,
  type ErrorCode,
  BotChatSendRequestSchema,
  BotCreateRequestSchema,
  BotFocusRequestSchema,
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
  normalizeProfileName,
} from "./crud.ts";
import { RoutineNotFound, RoutineRefused, patchNeedsRewrite } from "./routines.ts";

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
function extensionErrorBody(code: "conflict" | "command_blocked", message: string): ErrorBody {
  return { error: { code, message } };
}

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

function failure(c: Context<Env>, err: unknown) {
  // Checked first, ahead of every other mapping: a name that names no Hermes profile at all is not
  // a backend failure of any kind, it is a 404 that says so, on every `/bots/:name/*` route the
  // same way `DELETE /bots/:name` already answers it.
  if (err instanceof BotNotFound) return c.json(errorBody("not_found", err.message), 404);
  // A routine id that names nothing in this bot's namespace, which includes an id that belongs to
  // another bot or to an untagged cron job the operator owns. Not found, not forbidden: this API
  // does not confirm the existence of jobs outside the bot that was asked about.
  if (err instanceof RoutineNotFound) return c.json(errorBody("not_found", err.message), 404);
  // A cron call the backend ANSWERED with a refusal. It arrives as a successful RPC result carrying
  // `success: false`, so it is not a backend failure and must not read as one: an unparsable
  // schedule is the client's input, and a 502 would tell a user to check their gateway when they
  // should be checking what they typed. The backend's text rides along verbatim in `hermesError`,
  // because it is the only description of what was actually wrong.
  if (err instanceof RoutineRefused) {
    return c.json({ ...errorBody("invalid_request", `hermes refused the cron ${err.action}`), hermesError: err.message }, 400);
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

  // Routines. Every one of these is scoped to the bot's `[bot:<name>]` cron namespace, which is the
  // only thing that makes a cron job a bot's routine: the operator's own unrelated cron jobs are
  // invisible here, and so are another bot's, whatever id a client sends.
  app.get("/bots/:name/routines", requireDevice, async (c) => {
    const resolved = canonicalName(c);
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
    const resolved = canonicalName(c);
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
    if (
      parsed.title === undefined &&
      parsed.schedule === undefined &&
      parsed.prompt === undefined &&
      parsed.enabled === undefined
    ) {
      return c.json(
        errorBody("invalid_request", "at least one of title, schedule, prompt, enabled is required"),
        400,
      );
    }
    // The one rule a client cannot discover from the shape: an edit to a routine's title or
    // schedule must carry its instruction too. There is no update action on the backend, so an edit
    // is a recreate, and the backend only ever reports a 100-character PREVIEW of a stored prompt.
    // Rebuilding a routine from that preview would silently truncate the user's own instruction, so
    // the request is refused instead of quietly damaging the routine.
    if (patchNeedsRewrite(parsed) && parsed.prompt === undefined) {
      return c.json(
        errorBody(
          "invalid_request",
          "prompt is required when title or schedule changes: hermes has no cron update action and reports only a truncated prompt preview, so the routine is recreated",
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
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    try {
      await bots.deleteRoutine(resolved.name, c.req.param("id") ?? "");
      return c.body(null, 204);
    } catch (err) {
      return failure(c, err);
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
}

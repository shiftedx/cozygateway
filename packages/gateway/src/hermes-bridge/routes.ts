import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  type ErrorBody,
  type ErrorCode,
  BotChatSendRequestSchema,
  BotCreateRequestSchema,
  BotFocusRequestSchema,
  ContractViolation,
  assertValid,
} from "cozygateway-contract";

import { HermesRpcError, HermesUnavailable } from "./client.ts";
import { RuntimeSessionUnknown } from "./chat-turns.ts";
import type { BotsSurface } from "./bridge.ts";
import { BotDeleteBlocked, BotDeleteFailed, BotDeleteRefused, BotNameInvalid, BotNameTaken } from "./crud.ts";

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

function failure(c: Context<Env>, err: unknown) {
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
      return c.json({ bot: created.bot, metaOutcome: created.metaOutcome }, 201);
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
    const name = c.req.param("name");
    try {
      await bots.deleteBot(name);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof BotDeleteRefused) return c.json(errorBody("invalid_request", err.message), 400);
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

  app.get("/bots/:name/chat", requireDevice, async (c) => {
    const name = c.req.param("name");
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
    const name = c.req.param("name");
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
    const name = c.req.param("name");
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

  app.get("/bots/:name/sessions", requireDevice, async (c) => {
    const name = c.req.param("name");
    try {
      return c.json({ sessions: await bots.sessions(name, SESSION_LIST_LIMIT) });
    } catch (err) {
      return failure(c, err);
    }
  });
}

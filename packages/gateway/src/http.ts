import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import {
  type ErrorBody,
  type ErrorCode,
  type GatewayInfo,
  type Message,
  type PresenceState,
  type RichBlock,
  ContractViolation,
  CreateThreadRequestSchema,
  PairRequestSchema,
  PushRegisterRequestSchema,
  RenameThreadRequestSchema,
  SendMessageRequestSchema,
  assertValid,
} from "cozygateway-contract";

import { Value } from "@sinclair/typebox/value";
import { RegisterRequestSchema as RelayRegisterRequestSchema } from "cozygateway-relay";

import type { GatewayConfig } from "./config.ts";
import type { Storage, ThreadRow } from "./storage.ts";
import { hashToken, mintDeviceToken } from "./auth.ts";
import { BackendUnavailable } from "./errors.ts";
import type { BotsSurface } from "./hermes-bridge/bridge.ts";
import { registerBotRoutes } from "./hermes-bridge/routes.ts";
import type { MediaFetch, MediaLimiter, MediaLookup } from "./hermes-bridge/media.ts";
import type { PhotoRateLimiter } from "./hermes-bridge/photos.ts";

export interface AppDeps {
  storage: Storage;
  /** The bots bridge, present only when a hermes bridge is configured. When absent the `/bots`
   *  routes are not registered at all and the capability is not advertised, so an app probing
   *  `GatewayInfo.capabilities` sees the truth. */
  bots?: BotsSurface;
  /** Test seam for `GET /bots/:name/media`. Left undefined in production, where the proxy uses the
   *  global `fetch`; a test supplies its own so the media rules can be exercised without a socket. */
  mediaFetch?: MediaFetch;
  /** Test seams alongside `mediaFetch`, for the same reason: the resolved-address rule and the
   *  concurrency cap are as much a part of what the proxy will dial as the literal rules are, and a
   *  rule that can only be exercised against real DNS is a rule that does not get tested. Left
   *  undefined in production, where the proxy uses `dns.lookup` and the one process-wide limiter. */
  mediaLookup?: MediaLookup;
  mediaLimiter?: MediaLimiter;
  mediaQueueWaitMs?: number;
  /** Test seams for `POST /bots/:name/chat/photos` (capability 9), for the same reason the media
   *  ones exist: the in-flight bound and the per-device rate limit are as much a part of what the
   *  route will do as the sniffing rules are, and neither can be exercised at production values
   *  inside a test. Left undefined in production, where the route builds its own. */
  photoLimiter?: MediaLimiter;
  photoQueueWaitMs?: number;
  photoRateLimiter?: PhotoRateLimiter;
  /** Test seam for the private relay boundary. Production uses the global fetch. */
  pushRelayFetch?: typeof fetch;
  config: GatewayConfig;
  gatewayInfo: GatewayInfo;
  presenceOf: (agentId: string) => PresenceState;
  submitUserMessage: (threadId: string, blocks: RichBlock[]) => Message;
  interruptThread: (threadId: string) => "interrupting" | "idle";
  /** Resolve one pending approval (contract v1.md section 5a). The gateway derives everything
   *  that matters -- the turn, the backend session, whether the approval is still pending --
   *  from its own record of the correlation id inside this thread; the request supplies no
   *  profile, agent, or turn reference of its own. `deviceId` is the authenticated principal,
   *  carried through only so the audit line can name who decided. */
  resolveApproval: (input: {
    threadId: string;
    toolCallId: string;
    decision: "approve" | "deny";
    deviceId: string;
  }) => Promise<"approved" | "denied" | "unknown" | "not_pending" | "expired" | "unsupported">;
  onDeviceRevoked: (deviceId: string) => void;
  now: () => number;
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

type Env = { Variables: { deviceId: string } };

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  const requireDevice = createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const device = token === "" ? undefined : deps.storage.deviceByTokenHash(hashToken(token));
    if (device === undefined) {
      return c.json(errorBody("unauthorized", "missing or unknown device token"), 401);
    }
    deps.storage.touchDevice(device.id, deps.now());
    c.set("deviceId", device.id);
    await next();
  });

  const readBody = async (c: Context<Env>): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  // `deps.gatewayInfo` is a static snapshot taken once at server assembly (it also seeds `/pair`
  // and the `ready` frame), so it cannot carry live bridge state. `bridges` is computed fresh on
  // every call instead: it is the whole point of issue #63 that a monitor polling this route sees
  // the hermes link's CURRENT liveness, not whatever was true when the process started.
  app.get("/health", (c) =>
    c.json(
      deps.bots === undefined
        ? deps.gatewayInfo
        : { ...deps.gatewayInfo, bridges: { hermes: deps.bots.health() } },
    ),
  );

  // Readiness (follow-up to issue #63, tracked separately): `/health` answers "is the process
  // alive", which is what a supervisor restarts on. `/ready` answers a different question, "will
  // a send actually deliver right now", which is what a router or monitor should alarm or
  // de-route on instead. The two must never be pointed at the same action: an offline hermes link
  // is not fixed by restarting the gateway process, so wiring a restart to this route would just
  // cycle a healthy process while the real fault -- a dead upstream bridge -- sits untouched.
  //
  // Same synchronous liveness snapshot `/health` reads (`deps.bots.health()`), no new I/O per
  // request, for the same reason `/health` does not: a readiness probe that has to make its own
  // network call to answer is itself a new way to go dark.
  app.get("/ready", (c) => {
    if (deps.bots === undefined) return c.json({ ready: true });
    const bridges = { hermes: deps.bots.health() };
    const allOnline = Object.values(bridges).every((bridge) => bridge.online);
    return c.json({ ready: allOnline, bridges }, allOnline ? 200 : 503);
  });

  app.post("/pair", async (c) => {
    const body = await readBody(c);
    let pairRequest;
    try {
      pairRequest = assertValid(PairRequestSchema, body);
    } catch (err) {
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    if (deps.storage.consumeSetupCode(pairRequest.setupCode, deps.now()) !== "ok") {
      return c.json(errorBody("setup_code_invalid", "setup code is unknown, used, or expired"), 401);
    }
    const { token, tokenHash } = mintDeviceToken();
    const device = {
      id: randomUUID(),
      name: pairRequest.deviceName,
      tokenHash,
      createdAt: deps.now(),
    };
    deps.storage.createDevice(device);
    return c.json({
      deviceToken: token,
      device: { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: null },
      gateway: deps.gatewayInfo,
    });
  });

  app.get("/devices", requireDevice, (c) => c.json(deps.storage.listDevices()));

  app.delete("/devices/:id", requireDevice, (c) => {
    const id = c.req.param("id");
    if (!deps.storage.deleteDevice(id)) {
      return c.json(errorBody("not_found", "no such device"), 404);
    }
    deps.onDeviceRevoked(id);
    return c.json({ ok: true });
  });

  const parseOr400 = <S extends Parameters<typeof assertValid>[0]>(
    c: Context<Env>,
    schema: S,
    body: unknown,
  ) => {
    try {
      return { ok: true as const, value: assertValid(schema, body) };
    } catch (err) {
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return { ok: false as const, response: c.json(errorBody("invalid_request", detail), 400) };
    }
  };

  const threadToWire = (t: ThreadRow) => ({
    id: t.id,
    agentId: t.agentId,
    title: t.title,
    createdAt: t.createdAt,
    lastMessageAt: t.lastMessageAt,
  });

  app.get("/agents", requireDevice, (c) =>
    c.json(
      deps.storage.listAgents().map((a) => ({
        id: a.id,
        name: a.name,
        ...(a.avatar === null ? {} : { avatar: a.avatar }),
        backend: a.backend,
        presence: deps.presenceOf(a.id),
      })),
    ),
  );

  app.get("/threads", requireDevice, (c) => c.json(deps.storage.listThreads().map(threadToWire)));

  app.post("/threads", requireDevice, async (c) => {
    const parsed = parseOr400(c, CreateThreadRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    if (deps.storage.agentById(parsed.value.agentId) === undefined) {
      return c.json(errorBody("not_found", "no such agent"), 404);
    }
    const thread = {
      id: randomUUID(),
      agentId: parsed.value.agentId,
      title: parsed.value.title ?? "New thread",
      createdAt: deps.now(),
    };
    deps.storage.createThread(thread);
    return c.json({ ...thread, lastMessageAt: null });
  });

  app.patch("/threads/:id", requireDevice, async (c) => {
    const parsed = parseOr400(c, RenameThreadRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    if (!deps.storage.renameThread(c.req.param("id"), parsed.value.title)) {
      return c.json(errorBody("not_found", "no such thread"), 404);
    }
    const thread = deps.storage.threadById(c.req.param("id"));
    return thread === undefined
      ? c.json(errorBody("not_found", "no such thread"), 404)
      : c.json(threadToWire(thread));
  });

  app.delete("/threads/:id", requireDevice, (c) => {
    if (!deps.storage.archiveThread(c.req.param("id"))) {
      return c.json(errorBody("not_found", "no such thread or already archived"), 404);
    }
    return c.json({ ok: true });
  });

  app.get("/threads/:id/messages", requireDevice, (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined) return c.json(errorBody("not_found", "no such thread"), 404);
    const beforeRaw = c.req.query("before");
    const limitRaw = c.req.query("limit");
    const before = beforeRaw === undefined ? null : Number.parseInt(beforeRaw, 10);
    const limit = Math.min(limitRaw === undefined ? 50 : Number.parseInt(limitRaw, 10), 200);
    if ((before !== null && (Number.isNaN(before) || before < 1)) || Number.isNaN(limit) || limit < 1) {
      return c.json(errorBody("invalid_request", "bad before/limit"), 400);
    }
    return c.json({ messages: deps.storage.messagesBefore(thread.id, before, limit) });
  });

  app.post("/threads/:id/messages", requireDevice, async (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined) return c.json(errorBody("not_found", "no such thread"), 404);
    if (thread.archivedAt !== null) {
      return c.json(errorBody("thread_archived", "thread is archived"), 409);
    }
    const parsed = parseOr400(c, SendMessageRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    try {
      const message = deps.submitUserMessage(thread.id, parsed.value.blocks);
      return c.json({ message });
    } catch (err) {
      if (err instanceof BackendUnavailable) {
        return c.json(errorBody("backend_unavailable", err.message), 503);
      }
      throw err;
    }
  });

  app.post("/threads/:id/interrupt", requireDevice, (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined) return c.json(errorBody("not_found", "no such thread"), 404);
    const outcome = deps.interruptThread(thread.id);
    if (outcome === "idle") return c.body(null, 204);
    return c.json({ status: "interrupting" }, 202);
  });

  // Approval verbs (contract v1.md section 5a). Two sibling routes rather than one route with a
  // decision in the body: the verb is the whole request, exactly as POST /threads/:id/interrupt
  // takes no body at all, and a notification action button maps to a URL with nothing to encode.
  // Only per-call scope exists on the wire, so there is nothing else for a client to say.
  const approvalRoute = (decision: "approve" | "deny") =>
    async (c: Context<Env>) => {
      // Read through a generic Context (this handler is shared by two routes), so the params are
      // typed as possibly absent; the router only reaches here with both present.
      const thread = deps.storage.threadById(c.req.param("id") ?? "");
      if (thread === undefined) return c.json(errorBody("not_found", "no such thread"), 404);
      const outcome = await deps.resolveApproval({
        threadId: thread.id,
        toolCallId: c.req.param("toolCallId") ?? "",
        decision,
        deviceId: c.get("deviceId"),
      });
      switch (outcome) {
        case "approved":
        case "denied":
          return c.json({ status: outcome }, 202);
        case "unknown":
          return c.json(errorBody("not_found", "no such pending approval"), 404);
        case "expired":
          return c.json(errorBody("approval_expired", "the approval expired before it was resolved"), 409);
        case "not_pending":
          return c.json(errorBody("approval_not_pending", "the approval is no longer pending"), 409);
        case "unsupported":
          return c.json(
            errorBody("backend_unavailable", "the agent backend cannot resolve approvals"),
            503,
          );
      }
    };

  app.post("/threads/:id/approvals/:toolCallId/approve", requireDevice, approvalRoute("approve"));
  app.post("/threads/:id/approvals/:toolCallId/deny", requireDevice, approvalRoute("deny"));

  app.post("/push/register", requireDevice, async (c) => {
    const body = await c.req.text();
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      decoded = undefined;
    }

    // The frozen v1 route predates the relay proxy and owns the same path. Its distinct body stays
    // local. A body in the RELAY's register shape is wire data and is forwarded byte for byte.
    // Anything matching neither shape keeps the frozen v1 answer, 400 invalid_request, whether or
    // not a relay is configured: garbage must never leave the gateway, and the conformance suite
    // pins that 400 on gateways with no relay at all.
    let registration;
    try {
      registration = assertValid(PushRegisterRequestSchema, decoded);
    } catch {
      registration = undefined;
    }
    if (registration !== undefined) {
      deps.storage.savePushRegistration(c.get("deviceId"), registration);
      return c.json({ ok: true });
    }
    if (!Value.Check(RelayRegisterRequestSchema, decoded)) {
      return c.json(errorBody("invalid_request", "malformed push registration body"), 400);
    }
    if (deps.config.pushRelayUrl === undefined) {
      return c.json(errorBody("not_found", "push relay proxy is not configured"), 404);
    }
    const relayFetch = deps.pushRelayFetch ?? fetch;
    const upstream = await relayFetch(`${deps.config.pushRelayUrl.replace(/\/+$/, "")}/register`, {
      method: "POST",
      headers: { "content-type": c.req.header("content-type") ?? "application/json" },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  });

  app.delete("/push/register/:pushId", requireDevice, async (c) => {
    if (deps.config.pushRelayUrl === undefined) {
      return c.json(errorBody("not_found", "push relay proxy is not configured"), 404);
    }
    const relayFetch = deps.pushRelayFetch ?? fetch;
    const pushId = encodeURIComponent(c.req.param("pushId"));
    const upstream = await relayFetch(
      `${deps.config.pushRelayUrl.replace(/\/+$/, "")}/register/${pushId}`,
      { method: "DELETE" },
    );
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  });

  // Vendor extension, registered last so it cannot shadow a core route (contract/ext-bots-v1.md).
  if (deps.bots !== undefined) {
    registerBotRoutes(
      app,
      requireDevice,
      deps.bots,
      {
        ...(deps.mediaFetch === undefined ? {} : { fetchImpl: deps.mediaFetch }),
        ...(deps.mediaLookup === undefined ? {} : { lookup: deps.mediaLookup }),
        ...(deps.mediaLimiter === undefined ? {} : { limiter: deps.mediaLimiter }),
        ...(deps.mediaQueueWaitMs === undefined ? {} : { queueWaitMs: deps.mediaQueueWaitMs }),
      },
      {
        ...(deps.photoLimiter === undefined ? {} : { limiter: deps.photoLimiter }),
        ...(deps.photoQueueWaitMs === undefined ? {} : { queueWaitMs: deps.photoQueueWaitMs }),
        ...(deps.photoRateLimiter === undefined ? {} : { rateLimiter: deps.photoRateLimiter }),
        now: deps.now,
      },
    );
  }

  app.notFound((c) => c.json(errorBody("not_found", "no such route"), 404));
  app.onError((err, c) => c.json(errorBody("internal", "unexpected gateway fault"), 500));

  return app;
}

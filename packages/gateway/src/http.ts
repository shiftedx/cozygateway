import { createHash, randomUUID } from "node:crypto";

import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import {
  type ErrorBody,
  type ErrorCode,
  type GatewayInfo,
  type AttachHealthSummary,
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

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { GatewayConfig } from "./config.ts";
import type { Storage, ThreadRow } from "./storage.ts";
import { hashToken, mintDeviceToken } from "./auth.ts";
import { BackendUnavailable } from "./errors.ts";
import type { BotControlSurface, BotsSurface } from "./hermes-bridge/bridge.ts";
import type { MemorySurface } from "./hermes-bridge/memory.ts";
import { registerBotRoutes } from "./hermes-bridge/routes.ts";
import { resolveByteRange } from "./hermes-bridge/routes.ts";
import type {
  MediaFetch,
  MediaLimiter,
  MediaLookup,
} from "./hermes-bridge/media.ts";
import {
  ATTACH_MEDIA_TTL_MS,
  PhotoRefused,
  readCappedBody,
  sniffImageType,
  type PhotoRateLimiter,
} from "./hermes-bridge/photos.ts";
import {
  ASSISTANT_MEDIA_TYPES,
  acceptAssistantMediaBytes,
} from "./hermes-bridge/assistant-media.ts";
import { attachmentDisposition, safeFilename } from "./hermes-bridge/documents.ts";
import type { AttachV1MediaDescriptor } from "./adapters/attach/protocol-v1.ts";
import { resolveAttachBearer } from "./adapters/attach/token-auth.ts";
import type { MobileNodeMediaDescriptor } from "./mobile-node.ts";
import { PAIR_REQUEST_MAX_BYTES, PairingAdmission, readPairBody, type PairingAttemptLimiter } from "./pairing-admission.ts";

/** The relay's register body, mirrored here rather than imported: the gateway's docker image
 *  bundles only its own package, so a runtime import of cozygateway-relay crashes the container
 *  (proven in production, 2026-08-20). Kept structurally identical to
 *  packages/relay/src/schemas.ts RegisterRequestSchema; the relay still authoritatively validates
 *  every forwarded body, so drift here can only over- or under-eagerly 400, never corrupt. */
const RelayRegisterRequestSchema = Type.Object({
  platform: Type.Union([
    Type.Literal("webhook"),
    Type.Literal("apns"),
    Type.Literal("apns-liveactivity"),
  ]),
  token: Type.String({ minLength: 1, maxLength: 2048 }),
  environment: Type.Optional(
    Type.Union([Type.Literal("development"), Type.Literal("production")]),
  ),
});

const LiveActivityRegisterRequestSchema = Type.Object(
  {
    activityId: Type.String({ minLength: 1, maxLength: 128 }),
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    conversationId: Type.String({ minLength: 1, maxLength: 160 }),
    bot: Type.String({ minLength: 1, maxLength: 120 }),
    token: Type.String({
      minLength: 32,
      maxLength: 512,
      pattern: "^[0-9a-f]+$",
    }),
    environment: Type.Union([
      Type.Literal("development"),
      Type.Literal("production"),
    ]),
  },
  { additionalProperties: false },
);

export interface AppDeps {
  storage: Storage;
  /** Test-only override for the gateway-wide `/pair` bucket. Production leaves this absent and
   *  builds its limiter from `now`; a long-lived black-box harness supplies one with virtual time. */
  pairingAdmission?: PairingAttemptLimiter;
  /** The bots bridge, present only when a hermes bridge is configured. When absent the `/bots`
   *  routes are not registered at all and the capability is not advertised, so an app probing
   *  `GatewayInfo.capabilities` sees the truth. */
  bots?: BotControlSurface | BotsSurface;
  /** Profile-local memory travels only over the attached plugin's bounded management lane. */
  memory?: MemorySurface;
  /** attach-v1 bearer token → authenticated agent. Enables only the media side channel; device
   * routes never accept this credential. */
  attachTokens?: ReadonlyMap<string, string>;
  /** Per-agent media rollout gate, evaluated after constant-time attach authentication. */
  attachMediaAllowed?: (agentId: string) => boolean;
  /** A device-authenticated lease claim for one phone-selected binary payload. */
  beginMobileMediaUpload?: (deviceId: string, requestId: string, lease: string) =>
    | { agentId: string; complete: (media: MobileNodeMediaDescriptor | undefined) => boolean }
    | undefined;
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
  /** Synchronous, aggregate attach-v1 state for operator health routes only. */
  attachHealth?: () => AttachHealthSummary;
  /** Operator surface for attach-v1 projection dead letters (issue #193). A dead letter blocks
   *  every later event for its agent, so it must be listable and releasable without DB surgery. */
  attachDeadLetters?: () => Array<{
    agentId: string; sequence: number; eventId: string; kind: string;
    attempts: number; error: string | null; deadLetteredAt: number; receivedAt: number;
  }>;
  /** Releases the FIRST dead letter for an agent and immediately retries projection. */
  releaseAttachDeadLetter?: (agentId: string, eventId: string) => boolean;
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
  }) => Promise<
    | "approved"
    | "denied"
    | "unknown"
    | "not_pending"
    | "expired"
    | "unsupported"
  >;
  onDeviceRevoked: (deviceId: string) => void;
  now: () => number;
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/** A 415 that does not say what arrived is a 415 the producer has to guess about, so the received
 *  `Content-Type` is echoed. It is an attacker-controlled header, so only MIME token characters
 *  survive and the result is truncated: nothing here can carry markup, a newline, or a slice of the
 *  uploaded payload back out in the response body. */
function sanitizedContentType(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9!#$&^_.+/-]/g, "").slice(0, 80);
  return cleaned.length === 0 ? "(absent)" : cleaned;
}

type Env = { Variables: { deviceId: string } };

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const pairingAdmission = deps.pairingAdmission ?? new PairingAdmission(deps.now);

  const requireDevice = createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const device =
      token === ""
        ? undefined
        : deps.storage.deviceByTokenHash(hashToken(token));
    if (device === undefined) {
      return c.json(
        errorBody("unauthorized", "missing or unknown device token"),
        401,
      );
    }
    deps.storage.touchDevice(device.id, deps.now());
    c.set("deviceId", device.id);
    await next();
  });

  const requireAttach = createMiddleware<Env>(async (c, next) => {
    const agentId =
      deps.attachTokens === undefined
        ? undefined
        : resolveAttachBearer(deps.attachTokens, c.req.header("authorization"));
    if (agentId === undefined)
      return c.json(
        errorBody("unauthorized", "missing or unknown attach token"),
        401,
      );
    await next();
  });
  /** Media is an optional rollout; attach-authenticated receipt reads must remain available even
   * when uploads are disabled for this profile. */
  const requireAttachMedia = createMiddleware<Env>(async (c, next) => {
    const agentId =
      deps.attachTokens === undefined
        ? undefined
        : resolveAttachBearer(deps.attachTokens, c.req.header("authorization"));
    if (agentId === undefined)
      return c.json(
        errorBody("unauthorized", "missing or unknown attach token"),
        401,
      );
    if (deps.attachMediaAllowed?.(agentId) === false) {
      return c.json(
        errorBody("invalid_request", "attach media is disabled for this agent"),
        403,
      );
    }
    await next();
  });
  const attachAgent = (c: Context<Env>): string => {
    return resolveAttachBearer(
      deps.attachTokens!,
      c.req.header("authorization"),
    )!;
  };

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
    c.json({
      ...(deps.bots === undefined
        ? deps.gatewayInfo
        : { ...deps.gatewayInfo, bridges: { hermes: deps.bots.health() } }),
      ...(deps.attachHealth === undefined ? {} : { attach: deps.attachHealth() }),
    }),
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
    if (deps.bots === undefined) return c.json({ ready: true, ...(deps.attachHealth === undefined ? {} : { attach: deps.attachHealth() }) });
    const bridges = { hermes: deps.bots.health() };
    const allOnline = Object.values(bridges).every((bridge) => bridge.online);
    return c.json({ ready: allOnline, bridges, ...(deps.attachHealth === undefined ? {} : { attach: deps.attachHealth() }) }, allOnline ? 200 : 503);
  });

  app.post("/pair", async (c) => {
    const body = await readPairBody(c.req.raw);
    if (body.kind === "too_large") {
      return c.json(
        errorBody("invalid_request", `pairing request is over the ${PAIR_REQUEST_MAX_BYTES} byte cap`),
        413,
      );
    }
    const retryAfter = pairingAdmission.attempt();
    if (retryAfter !== undefined) {
      return c.json(
        errorBody("invalid_request", "too many pairing attempts; try again later"),
        429,
        { "retry-after": String(retryAfter) },
      );
    }
    let pairRequest;
    try {
      pairRequest = assertValid(PairRequestSchema, body.value);
    } catch (err) {
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    if (
      deps.storage.consumeSetupCode(pairRequest.setupCode, deps.now()) !== "ok"
    ) {
      return c.json(
        errorBody(
          "setup_code_invalid",
          "setup code is unknown, used, or expired",
        ),
        401,
      );
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
      device: {
        id: device.id,
        name: device.name,
        createdAt: device.createdAt,
        lastSeenAt: null,
      },
      gateway: deps.gatewayInfo,
    });
  });

  app.get("/devices", requireDevice, (c) => c.json(deps.storage.listDevices()));

  // Issue #193's operator surface. A projection dead letter head-of-line blocks its agent's
  // whole event stream; before these routes the only remedies were DB surgery or a redeploy.
  app.get("/attach/deadletters", requireDevice, (c) =>
    c.json({ deadLetters: deps.attachDeadLetters?.() ?? [] }));

  app.post("/attach/deadletters/release", requireDevice, async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { agentId?: unknown; eventId?: unknown }
      | undefined;
    if (body === undefined || typeof body.agentId !== "string" || typeof body.eventId !== "string")
      return c.json(errorBody("invalid_request", "agentId and eventId are required"), 400);
    if (deps.releaseAttachDeadLetter === undefined)
      return c.json(errorBody("not_found", "attach is not configured"), 404);
    if (!deps.releaseAttachDeadLetter(body.agentId, body.eventId))
      return c.json(errorBody("not_found", "not the first dead letter for that agent"), 404);
    return c.json({ released: true });
  });

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
      const detail =
        err instanceof ContractViolation ? err.message : "malformed body";
      return {
        ok: false as const,
        response: c.json(errorBody("invalid_request", detail), 400),
      };
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

  app.get("/threads", requireDevice, (c) =>
    c.json(deps.storage.listThreads().map(threadToWire)),
  );

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
      return c.json(
        errorBody("not_found", "no such thread or already archived"),
        404,
      );
    }
    return c.json({ ok: true });
  });

  app.get("/threads/:id/messages", requireDevice, (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined)
      return c.json(errorBody("not_found", "no such thread"), 404);
    const beforeRaw = c.req.query("before");
    const limitRaw = c.req.query("limit");
    const before =
      beforeRaw === undefined ? null : Number.parseInt(beforeRaw, 10);
    const limit = Math.min(
      limitRaw === undefined ? 50 : Number.parseInt(limitRaw, 10),
      200,
    );
    if (
      (before !== null && (Number.isNaN(before) || before < 1)) ||
      Number.isNaN(limit) ||
      limit < 1
    ) {
      return c.json(errorBody("invalid_request", "bad before/limit"), 400);
    }
    return c.json({
      messages: deps.storage.messagesBefore(thread.id, before, limit),
    });
  });

  app.post("/threads/:id/messages", requireDevice, async (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined)
      return c.json(errorBody("not_found", "no such thread"), 404);
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
    if (thread === undefined)
      return c.json(errorBody("not_found", "no such thread"), 404);
    const outcome = deps.interruptThread(thread.id);
    if (outcome === "idle") return c.body(null, 204);
    return c.json({ status: "interrupting" }, 202);
  });

  // Approval verbs (contract v1.md section 5a). Two sibling routes rather than one route with a
  // decision in the body: the verb is the whole request, exactly as POST /threads/:id/interrupt
  // takes no body at all, and a notification action button maps to a URL with nothing to encode.
  // Only per-call scope exists on the wire, so there is nothing else for a client to say.
  const approvalRoute =
    (decision: "approve" | "deny") => async (c: Context<Env>) => {
      // Read through a generic Context (this handler is shared by two routes), so the params are
      // typed as possibly absent; the router only reaches here with both present.
      const thread = deps.storage.threadById(c.req.param("id") ?? "");
      if (thread === undefined)
        return c.json(errorBody("not_found", "no such thread"), 404);
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
          return c.json(
            errorBody(
              "backend_unavailable",
              "the agent backend cannot resolve approvals",
            ),
            503,
          );
      }
    };

  app.post(
    "/threads/:id/approvals/:toolCallId/approve",
    requireDevice,
    approvalRoute("approve"),
  );
  app.post(
    "/threads/:id/approvals/:toolCallId/deny",
    requireDevice,
    approvalRoute("deny"),
  );

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
      return c.json(
        errorBody("invalid_request", "malformed push registration body"),
        400,
      );
    }
    if (deps.config.pushRelayUrl === undefined) {
      return c.json(
        errorBody("not_found", "push relay proxy is not configured"),
        404,
      );
    }
    const relayFetch = deps.pushRelayFetch ?? fetch;
    const upstream = await relayFetch(
      `${deps.config.pushRelayUrl.replace(/\/+$/, "")}/register`,
      {
        method: "POST",
        headers: {
          "content-type": c.req.header("content-type") ?? "application/json",
        },
        body,
      },
    );
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  });

  app.delete("/push/register/:pushId", requireDevice, async (c) => {
    if (deps.config.pushRelayUrl === undefined) {
      return c.json(
        errorBody("not_found", "push relay proxy is not configured"),
        404,
      );
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

  app.post("/push/live-activities/register", requireDevice, async (c) => {
    const decoded = await readBody(c);
    if (!Value.Check(LiveActivityRegisterRequestSchema, decoded)) {
      return c.json(
        errorBody("invalid_request", "malformed Live Activity registration"),
        400,
      );
    }
    if (deps.config.pushRelayUrl === undefined) {
      return c.json(
        errorBody("not_found", "push relay proxy is not configured"),
        404,
      );
    }
    const relayFetch = deps.pushRelayFetch ?? fetch;
    const relayBase = deps.config.pushRelayUrl.replace(/\/+$/, "");
    const upstream = await relayFetch(`${relayBase}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "apns-liveactivity",
        token: decoded.token,
        environment: decoded.environment,
      }),
    });
    if (!upstream.ok) {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: upstream.headers,
      });
    }
    const result = (await upstream.json()) as { pushId?: unknown };
    if (typeof result.pushId !== "string" || result.pushId.length === 0) {
      return c.json(errorBody("internal", "relay returned no push id"), 502);
    }
    const previous = deps.storage.saveLiveActivityRegistration({
      deviceId: c.get("deviceId"),
      activityId: decoded.activityId,
      runId: decoded.runId,
      conversationId: decoded.conversationId,
      bot: decoded.bot,
      pushId: result.pushId,
      createdAt: deps.now(),
    });
    if (previous !== undefined && previous !== result.pushId) {
      void relayFetch(`${relayBase}/register/${encodeURIComponent(previous)}`, {
        method: "DELETE",
      });
    }
    return c.json({ ok: true });
  });

  app.delete("/push/live-activities/:activityId", requireDevice, async (c) => {
    const row = deps.storage.deleteLiveActivityRegistration(
      c.get("deviceId"),
      c.req.param("activityId"),
    );
    if (row !== undefined && deps.config.pushRelayUrl !== undefined) {
      const relayFetch = deps.pushRelayFetch ?? fetch;
      await relayFetch(
        `${deps.config.pushRelayUrl.replace(/\/+$/, "")}/register/${encodeURIComponent(row.pushId)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
    }
    return c.body(null, 204);
  });

  // Vendor extension, registered last so it cannot shadow a core route (contract/ext-bots-v1.md).
  if (deps.bots !== undefined) {
    registerBotRoutes(
      app,
      requireDevice,
      deps.bots,
      {
        ...(deps.mediaFetch === undefined
          ? {}
          : { fetchImpl: deps.mediaFetch }),
        ...(deps.mediaLookup === undefined ? {} : { lookup: deps.mediaLookup }),
        ...(deps.mediaLimiter === undefined
          ? {}
          : { limiter: deps.mediaLimiter }),
        ...(deps.mediaQueueWaitMs === undefined
          ? {}
          : { queueWaitMs: deps.mediaQueueWaitMs }),
      },
      {
        ...(deps.photoLimiter === undefined
          ? {}
          : { limiter: deps.photoLimiter }),
        ...(deps.photoQueueWaitMs === undefined
          ? {}
          : { queueWaitMs: deps.photoQueueWaitMs }),
        ...(deps.photoRateLimiter === undefined
          ? {}
          : { rateLimiter: deps.photoRateLimiter }),
        now: deps.now,
      },
      deps.memory,
    );
  }

  /** The phone has no attach bearer. This is deliberately the same bounded attach_media store and
   * validation pipeline, but its authorization is the one live device/lease claim, never a spool. */
  app.post("/mobile-node/media/:requestId", requireDevice, async (c) => {
    const requestId = c.req.param("requestId");
    const lease = c.req.header("x-mobile-node-lease") ?? "";
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(requestId) || !/^[A-Za-z0-9_-]{43}$/.test(lease))
      return c.json(errorBody("invalid_request", "invalid mobile media request"), 400);
    const claim = deps.beginMobileMediaUpload?.(c.get("deviceId"), requestId, lease);
    if (claim === undefined)
      return c.json(errorBody("not_found", "mobile media request is not available"), 404);
    const fail = (status: 400 | 413 | 415 | 422, body: ErrorBody) => {
      claim.complete(undefined);
      return c.json(body, status);
    };
    const receivedType = c.req.header("content-type") ?? "";
    const mimeType = receivedType.split(";")[0]!.trim().toLowerCase();
    const acceptedType = ASSISTANT_MEDIA_TYPES.get(mimeType);
    if (acceptedType === undefined)
      return fail(415, errorBody("invalid_request", "media type is not on the gateway allowlist"));
    const declared = Number(c.req.header("content-length") ?? "");
    if (Number.isFinite(declared) && declared > acceptedType.maxBytes)
      return fail(413, errorBody("invalid_request", "media is over the byte cap"));
    let bytes: Uint8Array;
    try {
      bytes = await readCappedBody(c.req.raw.body, acceptedType.maxBytes);
      acceptAssistantMediaBytes(mimeType, bytes, sniffImageType);
    } catch {
      return fail(415, errorBody("invalid_request", "media bytes did not match the declared type"));
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filename = safeFilename(c.req.header("x-attach-filename") ?? "");
    if (filename === undefined)
      return fail(400, errorBody("invalid_request", "invalid attach media filename"));
    const descriptor: AttachV1MediaDescriptor = {
      mediaId: randomUUID().replaceAll("-", ""), mimeType, byteCount: bytes.byteLength, sha256, filename, family: acceptedType.kind,
      expiresAt: deps.now() + ATTACH_MEDIA_TTL_MS,
    };
    try {
      deps.storage.saveAttachMedia(claim.agentId, descriptor, bytes, deps.now());
    } catch {
      return fail(400, errorBody("invalid_request", "could not store mobile media"));
    }
    if (!claim.complete(descriptor)) {
      deps.storage.deleteUnreferencedAttachMedia(claim.agentId, descriptor.mediaId);
      return c.json(errorBody("invalid_request", "mobile media request expired or changed"), 409);
    }
    return c.json({ media: descriptor }, 201);
  });

  if (deps.attachTokens !== undefined && deps.attachTokens.size > 0) {
    app.get("/attach/v1/deliveries/:deliveryId", requireAttach, (c) => {
      const deliveryId = c.req.param("deliveryId");
      if (deliveryId.length === 0 || deliveryId.length > 256)
        return c.json(errorBody("invalid_request", "invalid delivery id"), 400);
      const receipt = deps.storage.attachScheduledDeliveryReceipt(
        attachAgent(c),
        deliveryId,
      );
      return receipt === undefined
        ? c.json(errorBody("not_found", "no such attach delivery"), 404)
        : c.json(receipt);
    });

    app.post("/attach/v1/media/:mediaId", requireAttachMedia, async (c) => {
      const mediaId = c.req.param("mediaId");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId)) {
        return c.json(
          errorBody("invalid_request", "invalid attach media id"),
          400,
        );
      }
      const receivedType = c.req.header("content-type") ?? "";
      const received = sanitizedContentType(receivedType);
      const mimeType = receivedType.split(";")[0]!.trim().toLowerCase();
      // The allowlist is documented MIME by MIME in contract/ext-bots-v1.md; the plugin policy
      // table mirrors that document, and this map is the runtime copy of it.
      const acceptedType = ASSISTANT_MEDIA_TYPES.get(mimeType);
      if (acceptedType === undefined)
        return c.json(
          {
            ...errorBody("invalid_request", `media type ${received} is not on the gateway allowlist`),
            reason: "content_type",
            receivedContentType: received,
          },
          415,
        );
      /** 413 names the cap for the DECLARED type, not the largest cap in the table, so a producer
       *  can act on the number instead of guessing which limit it hit. */
      const overCap = () =>
        c.json(
          {
            ...errorBody(
              "invalid_request",
              `media is over the ${acceptedType.maxBytes} byte cap for ${mimeType}`,
            ),
            reason: "too_large",
            limitBytes: acceptedType.maxBytes,
          },
          413,
        );
      const declared = Number(c.req.header("content-length") ?? "");
      if (Number.isFinite(declared) && declared > acceptedType.maxBytes) return overCap();
      let bytes: Uint8Array;
      try {
        bytes = await readCappedBody(c.req.raw.body, acceptedType.maxBytes);
        acceptAssistantMediaBytes(mimeType, bytes, sniffImageType);
      } catch (err) {
        // Every branch answers with gateway-authored prose. No error string from a layer that
        // touched the payload reaches the body, so no uploaded byte can be reflected.
        const reason = err instanceof PhotoRefused ? err.reason : "content_type";
        if (reason === "too_large") return overCap();
        if (reason === "empty")
          return c.json({ ...errorBody("invalid_request", "media carried no bytes"), reason }, 400);
        return c.json(
          {
            ...errorBody("invalid_request", `media bytes did not match the declared type ${mimeType}`),
            reason,
            receivedContentType: received,
          },
          415,
        );
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const claimedHash = (c.req.header("x-attach-sha256") ?? "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(claimedHash) || claimedHash !== sha256) {
        return c.json(
          {
            ...errorBody("invalid_request", "media sha256 mismatch"),
            reason: "digest",
          },
          422,
        );
      }
      const filename = safeFilename(c.req.header("x-attach-filename") ?? "");
      if (filename === undefined) {
        return c.json(
          errorBody("invalid_request", "invalid attach media filename"),
          400,
        );
      }
      const expiresRaw = c.req.header("x-attach-expires-at");
      const expiresAt =
        expiresRaw === undefined ? undefined : Number(expiresRaw);
      if (
        expiresAt !== undefined &&
        (!Number.isSafeInteger(expiresAt) || expiresAt <= deps.now())
      ) {
        return c.json(
          errorBody("invalid_request", "invalid attach media expiry"),
          400,
        );
      }
      const descriptor: AttachV1MediaDescriptor = {
        mediaId,
        mimeType,
        byteCount: bytes.byteLength,
        sha256,
        filename,
        family: acceptedType.kind,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
      try {
        const created = deps.storage.saveAttachMedia(
          attachAgent(c),
          descriptor,
          bytes,
          deps.now(),
        );
        return c.json({ media: descriptor }, created ? 201 : 200);
      } catch {
        return c.json(
          errorBody("invalid_request", "attach media id already exists"),
          409,
        );
      }
    });

    /** Atomic producer rollback. An absent id is success so a retry after a crash between local
     * spool cleanup and this request stays convergent; a referenced id is never removed. */
    app.delete("/attach/v1/media/:mediaId", requireAttachMedia, (c) => {
      const mediaId = c.req.param("mediaId");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId))
        return c.json(
          errorBody("invalid_request", "invalid attach media id"),
          400,
        );
      const result = deps.storage.deleteUnreferencedAttachMedia(
        attachAgent(c),
        mediaId,
      );
      if (result === "referenced")
        return c.json(
          errorBody("invalid_request", "attach media is already referenced"),
          409,
        );
      return c.body(null, 204);
    });

    app.get("/attach/v1/media/:mediaId", requireAttachMedia, (c) => {
      const mediaId = c.req.param("mediaId");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId))
        return c.json(
          errorBody("invalid_request", "invalid attach media id"),
          400,
        );
      const agentId = attachAgent(c);
      const info = deps.storage.attachMediaInfo(agentId, mediaId, deps.now());
      if (info === undefined)
        return c.json(errorBody("not_found", "no such attach media"), 404);
      const range = resolveByteRange(c.req.header("range"), info.size);
      if (range === null)
        return new Response(null, {
          status: 416,
          headers: {
            "content-range": `bytes */${info.size}`,
            "accept-ranges": "bytes",
          },
        });
      const start = range?.start ?? 0;
      const end = range?.end ?? info.size - 1;
      const bytes = deps.storage.attachMediaSlice(
        agentId,
        mediaId,
        start,
        end - start + 1,
        deps.now(),
      );
      if (bytes === undefined)
        return c.json(errorBody("not_found", "no such attach media"), 404);
      return new Response(bytes.slice().buffer as ArrayBuffer, {
        status: range === undefined ? 200 : 206,
        headers: {
          "content-type": info.mime,
          "content-length": String(bytes.byteLength),
          "accept-ranges": "bytes",
          "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff",
          "content-disposition": attachmentDisposition(info.descriptor.filename),
          ...(range === undefined
            ? {}
            : { "content-range": `bytes ${start}-${end}/${info.size}` }),
        },
      });
    });
  }

  app.notFound((c) => c.json(errorBody("not_found", "no such route"), 404));
  app.onError((err, c) =>
    c.json(errorBody("internal", "unexpected gateway fault"), 500),
  );

  return app;
}

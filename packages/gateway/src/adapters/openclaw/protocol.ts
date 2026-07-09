import { type Static, Type } from "@sinclair/typebox";
import { check } from "cozygateway-contract";

/** OpenClaw Gateway WS protocol v4 (docs.openclaw.ai/gateway/protocol), operator-client side.
 *  This is a THIRD PARTY wire we dial out to, versioned independently of the frozen cozygateway
 *  client contract v1. Frames are JSON text; envelopes are `{type:"req"|"res"|"event", ...}`.
 *  Objects stay open (unknown fields ignored); the `type`/`event`/`payload.type` discriminants
 *  stay closed, mirroring the attach protocol module's stance. */

export const PROTOCOL_VERSION = 4;

/** Silence beyond `policy.tickIntervalMs * 2` after the last tick closes the socket with this
 *  code (verified wire fact). */
export const TICK_TIMEOUT_CLOSE_CODE = 4000;

// ---------------------------------------------------------------------------------------------
// Inbound (server -> operator client) frames
// ---------------------------------------------------------------------------------------------

/** Sent by the server before a connect completes, when device-signed auth is required. The
 *  client echoes `nonce` back inside `connect.params.device.nonce`. */
export const ConnectChallengeEventSchema = Type.Object({
  type: Type.Literal("event"),
  event: Type.Literal("connect.challenge"),
  payload: Type.Object({
    nonce: Type.String(),
    ts: Type.Number(),
  }),
  seq: Type.Optional(Type.Number()),
  stateVersion: Type.Optional(Type.Number()),
});
export type ConnectChallengeEvent = Static<typeof ConnectChallengeEventSchema>;

/** The `connect` response on success. `payload.type` is the nested discriminant that separates
 *  this from any other ok response. */
export const HelloOkResponseSchema = Type.Object({
  type: Type.Literal("res"),
  id: Type.String(),
  ok: Type.Literal(true),
  payload: Type.Object({
    type: Type.Literal("hello-ok"),
    protocol: Type.Number(),
    server: Type.Object({
      version: Type.String(),
      connId: Type.String(),
    }),
    features: Type.Object({
      methods: Type.Array(Type.String()),
      events: Type.Array(Type.String()),
    }),
    auth: Type.Object({
      role: Type.String(),
      scopes: Type.Array(Type.String()),
    }),
    policy: Type.Object({
      maxPayload: Type.Number(),
      maxBufferedBytes: Type.Number(),
      tickIntervalMs: Type.Number(),
    }),
  }),
});
export type HelloOkResponse = Static<typeof HelloOkResponseSchema>;

/** Any other ok response (e.g. `chat.send`, `sessions.create`). The payload shape varies by
 *  method and is not fully pinned by the verified wire facts beyond method-specific fields
 *  called out inline (e.g. `sessionKey` for `sessions.create`), so it stays an open record here;
 *  callers narrow further by method as needed. */
export const OkResponseSchema = Type.Object({
  type: Type.Literal("res"),
  id: Type.String(),
  ok: Type.Literal(true),
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type OkResponse = Static<typeof OkResponseSchema>;

/** The generic error response envelope: `error.details.{code,reason}`. */
export const ErrorResponseSchema = Type.Object({
  type: Type.Literal("res"),
  id: Type.String(),
  ok: Type.Literal(false),
  error: Type.Object({
    details: Type.Object({
      code: Type.String(),
      reason: Type.String(),
    }),
  }),
});
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

/** Any correlated response frame that is not the hello-ok handshake response: ok or error. */
export const ResponseFrameSchema = Type.Union([OkResponseSchema, ErrorResponseSchema]);
export type ResponseFrame = Static<typeof ResponseFrameSchema>;

/** Streamed assistant-turn event. PINNED by the Task 8 live wire study
 *  (docs/specs/2026-07-08-openclaw-wire-study.md): the event name is literally `chat`, and a
 *  single `chat` event carries the whole turn lifecycle discriminated by `payload.state`
 *  (`delta` while streaming, then a terminal `final`/`error`/`aborted`). `sessionKey` is the
 *  session-identifying field. On a `delta`, `deltaText` is the incremental chunk and `replace:true`
 *  means it REPLACES the running text rather than appending; `message` is the cumulative assistant
 *  message STRUCT (an object), not a text snapshot, so running text is built from `deltaText`
 *  alone. A terminal event may omit `deltaText` and carries an optional `stopReason`. */
export const ChatEventSchema = Type.Object({
  type: Type.Literal("event"),
  event: Type.Literal("chat"),
  payload: Type.Object({
    sessionKey: Type.String(),
    state: Type.Union([
      Type.Literal("delta"),
      Type.Literal("final"),
      Type.Literal("error"),
      Type.Literal("aborted"),
    ]),
    runId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    seq: Type.Optional(Type.Number()),
    deltaText: Type.Optional(Type.String()),
    replace: Type.Optional(Type.Boolean()),
    message: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  }),
  seq: Type.Optional(Type.Number()),
  stateVersion: Type.Optional(Type.Number()),
});
export type ChatEvent = Static<typeof ChatEventSchema>;

/** Periodic keepalive event; payload shape is not pinned by the verified wire facts beyond
 *  "periodic keepalive", so it stays open. */
export const TickEventSchema = Type.Object({
  type: Type.Literal("event"),
  event: Type.Literal("tick"),
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  seq: Type.Optional(Type.Number()),
  stateVersion: Type.Optional(Type.Number()),
});
export type TickEvent = Static<typeof TickEventSchema>;

/** Agent progress event. The envelope (sessionKey + stream) is required; `data` stays an open
 *  record because only tool items are ever read, via `toolItemOf` below. PINNED by live capture
 *  (openclaw@2026.6.11, 2026-07-09, docs/specs/2026-07-09-openclaw-tool-chips-design.md):
 *  `sessionKey` rides every agent event, and streams observed are `lifecycle`, `assistant`,
 *  `item`, and `compaction`. */
export const AgentEventSchema = Type.Object({
  type: Type.Literal("event"),
  event: Type.Literal("agent"),
  payload: Type.Object({
    sessionKey: Type.String(),
    stream: Type.String(),
    data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  seq: Type.Optional(Type.Number()),
  stateVersion: Type.Optional(Type.Number()),
});
export type AgentEvent = Static<typeof AgentEventSchema>;

/** One OpenClaw tool call lifecycle edge, narrowed from an agent item frame. */
export interface AgentToolItem {
  toolCallId: string;
  name: string;
  phase: "start" | "end";
  failed: boolean;
}

/** THE one named site owning the tool-frame wire fact. PINNED by live capture (openclaw@2026.6.11,
 *  2026-07-09): tool activity rides `event:"agent"` with `stream:"item"` and `data.kind:"tool"`,
 *  as a start/end pair keyed by `data.toolCallId`; a failed call ends with `status:"failed"` and
 *  an `error` string. The protocol docs' `stream:"tool"` and `session.tool` were NEVER observed
 *  live and are deliberately not parsed. `title`/`meta`/`error` carry argument-derived content
 *  (file names, host paths) and are never surfaced by this narrowing. */
export function toolItemOf(event: AgentEvent): AgentToolItem | undefined {
  if (event.payload.stream !== "item") return undefined;
  const data = event.payload.data;
  if (data === undefined || data["kind"] !== "tool") return undefined;
  const phase = data["phase"];
  if (phase !== "start" && phase !== "end") return undefined;
  const toolCallId =
    typeof data["toolCallId"] === "string" && data["toolCallId"].length > 0
      ? data["toolCallId"]
      : typeof data["itemId"] === "string" && data["itemId"].length > 0
        ? data["itemId"]
        : undefined;
  if (toolCallId === undefined) return undefined;
  const name = typeof data["name"] === "string" && data["name"].length > 0 ? data["name"] : "tool";
  const failed = data["status"] === "failed" || data["error"] !== undefined;
  return { toolCallId, name, phase, failed };
}

/** The tagged union `parseServerFrame` returns. Each variant is the original frame's fields plus
 *  a `kind` tag, so e.g. a hello-ok frame still exposes `.payload` directly (no extra nesting). */
export type ServerFrame =
  | (HelloOkResponse & { kind: "hello-ok" })
  | (ConnectChallengeEvent & { kind: "challenge" })
  | (ResponseFrame & { kind: "response" })
  | (ChatEvent & { kind: "chat" })
  | (AgentEvent & { kind: "agent" })
  | (TickEvent & { kind: "tick" });

/** Discriminates on `type` ("res"/"event"), then for responses on `payload.type` (hello-ok vs a
 *  generic ok/error response) and for events on the literal `event` name (connect.challenge, tick,
 *  chat). Returns `undefined` for anything that fails every known shape, including an unknown
 *  `type`. */
export function parseServerFrame(raw: unknown): ServerFrame | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const envelope = raw as { type?: unknown };

  if (envelope.type === "res") {
    if (check(HelloOkResponseSchema, raw)) return { ...raw, kind: "hello-ok" };
    if (check(ResponseFrameSchema, raw)) return { ...raw, kind: "response" };
    return undefined;
  }

  if (envelope.type === "event") {
    if (check(ConnectChallengeEventSchema, raw)) return { ...raw, kind: "challenge" };
    if (check(TickEventSchema, raw)) return { ...raw, kind: "tick" };
    if (check(ChatEventSchema, raw)) return { ...raw, kind: "chat" };
    if (check(AgentEventSchema, raw)) return { ...raw, kind: "agent" };
    return undefined;
  }

  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Outbound (operator client -> server) request builders
// ---------------------------------------------------------------------------------------------

export interface ConnectDeviceInput {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  /** May also be supplied via the sibling top-level `nonce` on `ConnectRequestInput`; if both
   *  are given the top-level value wins (see `buildConnectRequest`). */
  nonce?: string;
}

export interface ConnectRequestInput {
  id: string;
  token: string;
  /** The challenge nonce being echoed back. Merged into `device.nonce`; ignored if no `device`
   *  is supplied (a token-only connect attempt, before any challenge has been issued). */
  nonce?: string;
  device?: ConnectDeviceInput;
  /** Connects as a valid client identity (default `gateway-client` in `backend` mode). The
   *  signature covers `client.id`/`client.mode`/`client.platform`/`client.deviceFamily`, so these
   *  MUST match what `signChallenge` signed (see the constants in client.ts). `mode` is a real
   *  OpenClaw client mode (e.g. `backend`), NOT the connection `role` (`operator`). */
  clientId?: string;
  clientMode?: string;
  clientVersion?: string;
  platform?: string;
  deviceFamily?: string;
}

export interface ConnectRequest {
  type: "req";
  id: string;
  method: "connect";
  params: {
    minProtocol: number;
    maxProtocol: number;
    client: { id: string; version: string; platform: string; deviceFamily: string; mode: string };
    role: "operator";
    scopes: string[];
    auth: { token: string };
    device?: { id: string; publicKey: string; signature: string; signedAt: number; nonce: string };
  };
}

/** Builds the first frame an operator client sends. Places the token at `params.auth.token`,
 *  pins `minProtocol === maxProtocol === PROTOCOL_VERSION`, and fixes `role: "operator"`. The
 *  `client` block presents a valid client identity (`gateway-client`/`backend` by default) whose
 *  id/mode/platform/deviceFamily are exactly the values the device-auth signature covers. */
export function buildConnectRequest(input: ConnectRequestInput): ConnectRequest {
  const device =
    input.device !== undefined
      ? {
          id: input.device.id,
          publicKey: input.device.publicKey,
          signature: input.device.signature,
          signedAt: input.device.signedAt,
          nonce: input.nonce ?? input.device.nonce ?? "",
        }
      : undefined;

  return {
    type: "req",
    id: input.id,
    method: "connect",
    params: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: input.clientId ?? "gateway-client",
        version: input.clientVersion ?? "0.0.0",
        platform: input.platform ?? "server",
        deviceFamily: input.deviceFamily ?? "server",
        mode: input.clientMode ?? "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      auth: { token: input.token },
      ...(device !== undefined ? { device } : {}),
    },
  };
}

/** `chat.send`/`sessions.create` (and any other post-handshake method) deliberately have NO typed
 *  request builder here, unlike `buildConnectRequest`: the client's `request(method, params)` is
 *  a single generic send path shared across every method the adapter calls today and any the
 *  protocol adds later, and it mints the frame's `id` itself (see `client.ts`). A typed builder
 *  per method would either duplicate that id-minting outside the client (two sources of truth for
 *  frame construction) or force `request()`'s signature away from "any method, any params" toward
 *  something method-aware, for no behavioral gain: `connect` alone is special enough (fixed
 *  role/scopes/protocol bounds, an optional signed `device` block) to earn its own builder. */

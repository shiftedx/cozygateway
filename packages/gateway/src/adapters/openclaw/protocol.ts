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

/** Streamed assistant-turn delta. `deltaText` is the incremental chunk; `message` is the
 *  cumulative snapshot so far; `replace:true` means `deltaText` REPLACES the snapshot rather
 *  than appending to it. Reply-end signaling is out of scope for this task (Task 5's concern).
 *
 *  ASSUMPTION (Task 8 to verify): the verified wire facts confirm the delta PAYLOAD shape but
 *  not the exact `event` name the server uses for it, so `event` stays an open string here and
 *  `parseServerFrame` discriminates this frame kind structurally, by the presence of a string
 *  `payload.deltaText`, rather than by asserting a specific event name. If the live study pins
 *  the name, tighten `event` to a literal then. */
export const ChatDeltaEventSchema = Type.Object({
  type: Type.Literal("event"),
  event: Type.String(),
  payload: Type.Object({
    deltaText: Type.String(),
    message: Type.String(),
    replace: Type.Optional(Type.Boolean()),
  }),
  seq: Type.Optional(Type.Number()),
  stateVersion: Type.Optional(Type.Number()),
});
export type ChatDeltaEvent = Static<typeof ChatDeltaEventSchema>;

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

/** The tagged union `parseServerFrame` returns. Each variant is the original frame's fields plus
 *  a `kind` tag, so e.g. a hello-ok frame still exposes `.payload` directly (no extra nesting). */
export type ServerFrame =
  | (HelloOkResponse & { kind: "hello-ok" })
  | (ConnectChallengeEvent & { kind: "challenge" })
  | (ResponseFrame & { kind: "response" })
  | (ChatDeltaEvent & { kind: "delta" })
  | (TickEvent & { kind: "tick" });

/** Discriminates on `type` ("res"/"event"), then for responses on `payload.type` (hello-ok vs a
 *  generic ok/error response) and for events on `event` (connect.challenge, tick) with a
 *  structural fallback to the delta shape (see the ASSUMPTION above `ChatDeltaEventSchema`).
 *  Returns `undefined` for anything that fails every known shape, including an unknown `type`. */
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
    if (check(ChatDeltaEventSchema, raw)) return { ...raw, kind: "delta" };
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
  clientId?: string;
  clientVersion?: string;
  platform?: string;
}

export interface ConnectRequest {
  type: "req";
  id: string;
  method: "connect";
  params: {
    minProtocol: number;
    maxProtocol: number;
    client: { id: string; version: string; platform: string; mode: "operator" };
    role: "operator";
    scopes: string[];
    auth: { token: string };
    device?: { id: string; publicKey: string; signature: string; signedAt: number; nonce: string };
  };
}

/** Builds the first frame an operator client sends. Places the token at `params.auth.token`,
 *  pins `minProtocol === maxProtocol === PROTOCOL_VERSION`, and fixes `role: "operator"`. */
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
        id: input.clientId ?? "cozygateway",
        version: input.clientVersion ?? "0.0.0",
        platform: input.platform ?? "server",
        mode: "operator",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      auth: { token: input.token },
      ...(device !== undefined ? { device } : {}),
    },
  };
}

export interface ChatSendRequestInput {
  id: string;
  sessionKey: string;
  text: string;
}

export interface ChatSendRequest {
  type: "req";
  id: string;
  method: "chat.send";
  params: { sessionKey: string; text: string };
}

export function buildChatSendRequest(input: ChatSendRequestInput): ChatSendRequest {
  return {
    type: "req",
    id: input.id,
    method: "chat.send",
    params: { sessionKey: input.sessionKey, text: input.text },
  };
}

export interface SessionsCreateRequestInput {
  id: string;
  /** The verified wire facts confirm the method name and its `sessionKey`-bearing response but
   *  not the request params shape, so this stays an open bag (empty by default) pending the
   *  live study (Task 8). */
  params?: Record<string, unknown>;
}

export interface SessionsCreateRequest {
  type: "req";
  id: string;
  method: "sessions.create";
  params: Record<string, unknown>;
}

export function buildSessionsCreateRequest(input: SessionsCreateRequestInput): SessionsCreateRequest {
  return {
    type: "req",
    id: input.id,
    method: "sessions.create",
    params: input.params ?? {},
  };
}

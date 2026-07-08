import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import {
  PROTOCOL_VERSION,
  TICK_TIMEOUT_CLOSE_CODE,
  buildConnectRequest,
  parseServerFrame,
  type ChatDeltaEvent,
  type ServerFrame,
} from "./protocol.ts";
import { signChallenge, type DeviceIdentity } from "./device-auth.ts";

/** OpenClaw operator client: connection, handshake, reconnect-with-backoff, and tick-timeout
 *  enforcement for the third-party OpenClaw Gateway WS protocol v4 (see `protocol.ts`). One
 *  `ws` socket at a time; a state machine tracks whether the operator link is usable.
 *
 *  The `token` is a ROOT secret. It rides the wire once, inside `buildConnectRequest`'s
 *  `params.auth.token`, and never appears in any logged line or thrown error: every log call
 *  goes through `opts.logSink` (default `process.stderr.write`) with a short, hand-written
 *  description, never a serialized frame or raw error from the wire. */

/** These three values MUST match what `buildConnectRequest` (protocol.ts) embeds in the signed
 *  connect request's `params`, since the server (and this client) reconstruct the same
 *  device-auth payload (`buildAuthPayloadV3`, device-auth.ts) from those exact fields to verify
 *  the signature. `buildConnectRequest` hardcodes role "operator" and these two scopes, and
 *  defaults `client.platform` to "server" when unset (as it always is here, since
 *  `OpenClawClientOptions` carries no platform override). */
const OPERATOR_ROLE = "operator";
const OPERATOR_SCOPES = ["operator.read", "operator.write"];
const CLIENT_PLATFORM = "server";

// ASSUMPTION (Task 8 to verify): the verified wire facts pin `deltaText`/`message`/`replace` on
// the delta payload (see `ChatDeltaEventSchema` in protocol.ts) but not a session-identifying
// field name, so this reads `sessionKey` (matching the outbound `chat.send` request's own
// `params.sessionKey`) off the event payload as an open/unknown field rather than widening the
// pinned schema on a guess. If the live study pins a different field name (e.g. `session` or
// `conversationId`), this is the single site to update.
function sessionKeyOf(event: ChatDeltaEvent): string | undefined {
  const payload = event.payload as unknown as Record<string, unknown>;
  return typeof payload["sessionKey"] === "string" ? (payload["sessionKey"] as string) : undefined;
}

// ASSUMPTION (Task 8 to verify): a streamed reply ends when an event for the
// session carries a terminal marker (e.g. payload.done === true or a distinct
// "chat.final"/state value). Until verified, treat the first event bearing this
// marker as end-of-turn; the fake server sends the same shape the study records.
function isReplyEnd(event: ChatDeltaEvent): boolean {
  const payload = event.payload as unknown as Record<string, unknown>;
  return payload["done"] === true;
}

/** `replace ? deltaText : prev + deltaText`, except the server's own cumulative `message`
 *  snapshot wins outright when present: an empty string means "no cumulative snapshot on this
 *  event" (the field is required by `ChatDeltaEventSchema` but may be sent empty), anything else
 *  is treated as authoritative and returned as-is, bypassing local accumulation entirely. */
function accumulateDelta(prev: string, event: ChatDeltaEvent): string {
  if (event.payload.message.length > 0) return event.payload.message;
  return event.payload.replace === true ? event.payload.deltaText : prev + event.payload.deltaText;
}

export interface SessionHandlers {
  onDelta(snapshot: string): void;
  onDone(): void;
  onError(message: string): void;
}

export interface ReconnectPolicy {
  minMs: number;
  maxMs: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = { minMs: 500, maxMs: 15000 };

/** Pure exponential-backoff-with-jitter calculation, exported so its growth and cap can be
 *  unit-tested independent of any socket. `attempt` is 1-based (the first reconnect after a
 *  drop). The jitter band is narrow (+/-10% of the base) and the base itself doubles per
 *  attempt, so consecutive attempts' jittered ranges do not overlap as long as `minMs`/`maxMs`
 *  give the exponential curve room to separate, making delay growth observable even with
 *  randomness. `random` defaults to `Math.random` and is injectable for deterministic tests. */
export function computeReconnectDelay(
  attempt: number,
  policy: ReconnectPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(policy.maxMs, policy.minMs * 2 ** exponent);
  const jitterSpan = base * 0.1;
  const jitter = (random() * 2 - 1) * jitterSpan;
  const delay = Math.round(base + jitter);
  return Math.min(policy.maxMs, Math.max(policy.minMs, delay));
}

export interface OpenClawClientOptions {
  url: string;
  token: string;
  identity: DeviceIdentity;
  /** default PROTOCOL_VERSION */
  protocolVersion?: number;
  /** default { minMs: 500, maxMs: 15000 } */
  reconnect?: ReconnectPolicy;
  /** injectable clock for tests */
  now?: () => number;
  /** Every log line goes through this sink instead of a raw console/stderr write scattered
   *  through the module, so tests can capture and assert on exactly what left the process
   *  (scenario f: the token must never appear in any captured line). Default appends a
   *  newline-terminated string to `process.stderr`. */
  logSink?: (line: string) => void;
}

export type ClientState = "connecting" | "online" | "absent";

export interface OpenClawClient {
  state(): ClientState;
  /** Resolves on the matching `res.ok:true` payload; rejects on `res.ok:false` (with the
   *  server's error code, never wire/token content) or if the connection drops before a
   *  response arrives. Rejects immediately, without sending anything, unless the client is
   *  currently `online`. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Registers a handler for tick/other non-session-scoped events observed after `hello-ok`.
   *  Multiple handlers may be registered; none can be removed. Chat delta/reply-end events are
   *  NOT delivered here (see `subscribeSession`): they are session-scoped and go exclusively
   *  through the per-session subscription, so a generic `onEvent` listener can never observe
   *  another session's streamed content. */
  onEvent(handler: (frame: ServerFrame) => void): void;
  /** Registers interest in ONE OpenClaw chat session's streamed deltas. The client drops any
   *  delta/reply-end event whose session id does not match a currently subscribed session (the
   *  openclaw#32579 broadcast-bug guard and a cross-operator privacy guard, since the same root
   *  token can observe other operators' session traffic on this connection) before any parsing
   *  beyond the envelope -- dropped events are never delivered and never logged with content.
   *  `onDelta` fires with the running accumulated snapshot (see `accumulateDelta`); `onDone`
   *  fires exactly once, on the first event carrying the reply-end marker (see `isReplyEnd`),
   *  after which further deltas for this session are ignored; `onError` fires if the connection
   *  drops before the session reaches its reply-end marker. Returns an unsubscribe function. */
  subscribeSession(sessionKey: string, handlers: SessionHandlers): () => void;
  onStateChange(handler: (state: ClientState) => void): void;
  /** Begins the connect+reconnect loop. Idempotent: a second call while already started is a
   *  no-op. */
  start(): void;
  /** Idempotent. Cancels any pending reconnect, fails every outstanding `request()`, closes the
   *  live socket if any, and leaves the client `absent`. */
  close(): Promise<void>;
}

export function createOpenClawClient(opts: OpenClawClientOptions): OpenClawClient {
  const reconnectPolicy = opts.reconnect ?? DEFAULT_RECONNECT_POLICY;
  const expectedProtocol = opts.protocolVersion ?? PROTOCOL_VERSION;
  const now = opts.now ?? Date.now;
  const logLine = opts.logSink ?? ((line: string) => void process.stderr.write(line));
  const log = (message: string): void => logLine(`[openclaw-client] ${message}\n`);

  let state: ClientState = "absent";
  let ws: WebSocket | undefined;
  let started = false;
  let closed = false;
  let versionMismatch = false;
  let reconnectAttempt = 0;
  let tickIntervalMs: number | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setTimeout> | undefined;

  const eventHandlers: Array<(frame: ServerFrame) => void> = [];
  const stateHandlers: Array<(state: ClientState) => void> = [];
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  interface SessionSubscriptionState {
    handlers: SessionHandlers;
    snapshot: string;
    done: boolean;
  }
  const sessionSubscriptions = new Map<string, SessionSubscriptionState>();

  function setState(next: ClientState): void {
    if (state === next) return;
    state = next;
    for (const handler of stateHandlers) handler(next);
  }

  function failAllPending(err: Error): void {
    if (pending.size === 0) return;
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.reject(err);
  }

  function clearTickTimer(): void {
    if (tickTimer !== undefined) clearTimeout(tickTimer);
    tickTimer = undefined;
  }

  function resetTickTimer(intervalMs: number): void {
    clearTickTimer();
    tickTimer = setTimeout(() => {
      log(`no frames received within ${intervalMs * 2}ms of the last one; closing (tick timeout)`);
      ws?.close(TICK_TIMEOUT_CLOSE_CODE);
    }, intervalMs * 2);
    tickTimer.unref();
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  function handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      log("received a non-JSON frame; ignoring");
      return;
    }
    const frame = parseServerFrame(parsed);
    if (frame === undefined) {
      log("received an unrecognized frame shape; ignoring");
      return;
    }

    // Any inbound frame counts as wire activity for the tick-timeout watchdog, once we know the
    // interval (assigned at hello-ok).
    if (tickIntervalMs !== undefined) resetTickTimer(tickIntervalMs);

    switch (frame.kind) {
      case "challenge": {
        if (state === "online") {
          log("received a connect.challenge while already online; ignoring");
          return;
        }
        const socket = ws;
        if (socket === undefined) return;
        const signed = signChallenge({
          identity: opts.identity,
          nonce: frame.payload.nonce,
          token: opts.token,
          role: OPERATOR_ROLE,
          scopes: OPERATOR_SCOPES,
          platform: CLIENT_PLATFORM,
        });
        const req = buildConnectRequest({
          id: randomUUID(),
          token: opts.token,
          nonce: signed.nonce,
          device: {
            id: opts.identity.id,
            publicKey: opts.identity.publicKey,
            signature: signed.signature,
            signedAt: signed.signedAt,
          },
        });
        socket.send(JSON.stringify(req));
        return;
      }
      case "hello-ok": {
        if (frame.payload.protocol !== expectedProtocol) {
          log(
            `server reported protocol ${frame.payload.protocol}, expected ${expectedProtocol}; ` +
              "failing closed, will not retry",
          );
          versionMismatch = true;
          clearReconnectTimer();
          setState("absent");
          ws?.close();
          return;
        }
        tickIntervalMs = frame.payload.policy.tickIntervalMs;
        reconnectAttempt = 0;
        resetTickTimer(tickIntervalMs);
        setState("online");
        return;
      }
      case "response": {
        const entry = pending.get(frame.id);
        if (entry === undefined) return; // unknown, stale, or foreign correlation id: ignore
        pending.delete(frame.id);
        if (frame.ok) entry.resolve(frame.payload);
        else entry.reject(new Error(`openclaw request failed: ${frame.error.details.code}`));
        return;
      }
      case "tick": {
        for (const handler of eventHandlers) handler(frame);
        return;
      }
      case "delta": {
        const sessionKey = sessionKeyOf(frame);
        const sub = sessionKey === undefined ? undefined : sessionSubscriptions.get(sessionKey);
        if (sub === undefined) {
          // Foreign/unsubscribed session (openclaw#32579 broadcast-bug guard and cross-operator
          // privacy guard): drop before any further parsing. Deliberately no content in this log
          // line -- not even the session id -- since the guard exists precisely because this
          // connection's root token can observe other operators' session traffic.
          log("dropped a chat delta for a session with no active subscription");
          return;
        }
        if (sub.done) return; // reply already ended for this session; ignore trailing deltas.
        sub.snapshot = accumulateDelta(sub.snapshot, frame);
        sub.handlers.onDelta(sub.snapshot);
        if (isReplyEnd(frame)) {
          sub.done = true;
          sub.handlers.onDone();
        }
        return;
      }
    }
  }

  function scheduleReconnect(): void {
    setState("connecting");
    reconnectAttempt += 1;
    const delay = computeReconnectDelay(reconnectAttempt, reconnectPolicy);
    log(`disconnected; reconnecting in ${delay}ms (attempt ${reconnectAttempt}, at ${now()})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer.unref();
  }

  function handleClosed(code: number): void {
    clearTickTimer();
    // Reset so a reconnect does not arm the tick watchdog with the previous connection's
    // interval before the new hello-ok assigns its own (the interval is connection-specific and
    // only known again once a fresh hello-ok arrives).
    tickIntervalMs = undefined;
    ws = undefined;
    failAllPending(new Error("openclaw client disconnected before a response arrived"));

    // Additive to the brief's four required scenarios: a session whose reply had not yet reached
    // its terminal marker when the socket dropped gets a generic onError, so a caller mid-stream
    // is not left silently stalled forever. The subscription itself is left in place (not
    // removed) since the same sessionKey is worth resuming after reconnect; never includes
    // wire/token content.
    //
    // Skipped entirely on an intentional close() (closed is already true here by the time this
    // fires): delivering "dropped before the reply ended" after the caller itself asked to close
    // would be a misleading onError for a clean shutdown. Pending request() calls still fail via
    // failAllPending above, unconditionally -- only this session-level onError is suppressed.
    if (!closed) {
      for (const sub of sessionSubscriptions.values()) {
        if (!sub.done) sub.handlers.onError("openclaw connection dropped before the reply ended");
      }
    }

    if (closed) return;
    if (versionMismatch) {
      setState("absent");
      return;
    }
    log(`socket closed (code ${code})`);
    scheduleReconnect();
  }

  function connect(): void {
    if (closed) return;
    const socket = new WebSocket(opts.url);
    ws = socket;

    socket.on("open", () => {
      // The token-only first attempt: accepted directly by a server configured to trust it,
      // otherwise silently superseded by the signed retry the "challenge" branch above sends
      // once the connect.challenge event arrives.
      const req = buildConnectRequest({ id: randomUUID(), token: opts.token });
      socket.send(JSON.stringify(req));
    });
    socket.on("message", (data) => handleMessage(data));
    socket.on("close", (code: number) => handleClosed(code));
    socket.on("error", (err: Error) => log(`socket error: ${err.message}`));
  }

  return {
    state: () => state,

    request(method: string, params: unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (state !== "online" || ws === undefined || ws.readyState !== WebSocket.OPEN) {
          reject(new Error(`cannot send "${method}": client is ${state}, not online`));
          return;
        }
        const id = randomUUID();
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ type: "req", id, method, params }));
      });
    },

    onEvent(handler: (frame: ServerFrame) => void): void {
      eventHandlers.push(handler);
    },

    subscribeSession(sessionKey: string, handlers: SessionHandlers): () => void {
      sessionSubscriptions.set(sessionKey, { handlers, snapshot: "", done: false });
      return () => {
        sessionSubscriptions.delete(sessionKey);
      };
    },

    onStateChange(handler: (state: ClientState) => void): void {
      stateHandlers.push(handler);
    },

    start(): void {
      if (started) return;
      started = true;
      closed = false;
      setState("connecting");
      connect();
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearReconnectTimer();
      clearTickTimer();
      failAllPending(new Error("openclaw client is closing"));
      // Drop every session subscription so handler references from a permanently-closed client
      // cannot linger (and, per the guard added above, so any close-triggered handleClosed sees
      // nothing left to iterate even before its own `closed` check runs).
      sessionSubscriptions.clear();

      const socket = ws;
      if (socket !== undefined && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        await new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.close();
        });
      }
      ws = undefined;
      setState("absent");
    },
  };
}

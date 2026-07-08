import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import {
  PROTOCOL_VERSION,
  TICK_TIMEOUT_CLOSE_CODE,
  buildConnectRequest,
  parseServerFrame,
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
  /** Registers a handler for delta/tick/other events observed after `hello-ok`. Multiple
   *  handlers may be registered; none can be removed. */
  onEvent(handler: (frame: ServerFrame) => void): void;
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
      case "tick":
      case "delta": {
        for (const handler of eventHandlers) handler(frame);
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
  }

  function handleClosed(code: number): void {
    clearTickTimer();
    ws = undefined;
    failAllPending(new Error("openclaw client disconnected before a response arrived"));

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

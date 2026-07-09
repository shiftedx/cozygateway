import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID, verify } from "node:crypto";

import { WebSocketServer, WebSocket } from "ws";

import {
  buildAuthPayloadV3,
  decodeSignature,
  importDevicePublicKey,
} from "../../src/adapters/openclaw/device-auth.ts";
import { PROTOCOL_VERSION } from "../../src/adapters/openclaw/protocol.ts";

/** In-process fake OpenClaw v4 gateway server for `OpenClawClient` tests. Speaks the recorded
 *  wire shapes from `protocol.ts`: on every new connection it sends a `connect.challenge` event,
 *  expects the client's first `connect` request to be token-only (no `device`), then expects a
 *  second `connect` request carrying signed device fields, which it independently verifies
 *  against the device's public key before replying `hello-ok`. Ticks are scheduled on an
 *  interval reported via `hello-ok.payload.policy.tickIntervalMs` unless `silent` is set. */

export interface FakeOpenClawServerBehavior {
  /** protocol version reported in hello-ok; default PROTOCOL_VERSION (mismatch knob for
   *  scenario b). */
  protocolVersion?: number;
  /** policy.tickIntervalMs reported in hello-ok, and the real interval on which tick events are
   *  scheduled; default 40. */
  tickIntervalMs?: number;
  /** when true, no tick events are ever scheduled (silence knob for scenario e). */
  silent?: boolean;
  /** request methods on which the server closes the socket immediately instead of responding
   *  (mid-turn drop knob for scenario d). */
  dropOnMethod?: string[];
  /** the next N new connections are terminated immediately after opening, before any handshake
   *  frame is sent (connection-failure knob for scenario c's backoff-growth assertion). Consumed
   *  one per connection. */
  failNextConnections?: number;
  /** when true, the server accepts the socket but never sends `connect.challenge` (and so never
   *  reaches `hello-ok` either): the connection just sits open and silent. Reproduces a gateway
   *  that opens the socket but never completes the handshake, exercising the client's own
   *  handshake-deadline watchdog rather than any other fake-server behavior (Fix 1 scenario a). */
  neverSendChallenge?: boolean;
  /** when true, every signed `connect` request (one carrying a `device` block) is rejected with
   *  `bad_signature`, WITHOUT closing the socket, regardless of whether the signature would
   *  actually verify. Reproduces an auth rejection a server answers but never follows with a
   *  close, so the client's handshake-deadline watchdog (not a socket-close event) is what has to
   *  notice the stall (Fix 1 scenario b). */
  forceBadSignature?: boolean;
}

export interface FakeOpenClawServer {
  url: string;
  /** Number of sockets currently open on the server side. */
  connectionCount(): number;
  /** Total number of connections ever accepted, including ones later dropped/closed. */
  totalConnections(): number;
  /** Close codes the server observed, in arrival order, one per socket that has closed so far
   *  (e.g. 4000 for a client-initiated tick-timeout close). */
  closeCodes(): number[];
  /** `sessionKey` values the server has handed back from `sessions.create`, in call order. Lets a
   *  test read back the SAME key it should tag a subsequent `sendEvent` chat-delta frame with,
   *  exercising the assumed-same-field/value across `sessions.create`'s response and the delta
   *  event's session-identifying field. */
  sessionKeys(): string[];
  /** Force-closes every currently open socket (server-initiated drop knob for scenario c). */
  dropAll(code?: number): void;
  /** Broadcasts an arbitrary JSON-serializable frame to every currently open socket. Used by
   *  Task 5's chat-delta/reply-end tests to construct exact wire shapes (session id, deltaText,
   *  message, replace, the reply-end marker) without a dedicated per-scenario knob. */
  sendEvent(frame: Record<string, unknown>): void;
  /** Merges into the live behavior config; affects subsequent connections/messages. */
  setBehavior(patch: Partial<FakeOpenClawServerBehavior>): void;
  close(): Promise<void>;
}

const DEFAULT_TICK_INTERVAL_MS = 40;

export async function startFakeOpenClawServer(
  initial: FakeOpenClawServerBehavior = {},
): Promise<FakeOpenClawServer> {
  let cfg: Required<Omit<FakeOpenClawServerBehavior, "dropOnMethod">> & { dropOnMethod: string[] } = {
    protocolVersion: initial.protocolVersion ?? PROTOCOL_VERSION,
    tickIntervalMs: initial.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
    silent: initial.silent ?? false,
    dropOnMethod: initial.dropOnMethod ?? [],
    failNextConnections: initial.failNextConnections ?? 0,
    neverSendChallenge: initial.neverSendChallenge ?? false,
    forceBadSignature: initial.forceBadSignature ?? false,
  };

  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const sockets = new Set<WebSocket>();
  let totalConnections = 0;
  const closeCodes: number[] = [];
  const sessionKeys: string[] = [];

  wss.on("connection", (ws) => {
    totalConnections += 1;
    sockets.add(ws);
    ws.on("close", (code: number) => {
      sockets.delete(ws);
      closeCodes.push(code);
    });

    if (cfg.failNextConnections > 0) {
      cfg.failNextConnections -= 1;
      ws.terminate();
      return;
    }

    let tickTimer: ReturnType<typeof setTimeout> | undefined;
    const stopTicks = (): void => {
      if (tickTimer !== undefined) clearTimeout(tickTimer);
      tickTimer = undefined;
    };
    const scheduleTick = (): void => {
      if (cfg.silent) return;
      tickTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "event", event: "tick" }));
          scheduleTick();
        }
      }, cfg.tickIntervalMs);
    };
    ws.on("close", stopTicks);

    const nonce = randomUUID();
    if (!cfg.neverSendChallenge) {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce, ts: Date.now() } }));
    }
    // else: the socket stays open and silent forever from the server's side; the client is left
    // waiting on a challenge that never arrives, so hello-ok never arrives either.

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const frame = parsed as { type?: string; id?: string; method?: string; params?: Record<string, unknown> };
      if (frame.type !== "req" || typeof frame.id !== "string") return;

      if (cfg.dropOnMethod.includes(frame.method ?? "")) {
        ws.terminate();
        return;
      }

      if (frame.method === "connect") {
        const params = frame.params ?? {};
        const device = params["device"] as
          | { id: string; publicKey: string; signature: string; signedAt: number; nonce: string }
          | undefined;
        const auth = params["auth"] as { token: string } | undefined;
        const token = auth?.token ?? "";

        if (device === undefined) {
          // Token-only first connect: this fake server always requires device auth, so it does
          // not answer this request at all (matching the real wire's silent-until-challenged
          // stance); the client is expected to wait for the challenge event above instead.
          return;
        }

        const role = typeof params["role"] === "string" ? (params["role"] as string) : "operator";
        const scopes = Array.isArray(params["scopes"]) ? (params["scopes"] as string[]) : [];
        const client = params["client"] as
          | { id?: string; mode?: string; platform?: string; deviceFamily?: string }
          | undefined;
        const clientId = client?.id ?? "gateway-client";
        const clientMode = client?.mode ?? "backend";
        const platform = client?.platform ?? "server";
        const deviceFamily = client?.deviceFamily ?? "server";

        if (cfg.forceBadSignature) {
          // Deterministic auth rejection WITHOUT closing the socket, regardless of whether the
          // signature would actually verify: reproduces a server that answers `connect` with an
          // error frame but never follows it with a close, without depending on corrupting the
          // client's real signing (which the test has no hook into).
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { details: { code: "bad_signature", reason: "device signature did not verify" } },
            }),
          );
          return;
        }

        const expectedPayload = buildAuthPayloadV3(
          {
            identity: { id: device.id, publicKey: device.publicKey, privateKey: "" },
            nonce: device.nonce,
            token,
            role,
            scopes,
            clientId,
            clientMode,
            platform,
            deviceFamily,
          },
          device.signedAt,
        );
        let verified = false;
        try {
          verified = verify(
            null,
            Buffer.from(expectedPayload),
            importDevicePublicKey(device.publicKey),
            decodeSignature(device.signature),
          );
        } catch {
          verified = false;
        }
        if (!verified || device.nonce !== nonce) {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { details: { code: "bad_signature", reason: "device signature did not verify" } },
            }),
          );
          return;
        }

        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: cfg.protocolVersion,
              server: { version: "fake-1.0", connId: randomUUID() },
              features: { methods: ["chat.send", "sessions.create"], events: ["tick", "chat"] },
              auth: { role, scopes },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: cfg.tickIntervalMs },
            },
          }),
        );
        scheduleTick();
        return;
      }

      if (frame.method === "sessions.create") {
        // PINNED (Task 8): sessions.create returns the session key under `key`; that same value is
        // what chat/agent events carry as `sessionKey` and what chat.send takes as params.sessionKey.
        const sessionKey = randomUUID();
        sessionKeys.push(sessionKey);
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { key: sessionKey } }));
        return;
      }

      // Generic ok-echo for any other correlated request (e.g. chat.send).
      ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
    });
  });

  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const addr = http.address();
  if (addr === null || typeof addr !== "object") throw new Error("fake OpenClaw server has no address");
  const url = `ws://127.0.0.1:${addr.port}`;

  return {
    url,
    connectionCount: () => sockets.size,
    totalConnections: () => totalConnections,
    closeCodes: () => [...closeCodes],
    sessionKeys: () => [...sessionKeys],
    dropAll(code?: number): void {
      for (const ws of sockets) ws.close(code);
    },
    sendEvent(frame: Record<string, unknown>): void {
      const raw = JSON.stringify(frame);
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      }
    },
    setBehavior(patch: Partial<FakeOpenClawServerBehavior>): void {
      cfg = { ...cfg, ...patch, dropOnMethod: patch.dropOnMethod ?? cfg.dropOnMethod };
    },
    async close(): Promise<void> {
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

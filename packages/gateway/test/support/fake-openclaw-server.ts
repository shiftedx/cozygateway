import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { randomUUID, verify } from "node:crypto";

import { WebSocketServer, WebSocket } from "ws";

import { buildAuthPayloadV3, importDevicePublicKey } from "../../src/adapters/openclaw/device-auth.ts";
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
  };

  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const sockets = new Set<WebSocket>();
  let totalConnections = 0;
  const closeCodes: number[] = [];

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
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce, ts: Date.now() } }));

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
        const client = params["client"] as { platform?: string } | undefined;
        const platform = client?.platform ?? "server";

        const expectedPayload = buildAuthPayloadV3({
          identity: { id: device.id, publicKey: device.publicKey, privateKey: "" },
          nonce: device.nonce,
          token,
          role,
          scopes,
          platform,
        });
        let verified = false;
        try {
          verified = verify(
            null,
            Buffer.from(expectedPayload),
            importDevicePublicKey(device.publicKey),
            Buffer.from(device.signature, "base64"),
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
              features: { methods: ["chat.send", "sessions.create"], events: ["tick", "chat.delta"] },
              auth: { role, scopes },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: cfg.tickIntervalMs },
            },
          }),
        );
        scheduleTick();
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

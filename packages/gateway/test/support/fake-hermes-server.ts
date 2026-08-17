import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocketServer, WebSocket } from "ws";

/** In-process fake Hermes `tui_gateway` server for `HermesClient` and bridge tests. Speaks the
 *  shapes the dissection pins: one JSON value per frame, `{ id, method, params }` requests,
 *  `{ jsonrpc, id, result }` / `{ jsonrpc, id, error: { code, message } }` replies, a
 *  `gateway.ready` event on accept, and event frames shaped
 *  `{ method: "event", params: { type, session_id, payload } }`.
 *
 *  Handlers are supplied per method. An unregistered method answers with the real gateway's
 *  unknown-method error text so feature probes can be exercised end to end. */

/** Handed to a method handler so it can defer its reply, which is what makes out-of-order
 *  responses testable: return `NO_REPLY`, keep the context, and call `reply` later. */
export interface HermesCallContext {
  id: unknown;
  reply(result: unknown): void;
  replyError(code: number, message: string): void;
}

export interface FakeHermesBehavior {
  /** Per-method handlers. A handler may return a value (sent as `result`), throw
   *  `{ code, message }` (sent as `error`), or return the sentinel `NO_REPLY` to stay silent,
   *  optionally replying later through the call context. */
  methods?: Record<string, (params: Record<string, unknown>, ctx: HermesCallContext) => unknown>;
  /** When true, no `gateway.ready` event is sent, so the client never reaches online. */
  neverSendReady?: boolean;
  /** Close code used to reject the next N connections right after accepting them (4401/4403). */
  refuseWithCode?: number;
  /** Connections to refuse before behaving normally. Consumed one per connection. */
  refuseNextConnections?: number;
  /** Methods on which the socket is terminated instead of answered. */
  dropOnMethod?: string[];
}

/** Returned by a handler that should produce no reply at all. */
export const NO_REPLY = Symbol("no-reply");

export interface HermesCall {
  method: string;
  params: Record<string, unknown>;
  /** The query string the client dialed with, credential included, so tests can assert auth. */
  query: string;
}

export interface FakeHermesServer {
  url: string;
  calls(): HermesCall[];
  callsOf(method: string): HermesCall[];
  totalConnections(): number;
  connectionCount(): number;
  /** Every query string the server has seen on an upgrade, in connection order. */
  queries(): string[];
  sendEvent(type: string, payload?: unknown, sessionId?: string): void;
  dropAll(code?: number): void;
  setBehavior(patch: Partial<FakeHermesBehavior>): void;
  close(): Promise<void>;
}

export async function startFakeHermesServer(initial: FakeHermesBehavior = {}): Promise<FakeHermesServer> {
  let cfg: FakeHermesBehavior = { ...initial };

  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const sockets = new Set<WebSocket>();
  const calls: HermesCall[] = [];
  const queries: string[] = [];
  let totalConnections = 0;

  wss.on("connection", (ws, req) => {
    totalConnections += 1;
    const query = (req.url ?? "").split("?")[1] ?? "";
    queries.push(query);
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));

    if ((cfg.refuseNextConnections ?? 0) > 0) {
      cfg.refuseNextConnections = (cfg.refuseNextConnections ?? 0) - 1;
      ws.close(cfg.refuseWithCode ?? 4401, "refused");
      return;
    }

    if (cfg.neverSendReady !== true) {
      ws.send(
        JSON.stringify({
          method: "event",
          params: { type: "gateway.ready", payload: { skin: "fake", change_events: true } },
        }),
      );
    }

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const frame = parsed as { id?: unknown; method?: unknown; params?: unknown };
      if (typeof frame.method !== "string") return;
      const params = (typeof frame.params === "object" && frame.params !== null ? frame.params : {}) as Record<
        string,
        unknown
      >;
      calls.push({ method: frame.method, params, query });

      if ((cfg.dropOnMethod ?? []).includes(frame.method)) {
        ws.terminate();
        return;
      }

      const id = frame.id ?? null;
      const handler = cfg.methods?.[frame.method];
      if (handler === undefined) {
        // The real gateway's unknown-method rejection. The text matters: client feature probes
        // match /unknown method/i against it.
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: 4001, message: `unknown method: ${frame.method}` },
          }),
        );
        return;
      }
      const send = (body: Record<string, unknown>): void => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
      };
      const ctx: HermesCallContext = {
        id,
        reply: (result: unknown) => send({ result }),
        replyError: (code: number, message: string) => send({ error: { code, message } }),
      };
      try {
        const result = handler(params, ctx);
        if (result === NO_REPLY) return;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (err) {
        const record = (typeof err === "object" && err !== null ? err : {}) as {
          code?: number;
          message?: string;
        };
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: record.code ?? 5000, message: record.message ?? "failed" },
          }),
        );
      }
    });
  });

  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const addr = http.address();
  if (addr === null || typeof addr !== "object") throw new Error("fake hermes server has no address");

  return {
    url: `ws://127.0.0.1:${addr.port}/api/ws`,
    calls: () => [...calls],
    callsOf: (method: string) => calls.filter((call) => call.method === method),
    totalConnections: () => totalConnections,
    connectionCount: () => sockets.size,
    queries: () => [...queries],
    sendEvent(type: string, payload?: unknown, sessionId?: string): void {
      const raw = JSON.stringify({
        method: "event",
        params: { type, ...(sessionId === undefined ? {} : { session_id: sessionId }), payload },
      });
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      }
    },
    dropAll(code?: number): void {
      // No code means an abrupt drop (terminate), since ws only accepts 1000 or 3000-4999 on
      // close(). A code means a deliberate, observable close such as 4401.
      for (const ws of sockets) {
        if (code === undefined) ws.terminate();
        else ws.close(code, "closed");
      }
    },
    setBehavior(patch: Partial<FakeHermesBehavior>): void {
      cfg = { ...cfg, ...patch };
    },
    async close(): Promise<void> {
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

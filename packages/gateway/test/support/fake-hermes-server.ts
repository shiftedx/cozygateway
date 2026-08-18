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
  /** When present the server behaves like a GATED Hermes dashboard rather than a loopback bind:
   *  `POST /auth/password-login` mints a session cookie, `POST /api/auth/ws-ticket` mints a
   *  single-use ticket against that cookie, and the WS upgrade is accepted only for a live,
   *  unconsumed ticket (anything else is closed 4401). */
  gated?: { username: string; password: string };
  /** Gated mode: ticket lifetime in ms. 0 means every minted ticket is already expired, which is
   *  how the expiry path is exercised. Default 30000, matching upstream TTL_SECONDS. */
  ticketTtlMs?: number;
}

/** Upstream's TTL for a minted ws ticket (ws_tickets.TTL_SECONDS). */
const TICKET_TTL_MS = 30_000;

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
  /** HTTP origin of the same listener, for the gated login and ws-ticket endpoints. */
  baseUrl: string;
  /** Gated mode: how many times `/auth/password-login` has been called. */
  loginCount(): number;
  /** Gated mode: how many times `/api/auth/ws-ticket` has been called. */
  ticketMintCount(): number;
  /** Gated mode: every ticket the server has minted, in mint order. */
  mintedTickets(): string[];
  /** Gated mode: invalidate every session cookie, so the next ws-ticket mint answers 401 and the
   *  client has to log in again. */
  expireSessions(): void;
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

  const sessions = new Set<string>();
  const tickets = new Map<string, number>();
  const mintedTickets: string[] = [];
  let sessionSeq = 0;
  let ticketSeq = 0;
  let loginCount = 0;
  let ticketMintCount = 0;

  function readBody(req: import("node:http").IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += String(chunk)));
      req.on("end", () => resolve(raw));
    });
  }

  const http: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const send = (status: number, body: unknown, headers: Record<string, string | string[]> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (cfg.gated === undefined) {
      send(404, { detail: "Not Found" });
      return;
    }
    if (req.method === "POST" && path === "/auth/password-login") {
      loginCount += 1;
      void readBody(req).then((raw) => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          send(400, { detail: "bad body" });
          return;
        }
        const gated = cfg.gated;
        if (gated === undefined) {
          send(404, { detail: "Not Found" });
          return;
        }
        // Upstream answers 404 for an unknown or non-password provider, deliberately generic.
        if (body["provider"] !== "basic") {
          send(404, { detail: "Unknown provider" });
          return;
        }
        if (body["username"] !== gated.username || body["password"] !== gated.password) {
          send(401, { detail: "Invalid credentials" });
          return;
        }
        const session = `sess-${++sessionSeq}`;
        sessions.add(session);
        send(200, { ok: true, next: "/" }, { "set-cookie": [`hermes_session=${session}; Path=/; HttpOnly`] });
      });
      return;
    }
    if (req.method === "POST" && path === "/api/auth/ws-ticket") {
      ticketMintCount += 1;
      const cookie = req.headers.cookie ?? "";
      const session = /hermes_session=([^;]+)/.exec(cookie)?.[1] ?? "";
      if (!sessions.has(session)) {
        send(401, { detail: "Unauthorized" });
        return;
      }
      const ticket = `ticket-${++ticketSeq}-${Math.random().toString(36).slice(2, 10)}`;
      const ttl = cfg.ticketTtlMs ?? TICKET_TTL_MS;
      tickets.set(ticket, Date.now() + ttl);
      mintedTickets.push(ticket);
      send(200, { ticket, ttl_seconds: Math.round(ttl / 1000) });
      return;
    }
    send(404, { detail: "Not Found" });
  });
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

    if (cfg.gated !== undefined) {
      // Single-use: the ticket is consumed on the FIRST upgrade that presents it, so a replay
      // and an expired ticket both land on the same 4401 the real gateway sends.
      const ticket = new URLSearchParams(query).get("ticket") ?? "";
      const expiresAt = tickets.get(ticket);
      tickets.delete(ticket);
      if (expiresAt === undefined || expiresAt <= Date.now()) {
        ws.close(4401, "unauthorized");
        return;
      }
    }

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
    baseUrl: `http://127.0.0.1:${addr.port}`,
    loginCount: () => loginCount,
    ticketMintCount: () => ticketMintCount,
    mintedTickets: () => [...mintedTickets],
    expireSessions: () => sessions.clear(),
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

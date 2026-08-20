import { WebSocket } from "ws";

/** Persistent outbound JSON-RPC WebSocket client to a Hermes gateway (`hermes serve`, the
 *  `tui_gateway` surface at `/api/ws`). Modeled on `adapters/openclaw/client.ts`: one socket at a
 *  time, reconnect with exponential backoff and jitter, a handshake watchdog, and a generic
 *  `request(method, params)` correlated STRICTLY by id.
 *
 *  Hermes-facing assumptions live here and nowhere else in the gateway:
 *  - framing is one JSON value per frame; requests are `{ id, method, params }`, replies are
 *    `{ id, result }` or `{ id, error: { code, message, data? } }`.
 *  - the server pushes an event frame `{ method: "event", params: { type: "gateway.ready", ... } }`
 *    right after accepting the socket; that is what promotes the client to `online`.
 *  - responses can arrive OUT OF REQUEST ORDER (long handlers run on a worker pool), so nothing
 *    here may assume FIFO.
 *  - auth rides the upgrade URL: `?token=` on a loopback bind, or a single-use `?ticket=` on a
 *    gated (dashboard-auth) bind. Close codes 4401 (auth) and 4403 (origin or IP) are terminal:
 *    they are not retried, because retrying a rejected credential is a hot loop against the
 *    gateway. The one bounded exception is password mode, where a 4401 can mean nothing worse
 *    than a single-use ticket that lost its 30s race; see MAX_TICKET_RETRIES.
 *  - password mode speaks the gated dashboard's HTTP handshake before every dial:
 *    `POST {base}/auth/password-login` (JSON, provider "basic" unless configured) mints cookies,
 *    `POST {base}/api/auth/ws-ticket` mints a SINGLE-USE ticket with a 30s TTL. A fresh ticket is
 *    required for every connect attempt, so the mint sits inside the reconnect loop, not beside
 *    it. Cookie state lives in this closure and nowhere else.
 *  - global change broadcasts (`sessions.changed`, `cron.changed`, ...) arrive as ordinary event
 *    frames. They are optional: a gateway that never sends them is fully supported, the bridge
 *    just falls back to polling.
 *
 *  The token is a secret. It rides the connect URL only, and no log line here ever contains the
 *  URL query string or the token value. */

/** A rejection carrying the Hermes error text VERBATIM. Feature detection upstream depends on
 *  matching `/unknown method/i` against `message`, so nothing may reword, wrap, or prefix it. */
export class HermesRpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "HermesRpcError";
    this.code = code;
    this.data = data;
  }
}

/** Raised when the call could not be put on the wire, or the wire died under it. Distinct from
 *  `HermesRpcError`, which means the gateway answered and said no. */
export class HermesUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesUnavailable";
  }
}

/** The call went out and nothing came back inside its bound. A SUBCLASS of `HermesUnavailable` on
 *  purpose, so every existing "the link is not usable" branch keeps working, but distinguishable,
 *  because the two are not the same news: an unsent call changed nothing, while a timed-out one may
 *  still be running Hermes-side and completing right now. Anything that tears down local state on
 *  success must not treat this as a failure that means "nothing happened". */
export class HermesTimeout extends HermesUnavailable {
  readonly method: string;

  constructor(method: string, timeoutMs: number) {
    super(`hermes request "${method}" timed out after ${timeoutMs}ms; it may still be running`);
    this.name = "HermesTimeout";
    this.method = method;
  }
}

export interface ReconnectPolicy {
  minMs: number;
  maxMs: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = { minMs: 500, maxMs: 15_000 };
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Close codes the Hermes gateway uses for a refused connection. Both are terminal for this
 *  client: the credential or the origin will not become valid by retrying. */
export const AUTH_CLOSE_CODE = 4401;
export const ORIGIN_CLOSE_CODE = 4403;

/** How many consecutive 4401 closes password mode absorbs before treating auth as terminal. A
 *  single-use ticket carries a 30s TTL, so ONE 4401 can mean a lost race (slow dial, clock skew)
 *  rather than a bad credential: the password itself was already accepted over HTTP before the
 *  ticket was minted. Bounded so a genuinely rejected identity still fails closed instead of
 *  looping. Reset every time the socket reaches online. */
export const MAX_TICKET_RETRIES = 2;

/** Bounds each HTTP leg of the gated handshake (login, ws-ticket mint). */
export const DEFAULT_AUTH_HTTP_TIMEOUT_MS = 10_000;

/** The password provider a stock Hermes dashboard bundles. It is one implementation of an
 *  extension point, not the protocol, so it is a default and not a constant of the wire. */
export const DEFAULT_AUTH_PROVIDER = "basic";

/** How the client authenticates the WS upgrade.
 *  - "token": the loopback shape. The value rides the upgrade URL as `?token=` (or `?ticket=`
 *    for a pre-minted ticket) and is reused on every reconnect.
 *  - "password": the gated shape. The client logs in over HTTP, holds the session cookie, and
 *    mints a FRESH single-use ticket for every connect attempt. */
export type HermesAuth =
  | { mode: "token"; token: string; param?: "token" | "ticket" }
  | {
      mode: "password";
      /** HTTP origin of the Hermes dashboard, e.g. `http://homelab:9119`. No trailing slash. */
      baseUrl: string;
      username: string;
      password: string;
      /** Which registered password provider the login names. `basic` is the bundled one, not the
       *  protocol: a dashboard can register others (LDAP bind and so on), and upstream answers a
       *  deliberately generic 404 for a provider it does not know. Default `basic`. */
      provider?: string;
    };

/** Raised when the gated dashboard rejected the identity itself (bad password, unknown provider).
 *  Terminal: retrying is a credential-stuffing loop against a server that already said no. */
class TerminalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalAuthError";
  }
}

/** Raised when the session cookie is gone or stale. Recoverable by logging in again once. */
class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** Same pure backoff shape as the OpenClaw client's, duplicated rather than imported so the two
 *  clients stay independent (this one may tune its curve without touching the chat path).
 *  `attempt` is 1-based; jitter is +/-10% of the doubling base, clamped into the policy band. */
export function computeReconnectDelay(
  attempt: number,
  policy: ReconnectPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(policy.maxMs, policy.minMs * 2 ** exponent);
  const jitter = (random() * 2 - 1) * base * 0.1;
  const delay = Math.round(base + jitter);
  return Math.min(policy.maxMs, Math.max(policy.minMs, delay));
}

/** One event frame off the Hermes stream, envelope only. `payload` stays unknown: the bridge
 *  reads what it needs and tolerates everything else. */
export interface HermesEvent {
  type: string;
  sessionId: string | undefined;
  payload: unknown;
}

export type HermesState = "absent" | "connecting" | "online";

/** A snapshot of the client's own connection state, for a health surface to report (issue #63: a
 *  monitor watching only the advertised capability cannot tell "online" from "stuck reconnecting
 *  for six hours", because the capability itself never goes away). `since` is when `state` last
 *  changed, in the client's own clock (`opts.now`, defaulting to `Date.now`); `reconnectAttempt`
 *  is the count of consecutive reconnect attempts since the last time the link was online, reset
 *  to 0 on every `gateway.ready`, so it reads 0 while `state` is `"online"`. */
export interface HermesLiveness {
  state: HermesState;
  since: number;
  reconnectAttempt: number;
}

export interface HermesClientOptions {
  /** The gateway WebSocket URL, e.g. `ws://homelab:8790/api/ws`. Any query string already on it
   *  is preserved; the credential below is appended. */
  url: string;
  /** How the upgrade is authenticated: the loopback token shape or the gated password shape. */
  auth: HermesAuth;
  reconnect?: ReconnectPolicy;
  /** Bounds each HTTP leg of the gated handshake. Default 10000. */
  authHttpTimeoutMs?: number;
  /** Bounds socket-open through `gateway.ready`. On expiry the socket is force-closed so the
   *  ordinary reconnect path runs. Default 10000. */
  handshakeTimeoutMs?: number;
  /** Bounds a single `request()`. On expiry the promise rejects and the id is dropped; a late
   *  response for it is then ignored. Default 30000. */
  requestTimeoutMs?: number;
  /** When false, the socket counts as online the moment it opens instead of waiting for the
   *  `gateway.ready` event. Escape hatch for a Hermes build that does not send it. Default true. */
  requireReadyEvent?: boolean;
  now?: () => number;
  /** Every log line goes through this sink. Lines never contain the URL query string, the token,
   *  the password, the session cookie, a ticket, or any frame content beyond a method name. */
  logSink?: (line: string) => void;
}

export interface HermesClient {
  state(): HermesState;
  /** See `HermesLiveness`. A cheap, synchronous snapshot -- no RPC involved -- so a health route
   *  can call it on every request without adding load to the link it is reporting on. */
  liveness(): HermesLiveness;
  /** Resolves with the `result` value. Rejects with `HermesRpcError` (message = the gateway's
   *  error text, verbatim) when the gateway answered with an error, or `HermesUnavailable` when
   *  the call could not be sent or the socket died first, or `HermesTimeout` (a subclass of it)
   *  when the call went out and nothing came back inside its bound.
   *
   *  `opts.timeoutMs` overrides the client-wide bound for ONE call. It exists for the handful of
   *  Hermes operations that are legitimately slow (a profile delete stops a service and rmtrees a
   *  directory), where the default 30 s would reject a call that is going to succeed. */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  /** Subscribes to every event frame, including the optional `sessions.changed` /
   *  `cron.changed` broadcasts. Handlers cannot be removed. */
  onEvent(handler: (event: HermesEvent) => void): void;
  onStateChange(handler: (state: HermesState) => void): void;
  /** Idempotent. Begins the connect and reconnect loop. */
  start(): void;
  /** Idempotent. Cancels reconnects, fails every in-flight request, closes the socket. */
  close(): Promise<void>;
}

/** Appends the credential to the URL without disturbing anything already in the query string. */
function connectUrl(url: string, param: string, value: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${param}=${encodeURIComponent(value)}`;
}

/** Reads a Hermes reply envelope. Returns undefined for anything that is not a correlated
 *  response, so events and unknown frames fall through to the event path. */
function replyOf(
  frame: Record<string, unknown>,
): { id: string; ok: true; result: unknown } | { id: string; ok: false; error: HermesRpcError } | undefined {
  const rawId = frame["id"];
  if (rawId === undefined || rawId === null) return undefined;
  const id = String(rawId);
  const error = frame["error"];
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const message = typeof record["message"] === "string" ? record["message"] : "hermes request failed";
    const code = typeof record["code"] === "number" ? record["code"] : undefined;
    return { id, ok: false, error: new HermesRpcError(message, code, record["data"]) };
  }
  if ("result" in frame) return { id, ok: true, result: frame["result"] };
  return undefined;
}

/** Reads an event frame. Hermes sends `{ method: "event", params: { type, session_id, payload } }`;
 *  `gateway.ready` is the one event with no `session_id` key. */
function eventOf(frame: Record<string, unknown>): HermesEvent | undefined {
  if (frame["method"] !== "event") return undefined;
  const params = frame["params"];
  if (typeof params !== "object" || params === null) return undefined;
  const record = params as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string") return undefined;
  const sessionId = record["session_id"];
  return {
    type,
    sessionId: typeof sessionId === "string" ? sessionId : undefined,
    payload: record["payload"],
  };
}

export function createHermesClient(opts: HermesClientOptions): HermesClient {
  const reconnectPolicy = opts.reconnect ?? DEFAULT_RECONNECT_POLICY;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const requireReadyEvent = opts.requireReadyEvent ?? true;
  const authHttpTimeoutMs = opts.authHttpTimeoutMs ?? DEFAULT_AUTH_HTTP_TIMEOUT_MS;
  const auth = opts.auth;
  const now = opts.now ?? Date.now;
  const logLine = opts.logSink ?? ((line: string) => void process.stderr.write(line));
  const log = (message: string): void => logLine(`[hermes-bridge] ${message}\n`);

  let state: HermesState = "absent";
  /** When `state` last changed, in this client's own clock. See `HermesLiveness.since`. */
  let stateSince = now();
  let ws: WebSocket | undefined;
  let started = false;
  let closed = false;
  let refused = false;
  let reconnectAttempt = 0;
  let nextRequestId = 1;
  /** Gated mode only. The dashboard session cookie header value, held here and nowhere else. */
  let sessionCookie: string | undefined;
  let ticketRetries = 0;
  let generation = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<string, Pending>();
  const eventHandlers: Array<(event: HermesEvent) => void> = [];
  const stateHandlers: Array<(state: HermesState) => void> = [];

  function setState(next: HermesState): void {
    if (state === next) return;
    state = next;
    stateSince = now();
    for (const handler of stateHandlers) handler(next);
  }

  function settle(id: string): Pending | undefined {
    const entry = pending.get(id);
    if (entry === undefined) return undefined;
    pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  function failAllPending(err: Error): void {
    const entries = [...pending.entries()];
    pending.clear();
    for (const [, entry] of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  function clearHandshakeTimer(): void {
    if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  function armHandshakeTimer(): void {
    clearHandshakeTimer();
    handshakeTimer = setTimeout(() => {
      handshakeTimer = undefined;
      log(`handshake did not reach online within ${handshakeTimeoutMs}ms; closing (handshake timeout)`);
      ws?.close();
    }, handshakeTimeoutMs);
    handshakeTimer.unref();
  }

  function handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      log("received a non-JSON frame; ignoring");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const frame = parsed as Record<string, unknown>;

    const reply = replyOf(frame);
    if (reply !== undefined) {
      const entry = settle(reply.id);
      // No pending entry means the request already timed out or the socket dropped under it. A
      // late response is dropped silently; nothing is logged, since the id alone identifies work
      // the caller has already given up on.
      if (entry === undefined) return;
      if (reply.ok) entry.resolve(reply.result);
      else entry.reject(reply.error);
      return;
    }

    const event = eventOf(frame);
    if (event === undefined) return;
    if (event.type === "gateway.ready") {
      clearHandshakeTimer();
      reconnectAttempt = 0;
      ticketRetries = 0;
      setState("online");
    }
    for (const handler of eventHandlers) handler(event);
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
    clearHandshakeTimer();
    ws = undefined;
    failAllPending(new HermesUnavailable("hermes bridge disconnected before a response arrived"));
    if (closed) return;
    if (code === AUTH_CLOSE_CODE && auth.mode === "password" && ticketRetries < MAX_TICKET_RETRIES) {
      // Password mode already proved the identity over HTTP, so a 4401 here is most likely a
      // single-use ticket that expired or lost its race. Re-mint through the ordinary reconnect
      // path a bounded number of times before falling through to the terminal branch.
      ticketRetries += 1;
      log(
        `gateway refused the single-use ticket (close code ${code}); re-minting (attempt ${ticketRetries} of ${MAX_TICKET_RETRIES})`,
      );
      scheduleReconnect();
      return;
    }
    if (code === AUTH_CLOSE_CODE || code === ORIGIN_CLOSE_CODE) {
      // Terminal: the credential was rejected (4401) or the origin/IP is not allowed (4403).
      // Retrying either is a hot loop against a gateway that has already said no, so fail closed
      // and require an operator to fix the config and restart.
      refused = true;
      log(`gateway refused the connection (close code ${code}); not retrying`);
      setState("absent");
      return;
    }
    log(`socket closed (code ${code})`);
    scheduleReconnect();
  }

  /** Gated leg 1: exchange username/password for session cookies. The password is written to the
   *  request body and never anywhere else; no branch of this function logs a credential. */
  async function login(
    baseUrl: string,
    username: string,
    password: string,
    provider: string,
  ): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/auth/password-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, username, password, next: "/" }),
        redirect: "manual",
        signal: AbortSignal.timeout(authHttpTimeoutMs),
      });
    } catch (err) {
      throw new Error(`hermes login could not be reached: ${(err as Error).message}`);
    }
    // Drain the body so the socket is released back to the agent pool either way.
    await response.text().catch(() => "");
    if (response.status === 404) {
      // Upstream answers a deliberately generic 404 for both "no such provider" and "this provider
      // has no password support". Naming the provider is the only way an operator can tell that
      // apart from a bad password, which is what the 401 branch below means.
      throw new TerminalAuthError(
        `hermes has no password auth provider named "${provider}" (HTTP 404); set "provider" in the hermes bridge config to one the dashboard registers`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      // The identity itself was refused. It will not become valid by retrying; an operator has to
      // fix the config.
      throw new TerminalAuthError(`hermes rejected the bridge login (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(`hermes login failed (HTTP ${response.status})`);
    const cookies = response.headers
      .getSetCookie()
      .map((raw) => raw.split(";")[0] ?? "")
      .filter((pair) => pair.length > 0);
    if (cookies.length === 0) throw new Error("hermes login returned no session cookie");
    sessionCookie = cookies.join("; ");
    log("logged in to the hermes dashboard; session established");
  }

  /** Gated leg 2: mint a single-use, 30s-TTL ws ticket against the held session. */
  async function mintTicket(baseUrl: string): Promise<string> {
    const cookie = sessionCookie;
    if (cookie === undefined) throw new SessionExpiredError("no hermes session cookie held");
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/auth/ws-ticket`, {
        method: "POST",
        headers: { cookie },
        signal: AbortSignal.timeout(authHttpTimeoutMs),
      });
    } catch (err) {
      throw new Error(`hermes ws-ticket could not be reached: ${(err as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      await response.text().catch(() => "");
      sessionCookie = undefined;
      throw new SessionExpiredError(`hermes session is no longer valid (HTTP ${response.status})`);
    }
    if (!response.ok) {
      await response.text().catch(() => "");
      throw new Error(`hermes ws-ticket mint failed (HTTP ${response.status})`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    const ticket =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>)["ticket"] : undefined;
    if (typeof ticket !== "string" || ticket.length === 0) {
      throw new Error("hermes ws-ticket response carried no ticket");
    }
    return ticket;
  }

  /** The credential for ONE connect attempt. Token mode reuses its value; password mode mints a
   *  fresh ticket every time, logging in first when no session is held and exactly once more when
   *  the held session turns out to be stale. */
  async function resolveCredential(): Promise<{ param: string; value: string }> {
    if (auth.mode === "token") return { param: auth.param ?? "token", value: auth.token };
    const provider = auth.provider ?? DEFAULT_AUTH_PROVIDER;
    if (sessionCookie === undefined) await login(auth.baseUrl, auth.username, auth.password, provider);
    try {
      return { param: "ticket", value: await mintTicket(auth.baseUrl) };
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err;
      log("hermes session expired; logging in again");
      await login(auth.baseUrl, auth.username, auth.password, provider);
      return { param: "ticket", value: await mintTicket(auth.baseUrl) };
    }
  }

  function connect(): void {
    if (closed || refused) return;
    generation += 1;
    const attemptGeneration = generation;
    void (async () => {
      let credential: { param: string; value: string };
      try {
        credential = await resolveCredential();
      } catch (err) {
        if (closed || refused || attemptGeneration !== generation) return;
        if (err instanceof TerminalAuthError) {
          refused = true;
          log(`${err.message}; not retrying`);
          setState("absent");
          return;
        }
        log(`could not obtain a hermes credential: ${(err as Error).message}`);
        scheduleReconnect();
        return;
      }
      if (closed || refused || attemptGeneration !== generation) return;
      try {
        dial(credential.param, credential.value);
      } catch (err) {
        // `new WebSocket()` throws SYNCHRONOUSLY on a malformed URL. Inside this IIFE that would
        // otherwise surface as an unhandled rejection with no reconnect behind it, leaving the
        // bridge dead for the process lifetime. Config validation catches the common typo at
        // startup; this is the belt.
        log(`could not dial hermes: ${(err as Error).message}`);
        scheduleReconnect();
      }
    })();
  }

  function dial(param: string, value: string): void {
    const socket = new WebSocket(connectUrl(opts.url, param, value));
    ws = socket;
    armHandshakeTimer();
    socket.on("open", () => {
      if (requireReadyEvent) return;
      clearHandshakeTimer();
      reconnectAttempt = 0;
      ticketRetries = 0;
      setState("online");
    });
    socket.on("message", (data) => handleMessage(data));
    socket.on("close", (code: number) => handleClosed(code));
    socket.on("error", (err: Error) => log(`socket error: ${err.message}`));
  }

  return {
    state: () => state,

    liveness: (): HermesLiveness => ({ state, since: stateSince, reconnectAttempt }),

    request(method: string, params: unknown = {}, opts: { timeoutMs?: number } = {}): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const socket = ws;
        if (state !== "online" || socket === undefined || socket.readyState !== WebSocket.OPEN) {
          reject(new HermesUnavailable(`cannot send "${method}": hermes bridge is ${state}, not online`));
          return;
        }
        const bound = opts.timeoutMs ?? requestTimeoutMs;
        const id = String(nextRequestId++);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new HermesTimeout(method, bound));
        }, bound);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },

    onEvent(handler: (event: HermesEvent) => void): void {
      eventHandlers.push(handler);
    },

    onStateChange(handler: (state: HermesState) => void): void {
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
      clearHandshakeTimer();
      failAllPending(new HermesUnavailable("hermes bridge is closing"));
      const socket = ws;
      if (
        socket !== undefined &&
        (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
      ) {
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

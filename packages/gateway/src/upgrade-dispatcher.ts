import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
export type UpgradeResolver = (pathname: string) => UpgradeHandler | undefined;

export const PRE_UPGRADE_AUTH_TIMEOUT_MS = 5_000;
const UPGRADE_AUTH_DEADLINES = new WeakMap<IncomingMessage, number>();

/** Remaining duration inherited by route-specific upgrade authentication. */
export function preUpgradeAuthRemainingMs(request: IncomingMessage): number | undefined {
  const deadline = UPGRADE_AUTH_DEADLINES.get(request);
  return deadline === undefined ? undefined : Math.max(0, deadline - performance.now());
}

/** Bounds each unauthenticated header interval, including the next request on a reused keep-alive
 * socket. Ordinary response work is unbounded by this guard. An upgrade inherits the same absolute
 * deadline for route authentication, so header parsing and the first auth frame cannot each spend
 * a separate full budget. */
export function installPreUpgradeDeadline(
  server: Server,
  timeoutMs = PRE_UPGRADE_AUTH_TIMEOUT_MS,
): () => void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("pre-upgrade deadline must be a positive whole number of milliseconds");
  const pending = new Map<Socket, { deadline: number; timer: ReturnType<typeof setTimeout> }>();
  const clear = (socket: Socket) => {
    const entry = pending.get(socket);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(socket);
  };
  const arm = (socket: Socket) => {
    clear(socket);
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => {
      pending.delete(socket);
      socket.destroy();
    }, timeoutMs);
    timer.unref?.();
    pending.set(socket, { deadline, timer });
  };
  const onConnection = (socket: Socket) => {
    arm(socket);
    socket.once("close", () => clear(socket));
  };
  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    const pathname = (request.url ?? "").split("?")[0] ?? "";
    if (!pathname.startsWith("/cozy/onboarding/")) clear(request.socket);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clear(request.socket);
      if (!request.socket.destroyed) arm(request.socket);
    };
    response.once("finish", release);
    response.once("close", release);
  };
  const onUpgrade = (request: IncomingMessage) => {
    const deadline = pending.get(request.socket)?.deadline ?? performance.now() + timeoutMs;
    UPGRADE_AUTH_DEADLINES.set(request, deadline);
    clear(request.socket);
  };
  server.on("connection", onConnection);
  server.prependListener("request", onRequest);
  server.prependListener("upgrade", onUpgrade);
  return () => {
    server.off("connection", onConnection);
    server.off("request", onRequest);
    server.off("upgrade", onUpgrade);
    for (const [socket, entry] of pending) {
      clearTimeout(entry.timer);
      socket.destroy();
    }
    pending.clear();
  };
}

/** The one 'upgrade' listener a shared http.Server may safely carry. `ws` WebSocketServer
 *  instances constructed with {noServer: true} never attach their own 'upgrade' listener, so
 *  routing by pathname here is the only dispatch that runs. A path matching no route would
 *  otherwise never be answered (the client hangs until its own timeout); this writes a plain
 *  HTTP error response and destroys the socket instead. */
export function createUpgradeDispatcher(
  routes: ReadonlyMap<string, UpgradeHandler>,
  dynamicResolver?: UpgradeResolver,
): UpgradeHandler {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    const handler = routes.get(pathname) ?? dynamicResolver?.(pathname);
    if (handler === undefined) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    handler(req, socket, head);
  };
}

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
export type UpgradeResolver = (pathname: string) => UpgradeHandler | undefined;

export const PRE_UPGRADE_AUTH_TIMEOUT_MS = 5_000;

/** Bounds the unauthenticated interval from TCP accept until Node has parsed a complete HTTP
 * request or upgrade. The deadline is absolute, so a slowloris cannot keep the connection alive
 * by dripping header bytes. Once headers are complete, the normal HTTP handler or route-specific
 * WebSocket authentication timer owns the connection and ordinary long responses remain valid. */
export function installPreUpgradeDeadline(
  server: Server,
  timeoutMs = PRE_UPGRADE_AUTH_TIMEOUT_MS,
): () => void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("pre-upgrade deadline must be a positive whole number of milliseconds");
  const pending = new Map<Socket, ReturnType<typeof setTimeout>>();
  const clear = (socket: Socket) => {
    const timer = pending.get(socket);
    if (timer === undefined) return;
    clearTimeout(timer);
    pending.delete(socket);
  };
  const onConnection = (socket: Socket) => {
    const timer = setTimeout(() => {
      pending.delete(socket);
      socket.destroy();
    }, timeoutMs);
    timer.unref?.();
    pending.set(socket, timer);
    socket.once("close", () => clear(socket));
  };
  const onRequest = (request: IncomingMessage, response: ServerResponse) => {
    const pathname = (request.url ?? "").split("?")[0] ?? "";
    if (!pathname.startsWith("/cozy/onboarding/")) {
      clear(request.socket);
      return;
    }
    const release = () => clear(request.socket);
    response.once("finish", release);
    response.once("close", release);
  };
  const onUpgrade = (request: IncomingMessage) => clear(request.socket);
  server.on("connection", onConnection);
  server.prependListener("request", onRequest);
  server.prependListener("upgrade", onUpgrade);
  return () => {
    server.off("connection", onConnection);
    server.off("request", onRequest);
    server.off("upgrade", onUpgrade);
    for (const [socket, timer] of pending) {
      clearTimeout(timer);
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

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** The one 'upgrade' listener a shared http.Server may safely carry. `ws` WebSocketServer
 *  instances constructed with {noServer: true} never attach their own 'upgrade' listener, so
 *  routing by pathname here is the only dispatch that runs. A path matching no route would
 *  otherwise never be answered (the client hangs until its own timeout); this writes a plain
 *  HTTP error response and destroys the socket instead. */
export function createUpgradeDispatcher(routes: ReadonlyMap<string, UpgradeHandler>): UpgradeHandler {
  return (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    const handler = routes.get(pathname);
    if (handler === undefined) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    handler(req, socket, head);
  };
}

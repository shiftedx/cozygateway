import type { Duplex } from "node:stream";

/**
 * Bounds for every public WebSocket ingress. Attach events move references and
 * metadata; file bytes use authenticated HTTP media routes, so this leaves
 * published protocols room without letting an anonymous upgrade reserve an
 * unbounded buffer.
 */
export const PUBLIC_WEBSOCKET_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024;

/** Sockets that upgraded but have not yet proved an app, runner, or attach identity. */
export const PUBLIC_WEBSOCKET_MAX_PENDING_CONNECTIONS = 32;

/**
 * Reserves capacity before `WebSocketServer.handleUpgrade()` constructs a WebSocket. The raw
 * socket listeners cover a failed upgrade as well as every later WebSocket close/error, and the
 * release is deliberately idempotent because either event may win that race.
 */
export class PendingWebsocketLimiter {
  readonly #max: number;
  #pending = 0;

  constructor(max = PUBLIC_WEBSOCKET_MAX_PENDING_CONNECTIONS) {
    this.#max = max;
  }

  reserve(socket: Duplex): (() => void) | undefined {
    if (this.#pending >= this.#max) {
      rejectWebSocketUpgrade(socket);
      return undefined;
    }
    this.#pending += 1;
    let pending = true;
    const release = (): void => {
      if (!pending) return;
      pending = false;
      this.#pending -= 1;
    };
    // These are installed before the upgrade. An invalid bearer or a handleUpgrade failure can
    // otherwise close before a lane has installed its WebSocket-level close listener.
    socket.once("close", release);
    socket.once("error", release);
    return release;
  }
}

/** Refuses an HTTP upgrade before allocating a WebSocket or sending a `101` response. */
export function rejectWebSocketUpgrade(socket: Duplex): void {
  // A raw socket has no default error listener. Keep the refusal path from becoming a process
  // error when the peer resets while this response is being written.
  socket.once("error", () => {});
  socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
}

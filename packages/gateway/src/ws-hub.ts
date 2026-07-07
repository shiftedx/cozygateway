import type { Server } from "node:http";

import { WebSocketServer, WebSocket } from "ws";
import {
  type GatewayInfo,
  type ServerFrame,
  ClientFrameSchema,
  check,
} from "cozygateway-contract";

import type { Storage } from "./storage.ts";
import { hashToken } from "./auth.ts";

interface Client {
  socket: WebSocket;
  deviceId: string;
}

export class WsHub {
  readonly #storage: Storage;
  readonly #gatewayInfo: GatewayInfo;
  readonly #now: () => number;
  readonly #authTimeoutMs: number;
  readonly #clients = new Set<Client>();
  #wss: WebSocketServer | undefined;

  constructor(deps: {
    storage: Storage;
    gatewayInfo: GatewayInfo;
    now: () => number;
    authTimeoutMs?: number;
  }) {
    this.#storage = deps.storage;
    this.#gatewayInfo = deps.gatewayInfo;
    this.#now = deps.now;
    this.#authTimeoutMs = deps.authTimeoutMs ?? 10_000;
  }

  attach(server: Server, path = "/ws"): void {
    const wss = new WebSocketServer({ server, path });
    this.#wss = wss;
    // Swallow server-level errors: an unhandled 'error' event would crash the process.
    wss.on("error", () => {});
    wss.on("connection", (socket) => this.#onConnection(socket));
  }

  #send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  #onConnection(socket: WebSocket): void {
    let client: Client | undefined;
    // A ws socket with no 'error' listener crashes the process on the first socket error.
    socket.on("error", () => {
      try {
        socket.close(1008, "socket error");
      } catch {
        socket.terminate();
      }
    });
    const authTimer = setTimeout(() => {
      if (client === undefined) socket.close(1008, "auth timeout");
    }, this.#authTimeoutMs);

    socket.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        frame = undefined;
      }
      if (!check(ClientFrameSchema, frame)) {
        if (client === undefined) {
          this.#send(socket, { type: "error", code: "unauthorized", message: "first frame must be auth" });
          socket.close(1008, "unauthenticated");
        } else {
          this.#send(socket, { type: "error", code: "invalid_request", message: "unknown frame" });
        }
        return;
      }

      if (frame.type === "auth") {
        if (client !== undefined) {
          this.#send(socket, { type: "error", code: "invalid_request", message: "already authenticated" });
          return;
        }
        const device = this.#storage.deviceByTokenHash(hashToken(frame.token));
        if (device === undefined) {
          this.#send(socket, { type: "error", code: "unauthorized", message: "unknown device token" });
          socket.close(1008, "unauthenticated");
          return;
        }
        clearTimeout(authTimer);
        this.#storage.touchDevice(device.id, this.#now());
        client = { socket, deviceId: device.id };
        this.#clients.add(client);
        this.#send(socket, { type: "ready", deviceId: device.id, gateway: this.#gatewayInfo });
        return;
      }

      if (client === undefined) {
        this.#send(socket, { type: "error", code: "unauthorized", message: "first frame must be auth" });
        socket.close(1008, "unauthenticated");
        return;
      }

      for (const [threadId, sinceSeq] of Object.entries(frame.threads)) {
        for (const message of this.#storage.messagesSince(threadId, sinceSeq)) {
          this.#send(socket, { type: "committed", threadId, seq: message.seq, message });
        }
      }
      this.#send(socket, { type: "synced" });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (client !== undefined) this.#clients.delete(client);
    });
  }

  broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const client of this.#clients) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  }

  hasClients(): boolean {
    return this.#clients.size > 0;
  }

  closeDevice(deviceId: string): void {
    for (const client of this.#clients) {
      if (client.deviceId === deviceId) client.socket.close(1008, "device revoked");
    }
  }

  close(): void {
    for (const client of this.#clients) client.socket.close(1001, "server shutdown");
    this.#wss?.close();
  }
}

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, WebSocket } from "ws";
import {
  type GatewayInfo,
  type MobileNodeRequestFrame,
  type MobileNodeCancelFrame,
  type MobileNodeResultFrame,
  type ServerFrame,
  ClientFrameSchema,
  check,
} from "cozygateway-contract";

import type { Storage } from "./storage.ts";
import { hashToken } from "./auth.ts";
import { emitTrace, traceId, type TraceLog } from "./trace.ts";

interface Client {
  socket: WebSocket;
  deviceId: string;
  heartbeatAlive: boolean;
  mobileNode: boolean;
}

const HEARTBEAT_MS = 5_000;

export class WsHub {
  readonly #storage: Storage;
  readonly #gatewayInfo: GatewayInfo;
  readonly #now: () => number;
  readonly #authTimeoutMs: number;
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;
  readonly #clients = new Set<Client>();
  /** The latest advertised foreground socket per device. Older sibling sockets never receive
   * a mobile request and cannot cancel the selected node when they close. */
  readonly #mobileNodes = new Map<string, Client>();
  // Counts sockets per device rather than a boolean, so a second socket for the same device
  // (e.g. a reconnect racing a still-closing prior connection) doesn't get "undone" by the
  // first socket's close.
  readonly #deviceCounts = new Map<string, number>();
  readonly #wss: WebSocketServer;
  readonly #trace: TraceLog | undefined;
  readonly #onMobileResult: ((deviceId: string, frame: MobileNodeResultFrame) => void) | undefined;
  readonly #onDeviceDisconnect: ((deviceId: string) => void) | undefined;

  constructor(deps: {
    storage: Storage;
    gatewayInfo: GatewayInfo;
    now: () => number;
    authTimeoutMs?: number;
    heartbeatMs?: number;
    trace?: TraceLog;
    onMobileResult?: (deviceId: string, frame: MobileNodeResultFrame) => void;
    onDeviceDisconnect?: (deviceId: string) => void;
  }) {
    this.#storage = deps.storage;
    this.#gatewayInfo = deps.gatewayInfo;
    this.#now = deps.now;
    this.#authTimeoutMs = deps.authTimeoutMs ?? 10_000;
    this.#trace = deps.trace;
    this.#onMobileResult = deps.onMobileResult;
    this.#onDeviceDisconnect = deps.onDeviceDisconnect;
    const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
    // noServer: true means this WebSocketServer never attaches its own 'upgrade' listener; the
    // caller routes matching requests to handleUpgrade() below. See upgrade-dispatcher.ts.
    this.#wss = new WebSocketServer({ noServer: true });
    // Swallow server-level errors: an unhandled 'error' event would crash the process.
    this.#wss.on("error", () => {});
    this.#wss.on("connection", (socket) => this.#onConnection(socket));
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), heartbeatMs);
    this.#heartbeatTimer.unref?.();
  }

  /** Completes a WebSocket handshake for an upgrade request already routed to this hub by
   *  pathname. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit("connection", ws, req));
  }

  #send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  #onConnection(socket: WebSocket): void {
    let client: Client | undefined;
    const connection = traceId(randomUUID());
    emitTrace(this.#trace, "app_ws_open", { connection });
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
        client = { socket, deviceId: device.id, heartbeatAlive: true, mobileNode: false };
        emitTrace(this.#trace, "app_ws_auth", { connection, device: traceId(device.id) });
        this.#clients.add(client);
        this.#deviceCounts.set(device.id, (this.#deviceCounts.get(device.id) ?? 0) + 1);
        this.#send(socket, { type: "ready", deviceId: device.id, gateway: this.#gatewayInfo });
        return;
      }

      if (client === undefined) {
        this.#send(socket, { type: "error", code: "unauthorized", message: "first frame must be auth" });
        socket.close(1008, "unauthenticated");
        return;
      }

      if (frame.type === "mobile_node_advertise") {
        client.mobileNode = frame.foreground && frame.commands.includes("device.status");
        if (client.mobileNode) this.#mobileNodes.set(client.deviceId, client);
        return;
      }
      if (frame.type === "mobile_node_result") {
        if (this.#mobileNodes.get(client.deviceId) === client)
          this.#onMobileResult?.(client.deviceId, frame);
        return;
      }

      for (const [threadId, sinceSeq] of Object.entries(frame.threads)) {
        for (const message of this.#storage.messagesSince(threadId, sinceSeq)) {
          this.#send(socket, { type: "committed", threadId, seq: message.seq, message });
        }
      }
      emitTrace(this.#trace, "app_ws_sync", { connection, device: traceId(client.deviceId), threadCount: Object.keys(frame.threads).length });
      this.#send(socket, { type: "synced" });
    });

    socket.on("pong", () => {
      if (client !== undefined) client.heartbeatAlive = true;
    });

    socket.on("close", (code) => {
      clearTimeout(authTimer);
      if (client !== undefined) {
        this.#clients.delete(client);
        this.#releaseDevice(client.deviceId);
        if (this.#mobileNodes.get(client.deviceId) === client) {
          this.#mobileNodes.delete(client.deviceId);
          this.#onDeviceDisconnect?.(client.deviceId);
        }
      }
      emitTrace(this.#trace, "app_ws_close", { connection, device: client === undefined ? null : traceId(client.deviceId), code });
    });
  }

  /** Decrements a device's live-socket count, dropping the map entry once it reaches zero.
   *  Multiple sockets for the same device (see `#deviceCounts`) keep the device connected
   *  until every one of them has closed. */
  #releaseDevice(deviceId: string): void {
    const count = (this.#deviceCounts.get(deviceId) ?? 1) - 1;
    if (count <= 0) this.#deviceCounts.delete(deviceId);
    else this.#deviceCounts.set(deviceId, count);
  }

  /** A socket can remain OPEN in Node after the phone process has disappeared and before TCP's own
   *  much longer timeout notices. One missed application heartbeat is tolerated; the next tick
   *  terminates it, so dead sockets stop suppressing push within two short intervals. */
  #heartbeat(): void {
    for (const client of this.#clients) {
      if (!client.heartbeatAlive) {
        client.socket.terminate();
        continue;
      }
      client.heartbeatAlive = false;
      try {
        client.socket.ping();
      } catch {
        client.socket.terminate();
      }
    }
  }

  broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const client of this.#clients) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  }

  /** A fresh snapshot of every device with at least one live socket, taken synchronously.
   *  Callers that hold onto the returned set are unaffected by connections/disconnections
   *  that happen afterward. */
  connectedDeviceIds(): ReadonlySet<string> {
    return new Set(this.#deviceCounts.keys());
  }

  /** Live (not snapshotted) check: whether `deviceId` has at least one open socket right now. */
  isDeviceConnected(deviceId: string): boolean {
    return (this.#deviceCounts.get(deviceId) ?? 0) > 0;
  }

  closeDevice(deviceId: string): void {
    for (const client of this.#clients) {
      if (client.deviceId === deviceId) client.socket.close(1008, "device revoked");
    }
  }

  sendToDevice(deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame): boolean {
    const client = this.#mobileNodes.get(deviceId);
    if (client === undefined || client.socket.readyState !== WebSocket.OPEN) return false;
    client.socket.send(JSON.stringify(frame));
    return true;
  }

  isMobileNodeAvailable(deviceId: string): boolean {
    const client = this.#mobileNodes.get(deviceId);
    return client !== undefined && client.socket.readyState === WebSocket.OPEN;
  }

  close(): void {
    clearInterval(this.#heartbeatTimer);
    for (const client of this.#clients) client.socket.close(1001, "server shutdown");
    this.#wss.close();
  }
}

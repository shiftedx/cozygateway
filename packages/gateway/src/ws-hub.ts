import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, WebSocket } from "ws";
import {
  type GatewayInfo,
  type MobileNodeRequestFrame,
  type MobileNodeCancelFrame,
  type MobileNodeProgressFrame,
  type MobileNodeResultFrame,
  type ServerFrame,
  ClientFrameSchema,
  check,
} from "cozygateway-contract";

import type { ObserveSubscriptionKind } from "cozygateway-contract";
import type { Storage } from "./storage.ts";
import type { DeviceScope } from "cozygateway-contract";
import { hashToken } from "./auth.ts";
import {
  emitMobileNodeFailure,
  type MobileNodeCommand,
  type MobileNodeRoute,
  type MobileNodeSendOutcome,
} from "./mobile-node.ts";
import { emitTrace, traceId, type TraceLog } from "./trace.ts";
import { monotonicNow, type ObservationRing } from "./observe/ring.ts";
import { deviceOriginVia, type DeviceOriginVia } from "./observe/origin.ts";
import {
  PUBLIC_WEBSOCKET_MAX_PAYLOAD_BYTES,
  PUBLIC_WEBSOCKET_MAX_PENDING_CONNECTIONS,
  PendingWebsocketLimiter,
} from "./websocket-limits.ts";

interface Client {
  socket: WebSocket;
  deviceId: string;
  /** Capability 72. What this socket's token may do. A `read` socket is an observer: it may
   *  authenticate and it may `sync`, and every command frame is refused. */
  scope: DeviceScope;
  heartbeatAlive: boolean;
  mobileCommands: Set<MobileNodeRequestFrame["command"]>;
  mobileForeground: boolean;
  /** What this client said it understands on `auth`, or undefined when it said nothing. */
  capabilities?: Record<string, number>;
  /** Capability 75. Which observation frame kinds this socket asked for, or undefined when it has
   *  asked for none. Governs ONLY a read-scoped socket: a write-scoped client's frames are exactly
   *  what they were before this row, and it never receives an `observe_*` frame at all. */
  observeKinds?: Set<ObserveSubscriptionKind>;
  observeQueue?: string[];
  observeDropped?: number;
  observeTimer?: ReturnType<typeof setTimeout>;
}

/** Frames a client is sent only when it did not rule itself out. A client that declares a version
 *  BELOW the number here is not sent that frame at all, so "additive" means what it says rather
 *  than "one extra frame it drops"; a client that declares nothing is sent it and ignores what it
 *  does not know, which is what every client shipped before the declaration existed does. */
const CAPABILITY_GATED_FRAMES: Record<string, { capability: string; minimum: number }> = {
  bot_draft_updated: { capability: "com.cozylabs.bots", minimum: 71 },
};

function understands(client: Client, frame: ServerFrame): boolean {
  const gate = CAPABILITY_GATED_FRAMES[frame.type];
  if (gate === undefined) return true;
  const declared = client.capabilities?.[gate.capability];
  return declared === undefined || declared >= gate.minimum;
}

const HEARTBEAT_MS = 5_000;

export class WsHub {
  readonly #storage: Storage;
  readonly #gatewayInfo: GatewayInfo;
  readonly #now: () => number;
  readonly #authTimeoutMs: number;
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;
  readonly #clients = new Set<Client>();
  /** The latest advertised eligible socket per device. Status remains eligible in background;
   * location does not. Older sibling sockets never receive
   * a mobile request and cannot cancel the selected node when they close. */
  readonly #mobileNodes = new Map<string, Client>();
  // Counts sockets per device rather than a boolean, so a second socket for the same device
  // (e.g. a reconnect racing a still-closing prior connection) doesn't get "undone" by the
  // first socket's close.
  readonly #deviceCounts = new Map<string, number>();
  readonly #wss: WebSocketServer;
  readonly #trace: TraceLog | undefined;
  readonly #onMobileResult: ((deviceId: string, frame: MobileNodeResultFrame) => void) | undefined;
  readonly #onMobileProgress: ((deviceId: string, frame: MobileNodeProgressFrame) => void) | undefined;
  readonly #onDeviceDisconnect: ((deviceId: string) => void) | undefined;
  readonly #onMobileAvailable: ((deviceId: string) => void) | undefined;
  readonly #pendingConnections: PendingWebsocketLimiter;
  /** Dashboard packet D2. The heartbeat already proves a device is alive; these two maps are what
   *  turn that proof into a measured round trip. They are keyed by socket rather than carried on
   *  the Client record so the authenticated-client shape is untouched: a device that never
   *  authenticates is never pinged and never appears here.
   *
   *  Monotonic readings only. A ping-to-pong measured across two `Date.now()` calls would report an
   *  hour when the clock stepped, and the ring would store it as a real network round trip. */
  readonly #pingSentAt = new WeakMap<WebSocket, number>();
  readonly #originVia = new WeakMap<WebSocket, DeviceOriginVia>();
  readonly #observe: ObservationRing | undefined;
  readonly #publicHost: string | undefined;

  constructor(deps: {
    storage: Storage;
    gatewayInfo: GatewayInfo;
    now: () => number;
    authTimeoutMs?: number;
    heartbeatMs?: number;
    trace?: TraceLog;
    onMobileResult?: (deviceId: string, frame: MobileNodeResultFrame) => void;
    onMobileProgress?: (deviceId: string, frame: MobileNodeProgressFrame) => void;
    onDeviceDisconnect?: (deviceId: string) => void;
    onMobileAvailable?: (deviceId: string) => void;
    /** Dashboard packet D2. Absent means the observation ring is off, and then the heartbeat does
     *  exactly what it did before: flip a boolean and ping. */
    observe?: ObservationRing;
    /** The operator's advertised public hostname, used only to tell a connection that came through
     *  the tunnel from one that came straight off the LAN. */
    publicHost?: string;
    /** Test seam; production keeps a bounded unauthenticated handshake pool. */
    maxPendingConnections?: number;
  }) {
    this.#storage = deps.storage;
    this.#gatewayInfo = deps.gatewayInfo;
    this.#now = deps.now;
    this.#authTimeoutMs = deps.authTimeoutMs ?? 10_000;
    this.#trace = deps.trace;
    this.#onMobileResult = deps.onMobileResult;
    this.#onMobileProgress = deps.onMobileProgress;
    this.#onDeviceDisconnect = deps.onDeviceDisconnect;
    this.#onMobileAvailable = deps.onMobileAvailable;
    this.#observe = deps.observe?.enabled === true ? deps.observe : undefined;
    this.#observe?.bindEmitter((frame) => this.broadcast(frame));
    this.#publicHost = deps.publicHost;
    this.#pendingConnections = new PendingWebsocketLimiter(deps.maxPendingConnections ?? PUBLIC_WEBSOCKET_MAX_PENDING_CONNECTIONS);
    const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
    // noServer: true means this WebSocketServer never attaches its own 'upgrade' listener; the
    // caller routes matching requests to handleUpgrade() below. See upgrade-dispatcher.ts.
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: PUBLIC_WEBSOCKET_MAX_PAYLOAD_BYTES });
    // Swallow server-level errors: an unhandled 'error' event would crash the process.
    this.#wss.on("error", () => {});
    this.#wss.on("connection", (socket: WebSocket, req: IncomingMessage, releasePending: () => void) => this.#onConnection(socket, req, releasePending));
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), heartbeatMs);
    this.#heartbeatTimer.unref?.();
  }

  /** Completes a WebSocket handshake for an upgrade request already routed to this hub by
   *  pathname. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const releasePending = this.#pendingConnections.reserve(socket);
    if (releasePending === undefined) return;
    try {
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit("connection", ws, req, releasePending));
    } catch {
      releasePending();
      socket.destroy();
    }
  }

  #send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  #onConnection(socket: WebSocket, req?: IncomingMessage, releasePending?: () => void): void {
    let client: Client | undefined;
    // Dashboard packet D2, design section 10. Which path this socket arrived on decides which
    // distribution its round trips belong to; read once here, because the request is gone by the
    // time the first pong comes back. Recorded before authentication and used only after it.
    if (this.#observe !== undefined) this.#originVia.set(socket, deviceOriginVia(req, this.#publicHost));
    // The raw socket reservation is already listening, but release here as well so a WebSocket
    // error or close that races authentication cannot keep its slot until TCP teardown.
    socket.once("close", () => releasePending?.());
    const connection = traceId(randomUUID());
    emitTrace(this.#trace, "app_ws_open", { connection });
    // A ws socket with no 'error' listener crashes the process on the first socket error.
    socket.on("error", () => {
      releasePending?.();
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
        const looksLikeMobileResult = typeof frame === "object" && frame !== null
          && (frame as { type?: unknown }).type === "mobile_node_result";
        if (client !== undefined && this.#mobileNodes.get(client.deviceId) === client
          && (frame === undefined || looksLikeMobileResult)) {
          const selected = this.#mobileNodes.get(client.deviceId);
          emitMobileNodeFailure(this.#trace, "invalid_phone_payload", {
            command: "unknown",
            selectedDevicePresent: true,
            selectedSocketPresent: selected !== undefined,
            selectedSocketOpen: selected?.socket.readyState === WebSocket.OPEN,
            commandAdvertised: (selected?.mobileCommands.size ?? 0) > 0,
            connectedSocketCount: this.#connectedSocketCount(client.deviceId),
            payloadParseable: frame !== undefined,
            payloadSchemaValid: false,
          });
        }
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
        releasePending?.();
        this.#storage.touchDevice(device.id, this.#now());
        this.#storage.recordDeviceEdgeProbe(device.id, frame.edgeRttMs, frame.edgeColo);
        client = {
          socket, deviceId: device.id, scope: device.scope, heartbeatAlive: true, mobileCommands: new Set(),
          mobileForeground: false,
          ...(frame.capabilities === undefined ? {} : { capabilities: frame.capabilities }),
        };
        emitTrace(this.#trace, "app_ws_auth", { connection, device: traceId(device.id) });
        this.#clients.add(client);
        this.#deviceCounts.set(device.id, (this.#deviceCounts.get(device.id) ?? 0) + 1);
        this.#send(socket, { type: "ready", deviceId: device.id, gateway: this.#gatewayInfo });
        if (client.scope === "write") this.#send(socket, { type: "cozyapps_snapshot", ...this.#storage.cozyAppsSnapshot() });
        return;
      }

      if (client === undefined) {
        this.#send(socket, { type: "error", code: "unauthorized", message: "first frame must be auth" });
        socket.close(1008, "unauthenticated");
        return;
      }

      // Capability 72. THE ONE ENFORCEMENT POINT on this socket, the websocket half of the rule
      // the HTTP middleware applies to every write route. `auth` is handled above and `sync` is a
      // read; everything else a client can send is a command, so the check is written as "not a
      // read frame" rather than as a list of commands to keep in step, and a client frame added
      // later is refused for a read token by construction.
      // Fail closed for the same reason the HTTP middleware does: any scope that is not `write`
      // may send `auth` and `sync` and nothing else.
      // Capability 75. `observe_subscribe` and `observe_unsubscribe` are READS: they say which
      // frames this socket wants and change nothing else, which is why they join `sync` on the
      // read side of the rule rather than widening what a read token may do.
      if (
        client.scope !== "write"
        && frame.type !== "sync"
        && frame.type !== "observe_subscribe"
        && frame.type !== "observe_unsubscribe"
      ) {
        this.#send(socket, {
          type: "error", code: "scope_read_only", message: "this device token may only read",
        });
        return;
      }

      if (frame.type === "mobile_node_advertise") {
        client.mobileForeground = frame.foreground;
        client.mobileCommands = new Set(
          frame.foreground ? frame.commands : frame.commands.filter((command) => command === "device.status"),
        );
        if (client.mobileCommands.size) {
          const selected = this.#mobileNodes.get(client.deviceId);
          const liveSiblingForeground = selected !== undefined
            && selected !== client
            && selected.socket.readyState === WebSocket.OPEN
            && selected.mobileForeground;
          if (!liveSiblingForeground || client.mobileForeground) {
            this.#mobileNodes.set(client.deviceId, client);
            this.#onMobileAvailable?.(client.deviceId);
          }
        } else if (this.#mobileNodes.get(client.deviceId) === client) {
          this.#mobileNodes.delete(client.deviceId);
          this.#onDeviceDisconnect?.(client.deviceId);
        }
        return;
      }
      if (frame.type === "mobile_node_result") {
        if (this.#mobileNodes.get(client.deviceId) === client)
          this.#onMobileResult?.(client.deviceId, frame);
        return;
      }
      // Capability 68. Same selected-socket rule the result above follows: only the socket this
      // device's requests were routed to can say anything about one.
      if (frame.type === "mobile_node_progress") {
        if (this.#mobileNodes.get(client.deviceId) === client)
          this.#onMobileProgress?.(client.deviceId, frame);
        return;
      }

      if (frame.type === "observe_subscribe") {
        client.observeKinds = new Set(frame.kinds);
        return;
      }
      if (frame.type === "observe_unsubscribe") {
        client.observeKinds = undefined;
        this.#clearObserveQueue(client);
        return;
      }

      for (const [threadId, sinceSeq] of Object.entries(client.scope === "write" ? frame.threads : {})) {
        for (const message of this.#storage.messagesSince(threadId, sinceSeq)) {
          this.#send(socket, { type: "committed", threadId, seq: message.seq, message });
        }
      }
      emitTrace(this.#trace, "app_ws_sync", { connection, device: traceId(client.deviceId), threadCount: Object.keys(frame.threads).length });
      this.#send(socket, { type: "synced" });
    });

    socket.on("pong", () => {
      if (client === undefined) return;
      client.heartbeatAlive = true;
      // Dashboard packet D2. The one hop that includes everything between the person's phone and
      // this process: their radio, their VPN, the edge, the tunnel and the accept.
      const sentAt = this.#pingSentAt.get(socket);
      if (sentAt === undefined || this.#observe === undefined) return;
      this.#pingSentAt.delete(socket);
      this.#observe.deviceRtt(client.deviceId, monotonicNow() - sentAt, this.#originVia.get(socket) ?? "lan");
    });

    socket.on("close", (code) => {
      clearTimeout(authTimer);
      releasePending?.();
      if (client !== undefined) {
        this.#clearObserveQueue(client);
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
        // Dashboard packet D2. A missed interval is a measured silence, not a round trip, so it
        // gets its own series rather than a made-up large `device_rtt_ms`.
        const outstandingSince = this.#pingSentAt.get(client.socket);
        if (this.#observe !== undefined && outstandingSince !== undefined) {
          this.#observe.heartbeatGap(client.deviceId, monotonicNow() - outstandingSince);
        }
        client.socket.terminate();
        continue;
      }
      client.heartbeatAlive = false;
      try {
        client.socket.ping();
        if (this.#observe !== undefined) this.#pingSentAt.set(client.socket, monotonicNow());
      } catch {
        client.socket.terminate();
      }
    }
  }

  #clearObserveQueue(client: Client): void {
    if (client.observeTimer !== undefined) clearTimeout(client.observeTimer);
    client.observeTimer = undefined;
    client.observeQueue = [];
    client.observeDropped = 0;
  }

  #queueObserve(client: Client, frame: ServerFrame): void {
    const queue = client.observeQueue ??= [];
    if (queue.length >= 256) {
      queue.shift();
      client.observeDropped = (client.observeDropped ?? 0) + 1;
    }
    queue.push(JSON.stringify(frame));
    this.#scheduleObserve(client);
  }

  #scheduleObserve(client: Client): void {
    if (client.observeTimer !== undefined) return;
    client.observeTimer = setTimeout(() => {
      client.observeTimer = undefined;
      if (client.socket.readyState !== WebSocket.OPEN || client.observeKinds === undefined) {
        this.#clearObserveQueue(client);
        return;
      }
      if (client.socket.bufferedAmount < 64 * 1024) {
        if ((client.observeDropped ?? 0) > 0) {
          this.#send(client.socket, { type: "observe_gap", dropped: client.observeDropped! });
          client.observeDropped = 0;
        }
        const queue = client.observeQueue ?? [];
        while (queue.length > 0 && client.socket.bufferedAmount < 64 * 1024) {
          client.socket.send(queue.shift()!);
        }
      }
      if ((client.observeQueue?.length ?? 0) > 0) this.#scheduleObserve(client);
    }, 10);
    client.observeTimer.unref();
  }

  broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const client of this.#clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (!understands(client, frame)) continue;
      if (client.scope === "read") {
        if (frame.type === "bot_chat_delta") {
          if (client.observeKinds?.has("observe_chat_delta")) {
            this.#queueObserve(client, {
              type: "observe_chat_delta", bot: frame.bot, turnId: frame.turnId,
              seq: frame.seq, textLength: frame.text.length, updatedAt: frame.updatedAt,
              ...(frame.done === undefined ? {} : { done: frame.done }),
            });
          }
        } else if (client.observeKinds?.has(frame.type as ObserveSubscriptionKind)) {
          if (frame.type === "observe_sample" || frame.type === "observe_event" || frame.type === "observe_chat_delta") {
            this.#queueObserve(client, frame);
          } else if (frame.type === "bot_task_updated" || frame.type === "bot_presence" || frame.type === "bot_roster"
            || frame.type === "bot_approval_pending" || frame.type === "bot_approval_resolved") {
            this.#queueObserve(client, { type: "observe_update", kind: frame.type, at: this.#now() });
          }
        }
        continue;
      }
      if (frame.type.startsWith("observe_")) continue;
      client.socket.send(payload);
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

  #connectedSocketCount(deviceId: string): number {
    let count = 0;
    for (const client of this.#clients) {
      if (client.deviceId === deviceId && client.socket.readyState === WebSocket.OPEN) count += 1;
    }
    return count;
  }

  mobileNodeRoute(deviceId: string, command: MobileNodeCommand = "device.status"): MobileNodeRoute {
    const client = this.#mobileNodes.get(deviceId);
    const connectedSocketCount = this.#connectedSocketCount(deviceId);
    if (client === undefined) {
      return {
        status: connectedSocketCount > 0 ? "command_not_advertised" : "selected_socket_unavailable",
        selectedSocketPresent: false,
        selectedSocketOpen: false,
        commandAdvertised: false,
        foreground: false,
        connectedSocketCount,
      };
    }
    const selectedSocketOpen = client.socket.readyState === WebSocket.OPEN;
    const commandAdvertised = client.mobileCommands.has(command);
    return {
      status: !selectedSocketOpen
        ? "selected_socket_unavailable"
        : commandAdvertised ? "available" : "command_not_advertised",
      selectedSocketPresent: true,
      selectedSocketOpen,
      commandAdvertised,
      foreground: client.mobileForeground,
      connectedSocketCount,
    };
  }

  sendMobileNodeFrame(
    deviceId: string,
    frame: MobileNodeRequestFrame | MobileNodeCancelFrame,
  ): MobileNodeSendOutcome {
    const client = this.#mobileNodes.get(deviceId);
    if (client === undefined) return "selected_socket_unavailable";
    if (client.socket.readyState !== WebSocket.OPEN) return "selected_socket_unavailable";
    if (frame.type === "mobile_node_request" && !client.mobileCommands.has(frame.command))
      return "command_not_advertised";
    try {
      client.socket.send(JSON.stringify(frame));
      return "sent";
    } catch {
      return "frame_send_failed";
    }
  }

  sendToDevice(deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame): boolean {
    return this.sendMobileNodeFrame(deviceId, frame) === "sent";
  }

  isMobileNodeAvailable(deviceId: string, command: MobileNodeRequestFrame["command"] = "device.status"): boolean {
    return this.mobileNodeRoute(deviceId, command).status === "available";
  }

  close(): void {
    clearInterval(this.#heartbeatTimer);
    this.#observe?.bindEmitter(undefined);
    for (const client of this.#clients) this.#clearObserveQueue(client);
    for (const client of this.#clients) client.socket.close(1001, "server shutdown");
    this.#wss.close();
  }
}

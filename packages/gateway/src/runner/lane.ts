import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { check } from "cozygateway-contract";
import { WebSocket, WebSocketServer } from "ws";

import { resolveAttachBearer } from "../adapters/attach/token-auth.ts";
import {
  PendingWebsocketLimiter,
  PUBLIC_WEBSOCKET_MAX_PAYLOAD_BYTES,
  PUBLIC_WEBSOCKET_MAX_PENDING_CONNECTIONS,
} from "../websocket-limits.ts";
import { LEGACY_RUNNER_ID, type RunnerRoster } from "./roster.ts";
import {
  platformLabel,
  RUNNER_CLIENT_FRAME_KINDS,
  RunnerClientFrameSchema,
  type RunnerChatCommandFrame,
  type RunnerChatFrame,
  type RunnerHello,
  type RunnerServerFrame,
  RUNNER_V1_HEARTBEAT_INTERVAL_MS,
  RUNNER_V1_HEARTBEAT_TIMEOUT_MS,
  RUNNER_V1_VERSION,
} from "./protocol.ts";

export interface RunnerLaneOptions {
  token?: string;
  roster?: RunnerRoster;
  now?: () => number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  log?: (line: string) => void;
  maxPendingConnections?: number;
}

interface RunnerConnection {
  socket: WebSocket;
  hello: boolean;
  key: string;
  rowId?: string;
  agentVersion?: string;
  chatExecution?: boolean;
  chatExecutionHarnesses?: readonly ("cozyagents" | "hermes")[];
  lastSeenAt: number;
}

/** Authenticated remote-computer stream for Hermes chat execution only. */
export class RunnerLane {
  readonly #token: string | undefined;
  readonly #roster: RunnerRoster | undefined;
  readonly #now: () => number;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #log: (line: string) => void;
  readonly #wss: WebSocketServer;
  readonly #connections = new Map<string, RunnerConnection>();
  readonly #pendingConnections: PendingWebsocketLimiter;
  readonly #chatListeners = new Set<(runnerId: string, frame: RunnerChatFrame) => void>();
  readonly #chatConnections = new Set<(runnerId: string, hello: RunnerHello | undefined) => void>();
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(opts: RunnerLaneOptions) {
    this.#token = opts.token;
    this.#roster = opts.roster;
    this.#now = opts.now ?? Date.now;
    this.#heartbeatIntervalMs = opts.heartbeatIntervalMs ?? RUNNER_V1_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? RUNNER_V1_HEARTBEAT_TIMEOUT_MS;
    this.#log = opts.log ?? ((line) => void process.stderr.write(`[runner] ${line}\n`));
    this.#pendingConnections = new PendingWebsocketLimiter(
      opts.maxPendingConnections ?? PUBLIC_WEBSOCKET_MAX_PENDING_CONNECTIONS,
    );
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: PUBLIC_WEBSOCKET_MAX_PAYLOAD_BYTES });
    this.#wss.on("error", () => {});
    this.#wss.on("connection", (socket: WebSocket, req: IncomingMessage, release: () => void) =>
      this.#onConnection(socket, req, release));
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const release = this.#pendingConnections.reserve(socket);
    if (release === undefined) return;
    try {
      this.#wss.handleUpgrade(req, socket, head, (ws) =>
        this.#wss.emit("connection", ws, req, release));
    } catch {
      release();
      socket.destroy();
    }
  }

  connectedRunners(): readonly string[] {
    return [...this.#connections].filter(([, connection]) => connection.hello).map(([id]) => id);
  }

  chatCapableRunners(_harness?: "hermes"): readonly string[] {
    return [...this.#connections]
      .filter(([, connection]) => connection.hello && connection.chatExecution
        && connection.chatExecutionHarnesses?.includes("hermes"))
      .map(([id]) => id);
  }

  sendChatCommand(runnerId: string, frame: RunnerChatCommandFrame): boolean {
    const connection = this.#connections.get(runnerId);
    if (!connection?.hello || !connection.chatExecution || connection.socket.readyState !== WebSocket.OPEN)
      return false;
    connection.socket.send(JSON.stringify(frame));
    return true;
  }

  onChatFrame(listener: (runnerId: string, frame: RunnerChatFrame) => void): () => void {
    this.#chatListeners.add(listener);
    return () => this.#chatListeners.delete(listener);
  }

  onChatConnection(listener: (runnerId: string, hello: RunnerHello | undefined) => void): () => void {
    this.#chatConnections.add(listener);
    return () => this.#chatConnections.delete(listener);
  }

  agentVersion(id: string): string | undefined {
    return this.#connections.get(id)?.agentVersion;
  }

  lastContactAt(id: string): number | null {
    return this.#connections.get(id)?.lastSeenAt ?? null;
  }

  disconnectRunner(id: string): boolean {
    const connection = this.#connections.get(id);
    if (connection === undefined) return false;
    this.#connections.delete(id);
    connection.socket.close(1008, "computer revoked");
    return true;
  }

  close(): void {
    this.#closed = true;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    for (const connection of this.#connections.values())
      connection.socket.close(1001, "gateway shutting down");
    this.#connections.clear();
    this.#wss.close();
  }

  #onConnection(socket: WebSocket, req: IncomingMessage, release?: () => void): void {
    socket.once("close", () => release?.());
    socket.on("error", () => {
      release?.();
      socket.terminate();
    });
    if (this.#closed) {
      socket.close(1001, "gateway shutting down");
      return;
    }
    const row = this.#roster?.resolve(req.headers.authorization);
    const legacy = row === undefined && this.#token !== undefined
      && resolveAttachBearer(new Map([[this.#token, "runner"]]), req.headers.authorization) !== undefined;
    if (row === undefined && !legacy) {
      socket.close(1008, "unauthorized");
      return;
    }
    const connection: RunnerConnection = {
      socket,
      hello: false,
      key: row?.id ?? LEGACY_RUNNER_ID,
      rowId: row?.id,
      lastSeenAt: this.#now(),
    };
    const helloTimer = setTimeout(() => {
      if (!connection.hello) socket.close(1002, "runner-v1 hello required");
    }, 5_000);
    helloTimer.unref();

    socket.on("message", (data) => {
      connection.lastSeenAt = this.#now();
      if (connection.rowId !== undefined && connection.hello)
        this.#roster?.touch(connection.rowId, connection.lastSeenAt);
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(data));
      } catch {
        socket.close(1002, "frame is not JSON");
        return;
      }
      const kind = (decoded as { kind?: unknown }).kind;
      if (typeof kind !== "string" || !RUNNER_CLIENT_FRAME_KINDS.has(kind)) {
        this.#log("ignored unknown runner-v1 frame");
        return;
      }
      if (!check(RunnerClientFrameSchema, decoded)) {
        socket.close(1002, `malformed runner-v1 ${kind} frame`);
        return;
      }
      const frame = decoded;
      if (!connection.hello) {
        if (frame.kind !== "hello") {
          socket.close(1002, "runner-v1 hello required");
          return;
        }
        if (frame.version !== RUNNER_V1_VERSION) {
          socket.close(1002, `this gateway speaks runner-v1 version ${RUNNER_V1_VERSION} only`);
          return;
        }
        if (connection.rowId !== undefined && frame.runnerId !== connection.rowId) {
          socket.close(1008, "hello runnerId does not match the paired computer");
          return;
        }
        clearTimeout(helloTimer);
        release?.();
        const previous = this.#connections.get(connection.key);
        if (previous !== undefined && previous.socket !== socket)
          previous.socket.close(4000, "superseded");
        connection.hello = true;
        connection.agentVersion = frame.agentVersion;
        connection.chatExecution = frame.capabilities?.chat_execution === 1 && frame.backends.includes("process");
        // Older computers never advertised which harness they can execute. Do not infer Hermes.
        connection.chatExecutionHarnesses = frame.chatExecutionHarnesses ?? [];
        this.#connections.set(connection.key, connection);
        if (connection.rowId !== undefined) {
          this.#roster?.observe(connection.rowId, {
            backends: frame.backends,
            ...(frame.name === undefined ? {} : { name: frame.name }),
            ...(frame.platform === undefined ? {} : { platform: platformLabel(frame.platform)! }),
            ...(frame.agentVersion === undefined ? {} : { version: frame.agentVersion }),
          });
        }
        socket.send(JSON.stringify({
          kind: "hello_ack",
          version: RUNNER_V1_VERSION,
          capabilities: connection.chatExecution ? ["chat_execution"] : [],
          heartbeatIntervalMs: this.#heartbeatIntervalMs,
        } satisfies RunnerServerFrame));
        this.#startHeartbeat();
        for (const listener of this.#chatConnections) listener(connection.key, frame);
        return;
      }
      if (frame.kind === "hello") {
        socket.close(1002, "duplicate runner-v1 hello");
        return;
      }
      if (frame.kind === "heartbeat") return;
      if (!connection.chatExecution) {
        socket.close(1008, "chat execution capability required");
        return;
      }
      for (const listener of this.#chatListeners) listener(connection.key, frame);
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      release?.();
      if (this.#connections.get(connection.key)?.socket === socket) {
        this.#connections.delete(connection.key);
        for (const listener of this.#chatConnections) listener(connection.key, undefined);
      }
      if (this.#connections.size === 0 && this.#heartbeat !== undefined) {
        clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
      }
    });
  }

  #startHeartbeat(): void {
    if (this.#heartbeat !== undefined) return;
    this.#heartbeat = setInterval(() => {
      const now = this.#now();
      for (const connection of [...this.#connections.values()]) {
        if (now - connection.lastSeenAt > this.#heartbeatTimeoutMs) {
          connection.socket.terminate();
          continue;
        }
        connection.socket.send(JSON.stringify({ kind: "heartbeat", sentAt: now } satisfies RunnerServerFrame));
      }
    }, this.#heartbeatIntervalMs);
    this.#heartbeat.unref?.();
  }
}

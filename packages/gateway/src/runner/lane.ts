import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { check } from "cozygateway-contract";
import { WebSocket, WebSocketServer } from "ws";

import { resolveAttachBearer } from "../adapters/attach/token-auth.ts";
import type { RunnerOperationRow, Storage } from "../storage.ts";
import {
  RUNNER_V1_HEARTBEAT_INTERVAL_MS,
  RUNNER_V1_HEARTBEAT_TIMEOUT_MS,
  RUNNER_V1_VERSION,
  RunnerClientFrameSchema,
  type RunnerClientFrame,
  type RunnerCreateRuntimePayload,
  type RunnerReceipt,
  type RunnerServerFrame,
} from "./protocol.ts";

export interface RunnerLaneOptions {
  /** The single runner credential, from `COZYGATEWAY_RUNNER_TOKEN`. Absent means no lane at all;
   *  the caller decides that, because a gateway with no runner still accepts operations. */
  token: string;
  storage: Storage;
  /** The attach credential to inject for a bot, read at SEND time from the runtime bot row so no
   *  secret is ever at rest inside an operations row. */
  attachTokenFor: (botId: string) => string | undefined;
  now?: () => number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** A receipt landed. The gateway uses this to refresh what the app sees; the callback is handed
   *  identity and stage only, never the payload. */
  onReceipt?: (receipt: RunnerReceipt) => void;
  /** Diagnostics sink. Every line here carries ids, stages and counts only: no token, no env
   *  value, no host path (ADR 0002). */
  log?: (line: string) => void;
}

interface RunnerConnection {
  socket: WebSocket;
  hello: boolean;
  runnerId: string;
  backends: readonly string[];
  lastSeenAt: number;
}

/** The gateway half of the CozyRunner control stream (`/runner/v1`, capability 49).
 *
 * One runner at a time, authenticated by one operator-placed bearer token. It holds NO desired
 * state of its own: the durable truth is `runner_operations` in storage, and this lane is only the
 * transport that hands an operation to a runner and writes its receipts back. That is what lets a
 * create accepted while no runner was connected sit honestly in `waiting_for_runner` and reconcile
 * the moment one arrives, rather than failing or being invented into progress. */
export class RunnerLane {
  readonly #token: string;
  readonly #storage: Storage;
  readonly #attachTokenFor: (botId: string) => string | undefined;
  readonly #now: () => number;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #onReceipt: RunnerLaneOptions["onReceipt"];
  readonly #log: (line: string) => void;
  readonly #wss: WebSocketServer;
  #connection: RunnerConnection | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(opts: RunnerLaneOptions) {
    this.#token = opts.token;
    this.#storage = opts.storage;
    this.#attachTokenFor = opts.attachTokenFor;
    this.#now = opts.now ?? Date.now;
    this.#heartbeatIntervalMs = opts.heartbeatIntervalMs ?? RUNNER_V1_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? RUNNER_V1_HEARTBEAT_TIMEOUT_MS;
    this.#onReceipt = opts.onReceipt;
    this.#log = opts.log ?? ((line) => void process.stderr.write(`[runner] ${line}\n`));
    this.#wss = new WebSocketServer({ noServer: true });
    this.#wss.on("connection", (socket, req) => this.#onConnection(socket, req));
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit("connection", ws, req));
  }

  /** Whether a runner has completed its hello. A create is still accepted when this is false. */
  connected(): boolean {
    return this.#connection?.hello === true;
  }

  /** When the runner last said anything at all, or null while none is connected. */
  lastContactAt(): number | null {
    return this.#connection?.lastSeenAt ?? null;
  }

  /** Hands every not-yet-sent operation to the connected runner, oldest first. Safe to call at any
   *  time: with no runner it does nothing and the operations keep waiting. */
  dispatchPending(): void {
    const connection = this.#connection;
    if (connection === undefined || !connection.hello) return;
    for (const operation of this.#storage.unsentRunnerOperations()) {
      this.#send(connection, operation);
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#connection?.socket.close(1001, "gateway shutting down");
    this.#connection = undefined;
    this.#wss.close();
  }

  #send(connection: RunnerConnection, operation: RunnerOperationRow): void {
    let frame: RunnerServerFrame;
    if (operation.kind === "create_runtime") {
      const attachToken = this.#attachTokenFor(operation.bot);
      if (attachToken === undefined) {
        // The bot was deleted between acceptance and this send. Its `delete_runtime` is already
        // queued behind this row, so dropping the create is the honest reconciliation, not a loss.
        this.#log(`operation ${operation.operationId} skipped: bot ${operation.bot} no longer exists`);
        this.#storage.markRunnerOperationSent(operation.operationId, this.#now());
        return;
      }
      frame = {
        kind: "command",
        command: "create_runtime",
        payload: {
          ...(operation.payload as Omit<
            RunnerCreateRuntimePayload,
            "operationId" | "botId" | "specGeneration" | "attachToken"
          >),
          operationId: operation.operationId,
          botId: operation.bot,
          specGeneration: operation.specGeneration,
          attachToken,
        },
      };
    } else {
      frame = {
        kind: "command",
        command: "delete_runtime",
        payload: {
          operationId: operation.operationId,
          botId: operation.bot,
          specGeneration: operation.specGeneration,
        },
      };
    }
    connection.socket.send(JSON.stringify(frame));
    this.#storage.markRunnerOperationSent(operation.operationId, this.#now());
    this.#log(`sent ${operation.kind} ${operation.operationId} for bot ${operation.bot}`);
  }

  #onConnection(socket: WebSocket, req: IncomingMessage): void {
    socket.on("error", () => socket.terminate());
    if (this.#closed) {
      socket.close(1001, "gateway shutting down");
      return;
    }
    // One map, one entry, resolved by the same constant-time scan every other credential on this
    // gateway goes through, so a wrong token cannot be found by timing.
    const holder = resolveAttachBearer(new Map([[this.#token, "runner"]]), req.headers.authorization);
    if (holder === undefined) {
      socket.close(1008, "unauthorized");
      return;
    }
    const connection: RunnerConnection = {
      socket,
      hello: false,
      runnerId: "",
      backends: [],
      lastSeenAt: this.#now(),
    };
    const helloTimer = setTimeout(() => {
      if (!connection.hello) socket.close(1002, "runner-v1 hello required");
    }, 5_000);
    helloTimer.unref();

    socket.on("message", (data) => {
      connection.lastSeenAt = this.#now();
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(data));
      } catch {
        socket.close(1002, "frame is not JSON");
        return;
      }
      if (!check(RunnerClientFrameSchema, decoded)) {
        socket.close(1002, "unknown runner-v1 frame");
        return;
      }
      const frame = decoded as RunnerClientFrame;
      if (!connection.hello) {
        if (frame.kind !== "hello") {
          socket.close(1002, "runner-v1 hello required");
          return;
        }
        if (frame.version !== RUNNER_V1_VERSION) {
          socket.close(1002, `this gateway speaks runner-v1 version ${RUNNER_V1_VERSION} only`);
          return;
        }
        clearTimeout(helloTimer);
        // A second runner supersedes the first rather than racing it: ADR 0002 pairs one gateway
        // with one runner, and two reconcilers against one Docker host is the failure mode the
        // whole single-writer rule exists to prevent.
        const previous = this.#connection;
        if (previous !== undefined && previous.socket !== socket)
          previous.socket.close(4000, "superseded");
        connection.hello = true;
        connection.runnerId = frame.runnerId;
        connection.backends = frame.backends;
        this.#connection = connection;
        socket.send(
          JSON.stringify({
            kind: "hello_ack",
            version: RUNNER_V1_VERSION,
            heartbeatIntervalMs: this.#heartbeatIntervalMs,
          } satisfies RunnerServerFrame),
        );
        this.#log(
          `runner ${frame.runnerId} attached (backends ${frame.backends.join(",")}, inventory ${frame.inventory?.length ?? 0})`,
        );
        this.#startHeartbeat();
        // Everything still waiting on a first receipt is handed over again. An operation already
        // receipted is not resent: resuming from the last verified stage is the runner's job.
        this.#storage.resetUnreceiptedRunnerOperationSends();
        this.dispatchPending();
        return;
      }
      if (frame.kind === "hello") {
        socket.close(1002, "duplicate runner-v1 hello");
        return;
      }
      if (frame.kind === "heartbeat") return;
      this.#receipt(frame);
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (this.#connection?.socket === socket) {
        this.#connection = undefined;
        if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
        this.#log("runner detached");
      }
    });
  }

  #receipt(receipt: RunnerReceipt): void {
    const recorded = this.#storage.recordRunnerReceipt({
      operationId: receipt.operationId,
      botId: receipt.botId,
      specGeneration: receipt.specGeneration,
      stage: receipt.stage,
      at: receipt.at,
      ...(receipt.code === undefined ? {} : { code: receipt.code }),
    });
    if (!recorded) {
      // A receipt naming an operation this gateway never issued, or one issued for another bot, is
      // dropped rather than trusted: the gateway is the lifecycle authority, and a runner cannot
      // assert state for a bot it was not asked about.
      this.#log(`ignored a receipt for unknown operation ${receipt.operationId}`);
      return;
    }
    this.#log(
      `receipt ${receipt.operationId} bot ${receipt.botId} stage ${receipt.stage}` +
        (receipt.code === undefined ? "" : ` code ${receipt.code}`),
    );
    this.#onReceipt?.(receipt);
  }

  #startHeartbeat(): void {
    if (this.#heartbeat !== undefined) return;
    this.#heartbeat = setInterval(() => {
      const connection = this.#connection;
      if (connection === undefined) return;
      const now = this.#now();
      if (now - connection.lastSeenAt > this.#heartbeatTimeoutMs) {
        this.#log("runner silent past the heartbeat ceiling; terminating the socket");
        connection.socket.terminate();
        return;
      }
      connection.socket.send(JSON.stringify({ kind: "heartbeat", sentAt: now } satisfies RunnerServerFrame));
    }, this.#heartbeatIntervalMs);
    this.#heartbeat.unref?.();
  }
}

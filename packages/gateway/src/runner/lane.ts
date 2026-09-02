import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { check } from "cozygateway-contract";
import { WebSocket, WebSocketServer } from "ws";

import { resolveAttachBearer } from "../adapters/attach/token-auth.ts";
import type { RunnerOperationRow, Storage } from "../storage.ts";
import { LEGACY_RUNNER_ID, type RunnerRoster } from "./roster.ts";
import {
  RUNNER_V1_HEARTBEAT_INTERVAL_MS,
  RUNNER_V1_HEARTBEAT_TIMEOUT_MS,
  RUNNER_V1_VERSION,
  RUNNER_CLIENT_FRAME_KINDS,
  RunnerClientFrameSchema,
  type RunnerClientFrame,
  type RunnerCreateRuntimePayload,
  type RunnerReceipt,
  type RunnerServerFrame,
  platformLabel,
} from "./protocol.ts";

export interface RunnerLaneOptions {
  /** The LEGACY shared credential, from `COZYGATEWAY_RUNNER_TOKEN`. Optional since capability 52:
   *  a gateway whose runners were paired through `POST /pair {kind: "runner"}` has no shared token
   *  at all, and its lane still authenticates every one of them. */
  token?: string;
  /** Capability 52. The paired runners, each with its own token and its own row. Absent leaves the
   *  lane exactly as it was before 52: the shared credential and nothing else. */
  roster?: RunnerRoster;
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
  /** The lane key: the paired runner's row id, or `LEGACY_RUNNER_ID` for the shared credential.
   *  Supersede is scoped to this, so two paired runners hold two sockets at once. */
  key: string;
  /** The roster row this socket authenticated as, or undefined for the legacy shared credential,
   *  which has no row to attribute anything to. */
  rowId: string | undefined;
  runnerId: string;
  backends: readonly string[];
  lastSeenAt: number;
}

/** The gateway half of the CozyRunner control stream (`/runner/v1`, capability 49, multi-tenant
 * since 52).
 *
 * One socket per paired runner, each authenticated by that runner's own token, plus the legacy
 * shared credential as one more tenant. It holds NO desired
 * state of its own: the durable truth is `runner_operations` in storage, and this lane is only the
 * transport that hands an operation to a runner and writes its receipts back. That is what lets a
 * create accepted while no runner was connected sit honestly in `waiting_for_runner` and reconcile
 * the moment one arrives, rather than failing or being invented into progress. */
export class RunnerLane {
  readonly #token: string | undefined;
  readonly #roster: RunnerRoster | undefined;
  readonly #storage: Storage;
  readonly #attachTokenFor: (botId: string) => string | undefined;
  readonly #now: () => number;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #onReceipt: RunnerLaneOptions["onReceipt"];
  readonly #log: (line: string) => void;
  readonly #wss: WebSocketServer;
  readonly #connections = new Map<string, RunnerConnection>();
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(opts: RunnerLaneOptions) {
    this.#token = opts.token;
    this.#roster = opts.roster;
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

  /** Whether ANY runner has completed its hello. A create is still accepted when this is false. */
  connected(): boolean {
    return this.#attached().length > 0;
  }

  /** Every runner holding a live, hello-completed socket, by lane key. */
  connectedRunners(): readonly string[] {
    return this.#attached().map((connection) => connection.key);
  }

  /** When a runner last said anything at all: the most recent of any of them, or of one named
   *  runner, and null while that runner is not connected. */
  lastContactAt(runnerId?: string): number | null {
    if (runnerId !== undefined) return this.#connections.get(runnerId)?.lastSeenAt ?? null;
    const times = [...this.#connections.values()].map((connection) => connection.lastSeenAt);
    return times.length === 0 ? null : Math.max(...times);
  }

  /** Hands every not-yet-sent operation to one connected runner, oldest first. Safe to call at any
   *  time: with no runner it does nothing and the operations keep waiting.
   *
   *  ONE runner, not every runner: an operation row carries no runner of its own until row 53, and
   *  fanning it out would create the same container twice. The account default is preferred so the
   *  choice is the one the person made in the app, and the earliest attached socket is the honest
   *  fallback when nothing is flagged. */
  dispatchPending(): void {
    const connection = this.#dispatchTarget();
    if (connection === undefined) return;
    for (const operation of this.#storage.unsentRunnerOperations()) {
      this.#send(connection, operation);
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    for (const connection of this.#connections.values())
      connection.socket.close(1001, "gateway shutting down");
    this.#connections.clear();
    this.#wss.close();
  }

  /** Closes a revoked runner's socket, which is the other half of `DELETE /runners/:id`: the row
   *  is gone, so the socket it authenticated must not outlive it. */
  disconnectRunner(runnerId: string): boolean {
    const connection = this.#connections.get(runnerId);
    if (connection === undefined) return false;
    this.#connections.delete(runnerId);
    connection.socket.close(1008, "runner revoked");
    return true;
  }

  #attached(): RunnerConnection[] {
    return [...this.#connections.values()].filter((connection) => connection.hello);
  }

  #dispatchTarget(): RunnerConnection | undefined {
    const attached = this.#attached();
    if (attached.length === 0) return undefined;
    const preferred = this.#roster?.defaultRunner()?.id;
    return (
      (preferred === undefined ? undefined : attached.find((connection) => connection.key === preferred))
      ?? attached[0]
    );
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
    // The paired runners first, then the legacy shared credential. Both resolve the bearer without
    // ever comparing it byte by byte against a real one: the roster hashes it and looks the hash
    // up, and the legacy path goes through the same constant-time scan every other credential on
    // this gateway goes through.
    const row = this.#roster?.resolve(req.headers.authorization);
    const legacy =
      row === undefined
      && this.#token !== undefined
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
      // Every frame is contact, so `lastSeenAt` on the row moves with the heartbeat and with every
      // receipt rather than only at attach: the roster screen is answering "is this machine here".
      if (connection.rowId !== undefined && connection.hello)
        this.#roster?.touch(connection.rowId, connection.lastSeenAt);
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(data));
      } catch {
        socket.close(1002, "frame is not JSON");
        return;
      }
      // A frame kind this gateway has never heard of is IGNORED, not fatal: a runner that grows a
      // new frame type must stay connected to an older gateway rather than be disconnected in the
      // middle of a reconciliation. A KNOWN kind that fails its schema is still a loud refusal,
      // because that is a real skew in a frame this gateway acts on.
      const kind = (decoded as { kind?: unknown }).kind;
      if (typeof kind !== "string" || !RUNNER_CLIENT_FRAME_KINDS.has(kind)) {
        this.#log(`ignored an unknown runner-v1 frame kind ${typeof kind === "string" ? kind : "(absent)"}`);
        return;
      }
      if (!check(RunnerClientFrameSchema, decoded)) {
        socket.close(1002, `malformed runner-v1 ${kind} frame`);
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
        // A runner may not claim another runner's identity: the bearer decided which row this
        // socket is, and a hello naming a different one is skew or theft, never a rename.
        if (connection.rowId !== undefined && frame.runnerId !== connection.rowId) {
          socket.close(1008, "hello runnerId does not match the paired runner");
          return;
        }
        clearTimeout(helloTimer);
        // A second hello for the SAME runner supersedes the first rather than racing it: two
        // reconcilers against one host is the failure mode the single-writer rule exists to
        // prevent. A hello for a DIFFERENT runner is a different machine and gets its own socket,
        // because two runners are two hosts (capability 52).
        const previous = this.#connections.get(connection.key);
        if (previous !== undefined && previous.socket !== socket)
          previous.socket.close(4000, "superseded");
        connection.hello = true;
        connection.runnerId = frame.runnerId;
        connection.backends = frame.backends;
        this.#connections.set(connection.key, connection);
        if (connection.rowId !== undefined) {
          this.#roster?.observe(connection.rowId, {
            backends: frame.backends,
            // The machine's own name, recorded on every hello that carries one: a person who
            // renames their computer expects the roster to follow rather than to keep showing the
            // name it had the day it was paired. A runner that reports none leaves the row's name
            // exactly as it is.
            ...(frame.name === undefined ? {} : { name: frame.name }),
            ...(frame.platform === undefined ? {} : { platform: platformLabel(frame.platform)! }),
            ...(frame.agentVersion === undefined ? {} : { version: frame.agentVersion }),
          });
          this.#roster?.touch(connection.rowId, this.#now());
        }
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
      if (this.#connections.get(connection.key)?.socket === socket) {
        this.#connections.delete(connection.key);
        this.#log(`runner ${connection.key} detached`);
      }
      if (this.#connections.size === 0) {
        if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
      }
    });
  }

  #receipt(receipt: RunnerReceipt): void {
    const outcome = this.#storage.recordRunnerReceipt({
      operationId: receipt.operationId,
      botId: receipt.botId,
      specGeneration: receipt.specGeneration,
      stage: receipt.stage,
      at: receipt.at,
      ...(receipt.code === undefined ? {} : { code: receipt.code }),
    });
    if (outcome === "unknown") {
      // A receipt naming an operation this gateway never issued, or one issued for another bot, is
      // dropped rather than trusted: the gateway is the lifecycle authority, and a runner cannot
      // assert state for a bot it was not asked about.
      this.#log(`ignored a receipt for unknown operation ${receipt.operationId}`);
      return;
    }
    if (outcome === "stale") {
      // Contact recorded, stage untouched: a retried or reordered receipt must never walk a bot
      // back from `ready` to `creating` on somebody's screen.
      this.#log(`ignored a stale ${receipt.stage} receipt for operation ${receipt.operationId}`);
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
      const now = this.#now();
      // Per socket, not per lane: one silent runner is terminated without touching the others.
      for (const connection of [...this.#connections.values()]) {
        if (now - connection.lastSeenAt > this.#heartbeatTimeoutMs) {
          this.#log(`runner ${connection.key} silent past the heartbeat ceiling; terminating the socket`);
          connection.socket.terminate();
          continue;
        }
        connection.socket.send(JSON.stringify({ kind: "heartbeat", sentAt: now } satisfies RunnerServerFrame));
      }
    }, this.#heartbeatIntervalMs);
    this.#heartbeat.unref?.();
  }
}

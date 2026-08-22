import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { check, type AttachHealthSummary } from "cozygateway-contract";
import { WebSocket, WebSocketServer } from "ws";

import type { Storage } from "../../storage.ts";
import type {
  AttachInterruptFrame,
  AttachSteerFrame,
  AttachTurnFrame,
  TurnEndpoint,
} from "./adapter.ts";
import {
  AttachV1ClientFrameSchema,
  type AttachV1Capability,
  type AttachV1ClientFrame,
  type AttachV1Command,
  type AttachV1CommandFrame,
  type AttachV1EventFrame,
  type AttachV1ServerFrame,
} from "./protocol-v1.ts";
import { resolveAttachBearer } from "./token-auth.ts";
import { emitTrace, traceId, type TraceLog } from "../../trace.ts";

export const ATTACH_V1_MAX_IN_FLIGHT_EVENTS = 64;
export const ATTACH_V1_MAX_IN_FLIGHT_BYTES = 4 * 1024 * 1024;
export const ATTACH_V1_HEARTBEAT_INTERVAL_MS = 15_000;
export const ATTACH_V1_HEARTBEAT_TIMEOUT_MS = 45_000;
export const ATTACH_V1_CAPABILITIES = ["draft", "media", "tools", "approvals", "clarify", "scheduled"] as const satisfies readonly AttachV1Capability[];

export interface AttachV1Events {
  /** True only after the event was durably projected into its owning app/transcript state. */
  onEvent(agentId: string, frame: AttachV1EventFrame): boolean;
  /** Authorization/canonical-target check performed before inbox admission. */
  canAcceptEvent?(agentId: string, frame: AttachV1EventFrame): boolean;
  onPresence(agentId: string, state: "online" | "degraded" | "absent"): void;
}

interface Connection {
  socket: WebSocket;
  hello: boolean;
  instanceId?: string;
  commandCursor: number;
  lastSeenAt: number;
  degraded: boolean;
  maxInFlightEvents: number;
  maxInFlightBytes: number;
  sendCursor: number;
  sentCommands: Map<number, { commandId: string; bytes: number }>;
  sentCommandBytes: number;
  capabilities: Set<AttachV1Capability>;
}

/** Storage-backed attach-v1 ingress. Socket loss changes availability but never deletes commands
 * or fails turns: a reconnect resumes the durable outbox and plugin event stream by cursor. */
export class AttachV1Ingress implements TurnEndpoint {
  readonly #tokens: Map<string, string>;
  readonly #storage: Storage;
  readonly #events: AttachV1Events;
  readonly #current = new Map<string, Connection>();
  readonly #negotiated = new Set<string>();
  readonly #wss: WebSocketServer;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #heartbeat: ReturnType<typeof setInterval>;
  readonly #now: () => number;
  readonly #allowedCapabilities: ReadonlyMap<string, ReadonlySet<AttachV1Capability>>;
  readonly #projectionRetryMs: number;
  readonly #projectionMaxAttempts: number;
  readonly #projectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #trace: TraceLog | undefined;
  #lastHeartbeatAt: number | null = null;

  constructor(deps: {
    tokens: Map<string, string>;
    storage: Storage;
    events: AttachV1Events;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    now?: () => number;
    allowedCapabilities?: ReadonlyMap<string, ReadonlySet<AttachV1Capability>>;
    projectionRetryMs?: number;
    projectionMaxAttempts?: number;
    trace?: TraceLog;
  }) {
    this.#tokens = deps.tokens;
    this.#storage = deps.storage;
    this.#events = deps.events;
    this.#heartbeatIntervalMs = deps.heartbeatIntervalMs ?? ATTACH_V1_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? ATTACH_V1_HEARTBEAT_TIMEOUT_MS;
    this.#now = deps.now ?? (() => Date.now());
    this.#allowedCapabilities = deps.allowedCapabilities ?? new Map();
    this.#projectionRetryMs = deps.projectionRetryMs ?? 250;
    this.#projectionMaxAttempts = deps.projectionMaxAttempts ?? 8;
    this.#trace = deps.trace;
    this.#wss = new WebSocketServer({ noServer: true });
    this.#wss.on("error", () => {});
    this.#wss.on("connection", (socket, req) => this.#onConnection(socket, req));
    this.#heartbeat = setInterval(() => this.#tick(), this.#heartbeatIntervalMs);
    this.#heartbeat.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit("connection", ws, req));
  }

  #agentFor(req: IncomingMessage): string | undefined {
    return resolveAttachBearer(this.#tokens, req.headers.authorization);
  }

  #onConnection(socket: WebSocket, req: IncomingMessage): void {
    socket.on("error", () => socket.terminate());
    const agentId = this.#agentFor(req);
    if (agentId === undefined) {
      socket.close(1008, "unauthorized");
      return;
    }
    const connection: Connection = {
      socket, hello: false, commandCursor: 0, lastSeenAt: this.#now(), degraded: false,
      maxInFlightEvents: ATTACH_V1_MAX_IN_FLIGHT_EVENTS,
      maxInFlightBytes: ATTACH_V1_MAX_IN_FLIGHT_BYTES,
      sendCursor: 0,
      sentCommands: new Map(),
      sentCommandBytes: 0,
      capabilities: new Set(),
    };
    const helloTimer = setTimeout(() => {
      if (!connection.hello) socket.close(1002, "attach-v1 hello required");
    }, 5_000);
    helloTimer.unref();

    socket.on("message", (data) => {
      const receivedAt = this.#now();
      connection.lastSeenAt = receivedAt;
      if (connection.degraded && connection.hello) {
        connection.degraded = false;
        this.#presence(agentId, "online");
      }
      let decoded: unknown;
      try { decoded = JSON.parse(String(data)); } catch { return; }
      if (!check(AttachV1ClientFrameSchema, decoded)) return;
      const frame = decoded as AttachV1ClientFrame;
      if (!connection.hello) {
        if (frame.kind !== "hello") {
          socket.close(1002, "attach-v1 hello required");
          return;
        }
        clearTimeout(helloTimer);
        const previous = this.#current.get(agentId);
        if (previous !== undefined && previous.socket !== socket) previous.socket.close(4000, "superseded");
        const resumedThrough = frame.resume?.commandSequence ?? 0;
        if (!this.#storage.reconcileAttachCommandResume(agentId, resumedThrough, this.#now())) {
          socket.close(1008, "invalid command resume cursor");
          return;
        }
        connection.hello = true;
        this.#negotiated.add(agentId);
        connection.instanceId = frame.instanceId;
        connection.commandCursor = this.#storage.attachCommandCursor(agentId);
        connection.sendCursor = connection.commandCursor;
        const offered = new Set(frame.capabilities);
        connection.capabilities = new Set(this.#allowed(agentId).filter((capability) => offered.has(capability)));
        connection.maxInFlightEvents = Math.min(frame.limits?.maxInFlightEvents ?? ATTACH_V1_MAX_IN_FLIGHT_EVENTS, ATTACH_V1_MAX_IN_FLIGHT_EVENTS);
        connection.maxInFlightBytes = Math.min(frame.limits?.maxInFlightBytes ?? ATTACH_V1_MAX_IN_FLIGHT_BYTES, ATTACH_V1_MAX_IN_FLIGHT_BYTES);
        this.#current.set(agentId, connection);
        this.#traceAttach("attach_hello", agentId, { commandCursor: connection.commandCursor, eventCursor: this.#storage.attachEventCursor(agentId) });
        this.#send(connection, {
          kind: "hello_ack", version: 1, agentId,
          capabilities: [...connection.capabilities],
          resume: { eventSequence: this.#storage.attachEventCursor(agentId), commandSequence: this.#storage.attachCommandCursor(agentId) },
          limits: { maxInFlightEvents: connection.maxInFlightEvents, maxInFlightBytes: connection.maxInFlightBytes },
          heartbeatIntervalMs: this.#heartbeatIntervalMs,
        });
        this.#presence(agentId, "online");
        this.#flush(agentId, connection.commandCursor);
        return;
      }
      if (frame.kind === "hello") return;
      if (frame.kind === "heartbeat") {
        // Gateway is the sole heartbeat initiator. The inbound frame is its one acknowledgement,
        // not a request for another response; echoing it makes two healthy peers amplify heartbeats.
        this.#lastHeartbeatAt = receivedAt;
        this.#flush(agentId, connection.commandCursor);
        return;
      }
      if (frame.kind === "ack") {
        const sent = connection.sentCommands.get(frame.sequence);
        if (frame.channel === "command" && sent?.commandId === frame.id && this.#storage.ackAttachCommand(agentId, frame.sequence, frame.id, this.#now())) {
          connection.sentCommands.delete(frame.sequence);
          connection.sentCommandBytes -= sent.bytes;
          connection.commandCursor = this.#storage.attachCommandCursor(agentId);
          this.#traceAttach("attach_command_ack", agentId, { commandCursor: connection.commandCursor });
          this.#flush(agentId, connection.commandCursor);
        }
        return;
      }
      if (frame.kind === "gap") {
        if (frame.channel === "command") {
          connection.sentCommands.clear();
          connection.sentCommandBytes = 0;
          connection.sendCursor = frame.requestedAfter;
          this.#flush(agentId, frame.requestedAfter);
        }
        return;
      }
      const missingCapability = eventCapabilities(frame).find((capability) => !connection.capabilities.has(capability));
      if (missingCapability !== undefined) {
        socket.close(1008, `attach-v1 capability not negotiated: ${missingCapability}`);
        return;
      }
      if (this.#events.canAcceptEvent?.(agentId, frame) === false) {
        socket.close(1008, "attach-v1 event target is not authorized");
        return;
      }
      const admission = this.#storage.acceptAttachEvent(agentId, frame, this.#now());
      if (admission.status === "gap") {
        this.#send(connection, {
          kind: "gap", channel: "event", requestedAfter: admission.expectedSequence - 1,
          earliestAvailable: admission.expectedSequence, latestAvailable: this.#storage.attachEventCursor(agentId),
        });
        return;
      }
      if (admission.status === "conflict") {
        socket.close(1008, "event sequence conflict");
        return;
      }
      if (admission.status === "accepted") {
        this.#projectPending(agentId);
      }
      this.#traceAttach("attach_event", agentId, { eventCursor: admission.acknowledgedSequence, outcome: admission.status });
      this.#send(connection, {
        kind: "ack", channel: "event", sequence: admission.acknowledgedSequence,
        id: frame.eventId, ...(admission.status === "duplicate" ? { duplicate: true } : {}),
      });
    });

    socket.on("close", (code) => {
      clearTimeout(helloTimer);
      if (this.#current.get(agentId) === connection) {
        this.#current.delete(agentId);
        this.#presence(agentId, "absent");
      }
      this.#traceAttach("attach_close", agentId, { code, commandCursor: connection.commandCursor });
    });
  }

  #send(connection: Connection, frame: AttachV1ServerFrame): boolean {
    if (connection.socket.readyState !== WebSocket.OPEN) return false;
    const encoded = JSON.stringify(frame);
    if (connection.socket.bufferedAmount + Buffer.byteLength(encoded) > connection.maxInFlightBytes) return false;
    connection.socket.send(encoded);
    return true;
  }

  #flush(agentId: string, afterSequence: number): void {
    const connection = this.#current.get(agentId);
    if (connection === undefined || !connection.hello) return;
    const countCapacity = connection.maxInFlightEvents - connection.sentCommands.size;
    if (countCapacity <= 0) return;
    const frames = this.#storage.pendingAttachCommands(agentId, Math.max(afterSequence, connection.sendCursor), countCapacity);
    for (const queued of frames) {
      let frame = queued;
      const missing = commandCapabilities(frame.command).find((capability) => !connection.capabilities.has(capability));
      if (missing !== undefined) {
        const cancelled = this.#storage.cancelAttachCommand(
          agentId,
          frame.sequence,
          frame.commandId,
          `capability not negotiated: ${missing}`,
          this.#now(),
        );
        if (cancelled === undefined) break;
        frame = cancelled;
        this.#presence(agentId, "degraded");
      }
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (connection.sentCommandBytes + bytes > connection.maxInFlightBytes) break;
      if (!this.#send(connection, frame)) break;
      connection.sentCommands.set(frame.sequence, { commandId: frame.commandId, bytes });
      connection.sentCommandBytes += bytes;
      connection.sendCursor = frame.sequence;
    }
  }

  #enqueue(agentId: string, command: AttachV1Command, commandId: string = randomUUID()): boolean {
    const requiredCapabilities = commandCapabilities(command);
    if (!requiredCapabilities.every((capability) => this.#allowed(agentId).includes(capability))) return false;
    const connection = this.#current.get(agentId);
    if (connection?.hello === true && !requiredCapabilities.every((capability) => connection.capabilities.has(capability))) return false;
    this.#storage.enqueueAttachCommand(agentId, commandId, command, this.#now());
    // Always start at the receiver's ACK cursor. Starting at the newly appended sequence would
    // bypass older unacked rows and defeat maxInFlightEvents under a fast producer.
    this.#flush(agentId, this.#current.get(agentId)?.commandCursor ?? 0);
    return true;
  }

  /** v1 accepts a turn while absent because the command is durably queued. */
  canQueue(agentId: string): boolean { return [...this.#tokens.values()].includes(agentId); }
  hasNegotiated(agentId: string): boolean {
    return this.#negotiated.has(agentId) || this.#storage.attachEventCursor(agentId) > 0;
  }
  isAttached(agentId: string): boolean {
    const current = this.#current.get(agentId);
    return current?.hello === true && current.socket.readyState === WebSocket.OPEN && !current.degraded;
  }
  health(): AttachHealthSummary {
    let online = 0;
    let degraded = 0;
    for (const connection of this.#current.values()) {
      if (!connection.hello || connection.socket.readyState !== WebSocket.OPEN) continue;
      if (connection.degraded) degraded += 1;
      else online += 1;
    }
    const durable = this.#storage.attachHealth();
    return {
      configured: this.#tokens.size,
      online,
      degraded,
      absent: Math.max(0, this.#tokens.size - online - degraded),
      lastHeartbeatAt: this.#lastHeartbeatAt,
      ...durable,
    };
  }
  sendTurn(agentId: string, frame: AttachTurnFrame): boolean {
    return this.#enqueue(agentId, { kind: "turn", threadId: frame.threadId, turnId: frame.turnId, messageId: `${frame.turnId}:user`, text: frame.text });
  }
  sendSteer(agentId: string, frame: AttachSteerFrame): boolean {
    return this.#enqueue(agentId, { kind: "steer", threadId: frame.threadId, turnId: frame.turnId, messageId: randomUUID(), text: frame.text });
  }
  sendInterrupt(agentId: string, frame: AttachInterruptFrame): boolean {
    return this.#enqueue(agentId, { kind: "interrupt", threadId: frame.threadId, turnId: frame.turnId });
  }
  sendApprovalResolution(agentId: string, input: { threadId: string; turnId: string; approvalId: string; decision: "approve" | "deny" }, commandId?: string): boolean {
    return this.#enqueue(agentId, { kind: "resolve_approval", ...input }, commandId);
  }

  sendNativeTurn(agentId: string, input: { threadId: string; turnId: string; messageId: string; text: string; mediaIds?: string[] }): boolean {
    return this.#enqueue(agentId, { kind: "turn", ...input });
  }

  sendNativeSteer(agentId: string, input: { threadId: string; turnId: string; messageId: string; text: string }): boolean {
    return this.#enqueue(agentId, { kind: "steer", ...input });
  }

  sendNativeInterrupt(agentId: string, input: { threadId: string; turnId: string }): boolean {
    return this.#enqueue(agentId, { kind: "interrupt", ...input });
  }

  sendClarifyResolution(agentId: string, input: { threadId: string; turnId: string; clarifyId: string; optionId: string }, commandId?: string): boolean {
    return this.#enqueue(agentId, { kind: "resolve_clarify", ...input }, commandId);
  }

  replayUnapplied(agentId: string): void {
    this.#projectPending(agentId);
  }

  /** Explicit operator/control-plane release for the first projection dead letter. It does not
   * skip the failed event: the event is retried first, preserving stream order. */
  releaseProjectionDeadLetter(agentId: string, eventId: string): boolean {
    if (!this.#storage.releaseAttachProjectionDeadLetter(agentId, eventId)) return false;
    this.#projectPending(agentId);
    return true;
  }

  negotiatedCapabilities(agentId: string): ReadonlySet<AttachV1Capability> {
    return this.#current.get(agentId)?.capabilities ?? new Set();
  }

  #allowed(agentId: string): AttachV1Capability[] {
    const configured = this.#allowedCapabilities.get(agentId);
    return configured === undefined
      ? [...ATTACH_V1_CAPABILITIES]
      : ATTACH_V1_CAPABILITIES.filter((capability) => configured.has(capability));
  }

  #projectPending(agentId: string): void {
    // New later events must not accelerate an earlier event through its retry budget. The one
    // active timer is the ordering barrier for this identity until it fires or the event applies.
    if (this.#projectionTimers.has(agentId)) return;
    for (const frame of this.#storage.unappliedAttachEvents(agentId)) {
      let projected = false;
      let error = "projection declined event";
      try {
        projected = this.#events.onEvent(agentId, frame);
      } catch (err) {
        error = err instanceof Error ? err.message : "projection threw";
      }
      if (projected) {
        this.#storage.markAttachEventApplied(agentId, frame.eventId, this.#now());
        this.#traceAttach("attach_projection", agentId, { outcome: "applied" });
        continue;
      }
      const failure = this.#storage.recordAttachProjectionFailure(agentId, frame.eventId, error, this.#now(), this.#projectionMaxAttempts);
      if (failure.deadLettered) {
        this.#presence(agentId, "degraded");
        this.#traceAttach("attach_projection", agentId, { outcome: "dead_letter" });
        return;
      }
      const delay = Math.min(this.#projectionRetryMs * 2 ** Math.max(0, failure.attempts - 1), 30_000);
      const timer = setTimeout(() => {
        this.#projectionTimers.delete(agentId);
        this.#projectPending(agentId);
      }, delay);
      timer.unref();
      this.#projectionTimers.set(agentId, timer);
      break;
    }
  }

  #tick(): void {
    const now = this.#now();
    for (const [agentId, connection] of this.#current) {
      const age = now - connection.lastSeenAt;
      if (age >= this.#heartbeatTimeoutMs) {
        connection.socket.terminate();
      } else if (age >= this.#heartbeatIntervalMs * 2 && !connection.degraded) {
        connection.degraded = true;
        this.#presence(agentId, "degraded");
      } else {
        this.#send(connection, { kind: "heartbeat", sentAt: now });
      }
    }
  }

  #presence(agentId: string, state: "online" | "degraded" | "absent"): void {
    this.#events.onPresence(agentId, state);
    this.#traceAttach("attach_presence", agentId, { state });
  }

  #traceAttach(event: string, agentId: string, fields: Record<string, number | string> = {}): void {
    if (this.#trace === undefined) return;
    try {
      const queue = this.#storage.attachQueueHealth(agentId, this.#now());
      emitTrace(this.#trace, event, { profile: traceId(agentId), queueDepth: queue.depth, oldestQueueAgeMs: queue.oldestAgeMs, ...fields });
    } catch {
      emitTrace(this.#trace, event, { profile: traceId(agentId), ...fields });
    }
  }

  close(): void {
    clearInterval(this.#heartbeat);
    for (const timer of this.#projectionTimers.values()) clearTimeout(timer);
    this.#projectionTimers.clear();
    for (const connection of this.#current.values()) connection.socket.close(1001, "server shutdown");
    this.#current.clear();
    this.#wss.close();
  }
}

function eventCapabilities(frame: AttachV1EventFrame): AttachV1Capability[] {
  switch (frame.event.kind) {
    case "media": return ["media"];
    case "tool": return ["tools"];
    case "approval": return ["approvals"];
    case "clarify": return ["clarify"];
    case "scheduled": return ["scheduled", ...(frame.event.mediaIds?.length ? ["media" as const] : [])];
    case "presence": return [];
    case "commit": return ["draft", ...(frame.event.mediaIds?.length ? ["media" as const] : [])];
    default: return ["draft"];
  }
}

function commandCapabilities(command: AttachV1Command): AttachV1Capability[] {
  if (command.kind === "discard") return [];
  if (command.kind === "resolve_approval") return ["approvals"];
  if (command.kind === "resolve_clarify") return ["clarify"];
  if (command.kind === "turn" && (command.mediaIds?.length ?? 0) > 0) return ["draft", "media"];
  return ["draft"];
}

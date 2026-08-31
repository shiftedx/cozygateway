import { randomUUID } from "node:crypto";
import type { TSchema } from "@sinclair/typebox";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { check, ContractViolation, assertValid, type AttachHealthSummary } from "cozygateway-contract";
import { WebSocket, WebSocketServer } from "ws";

import type { NativeInteractionResolutionRequest, Storage } from "../../storage.ts";
import type {
  AttachInterruptFrame,
  AttachSteerFrame,
  AttachTurnFrame,
  TurnEndpoint,
} from "./adapter.ts";
import {
  AttachV1AckSchema,
  AttachV1ClientFrameSchema,
  AttachV1EventFrameSchema,
  AttachV1GapSchema,
  AttachV1HeartbeatSchema,
  AttachV1HelloSchema,
  AttachV1MemoryResultSchema,
  AttachV1MobileCancelSchema,
  AttachV1MobileRequestSchema,
  AttachV1MobileResultSchema,
  type AttachV1Capability,
  type AttachV1ClientFrame,
  type AttachV1Command,
  type AttachV1CommandFrame,
  type AttachV1DiscardReason,
  type AttachV1EventFrame,
  type AttachV1MobileCancel,
  type AttachV1MobileRequest,
  type AttachV1MobileResultInput,
  type AttachV1MemoryRequest,
  type AttachV1MemoryResult,
  type AttachV1ServerFrame,
  type AttachV1SlashCommand,
  type AttachV1Telemetry,
} from "./protocol-v1.ts";
import { resolveAttachBearer } from "./token-auth.ts";
import { emitTrace, traceId, type TraceLog } from "../../trace.ts";

export const ATTACH_V1_MAX_IN_FLIGHT_EVENTS = 64;
export const ATTACH_V1_MAX_IN_FLIGHT_BYTES = 4 * 1024 * 1024;
export const ATTACH_V1_HEARTBEAT_INTERVAL_MS = 15_000;
export const ATTACH_V1_HEARTBEAT_TIMEOUT_MS = 45_000;
/** Every capability the gateway will negotiate. `satisfies` proves each entry is a real
 *  capability; it does NOT prove the list is complete, so adding one to the schema and forgetting
 *  it here type-checks cleanly and silently refuses the surface at negotiation. A test compares
 *  this list against the schema for exactly that reason. */
export const ATTACH_V1_CAPABILITIES = ["draft", "media", "tools", "approvals", "clarify", "scheduled", "mobile_node", "mobile_location", "mobile_media", "mobile_notifications", "memory_management", "delivery_receipts", "delegation", "thinking", "desktop_session_resume", "desktop_session_sync"] as const satisfies readonly AttachV1Capability[];

/** Why a memory request did or did not reach the attached plugin. */
export type MemorySendOutcome = "sent" | "unknown_bot" | "not_attached" | "capability_not_negotiated";

export interface AttachV1Events {
  /** True only after the event was durably projected into its owning app/transcript state. */
  onEvent(agentId: string, frame: AttachV1EventFrame): boolean;
  /** Authorization/canonical-target check performed before inbox admission. */
  canAcceptEvent?(agentId: string, frame: AttachV1EventFrame): boolean;
  onPresence(agentId: string, state: "online" | "degraded" | "absent"): void;
  onMobileRequest?(agentId: string, frame: AttachV1MobileRequest): void;
  onMobileCancel?(agentId: string, frame: AttachV1MobileCancel): void;
  onMemoryResult?(agentId: string, frame: AttachV1MemoryResult): void;
  /** A scheduled delivery that will never reach a transcript. The ingress emits the plugin-facing
   * receipt itself; this is the app-facing half, raised so the layer that owns a bot's canonical
   * chat can say so to the user instead of leaving a cron report silently missing. */
  onScheduledDeliveryFailed?(
    agentId: string,
    failure: {
      deliveryId: string;
      messageId: string;
      stage: "authorization" | "projection";
      reason: string;
      at: number;
    },
  ): void;
}

interface Connection {
  socket: WebSocket;
  hello: boolean;
  instanceId?: string;
  commandCursor: number;
  lastSeenAt: number;
  heartbeatDegraded: boolean;
  degraded: boolean;
  telemetry?: { eventOutboxDepth: number; lastAckProgressAt: number };
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
  /** Last authenticated catalog per profile. It deliberately survives a socket drop: command
   * discovery remains useful while the phone is offline, just as Telegram keeps its bot menu. */
  readonly #commandCatalogs = new Map<string, readonly AttachV1SlashCommand[]>();
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
  readonly #log: (line: string) => void;
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
    /** Operator-visible channel for refusals. Tracing is optional and often off; a peer that is
     *  being refused must still say so somewhere an operator reads by default. */
    log?: (line: string) => void;
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
    this.#log = deps.log ?? ((line) => console.warn(line));
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
      heartbeatDegraded: false,
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
      connection.heartbeatDegraded = false;
      let decoded: unknown;
      try { decoded = JSON.parse(String(data)); } catch {
        this.#refuse(agentId, socket, "unparseable", "frame is not JSON");
        return;
      }
      // There is one hello shape. A peer built against an older one used to negotiate a reduced
      // capability set and look healthy for hours; name the version it sent and close instead.
      const helloVersion = helloVersionOf(decoded);
      if (helloVersion !== undefined) {
        this.#refuse(agentId, socket, "hello", `unsupported hello version ${helloVersion}, this gateway speaks hello version 2 only`);
        return;
      }
      if (!check(AttachV1ClientFrameSchema, decoded)) {
        // A dropped frame used to be invisible on both ends: the peer waits forever for a reply
        // that will never come, and no log says why. Name the offending field and close, so a
        // contract skew is a loud, bounded refusal instead of a hang.
        this.#refuse(agentId, socket, frameKind(decoded), schemaReason(decoded));
        return;
      }
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
        if ("telemetry" in frame && frame.telemetry !== undefined)
          connection.telemetry = this.#recordTelemetry(agentId, frame.telemetry, receivedAt);
        if (frame.commands !== undefined) {
          this.#commandCatalogs.set(agentId, [...frame.commands]);
        }
        connection.maxInFlightEvents = Math.min(frame.limits?.maxInFlightEvents ?? ATTACH_V1_MAX_IN_FLIGHT_EVENTS, ATTACH_V1_MAX_IN_FLIGHT_EVENTS);
        connection.maxInFlightBytes = Math.min(frame.limits?.maxInFlightBytes ?? ATTACH_V1_MAX_IN_FLIGHT_BYTES, ATTACH_V1_MAX_IN_FLIGHT_BYTES);
        this.#current.set(agentId, connection);
        this.#traceAttach("attach_hello", agentId, {
          commandCursor: connection.commandCursor,
          eventCursor: this.#storage.attachEventCursor(agentId),
          helloVersion: frame.version,
          capabilities: [...connection.capabilities].join(","),
        });
        // What a peer negotiated decides which surfaces work for the rest of the connection's
        // life, and nothing else on the gateway reports it. A plugin that quietly handshakes as
        // an older version leaves this one line as the evidence.
        this.#log(`attach-v1: profile "${agentId}" negotiated hello v${frame.version} with capabilities [${[...connection.capabilities].join(", ")}]`);
        this.#send(connection, {
          kind: "hello_ack", version: 2, agentId,
          capabilities: [...connection.capabilities],
          resume: { eventSequence: this.#storage.attachEventCursor(agentId), commandSequence: this.#storage.attachCommandCursor(agentId) },
          limits: { maxInFlightEvents: connection.maxInFlightEvents, maxInFlightBytes: connection.maxInFlightBytes },
          heartbeatIntervalMs: this.#heartbeatIntervalMs,
        });
        this.#presence(agentId, "online");
        this.#refreshDegraded(agentId, connection);
        this.#flush(agentId, connection.commandCursor);
        return;
      }
      if (frame.kind === "hello") return;
      if (frame.kind === "heartbeat") {
        // Gateway is the sole heartbeat initiator. The inbound frame is its one acknowledgement,
        // not a request for another response; echoing it makes two healthy peers amplify heartbeats.
        this.#lastHeartbeatAt = receivedAt;
        if (frame.telemetry !== undefined)
          connection.telemetry = this.#recordTelemetry(agentId, frame.telemetry, receivedAt);
        this.#refreshDegraded(agentId, connection);
        return;
      }
      if (frame.kind === "mobile_request") {
        const required = frame.command === "location.current" ? "mobile_location"
          : frame.command === "camera.capture" || frame.command === "file.pick" ? "mobile_media"
          : frame.command === "notification.present" ? "mobile_notifications" : "mobile_node";
        if (!connection.capabilities.has(required)) {
          socket.close(1008, `attach-v1 capability not negotiated: ${required}`);
          return;
        }
        this.#events.onMobileRequest?.(agentId, frame);
        return;
      }
      if (frame.kind === "mobile_cancel") {
        if (!connection.capabilities.has("mobile_node")) {
          socket.close(1008, "attach-v1 capability not negotiated: mobile_node");
          return;
        }
        this.#events.onMobileCancel?.(agentId, frame);
        return;
      }
      if (frame.kind === "memory_result") {
        if (!connection.capabilities.has("memory_management")) {
          socket.close(1008, "attach-v1 capability not negotiated: memory_management");
          return;
        }
        this.#events.onMemoryResult?.(agentId, frame);
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
      const discardReason: AttachV1DiscardReason | undefined = missingCapability !== undefined
        ? "capability_not_negotiated"
        : this.#events.canAcceptEvent?.(agentId, frame) === false
          ? "unauthorized_target"
          : undefined;
      const admission = this.#storage.acceptAttachEvent(agentId, frame, this.#now(), discardReason);
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
      if (admission.status === "discarded" && frame.event.kind === "scheduled") {
        this.#deliveryFailed(agentId, {
          deliveryId: frame.event.deliveryId,
          messageId: frame.event.messageId,
          stage: "authorization",
          reason: admission.reason,
        });
      }
      this.#traceAttach("attach_event", agentId, { eventCursor: admission.acknowledgedSequence, outcome: admission.status });
      this.#send(connection, {
        kind: "ack", channel: "event", sequence: admission.acknowledgedSequence,
        id: frame.eventId, ...(admission.status === "duplicate" ? { duplicate: true } : {}),
        ...(admission.status === "discarded" ? { discarded: true as const, reason: admission.reason } : {}),
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
        const cancelled = this.#storage.discardAttachCommandAndReopenNativeInteraction(
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
    const now = this.#now();
    for (const connection of this.#current.values()) {
      if (!connection.hello || connection.socket.readyState !== WebSocket.OPEN) continue;
      if (connection.degraded || this.#pluginBacklogStalled(connection, now)) degraded += 1;
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

  /** Atomically marks the native interaction requested and appends its stable command. The ACK
   * only means the plugin journal accepted it; callers await the later terminal attach event. */
  requestNativeApprovalResolution(
    agentId: string,
    input: { threadId: string; turnId: string; approvalId: string; decision: "approve" | "deny" },
  ): NativeInteractionResolutionRequest | { outcome: "unsupported" } {
    const requestedAt = this.#now();
    const expired = this.#storage.expireNativeInteractionIfDue(agentId, "approval", input.approvalId, requestedAt);
    if (expired !== undefined) return { outcome: "expired", ...expired };
    if (!this.#canResolve(agentId, "approvals")) return { outcome: "unsupported" };
    const result = this.#storage.requestNativeInteractionResolution({
      bot: agentId,
      kind: "approval",
      interactionId: input.approvalId,
      decision: input.decision,
      commandId: `approval:${agentId}:${input.approvalId}`,
      command: { kind: "resolve_approval", ...input },
      requestedAt,
    });
    if (result.outcome === "requested" || result.outcome === "already_requested")
      this.#flush(agentId, this.#current.get(agentId)?.commandCursor ?? 0);
    return result;
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

  /** Enqueue an explicit desktop adoption. The idempotency key is the gateway-owned resume id;
   * command ACK is transport-only, while the later `desktop_session_resumed` event is the sole
   * proof that the plugin switched the exact profile-local Hermes context. */
  sendNativeDesktopResume(agentId: string, input: {
    threadId: string; hermesSessionId: string; resumeId: string;
  }): boolean {
    return this.#enqueue(
      agentId,
      { kind: "desktop_session_resume", ...input },
      `desktop-resume:${agentId}:${input.resumeId}`,
    );
  }

  sendClarifyResolution(agentId: string, input: { threadId: string; turnId: string; clarifyId: string; optionId: string }, commandId?: string): boolean {
    return this.#enqueue(agentId, { kind: "resolve_clarify", ...input }, commandId);
  }

  /** Raw memory is a live request/reply lane and is never written to Gateway storage.
   *
   *  The three ways this lane can be closed are operationally different -- an unconfigured bot, a
   *  disconnected plugin, and a plugin that connected but never offered `memory_management` all
   *  need different fixes -- so the caller gets the reason rather than a bare `false`. Collapsing
   *  them into one 503 is what made a stale plugin indistinguishable from an offline one. */
  sendMemoryRequest(agentId: string, input: AttachV1MemoryRequest): MemorySendOutcome {
    if (![...this.#tokens.values()].includes(agentId)) return "unknown_bot";
    const connection = this.#current.get(agentId);
    if (connection?.hello !== true) return "not_attached";
    if (!connection.capabilities.has("memory_management")) return "capability_not_negotiated";
    return this.#send(connection, input) ? "sent" : "not_attached";
  }

  requestNativeClarifyResolution(
    agentId: string,
    input: { threadId: string; turnId: string; clarifyId: string; optionId: string },
  ): NativeInteractionResolutionRequest | { outcome: "unsupported" } {
    const requestedAt = this.#now();
    const expired = this.#storage.expireNativeInteractionIfDue(agentId, "clarify", input.clarifyId, requestedAt);
    if (expired !== undefined) return { outcome: "expired", ...expired };
    if (!this.#canResolve(agentId, "clarify")) return { outcome: "unsupported" };
    const result = this.#storage.requestNativeInteractionResolution({
      bot: agentId,
      kind: "clarify",
      interactionId: input.clarifyId,
      decision: "select",
      optionId: input.optionId,
      commandId: `clarify:${agentId}:${input.clarifyId}`,
      command: { kind: "resolve_clarify", ...input },
      requestedAt,
    });
    if (result.outcome === "requested" || result.outcome === "already_requested")
      this.#flush(agentId, this.#current.get(agentId)?.commandCursor ?? 0);
    return result;
  }

  sendMobileResult(agentId: string, frame: AttachV1MobileResultInput): boolean {
    const connection = this.#current.get(agentId);
    const detailed = { kind: "mobile_result" as const, ...frame };
    if (!check(AttachV1MobileResultSchema, detailed)) return false;
    const outbound = detailed as AttachV1ServerFrame;
    const required = "result" in frame && isLocationResult(frame.result) ? "mobile_location"
      : "result" in frame && isMediaResult(frame.result) ? "mobile_media"
      : "result" in frame && isNotificationResult(frame.result) ? "mobile_notifications" : "mobile_node";
    if (connection === undefined || !connection.hello || !connection.capabilities.has(required)) return false;
    return this.#send(connection, outbound);
  }

  /** Durably queues one delivery receipt. `false` means the receipt was not queued at all, which
   * is deliberate and never fatal: a receipt is gateway-to-plugin bookkeeping, so a plugin that
   * never negotiated `delivery_receipts` simply does not hear about it rather than having its
   * outbox filled with commands it would only discard. A receipt queued while the plugin is away
   * follows the ordinary durable path and, if that plugin comes back without the capability, the
   * existing tombstone converts it to a `discard`. */
  sendDeliveryReceipt(
    agentId: string,
    input: {
      deliveryId: string;
      messageId: string;
      state: "displayed" | "failed";
      at?: number;
      stage?: "authorization" | "projection";
      reason?: string;
    },
  ): boolean {
    const { at, stage, reason, ...rest } = input;
    return this.#enqueue(
      agentId,
      {
        kind: "delivery_receipt", ...rest, at: at ?? this.#now(),
        ...(stage === undefined ? {} : { stage }),
        ...(reason === undefined ? {} : { reason: reason.slice(0, 256) }),
      },
      `rcpt:${input.deliveryId}:${input.state}`,
    );
  }

  #deliveryFailed(
    agentId: string,
    failure: { deliveryId: string; messageId: string; stage: "authorization" | "projection"; reason: string },
  ): void {
    const at = this.#now();
    const reason = failure.reason.slice(0, 256);
    this.sendDeliveryReceipt(agentId, { ...failure, reason, state: "failed", at });
    this.#events.onScheduledDeliveryFailed?.(agentId, { ...failure, reason, at });
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

  commandCatalog(agentId: string): readonly AttachV1SlashCommand[] {
    return this.#commandCatalogs.get(agentId) ?? [];
  }

  #canResolve(agentId: string, capability: "approvals" | "clarify"): boolean {
    if (!this.#allowed(agentId).includes(capability)) return false;
    const connection = this.#current.get(agentId);
    return connection?.hello !== true || connection.capabilities.has(capability);
  }

  #recordTelemetry(
    agentId: string,
    telemetry: AttachV1Telemetry,
    receivedAt: number,
  ): { eventOutboxDepth: number; lastAckProgressAt: number } {
    return this.#storage.recordAttachTelemetry(agentId, telemetry, receivedAt);
  }

  #pluginBacklogStalled(connection: Connection, now: number): boolean {
    return connection.telemetry !== undefined
      && connection.telemetry.eventOutboxDepth > 0
      && now - connection.telemetry.lastAckProgressAt >= 30_000;
  }

  #refreshDegraded(agentId: string, connection: Connection): void {
    const degraded = connection.heartbeatDegraded || this.#pluginBacklogStalled(connection, this.#now());
    if (connection.degraded === degraded) return;
    connection.degraded = degraded;
    this.#presence(agentId, degraded ? "degraded" : "online");
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
      // A draft or tool frame is ephemeral rendering state: superseded in seconds and worthless
      // once its turn ends. It gets the same bounded retries, but exhaustion SKIPS it (stamped
      // applied, said out loud) instead of dead-lettering: in production two declined drafts
      // dead-lettered and head-of-line blocked their bots for hours (issue #193), a price no
      // draft is worth. Durable facts (commits, terminals, scheduled deliveries, interactions)
      // keep the dead letter, because silently skipping one of those would lose user data.
      const ephemeral = frame.event.kind === "draft" || frame.event.kind === "tool" || frame.event.kind === "delegation" || frame.event.kind === "thinking";
      const failure = this.#storage.recordAttachProjectionFailure(agentId, frame.eventId, error, this.#now(), ephemeral ? Number.MAX_SAFE_INTEGER : this.#projectionMaxAttempts);
      // A projection failure used to be invisible until the post-mortem DB read. Say it on the
      // operator channel at the first attempt and at the dead letter (issue #193): the dead
      // letter blocks every later event for this identity, which is exactly the kind of fact an
      // operator must not learn from a silent phone.
      if (failure.attempts === 1)
        this.#log(`attach-v1: projecting ${frame.event.kind} event ${frame.sequence} for profile "${agentId}" failed (${error}); retrying`);
      if (ephemeral && failure.attempts >= this.#projectionMaxAttempts) {
        this.#storage.markAttachEventApplied(agentId, frame.eventId, this.#now());
        this.#log(`attach-v1: skipped undeliverable ${frame.event.kind} event ${frame.sequence} for profile "${agentId}" after ${failure.attempts} attempts (${error}); ephemeral events never dead-letter the stream`);
        continue;
      }
      if (failure.deadLettered) {
        this.#log(`attach-v1: event ${frame.sequence} for profile "${agentId}" dead-lettered after ${failure.attempts} projection attempts (${error}); later events for this profile are blocked until it is released`);
        if (frame.event.kind === "scheduled") {
          this.#deliveryFailed(agentId, {
            deliveryId: frame.event.deliveryId,
            messageId: frame.event.messageId,
            stage: "projection",
            reason: error,
          });
        }
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
      } else {
        connection.heartbeatDegraded = age >= this.#heartbeatIntervalMs * 2;
        this.#refreshDegraded(agentId, connection);
        this.#send(connection, { kind: "heartbeat", sentAt: now });
      }
    }
  }

  #presence(agentId: string, state: "online" | "degraded" | "absent"): void {
    this.#events.onPresence(agentId, state);
    this.#traceAttach("attach_presence", agentId, { state });
  }

  /** Refuses one frame out loud. The reason is derived from the schema, never from payload
   *  content, so nothing a peer sent can be echoed into a log line. */
  #refuse(agentId: string, socket: WebSocket, kind: string, reason: string): void {
    const bounded = reason.slice(0, 160);
    this.#log(`attach-v1: refused ${kind} frame from profile "${agentId}": ${bounded}`);
    this.#traceAttach("attach_frame_refused", agentId, { frameKind: kind, reason: bounded });
    socket.close(1008, `attach-v1 invalid ${kind} frame`.slice(0, 120));
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

  /** Ends a deleted bot's live attach lane. The caller removes the token map entry
   *  (`revokeAttachTokens`); this drops the open socket and the per-profile runtime state so a
   *  connection authenticated before the revocation cannot keep flowing. Durable journal rows are
   *  the storage purge's business, not this method's. */
  disconnectAgent(agentId: string): void {
    const connection = this.#current.get(agentId);
    if (connection !== undefined) {
      connection.socket.close(1008, "identity revoked");
      this.#current.delete(agentId);
    }
    this.#commandCatalogs.delete(agentId);
    this.#negotiated.delete(agentId);
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

/** The peer's claimed frame kind, constrained to the known set. An unknown or absent kind is
 *  reported as "unknown" rather than echoed, so the log line stays bounded and content-free. */
const KNOWN_FRAME_KINDS = new Set(["hello", "event", "ack", "gap", "heartbeat", "mobile_request", "mobile_cancel", "memory_result"]);
function frameKind(decoded: unknown): string {
  const kind = typeof decoded === "object" && decoded !== null ? (decoded as { kind?: unknown }).kind : undefined;
  return typeof kind === "string" && KNOWN_FRAME_KINDS.has(kind) ? kind : "unknown";
}

/** The one member schema a frame CLAIMED to be, so the violation names a field instead of the
 *  whole union. Validating a bad frame against the union only ever answers "expected union value"
 *  at the root, which is exactly as useless as the silent drop it replaced. */
const KIND_SCHEMAS: Record<string, TSchema> = {
  hello: AttachV1HelloSchema,
  event: AttachV1EventFrameSchema,
  ack: AttachV1AckSchema,
  gap: AttachV1GapSchema,
  heartbeat: AttachV1HeartbeatSchema,
  mobile_request: AttachV1MobileRequestSchema,
  mobile_cancel: AttachV1MobileCancelSchema,
  memory_result: AttachV1MemoryResultSchema,
};

/** The first schema violation, as "<message> at <json pointer>". TypeBox's message text and the
 *  pointer are both schema-derived, so no payload value reaches the log. */
function schemaReason(decoded: unknown): string {
  const schema = KIND_SCHEMAS[frameKind(decoded)] ?? AttachV1ClientFrameSchema;
  try {
    assertValid(schema, decoded);
  } catch (err) {
    if (err instanceof ContractViolation) return err.message;
  }
  return "failed schema validation";
}

/** The version a hello frame claimed, when it is anything other than the one supported version.
 *  `undefined` means "not a mis-versioned hello", so an ordinary frame takes the normal path. The
 *  value is rendered bounded and only when it is a finite number, so no payload prose reaches a log. */
function helloVersionOf(decoded: unknown): string | undefined {
  if (typeof decoded !== "object" || decoded === null) return undefined;
  const record = decoded as { kind?: unknown; version?: unknown };
  if (record.kind !== "hello" || record.version === 2) return undefined;
  return typeof record.version === "number" && Number.isFinite(record.version)
    ? String(record.version).slice(0, 16)
    : "unknown";
}

function isLocationResult(value: unknown): value is { latitude: number; longitude: number } {
  return typeof value === "object" && value !== null && "latitude" in value && "longitude" in value;
}
function isMediaResult(value: unknown): value is { mediaId: string } {
  return typeof value === "object" && value !== null && "mediaId" in value;
}
function isNotificationResult(value: unknown): value is { action: string } {
  return typeof value === "object" && value !== null && "action" in value;
}

function eventCapabilities(frame: AttachV1EventFrame): AttachV1Capability[] {
  switch (frame.event.kind) {
    case "media": return ["media"];
    case "tool": return ["tools"];
    case "delegation": return ["delegation"];
    case "thinking": return ["thinking"];
    case "approval": return ["approvals"];
    case "clarify": return ["clarify"];
    case "scheduled": return ["scheduled", ...(frame.event.mediaIds?.length ? ["media" as const] : [])];
    case "presence": return [];
    case "desktop_session_message": return ["desktop_session_sync"];
    case "desktop_session_resumed": return ["desktop_session_resume"];
    case "commit": return ["draft", ...(frame.event.mediaIds?.length ? ["media" as const] : [])];
    default: return ["draft"];
  }
}

function commandCapabilities(command: AttachV1Command): AttachV1Capability[] {
  if (command.kind === "discard") return [];
  if (command.kind === "delivery_receipt") return ["delivery_receipts"];
  if (command.kind === "resolve_approval") return ["approvals"];
  if (command.kind === "resolve_clarify") return ["clarify"];
  if (command.kind === "desktop_session_resume") return ["desktop_session_resume"];
  if (command.kind === "turn" && (command.mediaIds?.length ?? 0) > 0) return ["draft", "media"];
  return ["draft"];
}

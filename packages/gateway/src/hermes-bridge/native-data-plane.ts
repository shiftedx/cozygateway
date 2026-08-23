import { createHash, randomUUID } from "node:crypto";

import type {
  AttachmentBlock,
  BotApprovalPendingFrame,
  BotApprovalResolutionRequestedFrame,
  BotApprovalResolvedFrame,
  BotChatDeltaFrame,
  BotChatMessage,
  BotChatStateCause,
  BotChatStateFrame,
  BotChatStatus,
  BotClarifyPendingFrame,
  BotClarifyResolutionRequestedFrame,
  BotClarifyResolvedFrame,
  BotToolActivityFrame,
  BotToolStep,
  BotTurnToolSteps,
  BotSummary,
  BotPendingApproval,
  RichBlock,
  ServerFrame,
} from "cozygateway-contract";

import type { AttachV1Ingress } from "../adapters/attach/ingress-v1.ts";
import { blocksToText } from "../adapters/attach/blocks-to-text.ts";
import { emitTrace, traceId, type TraceLog } from "../trace.ts";
import type { AttachV1EventFrame, AttachV1MobileRequest } from "../adapters/attach/protocol-v1.ts";
import type { MobileNodeBroker } from "../mobile-node.ts";
import { BackendUnavailable } from "../errors.ts";
import type { Storage } from "../storage.ts";
import type {
  BotApprovalDecision,
  BotClarifyResolveOutcome,
  BotApprovalResolveOutcome,
} from "./approvals.ts";
import {
  BotSessionConflict,
  BotSessionNotFound,
  type BotControlSurface,
  type BotChatFileUpload,
  type BotChatPhotoUpload,
  type BotsSurface,
} from "./bridge.ts";

export interface NativeBotDataPlaneOptions {
  control: BotControlSurface;
  storage: Storage;
  ingress: AttachV1Ingress;
  nativeBots: Iterable<string>;
  /** Optional opener offered only while a Bot Chat transcript is empty. */
  chatSuggestion: string;
  broadcast: (frame: ServerFrame) => void;
  onChatMessage?: (event: {
    bot: string;
    displayName: string;
    messageId: string;
    chatSessionId: string;
    preview: string;
  }) => void;
  onApproval?: (event: {
    bot: string;
    sessionId: string;
    turnId: string;
    toolCallId: string;
    name?: string;
    outcome?: "approved" | "denied" | "expired";
  }) => void;
  now?: () => number;
  /** Existing gateway wall-clock bound; durable attach queueing lasts until this deadline. */
  turnTimeoutMs?: number;
  log?: (message: string) => void;
  trace?: TraceLog;
  mobileNode?: MobileNodeBroker;
}

interface ApprovalPayload {
  name: string;
}
interface ClarifyPayload {
  prompt: string;
  options: Array<{ id: string; label: string }>;
}

interface ToolFrameState {
  seq: number;
  steps: Map<string, BotToolStep>;
}

interface NativeTurnState {
  status: BotChatStatus;
  cause?: BotChatStateCause;
  queuedAt?: number;
}

/** Attach-owned Bot Mode data plane. The returned surface delegates management/control methods to
 * the dashboard bridge but owns every chat method for configured profiles, making it impossible
 * for a native send or settlement to fall through to the Dashboard chat transport. */
export class NativeBotDataPlane {
  readonly #control: BotControlSurface;
  readonly #storage: Storage;
  readonly #ingress: AttachV1Ingress;
  readonly #native: Set<string>;
  readonly #chatSuggestion: string;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #onChatMessage: NativeBotDataPlaneOptions["onChatMessage"];
  readonly #onApproval: NativeBotDataPlaneOptions["onApproval"];
  readonly #now: () => number;
  readonly #turnTimeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #trace: TraceLog | undefined;
  readonly #mobileNode: MobileNodeBroker | undefined;
  readonly #turnOrigins = new Map<string, string>();
  readonly #draftSeq = new Map<string, number>();
  readonly #toolFrames = new Map<string, ToolFrameState>();
  readonly #tracedTurnStates = new Map<string, string>();
  readonly #attachPresence = new Map<string, "online" | "degraded" | "absent">();
  readonly #interactionTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  readonly #turnTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: NativeBotDataPlaneOptions) {
    this.#control = opts.control;
    this.#storage = opts.storage;
    this.#ingress = opts.ingress;
    this.#native = new Set([...opts.nativeBots].map(normalize));
    this.#chatSuggestion = opts.chatSuggestion;
    this.#broadcast = opts.broadcast;
    this.#onChatMessage = opts.onChatMessage;
    this.#onApproval = opts.onApproval;
    this.#now = opts.now ?? Date.now;
    this.#turnTimeoutMs = opts.turnTimeoutMs ?? 600_000;
    this.#log =
      opts.log ??
      ((message) => void process.stderr.write(`[native-bot] ${message}\n`));
    this.#trace = opts.trace;
    this.#mobileNode = opts.mobileNode;
    // Scheduled/home delivery is authorized against this durable gateway-owned binding, never a
    // target asserted by an event itself. Creating it at assembly makes the target canonical even
    // before the app has opened this bot's chat.
    for (const bot of this.#native) {
      const chat = this.#storage.nativeBotChat(bot, this.#now());
      this.#restoreToolFrames(bot);
      if (chat.activeTurnId !== undefined)
        this.#scheduleTurnTimeout(bot, chat.sessionId, chat.activeTurnId);
    }
    for (const pending of this.#storage.pendingNativeInteractions()) {
      if (this.#native.has(pending.bot))
        this.#scheduleInteractionExpiry(pending);
    }
  }

  surface(): BotsSurface {
    const overrides: Partial<BotsSurface> = {
      roster: () => this.#roster(),
      commands: (name) => this.#commands(name),
      pendingApprovals: () => this.#pendingApprovals(),
      attachmentHistory: (input) => this.#attachmentHistory(input),
      canonicalChat: (name) => this.#canonical(name),
      newSession: (name) => this.#newSession(name),
      sessions: (name, limit) => this.#sessions(name, limit),
      adoptSession: (name, sessionId, limit) =>
        this.#adoptSession(name, sessionId, limit),
      chatHistory: (name) => this.#history(name),
      sendChatMessage: (name, text, opts) => this.#send(name, text, opts),
      sendChatPhoto: (name, photo, opts) => this.#sendPhoto(name, photo, opts),
      sendChatAttachment: (name, file, opts) => this.#sendFile(name, file, opts),
      stopChat: (name) => this.#stop(name),
      resetChat: (name) => this.#reset(name),
      resolveApproval: (name, toolCallId, decision, deviceId) =>
        this.#resolveApproval(name, toolCallId, decision, deviceId),
      resolveClarify: (name, clarifyId, optionId, deviceId) =>
        this.#resolveClarify(name, clarifyId, optionId, deviceId),
      chatAttachmentInfo: (name, fileId) => this.#attachmentInfo(name, fileId),
      chatAttachmentSlice: (name, fileId, offset, length) =>
        this.#attachmentSlice(name, fileId, offset, length),
    };
    return new Proxy(this.#control, {
      get: (target, property) => {
        const override = overrides[property as keyof BotsSurface];
        const value = override ?? Reflect.get(target, property, target);
        return typeof value === "function"
          ? value.bind(override === undefined ? target : overrides)
          : value;
      },
    }) as BotsSurface;
  }

  #pendingApprovals(): BotPendingApproval[] {
    // A cold restart schedules already-due expiry timers with a zero delay. That is still one
    // event-loop turn too late for a user who opens the inbox or taps a push immediately, so settle
    // those durable rows synchronously before projecting the snapshot.
    for (const due of this.#storage.dueNativeApprovalIds([...this.#native], this.#now())) {
      const expired = this.#storage.expireNativeApprovalIfDue(due.bot, due.interactionId, this.#now());
      if (expired === undefined) continue;
      this.#clearInteractionTimer("approval", due.bot, due.interactionId);
      this.#emitApprovalResolved(due.bot, expired.sessionId, expired.turnId, due.interactionId, "expired");
      this.#state(due.bot, expired.sessionId, "polling", true);
    }
    // Storage also receives the configured set: a durable row from a removed/reconfigured profile
    // is intentionally invisible because its existing action route correctly rejects that bot.
    return this.#storage.pendingNativeApprovals([...this.#native], 100);
  }

  /** Expose only attach-configured identities. Hermes may host other profiles, but this gateway
   * has no token, plugin, or durable chat transport for them until the installer reconciles them.
   * Overlay the native transcript on their dashboard-owned metadata. */
  #roster() {
    const view = this.#control.roster();
    const bots = view.bots
      .filter((summary) => this.#native.has(normalize(summary.name)))
      .map((summary): BotSummary => {
        const bot = normalize(summary.name);
        const chat = this.#storage.nativeBotChat(bot, this.#now());
        const messages = this.#storage.nativeBotMessages(bot, chat.sessionId);
        const latest = messages.findLast(
          (message) => message.text.trim().length > 0,
        );
        return {
          ...summary,
          chatSessionId: chat.sessionId,
          lastActiveAt: latest?.at ?? null,
          preview:
            latest === undefined
              ? { kind: "empty", text: "No conversations yet, say hi" }
              : { kind: "plain", text: latest.text.trim() },
        };
      });
    return { ...view, bots };
  }

  handles(bot: string): boolean {
    return this.#native.has(normalize(bot));
  }

  canAccept(bot: string, frame: AttachV1EventFrame): boolean {
    const key = normalize(bot);
    if (!this.handles(key)) return false;
    if (frame.event.kind === "scheduled") {
      if ("target" in frame.event) return frame.event.target.kind === "canonical_home";
      return frame.event.threadId === this.#storage.nativeBotChat(key, this.#now()).sessionId;
    }
    return (
      "threadId" in frame.event &&
      this.#storage.nativeBotHasSession(key, frame.event.threadId)
    );
  }

  mobileRequest(bot: string, frame: AttachV1MobileRequest): void {
    const key = normalize(bot);
    if (!this.handles(key)) {
      this.#mobileNode?.reject(key, frame.requestId);
      return;
    }
    const chat = this.#storage.nativeBotChat(key, this.#now());
    if (chat.sessionId !== frame.threadId || chat.activeTurnId !== frame.turnId) {
      this.#mobileNode?.reject(key, frame.requestId);
      return;
    }
    this.#mobileNode?.invoke({
      ...frame, bot: key, agentId: key, deviceId: this.#turnOrigins.get(this.#nativeTurnKey(key, frame.threadId, frame.turnId)),
    });
  }

  /** Attach transport presence is the only connectivity signal. Commands remain durably queued;
   * this projects that fact without creating a second retry or timeout policy. */
  handleAttachPresence(bot: string, state: "online" | "degraded" | "absent"): void {
    const key = normalize(bot);
    if (!this.handles(key)) return;
    this.#attachPresence.set(key, state);
    const chat = this.#storage.nativeBotChat(key, this.#now());
    if (chat.activeTurnId !== undefined)
      this.#state(key, chat.sessionId, "polling", true);
  }

  close(): void {
    for (const timer of this.#interactionTimers.values()) clearTimeout(timer);
    this.#interactionTimers.clear();
    for (const timer of this.#turnTimers.values()) clearTimeout(timer);
    this.#turnTimers.clear();
  }

  handle(bot: string, frame: AttachV1EventFrame): boolean {
    const key = normalize(bot);
    if (!this.handles(key)) return false;
    const event = frame.event;
    if (event.kind === "presence" || event.kind === "media") return true;
    if (event.kind === "scheduled") {
      const delivery = this.#storage.attachScheduledDelivery(
        key,
        event.deliveryId,
      );
      if (
        delivery === undefined ||
        delivery.messageId !== event.messageId
      )
        return false;
      return this.#commit(
        key,
        delivery.threadId,
        event.messageId,
        event.blocks,
        event.mediaIds,
      );
    }
    if (!("threadId" in event)) return false;
    const sessionId = event.threadId;
    // One Hermes profile can serve both a core `/threads` agent and Bot Mode. The bearer token is
    // therefore not enough to decide which projection owns an event: only a durable local Bot
    // session may reach this plane. Group rooms are dispatched first by the server and use their
    // own durable group-turn binding.
    if (!this.#storage.nativeBotHasSession(key, sessionId)) return false;
    if ("turnId" in event) {
      if (this.#storage.nativeBotTurnTerminal(key, sessionId, event.turnId)) return true;
      const command = this.#storage.attachTurnCommand(key, event.turnId);
      if (command === undefined || command.threadId !== sessionId) return false;
    }
    if (event.kind === "draft") {
      const seq = (this.#draftSeq.get(event.turnId) ?? 0) + 1;
      this.#draftSeq.set(event.turnId, seq);
      const delta: BotChatDeltaFrame = {
        type: "bot_chat_delta",
        bot: key,
        sessionId,
        turnId: event.turnId,
        text: blocksToText(event.blocks),
        seq,
        updatedAt: this.#now(),
      };
      this.#broadcast(delta);
      this.#state(key, sessionId, "polling", true);
      return true;
    }
    if (event.kind === "commit") {
      this.#finish(key, sessionId, event.turnId, {
        phase: "complete",
        status: "completed",
      });
      return this.#commit(
        key,
        sessionId,
        event.messageId,
        event.blocks,
        event.mediaIds,
      );
    }
    if (
      event.kind === "failed" ||
      event.kind === "cancelled" ||
      event.kind === "interrupted"
    ) {
      this.#finish(key, sessionId, event.turnId, {
        phase: "failed",
        status: event.kind === "failed" ? "failed" : "interrupted",
        ...(event.kind === "cancelled" ? { cause: "cancelled" as const } : {}),
      });
      return true;
    }
    if (event.kind === "tool") return this.#tool(key, sessionId, event);
    if (event.kind === "approval") return this.#approval(key, sessionId, event);
    if (event.kind === "clarify") return this.#clarify(key, sessionId, event);
    return false;
  }

  async #canonical(name: string) {
    if (!this.#native.has(normalize(name))) throw new BotSessionNotFound(name);
    const bot = normalize(name);
    const chat = this.#storage.nativeBotChat(bot, this.#now());
    return {
      sessionId: chat.sessionId,
      adoption: chat.created ? ("created" as const) : ("pin" as const),
    };
  }

  #commands(name: string) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    return this.#ingress.commandCatalog(bot);
  }

  #attachmentHistory(input: {
    query?: string;
    kind?: "image" | "video" | "audio" | "file";
    bot?: string;
    since?: number;
    offset: number;
    limit: number;
  }) {
    const items = this.#storage.nativeBotAttachmentHistory({
      ...input,
      bots: [...this.#native],
      limit: input.limit + 1,
    });
    const hasMore = items.length > input.limit;
    return {
      items: hasMore ? items.slice(0, input.limit) : items,
      nextOffset: hasMore ? input.offset + input.limit : null,
    };
  }

  async #newSession(name: string) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    const now = this.#now();
    const previous = this.#storage.nativeBotChat(bot, now);
    if (previous.activeTurnId !== undefined)
      this.#cancelMobileTurn(bot, previous.sessionId, previous.activeTurnId);
    const previousSessionId = previous.sessionId;
    const sessionId = this.#storage.resetNativeBotChat(bot, now);
    // The existing app treats this as a cross-device transcript switch; the same adoption frame
    // remains correct even though attach-native sessions are gateway-owned rather than Hermes RPC
    // rows.
    this.#broadcast({
      type: "bot_chat_adopted",
      bot,
      sessionId,
      previousSessionId,
      updatedAt: now,
    });
    return { sessionId, previousSessionId };
  }

  async #sessions(name: string, limit: number) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    const activeSessionId = this.#storage.nativeBotChat(
      bot,
      this.#now(),
    ).sessionId;
    return {
      sessions: this.#storage.nativeBotSessions(bot, limit).map((session) => ({
        ...session,
        kind: "conversation" as const,
      })),
      activeSessionId,
    };
  }

  async #adoptSession(name: string, sessionId: string, _limit: number) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(sessionId);
    if (!this.#storage.nativeBotHasSession(bot, sessionId)) {
      const owner = this.#storage.nativeBotSessionOwner(sessionId);
      if (owner !== undefined) throw new BotSessionConflict(sessionId, owner);
      throw new BotSessionNotFound(sessionId);
    }
    const now = this.#now();
    const previousSessionId = this.#storage.nativeBotChat(bot, now).sessionId;
    // The ownership check above makes this update total. Keep the guard because the storage API is
    // also used by tests and must never silently create a session for an arbitrary id.
    if (!this.#storage.selectNativeBotSession(bot, sessionId, now))
      throw new BotSessionNotFound(sessionId);
    this.#broadcast({
      type: "bot_chat_adopted",
      bot,
      sessionId,
      previousSessionId,
      updatedAt: now,
    });
    return { name, sessionId, previousSessionId };
  }

  async #history(name: string) {
    if (!this.#native.has(normalize(name))) throw new BotSessionNotFound(name);
    const bot = normalize(name);
    const chat = this.#storage.nativeBotChat(bot, this.#now());
    const messages = this.#storage.nativeBotMessages(bot, chat.sessionId);
    const state = this.#turnState(bot, chat.sessionId, chat.activeTurnId);
    this.#rebroadcastPending(bot);
    return {
      sessionId: chat.sessionId,
      adoption: chat.created ? ("created" as const) : ("pin" as const),
      messages,
      running: chat.activeTurnId !== undefined,
      inflight: chat.activeTurnId !== undefined,
      ...(state === undefined ? {} : state),
      ...this.#historyToolSteps(chat.sessionId),
      updatedAt: this.#now(),
      ...(messages.length === 0 && this.#chatSuggestion !== ""
        ? { suggestion: this.#chatSuggestion }
        : {}),
    };
  }

  async #send(
    name: string,
    text: string,
    opts?: { clientId?: string; deviceId?: string },
  ): Promise<{ sessionId: string; message: BotChatMessage }> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    const now = this.#now();
    const chat = this.#storage.nativeBotChat(bot, now);
    const messageId = opts?.clientId ?? randomUUID();
    const turnId = chat.activeTurnId ?? randomUUID();
    const accepted = chat.activeTurnId === undefined
      ? this.#ingress.sendNativeTurn(bot, {
          threadId: chat.sessionId,
          turnId,
          messageId,
          text,
        })
      : this.#ingress.sendNativeSteer(bot, {
          threadId: chat.sessionId,
          turnId,
          messageId,
          text,
        });
    if (!accepted)
      throw new BackendUnavailable(`native attach-v1 profile "${bot}" is unavailable`);
    const message = this.#storage.appendNativeBotMessage({
      bot,
      sessionId: chat.sessionId,
      messageId,
      role: "user",
      text,
      at: now,
      ...(opts?.clientId === undefined ? {} : { clientId: opts.clientId }),
    });
    if (chat.activeTurnId === undefined) {
      this.#storage.setNativeBotTurn(bot, chat.sessionId, turnId, now);
      if (opts?.deviceId !== undefined) this.#turnOrigins.set(this.#nativeTurnKey(bot, chat.sessionId, turnId), opts.deviceId);
      this.#scheduleTurnTimeout(bot, chat.sessionId, turnId);
    }
    this.#broadcastMessage(bot, chat.sessionId, message, now);
    if (chat.activeTurnId === undefined)
      this.#state(bot, chat.sessionId, "polling", true);
    return { sessionId: chat.sessionId, message };
  }

  async #stop(name: string): Promise<"stopped" | "idle"> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    const chat = this.#storage.nativeBotChat(bot, this.#now());
    if (chat.activeTurnId === undefined) return "idle";
    this.#cancelMobileTurn(bot, chat.sessionId, chat.activeTurnId);
    if (!this.#ingress.sendNativeInterrupt(bot, {
      threadId: chat.sessionId,
      turnId: chat.activeTurnId,
    })) {
      throw new BackendUnavailable(
        `native attach-v1 profile "${bot}" cannot queue an interrupt`,
      );
    }
    return "stopped";
  }

  async #sendPhoto(
    name: string,
    photo: BotChatPhotoUpload,
    opts?: { deviceId?: string },
  ): Promise<{ sessionId: string; message: BotChatMessage }> {
    return this.#sendAttachment(name, {
      bytes: photo.bytes,
      mime: photo.mime,
      name: `image.${photo.ext}`,
      family: "image",
      text: photo.text,
      clientId: photo.clientId,
      label: "photo", deviceId: opts?.deviceId,
    });
  }

  async #sendFile(
    name: string,
    file: BotChatFileUpload,
    opts?: { deviceId?: string },
  ): Promise<{ sessionId: string; message: BotChatMessage }> {
    return this.#sendAttachment(name, { ...file, family: "file", label: "attachment", deviceId: opts?.deviceId });
  }

  /** One durable attachment turn, after each public route has validated its own file type. */
  async #sendAttachment(
    name: string,
    input: {
      bytes: Uint8Array;
      mime: string;
      name: string;
      family: "image" | "file";
      text: string;
      clientId?: string;
      deviceId?: string;
      label: "photo" | "attachment";
    },
  ): Promise<{ sessionId: string; message: BotChatMessage }> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    const now = this.#now();
    const chat = this.#storage.nativeBotChat(bot, now);
    const mediaId = randomUUID().replaceAll("-", "");
    const messageId = input.clientId ?? randomUUID();
    const turnId = randomUUID();
    if (chat.activeTurnId !== undefined) {
      throw new BackendUnavailable(
        `native attach-v1 profile "${bot}" cannot accept a ${input.label} while a turn is running`,
      );
    }
    // Persist before the socket can carry the command into another process. If enqueue rejects,
    // remove this exact unreferenced row so failure stays atomic from the app's point of view.
    this.#storage.saveAttachMedia(
      bot,
      {
        mediaId,
        mimeType: input.mime,
        byteCount: input.bytes.byteLength,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
        filename: input.name,
        family: input.family,
      },
      input.bytes,
      now,
    );
    if (!this.#ingress.sendNativeTurn(bot, {
      threadId: chat.sessionId,
      turnId,
      messageId,
      text: input.text,
      mediaIds: [mediaId],
    })) {
      this.#storage.deleteAttachMedia(bot, mediaId);
      throw new BackendUnavailable(`native attach-v1 profile "${bot}" is unavailable`);
    }
    const attachment: AttachmentBlock = {
      type: "attachment",
      fileId: mediaId,
      name: input.name,
      mimeType: input.mime,
      size: input.bytes.byteLength,
      mediaKind: input.family,
    };
    const message = this.#storage.appendNativeBotMessage({
      bot,
      sessionId: chat.sessionId,
      messageId,
      role: "user",
      text: input.text,
      at: now,
      attachments: [attachment],
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
    });
    this.#storage.setNativeBotTurn(bot, chat.sessionId, turnId, now);
    if (input.deviceId !== undefined) this.#turnOrigins.set(this.#nativeTurnKey(bot, chat.sessionId, turnId), input.deviceId);
    this.#scheduleTurnTimeout(bot, chat.sessionId, turnId);
    this.#broadcastMessage(bot, chat.sessionId, message, now);
    this.#state(bot, chat.sessionId, "polling", true);
    return { sessionId: chat.sessionId, message };
  }

  #broadcastMessage(
    bot: string,
    sessionId: string,
    message: BotChatMessage,
    now: number,
  ): void {
    this.#broadcast({
      type: "bot_chat",
      bot,
      sessionId,
      messages: [message],
      updatedAt: now,
    });
  }

  async #reset(name: string) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    const now = this.#now();
    const previous = this.#storage.nativeBotChat(bot, now);
    if (previous.activeTurnId !== undefined) {
      this.#cancelMobileTurn(bot, previous.sessionId, previous.activeTurnId);
      this.#ingress.sendNativeInterrupt(bot, {
        threadId: previous.sessionId,
        turnId: previous.activeTurnId,
      });
    }
    const sessionId = this.#storage.resetNativeBotChat(bot, now);
    this.#broadcast({
      type: "bot_chat_reset",
      bot,
      sessionId,
      previousSessionId: previous.sessionId,
      updatedAt: now,
    });
    return { sessionId, previousSessionId: previous.sessionId };
  }

  async #resolveApproval(
    name: string,
    approvalId: string,
    decision: BotApprovalDecision,
    _deviceId: string,
  ): Promise<BotApprovalResolveOutcome> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return "unknown";
    const binding = this.#storage.nativeInteraction(
      bot,
      "approval",
      approvalId,
    );
    if (binding === undefined) return "unknown";
    if (binding.status !== "pending")
      return binding.status === "expired" ? "expired" : "not_pending";
    const requested = this.#ingress.requestNativeApprovalResolution(bot, {
      threadId: binding.sessionId,
      turnId: binding.turnId,
      approvalId,
      decision,
    });
    if (requested.outcome === "expired") {
      this.#clearInteractionTimer("approval", bot, approvalId);
      this.#emitApprovalResolved(bot, requested.sessionId, requested.turnId, approvalId, "expired");
      this.#state(bot, requested.sessionId, "polling", true);
      return "expired";
    }
    if (requested.outcome === "requested") {
      this.#emitApprovalResolutionRequested(bot, binding.sessionId, binding.turnId, approvalId);
      return "requested";
    }
    if (requested.outcome === "already_requested") return "requested";
    if (requested.outcome === "resolution_pending") return "resolution_pending";
    return requested.outcome;
  }

  async #resolveClarify(
    name: string,
    clarifyId: string,
    optionId: string,
    _deviceId: string,
  ): Promise<BotClarifyResolveOutcome> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return "unknown";
    const binding = this.#storage.nativeInteraction(bot, "clarify", clarifyId);
    if (binding === undefined) return "unknown";
    if (binding.status !== "pending")
      return binding.status === "expired" ? "expired" : "not_pending";
    const payload = binding.payload as ClarifyPayload;
    if (!payload.options.some((option) => option.id === optionId))
      return "invalid_option";
    const requested = this.#ingress.requestNativeClarifyResolution(bot, {
      threadId: binding.sessionId,
      turnId: binding.turnId,
      clarifyId,
      optionId,
    });
    if (requested.outcome === "expired") {
      this.#clearInteractionTimer("clarify", bot, clarifyId);
      this.#broadcast({
        type: "bot_clarify_resolved",
        bot,
        sessionId: requested.sessionId,
        turnId: requested.turnId,
        clarifyId,
        outcome: "expired",
        updatedAt: this.#now(),
      });
      this.#state(bot, requested.sessionId, "polling", true);
      return "expired";
    }
    if (requested.outcome === "requested") {
      this.#emitClarifyResolutionRequested(bot, binding.sessionId, binding.turnId, clarifyId);
      return "requested";
    }
    if (requested.outcome === "already_requested") return "requested";
    if (requested.outcome === "resolution_pending") return "resolution_pending";
    return requested.outcome;
  }

  #attachmentInfo(name: string, fileId: string) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return undefined;
    const info = this.#storage.attachMediaInfo(bot, fileId, this.#now());
    return info === undefined
      ? undefined
      : { mime: info.mime, name: info.descriptor.filename, size: info.size };
  }

  #attachmentSlice(
    name: string,
    fileId: string,
    offset: number,
    length: number,
  ) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return undefined;
    return this.#storage.attachMediaSlice(
      bot,
      fileId,
      offset,
      length,
      this.#now(),
    );
  }

  #finish(
    bot: string,
    sessionId: string,
    turnId: string,
    terminal: Pick<NativeTurnState, "status" | "cause"> & {
      phase: Exclude<BotChatStateFrame["phase"], "polling">;
    } = { phase: "complete", status: "completed" },
  ): void {
    const settledActiveTurn = this.#storage.clearNativeBotTurn(
      bot,
      sessionId,
      turnId,
      this.#now(),
    );
    if (!settledActiveTurn) return;
    this.#clearTurnTimeout(bot, sessionId, turnId);
    this.#cancelMobileTurn(bot, sessionId, turnId);
    this.#storage.recordNativeBotTerminal({
      bot,
      sessionId,
      turnId,
      status: terminal.status as "completed" | "failed" | "interrupted" | "timed_out",
      ...(terminal.cause === "cancelled" ? { cause: "cancelled" as const } : {}),
      completedAt: this.#now(),
    });
    emitTrace(this.#trace, "native_turn_transition", {
      profile: traceId(bot), session: traceId(sessionId), turn: traceId(turnId),
      status: terminal.status, reason: terminal.cause ?? terminal.phase,
    });
    this.#tracedTurnStates.delete(this.#nativeTurnKey(bot, sessionId, turnId));
    this.#expireTurnInteractions(bot, sessionId, turnId);
    this.#sealTools(
      bot,
      sessionId,
      turnId,
      terminal.status === "completed" ? "ok" : "error",
    );
    const seq = (this.#draftSeq.get(turnId) ?? 0) + 1;
    this.#broadcast({
      type: "bot_chat_delta",
      bot,
      sessionId,
      turnId,
      text: "",
      seq,
      updatedAt: this.#now(),
      done: true,
    });
    this.#draftSeq.delete(turnId);
    this.#state(bot, sessionId, terminal.phase, false, terminal);
  }

  #commit(
    bot: string,
    sessionId: string,
    messageId: string,
    blocks: readonly RichBlock[],
    mediaIds?: string[],
  ): boolean {
    const now = this.#now();
    if (this.#storage.nativeBotMessage(bot, messageId) !== undefined)
      return true;
    const attachments = mediaIds?.flatMap((mediaId): AttachmentBlock[] => {
      const info = this.#storage.attachMediaInfo(bot, mediaId, now);
      if (info === undefined) return [];
      const family = info.descriptor.family;
      return [
        {
          type: "attachment",
          fileId: mediaId,
          name: info.descriptor.filename,
          mimeType: info.mime,
          size: info.size,
          ...(family === "image" || family === "audio" || family === "video" || family === "file"
            ? { mediaKind: family }
            : {}),
        },
      ];
    });
    const text = blocksToText(blocks);
    const message = this.#storage.appendNativeBotMessage({
      bot,
      sessionId,
      messageId,
      role: "assistant",
      text,
      at: now,
      ...(attachments === undefined || attachments.length === 0
        ? {}
        : { attachments }),
    });
    this.#broadcast({
      type: "bot_chat",
      bot,
      sessionId,
      messages: [message],
      updatedAt: now,
    });
    this.#onChatMessage?.({
      bot,
      displayName: bot,
      messageId,
      chatSessionId: sessionId,
      preview: text.slice(0, 240),
    });
    return true;
  }

  #tool(
    bot: string,
    sessionId: string,
    event: Extract<AttachV1EventFrame["event"], { kind: "tool" }>,
  ): boolean {
    const key = this.#nativeTurnKey(bot, sessionId, event.turnId);
    const current = this.#toolFrames.get(key) ?? {
      seq: 0,
      steps: new Map<string, BotToolStep>(),
    };
    const prior = current.steps.get(event.callId);
    const now = this.#now();
    const step: BotToolStep = {
      stepId: event.callId,
      seq: prior?.seq ?? current.steps.size + 1,
      name: event.name,
      status: event.status,
      startedAt: prior?.startedAt ?? now,
      ...(event.status === "running" ? {} : { endedAt: now }),
      ...(event.detail === undefined ? {} : { detail: event.detail }),
    };
    current.steps.set(event.callId, step);
    current.seq += 1;
    this.#toolFrames.set(key, current);
    this.#storage.upsertBotChatToolStep({
      bot,
      sessionId,
      turnId: event.turnId,
      stepId: step.stepId,
      seq: step.seq,
      name: step.name,
      status: step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      detail: step.detail,
    });
    const wire: BotToolActivityFrame = {
      type: "bot_tool_activity",
      bot,
      sessionId,
      turnId: event.turnId,
      steps: [...current.steps.values()],
      seq: current.seq,
      updatedAt: now,
    };
    this.#broadcast(wire);
    this.#state(bot, sessionId, "polling", true);
    return true;
  }

  /** The REST history is the sole reconnect recovery path. It deliberately includes active turns
   * too: after a Gateway restart the next terminal event can rebuild and seal this same state. */
  #historyToolSteps(sessionId: string): { toolSteps?: BotTurnToolSteps[] } {
    const turns = new Map<string, BotTurnToolSteps>();
    for (const row of this.#storage.botChatToolSteps(sessionId, 0)) {
      const turn = turns.get(row.turnId) ?? {
        turnId: row.turnId,
        startedAt: row.startedAt,
        steps: [],
      };
      const step: BotToolStep = {
        stepId: row.stepId,
        seq: row.seq,
        name: row.name,
        status: row.status as BotToolStep["status"],
        startedAt: row.startedAt,
        ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
        ...(row.detail === null ? {} : { detail: row.detail }),
        ...(row.errorText === null ? {} : { errorText: row.errorText }),
      };
      turn.steps.push(step);
      turns.set(row.turnId, turn);
    }
    const toolSteps = [...turns.values()].map((turn) => {
      turn.steps.sort((a, b) => a.seq - b.seq);
      const endedAt = turn.steps.reduce<number | undefined>(
        (latest, step) =>
          step.status === "running" || step.endedAt === undefined
            ? undefined
            : Math.max(latest ?? step.endedAt, step.endedAt),
        undefined,
      );
      return { ...turn, ...(endedAt === undefined ? {} : { endedAt }) };
    });
    return toolSteps.length === 0 ? {} : { toolSteps };
  }

  #turnState(
    bot: string,
    sessionId: string,
    turnId: string | undefined,
  ): NativeTurnState | undefined {
    if (turnId === undefined) {
      const terminal = this.#storage.nativeBotLastTerminal(bot, sessionId);
      if (terminal === undefined) return undefined;
      return {
        status: terminal.status,
        ...(terminal.cause === undefined ? {} : { cause: terminal.cause }),
      };
    }
    const delivery = this.#storage.nativeBotTurnDelivery(bot, turnId);
    const presence = this.#attachPresence.get(bot);
    const detached = presence === undefined
      ? this.#ingress.isAttached?.(bot) !== true
      : presence !== "online";
    const connection = detached
      ? presence === "degraded"
        ? "attach_degraded" as const
        : delivery?.acknowledgedAt === null || delivery === undefined
        ? "attach_absent" as const
        : "attach_lost" as const
      : undefined;
    const pending = this.#storage.pendingNativeInteractions(bot).some(
      (interaction) =>
        interaction.sessionId === sessionId && interaction.turnId === turnId,
    );
    if (pending) {
      return {
        status: "awaiting_input",
        ...(connection === undefined ? {} : { cause: connection }),
      };
    }
    const tools = this.#toolFrames.get(this.#nativeTurnKey(bot, sessionId, turnId));
    if ([...(tools?.steps.values() ?? [])].some((step) => step.status === "running")) {
      return {
        status: "using_tools",
        ...(connection === undefined ? {} : { cause: connection }),
      };
    }
    if (!detached) return { status: "executing" };
    if (delivery !== undefined && delivery.acknowledgedAt !== null)
      return { status: "connectivity_lost", cause: "attach_lost" };
    return {
      status: "queued",
      cause: "attach_absent",
      ...(delivery === undefined ? {} : { queuedAt: delivery.queuedAt }),
    };
  }

  #scheduleTurnTimeout(bot: string, sessionId: string, turnId: string): void {
    if (this.#turnTimeoutMs <= 0) return;
    const delivery = this.#storage.nativeBotTurnDelivery(bot, turnId);
    if (delivery === undefined) return;
    this.#clearTurnTimeout(bot, sessionId, turnId);
    const key = this.#nativeTurnKey(bot, sessionId, turnId);
    const timer = setTimeout(
      () => this.#timeoutTurn(bot, sessionId, turnId),
      Math.max(0, delivery.queuedAt + this.#turnTimeoutMs - this.#now()),
    );
    timer.unref();
    this.#turnTimers.set(key, timer);
  }

  #timeoutTurn(bot: string, sessionId: string, turnId: string): void {
    this.#turnTimers.delete(this.#nativeTurnKey(bot, sessionId, turnId));
    const chat = this.#storage.nativeBotChat(bot, this.#now());
    if (chat.sessionId !== sessionId || chat.activeTurnId !== turnId) return;
    const delivery = this.#storage.nativeBotTurnDelivery(bot, turnId);
    if (delivery === undefined) return;
    if (delivery.acknowledgedAt === null) {
      this.#storage.cancelAttachCommand(
        bot,
        delivery.sequence,
        delivery.commandId,
        "native turn timed out",
        this.#now(),
      );
    } else {
      this.#ingress.sendNativeInterrupt(bot, { threadId: sessionId, turnId });
    }
    this.#finish(bot, sessionId, turnId, {
      phase: "timeout",
      status: "timed_out",
    });
  }

  #clearTurnTimeout(bot: string, sessionId: string, turnId: string): void {
    const key = this.#nativeTurnKey(bot, sessionId, turnId);
    const timer = this.#turnTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#turnTimers.delete(key);
  }

  #nativeTurnKey(bot: string, sessionId: string, turnId: string): string {
    return `${bot}:${sessionId}:${turnId}`;
  }

  #cancelMobileTurn(bot: string, sessionId: string, turnId: string): void {
    this.#turnOrigins.delete(this.#nativeTurnKey(bot, sessionId, turnId));
    this.#mobileNode?.cancelTurn(bot, turnId);
  }

  #restoreToolFrames(bot: string): void {
    for (const session of this.#storage.nativeBotSessions(bot, 10_000)) {
      for (const row of this.#storage.botChatToolSteps(session.id, 0)) {
        const key = this.#nativeTurnKey(bot, session.id, row.turnId);
        const current = this.#toolFrames.get(key) ?? {
          seq: 0,
          steps: new Map<string, BotToolStep>(),
        };
        current.steps.set(row.stepId, {
          stepId: row.stepId,
          seq: row.seq,
          name: row.name,
          status: row.status as BotToolStep["status"],
          startedAt: row.startedAt,
          ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
          ...(row.detail === null ? {} : { detail: row.detail }),
          ...(row.errorText === null ? {} : { errorText: row.errorText }),
        });
        this.#toolFrames.set(key, current);
      }
    }
  }

  #sealTools(
    bot: string,
    sessionId: string,
    turnId: string,
    status: "ok" | "error",
  ): void {
    const current = this.#toolFrames.get(this.#nativeTurnKey(bot, sessionId, turnId));
    if (current === undefined || current.steps.size === 0) return;
    const now = this.#now();
    for (const [stepId, step] of current.steps) {
      if (step.status !== "running") continue;
      const sealed = { ...step, status, endedAt: now } as BotToolStep;
      current.steps.set(stepId, sealed);
      this.#storage.upsertBotChatToolStep({
        bot,
        sessionId,
        turnId,
        stepId: sealed.stepId,
        seq: sealed.seq,
        name: sealed.name,
        status: sealed.status,
        startedAt: sealed.startedAt,
        endedAt: sealed.endedAt,
        detail: sealed.detail,
        errorText: sealed.errorText,
      });
    }
    current.seq += 1;
    this.#broadcast({
      type: "bot_tool_activity",
      bot,
      sessionId,
      turnId,
      steps: [...current.steps.values()],
      seq: current.seq,
      updatedAt: now,
      done: true,
    });
    emitTrace(this.#trace, "native_tool_terminalization", {
      profile: traceId(bot), session: traceId(sessionId), turn: traceId(turnId), reason: status,
    });
  }

  #approval(
    bot: string,
    sessionId: string,
    event: Extract<AttachV1EventFrame["event"], { kind: "approval" }>,
  ): boolean {
    const outcome =
      event.status === "approved"
        ? "approved"
        : event.status === "denied"
          ? "denied"
          : event.status === "pending"
            ? undefined
            : "expired";
    const binding = outcome === undefined
      ? undefined
      : this.#storage.nativeInteraction(bot, "approval", event.approvalId);
    if (
      binding !== undefined &&
      (binding.sessionId !== sessionId || binding.turnId !== event.turnId)
    )
      return false;
    const change = this.#storage.recordNativeInteraction({
      bot,
      kind: "approval",
      interactionId: event.approvalId,
      sessionId,
      turnId: event.turnId,
      payload: { name: event.name } satisfies ApprovalPayload,
      status: outcome ?? "pending",
      ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
      updatedAt: this.#now(),
    });
    if (change === "duplicate") return true;
    if (change === "conflict") return false;
    if (outcome === undefined) {
      const wire: BotApprovalPendingFrame = {
        type: "bot_approval_pending",
        bot,
        sessionId,
        turnId: event.turnId,
        toolCallId: event.approvalId,
        name: event.name,
        updatedAt: this.#now(),
      };
      this.#broadcast(wire);
      this.#onApproval?.({
        bot,
        sessionId,
        turnId: event.turnId,
        toolCallId: event.approvalId,
        name: event.name,
      });
      if (event.expiresAt !== undefined)
        this.#scheduleInteractionExpiry({
          bot,
          kind: "approval",
          interactionId: event.approvalId,
          sessionId,
          turnId: event.turnId,
          payload: { name: event.name },
          expiresAt: event.expiresAt,
          updatedAt: this.#now(),
        });
      this.#state(bot, sessionId, "polling", true);
    } else {
      this.#clearInteractionTimer("approval", bot, event.approvalId);
      this.#emitApprovalResolved(
        bot,
        sessionId,
        event.turnId,
        event.approvalId,
        outcome,
      );
      this.#state(bot, sessionId, "polling", true);
    }
    return true;
  }

  #clarify(
    bot: string,
    sessionId: string,
    event: Extract<AttachV1EventFrame["event"], { kind: "clarify" }>,
  ): boolean {
    const outcome =
      event.status === "resolved"
        ? "selected"
        : event.status === "pending"
          ? undefined
          : event.status;
    const payload: ClarifyPayload = {
      prompt: event.prompt,
      options: event.options,
    };
    const binding = outcome === undefined
      ? undefined
      : this.#storage.nativeInteraction(bot, "clarify", event.clarifyId);
    if (
      binding !== undefined &&
      (binding.sessionId !== sessionId || binding.turnId !== event.turnId)
    )
      return false;
    const options = binding === undefined
      ? event.options
      : (binding.payload as ClarifyPayload).options;
    if (
      outcome === "selected" &&
      event.selectedOptionId !== undefined &&
      !options.some((option) => option.id === event.selectedOptionId)
    )
      return false;
    const change = this.#storage.recordNativeInteraction({
      bot,
      kind: "clarify",
      interactionId: event.clarifyId,
      sessionId,
      turnId: event.turnId,
      payload,
      status: outcome ?? "pending",
      ...(event.selectedOptionId === undefined
        ? {}
        : { selectedOptionId: event.selectedOptionId }),
      ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
      updatedAt: this.#now(),
    });
    if (change === "duplicate") return true;
    if (change === "conflict") return false;
    if (outcome === undefined) {
      const pending: BotClarifyPendingFrame = {
        type: "bot_clarify_pending",
        bot,
        sessionId,
        turnId: event.turnId,
        clarifyId: event.clarifyId,
        prompt: event.prompt,
        options: event.options,
        ...(event.expiresAt === undefined
          ? {}
          : { expiresAt: event.expiresAt }),
        updatedAt: this.#now(),
      };
      this.#broadcast(pending);
      if (event.expiresAt !== undefined)
        this.#scheduleInteractionExpiry({
          bot,
          kind: "clarify",
          interactionId: event.clarifyId,
          sessionId,
          turnId: event.turnId,
          payload,
          expiresAt: event.expiresAt,
          updatedAt: this.#now(),
        });
      this.#state(bot, sessionId, "polling", true);
    } else {
      this.#clearInteractionTimer("clarify", bot, event.clarifyId);
      const resolved: BotClarifyResolvedFrame = {
        type: "bot_clarify_resolved",
        bot,
        sessionId,
        turnId: event.turnId,
        clarifyId: event.clarifyId,
        outcome,
        ...(event.selectedOptionId === undefined
          ? {}
          : { selectedOptionId: event.selectedOptionId }),
        updatedAt: this.#now(),
      };
      this.#broadcast(resolved);
      this.#state(bot, sessionId, "polling", true);
    }
    return true;
  }

  #emitApprovalResolved(
    bot: string,
    sessionId: string,
    turnId: string,
    approvalId: string,
    outcome: "approved" | "denied" | "expired",
  ): void {
    const wire: BotApprovalResolvedFrame = {
      type: "bot_approval_resolved",
      bot,
      sessionId,
      turnId,
      toolCallId: approvalId,
      outcome,
      updatedAt: this.#now(),
    };
    this.#broadcast(wire);
    this.#onApproval?.({
      bot,
      sessionId,
      turnId,
      toolCallId: approvalId,
      outcome,
    });
  }

  #emitApprovalResolutionRequested(
    bot: string,
    sessionId: string,
    turnId: string,
    approvalId: string,
  ): void {
    const wire: BotApprovalResolutionRequestedFrame = {
      type: "bot_approval_resolution_requested",
      bot,
      sessionId,
      turnId,
      toolCallId: approvalId,
      updatedAt: this.#now(),
    };
    this.#broadcast(wire);
  }

  #emitClarifyResolutionRequested(
    bot: string,
    sessionId: string,
    turnId: string,
    clarifyId: string,
  ): void {
    const wire: BotClarifyResolutionRequestedFrame = {
      type: "bot_clarify_resolution_requested",
      bot,
      sessionId,
      turnId,
      clarifyId,
      updatedAt: this.#now(),
    };
    this.#broadcast(wire);
  }

  #scheduleInteractionExpiry(pending: {
    bot: string;
    kind: "approval" | "clarify";
    interactionId: string;
    sessionId: string;
    turnId: string;
    payload: unknown;
    expiresAt: number | null;
    updatedAt: number;
  }): void {
    if (pending.expiresAt === null) return;
    const key = `${pending.kind}:${pending.bot}:${pending.interactionId}`;
    const prior = this.#interactionTimers.get(key);
    if (prior !== undefined) clearTimeout(prior);
    const timer = setTimeout(
      () => {
        if (
          !this.#storage.resolveNativeInteraction(
            pending.bot,
            pending.kind,
            pending.interactionId,
            "expired",
            this.#now(),
          )
        )
          return;
        if (pending.kind === "approval") {
          this.#emitApprovalResolved(
            pending.bot,
            pending.sessionId,
            pending.turnId,
            pending.interactionId,
            "expired",
          );
        } else {
          this.#broadcast({
            type: "bot_clarify_resolved",
            bot: pending.bot,
            sessionId: pending.sessionId,
            turnId: pending.turnId,
            clarifyId: pending.interactionId,
            outcome: "expired",
            updatedAt: this.#now(),
          });
        }
        this.#interactionTimers.delete(key);
      },
      Math.max(0, pending.expiresAt - this.#now()),
    );
    timer.unref();
    this.#interactionTimers.set(key, timer);
  }

  #clearInteractionTimer(
    kind: "approval" | "clarify",
    bot: string,
    interactionId: string,
  ): void {
    const key = `${kind}:${bot}:${interactionId}`;
    const timer = this.#interactionTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#interactionTimers.delete(key);
  }

  #expireTurnInteractions(bot: string, sessionId: string, turnId: string): void {
    for (const pending of this.#storage.pendingNativeInteractions(bot)) {
      if (pending.sessionId !== sessionId || pending.turnId !== turnId) continue;
      if (!this.#storage.resolveNativeInteraction(
        bot,
        pending.kind,
        pending.interactionId,
        "expired",
        this.#now(),
      )) continue;
      this.#clearInteractionTimer(pending.kind, bot, pending.interactionId);
      if (pending.kind === "approval") {
        this.#emitApprovalResolved(
          bot,
          sessionId,
          turnId,
          pending.interactionId,
          "expired",
        );
      } else {
        this.#broadcast({
          type: "bot_clarify_resolved",
          bot,
          sessionId,
          turnId,
          clarifyId: pending.interactionId,
          outcome: "expired",
          updatedAt: this.#now(),
        });
      }
    }
  }

  #rebroadcastPending(bot: string): void {
    for (const pending of this.#storage.pendingNativeInteractions(bot)) {
      if (pending.kind === "approval") {
        const payload = pending.payload as ApprovalPayload;
        this.#broadcast({
          type: "bot_approval_pending",
          bot,
          sessionId: pending.sessionId,
          turnId: pending.turnId,
          toolCallId: pending.interactionId,
          name: payload.name,
          updatedAt: pending.updatedAt,
        });
      } else {
        const payload = pending.payload as ClarifyPayload;
        this.#broadcast({
          type: "bot_clarify_pending",
          bot,
          sessionId: pending.sessionId,
          turnId: pending.turnId,
          clarifyId: pending.interactionId,
          prompt: payload.prompt,
          options: payload.options,
          ...(pending.expiresAt === null
            ? {}
            : { expiresAt: pending.expiresAt }),
          updatedAt: pending.updatedAt,
        });
      }
    }
  }

  #state(
    bot: string,
    sessionId: string,
    phase: BotChatStateFrame["phase"],
    running: boolean,
    terminal?: NativeTurnState,
  ): void {
    const chat = this.#storage.nativeBotChat(bot, this.#now());
    const state = terminal ?? this.#turnState(bot, sessionId, chat.activeTurnId);
    if (chat.activeTurnId !== undefined && state !== undefined) {
      const key = this.#nativeTurnKey(bot, sessionId, chat.activeTurnId);
      const signature = `${state.status}:${state.cause ?? ""}`;
      if (this.#tracedTurnStates.get(key) !== signature) {
        this.#tracedTurnStates.set(key, signature);
        emitTrace(this.#trace, "native_turn_transition", {
          profile: traceId(bot), session: traceId(sessionId), turn: traceId(chat.activeTurnId),
          status: state.status, reason: state.cause ?? phase,
        });
      }
    }
    const frame: BotChatStateFrame = {
      type: "bot_chat_state",
      bot,
      sessionId,
      phase,
      running,
      inflight: running,
      ...(state === undefined ? {} : state),
      updatedAt: this.#now(),
    };
    this.#broadcast(frame);
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

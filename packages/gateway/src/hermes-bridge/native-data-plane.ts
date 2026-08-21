import { createHash, randomUUID } from "node:crypto";

import type {
  AttachmentBlock,
  BotApprovalPendingFrame,
  BotApprovalResolvedFrame,
  BotChatDeltaFrame,
  BotChatMessage,
  BotChatStateFrame,
  BotClarifyPendingFrame,
  BotClarifyResolvedFrame,
  BotToolActivityFrame,
  BotToolStep,
  BotSummary,
  ServerFrame,
} from "cozygateway-contract";

import type { AttachV1Ingress } from "../adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../adapters/attach/protocol-v1.ts";
import type { Storage } from "../storage.ts";
import type { BotApprovalDecision, BotApprovalResolveOutcome } from "./approvals.ts";
import type { BotChatPhotoUpload, BotsSurface } from "./bridge.ts";

export interface NativeBotDataPlaneOptions {
  control: BotsSurface;
  storage: Storage;
  ingress: AttachV1Ingress;
  nativeBots: Iterable<string>;
  shadowBots?: Iterable<string>;
  broadcast: (frame: ServerFrame) => void;
  onChatMessage?: (event: { bot: string; displayName: string; messageId: string; chatSessionId: string; preview: string }) => void;
  onApproval?: (event: { bot: string; sessionId: string; turnId: string; toolCallId: string; name?: string; outcome?: "approved" | "denied" | "expired" }) => void;
  now?: () => number;
}

interface ApprovalPayload { name: string }
interface ClarifyPayload { prompt: string; options: Array<{ id: string; label: string }> }

/** Per-profile migration gate for Bot Mode. The returned surface delegates management/control
 * methods to the dashboard bridge but owns every chat method for native profiles, making it
 * impossible for a native send or settlement to fall through to prompt.submit/session.resume. */
export class NativeBotDataPlane {
  readonly #control: BotsSurface;
  readonly #storage: Storage;
  readonly #ingress: AttachV1Ingress;
  readonly #native: Set<string>;
  readonly #shadow: Set<string>;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #onChatMessage: NativeBotDataPlaneOptions["onChatMessage"];
  readonly #onApproval: NativeBotDataPlaneOptions["onApproval"];
  readonly #now: () => number;
  readonly #draftSeq = new Map<string, number>();
  readonly #toolFrames = new Map<string, { seq: number; steps: Map<string, BotToolStep> }>();
  readonly #interactionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: NativeBotDataPlaneOptions) {
    this.#control = opts.control;
    this.#storage = opts.storage;
    this.#ingress = opts.ingress;
    this.#native = new Set([...opts.nativeBots].map(normalize));
    this.#shadow = new Set([...(opts.shadowBots ?? [])].map(normalize));
    this.#broadcast = opts.broadcast;
    this.#onChatMessage = opts.onChatMessage;
    this.#onApproval = opts.onApproval;
    this.#now = opts.now ?? Date.now;
    // Scheduled/home delivery is authorized against this durable gateway-owned binding, never a
    // target asserted by an event itself. Creating it at assembly makes the target canonical even
    // before the app has opened this bot's chat.
    for (const bot of [...this.#native, ...this.#shadow]) this.#storage.nativeBotChat(bot, this.#now());
    for (const pending of this.#storage.pendingNativeInteractions()) {
      if (this.#native.has(pending.bot)) this.#scheduleInteractionExpiry(pending);
    }
  }

  surface(): BotsSurface {
    const overrides: Partial<BotsSurface> = {
      roster: () => this.#roster(),
      canonicalChat: (name) => this.#canonical(name),
      chatHistory: (name) => this.#history(name),
      sendChatMessage: (name, text, opts) => this.#send(name, text, opts),
      sendChatPhoto: (name, photo) => this.#sendPhoto(name, photo),
      stopChat: (name) => this.#stop(name),
      resetChat: (name) => this.#reset(name),
      resolveApproval: (name, toolCallId, decision, deviceId) => this.#resolveApproval(name, toolCallId, decision, deviceId),
      resolveClarify: (name, clarifyId, optionId, deviceId) => this.#resolveClarify(name, clarifyId, optionId, deviceId),
      chatAttachmentInfo: (name, fileId) => this.#attachmentInfo(name, fileId),
      chatAttachmentSlice: (name, fileId, offset, length) => this.#attachmentSlice(name, fileId, offset, length),
    };
    return new Proxy(this.#control, {
      get: (target, property) => {
        const override = overrides[property as keyof BotsSurface];
        const value = override ?? Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(override === undefined ? target : overrides) : value;
      },
    });
  }

  /** Overlay the durable attach-v1 transcript on the dashboard-owned profile roster. Profile
   * metadata remains control-plane state, while chat identity, preview and activity come from the
   * same native rows `chatHistory` serves. */
  #roster() {
    const view = this.#control.roster();
    const bots = view.bots.map((summary): BotSummary => {
      const bot = normalize(summary.name);
      if (!this.#native.has(bot)) return summary;
      const chat = this.#storage.nativeBotChat(bot, this.#now());
      const messages = this.#storage.nativeBotMessages(bot, chat.sessionId);
      const latest = messages.findLast((message) => message.text.trim().length > 0);
      return {
        ...summary,
        chatSessionId: chat.sessionId,
        lastActiveAt: latest?.at ?? null,
        preview: latest === undefined
          ? { kind: "empty", text: "No conversations yet, say hi" }
          : { kind: "plain", text: latest.text.trim() },
      };
    });
    return { ...view, bots };
  }

  handles(bot: string): boolean { return this.#native.has(normalize(bot)) || this.#shadow.has(normalize(bot)); }

  canAccept(bot: string, frame: AttachV1EventFrame): boolean {
    const key = normalize(bot);
    if (!this.handles(key)) return false;
    if (frame.event.kind !== "scheduled") return true;
    return frame.event.threadId === this.#storage.nativeBotChat(key, this.#now()).sessionId;
  }

  close(): void {
    for (const timer of this.#interactionTimers.values()) clearTimeout(timer);
    this.#interactionTimers.clear();
  }

  handle(bot: string, frame: AttachV1EventFrame): boolean {
    const key = normalize(bot);
    if (!this.handles(key)) return false;
    // Shadow mode exercises authentication, journaling, ACK/replay and observability without
    // producing app-visible transcript state during a canary.
    if (this.#shadow.has(key)) return true;
    const event = frame.event;
    if (event.kind === "presence" || event.kind === "media") return true;
    if (event.kind === "scheduled") {
      const delivery = this.#storage.attachScheduledDelivery(key, event.deliveryId);
      if (delivery === undefined || delivery.threadId !== event.threadId || delivery.messageId !== event.messageId) return false;
      return this.#commit(key, event.threadId, event.messageId, event.blocks, event.mediaIds);
    }
    if (!("threadId" in event)) return false;
    const sessionId = event.threadId;
    if ("turnId" in event) {
      const command = this.#storage.attachTurnCommand(key, event.turnId);
      if (command === undefined || command.threadId !== sessionId) return false;
    }
    if (event.kind === "draft") {
      const seq = (this.#draftSeq.get(event.turnId) ?? 0) + 1;
      this.#draftSeq.set(event.turnId, seq);
      const delta: BotChatDeltaFrame = { type: "bot_chat_delta", bot: key, sessionId, turnId: event.turnId, text: blocksText(event.blocks), seq, updatedAt: this.#now() };
      this.#broadcast(delta);
      return true;
    }
    if (event.kind === "commit") {
      this.#finish(key, sessionId, event.turnId);
      return this.#commit(key, sessionId, event.messageId, event.blocks, event.mediaIds);
    }
    if (event.kind === "failed" || event.kind === "cancelled" || event.kind === "interrupted") {
      this.#finish(key, sessionId, event.turnId, "failed");
      return true;
    }
    if (event.kind === "tool") return this.#tool(key, sessionId, event);
    if (event.kind === "approval") return this.#approval(key, sessionId, event);
    if (event.kind === "clarify") return this.#clarify(key, sessionId, event);
    return false;
  }

  async #canonical(name: string) {
    if (!this.#native.has(normalize(name))) return this.#control.canonicalChat(name);
    const chat = this.#storage.nativeBotChat(normalize(name), this.#now());
    return { sessionId: chat.sessionId, adoption: chat.created ? "created" as const : "pin" as const };
  }

  async #history(name: string) {
    if (!this.#native.has(normalize(name))) return this.#control.chatHistory(name);
    const chat = this.#storage.nativeBotChat(normalize(name), this.#now());
    this.#rebroadcastPending(normalize(name));
    return {
      sessionId: chat.sessionId,
      adoption: chat.created ? "created" as const : "pin" as const,
      messages: this.#storage.nativeBotMessages(normalize(name), chat.sessionId),
      running: chat.activeTurnId !== undefined,
      inflight: chat.activeTurnId !== undefined,
      updatedAt: this.#now(),
    };
  }

  async #send(name: string, text: string, opts?: { clientId?: string }): Promise<{ sessionId: string; message: BotChatMessage }> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return this.#control.sendChatMessage(name, text, opts);
    const now = this.#now();
    const chat = this.#storage.nativeBotChat(bot, now);
    const messageId = opts?.clientId ?? randomUUID();
    const turnId = randomUUID();
    const message = this.#storage.appendNativeBotMessage({ bot, sessionId: chat.sessionId, messageId, role: "user", text, at: now, ...(opts?.clientId === undefined ? {} : { clientId: opts.clientId }) });
    this.#submitNativeTurn(bot, chat.sessionId, turnId, message, text, now);
    return { sessionId: chat.sessionId, message };
  }

  async #stop(name: string): Promise<"stopped" | "idle"> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return this.#control.stopChat(name);
    const chat = this.#storage.nativeBotChat(bot, this.#now());
    if (chat.activeTurnId === undefined) return "idle";
    this.#ingress.sendNativeInterrupt(bot, { threadId: chat.sessionId, turnId: chat.activeTurnId });
    return "stopped";
  }

  async #sendPhoto(name: string, photo: BotChatPhotoUpload): Promise<{ sessionId: string; message: BotChatMessage }> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return this.#control.sendChatPhoto(name, photo);
    const now = this.#now();
    const chat = this.#storage.nativeBotChat(bot, now);
    const mediaId = randomUUID().replaceAll("-", "");
    const messageId = photo.clientId ?? randomUUID();
    const turnId = randomUUID();
    this.#storage.saveAttachMedia(
      bot,
      {
        mediaId,
        mimeType: photo.mime,
        byteCount: photo.bytes.byteLength,
        sha256: createHash("sha256").update(photo.bytes).digest("hex"),
        filename: `image.${photo.ext}`,
        family: "image",
      },
      photo.bytes,
      now,
    );
    const attachment: AttachmentBlock = { type: "attachment", fileId: mediaId, name: `image.${photo.ext}`, mimeType: photo.mime, size: photo.bytes.byteLength, mediaKind: "image" };
    const message = this.#storage.appendNativeBotMessage({ bot, sessionId: chat.sessionId, messageId, role: "user", text: photo.text, at: now, attachments: [attachment], ...(photo.clientId === undefined ? {} : { clientId: photo.clientId }) });
    this.#submitNativeTurn(bot, chat.sessionId, turnId, message, photo.text, now, [mediaId]);
    return { sessionId: chat.sessionId, message };
  }

  #submitNativeTurn(
    bot: string,
    sessionId: string,
    turnId: string,
    message: BotChatMessage,
    text: string,
    now: number,
    mediaIds?: string[],
  ): void {
    this.#storage.setNativeBotTurn(bot, turnId, now);
    if (!this.#ingress.sendNativeTurn(bot, { threadId: sessionId, turnId, messageId: message.id, text, ...(mediaIds === undefined ? {} : { mediaIds }) })) {
      this.#storage.setNativeBotTurn(bot, undefined, now);
      throw new Error(`native attach-v1 profile "${bot}" is unavailable`);
    }
    this.#broadcast({ type: "bot_chat", bot, sessionId, messages: [message], updatedAt: now });
    this.#state(bot, sessionId, "polling", true);
  }

  async #reset(name: string) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return this.#control.resetChat(name);
    const previousSessionId = this.#storage.nativeBotChat(bot, this.#now()).sessionId;
    const sessionId = this.#storage.resetNativeBotChat(bot, this.#now());
    this.#broadcast({ type: "bot_chat_reset", bot, sessionId, previousSessionId, updatedAt: this.#now() });
    return { sessionId, previousSessionId };
  }

  async #resolveApproval(name: string, approvalId: string, decision: BotApprovalDecision, _deviceId: string): Promise<BotApprovalResolveOutcome> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return this.#control.resolveApproval(name, approvalId, decision, _deviceId);
    const binding = this.#storage.nativeInteraction(bot, "approval", approvalId);
    if (binding === undefined) return "unknown";
    if (binding.status !== "pending") return binding.status === "expired" ? "expired" : "not_pending";
    const outcome = decision === "approve" ? "approved" : "denied";
    if (!this.#ingress.sendApprovalResolution(
      bot,
      { threadId: binding.sessionId, turnId: binding.turnId, approvalId, decision },
      `approval:${bot}:${approvalId}`,
    )) return "unsupported";
    if (!this.#storage.resolveNativeInteraction(bot, "approval", approvalId, outcome, this.#now())) return "not_pending";
    this.#clearInteractionTimer("approval", bot, approvalId);
    this.#emitApprovalResolved(bot, binding.sessionId, binding.turnId, approvalId, outcome);
    return outcome;
  }

  async #resolveClarify(
    name: string,
    clarifyId: string,
    optionId: string,
    deviceId: string,
  ): Promise<"selected" | "unknown" | "not_pending" | "expired" | "invalid_option" | "unsupported"> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return this.#control.resolveClarify(name, clarifyId, optionId, deviceId);
    const binding = this.#storage.nativeInteraction(bot, "clarify", clarifyId);
    if (binding === undefined) return "unknown";
    if (binding.status !== "pending") return binding.status === "expired" ? "expired" : "not_pending";
    const payload = binding.payload as ClarifyPayload;
    if (!payload.options.some((option) => option.id === optionId)) return "invalid_option";
    if (!this.#ingress.sendClarifyResolution(
      bot,
      { threadId: binding.sessionId, turnId: binding.turnId, clarifyId, optionId },
      `clarify:${bot}:${clarifyId}`,
    )) return "unsupported";
    if (!this.#storage.resolveNativeInteraction(bot, "clarify", clarifyId, "selected", this.#now(), optionId)) return "not_pending";
    this.#clearInteractionTimer("clarify", bot, clarifyId);
    this.#broadcast({ type: "bot_clarify_resolved", bot, sessionId: binding.sessionId, turnId: binding.turnId, clarifyId, outcome: "selected", selectedOptionId: optionId, updatedAt: this.#now() });
    return "selected";
  }

  #attachmentInfo(name: string, fileId: string) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return this.#control.chatAttachmentInfo(name, fileId);
    const info = this.#storage.attachMediaInfo(bot, fileId, this.#now());
    return info === undefined ? undefined : { mime: info.mime, name: info.descriptor.filename, size: info.size };
  }

  #attachmentSlice(name: string, fileId: string, offset: number, length: number) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return this.#control.chatAttachmentSlice(name, fileId, offset, length);
    return this.#storage.attachMediaSlice(bot, fileId, offset, length, this.#now());
  }

  #finish(bot: string, sessionId: string, turnId: string, phase: "complete" | "failed" = "complete"): void {
    this.#storage.setNativeBotTurn(bot, undefined, this.#now());
    const seq = (this.#draftSeq.get(turnId) ?? 0) + 1;
    this.#broadcast({ type: "bot_chat_delta", bot, sessionId, turnId, text: "", seq, updatedAt: this.#now(), done: true });
    this.#draftSeq.delete(turnId);
    this.#state(bot, sessionId, phase, false);
  }

  #commit(bot: string, sessionId: string, messageId: string, blocks: readonly { type: string; [key: string]: unknown }[], mediaIds?: string[]): boolean {
    const now = this.#now();
    if (this.#storage.nativeBotMessage(bot, messageId) !== undefined) return true;
    const attachments = mediaIds?.flatMap((mediaId): AttachmentBlock[] => {
      const info = this.#storage.attachMediaInfo(bot, mediaId, now);
      if (info === undefined) return [];
      const family = info.descriptor.family;
      return [{ type: "attachment", fileId: mediaId, name: info.descriptor.filename, mimeType: info.mime, size: info.size, ...(family === "image" || family === "audio" || family === "video" ? { mediaKind: family } : {}) }];
    });
    const text = blocksText(blocks);
    const message = this.#storage.appendNativeBotMessage({ bot, sessionId, messageId, role: "assistant", text, at: now, ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }) });
    this.#broadcast({ type: "bot_chat", bot, sessionId, messages: [message], updatedAt: now });
    this.#onChatMessage?.({ bot, displayName: bot, messageId, chatSessionId: sessionId, preview: text.slice(0, 240) });
    return true;
  }

  #tool(bot: string, sessionId: string, event: Extract<AttachV1EventFrame["event"], { kind: "tool" }>): boolean {
    const current = this.#toolFrames.get(event.turnId) ?? { seq: 0, steps: new Map<string, BotToolStep>() };
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
    this.#toolFrames.set(event.turnId, current);
    this.#storage.upsertBotChatToolStep({ bot, sessionId, turnId: event.turnId, stepId: step.stepId, seq: step.seq, name: step.name, status: step.status, startedAt: step.startedAt, endedAt: step.endedAt, detail: step.detail });
    const wire: BotToolActivityFrame = { type: "bot_tool_activity", bot, sessionId, turnId: event.turnId, steps: [...current.steps.values()], seq: current.seq, updatedAt: now };
    this.#broadcast(wire);
    return true;
  }

  #approval(bot: string, sessionId: string, event: Extract<AttachV1EventFrame["event"], { kind: "approval" }>): boolean {
    const outcome = event.status === "approved" ? "approved" : event.status === "denied" ? "denied" : event.status === "pending" ? undefined : "expired";
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
    if (outcome === undefined) {
      const wire: BotApprovalPendingFrame = { type: "bot_approval_pending", bot, sessionId, turnId: event.turnId, toolCallId: event.approvalId, name: event.name, updatedAt: this.#now() };
      this.#broadcast(wire);
      this.#onApproval?.({ bot, sessionId, turnId: event.turnId, toolCallId: event.approvalId, name: event.name });
      if (event.expiresAt !== undefined) this.#scheduleInteractionExpiry({ bot, kind: "approval", interactionId: event.approvalId, sessionId, turnId: event.turnId, payload: { name: event.name }, expiresAt: event.expiresAt, updatedAt: this.#now() });
    } else {
      this.#clearInteractionTimer("approval", bot, event.approvalId);
      this.#emitApprovalResolved(bot, sessionId, event.turnId, event.approvalId, outcome);
    }
    return true;
  }

  #clarify(bot: string, sessionId: string, event: Extract<AttachV1EventFrame["event"], { kind: "clarify" }>): boolean {
    const outcome = event.status === "resolved" ? "selected" : event.status === "pending" ? undefined : event.status;
    const payload: ClarifyPayload = { prompt: event.prompt, options: event.options };
    const change = this.#storage.recordNativeInteraction({
      bot,
      kind: "clarify",
      interactionId: event.clarifyId,
      sessionId,
      turnId: event.turnId,
      payload,
      status: outcome ?? "pending",
      ...(event.selectedOptionId === undefined ? {} : { selectedOptionId: event.selectedOptionId }),
      ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
      updatedAt: this.#now(),
    });
    if (change === "duplicate") return true;
    if (outcome === undefined) {
      const pending: BotClarifyPendingFrame = { type: "bot_clarify_pending", bot, sessionId, turnId: event.turnId, clarifyId: event.clarifyId, prompt: event.prompt, options: event.options, ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }), updatedAt: this.#now() };
      this.#broadcast(pending);
      if (event.expiresAt !== undefined) this.#scheduleInteractionExpiry({ bot, kind: "clarify", interactionId: event.clarifyId, sessionId, turnId: event.turnId, payload, expiresAt: event.expiresAt, updatedAt: this.#now() });
    } else {
      this.#clearInteractionTimer("clarify", bot, event.clarifyId);
      const resolved: BotClarifyResolvedFrame = { type: "bot_clarify_resolved", bot, sessionId, turnId: event.turnId, clarifyId: event.clarifyId, outcome, ...(event.selectedOptionId === undefined ? {} : { selectedOptionId: event.selectedOptionId }), updatedAt: this.#now() };
      this.#broadcast(resolved);
    }
    return true;
  }

  #emitApprovalResolved(bot: string, sessionId: string, turnId: string, approvalId: string, outcome: "approved" | "denied" | "expired"): void {
    const wire: BotApprovalResolvedFrame = { type: "bot_approval_resolved", bot, sessionId, turnId, toolCallId: approvalId, outcome, updatedAt: this.#now() };
    this.#broadcast(wire);
    this.#onApproval?.({ bot, sessionId, turnId, toolCallId: approvalId, outcome });
  }

  #scheduleInteractionExpiry(pending: {
    bot: string; kind: "approval" | "clarify"; interactionId: string; sessionId: string; turnId: string;
    payload: unknown; expiresAt: number | null; updatedAt: number;
  }): void {
    if (pending.expiresAt === null) return;
    const key = `${pending.kind}:${pending.bot}:${pending.interactionId}`;
    const prior = this.#interactionTimers.get(key);
    if (prior !== undefined) clearTimeout(prior);
    const timer = setTimeout(() => {
      if (!this.#storage.resolveNativeInteraction(pending.bot, pending.kind, pending.interactionId, "expired", this.#now())) return;
      if (pending.kind === "approval") {
        this.#emitApprovalResolved(pending.bot, pending.sessionId, pending.turnId, pending.interactionId, "expired");
      } else {
        this.#broadcast({ type: "bot_clarify_resolved", bot: pending.bot, sessionId: pending.sessionId, turnId: pending.turnId, clarifyId: pending.interactionId, outcome: "expired", updatedAt: this.#now() });
      }
      this.#interactionTimers.delete(key);
    }, Math.max(0, pending.expiresAt - this.#now()));
    timer.unref();
    this.#interactionTimers.set(key, timer);
  }

  #clearInteractionTimer(kind: "approval" | "clarify", bot: string, interactionId: string): void {
    const key = `${kind}:${bot}:${interactionId}`;
    const timer = this.#interactionTimers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#interactionTimers.delete(key);
  }

  #rebroadcastPending(bot: string): void {
    for (const pending of this.#storage.pendingNativeInteractions(bot)) {
      if (pending.kind === "approval") {
        const payload = pending.payload as ApprovalPayload;
        this.#broadcast({ type: "bot_approval_pending", bot, sessionId: pending.sessionId, turnId: pending.turnId, toolCallId: pending.interactionId, name: payload.name, updatedAt: pending.updatedAt });
      } else {
        const payload = pending.payload as ClarifyPayload;
        this.#broadcast({ type: "bot_clarify_pending", bot, sessionId: pending.sessionId, turnId: pending.turnId, clarifyId: pending.interactionId, prompt: payload.prompt, options: payload.options, ...(pending.expiresAt === null ? {} : { expiresAt: pending.expiresAt }), updatedAt: pending.updatedAt });
      }
    }
  }

  #state(bot: string, sessionId: string, phase: BotChatStateFrame["phase"], running: boolean): void {
    const frame: BotChatStateFrame = { type: "bot_chat_state", bot, sessionId, phase, running, inflight: running, updatedAt: this.#now() };
    this.#broadcast(frame);
  }
}

function normalize(value: string): string { return value.trim().toLowerCase(); }

function blocksText(blocks: readonly { type: string; [key: string]: unknown }[]): string {
  return blocks.map((block) => typeof block.text === "string" ? block.text : typeof block.code === "string" ? block.code : "").filter(Boolean).join("\n");
}

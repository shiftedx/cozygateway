import { createHash, randomUUID } from "node:crypto";

import type {
  AttachmentBlock,
  BotChatAttachment,
  BotApprovalPendingFrame,
  BotApprovalResolutionRequestedFrame,
  BotApprovalResolvedFrame,
  BotChatDeltaFrame,
  BotChatMessage,
  BotChatStateCause,
  BotChatStateFrame,
  BotMobileReceipt,
  BotChatStatus,
  BotInteractionSettlement,
  BotClarifyPendingFrame,
  BotClarifyResolutionRequestedFrame,
  BotClarifyResolvedFrame,
  BotToolActivityFrame,
  BotToolStep,
  BotTurnToolSteps,
  BotDelegationActivityFrame,
  BotDelegationChild,
  BotTurnDelegations,
  BotThinkingActivityFrame,
  BotSummary,
  BotDesktopHermesSession,
  BotDesktopHermesResumeResponse,
  BotPendingClarification,
  BotPendingApproval,
  RichBlock,
  ServerFrame,
} from "cozygateway-contract";

import type { AttachV1Ingress } from "../adapters/attach/ingress-v1.ts";
import { blocksToText } from "../adapters/attach/blocks-to-text.ts";
import { emitTrace, traceId, type TraceLog } from "../trace.ts";
import type { AttachV1EventFrame, AttachV1MobileRequest } from "../adapters/attach/protocol-v1.ts";
import type { MobileNodeBroker, MobileNodeReceiptInput } from "../mobile-node.ts";
import { BackendUnavailable, UnsupportedForRuntime } from "../errors.ts";
import type { Storage } from "../storage.ts";
import { ATTACH_MEDIA_TTL_MS } from "./photos.ts";
import type {
  BotApprovalDecision,
  BotClarifyResolveOutcome,
  BotApprovalResolveOutcome,
} from "./approvals.ts";
import { BotNameTaken } from "./crud.ts";
import { GroupInvalid } from "./group-rooms.ts";
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
  /** Config-declared bots served by a non-Hermes runtime. They have no Dashboard profile, so their
   * roster row is built here and their Dashboard-backed surfaces refuse instead of asking. */
  runtimeBots?: readonly {
    id: string;
    name: string;
    avatar: string | null;
    runtime: "cozyagents";
  }[];
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
  /** How often the stale-turn sweep runs. 0 disables the sweep entirely. */
  staleTurnSweepMs?: number | undefined;
  /** Silence after an ACKED interrupt before the gateway seals the turn itself. */
  staleTurnInterruptGraceMs?: number | undefined;
  /** Hard ceiling of TOTAL silence (no frames of any kind) before a turn is reaped. */
  staleTurnCeilingMs?: number | undefined;
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

interface DelegationFrameState {
  seq: number;
  count: number;
  /** Canonical Hermes delegation id (`deleg_...`) once any event carried it; keep-first. */
  aliasId?: string;
  children: Map<string, BotDelegationChild>;
}

/** Delegation statuses that will never change on their own again (a settled child may still be
 * overwritten by a REAL finish leg upgrading an `unknown`, but never regresses to live). */
const DELEGATION_SETTLED = new Set<BotDelegationChild["status"]>([
  "succeeded", "failed", "interrupted", "stalled", "unknown",
]);

type LiveTurnFrame = BotChatDeltaFrame | BotToolActivityFrame | BotDelegationActivityFrame | BotThinkingActivityFrame | BotChatStateFrame;

interface LiveTurnBatch {
  timer: ReturnType<typeof setTimeout>;
  frames: Map<string, LiveTurnFrame>;
}

/** Coalescing slot for a live-turn frame: latest-wins per type, except delegation snapshots,
 * which are latest-wins per (type, batch). */
function liveTurnFrameKey(frame: LiveTurnFrame): string {
  return frame.type === "bot_delegation_activity"
    ? `${frame.type}:${frame.batchId}`
    : frame.type;
}

const LIVE_TURN_FLUSH_MS = 100;
const DESKTOP_RESUME_CONFIRM_MS = 2_000;

/** Kept structural at this assembly seam so `pnpm --filter cozygateway typecheck` does not depend
 * on a prior contract build. The public wire shape is owned and schema-checked in ext-bots.ts. */
type CozyAppsReadiness = {
  status: "ready" | "degraded";
  reason?: "cozyapps_not_negotiated";
  repair?: "restart_profile";
};

interface NativeTurnState {
  status: BotChatStatus;
  cause?: BotChatStateCause;
  queuedAt?: number;
}

/** The exact fields `#nativeOverlay` writes onto a roster row. */
type NativeRowOverlay = Pick<
  BotSummary,
  "chatSessionId" | "lastActiveAt" | "preview" | "syncState"
> &
  Partial<Pick<BotSummary, "cozyApps" | "syncReason" | "syncRepair">>;

/** `BotsSurface` methods whose answer comes from the Hermes Dashboard and that take the bot name
 * first. A bot served by another runtime has no Dashboard profile behind it, so asking would ask
 * about a profile that does not exist and answer 404. Chat, readiness and desktop-session methods
 * are absent on purpose: the native plane owns those for every bot it handles. */
const DASHBOARD_ONLY: ReadonlySet<string> = new Set([
  "botProfile",
  "configureProfile",
  "modelConfig",
  "configureModel",
  "modelProviders",
  "configureModelProviderField",
  "clearModelProviderField",
  "startModelProviderOAuth",
  "pollModelProviderOAuth",
  "submitModelProviderOAuthCode",
  "cancelModelProviderOAuth",
  "desktopSessionTranscript",
  "routines",
  "createRoutine",
  "patchRoutine",
  "deleteRoutine",
  "deleteBot",
]);

/** Attach-owned Bot Mode data plane. The returned surface delegates management/control methods to
 * the dashboard bridge but owns every chat method for configured profiles, making it impossible
 * for a native send or settlement to fall through to the Dashboard chat transport. */
export class NativeBotDataPlane {
  readonly #control: BotControlSurface;
  readonly #storage: Storage;
  readonly #ingress: AttachV1Ingress;
  readonly #native: Set<string>;
  readonly #runtimeBots: Map<string, NonNullable<NativeBotDataPlaneOptions["runtimeBots"]>[number]>;
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
  /** Device-bound private CozyApp executions. Never persisted or exposed on either public wire. */
  readonly #cozyAppOrigins = new Map<string, { deviceId: string; expiresAt: number }>();
  readonly #cozyAppOriginTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #draftSeq = new Map<string, number>();
  /** Last plugin-side thinking `seq` per turnId. In-memory only: thinking is ephemeral by
   *  design (capability 35), so there is no storage row and no restore on reboot. */
  readonly #thinkingSeq = new Map<string, number>();
  readonly #toolFrames = new Map<string, ToolFrameState>();
  readonly #delegationFrames = new Map<string, Map<string, DelegationFrameState>>();
  readonly #tracedTurnStates = new Map<string, string>();
  readonly #attachPresence = new Map<string, "online" | "degraded" | "absent">();
  readonly #desktopResumeWaiters = new Map<string, (sessionId: string) => void>();
  readonly #desktopResumeOperations = new Map<string, Promise<BotDesktopHermesResumeResponse>>();
  readonly #latestSessionResolutions = new Map<string, Promise<void>>();
  /** A durable binding proves identity; this process-local proof additionally proves the currently
   * attached plugin switched its private raw-session map during this data-plane lifetime. */
  readonly #liveDesktopResumeProofs = new Map<
    string,
    { hermesSessionId: string; sessionId: string }
  >();
  readonly #interactionTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  readonly #turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #liveTurnBatches = new Map<string, LiveTurnBatch>();
  readonly #staleTurnSweepMs: number;
  readonly #staleTurnInterruptGraceMs: number;
  readonly #staleTurnCeilingMs: number;
  /** Last moment this turn produced ANY frame. Seeded from the durable queuedAt, so a restart
   *  does not hand a turn that was already silent for an hour a fresh hour of silence. */
  readonly #turnActivity = new Map<string, number>();
  /** When an interrupt for this turn was accepted by the plugin. */
  readonly #interruptAcked = new Map<string, number>();
  #staleTurnSweep: ReturnType<typeof setInterval> | undefined;

  constructor(opts: NativeBotDataPlaneOptions) {
    this.#control = opts.control;
    this.#storage = opts.storage;
    this.#ingress = opts.ingress;
    this.#native = new Set([...opts.nativeBots].map(normalize));
    this.#runtimeBots = new Map(
      (opts.runtimeBots ?? []).map((bot) => [normalize(bot.id), bot]),
    );
    this.#chatSuggestion = opts.chatSuggestion;
    this.#broadcast = opts.broadcast;
    this.#onChatMessage = opts.onChatMessage;
    this.#onApproval = opts.onApproval;
    this.#now = opts.now ?? Date.now;
    this.#turnTimeoutMs = opts.turnTimeoutMs ?? 0;
    this.#staleTurnSweepMs = opts.staleTurnSweepMs ?? 60_000;
    this.#staleTurnInterruptGraceMs = opts.staleTurnInterruptGraceMs ?? 120_000;
    this.#staleTurnCeilingMs = opts.staleTurnCeilingMs ?? 1_800_000;
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
      this.#restoreDelegationFrames(bot);
      if (chat.activeTurnId !== undefined) {
        this.#scheduleTurnTimeout(bot, chat.sessionId, chat.activeTurnId);
        this.#seedTurnActivity(bot, chat.sessionId, chat.activeTurnId);
      }
    }
    for (const pending of this.#storage.pendingNativeInteractions()) {
      if (this.#native.has(pending.bot))
        this.#scheduleInteractionExpiry(pending);
    }
  }

  surface(): BotsSurface {
    const overrides: Partial<BotsSurface> = {
      roster: () => this.#roster(),
      createBot: async (input) => {
        // The proxy guard cannot see this one: its first argument is a create request, not a name.
        // Unguarded it writes a Hermes profile the roster filter then hides and DELETE refuses,
        // leaving an orphan no route can reach.
        const bot = normalize(input.name);
        if (this.#runtimeBots.has(bot)) throw new BotNameTaken(bot);
        return this.#control.createBot(input);
      },
      createGroup: async (name, members) => {
        // Room membership is resolved against `profiles.list`, which never names a runtime bot, so
        // without this the user is told the bot is not on this gateway while `GET /bots` lists it.
        for (const member of members) {
          const bot = normalize(member);
          const runtimeBot = this.#runtimeBots.get(bot);
          if (runtimeBot !== undefined)
            throw new GroupInvalid(
              `${bot} is a ${runtimeBot.runtime} runtime bot; rooms are not supported for runtime bots yet`,
            );
        }
        return this.#control.createGroup(name, members);
      },
      readiness: (name) => this.#readiness(name),
      commands: (name) => this.#commands(name),
      pendingApprovals: () => this.#pendingApprovals(),
      pendingClarifications: () => this.#pendingClarifications(),
      terminalSettlements: () => this.#terminalSettlements(),
      attachmentHistory: (input) => this.#attachmentHistory(input),
      desktopSessions: (name) => this.#desktopSessions(name),
      resumeDesktopSession: (name, hermesSessionId) =>
        this.#resumeDesktopSession(name, hermesSessionId),
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
      recordDisplayed: (name, messageIds, deviceId) =>
        this.#recordDisplayed(name, messageIds, deviceId),
    };
    return new Proxy(this.#control, {
      get: (target, property) => {
        const override = overrides[property as keyof BotsSurface];
        const value = override ?? Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        const bound = value.bind(override === undefined ? target : overrides);
        if (typeof property !== "string" || !DASHBOARD_ONLY.has(property))
          return bound;
        // The refusal is decided here so the Dashboard bridge is never reached for a bot it does
        // not own. Rejected rather than thrown: every guarded method returns a promise.
        return (...args: unknown[]) => {
          const name = typeof args[0] === "string" ? normalize(args[0]) : undefined;
          const runtimeBot = name === undefined ? undefined : this.#runtimeBots.get(name);
          if (name === undefined || runtimeBot === undefined) return bound(...args);
          return Promise.reject(
            new UnsupportedForRuntime(name, property, runtimeBot.runtime),
          );
        };
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

  #pendingClarifications(): BotPendingClarification[] {
    return this.#storage.pendingNativeClarifications([...this.#native], 100);
  }

  #terminalSettlements(): BotInteractionSettlement[] {
    return this.#storage.terminalNativeSettlements([...this.#native]);
  }

  /** Expose every profile Hermes reports, while overlaying native transcript state only for
   * attach-configured identities. An unmanaged profile is still a real Hermes agent and hiding it
   * made CozyChat's roster disagree with Desktop/CLI; `syncState` keeps that visibility honest
   * without inventing a writable chat lane.
   *
   * Public because the `bot_roster` frame has to be the same rows `GET /bots` returns. The control
   * plane builds a roster from `profiles.list` alone, which knows no local conversation identity,
   * so a frame published straight from it carried `chatSessionId: null` while the REST route
   * carried the real id: a client could not join a `bot_chat_delta` to the roster row it belongs
   * to. One function, both surfaces, no drift. */
  rosterBots(bots: readonly BotSummary[]): BotSummary[] {
    const rows = bots
      // A Hermes profile sharing an id with a runtime bot would otherwise produce two rows for
      // one name. The config-declared row wins: it is the identity this gateway actually serves.
      .filter((summary) => !this.#runtimeBots.has(normalize(summary.name)))
      .map((summary): BotSummary => {
        const bot = normalize(summary.name);
        if (!this.#native.has(bot)) {
          return { ...summary, chatSessionId: null, syncState: "setup_required" };
        }
        return { ...summary, ...this.#nativeOverlay(bot) };
      });
    // A config-declared runtime bot has no Hermes profile to overlay, so its row is built here.
    // Appended in this function rather than in `#roster` so the `bot_roster` frame, which is
    // published through this overlay, carries exactly the rows `GET /bots` returns.
    for (const bot of this.#runtimeBots.values()) rows.push(this.#runtimeRow(bot));
    return rows;
  }

  /** Everything a native row knows that the Dashboard cannot: the local conversation identity,
   * its latest line, and how far its attach transport has come. Typed as the exact fields it
   * writes, so spreading it over a partial row still satisfies `BotSummary`. */
  #nativeOverlay(bot: string): NativeRowOverlay {
    const chat = this.#storage.nativeBotChat(bot, this.#now());
    const messages = this.#storage.nativeBotMessages(bot, chat.sessionId);
    const latest = messages.findLast((message) => message.text.trim().length > 0);
    const cozyApps = this.#cozyAppsReadiness(bot);
    return {
      chatSessionId: chat.sessionId,
      lastActiveAt: latest?.at ?? null,
      preview:
        latest === undefined
          ? { kind: "empty", text: "No conversations yet, say hi" }
          : { kind: "plain", text: latest.text.trim() },
      syncState: this.#syncState(bot),
      ...(cozyApps === undefined ? {} : { cozyApps }),
      ...(cozyApps?.reason === undefined ? {} : { syncReason: cozyApps.reason }),
      ...(cozyApps?.repair === undefined ? {} : { syncRepair: cozyApps.repair }),
    };
  }

  #runtimeRow(
    bot: NonNullable<NativeBotDataPlaneOptions["runtimeBots"]>[number],
  ): BotSummary {
    const id = normalize(bot.id);
    return {
      name: id,
      displayName: bot.name,
      handle: id,
      description: null,
      // No route serves a runtime bot's avatar in v0.0.1, so claiming one would send every client
      // after an image that does not exist. The configured value is still the agents row's.
      hasAvatar: false,
      group: null,
      pinned: false,
      active: this.#syncState(id) === "ready",
      meta: null,
      runtime: bot.runtime,
      ...this.#nativeOverlay(id),
    };
  }

  #roster() {
    const view = this.#control.roster();
    return { ...view, bots: this.rosterBots(view.bots) };
  }

  /** A profile is not usable merely because Hermes lists it. Native Bot Mode becomes writable
   * only after the profile's authenticated attach-v1 transport is online. Unconfigured profiles
   * report `setup_required`; the installer adds them to gateway config, and the ensuing restart
   * constructs the native plane that can eventually move through `starting` to `ready`. */
  #readiness(name: string) {
    const key = normalize(name);
    const cozyApps = this.#cozyAppsReadiness(key);
    return {
      name: key,
      status: this.#syncState(key),
      ...(cozyApps === undefined ? {} : { cozyApps }),
      ...(cozyApps?.reason === undefined ? {} : { reason: cozyApps.reason }),
      ...(cozyApps?.repair === undefined ? {} : { repair: cozyApps.repair }),
      updatedAt: this.#now(),
    };
  }

  #syncState(bot: string): "setup_required" | "starting" | "ready" {
    if (!this.handles(bot)) return "setup_required";
    const presence = this.#attachPresence.get(bot);
    const transportReady = presence !== "degraded" && presence !== "absent"
      && (presence === "online" || this.#ingress.isAttached?.(bot) === true);
    if (!transportReady) return "starting";
    // An online old plugin can still accept chat turns, but it cannot publish or action CozyApps.
    // Surface the existing non-ready state until its launch is restarted with the installed plugin
    // rather than letting an app infer feature availability from the gateway-wide capability alone.
    return this.#cozyAppsReadiness(bot)?.status === "degraded" ? "starting" : "ready";
  }

  #cozyAppsReadiness(bot: string): CozyAppsReadiness | undefined {
    if (!this.handles(bot)) return undefined;
    // `restart_profile` repairs a Hermes plugin launch. A config-declared runtime bot has no
    // plugin to restart, so a missing `cozyapps` negotiation is a fact about its peer's feature
    // set, not a reason to hold its row out of `ready`.
    if (this.#runtimeBots.has(bot)) return undefined;
    // Unit seams from pre-capability tests deliberately model only attachment. Production ingress
    // always exposes this accessor; absence here means no capability observation is available.
    const capabilitiesFor = this.#ingress.negotiatedCapabilities;
    if (typeof capabilitiesFor !== "function") return undefined;
    const presence = this.#attachPresence.get(bot);
    const transportReady = presence !== "degraded" && presence !== "absent"
      && (presence === "online" || this.#ingress.isAttached?.(bot) === true);
    if (!transportReady) return { status: "degraded" };
    return capabilitiesFor.call(this.#ingress, bot).has("cozyapps")
      ? { status: "ready" }
      : {
          status: "degraded",
          reason: "cozyapps_not_negotiated",
          repair: "restart_profile",
        };
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
    if (frame.event.kind === "desktop_session_resumed") {
      return this.#storage.nativeBotHasSession(key, frame.event.threadId);
    }
    if (frame.event.kind === "desktop_session_message") {
      if (!this.#storage.nativeBotHasSession(key, frame.event.threadId)) return false;
      // A gateway-origin transcript row is the attach plugin observing the mobile message we
      // already committed locally. Accepting it would turn the mirror into a feedback loop and
      // render every matching user or assistant row twice. Only an independently verified
      // Desktop/TUI/CLI source may project transcript history back into this local session.
      if (frame.event.source === "cozygateway") return false;
      return this.#storage.hasConfirmedNativeDesktopResume(
        key, frame.event.desktopSessionId, frame.event.threadId,
      );
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
    const privateOrigin = this.#cozyAppOrigins.get(this.#nativeTurnKey(key, frame.threadId, frame.turnId));
    if (privateOrigin !== undefined) {
      if (privateOrigin.expiresAt < this.#now()) {
        this.#cozyAppOrigins.delete(this.#nativeTurnKey(key, frame.threadId, frame.turnId));
        this.#mobileNode?.reject(key, frame.requestId);
        return;
      }
      const { kind: _kind, ...request } = frame;
      this.#mobileNode?.invoke({ ...request, bot: key, agentId: key, deviceId: privateOrigin.deviceId });
      return;
    }
    const chat = this.#storage.nativeBotChat(key, this.#now());
    if (chat.sessionId !== frame.threadId || chat.activeTurnId !== frame.turnId) {
      this.#mobileNode?.reject(key, frame.requestId);
      return;
    }
    // `kind` belongs to the attach envelope, not to the phone frame. Spreading the whole attach
    // frame carried it onto the wire, where the app requires an exact key set and silently drops
    // anything carrying an extra one. Strip it here, at the boundary it stops being meaningful.
    const { kind: _kind, ...request } = frame;
    this.#mobileNode?.invoke({
      ...request, bot: key, agentId: key, deviceId: this.#turnOrigins.get(this.#nativeTurnKey(key, frame.threadId, frame.turnId)),
    });
  }

  registerCozyAppActionOrigin(bot: string, appId: string, actionRequestId: string, deviceId: string, ttlMs: number): boolean {
    const key = normalize(bot);
    if (!this.handles(key) || !/^[A-Za-z0-9_-]{1,128}$/.test(appId) || !/^[A-Za-z0-9_-]{1,128}$/.test(actionRequestId)) return false;
    const threadId = `__cozyapp__:${appId}`;
    const originKey = this.#nativeTurnKey(key, threadId, actionRequestId);
    this.#cozyAppOrigins.set(originKey, { deviceId, expiresAt: this.#now() + ttlMs });
    clearTimeout(this.#cozyAppOriginTimers.get(originKey));
    const timer = setTimeout(() => { this.#cozyAppOrigins.delete(originKey); this.#cozyAppOriginTimers.delete(originKey); }, ttlMs);
    timer.unref?.(); this.#cozyAppOriginTimers.set(originKey, timer);
    return true;
  }

  clearCozyAppActionOrigin(bot: string, appId: string, actionRequestId: string): void {
    const key = this.#nativeTurnKey(normalize(bot), `__cozyapp__:${appId}`, actionRequestId);
    this.#cozyAppOrigins.delete(key); clearTimeout(this.#cozyAppOriginTimers.get(key)); this.#cozyAppOriginTimers.delete(key);
  }

  recordMobileReceipt(input: MobileNodeReceiptInput): BotMobileReceipt | undefined {
    const receipt = this.#storage.recordBotMobileReceipt({
      requestId: input.requestId,
      bot: input.bot,
      sessionId: input.threadId,
      turnId: input.turnId,
      command: input.command,
      sharedDescription: input.sharedDescription,
      purpose: input.purpose,
      sharedAt: this.#now(),
    });
    if (receipt === undefined) return undefined;
    // Durability gates sharing. Live emission is best effort because history replays the stored receipt.
    try {
      this.#broadcast({ type: "bot_mobile_receipt", ...receipt });
    } catch {}
    return receipt;
  }

  /** Attach transport presence is the only connectivity signal. Commands remain durably queued;
   * this projects that fact without creating a second retry or timeout policy. */
  handleAttachPresence(bot: string, state: "online" | "degraded" | "absent"): void {
    const key = normalize(bot);
    if (!this.handles(key)) return;
    this.#attachPresence.set(key, state);
    const chat = this.#storage.nativeBotChat(key, this.#now());
    if (chat.activeTurnId !== undefined) {
      this.#flushLiveTurn(this.#nativeTurnKey(key, chat.sessionId, chat.activeTurnId));
      this.#state(key, chat.sessionId, "polling", true);
    }
  }

  close(): void {
    if (this.#staleTurnSweep !== undefined) clearInterval(this.#staleTurnSweep);
    this.#staleTurnSweep = undefined;
    this.#turnActivity.clear();
    this.#interruptAcked.clear();
    for (const timer of this.#interactionTimers.values()) clearTimeout(timer);
    this.#interactionTimers.clear();
    for (const timer of this.#turnTimers.values()) clearTimeout(timer);
    this.#turnTimers.clear();
    for (const timer of this.#cozyAppOriginTimers.values()) clearTimeout(timer);
    this.#cozyAppOriginTimers.clear();
    this.#cozyAppOrigins.clear();
    for (const batch of this.#liveTurnBatches.values()) clearTimeout(batch.timer);
    this.#liveTurnBatches.clear();
    this.#desktopResumeOperations.clear();
    this.#latestSessionResolutions.clear();
    this.#liveDesktopResumeProofs.clear();
  }

  handle(bot: string, frame: AttachV1EventFrame): boolean {
    const key = normalize(bot);
    if (!this.handles(key)) return false;
    const event = frame.event;
    if (event.kind === "presence" || event.kind === "media") return true;
    if (event.kind === "desktop_session_resumed") {
      const confirmed = this.#storage.confirmNativeDesktopResume({
        bot: key,
        hermesSessionId: event.hermesSessionId,
        sessionId: event.threadId,
        resumeId: event.resumeId,
        now: this.#now(),
      });
      if (confirmed === undefined) return false;
      this.#liveDesktopResumeProofs.set(key, {
        hermesSessionId: event.hermesSessionId,
        sessionId: event.threadId,
      });
      if (confirmed.selectionChanged) {
        this.#broadcast({
          type: "bot_chat_adopted",
          bot: key,
          sessionId: event.threadId,
          previousSessionId: confirmed.previousSessionId,
          updatedAt: this.#now(),
        });
      }
      this.#desktopResumeWaiters.get(event.resumeId)?.(event.threadId);
      this.#desktopResumeWaiters.delete(event.resumeId);
      return true;
    }
    if (event.kind === "desktop_session_message") {
      if (!this.canAccept(key, frame)) return false;
      const messageId = desktopSessionMessageId(event.source, event.hermesSessionId, event.rowId);
      // Attach is at-least-once. The storage uniqueness guard is authoritative, but read first so
      // a replay is acknowledged without emitting another `bot_chat` frame.
      if (this.#storage.nativeBotMessage(key, messageId) !== undefined) return true;
      const message = this.#storage.appendNativeBotMessage({
        bot: key,
        sessionId: event.threadId,
        messageId,
        role: event.role,
        text: event.text,
        at: event.at,
        // Capability 47. A desktop-authored row is still this bot's row, and the reader asking
        // "who said this?" deserves the same answer here as on a gateway-projected reply. It
        // answers no gateway turn, so it names none.
        ...(event.role === "user" ? {} : { authorBot: key }),
      });
      this.#broadcastMessage(key, event.threadId, message, this.#now());
      return true;
    }
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
        event.mediaPositions,
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
      const command = this.#storage.attachTurnCommand(key, event.turnId);
      const terminal = this.#storage.nativeBotTurnTerminal(key, sessionId, event.turnId);
      if (terminal !== undefined) {
        // A delegation batch legitimately outlives its turn (async delegate_task): a child's
        // finish leg lands after the seal and must still settle its card. Ephemeral, so the
        // at-least-once replay of an already-settled state is acknowledged inside #delegation.
        if (event.kind === "delegation")
          return this.#delegation(key, sessionId, event, false);
        const delivery = this.#storage.nativeBotTurnDelivery(key, event.turnId);
        // An acknowledged Hermes turn may finish after something else sealed it: the local
        // response deadline, the stale-turn reaper, or the plugin's own interrupt seal. The
        // durable reply is still authoritative -- it is the one thing the user was waiting for,
        // and this used to honor it only past a `timed_out` seal, so a commit landing after any
        // other provisional terminal was acknowledged and silently dropped (issue #193). The
        // projection is idempotent by messageId, so an at-least-once retry is safe.
        // The one exception is an explicit user cancel (`cause: "cancelled"`): the user said
        // stop and the plugin witnessed it, so a late reply stays suppressed. Every other seal
        // is a provisional gateway guess that the durable reply outranks.
        if (
          event.kind === "commit" &&
          command?.threadId === sessionId &&
          delivery !== undefined &&
          delivery.acknowledgedAt !== null &&
          terminal.cause !== "cancelled"
        ) {
          const committed = this.#commit(
            key, sessionId, event.messageId, event.blocks, event.mediaIds, event.mediaPositions,
            event.turnId,
          );
          if (committed && event.continues !== true && terminal.status !== "completed") {
            this.#storage.recordNativeBotTerminal({
              bot: key, sessionId, turnId: event.turnId,
              status: "completed", completedAt: this.#now(),
            });
            // The provisional seal may have left the durable pointer standing (a crash between
            // journal and apply does exactly that); settle it with the same guarded clear.
            this.#storage.clearNativeBotTurn(key, sessionId, event.turnId, this.#now());
            this.#state(key, sessionId, "complete", false, { status: "completed" });
          }
          return committed;
        }
        return true;
      }
      if (command === undefined || command.threadId !== sessionId) {
        // This is a known native session, so no other projection will claim the event; the
        // declined guard is the whole diagnosis and must not die silent (issue #193).
        this.#log(
          `native ${event.kind} event for "${key}" declined: ${command === undefined ? "no durable turn command" : "turn command bound to another thread"} (turn ${event.turnId})`,
        );
        return false;
      }
      // Any frame at all is proof the turn is alive. A long tool run keeps producing them (tool
      // steps, drafts, and since #189 interim commits), which is exactly what makes total silence
      // a safe staleness signal rather than a race against slow work.
      this.#turnActivity.set(this.#nativeTurnKey(key, sessionId, event.turnId), this.#now());
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
      this.#coalesceLiveTurn(
        this.#nativeTurnKey(key, sessionId, event.turnId),
        delta,
        this.#stateFrame(key, sessionId, "polling", true),
      );
      return true;
    }
    if (event.kind === "commit") {
      // A Hermes agent loop legitimately replies more than once: an interim reply mid-run is the
      // same `commit` frame as the last one, so the gateway cannot tell them apart on its own and
      // used to end the turn on the first. The plugin can tell them apart, and says so. An interim
      // commit projects its message like any other and leaves the TURN running, so the tool events
      // and drafts the agent keeps producing still reach the app.
      if (event.continues === true)
        return this.#commitInterim(key, sessionId, event);
      // Project the reply DURABLY before sealing the turn. Both halves are idempotent, but only
      // this order is crash-safe: a death between them leaves the message on record and the
      // turn open, and the next assembly's replay re-runs both. The old order could die having
      // sealed the turn without ever projecting the reply -- the ghost issue #193 repaired by
      // hand in production. The seal callback keeps the WIRE order clients pin: live activity
      // flushes, the terminal frames go out, and the answer lands last.
      return this.#commit(
        key,
        sessionId,
        event.messageId,
        event.blocks,
        event.mediaIds,
        event.mediaPositions,
        event.turnId,
        () =>
          this.#finish(key, sessionId, event.turnId, {
            phase: "complete",
            status: "completed",
          }),
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
    if (event.kind === "thinking") return this.#thinking(key, sessionId, event);
    if (event.kind === "delegation") return this.#delegation(key, sessionId, event, true);
    if (event.kind === "approval") return this.#approval(key, sessionId, event);
    if (event.kind === "clarify") return this.#clarify(key, sessionId, event);
    return false;
  }

  async #canonical(name: string) {
    if (!this.#native.has(normalize(name))) throw new BotSessionNotFound(name);
    const bot = normalize(name);
    await this.#resolveLatestSession(bot);
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

  async #desktopSessions(name: string) {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    this.#assertRuntimeSupports(bot, "desktopSessions");
    return this.#control.desktopSessions(bot);
  }

  /** These two surfaces are native-plane overrides, so the `surface()` guard never sees them.
   * Their answer still comes from the Dashboard, so a runtime bot gets the same refusal. */
  #assertRuntimeSupports(bot: string, feature: string): void {
    const runtimeBot = this.#runtimeBots.get(bot);
    if (runtimeBot !== undefined)
      throw new UnsupportedForRuntime(bot, feature, runtimeBot.runtime);
  }

  /** Resolve one authoritative conversation before a read or send. The gateway compares actual
   * message activity across its selected local chat and the source-qualified Desktop/TUI/CLI
   * index, then performs the existing exact resume proof only when another session is newer. */
  async #resolveLatestSession(bot: string): Promise<void> {
    const inflight = this.#latestSessionResolutions.get(bot);
    if (inflight !== undefined) return inflight;
    const resolution = this.#resolveLatestSessionOnce(bot);
    this.#latestSessionResolutions.set(bot, resolution);
    try {
      await resolution;
    } finally {
      if (this.#latestSessionResolutions.get(bot) === resolution)
        this.#latestSessionResolutions.delete(bot);
    }
  }

  async #resolveLatestSessionOnce(bot: string): Promise<void> {
    // A runtime bot has no Hermes profile, so the Desktop/TUI/CLI index cannot hold a session for
    // it. Asking anyway would issue a profile RPC on every chat read and send whose failure this
    // method's catch would silently swallow.
    if (this.#runtimeBots.has(bot)) return;
    const current = this.#storage.nativeBotChat(bot, this.#now());
    // Never redirect an in-flight lane. The session that owns the running turn remains canonical
    // until Hermes settles it; the next read/send performs the same recency resolution again.
    if (current.activeTurnId !== undefined) return;
    try {
      const latest = latestDesktopSession(await this.#control.desktopSessions(bot));
      if (latest === undefined) return;
      const binding = this.#storage.nativeDesktopResumeBinding(bot, current.sessionId);
      if (binding?.hermesSessionId === latest.hermesSessionId) {
        const proof = this.#liveDesktopResumeProofs.get(bot);
        if (proof?.hermesSessionId === latest.hermesSessionId
            && proof.sessionId === current.sessionId) return;
        // The durable selection is already right, but a restarted plugin needs a fresh private
        // raw-session proof. Confirmation deliberately emits no adoption frame for this no-op.
        await this.#resumeEligibleDesktopSession(bot, latest.hermesSessionId);
        return;
      }
      const localActivity = this.#storage.nativeBotSessionActivityAt(bot, current.sessionId) ?? 0;
      if (localActivity >= desktopActivityStamp(latest)) return;
      await this.#resumeEligibleDesktopSession(bot, latest.hermesSessionId);
    } catch {
      // Cross-surface continuity is enhancement-only. An unavailable index, transcript, or attach
      // proof leaves the existing gateway chat readable and sendable rather than failing the chat.
    }
  }

  async #resumeDesktopSession(
    name: string,
    hermesSessionId: string,
  ): Promise<BotDesktopHermesResumeResponse> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    this.#assertRuntimeSupports(bot, "resumeDesktopSession");
    // Re-read the source-qualified dashboard index at action time. A row shown earlier is no
    // authorization to resume after it was deleted, reclassified, or moved to another profile.
    const eligible = await this.#control.desktopSessions(bot);
    if (!eligible.some((row) => row.hermesSessionId === hermesSessionId))
      throw new BotSessionNotFound(hermesSessionId);
    return this.#resumeEligibleDesktopSession(bot, hermesSessionId);
  }

  async #resumeEligibleDesktopSession(
    bot: string,
    hermesSessionId: string,
  ): Promise<BotDesktopHermesResumeResponse> {
    const key = `${bot}\u0000${hermesSessionId}`;
    const inflight = this.#desktopResumeOperations.get(key);
    if (inflight !== undefined) return inflight;
    const operation = this.#performDesktopSessionResume(bot, hermesSessionId);
    this.#desktopResumeOperations.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#desktopResumeOperations.get(key) === operation)
        this.#desktopResumeOperations.delete(key);
    }
  }

  async #performDesktopSessionResume(
    bot: string,
    hermesSessionId: string,
  ): Promise<BotDesktopHermesResumeResponse> {
    const current = this.#storage.nativeBotChat(bot, this.#now());
    if (current.activeTurnId !== undefined)
      throw new BackendUnavailable("cannot resume a desktop session while this bot has a running native turn");
    const staged = this.#storage.stageNativeDesktopResume(bot, hermesSessionId, this.#now());
    // Read and sanitize the desktop transcript before the plugin can confirm. The staged local
    // session is not selected yet, so a failed/slow source read cannot redirect a normal send.
    const imported = await this.#control.desktopSessionTranscript(bot, hermesSessionId);
    for (const [index, message] of imported.entries()) {
      this.#storage.appendNativeBotMessage({
        bot,
        sessionId: staged.sessionId,
        messageId: `desktop:${hermesSessionId}:${message.id}`,
        role: message.role,
        text: message.text,
        at: message.at ?? this.#now() + index,
        ...(message.role === "user" ? {} : { authorBot: bot }),
      });
    }
    // A durable `resumed` binding only proves a past plugin process switched its private raw
    // session map. Every explicit adoption therefore queues a fresh command/proof before this
    // gateway may report it resumed or (re)select the local chat.
    const confirmed = new Promise<string>((resolve) => this.#desktopResumeWaiters.set(staged.resumeId, resolve));
    if (!this.#ingress.sendNativeDesktopResume(bot, {
      threadId: staged.sessionId,
      hermesSessionId,
      resumeId: staged.resumeId,
    })) {
      this.#desktopResumeWaiters.delete(staged.resumeId);
      throw new BackendUnavailable("the attached Hermes plugin does not support exact desktop-session resume");
    }
    const sessionId = await Promise.race([
      confirmed,
      new Promise<undefined>((resolve) => setTimeout(resolve, DESKTOP_RESUME_CONFIRM_MS)),
    ]);
    this.#desktopResumeWaiters.delete(staged.resumeId);
    return {
      name: bot,
      source: "hermes_desktop",
      hermesSessionId,
      status: sessionId === undefined ? "pending" : "resumed",
      ...(sessionId === undefined ? {} : { sessionId }),
    };
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
    if (previous.activeTurnId !== undefined) {
      this.#discardLiveTurn(this.#nativeTurnKey(bot, previous.sessionId, previous.activeTurnId));
      this.#cancelMobileTurn(bot, previous.sessionId, previous.activeTurnId);
    }
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
    const previous = this.#storage.nativeBotChat(bot, now);
    const previousSessionId = previous.sessionId;
    if (previous.activeTurnId !== undefined)
      this.#discardLiveTurn(this.#nativeTurnKey(bot, previous.sessionId, previous.activeTurnId));
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
    await this.#resolveLatestSession(bot);
    const chat = this.#storage.nativeBotChat(bot, this.#now());
    const messages = this.#storage.nativeBotMessages(bot, chat.sessionId);
    const state = this.#turnState(bot, chat.sessionId, chat.activeTurnId);
    this.#rebroadcastPending(bot);
    return {
      sessionId: chat.sessionId,
      adoption: chat.created ? ("created" as const) : ("pin" as const),
      messages,
      mobileReceipts: this.#storage.nativeBotMobileReceipts(bot, chat.sessionId),
      running: chat.activeTurnId !== undefined,
      inflight: chat.activeTurnId !== undefined,
      ...(state === undefined ? {} : state),
      ...this.#historyToolSteps(chat.sessionId),
      ...this.#historyDelegations(chat.sessionId),
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
    await this.#resolveLatestSession(bot);
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
      // Capability 47. The turn this message opened (or steered), stamped here because this is the
      // only place that knows it: at commit time the reply can then name the row it answers
      // instead of the reader guessing from adjacency.
      turnId,
      ...(opts?.clientId === undefined ? {} : { clientId: opts.clientId }),
    });
    if (chat.activeTurnId === undefined) {
      this.#storage.setNativeBotTurn(bot, chat.sessionId, turnId, now);
      if (opts?.deviceId !== undefined) this.#turnOrigins.set(this.#nativeTurnKey(bot, chat.sessionId, turnId), opts.deviceId);
      this.#scheduleTurnTimeout(bot, chat.sessionId, turnId);
      this.#seedTurnActivity(bot, chat.sessionId, turnId);
      this.#sweepStaleDelegations(bot, chat.sessionId, turnId);
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
    // An ack means the interrupt reached the plugin, NOT that the turn ended. When the plugin has
    // no live Hermes work to stop, nothing seals; the sweep below reads this together with total
    // silence and terminalizes the turn itself (issue #190).
    this.#interruptAcked.set(
      this.#nativeTurnKey(bot, chat.sessionId, chat.activeTurnId),
      this.#now(),
    );
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
    await this.#resolveLatestSession(bot);
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
        expiresAt: now + ATTACH_MEDIA_TTL_MS,
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
      turnId,
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
      this.#discardLiveTurn(this.#nativeTurnKey(bot, previous.sessionId, previous.activeTurnId));
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
    this.#flushLiveTurn(this.#nativeTurnKey(bot, sessionId, turnId));
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
    this.#turnActivity.delete(this.#nativeTurnKey(bot, sessionId, turnId));
    this.#interruptAcked.delete(this.#nativeTurnKey(bot, sessionId, turnId));
    this.#stopStaleTurnSweepWhenIdle();
    this.#expireTurnInteractions(bot, sessionId, turnId);
    this.#sealTools(
      bot,
      sessionId,
      turnId,
      terminal.status === "completed" ? "ok" : "error",
    );
    this.#sealDelegations(bot, sessionId, turnId, terminal.status === "completed");
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
    this.#thinkingSeq.delete(turnId);
    this.#state(bot, sessionId, terminal.phase, false, terminal);
  }

  /** Capability 31. Turns a device's "I put these on screen" report into durable receipts, and
   * closes the loop for any of them that were a scheduled delivery: the plugin that produced a
   * cron report learns that a human read it, which is the one thing neither its own spool nor the
   * gateway's transcript could tell it. */
  /** Projects one reply of a still-running turn. Everything `#finish` does is deliberately absent:
   * no terminal record, no `#sealTools` (nothing has stopped running), no cleared active turn. The
   * live draft that carried this reply is emptied without `done`, because the reply now exists as a
   * transcript row and the turn is still going. */
  #commitInterim(
    bot: string,
    sessionId: string,
    event: Extract<AttachV1EventFrame["event"], { kind: "commit" }>,
  ): boolean {
    this.#flushLiveTurn(this.#nativeTurnKey(bot, sessionId, event.turnId));
    const committed = this.#commit(
      bot,
      sessionId,
      event.messageId,
      event.blocks,
      event.mediaIds,
      event.mediaPositions,
      event.turnId,
    );
    if (!committed) return false;
    const seq = (this.#draftSeq.get(event.turnId) ?? 0) + 1;
    this.#draftSeq.set(event.turnId, seq);
    this.#broadcast({
      type: "bot_chat_delta",
      bot,
      sessionId,
      turnId: event.turnId,
      text: "",
      seq,
      updatedAt: this.#now(),
    });
    this.#state(bot, sessionId, "polling", true);
    return true;
  }

  #recordDisplayed(
    name: string,
    messageIds: readonly string[],
    deviceId: string,
  ): { recorded: number } {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    const at = this.#now();
    const result = this.#storage.recordBotMessageDisplayed(bot, messageIds, deviceId, at);
    for (const delivery of result.deliveries) {
      this.#ingress.sendDeliveryReceipt(bot, {
        deliveryId: delivery.deliveryId,
        messageId: delivery.messageId,
        state: "displayed",
        at,
      });
    }
    return { recorded: result.recorded };
  }

  /** A scheduled delivery that terminally failed is the one gateway-side event a user can neither
   * see nor infer: nothing arrives, and nothing says why. This appends one quiet marked row to the
   * bot's CURRENT canonical chat, which is where the delivery would have landed had it survived.
   *
   * The row is keyed by delivery id, so a retried failure never duplicates it, and it raises no
   * push: a report that failed to arrive should not wake a phone at 3am to say so. */
  recordScheduledDeliveryFailure(
    bot: string,
    failure: { deliveryId: string; stage: "authorization" | "projection"; reason: string; at: number },
  ): void {
    const key = normalize(bot);
    if (!this.handles(key)) return;
    const chat = this.#storage.nativeBotChat(key, failure.at);
    const message = this.#storage.appendNativeBotMessage({
      bot: key,
      sessionId: chat.sessionId,
      messageId: `delivery-failed:${failure.deliveryId}`,
      role: "system",
      // Capability 47. A gateway-authored row still has an author the reader cares about: the bot
      // whose chat it landed in. It answers no turn, so it names none.
      authorBot: key,
      marker: DELIVERY_FAILED_MARKER,
      text: deliveryFailureText(key, failure.at, failure.reason),
      at: failure.at,
    });
    this.#broadcast({
      type: "bot_chat",
      bot: key,
      sessionId: chat.sessionId,
      messages: [message],
      updatedAt: failure.at,
    });
  }

  /** `seal` runs after the durable message append and before the wire announcement. It is how a
   *  final commit keeps the crash-safe durable order (reply row first, then the terminal seal)
   *  without changing the wire order clients pin (activity, terminal state, then the answer). */
  #commit(
    bot: string,
    sessionId: string,
    messageId: string,
    blocks: readonly RichBlock[],
    mediaIds?: string[],
    mediaPositions?: number[],
    turnId?: string,
    seal?: () => void,
  ): boolean {
    const now = this.#now();
    if (this.#storage.nativeBotMessage(bot, messageId) !== undefined) {
      // Already projected (an at-least-once retry, or a crash after the append): still seal.
      seal?.();
      return true;
    }
    // Positions are all or nothing: a length that does not match the ids is a sender that
    // counted something else, and half a placement is worse than none. The transcript then
    // carries the attachments the way it always has, above the message.
    const positions = mediaPositions?.length === mediaIds?.length ? mediaPositions : undefined;
    const attachments = mediaIds?.flatMap((mediaId, index): BotChatAttachment[] => {
      const info = this.#storage.attachMediaInfo(bot, mediaId, now);
      if (info === undefined) return [];
      const family = info.descriptor.family;
      const position = positions?.[index];
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
          ...(position === undefined ? {} : { position }),
        },
      ];
    });
    const text = blocksToText(blocks);
    // Capability 47. Every id here is one the gateway already held; none is inferred. A commit
    // outside a turn (a scheduled delivery projection) has no turn and answers no user row, so it
    // carries only its author. A STEER shares the running turn's id, so the lookup takes the
    // FIRST user row of the turn: the question the turn answers is the one that opened it, and a
    // mid-turn nudge does not replace it.
    const inReplyToId =
      turnId === undefined ? undefined : this.#storage.nativeBotTurnUserMessageId(bot, sessionId, turnId);
    const message = this.#storage.appendNativeBotMessage({
      bot,
      sessionId,
      messageId,
      role: "assistant",
      text,
      at: now,
      authorBot: bot,
      ...(turnId === undefined ? {} : { turnId }),
      ...(inReplyToId === undefined ? {} : { inReplyToId }),
      ...(attachments === undefined || attachments.length === 0
        ? {}
        : { attachments }),
    });
    // A turn reply that carried media is the only delivery whose lifecycle had no gateway-side
    // name. Record the plugin's own key for it now, while the turn id is still in hand, so the
    // displayed ack that arrives minutes later can close those media rows instead of leaving the
    // agent to say "I cannot confirm CozyChat displayed the attachment" about a picture the
    // owner is already looking at.
    if (turnId !== undefined && attachments !== undefined && attachments.length > 0)
      this.#storage.bindTurnMediaDelivery(bot, messageId, `turn:${turnId}`);
    seal?.();
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
    // Attach-v1 is at-least-once. A retried lifecycle state contains no new user-visible fact,
    // so acknowledge it without rewriting SQLite or rebroadcasting the cumulative tool list.
    if (
      prior !== undefined &&
      prior.name === event.name &&
      prior.status === event.status &&
      prior.detail === event.detail
    ) return true;
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
    this.#coalesceLiveTurn(
      key,
      wire,
      this.#stateFrame(bot, sessionId, "polling", true),
    );
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

  /** EPHEMERAL latest-only reasoning preview (capability 35). Deliberately touches no storage:
   *  thinking is gone on reopen by design, so there is no history field and no restore path.
   *  Post-terminal suppression lives in `handle`: a sealed turn acknowledges the event without
   *  reaching here (thinking has no post-seal carve-out, unlike delegation). */
  #thinking(
    bot: string,
    sessionId: string,
    event: Extract<AttachV1EventFrame["event"], { kind: "thinking" }>,
  ): boolean {
    const last = this.#thinkingSeq.get(event.turnId) ?? 0;
    // Attach-v1 is at-least-once: a replayed or reordered preview is acknowledged without a
    // rebroadcast, so a stale preview can never overwrite a newer one.
    if (event.seq <= last) return true;
    this.#thinkingSeq.set(event.turnId, event.seq);
    const wire: BotThinkingActivityFrame = {
      type: "bot_thinking_activity",
      bot,
      sessionId,
      turnId: event.turnId,
      // The schema already refuses >280; the slice keeps the bound even for a caller that
      // bypassed admission (defense in depth on the one privacy-critical field).
      text: event.text.slice(0, 280),
      seq: event.seq,
      updatedAt: this.#now(),
    };
    this.#coalesceLiveTurn(
      this.#nativeTurnKey(bot, sessionId, event.turnId),
      wire,
      this.#stateFrame(bot, sessionId, "polling", true),
    );
    return true;
  }

  #delegation(
    bot: string,
    sessionId: string,
    event: Extract<AttachV1EventFrame["event"], { kind: "delegation" }>,
    live: boolean,
  ): boolean {
    // Reconstruct the closed public shape even for an internal caller that bypassed
    // attach admission. Hermes schema_errors can contain validation prose and host
    // paths; no sibling of valid/retries is ever retained or projected.
    const incomingSchemaValidation = event.schemaValidation !== undefined &&
      typeof event.schemaValidation.valid === "boolean" &&
      (event.schemaValidation.retries === undefined ||
        (Number.isInteger(event.schemaValidation.retries) &&
          event.schemaValidation.retries >= 0 && event.schemaValidation.retries <= 1))
      ? {
          valid: event.schemaValidation.valid,
          ...(event.schemaValidation.retries === undefined
            ? {}
            : { retries: event.schemaValidation.retries }),
        }
      : undefined;
    const key = this.#nativeTurnKey(bot, sessionId, event.turnId);
    const batches = this.#delegationFrames.get(key) ?? new Map<string, DelegationFrameState>();
    const current = batches.get(event.batchId) ?? {
      seq: 0,
      count: 0,
      children: new Map<string, BotDelegationChild>(),
    };
    const prior = current.children.get(event.childId);
    // The batch-level alias (Hermes's canonical `deleg_...` id) rides child events once the
    // plugin learns it from the parent tool result. Keep-first, and a frame whose only news
    // is the alias must NOT be dropped as a replay: clients need it to reconcile the batch
    // with the async completion row.
    const aliasNew = event.aliasId !== undefined && current.aliasId === undefined;
    if (aliasNew) current.aliasId = event.aliasId;
    // Attach-v1 is at-least-once: a replayed child state is acknowledged without another
    // SQLite write or rebroadcast, exactly as a replayed tool event is.
    if (
      !aliasNew &&
      prior !== undefined &&
      prior.status === event.status &&
      prior.currentTool === event.currentTool &&
      prior.toolCount === event.toolCount &&
      prior.costUsd === event.costUsd &&
      prior.costStatus === event.costStatus &&
      prior.schemaValidation?.valid === incomingSchemaValidation?.valid &&
      prior.schemaValidation?.retries === incomingSchemaValidation?.retries &&
      prior.durationMs === event.durationMs &&
      prior.lastActiveAt === event.lastActiveAt
    ) {
      // Cleo diagnostic: an acknowledged TERMINAL event that produces no broadcast is
      // exactly the shape behind a stuck "working" card -- make it loud in the log.
      if (DELEGATION_SETTLED.has(event.status))
        this.#log(
          `delegation terminal event for "${bot}" acknowledged without broadcast ` +
            `(batch ${event.batchId}, child ${event.childId}: duplicate settled replay)`,
        );
      return true;
    }
    // A live leg replayed AFTER the child settled must not resurrect it. A newly learned
    // alias still lands: persist it and rebroadcast the batch otherwise UNCHANGED.
    if (
      prior !== undefined &&
      DELEGATION_SETTLED.has(prior.status) &&
      !DELEGATION_SETTLED.has(event.status)
    ) {
      if (aliasNew) {
        const stampedAt = this.#now();
        current.seq += 1;
        batches.set(event.batchId, current);
        this.#delegationFrames.set(key, batches);
        this.#storage.upsertBotChatDelegation({
          bot,
          sessionId,
          turnId: event.turnId,
          batchId: event.batchId,
          aliasId: current.aliasId,
          childId: prior.childId,
          index: prior.index,
          count: current.count,
          status: prior.status,
          lastActiveAt: prior.lastActiveAt,
          startedAt: prior.startedAt,
          endedAt: prior.endedAt,
          label: prior.label,
          currentTool: prior.currentTool,
          apiCalls: prior.apiCalls,
          toolCount: prior.toolCount,
          costUsd: prior.costUsd,
          costStatus: prior.costStatus,
          schemaValidation: prior.schemaValidation,
          durationMs: prior.durationMs,
        });
        const aliasWire = this.#delegationWire(
          bot, sessionId, event.turnId, event.batchId, current, stampedAt,
        );
        if (live) {
          this.#coalesceLiveTurn(key, aliasWire, this.#stateFrame(bot, sessionId, "polling", true));
        } else {
          this.#broadcast(aliasWire);
        }
      }
      return true;
    }
    const now = this.#now();
    const label = event.label ?? prior?.label;
    const apiCalls = event.apiCalls ?? prior?.apiCalls;
    const toolCount = event.toolCount ?? prior?.toolCount;
    const costUsd = event.costUsd ?? prior?.costUsd;
    const costStatus = event.costStatus ?? prior?.costStatus;
    const schemaValidation = incomingSchemaValidation ?? prior?.schemaValidation;
    const durationMs = event.durationMs ?? prior?.durationMs;
    const child: BotDelegationChild = {
      childId: event.childId,
      index: prior?.index ?? event.index,
      status: event.status,
      lastActiveAt: event.lastActiveAt,
      startedAt: prior?.startedAt ?? now,
      ...(DELEGATION_SETTLED.has(event.status) ? { endedAt: prior?.endedAt ?? now } : {}),
      ...(label === undefined ? {} : { label }),
      ...(event.currentTool === undefined ? {} : { currentTool: event.currentTool }),
      ...(apiCalls === undefined ? {} : { apiCalls }),
      ...(toolCount === undefined ? {} : { toolCount }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(costStatus === undefined ? {} : { costStatus }),
      ...(schemaValidation === undefined ? {} : { schemaValidation }),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    current.children.set(event.childId, child);
    current.count = Math.max(current.count, event.count, current.children.size);
    current.seq += 1;
    batches.set(event.batchId, current);
    this.#delegationFrames.set(key, batches);
    this.#storage.upsertBotChatDelegation({
      bot,
      sessionId,
      turnId: event.turnId,
      batchId: event.batchId,
      aliasId: current.aliasId,
      childId: child.childId,
      index: child.index,
      count: current.count,
      status: child.status,
      lastActiveAt: child.lastActiveAt,
      startedAt: child.startedAt,
      endedAt: child.endedAt,
      label: child.label,
      currentTool: child.currentTool,
      apiCalls: child.apiCalls,
      toolCount: child.toolCount,
      costUsd: child.costUsd,
      costStatus: child.costStatus,
      schemaValidation: child.schemaValidation,
      durationMs: child.durationMs,
    });
    const wire = this.#delegationWire(bot, sessionId, event.turnId, event.batchId, current, now);
    // Post-seal legs broadcast directly: the sealed turn is not "polling" and has no live batch.
    if (live) {
      this.#coalesceLiveTurn(key, wire, this.#stateFrame(bot, sessionId, "polling", true));
    } else {
      this.#broadcast(wire);
    }
    return true;
  }

  #delegationWire(
    bot: string,
    sessionId: string,
    turnId: string,
    batchId: string,
    state: DelegationFrameState,
    updatedAt: number,
  ): BotDelegationActivityFrame {
    const children = [...state.children.values()].sort((a, b) => a.index - b.index);
    const done =
      children.length >= state.count &&
      children.every((child) => DELEGATION_SETTLED.has(child.status));
    return {
      type: "bot_delegation_activity",
      bot,
      sessionId,
      turnId,
      batchId,
      ...(state.aliasId === undefined ? {} : { aliasId: state.aliasId }),
      count: state.count,
      children,
      seq: state.seq,
      updatedAt,
      ...(done ? { done: true } : {}),
    };
  }

  /** Reconnect recovery for delegation batches, exactly as `#historyToolSteps` is for steps. */
  #historyDelegations(sessionId: string): { delegations?: BotTurnDelegations[] } {
    const batches = new Map<string, BotTurnDelegations>();
    for (const row of this.#storage.botChatDelegations(sessionId, 0)) {
      const groupKey = `${row.turnId}\u0000${row.batchId}`;
      const batch = batches.get(groupKey) ?? {
        turnId: row.turnId,
        batchId: row.batchId,
        count: 0,
        startedAt: row.startedAt,
        children: [],
      };
      if (batch.aliasId === undefined && row.aliasId !== null) batch.aliasId = row.aliasId;
      batch.count = Math.max(batch.count, row.count);
      batch.startedAt = Math.min(batch.startedAt, row.startedAt);
      batch.children.push(this.#delegationChildFromRow(row));
      batches.set(groupKey, batch);
    }
    const delegations = [...batches.values()].map((batch) => {
      batch.children.sort((a, b) => a.index - b.index);
      const endedAt = batch.children.reduce<number | undefined>(
        (latest, child) =>
          child.endedAt === undefined
            ? undefined
            : Math.max(latest ?? child.endedAt, child.endedAt),
        undefined,
      );
      return { ...batch, ...(endedAt === undefined ? {} : { endedAt }) };
    });
    return delegations.length === 0 ? {} : { delegations };
  }

  #delegationChildFromRow(row: {
    childId: string;
    index: number;
    label: string | null;
    status: string;
    currentTool: string | null;
    apiCalls: number | null;
    toolCount: number | null;
    costUsd: number | null;
    costStatus: "estimated" | "reported" | "unknown" | null;
    schemaValid: number | null;
    schemaRetries: number | null;
    durationMs: number | null;
    lastActiveAt: number;
    startedAt: number;
    endedAt: number | null;
  }): BotDelegationChild {
    return {
      childId: row.childId,
      index: row.index,
      status: row.status as BotDelegationChild["status"],
      lastActiveAt: row.lastActiveAt,
      startedAt: row.startedAt,
      ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
      ...(row.label === null ? {} : { label: row.label }),
      ...(row.currentTool === null ? {} : { currentTool: row.currentTool }),
      ...(row.apiCalls === null ? {} : { apiCalls: row.apiCalls }),
      ...(row.toolCount === null ? {} : { toolCount: row.toolCount }),
      ...(row.costUsd === null ? {} : { costUsd: row.costUsd }),
      ...(row.costStatus === null ? {} : { costStatus: row.costStatus }),
      ...(row.schemaValid === null ? {} : {
        schemaValidation: {
          valid: row.schemaValid === 1,
          ...(row.schemaRetries === null ? {} : { retries: row.schemaRetries }),
        },
      }),
      ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
    };
  }

  #restoreDelegationFrames(bot: string): void {
    for (const session of this.#storage.nativeBotSessions(bot, 10_000)) {
      for (const row of this.#storage.botChatDelegations(session.id, 0)) {
        const key = this.#nativeTurnKey(bot, session.id, row.turnId);
        const batches =
          this.#delegationFrames.get(key) ?? new Map<string, DelegationFrameState>();
        const current = batches.get(row.batchId) ?? {
          seq: 0,
          count: 0,
          children: new Map<string, BotDelegationChild>(),
        };
        current.children.set(row.childId, this.#delegationChildFromRow(row));
        current.count = Math.max(current.count, row.count, current.children.size);
        if (current.aliasId === undefined && row.aliasId !== null) current.aliasId = row.aliasId;
        batches.set(row.batchId, current);
        this.#delegationFrames.set(key, batches);
      }
    }
  }

  /** Settles a sealed turn's batches. An interrupted/failed turn takes its live children with
   *  it (`interrupted`): the user said stop and no spinner may remain. A COMPLETED turn keeps
   *  live children live -- an async `delegate_task` batch legitimately outlives its turn, and
   *  its finish legs still project (see the terminal carve-out in `handle`). */
  #sealDelegations(bot: string, sessionId: string, turnId: string, completed: boolean): void {
    if (completed) return;
    const key = this.#nativeTurnKey(bot, sessionId, turnId);
    this.#settleLiveDelegations(bot, sessionId, turnId, key, "interrupted");
  }

  /** A still-live child on any PRIOR turn when a new turn starts is work whose finish leg may
   *  never come (Hermes restarted under it): settle it `unknown`, never `failed`, mirroring the
   *  boot-time reconciliation in storage. */
  #sweepStaleDelegations(bot: string, sessionId: string, activeTurnId: string): void {
    const activeKey = this.#nativeTurnKey(bot, sessionId, activeTurnId);
    const prefix = this.#nativeTurnKey(bot, sessionId, "");
    for (const key of this.#delegationFrames.keys()) {
      if (key === activeKey || !key.startsWith(prefix)) continue;
      this.#settleLiveDelegations(bot, sessionId, key.slice(prefix.length), key, "unknown");
    }
  }

  #settleLiveDelegations(
    bot: string,
    sessionId: string,
    turnId: string,
    key: string,
    settle: "interrupted" | "unknown",
  ): void {
    const batches = this.#delegationFrames.get(key);
    if (batches === undefined) return;
    const now = this.#now();
    for (const [batchId, state] of batches) {
      let changed = false;
      for (const [childId, child] of state.children) {
        if (DELEGATION_SETTLED.has(child.status)) continue;
        const settled: BotDelegationChild = { ...child, status: settle, endedAt: now };
        state.children.set(childId, settled);
        this.#storage.upsertBotChatDelegation({
          bot,
          sessionId,
          turnId,
          batchId,
          aliasId: state.aliasId,
          childId,
          index: settled.index,
          count: state.count,
          status: settled.status,
          lastActiveAt: settled.lastActiveAt,
          startedAt: settled.startedAt,
          endedAt: now,
          label: settled.label,
          currentTool: settled.currentTool,
          apiCalls: settled.apiCalls,
          toolCount: settled.toolCount,
        });
        changed = true;
      }
      if (!changed) continue;
      state.seq += 1;
      this.#broadcast(this.#delegationWire(bot, sessionId, turnId, batchId, state, now));
    }
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

  #seedTurnActivity(bot: string, sessionId: string, turnId: string): void {
    const key = this.#nativeTurnKey(bot, sessionId, turnId);
    if (!this.#turnActivity.has(key)) {
      const delivery = this.#storage.nativeBotTurnDelivery(bot, turnId);
      this.#turnActivity.set(key, delivery?.queuedAt ?? this.#now());
    }
    this.#startStaleTurnSweep();
  }

  /** The sweep runs only while a turn is open, so an idle gateway holds no timer at all. */
  #startStaleTurnSweep(): void {
    if (this.#staleTurnSweep !== undefined) return;
    if (this.#staleTurnSweepMs <= 0) return;
    if (this.#staleTurnInterruptGraceMs <= 0 && this.#staleTurnCeilingMs <= 0) return;
    const timer = setInterval(() => this.#sweepStaleTurns(), this.#staleTurnSweepMs);
    if (typeof timer.unref === "function") timer.unref();
    this.#staleTurnSweep = timer;
  }

  #stopStaleTurnSweepWhenIdle(): void {
    if (this.#staleTurnSweep === undefined || this.#turnActivity.size > 0) return;
    clearInterval(this.#staleTurnSweep);
    this.#staleTurnSweep = undefined;
  }

  /** Seal turns that can no longer seal themselves.
   *
   *  A turn is durable, so a turn nothing will ever terminalize is a phone that shows "thinking"
   *  forever -- across app restarts and container restarts alike, until an operator writes a
   *  terminal row by hand (issue #190). Two readings end one:
   *
   *  - an ACKED interrupt plus silence: the operator asked for a stop, the plugin took the
   *    command, and no terminal followed. That turn is over whether or not anything was running.
   *  - total silence past the hard ceiling: no draft, no tool step, no interim commit, nothing.
   *
   *  Silence is the whole signal, and it is only trustworthy because live work is noisy: a tool
   *  run emits `running`/`ok` steps, a streaming reply emits drafts, and a long agent loop emits
   *  interim commits. A legitimately long run is therefore never stale, and only a turn that has
   *  gone truly dark is reaped. */
  #sweepStaleTurns(): void {
    const now = this.#now();
    const live = new Set<string>();
    for (const bot of this.#native) {
      const chat = this.#storage.nativeBotChat(bot, now);
      const turnId = chat.activeTurnId;
      if (turnId === undefined) continue;
      const key = this.#nativeTurnKey(bot, chat.sessionId, turnId);
      live.add(key);
      this.#seedTurnActivity(bot, chat.sessionId, turnId);
      const silentFor = now - (this.#turnActivity.get(key) ?? now);
      const acked = this.#interruptAcked.get(key);
      if (
        acked !== undefined &&
        this.#staleTurnInterruptGraceMs > 0 &&
        silentFor >= this.#staleTurnInterruptGraceMs &&
        now - acked >= this.#staleTurnInterruptGraceMs
      ) {
        this.#log(
          `reaping interrupted turn ${turnId} for ${bot}: silent for ${silentFor}ms after an acked interrupt`,
        );
        this.#finish(bot, chat.sessionId, turnId, { phase: "failed", status: "interrupted" });
        continue;
      }
      if (this.#staleTurnCeilingMs > 0 && silentFor >= this.#staleTurnCeilingMs) {
        this.#log(
          `reaping silent turn ${turnId} for ${bot}: no events for ${silentFor}ms`,
        );
        this.#finish(bot, chat.sessionId, turnId, { phase: "timeout", status: "timed_out" });
      }
    }
    // A turn can also leave through /new, which discards it without a terminal. Anything no
    // longer the active turn is bookkeeping this sweep should not carry (or watch) any further.
    for (const map of [this.#turnActivity, this.#interruptAcked])
      for (const key of map.keys()) if (!live.has(key)) map.delete(key);
    this.#stopStaleTurnSweepWhenIdle();
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
    this.#flushLiveTurn(this.#nativeTurnKey(bot, sessionId, event.turnId));
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
    ) {
      // Another (session, turn) durably owns this approval id, so no retry can ever apply this
      // frame -- and a decline would dead-letter it and block every later event for the agent
      // behind it (issue #193). A permanently stale frame is acknowledged out loud instead.
      this.#log(`dropping approval event for "${bot}": approval id is bound to another turn`);
      return true;
    }
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
    if (change === "conflict") {
      this.#log(`dropping approval event for "${bot}": approval id is bound to another turn`);
      return true;
    }
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
    this.#flushLiveTurn(this.#nativeTurnKey(bot, sessionId, event.turnId));
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
    ) {
      // Permanently mis-bound (see the approval arm): acknowledge instead of dead-lettering.
      this.#log(`dropping clarify event for "${bot}": clarify id is bound to another turn`);
      return true;
    }
    const options = binding === undefined
      ? event.options
      : (binding.payload as ClarifyPayload).options;
    if (
      outcome === "selected" &&
      event.selectedOptionId !== undefined &&
      !options.some((option) => option.id === event.selectedOptionId)
    ) {
      // The durable option list can never grow this id; no retry can apply the frame.
      this.#log(`dropping clarify event for "${bot}": selected option is not in the durable option list`);
      return true;
    }
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
    if (change === "conflict") {
      this.#log(`dropping clarify event for "${bot}": clarify id is bound to another turn`);
      return true;
    }
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

  /** Progress frames are full replacements: send the leading state immediately, then keep only
   * the latest draft/tool/state for each 100 ms window. Durable event projection is unchanged. */
  #coalesceLiveTurn(key: string, ...frames: LiveTurnFrame[]): void {
    const current = this.#liveTurnBatches.get(key);
    if (current !== undefined) {
      for (const frame of frames) current.frames.set(liveTurnFrameKey(frame), frame);
      return;
    }
    const timer = setTimeout(() => this.#tickLiveTurn(key), LIVE_TURN_FLUSH_MS);
    timer.unref();
    this.#liveTurnBatches.set(key, { timer, frames: new Map() });
    for (const frame of frames) this.#broadcast(frame);
  }

  #flushLiveTurn(key: string): void {
    const batch = this.#liveTurnBatches.get(key);
    if (batch === undefined) return;
    clearTimeout(batch.timer);
    this.#liveTurnBatches.delete(key);
    this.#broadcastLiveFrames(batch.frames);
  }

  #tickLiveTurn(key: string): void {
    const batch = this.#liveTurnBatches.get(key);
    if (batch === undefined) return;
    if (batch.frames.size === 0) {
      this.#liveTurnBatches.delete(key);
      return;
    }
    const frames = new Map(batch.frames);
    batch.frames.clear();
    batch.timer = setTimeout(() => this.#tickLiveTurn(key), LIVE_TURN_FLUSH_MS);
    batch.timer.unref();
    this.#broadcastLiveFrames(frames);
  }

  #broadcastLiveFrames(frames: ReadonlyMap<string, LiveTurnFrame>): void {
    for (const type of ["bot_chat_delta", "bot_tool_activity", "bot_thinking_activity"] as const) {
      const frame = frames.get(type);
      if (frame !== undefined) this.#broadcast(frame);
    }
    // Delegation snapshots coalesce per BATCH (see liveTurnFrameKey): one turn can run several
    // batches, and keeping only the latest frame per type would silently drop a sibling batch's
    // final state.
    for (const [key, frame] of frames) {
      if (key.startsWith("bot_delegation_activity")) this.#broadcast(frame);
    }
    const state = frames.get("bot_chat_state");
    if (state !== undefined) this.#broadcast(state);
  }

  #discardLiveTurn(key: string): void {
    const batch = this.#liveTurnBatches.get(key);
    if (batch === undefined) return;
    clearTimeout(batch.timer);
    this.#liveTurnBatches.delete(key);
  }

  #stateFrame(
    bot: string,
    sessionId: string,
    phase: BotChatStateFrame["phase"],
    running: boolean,
    terminal?: NativeTurnState,
  ): BotChatStateFrame {
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
    return {
      type: "bot_chat_state",
      bot,
      sessionId,
      phase,
      running,
      inflight: running,
      ...(state === undefined ? {} : state),
      updatedAt: this.#now(),
    };
  }

  #state(
    bot: string,
    sessionId: string,
    phase: BotChatStateFrame["phase"],
    running: boolean,
    terminal?: NativeTurnState,
  ): void {
    this.#broadcast(this.#stateFrame(bot, sessionId, phase, running, terminal));
  }
}

/** Capability 31's only marker value. */
export const DELIVERY_FAILED_MARKER = "delivery.failed";

/** One human sentence, in the gateway's own local time, because that is the clock the bot's
 * routines are scheduled against and the one the user set them on. */
export function deliveryFailureText(bot: string, at: number, reason: string): string {
  const name = bot.charAt(0).toUpperCase() + bot.slice(1);
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${name} tried to deliver a scheduled message at ${time} and it could not be delivered: ${reason.slice(0, 256)}.`;
}

/** Stable, bounded native transcript identity for one SessionDB row. The digest makes the three
 * source-qualified components unambiguous even when a Hermes id itself contains a delimiter. */
function desktopSessionMessageId(source: "cozygateway" | "desktop" | "tui" | "cli", hermesSessionId: string, rowId: string): string {
  const digest = createHash("sha256")
    .update(source)
    .update("\0")
    .update(hermesSessionId)
    .update("\0")
    .update(rowId)
    .digest("hex");
  return `desktop:${source}:${digest}`;
}

function desktopActivityStamp(session: BotDesktopHermesSession): number {
  return session.lastActiveAt > 0 ? session.lastActiveAt : session.startedAt;
}

/** Do not trust provider enumeration order. Equal timestamps use the same stable opaque-id tie
 * break on every request, so two clients cannot oscillate the canonical chat. */
function latestDesktopSession(
  sessions: readonly BotDesktopHermesSession[],
): BotDesktopHermesSession | undefined {
  return [...sessions].sort((left, right) =>
    desktopActivityStamp(right) - desktopActivityStamp(left)
    || right.startedAt - left.startedAt
    || left.hermesSessionId.localeCompare(right.hermesSessionId))[0];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

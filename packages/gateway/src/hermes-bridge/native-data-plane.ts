import { createHash, randomUUID } from "node:crypto";

import { ALWAYS_REQUIRE_APPROVAL_CATEGORIES } from "cozygateway-contract";
import type {
  AttachmentBlock,
  BotChatAttachment,
  BotCreateRequest,
  BotCreateResponse,
  BotDeleteResponse,
  BotRuntimeProjection,
  BotRuntimeRecoveryResponse,
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
  BotApprovalRepair,
  BotApprovalGrant,
  BotMobileRequest,
  BotApprovalScope,
  BotRoutine,
  BotModelConfig,
  BotModelConfigPatch,
  RichBlock,
  ServerFrame,
} from "cozygateway-contract";

import type { AttachV1Ingress } from "../adapters/attach/ingress-v1.ts";
import { blocksToText } from "../adapters/attach/blocks-to-text.ts";
import { emitTrace, traceId, type TraceLog } from "../trace.ts";
import { sanitizeApprovalDetail, sanitizeApprovalRepair, sanitizeApprovalScope, type AttachV1EventFrame, type AttachV1MobileRequest } from "../adapters/attach/protocol-v1.ts";
import type { MobileNodeBroker, MobileNodeReceiptInput } from "../mobile-node.ts";
import { BackendUnavailable, UnsupportedForRuntime } from "../errors.ts";
import type { Storage } from "../storage.ts";
import type { GatewayChatConfiguration } from "../chat-configuration.ts";
import { CozyAgentsHarnessModelSettingsAdapter } from "../harness-settings.ts";
import { ATTACH_MEDIA_TTL_MS } from "./photos.ts";
import type {
  BotApprovalDecision,
  BotApprovalDecisionScope,
  BotClarifyResolveOutcome,
  BotApprovalResolveOutcome,
} from "./approvals.ts";
import { ConfigNotNegotiated, type ConfigSurface } from "./bot-config.ts";
import { HistoryNotNegotiated, type HistorySurface } from "./bot-history.ts";
import { RoutineNotFound } from "./routines.ts";
import { BotNameTaken, BotNotFound } from "./crud.ts";
import {
  BotSessionConflict,
  BotSessionNotFound,
  type BotSessionDeletion,
  type BotControlSurface,
  type BotChatFileUpload,
  type BotChatPhotoUpload,
  type BotsSurface,
} from "./bridge.ts";

/** `POST /bots/:name/routines/:id/run`. RUNTIME-BOT ONLY, the same way the bot-history routes are:
 * a Hermes bot has no route here and answers `409 unsupported_for_runtime`, because a Hermes cron
 * job is triggered by the Dashboard's own picker and this gateway has no `cron.manage` action that
 * fires one on demand. The config lane already carries `routines.run` (capability 48's
 * `ConfigSurface`); this surface is only the runtime-bot guard and the "what to answer" wrapper
 * around it, exactly as `historySurface()` wraps `HistorySurface`. */
export interface RunRoutineSurface {
  run(name: string, id: string): Promise<{ routine: BotRoutine; startedAt: number }>;
}

/** What the plane needs from the runtime-bot service. Narrow on purpose: the plane owns chat and
 * roster projection, and knows nothing about tokens, operations, or runners. */
export interface RuntimeBotLifecycle {
  owns(id: string): boolean;
  hasRuntime(id: string): boolean;
  create(input: BotCreateRequest, row: (id: string) => BotSummary): BotCreateResponse;
  delete(name: string, opts: { force?: boolean }): BotDeleteResponse;
  recover(name: string): BotRuntimeRecoveryResponse;
  projection(name: string): BotRuntimeProjection;
}

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
    /** Capability 54. Which paired computer runs this bot. Absent for a config-declared bot and
     * for one created before 54, and never invented for either. */
    runnerId?: string | null;
  }[];
  /** Capability 54. What a recorded runner id is called right now. Resolved per row rather than
   * frozen on it, so a renamed computer renames itself everywhere and a revoked one leaves the id
   * behind with no name to render. */
  runnerName?: (runnerId: string) => string | undefined;
  /** Capability 49. The gateway-owned runtime bot lifecycle. Present when this gateway can create
   * and delete runtime bots itself (`POST /bots {runtime: "cozyagents"}`); absent leaves the
   * capability-45 behavior exactly as it was, where a runtime bot is config-declared and its
   * delete keeps the 409. */
  runtimeLifecycle?: RuntimeBotLifecycle;
  /** The attach-v1 bot-config lane. A runtime bot serves its own profile, model selection and
   * routines over it, so those surfaces route here instead of refusing. Absent means no gateway on
   * this deployment negotiated the lane and every config surface keeps its 409. */
  botConfig?: ConfigSurface;
  /** Session execution context is prepared before the first turn is queued. */
  chatConfiguration?: GatewayChatConfiguration;
  /** Capability 50. The attach-v1 bot-history lane. A runtime bot checkpoints its own workspace
   * and serves the Changes/Undo/Try surface over it. Absent means this deployment serves no
   * history at all and `historySurface()` answers `undefined`, so the routes are never registered
   * and a client probing them sees a `404` rather than a lie. */
  botHistory?: HistorySurface;
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

/** Capability 69. ADR 0004's provisional owner-loss lease, the same 120 seconds a Task gets. It
 *  is the WHOLE silent-reap window for a native turn whose peer is disconnected or has re-attached
 *  without carrying it: the long ceiling below is only trustworthy while the peer is attached and
 *  still says the turn is running. Provisional, and re-evaluated with measured findings. */
const OWNER_LOSS_LEASE_MS = 120_000;

/** Capability 69. The window for a turn whose peer HAS re-attached but could not declare whether
 *  it still holds it, which is every Hermes peer until HF1 ships. It is deliberately far longer
 *  than the disconnected-peer lease: a peer that is attached and quiet may simply be inside one
 *  long prefill-bound model call with no frame to emit, and reaping that would end live work and,
 *  with a steer pending, ask the person again. Any frame at all resets it. Still far short of the
 *  30 minute silence ceiling, and provisional in the same sense the lease is. */
const UNDECLARED_OWNER_GRACE_MS = 600_000;

/** Capability 66. The ceiling on a standing category grant: one day. A person can revoke one at
 *  any moment, and nothing here extends an existing grant. */
const APPROVAL_GRANT_MAX_MS = 24 * 60 * 60 * 1_000;
/** Capability 66. The gateway's own ceiling on a `once` grant, which answers ONE later ask. A once
 *  grant lives until the ask it answered expires or this bound passes, whichever is sooner: the
 *  peer's own `expiresAt` can shorten it and can never extend it. Ten minutes is the same bound the
 *  durable interaction record already falls back to for an approval that names no expiry. */
const APPROVAL_ONCE_GRANT_MAX_MS = 10 * 60 * 1_000;
/** Capability 66. The target system a binding DERIVED from a plain approval is recorded under. A
 *  plain ask names no system, so derived bindings get their own namespace and can never match a
 *  grant a typed peer made against a real system it named. */
const PLAIN_APPROVAL_SYSTEM = "attach";

/** Capability 66, for peers that will never send a scope block. A Hermes-shaped approval carries no
 *  structured arguments on this wire (row 10's ruling: the free-text command and description are
 *  never forwarded), so the only deterministic content it has is the rule NAME plus the
 *  capability-56 `detail` sentence the peer sent to say what the ask concretely covers. Where both
 *  are present and inside the grant row's bounds, they hash into the same payload binding a typed
 *  ask gets, so a person can cover a later IDENTICAL plain ask with an explicit grant.
 *
 *  Where they are not, this returns nothing and the ask is UNCOVERABLE: a rule name alone says what
 *  kind of thing is being asked and never which one, so binding to it would cover asks the person
 *  never saw. Nothing about how a plain approval renders or settles changes either way; a grant can
 *  only exist because a client at 66 asked for one on a card a person read.
 *
 *  The derived scope is internal. It is never emitted on a frame, never stored on the interaction
 *  record, and never sent to a peer: `category` is `other` because a plain ask declares none, which
 *  is exactly why the always-require exclusion cannot bite here, and `retry` is `unknown` because
 *  the peer claimed nothing. Once coverage of a plain ask therefore rests on the person's own
 *  single-use grant, the same task, and the ask's own expiry, not on an idempotency claim. */
function plainApprovalScope(
  payload: ApprovalPayload,
  expiresAt: number | null,
): BotApprovalScope | undefined {
  const detail = payload.detail;
  if (detail === undefined || expiresAt === null) return undefined;
  // The grant row's own bounds. An ask outside them is uncoverable rather than truncated: a
  // truncated binding is a wider binding.
  if (payload.name.length < 1 || payload.name.length > 64 || detail.length > 256) return undefined;
  return {
    kind: "scoped_approval",
    action: payload.name,
    category: "other",
    system: PLAIN_APPROVAL_SYSTEM,
    resource: detail,
    change: detail,
    effects: [],
    reason: "peer_policy",
    payloadHash: createHash("sha256")
      .update(`plain\n${payload.name}\n${detail}`)
      .digest("hex"),
    expiresAt,
    retry: "unknown",
    requested: "once",
  };
}

interface ApprovalPayload {
  name: string;
  /** Capability 51. Present when the interaction was raised by a group-room member turn rather
   *  than a 1:1 chat. The room lives in the payload rather than in a column so a room interaction
   *  IS a 1:1 interaction row: every resolve, expiry and retention path here applies unchanged. */
  room?: { key: string; name: string };
  /** Capability 56. Sanitized, at most 400-character display sentence naming what the approval
   *  concretely covers. Stored on the durable interaction row so a reconnecting app's rebroadcast
   *  carries the same sentence the live frame did. */
  detail?: string;
  /** Capability 62. The validated MCP repair proposal, stored as sent so the live frame, the
   *  rebroadcast on reconnect, and the inbox row all carry the block the peer raised. */
  repair?: BotApprovalRepair;
  /** Capability 66. The validated scoped-approval block, stored as sent for the same reason: it is
   *  what a person reads before deciding, and what a decision's standing grant is bounded by. */
  scope?: BotApprovalScope;
  /** Capability 66. The standing grant that settled this ask without asking. Persisted so the
   *  rebroadcast and the inbox row say why a card the person never tapped is already resolving,
   *  and so a deny on it is read as countermanding the gateway rather than a rival decision. */
  grantId?: string;
}
interface ClarifyPayload {
  prompt: string;
  options: Array<{ id: string; label: string }>;
  /** Capability 51, as on `ApprovalPayload`. */
  room?: { key: string; name: string };
}

/** Capability 51. The room name an interaction payload carries, or nothing for a 1:1 chat. The
 *  payload is stored as opaque JSON, so this reads it defensively rather than casting. */
function payloadRoom(payload: unknown): string | undefined {
  const room = (payload as { room?: { name?: unknown } } | null)?.room;
  return typeof room?.name === "string" ? room.name : undefined;
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
]);

/** The `DASHBOARD_ONLY` methods a runtime bot answers over the attach-v1 config lane, each mapped
 * to the config-surface call that serves it. A method absent from this table keeps its 409.
 *
 * The arguments are re-read positionally from the proxied call rather than spread, because the
 * config surface takes the routine id and the patch as separate parameters exactly as the
 * `BotsSurface` method does; a blind spread would type-check and silently mis-order them. */
const CONFIG_LANE: Record<string, ((surface: ConfigSurface, name: string, args: unknown[]) => Promise<unknown>) | undefined> = {
  botProfile: (surface, name) => surface.botProfile(name),
  configureProfile: (surface, name, args) => surface.configureProfile(name, args[1] as never),
  modelConfig: (surface, name) => surface.modelConfig(name),
  configureModel: (surface, name, args) => surface.configureModel(name, args[1] as never),
  routines: (surface, name) => surface.routines(name),
  createRoutine: (surface, name, args) => surface.createRoutine(name, args[1] as never),
  patchRoutine: (surface, name, args) => surface.patchRoutine(name, args[1] as string, args[2] as never),
  deleteRoutine: (surface, name, args) => surface.deleteRoutine(name, args[1] as string),
};

/** Attach-owned Bot Mode data plane. The returned surface delegates management/control methods to
 * the dashboard bridge but owns every chat method for configured profiles, making it impossible
 * for a native send or settlement to fall through to the Dashboard chat transport. */
export class NativeBotDataPlane {
  readonly #control: BotControlSurface;
  readonly #storage: Storage;
  readonly #ingress: AttachV1Ingress;
  readonly #native: Set<string>;
  readonly #runtimeBots: Map<string, NonNullable<NativeBotDataPlaneOptions["runtimeBots"]>[number]>;
  readonly #runnerName: (runnerId: string) => string | undefined;
  readonly #runtimeLifecycle: RuntimeBotLifecycle | undefined;
  readonly #botConfig: ConfigSurface | undefined;
  readonly #chatConfiguration: GatewayChatConfiguration | undefined;
  readonly #botHistory: HistorySurface | undefined;
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
  /** Capability 69. When the gateway last learned that no peer is carrying this turn: the peer
   *  went absent, or it re-attached without declaring the turn active. Present means the turn is
   *  on the owner-loss lease instead of the long silence ceiling; any frame on the turn, or a
   *  hello that declares it active, is proof of ownership and removes it. */
  readonly #turnOwnerLost = new Map<string, { at: number; kind: "detached" | "undeclared" }>();
  /** Capability 69. The chat context (workspace and model) one open turn was dispatched with, so
   *  a promoted turn runs in the same workspace rather than the peer's default. Process-local and
   *  best effort: the durable copy rides on the pending steer row, which is what survives a
   *  restart. */
  readonly #turnContexts = new Map<string, unknown>();
  #staleTurnSweep: ReturnType<typeof setInterval> | undefined;

  constructor(opts: NativeBotDataPlaneOptions) {
    this.#control = opts.control;
    this.#storage = opts.storage;
    this.#ingress = opts.ingress;
    this.#native = new Set([...opts.nativeBots].map(normalize));
    this.#runnerName = opts.runnerName ?? (() => undefined);
    this.#runtimeBots = new Map(
      (opts.runtimeBots ?? []).map((bot) => [normalize(bot.id), bot]),
    );
    this.#runtimeLifecycle = opts.runtimeLifecycle;
    this.#botConfig = opts.botConfig;
    this.#chatConfiguration = opts.chatConfiguration;
    this.#botHistory = opts.botHistory;
    this.#chatSuggestion = opts.chatSuggestion;
    this.#broadcast = opts.broadcast;
    this.#onChatMessage = opts.onChatMessage;
    this.#onApproval = opts.onApproval;
    this.#now = opts.now ?? Date.now;
    this.#storage.tasks.expireInteractions((bot, kind, id, at) => this.#expireInteraction(bot, kind, id, at));
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
        // Capability 49. A create that names the CozyAgents runtime never reaches Hermes at all:
        // the gateway owns the row, the credential, and the operation a runner reconciles.
        if (input.runtime === "cozyagents") {
          if (this.#runtimeLifecycle === undefined)
            throw new BackendUnavailable("this gateway cannot create runtime bots");
          return this.#runtimeLifecycle.create(input, (id) => {
            const created = this.#runtimeBots.get(normalize(id));
            if (created === undefined) throw new BotNotFound(id);
            return this.#runtimeRow(created);
          });
        }
        return this.#control.createBot(input);
      },
      // Capability 49. A gateway-owned runtime bot is deletable here rather than 409: its identity
      // is revoked, its rows are purged, and the runner is handed a `delete_runtime`. A runtime bot
      // this gateway does NOT own (a config-declared capability-45 one) keeps the refusal, because
      // removing it means editing the config file the operator wrote.
      deleteBot: async (name, opts) => {
        const bot = normalize(name);
        const runtimeBot = this.#runtimeBots.get(bot);
        if (runtimeBot === undefined) return this.#control.deleteBot(name, opts);
        if (this.#runtimeLifecycle?.owns(bot) !== true)
          throw new UnsupportedForRuntime(bot, "deleteBot", runtimeBot.runtime);
        return this.#runtimeLifecycle.delete(bot, opts ?? {});
      },
      botRuntime: (name) => this.#botRuntime(name),
      recoverBotRuntime: (name) => this.#recoverBotRuntime(name),
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
      deleteSession: (name, sessionId) => this.#deleteSession(name, sessionId),
      chatHistory: (name) => this.#history(name),
      sendChatMessage: (name, text, opts) => this.#send(name, text, opts),
      sendChatPhoto: (name, photo, opts) => this.#sendPhoto(name, photo, opts),
      sendChatAttachment: (name, file, opts) => this.#sendFile(name, file, opts),
      stopChat: (name) => this.#stop(name),
      resetChat: (name) => this.#reset(name),
      resolveApproval: (name, toolCallId, decision, deviceId, grantRequest) =>
        this.#resolveApproval(name, toolCallId, decision, deviceId, grantRequest),
      approvalGrants: (name) => this.#approvalGrants(name),
      mobileRequests: (name, sessionId) => this.#mobileRequests(name, sessionId),
      revokeApprovalGrant: (name, grantId) => this.#revokeApprovalGrant(name, grantId),
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
          if ((property === "modelConfig" || property === "configureModel") && name !== undefined && runtimeBot === undefined && this.#botConfig !== undefined
              && this.#ingress.negotiatedCapabilities?.(name)?.has("provider_connections")) {
            if (property === "modelConfig") return this.#hermesModelConfig(name);
            if (property === "configureModel") return this.#configureHermesModel(name, args[1] as BotModelConfigPatch);
          }
          if (name === undefined || runtimeBot === undefined) return bound(...args);
          if (property === "modelProviders" && this.#botConfig !== undefined) {
            return new CozyAgentsHarnessModelSettingsAdapter(
              () => [{ id: name, name: runtimeBot.name }], (bot) => this.#botConfig!.modelConfig(bot),
            ).modelProviders(name);
          }
          // A runtime bot owns its own profile, model selection and routines and serves them over
          // the attach-v1 config lane, so those methods are answered by the peer rather than
          // refused. Everything else in this set has no peer-side equivalent and keeps its 409:
          // deletion is a gateway/Hermes lifecycle act, provider setup is Hermes-owned credential
          // storage, and a desktop transcript is a Hermes Dashboard artifact.
          const routed = CONFIG_LANE[property];
          if (routed !== undefined && this.#botConfig !== undefined) {
            const surface = this.#botConfig;
            // A peer that never negotiated `bot_config` reads exactly like a bot with no lane at
            // all, which is the true answer: the section is absent, not temporarily unreachable.
            return routed(surface, name, args).catch((error: unknown) => {
              throw error instanceof ConfigNotNegotiated
                ? new UnsupportedForRuntime(name, property, runtimeBot.runtime)
                : error;
            });
          }
          return Promise.reject(
            new UnsupportedForRuntime(name, property, runtimeBot.runtime),
          );
        };
      },
    }) as BotsSurface;
  }

  async #hermesModelConfig(name: string): Promise<BotModelConfig> {
    const [builtin, custom] = await Promise.all([this.#control.modelConfig(name), this.#botConfig!.modelConfig(name)]);
    return {
      model: custom.model ?? builtin.model, effort: custom.model ? custom.effort ?? builtin.effort : builtin.effort,
      catalog: [...builtin.catalog, ...custom.catalog.filter((entry) => !builtin.catalog.some((existing) => existing.id === entry.id))],
      efforts: [...new Set([...builtin.efforts, ...custom.efforts])],
      providers: [...builtin.providers ?? [], ...custom.providers ?? []],
    };
  }

  async #configureHermesModel(name: string, patch: BotModelConfigPatch): Promise<BotModelConfig> {
    const current = await this.#botConfig!.modelConfig(name);
    const custom = typeof patch.model === "string" && patch.model.startsWith("custom-")
      || patch.model === undefined && current.model?.startsWith("custom-");
    if (custom) {
      if (patch.model !== undefined) await this.#botConfig!.configureModel(name, { model: patch.model });
      if (patch.effort !== undefined) await this.#control.configureModel(name, { effort: patch.effort });
    }
    else {
      await this.#control.configureModel(name, patch);
      if (patch.model !== undefined) await this.#botConfig!.configureModel(name, { model: null });
    }
    return this.#hermesModelConfig(name);
  }

  #pendingApprovals(): BotPendingApproval[] {
    // A cold restart schedules already-due expiry timers with a zero delay. That is still one
    // event-loop turn too late for a user who opens the inbox or taps a push immediately, so settle
    // those durable rows synchronously before projecting the snapshot.
    this.#expireDueInteractions();
    // Storage also receives the configured set: a durable row from a removed/reconfigured profile
    // is intentionally invisible because its existing action route correctly rejects that bot.
    return this.#storage.pendingNativeApprovals([...this.#native], 100);
  }

  #pendingClarifications(): BotPendingClarification[] {
    this.#expireDueInteractions();
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
    const chat = this.#storage.nativeBotChat(id, this.#now());
    const runnerId = bot.runnerId ?? undefined;
    const runnerName = runnerId === undefined ? undefined : this.#runnerName(runnerId);
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
      active: chat.activeTurnId !== undefined,
      meta: null,
      runtime: bot.runtime,
      ...(runnerId === undefined ? {} : { runnerId }),
      ...(runnerName === undefined ? {} : { runnerName }),
      ...this.#nativeOverlay(id),
    };
  }

  /** Capability 49's read-only projection. A bot with no gateway-owned runtime row has no runtime
   * to project, which is a fact about its kind rather than a missing bot, so it answers the same
   * `409 unsupported_for_runtime` every other Hermes-shaped surface answers for the wrong kind. */
  #botRuntime(name: string): BotRuntimeProjection {
    const bot = normalize(name);
    // Three different answers, and the difference matters to a client: a bot that never had a
    // gateway-owned runtime has none to project (409, the same wrong-kind answer every other
    // Hermes-shaped surface gives), a live one projects, and one whose delete the runner has
    // finished is simply gone (404, from `BotNotFound` below).
    if (this.#runtimeLifecycle?.hasRuntime(bot) !== true)
      throw new UnsupportedForRuntime(bot, "botRuntime", "cozyagents");
    return this.#runtimeLifecycle.projection(bot);
  }

  /** Capability 61's exact-bot retry. A config-declared runtime has no operation row this
   * gateway owns, and a deleted gateway-owned bot must let the service return its ordinary 404;
   * only a live gateway-owned row may reach the recovery mutation. */
  #recoverBotRuntime(name: string): BotRuntimeRecoveryResponse {
    const bot = normalize(name);
    if (this.#runtimeLifecycle === undefined)
      throw new UnsupportedForRuntime(bot, "recoverBotRuntime", "cozyagents");
    if (this.#runtimeLifecycle.owns(bot) || this.#runtimeLifecycle.hasRuntime(bot))
      return this.#runtimeLifecycle.recover(bot);
    if (this.#runtimeBots.has(bot))
      throw new UnsupportedForRuntime(bot, "recoverBotRuntime", "cozyagents");
    throw new BotNotFound(bot);
  }

  /** Capability 50's history surface, with the ONE rule those routes owe a client wrapped around
   * it: history is a runtime-bot fact. A Hermes bot has no checkpointed workspace behind it,
   * because the Dashboard stores no repository and never did, so it gets the same `409
   * unsupported_for_runtime` every other wrong-kind surface answers, never a `404` that would say
   * the bot is gone and never a `503` that would offer a retry.
   *
   * A peer that never negotiated `bot_history` lands on that same 409 by way of
   * `HistoryNotNegotiated`, and for the same reason the config lane does: the section is genuinely
   * absent rather than temporarily unreachable. An offline peer is different and keeps its `503`,
   * because it really will answer once it reconnects.
   *
   * Returns `undefined` when no lane is wired at all, so the caller registers no routes rather
   * than registering five that can only fail. */
  historySurface(): HistorySurface | undefined {
    const lane = this.#botHistory;
    if (lane === undefined) return undefined;
    const guard = <T>(name: string, feature: string, call: (bot: string) => Promise<T>): Promise<T> => {
      const bot = normalize(name);
      const runtimeBot = this.#runtimeBots.get(bot);
      if (runtimeBot === undefined)
        return Promise.reject(new UnsupportedForRuntime(bot, feature, "hermes"));
      return call(bot).catch((error: unknown) => {
        throw error instanceof HistoryNotNegotiated
          ? new UnsupportedForRuntime(bot, feature, runtimeBot.runtime)
          : error;
      });
    };
    return {
      list: (name, query) => guard(name, "botHistory", (bot) => lane.list(bot, query)),
      diff: (name, from, to) => guard(name, "botHistoryDiff", (bot) => lane.diff(bot, from, to)),
      restore: (name, checkpoint) => guard(name, "botHistoryRestore", (bot) => lane.restore(bot, checkpoint)),
      tryStart: (name, label) => guard(name, "botHistoryTry", (bot) => lane.tryStart(bot, label)),
      tryKeep: (name) => guard(name, "botHistoryTry", (bot) => lane.tryKeep(bot)),
      tryDiscard: (name) => guard(name, "botHistoryTry", (bot) => lane.tryDiscard(bot)),
      resolve: (name, choices) => guard(name, "botHistoryResolve", (bot) => lane.resolve(bot, choices)),
    };
  }

  /** `POST /bots/:name/routines/:id/run`'s surface. RUNTIME-BOT ONLY, the same rule
   * `historySurface()` applies: a Hermes bot's cron job is not something this gateway can fire on
   * demand, so it gets the same `409 unsupported_for_runtime` every other wrong-kind surface
   * answers rather than a 404 (the bot is real) or a 503 (nothing here is reachable-but-broken).
   *
   * The config lane's `routines.run` ack carries no routine and no timestamp (it is the same bare
   * `{ok}` `routines.delete` answers), so the response this route publishes is built here: the
   * moment the peer's ack lands is `startedAt`, and the routine is read back with an ordinary
   * `routines.list` so a client gets the row it just triggered rather than an echo of its request.
   * An id the peer's ack accepted but that vanished from the very next list is not expected in
   * practice; the honest answer for it is the same `RoutineNotFound` an unknown id gets, since
   * either way this gateway cannot show a routine under that id any more.
   *
   * Returns `undefined` when no config lane is wired at all, so the route is not registered rather
   * than registered to fail every call. */
  runRoutineSurface(): RunRoutineSurface | undefined {
    const lane = this.#botConfig;
    if (lane === undefined) return undefined;
    return {
      run: async (name, id) => {
        const bot = normalize(name);
        const runtimeBot = this.#runtimeBots.get(bot);
        if (runtimeBot === undefined)
          return Promise.reject(new UnsupportedForRuntime(bot, "routinesRun", "hermes"));
        try {
          await lane.runRoutine(bot, id);
        } catch (error) {
          throw error instanceof ConfigNotNegotiated
            ? new UnsupportedForRuntime(bot, "routinesRun", runtimeBot.runtime)
            : error;
        }
        const startedAt = this.#now();
        const { routines } = await lane.routines(bot);
        const routine = routines.find((candidate) => candidate.id === id);
        if (routine === undefined) throw new RoutineNotFound(id);
        return { routine, startedAt };
      },
    };
  }

  /** Every runtime bot this gateway serves right now, config-declared and gateway-created alike.
   * Live rather than a snapshot: room membership is answered from this set, so a bot created from
   * the app can join a room without a restart. */
  runtimeBotNames(): ReadonlySet<string> {
    return new Set(this.#runtimeBots.keys());
  }

  /** Registers a runtime bot created at runtime, with no restart: the roster row, the native set
   * that decides which bots this plane serves chat for, and the durable canonical chat binding the
   * constructor makes for every configured bot. */
  addRuntimeBot(bot: NonNullable<NativeBotDataPlaneOptions["runtimeBots"]>[number]): void {
    const id = normalize(bot.id);
    this.#runtimeBots.set(id, { ...bot, id });
    this.#native.add(id);
    this.#storage.nativeBotChat(id, this.#now());
  }

  /** The inverse, for a delete. The durable rows are the caller's to purge; this drops only the
   * in-process registration, so nothing keeps answering for a bot that no longer exists. */
  removeRuntimeBot(id: string): void {
    const bot = normalize(id);
    this.#runtimeBots.delete(bot);
    this.#native.delete(bot);
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

  /** Resolve a source Bot Chat/session to its attached peer. Once a session has an execution row,
   * it must be ready on that exact peer; falling back to the source profile would run it in the
   * wrong workspace. Legacy chats with no execution row retain their existing source-peer lane. */
  #executionPeer(bot: string, sessionId: string): string | undefined {
    const execution = this.#storage.chatExecution(bot, sessionId);
    if (execution === undefined) return bot;
    return execution.stage === "ready" ? execution.executionId : undefined;
  }

  /** Translate an authenticated execution peer back to its source bot only for its bound session.
   * Events from a different session are refused before they enter the durable inbox. */
  #eventRoute(agentId: string, frame: AttachV1EventFrame): { bot: string; peer: string } | undefined {
    const direct = normalize(agentId);
    if (this.handles(direct)) {
      // Once a session is assigned to an execution peer, its source profile cannot still write
      // the same transcript merely because it remains attached for other chats and rooms.
      if ("threadId" in frame.event && this.#storage.chatExecution(direct, frame.event.threadId) !== undefined)
        return undefined;
      return { bot: direct, peer: agentId };
    }
    const execution = this.#storage.chatExecutionById(agentId);
    if (execution === undefined || execution.stage !== "ready" || !this.handles(execution.bot)) return undefined;
    if (!("threadId" in frame.event) || frame.event.threadId !== execution.sessionId) return undefined;
    // Desktop adoption and canonical scheduled delivery are profile-owned, never a remote chat
    // execution. Let their original source lane keep handling them.
    if (frame.event.kind === "desktop_session_resumed" || frame.event.kind === "desktop_session_message" || frame.event.kind === "scheduled") return undefined;
    return { bot: execution.bot, peer: agentId };
  }

  canAccept(bot: string, frame: AttachV1EventFrame): boolean {
    const route = this.#eventRoute(bot, frame);
    if (route === undefined) return false;
    const key = route.bot;
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
    const peer = bot;
    let key = normalize(bot);
    if (!this.handles(key)) {
      const execution = this.#storage.chatExecutionById(bot);
      if (execution === undefined || execution.stage !== "ready" || !this.handles(execution.bot)
          || execution.sessionId !== frame.threadId) {
        this.#mobileNode?.reject(peer, frame.requestId);
        return;
      }
      key = execution.bot;
    } else if (this.#storage.chatExecution(key, frame.threadId) !== undefined) {
      this.#mobileNode?.reject(peer, frame.requestId);
      return;
    }
    const privateOrigin = this.#cozyAppOrigins.get(this.#nativeTurnKey(key, frame.threadId, frame.turnId));
    if (privateOrigin !== undefined) {
      if (privateOrigin.expiresAt < this.#now()) {
        this.#cozyAppOrigins.delete(this.#nativeTurnKey(key, frame.threadId, frame.turnId));
        this.#mobileNode?.reject(peer, frame.requestId);
        return;
      }
      const { kind: _kind, ...request } = frame;
      this.#mobileNode?.invoke({ ...request, bot: key, agentId: peer, deviceId: privateOrigin.deviceId });
      return;
    }
    const chat = this.#storage.nativeBotChat(key, this.#now());
    if (chat.sessionId !== frame.threadId || chat.activeTurnId !== frame.turnId) {
      this.#mobileNode?.reject(peer, frame.requestId);
      return;
    }
    // `kind` belongs to the attach envelope, not to the phone frame. Spreading the whole attach
    // frame carried it onto the wire, where the app requires an exact key set and silently drops
    // anything carrying an extra one. Strip it here, at the boundary it stops being meaningful.
    const { kind: _kind, ...request } = frame;
    this.#mobileNode?.invoke({
      ...request, bot: key, agentId: peer, deviceId: this.#turnOrigins.get(this.#nativeTurnKey(key, frame.threadId, frame.turnId)),
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
  /** Capability 51. The two pieces of interaction bookkeeping a GROUP ROOM needs, handed over so a
   *  room reuses them rather than growing a second copy. A room interaction is an ordinary
   *  interaction row, so its expiry deadline belongs on the same timer wheel every other one uses,
   *  and a room turn's settlement expires what it was blocked on by the same rule a chat turn's
   *  does. Structurally typed against `RoomInteractionExpiry` in `group-rooms.ts`; deliberately not
   *  imported from there, so the room module keeps depending on this one and not the reverse. */
  groupInteractions(): {
    schedule: (pending: {
      bot: string; kind: "approval" | "clarify"; interactionId: string; sessionId: string;
      turnId: string; payload: unknown; expiresAt: number | null; updatedAt: number;
    }) => void;
    expireTurn: (bot: string, sessionId: string, turnId: string) => boolean;
  } {
    return {
      schedule: (pending) => this.#scheduleInteractionExpiry(pending),
      expireTurn: (bot, sessionId, turnId) => this.#expireTurnInteractions(bot, sessionId, turnId),
    };
  }

  handleAttachPresence(bot: string, state: "online" | "degraded" | "absent"): void {
    const key = this.#peerBot(bot);
    if (key === undefined) return;
    this.#attachPresence.set(key, state);
    // Capability 69. A peer with no socket is carrying nothing, so every turn it had actually
    // taken goes on the owner-loss lease from this moment. A reconnect that declares the turn
    // active takes it back off the lease; nothing else does.
    if (state === "absent")
      for (const turn of this.#reconcilableTurns(key, bot))
        this.#markOwnerLost(key, turn.sessionId, turn.turnId, "detached");
    const chat = this.#storage.nativeBotChat(key, this.#now());
    if (chat.activeTurnId !== undefined) {
      this.#flushLiveTurn(this.#nativeTurnKey(key, chat.sessionId, chat.activeTurnId));
      this.#state(key, chat.sessionId, "polling", true);
    }
  }

  /** Capability 69. Reconcile this profile's nonterminal native turns the moment its peer
   * re-attaches, which is the earliest instant anyone can know a turn was lost.
   *
   * `activeTurns` is the peer's own declaration. A turn it names is alive and keeps the long
   * window. A turn it does NOT name, when it declared at all, is sealed here rather than after
   * twenty minutes of silence, and any steer still waiting on it is promoted to a new durable
   * turn. A peer that declared nothing cannot be read either way, so its turns go on the
   * undeclared grace: one frame from the peer is enough to keep the turn, and no frame at all
   * ends it.
   *
   * ONLY TURNS THE PEER ACTUALLY TOOK are reconciled. A command still in the durable outbox is
   * one the peer has never seen, so its absence from a declaration says nothing; the gateway
   * accepts turns for a sleeping bot precisely so they run when it wakes, and sealing one here
   * would fail a message that is about to be delivered. `#reconcilableTurns` is that filter, and
   * the ingress calls this AFTER flushing the outbox so the ordering is unambiguous. */
  handleAttachHello(peer: string, activeTurns?: readonly string[]): void {
    const bot = this.#peerBot(peer);
    if (bot === undefined) return;
    const declared = activeTurns === undefined ? undefined : new Set(activeTurns);
    for (const turn of this.#reconcilableTurns(bot, peer)) {
      const key = this.#nativeTurnKey(bot, turn.sessionId, turn.turnId);
      if (declared === undefined) {
        this.#markOwnerLost(bot, turn.sessionId, turn.turnId, "undeclared");
        continue;
      }
      if (declared.has(turn.turnId)) {
        // The peer still carries it. Never sealed by reconciliation, and back on the long window.
        this.#turnOwnerLost.delete(key);
        this.#turnActivity.set(key, this.#now());
        continue;
      }
      this.#log(
        `sealing stale turn ${turn.turnId} for ${bot}: the re-attached peer does not carry it`,
      );
      this.#sealOwnerLoss(bot, turn.sessionId, turn.turnId);
    }
  }

  /** The turns one attach identity can speak for: the sessions it actually runs, and among those
   * only the turns whose command it has already taken off the wire. */
  #reconcilableTurns(bot: string, peer: string): { sessionId: string; turnId: string }[] {
    const identity = normalize(peer);
    return this.#storage.nativeBotActiveTurns(bot).filter((turn) => {
      // One profile can be served by several attach identities: a chat execution runs its own
      // session on its own peer. A peer only ever speaks for the sessions it runs, so a hello
      // from the profile can never seal a turn a chat execution is carrying, or the reverse.
      const owner = this.#executionPeer(bot, turn.sessionId);
      if (owner === undefined || normalize(owner) !== identity) return false;
      return this.#storage.nativeBotTurnDelivery(owner, turn.turnId)?.acknowledgedAt != null;
    });
  }

  /** The profile behind an attach identity, which is either the profile itself or a chat
   * execution bound to one. `undefined` for an identity this plane does not serve. */
  #peerBot(peer: string): string | undefined {
    const execution = this.#storage.chatExecutionById(peer);
    const bot = execution?.stage === "ready" ? execution.bot : normalize(peer);
    return this.handles(bot) ? bot : undefined;
  }

  #markOwnerLost(bot: string, sessionId: string, turnId: string, kind: "detached" | "undeclared"): void {
    const key = this.#nativeTurnKey(bot, sessionId, turnId);
    this.#turnOwnerLost.set(key, { at: this.#now(), kind });
    this.#seedTurnActivity(bot, sessionId, turnId);
  }

  /** Capability 69. End one turn nobody owns, and rescue what the person said on it. The seal is
   * the ORDINARY terminal path, so the app learns about it through the same turn transition every
   * other ending uses; only the reason in the log and the promotion that follows are new. */
  #sealOwnerLoss(bot: string, sessionId: string, turnId: string): void {
    this.#finish(bot, sessionId, turnId, { phase: "failed", status: "failed" });
    this.#promoteSteer(bot, sessionId, turnId);
  }

  /** Capability 69. The steers left unanswered on a turn that turned out to be dead. The oldest
   * becomes a NEW durable turn carrying the same text, media and chat context: the app sees an
   * ordinary new turn, and the user row that was committed against the dead turn moves onto the
   * live one so the reply answers the question that was actually asked. The steers that followed
   * it are re-dispatched onto that new turn, in the order the person sent them.
   *
   * NOTHING IS EVER DROPPED HERE. Every path that does not dispatch a person's words records a
   * visible failed delivery preserving them, and each steer is settled exactly once, so a steer
   * that was rescued or answered can never also be promoted. */
  #promoteSteer(bot: string, sessionId: string, deadTurnId: string): void {
    const pending = this.#storage.pendingNativeSteers(bot, sessionId, deadTurnId);
    if (pending.length === 0) return;
    const now = this.#now();
    const chat = this.#storage.nativeBotChat(bot, now);
    const peer = chat.sessionId === sessionId && chat.activeTurnId === undefined
      ? this.#executionPeer(bot, sessionId)
      : undefined;
    if (peer === undefined) {
      // No peer, or this conversation moved on (another turn is already running, or `/new`
      // selected a different session). These words were never delivered to anything, so they are
      // preserved on the conversation rather than quietly forgotten.
      for (const steer of pending) this.#failSteerDelivery(bot, sessionId, steer, now);
      return;
    }
    const [first, ...rest] = pending;
    if (first === undefined) return;
    const turnId = randomUUID();
    this.#cancelUndeliveredSteer(peer, first.messageId, now);
    const accepted = this.#ingress.sendNativeTurn(peer, {
      threadId: sessionId,
      turnId,
      messageId: first.messageId,
      text: first.text,
      ...(first.mediaIds === undefined || first.mediaIds.length === 0 ? {} : { mediaIds: first.mediaIds }),
      ...(first.context === undefined ? {} : { chatContext: first.context }),
    } as never);
    if (!accepted) {
      for (const steer of pending) this.#failSteerDelivery(bot, sessionId, steer, now);
      return;
    }
    this.#log(`promoted an unanswered steer on ${deadTurnId} for ${bot} to durable turn ${turnId}`);
    this.#storage.settlePendingNativeSteer(bot, first.messageId, now);
    this.#storage.rebindNativeBotMessageTurn(bot, sessionId, first.messageId, turnId);
    this.#storage.setNativeBotTurn(bot, sessionId, turnId, now);
    if (first.context !== undefined)
      this.#turnContexts.set(this.#nativeTurnKey(bot, sessionId, turnId), first.context);
    // The push suppression the original send earned belongs to the promoted turn too: the same
    // person on the same device is still waiting for this answer.
    if (first.originDevice !== undefined)
      this.#turnOrigins.set(this.#nativeTurnKey(bot, sessionId, turnId), first.originDevice);
    if (this.#chatConfiguration !== undefined) {
      try { this.#chatConfiguration.recordAcceptedTurn(bot, sessionId); } catch { /* the chat moved on; the turn is still dispatched */ }
    }
    this.#scheduleTurnTimeout(bot, sessionId, turnId);
    this.#seedTurnActivity(bot, sessionId, turnId);
    this.#sweepStaleDelegations(bot, sessionId, turnId);
    // The rebind changed a row a live client is already showing, so say so rather than leaving it
    // pinned to a dead turn id until the next history fetch.
    const rebound = this.#storage.nativeBotMessage(bot, first.messageId);
    if (rebound !== undefined) this.#broadcastMessage(bot, sessionId, rebound, now);
    this.#state(bot, sessionId, "polling", true);
    for (const steer of rest) {
      this.#cancelUndeliveredSteer(peer, steer.messageId, now);
      if (this.#ingress.sendNativeSteer(peer, {
        threadId: sessionId, turnId, messageId: steer.messageId, text: steer.text,
      })) {
        this.#storage.movePendingNativeSteer(bot, steer.messageId, turnId);
        this.#storage.rebindNativeBotMessageTurn(bot, sessionId, steer.messageId, turnId);
      } else {
        this.#failSteerDelivery(bot, sessionId, steer, now);
      }
    }
  }

  /** A steer command the peer never took off the wire must not arrive after the turn that
   * replaced it, or the person is asked twice. An already acknowledged command is left alone: the
   * peer has it, and cancelling it would claim something untrue. */
  #cancelUndeliveredSteer(peer: string, messageId: string, now: number): void {
    const delivery = this.#storage.attachSteerDelivery(peer, messageId);
    if (delivery === undefined || delivery.acknowledgedAt !== null) return;
    this.#storage.cancelAttachCommand(peer, delivery.sequence, delivery.commandId, "steer promoted to a durable turn", now);
  }

  /** Settle one steer that could not be delivered, and leave the person's words on the record. */
  #failSteerDelivery(
    bot: string,
    sessionId: string,
    steer: { messageId: string; text: string },
    now: number,
  ): void {
    this.#storage.settlePendingNativeSteer(bot, steer.messageId, now);
    this.#recordFailedSteerDelivery(bot, sessionId, steer);
  }

  /** The last resort under "nothing a person said or a bot said disappears": one visible marked
   * row on the conversation carrying the text that could not be delivered. */
  #recordFailedSteerDelivery(
    bot: string,
    sessionId: string,
    pending: { messageId: string; text: string },
  ): void {
    const at = this.#now();
    const message = this.#storage.appendNativeBotMessage({
      bot,
      sessionId,
      messageId: `steer-undelivered:${pending.messageId}`,
      role: "system",
      authorBot: bot,
      marker: DELIVERY_FAILED_MARKER,
      text: `This message could not be delivered and was not answered: ${pending.text.slice(0, 2048)}`,
      at,
    });
    this.#broadcast({ type: "bot_chat", bot, sessionId, messages: [message], updatedAt: at });
  }

  taskTurnQueued(peer: string, command: { threadId: string; turnId: string }): void {
    const bot = this.#storage.chatExecutionById(peer)?.bot ?? normalize(peer);
    if (!this.handles(bot) || !this.#storage.nativeBotHasSession(bot, command.threadId)) return;
    this.#scheduleTurnTimeout(bot, command.threadId, command.turnId);
    this.#seedTurnActivity(bot, command.threadId, command.turnId);
    this.#state(bot, command.threadId, "polling", true);
  }

  close(): void {
    if (this.#staleTurnSweep !== undefined) clearInterval(this.#staleTurnSweep);
    this.#staleTurnSweep = undefined;
    this.#turnActivity.clear();
    this.#interruptAcked.clear();
    this.#turnOwnerLost.clear();
    this.#turnContexts.clear();
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
    const route = this.#eventRoute(bot, frame);
    if (route === undefined) return false;
    const key = route.bot;
    const peer = route.peer;
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
      const command = this.#storage.attachTurnCommand(peer, event.turnId);
      const terminal = this.#storage.nativeBotTurnTerminal(key, sessionId, event.turnId);
      if (terminal !== undefined) {
        // A delegation batch legitimately outlives its turn (async delegate_task): a child's
        // finish leg lands after the seal and must still settle its card. Ephemeral, so the
        // at-least-once replay of an already-settled state is acknowledged inside #delegation.
        if (event.kind === "delegation")
          return this.#delegation(key, sessionId, event, false);
        const delivery = this.#storage.nativeBotTurnDelivery(peer, event.turnId);
        // Reply delivery survives gateway deadlines and journal-before-apply crashes. The first
        // terminal remains authoritative: a late answer cannot rewrite Run or Task outcome.
        // Explicit user cancellation suppresses late delivery as before.
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
          if (committed && event.continues !== true) {
            const cleared = this.#storage.clearNativeBotTurn(key, sessionId, event.turnId, this.#now());
            if (cleared) this.#state(key, sessionId, terminal.status === "completed" ? "complete" : "failed", false, terminal);
          }
          return committed;
        }
        return true;
      }
      if (command === undefined || command.threadId !== sessionId) {
        // Capability 69. A commit carrying words is the bot ANSWERING A PERSON, and the turn id it
        // arrived on is bookkeeping. A restarted peer that read a steer as a fresh inbound message
        // replies on a turn id this gateway never issued, and declining it here is how a reply
        // vanished in the live incident. Project it as an ordinary reply bound to no turn, exactly
        // as a scheduled delivery is: nothing a bot said is discarded for want of a turn command.
        if (command === undefined && event.kind === "commit"
          && (blocksToText(event.blocks).trim().length > 0 || (event.mediaIds?.length ?? 0) > 0)) {
          this.#log(
            `native commit for "${key}" on unknown turn ${event.turnId} projected as an untethered reply`,
          );
          const rescued = this.#commit(
            key, sessionId, event.messageId, event.blocks, event.mediaIds, event.mediaPositions,
          );
          // The peer heard the person and answered, on whatever turn id it invented. Every steer
          // still open on this conversation is therefore accounted for, and promoting one now
          // would ask the same question a second time and pay for a second answer.
          if (rescued) this.#storage.settlePendingNativeSteers(key, sessionId, undefined, this.#now());
          return rescued;
        }
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
      // Capability 69. The same proof answers the owner question: a peer that is emitting frames
      // for this turn is carrying it, whatever a hello or a dropped socket suggested. The one
      // exception is the typed unknown-turn failure, which is the peer saying the opposite, so it
      // must not clear the steer it is about to have promoted.
      if (!(event.kind === "failed" && event.reason === "unknown_turn")) {
        this.#turnOwnerLost.delete(this.#nativeTurnKey(key, sessionId, event.turnId));
        this.#storage.settlePendingNativeSteers(key, sessionId, event.turnId, this.#now());
      }
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
    if (event.kind === "failed" && event.reason === "unknown_turn") {
      // Capability 69. The peer holds no such turn, so this is owner loss reported rather than
      // inferred: seal it now and promote whatever the person said on it.
      this.#log(`sealing turn ${event.turnId} for ${key}: the peer reports it as an unknown turn`);
      this.#sealOwnerLoss(key, sessionId, event.turnId);
      return true;
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
        // Only publish a known, safe cause. Runtime diagnostics may contain private paths or
        // provider details. Match the known runtime message without forwarding raw diagnostics.
        ...(event.kind === "failed" && (
          event.message === "No verifier is configured for this workspace; the last verification attempt reported not_configured."
        ) ? { cause: "verification_unavailable" as const } : {}),
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

  /** Capability 60's only native direct-session deletion authority. Group/member threads never
   * exist in `bot_native_sessions`; a selected or running direct chat is refused before any
   * transcript row changes. */
  async #deleteSession(name: string, sessionId: string): Promise<BotSessionDeletion> {
    const bot = normalize(name);
    if (!this.#native.has(bot)) throw new BotSessionNotFound(name);
    // A deletion is only committed with its receiver tombstone. The negotiated capability is
    // durable across an attach outage, but an unverified or older runtime must not lose a
    // conversation it cannot be told to forget.
    const peer = this.#executionPeer(bot, sessionId);
    if (peer === undefined || !this.#ingress.canSendSessionDeletion(peer))
      throw new BackendUnavailable("cannot delete a conversation until the attached runtime has negotiated capability 60");
    const now = this.#now();
    const deleted = this.#storage.deleteNativeBotSession({
      bot, sessionId, deletedAt: now,
      enqueue: true, outboxAgentId: peer,
    });
    if (deleted.outcome === "not_found") throw new BotSessionNotFound(sessionId);
    if (deleted.outcome === "foreign") throw new BotSessionConflict(sessionId, "another bot");
    if (deleted.outcome === "current") throw new BackendUnavailable("cannot delete the active conversation; select another session first");
    if (deleted.outcome === "active") throw new BackendUnavailable("cannot delete a conversation with a running turn");
    if (deleted.outcome !== "deleted") throw new BotSessionNotFound(sessionId);
    this.#ingress.flushQueuedCommands(peer);
    return { name: bot, sessionId, deletedAt: deleted.deletedAt };
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
    // Context preparation may await the runtime. It rechecks the stored selection before it
    // returns, so no selection changed while preparing can be admitted with an older carrier.
    const chatContext = chat.activeTurnId === undefined && this.#chatConfiguration !== undefined
      ? (await this.#chatConfiguration.prepareContext(bot, chat.sessionId)).configuration
      : undefined;
    const currentChat = this.#storage.nativeBotChat(bot, this.#now());
    if (currentChat.sessionId !== chat.sessionId || currentChat.activeTurnId !== chat.activeTurnId)
      throw new BackendUnavailable("This chat changed while its workspace was starting. Try sending again.");
    const peer = this.#executionPeer(bot, chat.sessionId);
    if (peer === undefined)
      throw new BackendUnavailable(`chat execution for "${bot}" is not ready`);
    const accepted = chat.activeTurnId === undefined
      ? this.#ingress.sendNativeTurn(peer, {
          threadId: chat.sessionId,
          turnId,
          messageId,
          text,
          ...(chatContext?.workspace == null && chatContext?.model == null ? {} : { chatContext }),
        })
      : this.#ingress.sendNativeSteer(peer, {
          threadId: chat.sessionId,
          turnId,
          messageId,
          text,
        });
    if (!accepted)
      throw new BackendUnavailable(`native attach-v1 profile "${bot}" is unavailable`);
    if (chat.activeTurnId === undefined && this.#chatConfiguration !== undefined)
      this.#chatConfiguration.recordAcceptedTurn(bot, chat.sessionId);
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
      if (chatContext !== undefined)
        this.#turnContexts.set(this.#nativeTurnKey(bot, chat.sessionId, turnId), chatContext);
    } else {
      // Capability 69. A steer is the one send with no turn of its own to fall back on: if the
      // peer never had this turn, nothing else would ever answer these words. Record them
      // DURABLY, so a gateway restart between the steer and the seal cannot drop what a person
      // said, and settle the record when something proves the words were heard.
      const context = this.#turnContexts.get(this.#nativeTurnKey(bot, chat.sessionId, turnId));
      this.#storage.recordPendingNativeSteer({
        bot, sessionId: chat.sessionId, turnId, messageId, text, at: now,
        ...(context === undefined ? {} : { context }),
        ...(opts?.deviceId === undefined ? {} : { originDevice: opts.deviceId }),
      });
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
    const peer = this.#executionPeer(bot, chat.sessionId);
    if (peer === undefined || !this.#ingress.sendNativeInterrupt(peer, {
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
    const chatContext = this.#chatConfiguration === undefined
      ? undefined
      : (await this.#chatConfiguration.prepareContext(bot, chat.sessionId)).configuration;
    const currentChat = this.#storage.nativeBotChat(bot, this.#now());
    if (currentChat.sessionId !== chat.sessionId || currentChat.activeTurnId !== chat.activeTurnId)
      throw new BackendUnavailable("This chat changed while its workspace was starting. Try sending again.");
    const peer = this.#executionPeer(bot, chat.sessionId);
    if (peer === undefined)
      throw new BackendUnavailable(`chat execution for "${bot}" is not ready`);
    // Persist before the socket can carry the command into another process. If enqueue rejects,
    // remove this exact unreferenced row so failure stays atomic from the app's point of view.
    this.#storage.saveAttachMedia(
      peer,
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
    if (!this.#ingress.sendNativeTurn(peer, {
      threadId: chat.sessionId,
      turnId,
      messageId,
      text: input.text,
      mediaIds: [mediaId],
      ...(chatContext?.workspace == null && chatContext?.model == null ? {} : { chatContext }),
    })) {
      this.#storage.deleteAttachMedia(peer, mediaId);
      throw new BackendUnavailable(`native attach-v1 profile "${bot}" is unavailable`);
    }
    if (this.#chatConfiguration !== undefined)
      this.#chatConfiguration.recordAcceptedTurn(bot, chat.sessionId);
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
      const peer = this.#executionPeer(bot, previous.sessionId);
      if (peer !== undefined) this.#ingress.sendNativeInterrupt(peer, {
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

  /** Capability 66. Does a standing grant already cover this exact proposal, and if it is a
   *  single-use one, spend it? An always-require category is never consulted at all, and a `once`
   *  grant is consulted only when the peer called the retry idempotent: a mutation is never
   *  automatically replayed, and never more than once even then. */
  #claimGrant(
    bot: string,
    sessionId: string,
    turnId: string,
    scope: BotApprovalScope,
    /** True for a binding DERIVED from a plain approval, which carries no idempotency claim to
     *  read. Its single-use grant, its task and the ask's own expiry are the bound instead. */
    derived = false,
  ): string | undefined {
    if (ALWAYS_REQUIRE_APPROVAL_CATEGORIES.includes(scope.category)) return undefined;
    const now = this.#now();
    // The ask's own expiration bounds the consult too: a stale proposal is never covered, however
    // long the grant behind it still had to run.
    if (scope.expiresAt <= now) return undefined;
    return this.#storage.claimApprovalGrant({
      bot,
      sessionId,
      turnId,
      action: scope.action,
      category: scope.category,
      system: scope.system,
      resource: scope.resource,
      payloadHash: scope.payloadHash,
      allowOnce: derived || scope.retry === "idempotent",
      // A category grant needs a DECLARED category. A derived binding has none, so only the
      // person's own single-use grant can answer for a plain ask.
      allowCategory: !derived,
      now,
    });
  }

  /** Capability 66. Settle a covered approval through the ordinary relay: the gateway sends the
   *  same `resolve_approval` a tapped card sends, and the peer is the one that acts. The bounded
   *  log line carries ids and the grant, never a payload value. */
  #honorApprovalGrant(
    bot: string,
    sessionId: string,
    turnId: string,
    approvalId: string,
    grantId: string,
  ): void {
    const peer = this.#executionPeer(bot, sessionId);
    if (peer === undefined) return;
    const requested = this.#ingress.requestNativeApprovalResolution(peer, {
      threadId: sessionId,
      turnId,
      approvalId,
      decision: "approve",
    }, bot);
    if (requested.outcome !== "requested") return;
    this.#emitApprovalResolutionRequested(bot, sessionId, turnId, approvalId);
    emitTrace(this.#trace, "approval_grant_honored", {
      profile: traceId(bot), session: traceId(sessionId), approval: traceId(approvalId),
      grant: traceId(grantId),
    });
  }

  #approvalGrants(name: string): BotApprovalGrant[] {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return [];
    return this.#storage.approvalGrants(bot, this.#now());
  }

  /** Capability 68. Scoped to the profile and the conversation: a request another conversation
   *  opened is absent here, so a wrong-conversation read answers nothing rather than leaking one. */
  #mobileRequests(name: string, sessionId: string): BotMobileRequest[] {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return [];
    return this.#storage.nativeBotMobileRequests(bot, sessionId);
  }

  #revokeApprovalGrant(name: string, grantId: string): "revoked" | "unknown" {
    const bot = normalize(name);
    if (!this.#native.has(bot)) return "unknown";
    return this.#storage.revokeApprovalGrant(bot, grantId, this.#now()) ? "revoked" : "unknown";
  }

  async #resolveApproval(
    name: string,
    approvalId: string,
    decision: BotApprovalDecision,
    deviceId: string,
    grantRequest?: BotApprovalDecisionScope,
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
    // Capability 66. The scope block is what a grant is bounded by, so a decision that asks for a
    // category grant is refused before anything is relayed when there is nothing to bound it by,
    // or when the category is one no grant may ever cover. The person can still decide this one
    // invocation: they resend without asking for a grant.
    const payload = binding.payload as ApprovalPayload;
    // Capability 66. A plain ask can be bound too, where it carries deterministic content. Where it
    // does not, `scope` stays undefined and asking for a grant is refused with `scope_required`,
    // which is what "there is nothing here to bound a grant by" already means.
    const scope = payload.scope ?? plainApprovalScope(payload, binding.expiresAt);
    const derived = payload.scope === undefined;
    if (grantRequest?.grant === "category") {
      if (scope === undefined || grantRequest.expiresAt === undefined) return "scope_required";
      // A category is something a peer DECLARES. A plain ask declares none, and the gateway cannot
      // classify one, so a standing category policy over it would silently pre-approve a
      // destructive or publishing action nobody categorized. One ask at a time is the only offer.
      if (derived) return "category_undeclared";
      if (ALWAYS_REQUIRE_APPROVAL_CATEGORIES.includes(scope.category)) return "category_forbidden";
      const now = this.#now();
      // A standing grant is bounded in time by construction: a dead or unbounded expiry is refused
      // here rather than stored and consulted later.
      if (grantRequest.expiresAt <= now || grantRequest.expiresAt > now + APPROVAL_GRANT_MAX_MS)
        return "invalid_grant";
    }
    const peer = this.#executionPeer(bot, binding.sessionId);
    if (peer === undefined) return "unsupported";
    // Capability 66. A deny on an ask the GATEWAY settled from a standing grant is the person
    // countermanding their own policy, not a rival decision, so it replaces the requested marker
    // instead of colliding with it. Only that case: a decision the gateway did not make still
    // conflicts exactly as it did before this row.
    const settledByGrant = payload.grantId;
    const override = decision === "deny" && settledByGrant !== undefined
      && binding.requestedDecision === "approve";
    const requested = this.#ingress.requestNativeApprovalResolution(peer, {
      threadId: binding.sessionId,
      turnId: binding.turnId,
      approvalId,
      decision,
    }, bot, override ? { override: true } : undefined);
    if (requested.outcome === "expired") {
      // Capability 51: a room interaction's session is a member thread, never a chat session.
      const room = payloadRoom(binding.payload);
      this.#clearInteractionTimer("approval", bot, approvalId);
      this.#emitApprovalResolved(bot, requested.sessionId, requested.turnId, approvalId, "expired", room);
      if (room === undefined) this.#state(bot, requested.sessionId, "polling", true);
      return "expired";
    }
    if (requested.outcome === "requested" || requested.outcome === "already_requested") {
      if (requested.outcome === "requested")
        this.#emitApprovalResolutionRequested(bot, binding.sessionId, binding.turnId, approvalId);
      // Capability 66. The standing approval this decision leaves behind. It exists ONLY because a
      // person explicitly asked for one: a plain approve is one decision on one ask and leaves no
      // policy at all, which is what a client below 66, and a person simply tapping Approve, send.
      if (grantRequest?.grant === undefined || decision !== "approve") return "requested";
      if (scope === undefined) return "scope_required";
      if (ALWAYS_REQUIRE_APPROVAL_CATEGORIES.includes(scope.category)) return "category_forbidden";
      if (derived && grantRequest.grant === "category") return "category_undeclared";
      const category = grantRequest.grant === "category";
      const now = this.#now();
      const recorded = this.#storage.recordApprovalGrant({
        bot,
        grantId: `grant:${bot}:${approvalId}`,
        scope: category ? "category" : "once",
        deviceId,
        sessionId: binding.sessionId,
        turnId: category ? null : binding.turnId,
        approvalId,
        action: scope.action,
        category: scope.category,
        system: scope.system,
        resource: scope.resource,
        payloadHash: category ? null : scope.payloadHash,
        // A category grant runs to the bound the person set. A once grant dies with the ask it
        // answered or at the gateway's own ceiling, whichever comes first, so the value the peer
        // chose can only ever shorten it.
        expiresAt: category
          ? grantRequest.expiresAt!
          : Math.min(scope.expiresAt, now + APPROVAL_ONCE_GRANT_MAX_MS),
        createdAt: now,
      });
      // A decision carries at most one standing grant. A second one asking for a different policy
      // is told nothing was created rather than answered success for a policy change that did not
      // happen.
      return recorded ? "requested" : "grant_not_recorded";
    }
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
    const peer = this.#executionPeer(bot, binding.sessionId);
    if (peer === undefined) return "unsupported";
    const requested = this.#ingress.requestNativeClarifyResolution(peer, {
      threadId: binding.sessionId,
      turnId: binding.turnId,
      clarifyId,
      optionId,
    }, bot);
    if (requested.outcome === "expired") {
      const room = payloadRoom(binding.payload);
      this.#clearInteractionTimer("clarify", bot, clarifyId);
      this.#broadcast({
        type: "bot_clarify_resolved",
        bot,
        sessionId: requested.sessionId,
        turnId: requested.turnId,
        clarifyId,
        outcome: "expired",
        updatedAt: this.#now(),
        ...(room === undefined ? {} : { room }),
      });
      if (room === undefined) this.#state(bot, requested.sessionId, "polling", true);
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
      ...((terminal.cause === "cancelled" || terminal.cause === "verification_unavailable")
        ? { cause: terminal.cause } : {}),
      completedAt: this.#now(),
    });
    emitTrace(this.#trace, "native_turn_transition", {
      profile: traceId(bot), session: traceId(sessionId), turn: traceId(turnId),
      status: terminal.status, reason: terminal.cause ?? terminal.phase,
    });
    this.#tracedTurnStates.delete(this.#nativeTurnKey(bot, sessionId, turnId));
    this.#turnActivity.delete(this.#nativeTurnKey(bot, sessionId, turnId));
    this.#interruptAcked.delete(this.#nativeTurnKey(bot, sessionId, turnId));
    this.#turnOwnerLost.delete(this.#nativeTurnKey(bot, sessionId, turnId));
    this.#turnContexts.delete(this.#nativeTurnKey(bot, sessionId, turnId));
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
    // Capability 65. A peer below 65 declares no Artifact, so the gateway derives one minimal
    // record per delivered attachment here, at the moment the bytes were committed to a person.
    // A peer that DID declare this media already owns a record and none is derived. It runs after
    // the seal because an Artifact is a secondary fact and must never block a turn's terminal.
    for (const attachment of attachments ?? [])
      this.#storage.artifacts.derive({
        createdBy: bot, bot, sessionId, sourceMessageId: messageId, mediaId: attachment.fileId,
        filename: attachment.name, mediaType: attachment.mimeType, sizeBytes: attachment.size,
      }, now);
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
    const peer = this.#executionPeer(bot, sessionId);
    const delivery = peer === undefined ? undefined : this.#storage.nativeBotTurnDelivery(peer, turnId);
    const presence = peer === undefined ? "absent" : this.#attachPresence.get(peer);
    const detached = presence === undefined
      ? this.#ingress.isAttached?.(peer ?? bot) !== true
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
    const peer = this.#executionPeer(bot, sessionId);
    const delivery = peer === undefined ? undefined : this.#storage.nativeBotTurnDelivery(peer, turnId);
    if (delivery === undefined) return;
    this.#clearTurnTimeout(bot, sessionId, turnId);
    const key = this.#nativeTurnKey(bot, sessionId, turnId);
    const waiting = this.#storage.tasks.waiting(peer ?? bot, turnId);
    const suspended = this.#storage.tasks.suspended(peer ?? bot, turnId, delivery.queuedAt, this.#now());
    const timer = setTimeout(
      () => this.#timeoutTurn(bot, sessionId, turnId),
      Math.max(1, (waiting?.expiresAt ?? 0) - this.#now(), delivery.queuedAt + this.#turnTimeoutMs + suspended - this.#now()),
    );
    timer.unref();
    this.#turnTimers.set(key, timer);
  }

  #timeoutTurn(bot: string, sessionId: string, turnId: string): void {
    this.#turnTimers.delete(this.#nativeTurnKey(bot, sessionId, turnId));
    const chat = this.#storage.nativeBotChat(bot, this.#now());
    if (chat.sessionId !== sessionId || chat.activeTurnId !== turnId) return;
    const peer = this.#executionPeer(bot, sessionId);
    const delivery = peer === undefined ? undefined : this.#storage.nativeBotTurnDelivery(peer, turnId);
    if (delivery === undefined) return;
    const waiting = this.#storage.tasks.waiting(peer ?? bot, turnId);
    const suspended = this.#storage.tasks.suspended(peer ?? bot, turnId, delivery.queuedAt, this.#now());
    if ((waiting !== undefined && waiting.expiresAt > this.#now()) || (this.#turnTimeoutMs > 0 && this.#now() < delivery.queuedAt + this.#turnTimeoutMs + suspended)) {
      this.#scheduleTurnTimeout(bot, sessionId, turnId);
      return;
    }
    if (delivery.acknowledgedAt === null) {
      this.#storage.cancelAttachCommand(
        peer ?? bot,
        delivery.sequence,
        delivery.commandId,
        "native turn timed out",
        this.#now(),
      );
    } else {
      if (peer !== undefined) this.#ingress.sendNativeInterrupt(peer, { threadId: sessionId, turnId });
    }
    this.#finish(bot, sessionId, turnId, {
      phase: "timeout",
      status: "timed_out",
    });
  }

  #seedTurnActivity(bot: string, sessionId: string, turnId: string): void {
    const key = this.#nativeTurnKey(bot, sessionId, turnId);
    if (!this.#turnActivity.has(key)) {
      const peer = this.#executionPeer(bot, sessionId);
      const delivery = peer === undefined ? undefined : this.#storage.nativeBotTurnDelivery(peer, turnId);
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
      const peer = this.#executionPeer(bot, chat.sessionId) ?? bot;
      const waiting = this.#storage.tasks.waiting(peer, turnId);
      if (waiting !== undefined && waiting.expiresAt > now) continue;
      const lastActive = this.#turnActivity.get(key) ?? now;
      const silentFor = now - lastActive - this.#storage.tasks.suspended(peer, turnId, lastActive, now);
      // Capability 69. Nobody is carrying this turn: the peer is gone, or it re-attached without
      // it and could not say either way. Bound the silence to the provisional owner-loss lease
      // rather than the long ceiling, and never lengthen a window an operator already shortened.
      const ownerLost = this.#turnOwnerLost.get(key);
      if (ownerLost !== undefined && this.#staleTurnCeilingMs > 0) {
        const lease = Math.min(
          ownerLost.kind === "detached" ? OWNER_LOSS_LEASE_MS : UNDECLARED_OWNER_GRACE_MS,
          this.#staleTurnCeilingMs,
        );
        const since = Math.max(lastActive, ownerLost.at);
        if (now - since - this.#storage.tasks.suspended(peer, turnId, since, now) >= lease) {
          this.#log(
            `reaping unowned turn ${turnId} for ${bot}: ${ownerLost.kind} peer, no frame for ${now - since}ms`,
          );
          this.#sealOwnerLoss(bot, chat.sessionId, turnId);
          continue;
        }
      }
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
        this.#timeoutTurn(bot, chat.sessionId, turnId);
      }
    }
    // A turn can also leave through /new, which discards it without a terminal. Anything no
    // longer the active turn is bookkeeping this sweep should not carry (or watch) any further.
    for (const map of [this.#turnActivity, this.#interruptAcked, this.#turnOwnerLost])
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
    // Capability 56. Sanitize once, up front: the same sentence is stored on the durable row,
    // broadcast on the live frame, and re-emitted verbatim by `#rebroadcastPending` on reconnect.
    const detail = event.detail === undefined ? undefined : sanitizeApprovalDetail(event.detail);
    // Capability 62. Same discipline for the repair block: validate once, drop it (never the
    // approval) when it fails, and carry the one validated object on every surface below.
    const repair = sanitizeApprovalRepair(event.repair);
    // Bounded and content-free: a dropped block is otherwise invisible, and it is the one symptom
    // of a harness and gateway that disagree on the row.
    if (event.repair !== undefined && repair === undefined)
      this.#log(`dropping repair block on approval for "${bot}": failed validation`);
    // Capability 66. And again for the scoped-approval block. A block that fails validation is
    // dropped, which leaves a plain approval: no standing grant can be made from it and no consult
    // can cover it, so failing validation fails closed.
    const scope = sanitizeApprovalScope(event.scope);
    if (event.scope !== undefined && scope === undefined)
      this.#log(`dropping scope block on approval for "${bot}": failed validation`);
    const change = this.#storage.recordNativeInteraction({
      bot,
      kind: "approval",
      interactionId: event.approvalId,
      sessionId,
      turnId: event.turnId,
      payload: {
        name: event.name,
        ...(detail === undefined ? {} : { detail }),
        ...(repair === undefined ? {} : { repair }),
        ...(scope === undefined ? {} : { scope }),
      } satisfies ApprovalPayload,
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
      // Capability 66. Consult the standing grants BEFORE the card goes out, so the frame says
      // which grant is settling this ask rather than the app watching a card resolve itself for no
      // stated reason. Consulting is not executing: the decision still travels as the ordinary
      // `resolve_approval` the peer performs.
      // Capability 66. A typed peer's own block, or the binding derived from a plain ask's rule
      // name and capability-56 sentence. The stored record is the authority on the ask's expiry,
      // including the persisted fallback a legacy approval gets, so the derived binding reads it
      // rather than recomputing it.
      const covering = scope ?? plainApprovalScope(
        { name: event.name, ...(detail === undefined ? {} : { detail }) },
        this.#storage.nativeInteraction(bot, "approval", event.approvalId)?.expiresAt ?? null,
      );
      const grantId = covering === undefined
        ? undefined
        : this.#claimGrant(bot, sessionId, event.turnId, covering, scope === undefined);
      const wire: BotApprovalPendingFrame = {
        type: "bot_approval_pending",
        bot,
        sessionId,
        turnId: event.turnId,
        toolCallId: event.approvalId,
        name: event.name,
        updatedAt: this.#now(),
        ...(detail === undefined ? {} : { detail }),
        ...(repair === undefined ? {} : { repair }),
        ...(scope === undefined ? {} : { scope }),
        ...(grantId === undefined ? {} : { grantId }),
      };
      this.#broadcast(wire);
      this.#onApproval?.({
        bot,
        sessionId,
        turnId: event.turnId,
        toolCallId: event.approvalId,
        name: event.name,
      });
      this.#scheduleInteractionExpiry({
          bot,
          kind: "approval",
          interactionId: event.approvalId,
          sessionId,
          turnId: event.turnId,
          payload: {
            name: event.name,
            ...(detail === undefined ? {} : { detail }),
            ...(repair === undefined ? {} : { repair }),
          },
          expiresAt: event.expiresAt ?? null,
          updatedAt: this.#now(),
        });
      this.#state(bot, sessionId, "polling", true);
      // Capability 66. A covered ask is settled from the standing grant through the very same
      // relay path a tapped card uses; nothing is replayed and nothing is executed here. The grant
      // is named on the durable record FIRST, so a reconnect between these two lines still shows
      // the person what settled their card.
      if (grantId !== undefined) {
        this.#storage.attachInteractionGrant(bot, event.approvalId, grantId);
        this.#honorApprovalGrant(bot, sessionId, event.turnId, event.approvalId, grantId);
      }
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
      this.#scheduleInteractionExpiry({
          bot,
          kind: "clarify",
          interactionId: event.clarifyId,
          sessionId,
          turnId: event.turnId,
          payload,
          expiresAt: event.expiresAt ?? null,
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
    room?: string,
  ): void {
    const wire: BotApprovalResolvedFrame = {
      type: "bot_approval_resolved",
      bot,
      sessionId,
      turnId,
      toolCallId: approvalId,
      outcome,
      updatedAt: this.#now(),
      ...(room === undefined ? {} : { room }),
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

  #expireDueInteractions(): void {
    for (const bot of this.#native) for (const pending of this.#storage.pendingNativeInteractions(bot)) {
      if (pending.expiresAt !== null && pending.expiresAt <= this.#now()) this.#expireInteraction(bot, pending.kind, pending.interactionId, this.#now());
    }
  }

  #expireInteraction(bot: string, kind: "approval" | "clarify", id: string, at: number): void {
    const room = payloadRoom(this.#storage.nativeInteraction(bot, kind, id)?.payload);
    const expired = this.#storage.expireNativeInteractionIfDue(bot, kind, id, at);
    if (expired === undefined) return;
    this.#clearInteractionTimer(kind, bot, id);
    if (kind === "approval") this.#emitApprovalResolved(bot, expired.sessionId, expired.turnId, id, "expired", room);
    else this.#broadcast({ type: "bot_clarify_resolved", bot, sessionId: expired.sessionId, turnId: expired.turnId, clarifyId: id, outcome: "expired", updatedAt: at, ...(room === undefined ? {} : { room }) });
    if (room === undefined) this.#state(bot, expired.sessionId, "polling", true);
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
    const expiresAt = pending.expiresAt ?? this.#storage.nativeInteraction(pending.bot, pending.kind, pending.interactionId)?.expiresAt;
    if (expiresAt === undefined || expiresAt === null) return;
    const key = `${pending.kind}:${pending.bot}:${pending.interactionId}`;
    const prior = this.#interactionTimers.get(key);
    if (prior !== undefined) clearTimeout(prior);
    const timer = setTimeout(
      () => this.#expireInteraction(pending.bot, pending.kind, pending.interactionId, Math.max(expiresAt, this.#now())),
      Math.max(0, expiresAt - this.#now()),
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

  /** Everything this turn was still blocked on is over with it. Answers whether anything actually
   *  changed, which a caller that renders a badge needs: a turn that asked nothing must not make
   *  the room re-announce itself. Room turns settle through this same method (capability 51), so a
   *  room card and a chat card expire by one rule rather than two. */
  #expireTurnInteractions(bot: string, sessionId: string, turnId: string): boolean {
    let changed = false;
    for (const pending of this.#storage.pendingNativeInteractions(bot)) {
      if (pending.sessionId !== sessionId || pending.turnId !== turnId) continue;
      if (!this.#storage.resolveNativeInteraction(
        bot,
        pending.kind,
        pending.interactionId,
        "expired",
        this.#now(),
      )) continue;
      changed = true;
      this.#clearInteractionTimer(pending.kind, bot, pending.interactionId);
      const room = payloadRoom(pending.payload);
      if (pending.kind === "approval") {
        this.#emitApprovalResolved(
          bot,
          sessionId,
          turnId,
          pending.interactionId,
          "expired",
          room,
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
          ...(room === undefined ? {} : { room }),
        });
      }
    }
    return changed;
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
          ...(payload.room === undefined ? {} : { room: payload.room.name }),
          ...(payload.detail === undefined ? {} : { detail: payload.detail }),
          ...(payload.repair === undefined ? {} : { repair: payload.repair }),
          ...(payload.scope === undefined ? {} : { scope: payload.scope }),
          ...(payload.grantId === undefined ? {} : { grantId: payload.grantId }),
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
          ...(payload.room === undefined ? {} : { room: payload.room.name }),
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
    const waitingOn = chat.activeTurnId === undefined ? undefined : this.#storage.tasks.waiting(this.#executionPeer(bot, sessionId) ?? bot, chat.activeTurnId);
    return {
      type: "bot_chat_state",
      bot,
      sessionId,
      phase,
      running,
      inflight: running,
      ...(state === undefined ? {} : state),
      ...(waitingOn === undefined ? {} : { waitingOn }),
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

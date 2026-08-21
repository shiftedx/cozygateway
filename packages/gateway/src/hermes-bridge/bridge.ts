import type {
  BotCatalog,
  BotChatMessage,
  BotCreateRequest,
  BotGroup,
  BotGroupDetail,
  BotGroupMessage,
  BotInboxThread,
  BotModelConfig,
  BotModelConfigPatch,
  BotProfile,
  BotProfilePatch,
  BotRoutine,
  BotRoutineCreateRequest,
  BotRoutinePatch,
  BotSummary,
  BotTurnToolSteps,
  BridgeLiveness,
  ServerFrame,
} from "cozygateway-contract";

import type { Storage } from "../storage.ts";
import { HermesRpcError, HermesUnavailable, type HermesClient, type HermesState } from "./client.ts";
import {
  DEFAULT_CHAT_SUGGESTION,
  mintCanonicalChat,
  resolveCanonicalChat,
  listBotSessions,
  isConversationalSession,
  isConversationalSessionId,
  sessionKind,
  type CanonicalChatResult,
  type ChatAdoption,
  type PinStore,
} from "./canonical-chat.ts";
import {
  botDisplayName,
  botHandle,
  botMetaForWriteback,
  buildRoster,
  classifyPreview,
  parseProfilesList,
  readBotMeta,
  resolveChatPin,
  UI_META_KEY,
} from "./roster.ts";
import type { GroupMember } from "./group-protocol.ts";
import { BotChatStream } from "./chat-stream.ts";
import { BotToolActivity, TOOL_STEP_TTL_MS, groupToolSteps } from "./tool-activity.ts";
import {
  BotApprovals,
  type BotApprovalDecision,
  type BotApprovalPush,
  type BotApprovalResolveOutcome,
} from "./approvals.ts";
import { BotChatTurns, RuntimeSessionUnknown } from "./chat-turns.ts";
import { parseChatSnapshot } from "./chat-messages.ts";
import { ScheduledPushObserver } from "./scheduled-push.ts";
import { effectiveChatPin, followLatestChatPin } from "./chat-pin.ts";
import { inboxMessages as projectInboxMessages, inboxThread } from "./inbox.ts";
import { firstLocalGeneration, nextLocalGeneration, readyIdentity } from "./link-generation.ts";
import { GroupRooms } from "./group-rooms.ts";
import { PHOTO_SWEEP_MS, PHOTO_TTL_MS, newPhotoFileId, photoDisplayName, sniffImageType } from "./photos.ts";
import { decodeAssistantMediaDataUrl } from "./assistant-media.ts";
import { createMediaLimiter } from "./media.ts";
import {
  BotDeleteRefused,
  BotNotFound,
  createBotProfile,
  deleteBotProfile,
  PROFILE_DELETE_TIMEOUT_MS,
  validateExistingBotName,
  type CreatedBot,
  type DeletePath,
} from "./crud.ts";
import {
  CATALOG_CACHE_MAX,
  CATALOG_DEGRADED_TTL_MS,
  CATALOG_TTL_MS,
  configureBotProfile,
  readBotCatalog,
  readBotProfile,
  type CachedCatalog,
  type ProfileConfigureResult,
} from "./profile.ts";
import {
  createBotRoutine,
  deleteBotRoutine,
  listBotRoutines,
  patchBotRoutine,
  type RoutineWriteResult,
} from "./routines.ts";
import { readBotModelConfig, writeBotModelConfig } from "./model-config.ts";

/** The bots bridge: everything between the Hermes JSON-RPC client and the `/bots` REST routes.
 *  It owns the cache, the refresh cadence, the focus state the app declares, and the `/ws`
 *  broadcasts. Nothing above this module knows a Hermes method name.
 *
 *  Cadence follows the desktop's own polling rates, but only while a device says it is looking at
 *  something: roster every 5 s while the roster screen is focused, routines every 20 s while the
 *  routines screen is. With nothing focused the bridge is idle and costs the Hermes gateway
 *  nothing. Where Hermes offers a broadcast instead (`sessions.changed`, `cron.changed`)
 *  the bridge refreshes on the event, debounced, which beats any poll. */

/** Desktop-parity poll cadences, in milliseconds (dissection 1.3). */
export const ROSTER_POLL_MS = 5_000;
export const ROUTINES_POLL_MS = 20_000;

/** A focus declaration goes stale on its own so a device that vanishes without saying goodbye
 *  cannot pin the bridge into polling forever. */
export const FOCUS_TTL_MS = 60_000;

/** Change broadcasts are coalesced: a burst of `sessions.changed` during one turn should cost one
 *  refresh, not one per event. */
const CHANGE_DEBOUNCE_MS = 250;

/** How long a bot's routines keep being re-read on a `cron.changed` broadcast after the last time
 *  anything asked for them.
 *
 *  A cron change carries no bot name, so "which bots changed" is unanswerable and the bridge
 *  re-reads the bots something is actually watching. Bounded by time rather than by count because
 *  the cost is one `cron.manage` per watched bot per change burst, and a routines pane that has been
 *  closed for five minutes is not worth a round trip. A device that is still looking at the pane
 *  keeps its bot warm simply by reading it. */
export const ROUTINE_WATCH_TTL_MS = 5 * 60_000;

/** A transcript read marks an inbox thread open for this long. Hermes change events carry no
 *  reliable profile/thread pair, so watched threads are the bounded set re-read on a change. */
export const INBOX_WATCH_TTL_MS = 5 * 60_000;
export const INBOX_THREAD_LIMIT = 50;
export const INBOX_SESSION_SCAN_LIMIT = 200;

/** The hermes error code for "there is no such session". Same family as
 *  `HERMES_PROFILE_NOT_FOUND` in `routes.ts`, kept here because this one is not a status mapping: it
 *  is the fact the send path acts on. */
export const HERMES_SESSION_NOT_FOUND = 5003;

/** True when a failed send says the chat itself is gone rather than that the prompt was refused.
 *
 *  Two shapes mean it. `RuntimeSessionUnknown` is this gateway's own: the resume produced no runtime
 *  id and there was none on disk either, so the send was never addressable. A hermes `5003` is
 *  hermes' own: the stored id names no session it knows. The message check behind the code is there
 *  because the code is the one part of this that a hermes build could reasonably vary, and a heal is
 *  cheap where a permanent 502 is not. */
export function isChatSessionGone(err: unknown): boolean {
  if (err instanceof RuntimeSessionUnknown) return true;
  if (!(err instanceof HermesRpcError)) return false;
  if (err.code === HERMES_SESSION_NOT_FOUND) return true;
  return /no such session|session not found|unknown session/i.test(err.message);
}

export type BotFocusScreen = "roster" | "routines";

export interface BotRosterView {
  bots: BotSummary[];
  /** Milliseconds; null when no refresh has ever landed (cold cache). */
  updatedAt: number | null;
  /** True when the cache is being served without a live Hermes link behind it. */
  stale: boolean;
  hermesState: HermesState;
}

export interface BotSessionSummary {
  id: string;
  startedAt: number;
  lastActiveAt: number;
  kind: ReturnType<typeof sessionKind>;
  title?: string;
  preview?: string;
}

export interface BotSessionsView {
  sessions: BotSessionSummary[];
  activeSessionId: string | null;
}

export interface BotSessionAdoption {
  name: string;
  sessionId: string;
  previousSessionId: string;
}

export interface BotNewSessionResult {
  sessionId: string;
  previousSessionId: string;
}

export interface BotInboxView {
  threads: BotInboxThread[];
}

export interface BotInboxMessagesView {
  messages: BotGroupMessage[];
}

export class BotSessionNotFound extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`no Hermes session named "${sessionId}" exists`);
    this.name = "BotSessionNotFound";
    this.sessionId = sessionId;
  }
}

export class BotSessionConflict extends Error {
  readonly sessionId: string;
  readonly owner: string;

  constructor(sessionId: string, owner: string) {
    super(`Hermes session "${sessionId}" belongs to bot "${owner}"`);
    this.name = "BotSessionConflict";
    this.sessionId = sessionId;
    this.owner = owner;
  }
}

/** What the REST layer is allowed to ask of the bridge. Keeping it an interface lets the routes
 *  be tested against a stub with no sockets. */
export interface BotsSurface {
  roster(): BotRosterView;
  /** Liveness of the hermes link itself (issue #63), for `GET /health` to fold into
   *  `GatewayInfo.bridges.hermes`. Deliberately NOT part of `roster()`: that view answers "what can
   *  I show", already covers staleness via `stale`/`hermesState`, and is read only by the bots
   *  routes, while this is read by `/health` on every unauthenticated probe a monitor makes, for a
   *  bridge that may have nothing to do with the roster screen at all. */
  health(): BridgeLiveness;
  /** Fire-and-forget background refresh. Never throws, never awaited by a request handler. */
  refreshSoon(reason: string): void;
  canonicalChat(name: string): Promise<CanonicalChatResult>;
  newSession(name: string): Promise<BotNewSessionResult>;
  resetChat(name: string): Promise<ChatResetResult>;
  sessions(name: string, limit: number): Promise<BotSessionsView>;
  adoptSession(name: string, sessionId: string, limit: number): Promise<BotSessionAdoption>;
  inbox(name: string): Promise<BotInboxView>;
  inboxMessages(name: string, threadId: string): Promise<BotInboxMessagesView>;
  chatHistory(name: string): Promise<BotChatHistory>;
  sendChatMessage(
    name: string,
    text: string,
    opts?: { clientId?: string },
  ): Promise<{ sessionId: string; message: BotChatMessage }>;
  /** Capability 19: hard-stop the bot turn this bridge is currently driving. */
  stopChat(name: string): Promise<"stopped" | "idle">;
  /** Capability 9: one photo, with an optional caption, into the canonical chat. The bytes have
   *  already passed the inbound rules (`photos.ts`) by the time this is called; what this owns is
   *  storing the gateway's own copy and getting the RPC pair right. */
  sendChatPhoto(
    name: string,
    photo: BotChatPhotoUpload,
  ): Promise<{ sessionId: string; message: BotChatMessage }>;
  /** Metadata and sliced bytes for the authenticated attachment route. Kept separate so range
   *  negotiation and HEAD-like probes never materialize a large media BLOB. */
  chatAttachmentInfo(name: string, fileId: string): BotChatAttachmentInfo | undefined;
  chatAttachmentSlice(name: string, fileId: string, offset: number, length: number): Uint8Array | undefined;
  createBot(input: BotCreateRequest): Promise<BotCreated>;
  deleteBot(name: string): Promise<DeletePath>;
  botProfile(name: string): Promise<BotProfile>;
  configureProfile(name: string, patch: BotProfilePatch): Promise<ProfileConfigureResult>;
  modelConfig(name: string): Promise<BotModelConfig>;
  configureModel(name: string, patch: BotModelConfigPatch): Promise<BotModelConfig>;
  catalog(query: string): Promise<BotCatalog>;
  routines(name: string): Promise<BotRoutineList>;
  createRoutine(name: string, input: BotRoutineCreateRequest): Promise<RoutineWriteResult>;
  patchRoutine(name: string, id: string, patch: BotRoutinePatch): Promise<RoutineWriteResult>;
  deleteRoutine(name: string, id: string): Promise<void>;
  setFocus(deviceId: string, screen: BotFocusScreen | null): void;
  /** Group chat rooms. Hosted by this gateway rather than by a client, so they are the one part of
   *  this surface whose state is OURS and not a cache of Hermes' (see `group-rooms.ts`). */
  groups(): BotGroup[];
  createGroup(name: string, members: string[]): Promise<BotGroup>;
  deleteGroup(name: string): void;
  groupDetail(name: string): BotGroupDetail;
  sendGroupMessage(name: string, text: string, opts?: { clientId?: string }): BotGroupMessage;
  /** Capability 10: resolve one pending approval for a bot, per call only. Server-authoritative:
   *  the hermes session, the turn and the pending state all come from the gateway's own record, so
   *  the only things the caller contributes are which bot and which correlation id. */
  resolveApproval(
    name: string,
    toolCallId: string,
    decision: BotApprovalDecision,
    deviceId: string,
  ): Promise<BotApprovalResolveOutcome>;
  /** Capability 22: resolve one durable native clarification option. Dashboard-backed bots do not
   * expose this interaction and return unsupported; native-data-plane decorators own it. */
  resolveClarify(
    name: string,
    clarifyId: string,
    optionId: string,
    deviceId: string,
  ): Promise<"selected" | "unknown" | "not_pending" | "expired" | "invalid_option" | "unsupported">;
}

/** One accepted photo on its way to a bot. Everything here has already been decided: the bytes were
 *  sniffed, the type is one this gateway serves back, and the caption is whatever the sender wrote or
 *  the neutral default. */
export interface BotChatPhotoUpload {
  bytes: Uint8Array;
  mime: string;
  /** Extension derived from the SNIFFED bytes, never from a client filename. */
  ext: string;
  text: string;
  clientId?: string;
}

/** The gateway's own copy of a photo, on the way back out. */
export interface BotChatAttachmentBytes {
  bytes: Uint8Array;
  mime: string;
  name: string;
  size: number;
}

export type BotChatAttachmentInfo = Omit<BotChatAttachmentBytes, "bytes">;

/** What `POST /bots/:name/chat/reset` answers with. */
export interface ChatResetResult {
  /** The freshly minted canonical chat. */
  sessionId: string;
  /** The chat that was retired, when there was one to retire. */
  previousSessionId?: string;
}

/** What `GET /bots/:name/routines` answers with. */
export interface BotRoutineList {
  name: string;
  routines: BotRoutine[];
  updatedAt: number;
}

/** What `POST /bots` answers with: the roster row of the bot that now exists, plus how its look
 *  write landed. `metaOutcome` is the desktop's three-way `saveBotMeta` contract, surfaced rather
 *  than swallowed so a client can tell "your color is on every device" from "your color is only on
 *  this gateway". */
export interface BotCreated {
  bot: BotSummary;
  metaOutcome: CreatedBot["metaOutcome"];
  /** Hermes' own text for a look write that did not land. Absent when it landed. */
  metaError?: string;
}

/** What `GET /bots/:name/chat/messages` answers with. `adoption` says how the chat was resolved,
 *  which is the same value `GET /bots/:name/chat` reports. */
export interface BotChatHistory {
  sessionId: string;
  adoption: ChatAdoption;
  messages: BotChatMessage[];
  running: boolean;
  inflight: boolean;
  /** Tool steps for the turns this chat has already run (ext-bots capability 12). ABSENT rather
   *  than empty when there are none. Deliberately NOT attached to a message: see
   *  `BotTurnToolSteps` in the contract for why the gateway will not guess which transcript row a
   *  turn produced, and what a client joins on instead. */
  toolSteps?: BotTurnToolSteps[];
  updatedAt: number;
  /** An opener the client MAY offer while this chat is empty (ext-bots capability 11).
   *
   *  Presentation only, and what it is NOT is the whole point: the gateway never submits it, it is
   *  not in the transcript, and it becomes part of the conversation only if the user chooses to send
   *  it AS THEIR OWN message through the ordinary composer. Present only when `messages` is empty and
   *  the deployment configured a suggestion; ABSENT otherwise, so a client that has never heard of it
   *  sees exactly the payload it always saw. */
  suggestion?: string;
}

export interface HermesBridgeOptions {
  client: HermesClient;
  storage: Storage;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  /** New canonical chats are born hidden (desktop default). */
  hideBotChats?: boolean;
  /** The opener an empty bot chat offers a client (capability 11). Defaults to
   *  `DEFAULT_CHAT_SUGGESTION`, the line this gateway used to submit by itself. An EMPTY string (or
   *  one that is only whitespace) turns the field off, which is how a deployment says "offer
   *  nothing"; there is deliberately no separate boolean, because "no text" and "no suggestion" are
   *  the same state and two ways to say it would eventually disagree. */
  chatSuggestion?: string;
  /** Profile names kept off the roster this gateway serves. See `RosterBuildOptions.hidden`. */
  hiddenProfiles?: Iterable<string>;
  /** The Hermes profile this bridge's own link runs on, when the operator has told us. Deleting it
   *  stops the gateway the bridge is talking to, so `DELETE /bots/:name` refuses it.
   *
   *  It has to be configured rather than detected: the JSON-RPC surface reports which profile a
   *  SESSION is routed to, never which profile the gateway process itself was launched under, and
   *  guessing wrong in either direction is worse than not guessing (a wrong guess makes a real bot
   *  undeletable; no guess leaves the operator where they already were). Unset means no guard. */
  bridgeProfile?: string;
  rosterPollMs?: number;
  routinesPollMs?: number;
  focusTtlMs?: number;
  /** How often expired chat photos are swept off disk. Scaled down in tests; the read filter is what
   *  enforces the TTL, so this only decides how long unreachable bytes linger. */
  attachmentSweepMs?: number;
  /** Turn-poll cadence and cap. Defaults are the desktop's own 2 s / 180 s. */
  chatPollMs?: number;
  chatTurnTimeoutMs?: number;
  /** How often a live reply draft may go on the wire, per session. Default
   *  `CHAT_DELTA_THROTTLE_MS` (200 ms). */
  chatDeltaThrottleMs?: number;
  /** How often a turn's tool-step snapshot may go on the wire, per session (capability 12). Default
   *  `TOOL_ACTIVITY_THROTTLE_MS` (200 ms). */
  toolActivityThrottleMs?: number;
  /** How long a superseding group drive waits before taking over. Default `GROUP_CHAIN_DELAY_MS`
   *  (250 ms), the desktop's own. */
  groupChainDelayMs?: number;
  /** Raised when a group member's reply mentions `@user` (spec section 4's escalation). The room's
   *  durable `needs you` state and its `bot_group_state` frame have already happened by then; this
   *  is the out-of-band leg, for a device with no live socket. Wired to the push notifier at server
   *  assembly; unset (as in every test that does not care) means the escalation stays in-band. */
  onGroupEscalation?: (event: { group: string; member: string; displayName: string; text: string }) => void;
  /** Raised on every pending approval and every resolution (capability 10). The frame has already
   *  gone out by then; this is the out-of-band leg, for a device with no live socket. Wired to the
   *  push notifier at server assembly; unset (as in every test that does not care) means the
   *  approval lifecycle stays in-band. */
  onApproval?: (event: BotApprovalPush) => void;
  /** Raised after a settled assistant row lands in the listed conversational canonical session.
   *  Drafts, user echoes, context markers and machine-classified sessions never reach this seam. */
  onChatMessage?: (event: {
    bot: string;
    displayName: string;
    messageId: string;
    chatSessionId: string;
    /** The settled reply's wire-visible text. Rides only inside the encrypted push payload; the
     *  relay never sees it. */
    preview: string;
  }) => void;
  /** Audit sink for approval resolutions, one line per terminal transition. Defaults to the
   *  bridge's own log. The line names the bot, the chat, the turn, the toolCallId, the outcome and
   *  the deciding device, and never anything describing the action. */
  approvalLog?: (line: string) => void;
  /** How long a pending approval waits before the gateway calls it `expired`. Mirrors the hermes
   *  `approvals.timeout`, whose default is 300 s and which is not readable over the JSON-RPC
   *  surface, so an operator who changes it there sets this too. */
  approvalTimeoutMs?: number;
  /** How long a profile delete is given. Default `PROFILE_DELETE_TIMEOUT_MS` (180 s). Overridable
   *  so the timeout path is testable in milliseconds instead of minutes. */
  deleteTimeoutMs?: number;
  /** How long an edit-screen catalog is served from cache. Default `CATALOG_TTL_MS` (60 s). */
  catalogTtlMs?: number;
  /** How long a DEGRADED catalog (non-empty `unavailable`) is served from cache. Default
   *  `CATALOG_DEGRADED_TTL_MS` (5 s). */
  catalogDegradedTtlMs?: number;
  logSink?: (line: string) => void;
}

export class HermesBridge implements BotsSurface {
  readonly #client: HermesClient;
  readonly #storage: Storage;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #hideBotChats: boolean;
  readonly #hidden: ReadonlySet<string>;
  readonly #bridgeProfile: string | undefined;
  readonly #deleteTimeoutMs: number;
  readonly #scheduledPush: ScheduledPushObserver | undefined;
  readonly #rosterPollMs: number;
  readonly #routinesPollMs: number;
  readonly #focusTtlMs: number;
  readonly #sweepMs: number;
  readonly #log: (message: string) => void;

  readonly #catalogTtlMs: number;
  readonly #catalogDegradedTtlMs: number;
  /** Assistant dashboard reads decode base64 into memory. Two at a time bounds the 40 MB media
   *  expansion across bots while each bot's directives remain serialized by BotChatTurns. */
  readonly #assistantMediaLimiter = createMediaLimiter(2);

  readonly #focus = new Map<string, { screen: BotFocusScreen; at: number }>();
  /** The last catalog fetched, per skill query, and the fetch in flight for it. Keyed on the query
   *  because the skills half is a SEARCH: one cache slot would make every keystroke evict the
   *  previous answer and re-spend all three calls. */
  readonly #catalogCache = new Map<string, CachedCatalog>();
  readonly #catalogInflight = new Map<string, Promise<BotCatalog>>();
  readonly #chatInflight = new Map<string, Promise<CanonicalChatResult>>();
  readonly #createInflight = new Map<string, Promise<BotCreated>>();
  /** The tail of the per-bot profile-write CHAIN, by bot name. Not a dedupe like the two above:
   *  the second write must still run, it just runs AFTER the first. See `configureProfile`. */
  readonly #configureChain = new Map<string, Promise<unknown>>();
  readonly #pins: PinStore;
  readonly #chat: BotChatTurns;
  /** The live-draft producer. It reads Hermes' `message.*` events off the SAME socket everything
   *  else here speaks over, and it is fed from exactly two places: `start()` hands it every event
   *  frame, and the two turn paths tell it which runtime session belongs to which bot. */
  readonly #stream: BotChatStream;
  /** The hermes approval leg (capability 10). It reads `approval.request` off the SAME socket, and
   *  resolves through `approval.respond`. See `approvals.ts` for why bot approvals cannot ride the
   *  core `TurnRunner` surface. */
  readonly #approvals: BotApprovals;
  /** Capability 12. Live tool steps for a bot's turn; see `tool-activity.ts` for what hermes offers
   *  on this surface and for the redaction posture that keeps its free text off the wire. */
  readonly #toolActivity: BotToolActivity;
  readonly #groups: GroupRooms;

  /** Bots whose routines something has read recently, and when. Drives the `cron.changed` fan-out;
   *  see `ROUTINE_WATCH_TTL_MS`. */
  readonly #routineWatch = new Map<string, number>();
  /** Threads opened through the transcript route, with their last rendered count. */
  readonly #inboxWatch = new Map<
    string,
    { bot: string; threadId: string; messageCount: number; at: number }
  >();
  /** One list per bot at a time. Concurrency here is not merely wasteful: a list PAUSES legacy
   *  routines as a side effect, and two overlapping lists would both try to pause the same jobs. */
  readonly #routineInflight = new Map<string, Promise<BotRoutineList>>();
  /** The tail of the per-bot routine-WRITE chain, by bot name. The same chain `#configureChain` is,
   *  for the same reason, and just as load-bearing: see `#chainRoutineWrite`. */
  readonly #routineWriteChain = new Map<string, Promise<unknown>>();
  /** The last routines payload broadcast per bot, so an unchanged re-read is silent on the wire. */
  readonly #lastRoutinesJson = new Map<string, string>();
  #routineDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  #inboxDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  #inboxRefreshing: Promise<void> | undefined;
  #inboxRefreshDirty = false;

  /** The opener an empty chat offers, or `undefined` when this deployment offers none. Never
   *  submitted anywhere; see `BotChatHistory.suggestion`. */
  readonly #chatSuggestion: string | undefined;

  /** False once this Hermes has shown it cannot store `ui_meta` (an unknown-method rejection, or a
   *  reply carrying no `applied` object at all: dissection 3.1's `unsupported` outcome). Retrying
   *  forever costs one `profiles.configure` per chat open on every old gateway, for a write that
   *  is never going to apply. */
  #uiMetaWriteback = true;

  /** The profile the Hermes gateway is routed to, and whether it is mid-turn. Both feed the
   *  presence rule (dissection 7.1). The bridge only knows the routed profile when it is the one
   *  driving a turn, which on this surface is a chat send or a group round. */
  #routedProfile: string | null = null;
  #busyDepth = 0;

  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #sweepTimer: ReturnType<typeof setTimeout> | undefined;
  #debounceTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshing: Promise<void> | undefined;
  /** Set when a refresh was asked for while one was already running; drives the trailing run. */
  #refreshDirty = false;
  #closed = false;
  #lastRosterJson = "";
  #lastActiveJson = "";

  /** The hermes link generation every durable runtime id is stamped with and checked against; see
   *  `link-generation.ts`. Seeded from disk so a gateway restart against an untouched hermes keeps
   *  honouring the ids it was already holding. */
  #linkGeneration: string;
  /** True once this process has seen a `gateway.ready`. The FIRST one is the link this gateway
   *  started on and says nothing about hermes having restarted; every one after it followed a
   *  disconnect, which is exactly what a hermes restart looks like from here. */
  #sawReady = false;

  constructor(opts: HermesBridgeOptions) {
    this.#client = opts.client;
    this.#storage = opts.storage;
    this.#linkGeneration = opts.storage.hermesLinkGeneration() ?? firstLocalGeneration();
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#hideBotChats = opts.hideBotChats ?? true;
    // Normalized here as well as in the config parser: the set is compared against profile names
    // as Hermes stores them (lowercase), and a caller that hands over `Ops-Runner` means the same
    // bot as one that hands over `ops-runner`.
    this.#hidden = new Set([...(opts.hiddenProfiles ?? [])].map((name) => name.trim().toLowerCase()));
    const bridgeProfile = opts.bridgeProfile?.trim().toLowerCase();
    this.#bridgeProfile = bridgeProfile === undefined || bridgeProfile.length === 0 ? undefined : bridgeProfile;
    this.#deleteTimeoutMs = opts.deleteTimeoutMs ?? PROFILE_DELETE_TIMEOUT_MS;
    this.#catalogTtlMs = opts.catalogTtlMs ?? CATALOG_TTL_MS;
    this.#catalogDegradedTtlMs = opts.catalogDegradedTtlMs ?? CATALOG_DEGRADED_TTL_MS;
    this.#rosterPollMs = opts.rosterPollMs ?? ROSTER_POLL_MS;
    this.#routinesPollMs = opts.routinesPollMs ?? ROUTINES_POLL_MS;
    this.#focusTtlMs = opts.focusTtlMs ?? FOCUS_TTL_MS;
    this.#sweepMs = opts.attachmentSweepMs ?? PHOTO_SWEEP_MS;
    const suggestion = (opts.chatSuggestion ?? DEFAULT_CHAT_SUGGESTION).trim();
    this.#chatSuggestion = suggestion.length === 0 ? undefined : suggestion;
    const sink = opts.logSink ?? ((line: string) => void process.stderr.write(line));
    this.#log = (message: string) => sink(`[hermes-bridge] ${message}\n`);
    this.#pins = {
      get: (name) => this.#storage.botChatPin(name),
      set: (name, sessionId) => this.#storage.setBotChatPin(name, sessionId, this.#now()),
      entry: (name) => this.#storage.botChatPinEntry(name),
      clear: (name) => this.#storage.clearBotChatPin(name),
    };
    this.#stream = new BotChatStream({
      broadcast: this.#broadcast,
      now: this.#now,
      ...(opts.chatDeltaThrottleMs === undefined ? {} : { throttleMs: opts.chatDeltaThrottleMs }),
    });
    this.#scheduledPush =
      opts.onChatMessage === undefined
        ? undefined
        : new ScheduledPushObserver({
            rpc: this.#client,
            hidden: this.#hidden,
            binding: (runtimeId) => this.#stream.binding(runtimeId),
            deliver: (event) => {
              opts.onChatMessage?.({
                bot: event.bot,
                displayName: this.#memberInfo(event.bot).displayName,
                messageId: event.messageId,
                chatSessionId: event.chatSessionId,
                preview: event.text,
              });
            },
            log: this.#log,
          });
    this.#chat = new BotChatTurns({
      rpc: this.#client,
      broadcast: this.#broadcast,
      now: this.#now,
      log: this.#log,
      stream: this.#stream,
      // Capability 9. The turn loop learns which transcript row a send became; the database is where
      // that has to be written down, or a photo would decorate one live frame and then be gone from
      // every later read of the same conversation.
      attachments: {
        bind: (fileId, messageId) => this.#storage.bindBotChatAttachment(fileId, messageId),
        forMessage: (sessionId, messageId) =>
          this.#storage.botChatAttachmentsFor(sessionId, messageId, this.#now() - PHOTO_TTL_MS).map((row) => ({
            type: "attachment" as const,
            fileId: row.fileId,
            name: row.name,
            mimeType: row.mime,
            size: row.size,
            mediaKind: row.mime.startsWith("video/") ? "video" as const
              : row.mime.startsWith("audio/") ? "audio" as const
                : "image" as const,
          })),
        assistantMediaKeys: (sessionId, messageId) =>
          this.#storage.botChatAssistantMediaKeys(sessionId, messageId),
      },
      assistantMedia: {
        ingest: async ({ bot, sessionId, messageId, path, sourceKey }) => {
          const slot = await this.#assistantMediaLimiter.acquire();
          try {
            const dataUrl = await this.#client.readMediaDataUrl(path);
            const media = decodeAssistantMediaDataUrl(dataUrl, sniffImageType);
            this.#storage.putBotChatAttachment(
              {
                fileId: newPhotoFileId(),
                bot,
                sessionId,
                messageId,
                sourceKey,
                mime: media.mime,
                name: `${media.kind}.${media.ext}`,
                size: media.bytes.byteLength,
                bytes: media.bytes,
              },
              this.#now(),
              PHOTO_TTL_MS,
            );
          } finally {
            slot();
          }
        },
      },
      ...(opts.onChatMessage === undefined
        ? {}
        : {
            onSettledAssistantMessage: (event: {
              bot: string;
              chatSessionId: string;
              messageId: string;
              text: string;
            }) => {
              void (async () => {
                try {
                  const rows = await listBotSessions(this.#client, event.bot, 200);
                  if (!isConversationalSessionId(rows, event.chatSessionId)) return;
                  const { text, ...rest } = event;
                  opts.onChatMessage?.({
                    ...rest,
                    displayName: this.#memberInfo(event.bot).displayName,
                    preview: text,
                  });
                } catch (err) {
                  this.#log(
                    `chat push classification failed for ${event.bot}: ${
                      err instanceof Error ? err.message : "unknown"
                    }`,
                  );
                }
              })();
            },
          }),
      ...(opts.chatPollMs === undefined ? {} : { pollMs: opts.chatPollMs }),
      ...(opts.chatTurnTimeoutMs === undefined ? {} : { timeoutMs: opts.chatTurnTimeoutMs }),
    });
    this.#approvals = new BotApprovals({
      rpc: this.#client,
      // The approval leg asks the stream the same question every delta asks it -- which bot, which
      // stored session, which turn -- because an approval belongs to the turn whose bubble the user
      // is looking at, and the bindings are written in exactly one place.
      chat: {
        binding: (runtimeId) => this.#stream.binding(runtimeId),
        turnId: (runtimeId) => this.#stream.turnId(runtimeId),
      },
      broadcast: this.#broadcast,
      now: this.#now,
      log: this.#log,
      ...(opts.approvalLog === undefined ? {} : { approvalLog: opts.approvalLog }),
      ...(opts.onApproval === undefined ? {} : { raisePush: opts.onApproval }),
      ...(opts.approvalTimeoutMs === undefined ? {} : { timeoutMs: opts.approvalTimeoutMs }),
    });
    this.#toolActivity = new BotToolActivity({
      // The same pair the approval leg asks the stream for, and for the same reason: a tool step
      // belongs to the turn whose bubble the user is looking at, so `bot_tool_activity`,
      // `bot_chat_delta` and `bot_approval_pending` all name one turn for one chat.
      chat: {
        binding: (runtimeId) => this.#stream.binding(runtimeId),
        turnId: (runtimeId) => this.#stream.turnId(runtimeId),
      },
      broadcast: this.#broadcast,
      now: this.#now,
      log: this.#log,
      // Hermes replays no tool lifecycle on reconnect and persists none this gateway can read back,
      // so the steps are written here or they exist only for as long as one socket stayed open.
      store: {
        record: (step) => this.#storage.upsertBotChatToolStep(step),
      },
      ...(opts.toolActivityThrottleMs === undefined ? {} : { throttleMs: opts.toolActivityThrottleMs }),
    });
    this.#groups = new GroupRooms({
      rpc: this.#client,
      storage: this.#storage,
      broadcast: this.#broadcast,
      now: this.#now,
      log: this.#log,
      hidden: this.#hideBotChats,
      stream: this.#stream,
      memberInfo: (name) => this.#memberInfo(name),
      // Validated against a FRESH profile list rather than the roster cache: a room is written to
      // disk and its members are handed to `session.create` on the first round, and a cache that
      // still lists a bot deleted seconds ago is exactly how a room came to name a bot that Hermes
      // then auto-created back into existence. One round trip per create, whatever the member count.
      missingMembers: async (names) => {
        const known = await this.#freshProfileNames();
        return names.filter((name) => !known.has(name));
      },
      // Cache-only and deliberately unsure: an EMPTY roster means the cache has not landed yet, not
      // that every bot was deleted, and answering `false` there would make a cold start report every
      // member of every room as gone.
      memberKnown: (name) => {
        const bots = this.#storage.botRoster().bots;
        return bots.length === 0 ? undefined : bots.some((bot) => bot.name === name);
      },
      // The turn boundary's own check, and the one the cheap `memberKnown` gate cannot make: a
      // positive cache hit is a snapshot, and the whole hazard here is a member deleted since it was
      // taken. A transport failure reads as "still there" so a flaky link can never shrink a room;
      // the turn that follows fails honestly on its own.
      memberExists: async (name) => {
        try {
          return (await this.#freshProfileNames()).has(name);
        } catch {
          return true;
        }
      },
      ...(opts.onGroupEscalation === undefined ? {} : { escalate: opts.onGroupEscalation }),
      // A member turn is the same shape of wait as a 1:1 turn, so it honors the same overrides and
      // a test can scale both down together.
      ...(opts.chatPollMs === undefined ? {} : { pollMs: opts.chatPollMs }),
      ...(opts.chatTurnTimeoutMs === undefined ? {} : { turnTimeoutMs: opts.chatTurnTimeoutMs }),
      ...(opts.groupChainDelayMs === undefined ? {} : { chainDelayMs: opts.groupChainDelayMs }),
    });
  }

  /** How the protocol addresses one member: its profile name, the handle peers mention it by, and
   *  the title a transcript renders. Read from the roster cache, and DERIVED when the cache has not
   *  seen the bot (a cold start, a hidden profile), because a room whose membership silently shrinks
   *  because a cache was cold would be far worse than one whose member shows up under a plain name. */
  #memberInfo(name: string): GroupMember {
    const row = this.#storage.botRoster().bots.find((bot) => bot.name === name);
    return {
      name,
      handle: row?.handle ?? botHandle(name),
      displayName: row?.displayName ?? botDisplayName(name, null),
    };
  }

  groups(): BotGroup[] {
    return this.#groups.list();
  }

  async createGroup(name: string, members: string[]): Promise<BotGroup> {
    return this.#groups.create(name, members);
  }

  deleteGroup(name: string): void {
    this.#groups.remove(name);
  }

  groupDetail(name: string): BotGroupDetail {
    return this.#groups.detail(name);
  }

  sendGroupMessage(name: string, text: string, opts: { clientId?: string } = {}): BotGroupMessage {
    return this.#groups.send(name, text, opts);
  }

  /** Capability 10. See `BotsSurface.resolveApproval` and `approvals.ts`. */
  async resolveApproval(
    name: string,
    toolCallId: string,
    decision: BotApprovalDecision,
    deviceId: string,
  ): Promise<BotApprovalResolveOutcome> {
    return this.#approvals.resolve(name, toolCallId, decision, deviceId);
  }

  async resolveClarify(
    _name: string,
    _clarifyId: string,
    _optionId: string,
    _deviceId: string,
  ): Promise<"unsupported"> {
    return "unsupported";
  }

  /** The hermes link generation durable runtime ids are currently stamped with. Observability, and
   *  the seam a test needs to ask the storage layer the same question the bridge asks it. */
  linkGeneration(): string {
    return this.#linkGeneration;
  }

  /** Test seam: is this approval still awaiting a decision? */
  approvalPending(name: string, toolCallId: string): boolean {
    return this.#approvals.pending(name, toolCallId);
  }

  /** Test seam: resolves when the room's deliberation has finished. */
  async groupSettled(name: string): Promise<void> {
    await this.#groups.settled(name);
  }

  /** Test seam: true while a round loop holds the room. */
  groupRunning(name: string): boolean {
    return this.#groups.running(name);
  }

  /** Wires the client's events and starts it. The first roster refresh runs as soon as the link
   *  reaches online, regardless of focus, so a cold cache fills without waiting for a device. */
  start(): void {
    this.#client.onStateChange((state) => {
      if (state === "online") this.refreshSoon("hermes online");
      // A dropped socket takes any half-written draft with it. Dropping the buffers here is what
      // keeps a reconnect from resuming a reply from its middle; the reply itself still arrives
      // over the turn poll, which is the only thing that ever delivered it.
      else {
        this.#stream.reset();
        // Same argument: the completions for those steps went with the socket, and claiming an
        // outcome nobody observed would be inventing one.
        this.#toolActivity.reset();
      }
    });
    this.#client.onEvent((event) => {
      // The link generation, before anything else reads it. `gateway.ready` is the one event that
      // says "this is a live link to a hermes"; whether it is the SAME hermes as last time is what
      // `#observeReady` decides, and every durable runtime id is stamped with the answer.
      if (event.type === "gateway.ready") this.#observeReady(event.payload);
      // The token stream (`message.start` / `message.delta` / `message.complete`). Everything else
      // this gateway does with events is below; the stream reads its three types and ignores the
      // rest, chain-of-thought events emphatically included.
      this.#stream.handleEvent(event);
      this.#scheduledPush?.handleEvent(event);
      // The approval leg. Registered here, at the fan-out, and NOT as a case inside
      // `chat-stream.ts`'s switch, whose `default:` is a deliberate reasoning-leak allow-list that
      // must keep dropping everything it does not name.
      this.#approvals.handleEvent(event);
      // The tool-activity leg. Registered here at the fan-out for the same reason the approval leg
      // is, and it reads `tool.start` / `tool.complete` / `message.complete` and nothing else.
      this.#toolActivity.handleEvent(event);
      // Optional broadcasts. A gateway that never sends them is fully supported: the poll path
      // covers the same ground, just slower.
      if (event.type === "sessions.changed" || event.type === "cron.changed") {
        this.refreshSoon(event.type);
      }
      if (event.type === "sessions.changed") this.#refreshInboxSoon();
      // A cron change is the ONE broadcast that says something about routines, and it says only
      // that something changed: no job id, no profile. So every watched bot is re-read, debounced.
      if (event.type === "cron.changed") this.#refreshRoutinesSoon();
    });
    this.#client.start();
    this.#schedulePoll();
    // Once now, then hourly. The read filter is what makes expiry true; this is what makes the disk
    // go back.
    this.#sweepAttachments();
    this.#scheduleAttachmentSweep();
  }

  roster(): BotRosterView {
    const cached = this.#storage.botRoster();
    const hermesState = this.#client.state();
    return {
      bots: cached.bots,
      updatedAt: cached.updatedAt,
      stale: hermesState !== "online",
      hermesState,
    };
  }

  /** See `BotsSurface.health`. A thin reshape of the client's own snapshot: the bridge adds no
   *  state of its own here, because the socket is the only thing that knows whether sends can
   *  actually be delivered right now. */
  health(): BridgeLiveness {
    const liveness = this.#client.liveness();
    return {
      online: liveness.state === "online",
      since: liveness.since,
      reconnectAttempt: liveness.reconnectAttempt,
    };
  }

  refreshSoon(reason: string): void {
    if (this.#closed) return;
    if (this.#debounceTimer !== undefined) return;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined;
      void this.refresh(reason);
    }, CHANGE_DEBOUNCE_MS);
    this.#debounceTimer.unref();
  }

  /** Single-flight roster refresh, with a trailing run. A change that lands while a refresh is
   *  already on the wire describes state that refresh cannot have seen, so it sets a dirty flag
   *  and the in-flight run re-runs exactly once when it finishes. Without it a burst of
   *  `sessions.changed` under a slow `profiles.list` leaves the cache stale until the next poll,
   *  and with nothing focused there is no next poll.
   *
   *  Failures are logged and swallowed: the cache keeps serving, which is exactly the desktop's
   *  "showing the last good list" behavior. */
  async refresh(reason: string): Promise<void> {
    if (this.#closed) return;
    if (this.#refreshing !== undefined) {
      this.#refreshDirty = true;
      return this.#refreshing;
    }
    const run = (async () => {
      try {
        // Stamped BEFORE the call, and the same value is what the cache is stored under: it is the
        // moment this snapshot's data was asked for, so "was this local pin written after the
        // server could have seen it" has one answer, whether it is asked here or by `#serverPinOf`.
        const fetchedAt = this.#now();
        const result = await this.#client.request("profiles.list", {});
        const { profiles } = parseProfilesList(result);
        const canonicalSessions = new Map<
          string,
          Array<{
            id: string;
            kind: ReturnType<typeof sessionKind>;
            startedAt: number;
            lastActiveAt: number;
            preview: string | null;
          }>
        >();
        await Promise.all(
          profiles
            .filter((profile) => !this.#hidden.has(profile.name))
            .map(async (profile) => {
              try {
                const rows = await listBotSessions(this.#client, profile.name, 200);
                canonicalSessions.set(
                  profile.name,
                  rows.map((row) => ({
                    id: row.id,
                    kind: sessionKind(row),
                    startedAt: row.startedAt,
                    lastActiveAt: row.lastActiveAt,
                    preview: row.preview,
                  })),
                );
              } catch (err) {
                const detail = err instanceof Error ? err.message : "unknown failure";
                this.#log(`canonical roster activity unavailable for ${profile.name}: ${detail}`);
              }
            }),
        );
        const bots = buildRoster(profiles, {
          canonicalSessions,
          hidden: this.#hidden,
          pins: this.#storage.botChatPinEntries(),
          uiMetaSupported: this.#uiMetaWriteback,
          routedProfile: this.#routedProfile,
          gatewayState: this.#gatewayState(),
          now: fetchedAt,
        });
        this.#storage.replaceBotRoster(
          bots.map((summary) => ({ name: summary.name, summary })),
          fetchedAt,
        );
        this.#publish(bots, fetchedAt);
      } catch (err) {
        const detail = err instanceof Error ? err.message : "unknown failure";
        this.#log(`roster refresh failed (${reason}): ${detail}`);
      } finally {
        this.#refreshing = undefined;
        if (this.#refreshDirty && !this.#closed) {
          this.#refreshDirty = false;
          void this.refresh(`${reason} (trailing)`);
        }
      }
    })();
    this.#refreshing = run;
    return run;
  }

  /** Broadcasts only on change: an idle gateway with a steady roster is silent on the wire. */
  #publish(bots: BotSummary[], updatedAt: number): void {
    const rosterJson = JSON.stringify(bots);
    if (rosterJson !== this.#lastRosterJson) {
      this.#lastRosterJson = rosterJson;
      this.#broadcast({ type: "bot_roster", bots, updatedAt });
    }
    const active = bots.filter((bot) => bot.active).map((bot) => bot.name);
    const activeJson = JSON.stringify(active);
    if (activeJson !== this.#lastActiveJson) {
      this.#lastActiveJson = activeJson;
      this.#broadcast({ type: "bot_presence", active, updatedAt });
    }
  }

  async canonicalChat(name: string): Promise<CanonicalChatResult> {
    const inflight = this.#chatInflight.get(name);
    // De-duplicated by bot name: two taps (or two devices) must not mint two canonical chats.
    if (inflight !== undefined) return inflight;

    const run = (async () => {
      try {
        // Checked BEFORE anything routes or mints state: a name that names no profile at all must
        // never reach `resolveCanonicalChat`, which happily calls `session.create` for it (Hermes'
        // `session.create` does not itself validate the profile), minting a chat that hangs off
        // nothing a roster will ever show again.
        await this.#assertBotKnown(name);
        this.#routedProfile = name;
        this.#busyDepth += 1;
        try {
          const serverPin = await this.#serverPinOf(name);
          const result = await resolveCanonicalChat(name, {
            rpc: this.#client,
            pins: this.#pins,
            hideBotChats: this.#hideBotChats,
            serverPin,
            saveServerPin: (sessionId) => this.#saveServerPin(name, sessionId, serverPin),
            isRetired: this.#retiredOf(name),
            isUnwritten: (sessionId) => this.#storage.botChatUnwritten(name, sessionId),
            // The guard above is cache-first, so it can be satisfied by a snapshot taken before the
            // bot was deleted. That is harmless on every path but this one: minting the chat means
            // `session.create`, and Hermes 0.20.x answers that for an unknown name by CREATING the
            // profile. The cost is one round trip on the one open per bot that mints a chat.
            assertStillExists: async () => {
              if (!(await this.#freshProfileNames()).has(name)) throw new BotNotFound(name);
            },
          });
          // A chat this call created has no persisted row and cannot be resumed until the USER
          // writes to it, which may be never: remember its runtime id, durably, because that is the
          // only id their first message can be addressed to.
          if (result.adoption === "created" && result.runtimeId !== undefined) {
            this.#rememberUnwritten(name, result.sessionId, result.runtimeId);
          }
          // The pin MOVED under a device that may already be looking at the old chat (issue #88):
          // a conversation held from another device outran the pinned session and the canonical chat
          // followed it. Announced for the same reason `bot_chat_reset` is announced, and it is the
          // only case in this resolve worth a frame: every other adoption path answers "which session
          // is this bot's chat" for a caller that did not have one, while this one contradicts a
          // caller that did. Broadcast, not returned only, because the device that triggered the
          // resolve is usually not the device sitting on the stale transcript.
          if (result.previousSessionId !== undefined) {
            this.#broadcast({
              type: "bot_chat_adopted",
              bot: name,
              sessionId: result.sessionId,
              previousSessionId: result.previousSessionId,
              updatedAt: this.#now(),
            });
          }
          return result;
        } finally {
          this.#busyDepth = Math.max(0, this.#busyDepth - 1);
          // Nothing is routed once the last turn drains, so the busy leg of the presence rule stops
          // being attributed to whichever bot happened to resolve last.
          if (this.#busyDepth === 0) this.#routedProfile = null;
          this.refreshSoon("canonical chat resolved");
        }
      } finally {
        this.#chatInflight.delete(name);
      }
    })();
    this.#chatInflight.set(name, run);
    return run;
  }

  /** Mints and adopts a fresh canonical chat without retiring the one it replaces.
   *
   *  This deliberately shares the canonical-chat single-flight with open, reset, and manual
   *  adoption. Each request remains an action rather than a deduplicated read: it waits for an
   *  earlier operation, then mints the fresh session it was asked for. A canonical-chat read that
   *  arrives while this action runs joins it and receives the new pin.
   *
   *  Unlike `resetChat`, this does not cancel a turn, clear transcript state, or add the previous
   *  id to the retired set. The ordinary `bot_chat_adopted` contract therefore applies: the old
   *  session stays listed and restorable, and frames from a turn already running there may still
   *  arrive carrying that old session id.
   *
   *  `mintCanonicalChat` writes an automatic pin (`manual: false`). That is the capability-16
   *  manual-pin boundary: a manual restore is released by this explicitly new conversation, and
   *  capability-14 follow-latest may move the pin again when the next new conversation appears. */
  async newSession(name: string): Promise<BotNewSessionResult> {
    await this.#assertBotKnown(name);

    const pending = this.#chatInflight.get(name);
    if (pending !== undefined) {
      try {
        await pending;
      } catch {
        /* This action resolves the outgoing chat itself before minting its replacement. */
      }
    }

    const run = (async (): Promise<{ chat: CanonicalChatResult; previousSessionId: string }> => {
      try {
        this.#routedProfile = name;
        this.#busyDepth += 1;
        try {
          const serverPin = await this.#serverPinOf(name);
          const current = await resolveCanonicalChat(name, {
            rpc: this.#client,
            pins: this.#pins,
            hideBotChats: this.#hideBotChats,
            serverPin,
            saveServerPin: (sessionId) => this.#saveServerPin(name, sessionId, serverPin),
            isRetired: this.#retiredOf(name),
            isUnwritten: (sessionId) => this.#storage.botChatUnwritten(name, sessionId),
            assertStillExists: async () => {
              if (!(await this.#freshProfileNames()).has(name)) throw new BotNotFound(name);
            },
          });

          const minted = await mintCanonicalChat(name, {
            rpc: this.#client,
            pins: this.#pins,
            hideBotChats: this.#hideBotChats,
            assertStillExists: async () => {
              if (!(await this.#freshProfileNames()).has(name)) throw new BotNotFound(name);
            },
          });
          this.#rememberUnwritten(name, minted.storedId, minted.runtimeId);
          await this.#saveServerPin(name, minted.storedId, serverPin);

          this.#broadcast({
            type: "bot_chat_adopted",
            bot: name,
            sessionId: minted.storedId,
            previousSessionId: current.sessionId,
            updatedAt: this.#now(),
          });

          return {
            chat: { sessionId: minted.storedId, adoption: "created", runtimeId: minted.runtimeId },
            previousSessionId: current.sessionId,
          };
        } finally {
          this.#busyDepth = Math.max(0, this.#busyDepth - 1);
          if (this.#busyDepth === 0) this.#routedProfile = null;
          this.refreshSoon("new chat created");
        }
      } finally {
        this.#chatInflight.delete(name);
      }
    })();

    const joinable = run.then((result) => result.chat);
    void joinable.catch(() => {});
    this.#chatInflight.set(name, joinable);
    const result = await run;
    return { sessionId: result.chat.sessionId, previousSessionId: result.previousSessionId };
  }

  /** Retires a bot's current canonical chat and pins a fresh one in its place.
   *
   *  Say plainly what this is NOT, because the button that calls it will be labelled "clear chat"
   *  and the word promises more than the backend can deliver: Hermes exposes NO session delete on
   *  this surface. Nothing is erased. THE OLD SESSION AND ITS WHOLE TRANSCRIPT STAY ON THE HERMES
   *  HOST, untouched, and keep appearing in `session.list` and therefore in
   *  `GET /bots/:name/sessions`. The only thing this changes is which session the bot's canonical
   *  pin points at: the bot starts a new conversation, it does not forget the old one. A client that
   *  tells its user otherwise is lying on this gateway's behalf.
   *
   *  The teardown MUST precede the mint, and for the reason `deleteBot` spells out for the same
   *  three lines. A turn poll left running belongs to the RETIRED session: it would keep
   *  broadcasting `bot_chat` and `bot_chat_state` frames for a chat nobody is in any more, and every
   *  one of those polls rewrites the very watermark this reset just dropped, so the drop never takes
   *  and the new chat inherits a high-water mark from a session it has nothing to do with.
   *  `BotChatTurns.cancel` is what stops it, and cancelling cannot race the poll: the loop tests the
   *  flag at every checkpoint and returns without broadcasting.
   *
   *  The live DRAFT is torn down on the same call. `cancel` reaches through to
   *  `BotChatStream.forgetBot`, which drops the bot's runtime-session bindings and any half-drafted
   *  turn, so no `bot_chat_delta` can arrive for the retired chat once this returns. There is a
   *  second, independent guard behind it: `BotChatTurns.#startTurn` cancels a poll whose `sessionId`
   *  changed underneath it, which is exactly the shape a re-pin has, so even a poll opened in the
   *  gap would be cancelled by the first send into the new chat rather than run out its cap.
   *
   *  The retired session id is RECORDED, durably, in `bot_chat_retired`. That is not bookkeeping: the
   *  replacement is minted with the same title as the chat it replaces, so once the pin is gone
   *  nothing else tells the two apart, and the pin is losable by design (`#saveServerPin` swallows
   *  its own failures). Without the record, an adoption after a restart could pick the retired chat
   *  by title or by list position and hand the user back the conversation they cleared. With it, a
   *  retired session is never adopted, wherever it sorts. See `CanonicalChatDeps.isRetired`.
   *
   *  Mutually exclusive with `canonicalChat` by design, through the same `#chatInflight` map: a
   *  resolve that is already on the wire is awaited first (its failure is swallowed, since the reset
   *  is about to replace whatever it was resolving), and while the reset runs a concurrent resolve
   *  JOINS it and receives the new chat rather than racing the mint and answering with a session
   *  that is a moment from being retired. A second reset serializes behind the first the same way
   *  and then mints again, which is what a user tapping "clear" twice actually asked for. */
  async resetChat(name: string): Promise<ChatResetResult> {
    // Checked before anything routes or mints, the same rule `canonicalChat` states: `session.create`
    // does not validate the profile, and Hermes 0.20.x answers an unknown name by creating one.
    await this.#assertBotKnown(name);

    const pending = this.#chatInflight.get(name);
    if (pending !== undefined) {
      // Awaited, not joined: the reset needs to know what it is retiring, and a resolve that failed
      // still tells it nothing worth failing over.
      try {
        await pending;
      } catch {
        /* The chat this reset is replacing could not be resolved. It is being replaced anyway. */
      }
    }

    const run = (async (): Promise<{ chat: CanonicalChatResult; previousSessionId?: string }> => {
      try {
        this.#routedProfile = name;
        this.#busyDepth += 1;
        try {
          // Read ONCE, before anything writes: this is the pin the server carried going in, and it
          // is what tells the writeback below the difference between "the server never had a pin"
          // and "someone cleared the pin while this reset was running".
          const serverPin = await this.#serverPinOf(name);

          // What is being retired. This resolve may itself MINT a chat, for a bot nobody has ever
          // opened, and that is honest rather than wasteful: the reset then retires the chat it just
          // resolved, and the user gets the fresh chat they asked for either way.
          let previousSessionId: string | undefined;
          try {
            const current = await resolveCanonicalChat(name, {
              rpc: this.#client,
              pins: this.#pins,
              hideBotChats: this.#hideBotChats,
              serverPin,
              saveServerPin: (sessionId) => this.#saveServerPin(name, sessionId, serverPin),
              isRetired: this.#retiredOf(name),
              isUnwritten: (sessionId) => this.#storage.botChatUnwritten(name, sessionId),
              assertStillExists: async () => {
                if (!(await this.#freshProfileNames()).has(name)) throw new BotNotFound(name);
              },
            });
            previousSessionId = current.sessionId;
          } catch (err) {
            // A chat that cannot even be resolved is the strongest possible reason to want a new
            // one, so this does not fail the reset: the answer simply carries no `previousSessionId`,
            // which is the wire's way of saying there was nothing to retire.
            const detail = err instanceof Error ? err.message : "unknown";
            this.#log(`chat reset for ${name} could not resolve the outgoing chat: ${detail}`);
          }

          // Teardown BEFORE the mint. See the doc comment: order is the whole correctness argument.
          this.#chat.cancel(name);
          this.#approvals.forgetBot(name);
          this.#toolActivity.forgetBot(name);
          // The retired chat's steps go too: they described turns in a conversation the user asked
          // to leave behind, and the new chat must not open holding the old one's activity.
          this.#storage.deleteBotChatToolSteps(name);
          // The pin row goes, and the outgoing chat's runtime id goes with it. Nothing may be left
          // that could address a send at the session this reset is leaving behind.
          this.#pins.clear(name);
          // Mark the outgoing session retired, on disk, and do it BEFORE the pin is replaced so a
          // crash between the two leaves the stronger state: a session recorded as retired that no
          // pin points at is simply never adopted, whereas a pin moved without the record is the
          // hazard this set exists for. Only when there genuinely was something to retire: a reset
          // that could not resolve an outgoing chat has no id to refuse, and writing a placeholder
          // would poison the set for whatever that id later turns out to be.
          //
          // Why this outlives the process: the retired session keeps the canonical title (the mint is
          // shared with the resolve path on purpose), so the pin is the ONLY thing distinguishing it
          // from the fresh chat, and the pin can be lost, because `#saveServerPin` swallows its own
          // failures and a gateway too old to store `ui_meta` keeps the pin local to a database that
          // a restart may not carry. Adoption would then pick a "Bot Chat" by title or by list
          // position and could resurrect the conversation the user just cleared.
          if (previousSessionId !== undefined) {
            this.#storage.retireBotChat(name, previousSessionId, this.#now());
          }

          const minted = await mintCanonicalChat(name, {
            rpc: this.#client,
            pins: this.#pins,
            hideBotChats: this.#hideBotChats,
            assertStillExists: async () => {
              if (!(await this.#freshProfileNames()).has(name)) throw new BotNotFound(name);
            },
          });
          // Born empty and unlisted, exactly like a chat `canonicalChat` created: no row exists
          // until the user's first prompt, so the runtime id is what the reply to their first
          // message depends on.
          this.#rememberUnwritten(name, minted.storedId, minted.runtimeId);
          // Push the new pin cross-machine. Never allowed to fail the reset (it swallows its own
          // failures): a gateway that cannot store `ui_meta` still reset the chat, the pin just
          // stays gateway-local, which is the same trade the resolve path makes.
          await this.#saveServerPin(name, minted.storedId, serverPin);

          this.#broadcast({
            type: "bot_chat_reset",
            bot: name,
            sessionId: minted.storedId,
            ...(previousSessionId === undefined ? {} : { previousSessionId }),
            updatedAt: this.#now(),
          });

          return {
            chat: { sessionId: minted.storedId, adoption: "created", runtimeId: minted.runtimeId },
            ...(previousSessionId === undefined ? {} : { previousSessionId }),
          };
        } finally {
          this.#busyDepth = Math.max(0, this.#busyDepth - 1);
          if (this.#busyDepth === 0) this.#routedProfile = null;
          this.refreshSoon("chat reset");
        }
      } finally {
        this.#chatInflight.delete(name);
      }
    })();

    // The map is typed for what a RESOLVE answers, which is what a joining `canonicalChat` caller
    // expects, so the reset's own richer result is narrowed on the way in. The rejection handler is
    // not cosmetic: nothing awaits this derived promise when no resolve joins, and an unhandled
    // rejection on it would be reported even though `run` itself is awaited right below.
    const joinable = run.then((result) => result.chat);
    void joinable.catch(() => {});
    this.#chatInflight.set(name, joinable);
    const result = await run;
    return {
      sessionId: result.chat.sessionId,
      ...(result.previousSessionId === undefined
        ? {}
        : { previousSessionId: result.previousSessionId }),
    };
  }

  /** The retired-session test handed to `resolveCanonicalChat`, as a SNAPSHOT: the set is read once,
   *  here, rather than queried per candidate row, so one resolve costs one small SELECT instead of
   *  one per session in a list of up to a hundred. Snapshotting is also the honest reading, since the
   *  question the adoption paths ask is "what had been retired when this resolve began"; a reset that
   *  lands mid-resolve is serialized behind it by `#chatInflight` anyway. */
  #retiredOf(name: string): (sessionId: string) => boolean {
    const retired = this.#storage.botChatRetired(name);
    return (sessionId) => retired.has(sessionId);
  }

  async sessions(name: string, limit: number): Promise<BotSessionsView> {
    // Same guard as `canonicalChat`: `session.list` on an unknown profile answers empty rather than
    // an error, which without this check reads as "this bot has no sessions" instead of "this bot
    // does not exist".
    await this.#assertBotKnown(name);
    const [rows, serverPin] = await Promise.all([
      listBotSessions(this.#client, name, limit),
      this.#serverPinOf(name),
    ]);
    // Server pin first, but the SAME precedence rule resolvePin applies: `#saveServerPin` swallows
    // its own failures by design, so a local pin that is MANUAL (the user's explicit restore) or
    // UNWRITTEN (a freshly minted empty chat, invisible to session.list until its first prompt)
    // outranks a server pin that still names the chat it replaced.
    const localEntry = this.#storage.botChatPinEntry(name);
    const basePin = effectiveChatPin(
      serverPin,
      localEntry === undefined
        ? undefined
        : {
            ...localEntry,
            unwritten: this.#storage.botChatUnwritten(name, localEntry.sessionId),
          },
    );
    const activeSessionId =
      (typeof basePin === "string"
        ? followLatestChatPin(basePin, rows, {
            isConversational: isConversationalSession,
            isRetired: this.#retiredOf(name),
            manualSince:
              localEntry?.manual === true && localEntry.sessionId === basePin
                ? localEntry.updatedAt
                : undefined,
          })
        : basePin) ?? null;
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        startedAt: row.startedAt,
        lastActiveAt: row.lastActiveAt,
        kind: sessionKind(row),
        ...(row.title.length === 0 ? {} : { title: row.title }),
        ...(row.preview === null || row.preview.length === 0 ? {} : { preview: row.preview }),
      })),
      activeSessionId,
    };
  }

  /** The newest a2a sessions only, using the shared capability-14 classifier. */
  async inbox(name: string): Promise<BotInboxView> {
    await this.#assertBotKnown(name);
    const rows = (await listBotSessions(this.#client, name, INBOX_SESSION_SCAN_LIMIT))
      .filter((row) => sessionKind(row) === "a2a")
      .map((row, index) => ({ row, index }))
      .sort(
        (left, right) =>
          right.row.lastActiveAt - left.row.lastActiveAt ||
          right.row.startedAt - left.row.startedAt ||
          left.index - right.index,
      )
      .slice(0, INBOX_THREAD_LIMIT)
      .map(({ row }) => row);
    return { threads: rows.map((row) => inboxThread(row, row.messageCount ?? 0)) };
  }

  async inboxMessages(name: string, threadId: string): Promise<BotInboxMessagesView> {
    await this.#assertBotKnown(name);
    const rows = await listBotSessions(this.#client, name, INBOX_SESSION_SCAN_LIMIT);
    const row = rows.find((candidate) => candidate.id === threadId);
    if (row === undefined || sessionKind(row) !== "a2a") throw new BotSessionNotFound(threadId);
    const snapshot = await this.#inboxSnapshot(name, threadId);
    const messages = projectInboxMessages(snapshot, name, (speaker) => this.#displayNameOf(speaker));
    this.#inboxWatch.set(this.#inboxWatchKey(name, threadId), {
      bot: name,
      threadId,
      messageCount: messages.length,
      at: this.#now(),
    });
    return { messages };
  }

  async #inboxSnapshot(name: string, threadId: string) {
    return parseChatSnapshot(
      await this.#client.request("session.resume", {
        session_id: threadId,
        profile: name,
        omit_messages: false,
      }),
      threadId,
    );
  }

  #displayNameOf(name: string): string {
    return this.#storage.botRoster().bots.find((bot) => bot.name === name)?.displayName ?? botDisplayName(name, null);
  }

  #inboxWatchKey(name: string, threadId: string): string {
    return `${name}\u0000${threadId}`;
  }

  #refreshInboxSoon(): void {
    if (this.#closed || this.#inboxWatch.size === 0) return;
    if (this.#inboxRefreshing !== undefined) {
      this.#inboxRefreshDirty = true;
      return;
    }
    if (this.#inboxDebounceTimer !== undefined) return;
    this.#inboxDebounceTimer = setTimeout(() => {
      this.#inboxDebounceTimer = undefined;
      void this.#refreshOpenInbox();
    }, CHANGE_DEBOUNCE_MS);
    this.#inboxDebounceTimer.unref();
  }

  async #refreshOpenInbox(): Promise<void> {
    if (this.#inboxRefreshing !== undefined) {
      this.#inboxRefreshDirty = true;
      return this.#inboxRefreshing;
    }
    const run = (async () => {
      const cutoff = this.#now() - INBOX_WATCH_TTL_MS;
      const watched = [...this.#inboxWatch.entries()];
      for (const [key, watch] of watched) {
        if (watch.at < cutoff) {
          this.#inboxWatch.delete(key);
          continue;
        }
        try {
          const snapshot = await this.#inboxSnapshot(watch.bot, watch.threadId);
          const messageCount = projectInboxMessages(snapshot, watch.bot, (speaker) =>
            this.#displayNameOf(speaker),
          ).length;
          const current = this.#inboxWatch.get(key);
          if (current !== watch) continue;
          this.#inboxWatch.set(key, { ...watch, messageCount });
          if (messageCount > watch.messageCount) {
            this.#broadcast({
              type: "bot_inbox_activity",
              bot: watch.bot,
              threadId: watch.threadId,
              updatedAt: this.#now(),
            });
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.#log(`failed to refresh open inbox thread ${watch.bot}/${watch.threadId} (${detail})`);
        }
      }
    })();
    this.#inboxRefreshing = run;
    try {
      await run;
    } finally {
      this.#inboxRefreshing = undefined;
      if (this.#inboxRefreshDirty && !this.#closed) {
        this.#inboxRefreshDirty = false;
        this.#refreshInboxSoon();
      }
    }
  }

  /** Explicitly pins one visible Hermes session. The operation shares the canonical-chat
   *  single-flight so a simultaneous open or reset cannot race the choice. The existing adoption
   *  frame is emitted even when the selected id was already active: the user's action is also the
   *  cross-device instruction to re-read that transcript. */
  async adoptSession(name: string, sessionId: string, limit: number): Promise<BotSessionAdoption> {
    await this.#assertBotKnown(name);

    const pending = this.#chatInflight.get(name);
    if (pending !== undefined) {
      try {
        await pending;
      } catch {
        /* The manual selection validates and establishes its own pin below. */
      }
    }

    const run = (async (): Promise<BotSessionAdoption> => {
      try {
        const rows = await listBotSessions(this.#client, name, limit);
        if (!rows.some((row) => row.id === sessionId)) {
          // Session ids are gateway-wide Hermes handles. Only on a miss do the extra reads needed
          // to distinguish an unknown id (404) from one in another bot's namespace (409).
          const profiles = await this.#freshProfileNames();
          for (const profile of profiles) {
            if (profile === name) continue;
            const foreign = await listBotSessions(this.#client, profile, limit);
            if (foreign.some((row) => row.id === sessionId)) {
              throw new BotSessionConflict(sessionId, profile);
            }
          }
          throw new BotSessionNotFound(sessionId);
        }

        const serverPin = await this.#serverPinOf(name);
        const current = await resolveCanonicalChat(name, {
          rpc: this.#client,
          pins: this.#pins,
          hideBotChats: this.#hideBotChats,
          serverPin,
          saveServerPin: (resolvedId) => this.#saveServerPin(name, resolvedId, serverPin),
          isRetired: this.#retiredOf(name),
          isUnwritten: (resolvedId) => this.#storage.botChatUnwritten(name, resolvedId),
        });

        // This is the only writer of a manual pin. Every automatic PinStore.set call writes false,
        // so the flag clears at the first qualifying follow-latest adoption.
        this.#storage.restoreBotChat(name, sessionId);
        this.#storage.setBotChatPin(name, sessionId, this.#now(), true);
        await this.#saveServerPin(name, sessionId, serverPin);
        this.#broadcast({
          type: "bot_chat_adopted",
          bot: name,
          sessionId,
          previousSessionId: current.sessionId,
          updatedAt: this.#now(),
        });
        this.refreshSoon("chat manually adopted");
        return { name, sessionId, previousSessionId: current.sessionId };
      } finally {
        this.#chatInflight.delete(name);
      }
    })();

    const joinable = run.then((result): CanonicalChatResult => ({
      sessionId: result.sessionId,
      adoption: "pin",
    }));
    void joinable.catch(() => {});
    this.#chatInflight.set(name, joinable);
    return run;
  }

  /** True when `name` names no Hermes profile at all, so a bug like Hermes' own `session.create`
   *  tolerating a nonexistent profile (proven live: it happily minted a session for one) cannot
   *  leak into this API as a successful chat open.
   *
   *  Cache-first, fresh on a miss, the same shape `#serverPinOf` already uses: the roster cache
   *  answers a KNOWN bot without a round trip (a bot this bridge just created is already in it,
   *  because `createBot` awaits its own refresh before answering), and a miss is checked against a
   *  FRESH `profiles.list` rather than trusted, because the cache is also where a HIDDEN bot is
   *  never going to be (`RosterBuildOptions.hidden` filters it out on purpose) even though it stays
   *  chattable by name per the contract. A transport failure propagates rather than reading as
   *  "unknown": the route's `failure()` handler already turns that into the right 502/503/504. */
  async #assertBotKnown(name: string): Promise<void> {
    const cached = this.#storage.botRoster().bots.some((bot) => bot.name === name);
    if (cached) return;
    if (!(await this.#freshProfileNames()).has(name)) throw new BotNotFound(name);
  }

  /** Every profile name Hermes reports RIGHT NOW, cache untouched.
   *
   *  The cache-first arm of `#assertBotKnown` answers a positive from a SNAPSHOT, and a snapshot can
   *  only ever be as young as the last refresh. That is the right trade for a read route, where a
   *  stale yes costs one 404 that Hermes itself hands back a moment later. It is the wrong trade
   *  anywhere a stale yes reaches `session.create`, because Hermes 0.20.x AUTO-CREATES a profile for
   *  a name it does not know: a deleted bot comes back as a bare profile, and no later refresh can
   *  tell it apart from a real one. Those callers ask this instead.
   *
   *  There are exactly three, and the survey behind that number is worth keeping: room CREATE (the
   *  membership is durable and its first round mints sessions), the member TURN boundary (see
   *  `GroupRooms`), and the canonical chat's CREATE arm. Everything else that reaches a session was
   *  checked and does not need it. The chat turn poll and the group poll only ever `session.resume`
   *  or `prompt.submit` an id that already exists, which a Hermes with no such session refuses
   *  rather than invents; the adopt arms of `resolveCanonicalChat` resolve a session that is already
   *  there; and the routines routes speak only `cron.manage`, behind `#assertBotKnown`, and mint no
   *  profile of their own. */
  async #freshProfileNames(): Promise<Set<string>> {
    const { profiles } = parseProfilesList(await this.#client.request("profiles.list", {}));
    return new Set(profiles.map((profile) => profile.name));
  }

  /** History of a bot's canonical chat. Resolving the chat first is what makes this route usable
   *  as the app's only entry point: the app never has to know a session id.
   *
   *  A chat nobody has written in has no resumable row (dissection 5.1) and Hermes answers a resume
   *  of it with an error. That case reads as an EMPTY history rather than a failure. Any other
   *  failure propagates so the route can pass the Hermes text through verbatim.
   *
   *  What decides which of the two it is: whether this gateway is holding a runtime id for exactly
   *  this session, which is the durable record that it minted the chat and nothing has been said in
   *  it since (`Storage.botChatRuntimeId`). NOT `adoption`, which only says `created` on the call
   *  that did the creating -- the second open (open bot, resolve, read history: the exact sequence
   *  the app performs) correctly answers `pin`, and gating on `created` made that second read a 502
   *  for the one scenario this whole path exists for. And no longer a 180 s WINDOW either, which was
   *  right only while an auto-submitted kickoff meant the row was seconds away: capability 11 sends
   *  nothing, so "unresumable" is the resting state of an untouched chat and a timer would turn every
   *  chat older than three minutes into a 502.
   *
   *  The empty transcript is where `suggestion` rides, on both arms, because both arms describe the
   *  same thing to the user: a chat with nothing in it yet. */
  async chatHistory(name: string): Promise<BotChatHistory> {
    const chat = await this.canonicalChat(name);
    try {
      const snapshot = await this.#chat.history(name, chat.sessionId);
      // The session resumed, so it has a row: the runtime id is stale from here on.
      this.#storage.clearBotChatRuntimeId(name, chat.sessionId);
      // Capability 12 is a strip of chips riding alongside the transcript, not part of it. A
      // failure reading it (cozygateway#65: same SQLITE_BUSY/disk exposure as the write side)
      // degrades to "no tool steps this read" rather than failing the whole history response --
      // the transcript hermes already returned is real and worth serving on its own.
      let steps: ReturnType<typeof groupToolSteps> = [];
      try {
        steps = groupToolSteps(
          this.#storage.botChatToolSteps(chat.sessionId, this.#now() - TOOL_STEP_TTL_MS),
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.#log(`failed to read tool steps for ${name}; serving history without them (${detail})`);
      }
      return {
        sessionId: chat.sessionId,
        adoption: chat.adoption,
        messages: snapshot.messages,
        running: snapshot.running,
        inflight: snapshot.inflight,
        // Capability 12. Absent, not empty, on a chat that has run no tools, so a client below 12 is
        // unaffected and one at 12 can tell "nothing happened" from "nothing was recorded".
        ...(steps.length === 0 ? {} : { toolSteps: steps }),
        updatedAt: this.#now(),
        ...this.#suggestionFor(snapshot.messages),
      };
    } catch (err) {
      // Generation-BLIND on purpose (`botChatUnwritten`, not `botChatRuntimeId`): the question here
      // is whether the chat is empty, not whether it can still be addressed. A chat orphaned by a
      // hermes restart is empty, and answering the resume failure instead would 502 the whole screen
      // and put the composer out of reach -- the composer whose first send is what heals the chat.
      if (!this.#storage.botChatUnwritten(name, chat.sessionId)) throw err;
      return {
        sessionId: chat.sessionId,
        adoption: chat.adoption,
        messages: [],
        running: false,
        inflight: false,
        updatedAt: this.#now(),
        ...this.#suggestionFor([]),
      };
    }
  }

  /** The `suggestion` field, or nothing at all. Two conditions, both required: the transcript is
   *  empty (a suggestion next to an existing conversation is noise, and worse, it invites a client to
   *  re-offer an opener the user already answered) and this deployment configured one. */
  #suggestionFor(messages: BotChatMessage[]): { suggestion?: string } {
    if (messages.length > 0 || this.#chatSuggestion === undefined) return {};
    return { suggestion: this.#chatSuggestion };
  }

  /** Records, durably, that `sessionId` is a chat this gateway minted and nobody has written in, so
   *  the user's first message can be addressed at all. See `Storage.setBotChatRuntimeId`.
   *
   *  Stamped with the CURRENT link generation, which is what makes the record expire with the hermes
   *  that issued it rather than outliving it (issue #66). */
  #rememberUnwritten(name: string, sessionId: string, runtimeId: string): void {
    this.#storage.setBotChatRuntimeId(name, sessionId, runtimeId, this.#linkGeneration);
  }

  /** Settles the link generation for the link that just came up.
   *
   *  Three cases, and the middle one is the one worth naming. Hermes reporting an identity of its own
   *  is the strong answer: it is true across a gateway restart and false across a hermes restart,
   *  which is exactly the question being asked. The FIRST ready of this process with no identity
   *  keeps whatever the database carried, because a gateway starting up has learned nothing about
   *  hermes having restarted and inventing a new generation here would throw away every runtime id
   *  the gateway legitimately still holds (the PR #61 win). Every LATER ready with no identity
   *  followed a disconnect, and a disconnect is what a hermes restart looks like from this side, so
   *  the generation moves on. That is deliberately conservative in one direction only: a hermes that
   *  merely blipped costs the unwritten chats a re-mint on their first send, which the user sees as a
   *  chat that works, while trusting a stale id costs them a message that silently goes nowhere. */
  #observeReady(payload: unknown): void {
    const identity = readyIdentity(payload);
    const previous = this.#linkGeneration;
    const next =
      identity !== undefined
        ? `hermes:${identity}`
        : this.#sawReady
          ? nextLocalGeneration(previous)
          : previous;
    this.#sawReady = true;
    if (next !== previous) {
      this.#linkGeneration = next;
      this.#log(`hermes link generation is now ${next}; runtime ids from ${previous} are no longer addressable`);
    }
    // The write is guarded for the reason cozygateway#65 gives (SQLITE_BUSY and friends are real on
    // this path) and for one more that belongs to where this runs: it is the FIRST thing in the
    // bridge's event fan-out, so an exception here would take the token stream, the approvals leg and
    // the tool-activity leg down with it for that frame. The in-memory generation above is what this
    // process actually enforces; failing to write it down costs only the next process's memory of it,
    // and that process re-derives a fresh one on its first reconnect.
    try {
      // Persisted even when unchanged, but only when the database has never held one: a database
      // that answers `undefined` after a restart would re-seed a different generation and throw away
      // every runtime id the gateway legitimately still holds.
      if (next !== previous || this.#storage.hermesLinkGeneration() === undefined) {
        this.#storage.setHermesLinkGeneration(next);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#log(`could not record the hermes link generation ${next}; it holds in memory only (${detail})`);
    }
  }

  /** Submits into the canonical chat and leaves a turn poll running behind it. The reply is
   *  delivered over `/ws`, never in this response.
   *
   *  The runtime id of a chat nobody has written in is handed down: that session has no row to
   *  resume, and `prompt.submit` accepts nothing else. Since capability 11 that is the state EVERY
   *  chat starts in and stays in until this very call, so the id is read from the durable record
   *  rather than from memory -- a restart in between is ordinary now, not a two-second race.
   *
   *  When BOTH of those fail -- the stored session cannot be resumed and no runtime id addresses it
   *  either -- the chat is not merely erroring, it is gone, and it cannot come back: hermes restarted
   *  under an unwritten chat, the session it was holding was never persisted, and nothing on either
   *  side can resurrect it. Left alone that pinned chat answers 502 on EVERY send, forever, until
   *  somebody thinks to press reset (issue #66, live on the household box the night hermes crashed:
   *  6 of 7 pins were carrying an unwritten chat). So the send heals it instead of reporting it: the
   *  dead chat is retired, a replacement is minted through the very same path a reset uses, the
   *  user's message goes into the new chat and the route answers 202.
   *
   *  Re-homing is ANNOUNCED, not silent, and that is what makes it safe for a client that caches the
   *  session id: the heal goes through `resetChat`, so every device gets the ordinary
   *  `bot_chat_reset` frame (capability 8) naming the new session and the one it replaced, which is
   *  the frame they already handle, and this call answers with the new `sessionId` in the 202 body.
   *  A client that keys its transcript on the session id therefore learns the id changed by the same
   *  mechanism it learns it from a user-initiated reset.
   *
   *  Exactly one heal per send. A second failure is the honest error the route was always going to
   *  report, and retrying a mint in a loop would answer a broken hermes by filling it with chats. */
  async sendChatMessage(
    name: string,
    text: string,
    opts: { clientId?: string } = {},
  ): Promise<{ sessionId: string; message: BotChatMessage }> {
    const chat = await this.canonicalChat(name);
    const runtimeId =
      chat.runtimeId ?? this.#storage.botChatRuntimeId(name, chat.sessionId, this.#linkGeneration);
    try {
      const message = await this.#chat.send(name, chat.sessionId, text, {
        ...(runtimeId === undefined ? {} : { runtimeId }),
        ...(opts.clientId === undefined ? {} : { clientId: opts.clientId }),
      });
      return { sessionId: chat.sessionId, message };
    } catch (err) {
      // Only the unaddressable shape heals. A send that HAD a runtime id got as far as
      // `prompt.submit`, so its failure describes the submit and not a missing session, and a send
      // that failed for any other reason (the link is down, hermes refused the prompt) is a failure
      // a re-mint cannot fix and would only hide behind a brand new empty chat.
      if (runtimeId !== undefined || !isChatSessionGone(err)) throw err;
      const detail = err instanceof Error ? err.message : "unknown";
      this.#log(`${name}'s pinned chat could not be addressed (${detail}); minting a replacement and re-sending`);
      const healed = await this.resetChat(name);
      // Re-cache the roster before anything else resolves this bot. The cached `ui_meta` blob still
      // names the DEAD session, and a cached blob that names a chat is preferred over the local pin
      // (`resolveChatPin`), so the next open inside the debounce window would re-pin the chat that
      // was just retired and drop the replacement's runtime id with it. The reset path already asks
      // for this refresh; the heal waits for it, because the very next thing a healing client does
      // is read the chat back.
      await this.refresh("chat re-homed after a lost session");
      const healedRuntimeId = this.#storage.botChatRuntimeId(name, healed.sessionId, this.#linkGeneration);
      const message = await this.#chat.send(name, healed.sessionId, text, {
        ...(healedRuntimeId === undefined ? {} : { runtimeId: healedRuntimeId }),
        ...(opts.clientId === undefined ? {} : { clientId: opts.clientId }),
      });
      return { sessionId: healed.sessionId, message };
    }
  }

  /** Hard-stops the in-flight canonical-chat turn, when this bridge owns one. */
  async stopChat(name: string): Promise<"stopped" | "idle"> {
    return this.#chat.stop(name);
  }

  /** One photo, with its caption, into the canonical chat (capability 9).
   *
   *  The gateway's own copy is written FIRST, before hermes hears about the picture at all, and that
   *  ordering is deliberate. The id in the `attachment` block has to exist as a servable file the
   *  instant the 202 body carries it, or the sender's optimistic bubble points at a 404 for as long
   *  as the write takes. The cost of that ordering is an orphaned row when the send then fails, which
   *  is paid for below: a failed send deletes its own bytes, so a refused upload leaves nothing
   *  behind. Losing the delete (a crash between the two) leaves an unbound row, and an unbound row is
   *  swept by the TTL like any other.
   *
   *  What this deliberately does NOT do is reach for the file hermes wrote from the same bytes. That
   *  file lives at an absolute path on the hermes host, and `GET /bots/:name/media` already refuses
   *  to serve local paths because doing so from an authenticated route is a file-read primitive over
   *  the whole box. The copy served back to devices is the one the device itself uploaded: this
   *  gateway owns it, and it never came out of model output. */
  async sendChatPhoto(
    name: string,
    photo: BotChatPhotoUpload,
  ): Promise<{ sessionId: string; message: BotChatMessage }> {
    const chat = await this.canonicalChat(name);
    // Generation-scoped, exactly as the text send is: a runtime id from a hermes that has since
    // restarted addresses nothing, and a photo submitted at it would be accepted into a phantom
    // session. No re-mint here, deliberately -- a photo send that fails deletes its own bytes and the
    // client still holds the picture to retry, so the failure is recoverable in a way a lost text is
    // not, and re-sending the bytes into a chat the user has not been told about yet is not something
    // this path should decide on their behalf.
    const runtimeId =
      chat.runtimeId ?? this.#storage.botChatRuntimeId(name, chat.sessionId, this.#linkGeneration);

    const fileId = newPhotoFileId();
    const displayName = photoDisplayName(photo.ext);
    this.#storage.putBotChatAttachment(
      {
        fileId,
        bot: name,
        sessionId: chat.sessionId,
        mime: photo.mime,
        name: displayName,
        size: photo.bytes.byteLength,
        bytes: photo.bytes,
      },
      this.#now(),
      PHOTO_TTL_MS,
    );

    try {
      const message = await this.#chat.send(name, chat.sessionId, photo.text, {
        ...(runtimeId === undefined ? {} : { runtimeId }),
        ...(photo.clientId === undefined ? {} : { clientId: photo.clientId }),
        photo: {
          fileId,
          // Raw base64, no `data:` prefix. Hermes tolerates the prefix and tolerates embedded
          // whitespace, but tolerance is not a contract and the plain form is what its own docstring
          // documents.
          contentBase64: Buffer.from(photo.bytes).toString("base64"),
          // The only thing hermes uses a filename for is the extension, and this one is generated
          // from the sniffed bytes. The client's own filename never leaves the request.
          filename: displayName,
          block: {
            type: "attachment",
            fileId,
            name: displayName,
            mimeType: photo.mime,
            size: photo.bytes.byteLength,
          },
        },
      });
      return { sessionId: chat.sessionId, message };
    } catch (err) {
      // Nothing was submitted (the attach runs before the submit and fails the send), so there is no
      // transcript row for these bytes and never will be. Keeping them would be keeping a picture no
      // message points at, for two weeks, in the household's database.
      this.#storage.deleteBotChatAttachment(fileId);
      throw err;
    }
  }

  /** The gateway's own copy of a photo, by opaque id, scoped to the bot the route named AND to the
   *  TTL. A photo past its expiry is not found, whether or not a sweep has got to it yet: the
   *  contract promises a 404 after 14 days, and a promise that depends on a timer having fired is not
   *  a promise. */
  chatAttachmentInfo(name: string, fileId: string): BotChatAttachmentInfo | undefined {
    return this.#storage.botChatAttachmentInfo(name, fileId, this.#now() - PHOTO_TTL_MS);
  }

  chatAttachmentSlice(name: string, fileId: string, offset: number, length: number): Uint8Array | undefined {
    return this.#storage.botChatAttachmentSlice(name, fileId, this.#now() - PHOTO_TTL_MS, offset, length);
  }

  /** Reclaims the disk behind photos the reads above have already stopped serving.
   *
   *  Purely housekeeping, which is exactly why it is allowed to be a lazy timer: correctness lives in
   *  the read filter, and this only decides how long the bytes linger on disk after they have become
   *  unreachable. It runs once at `start()` (so a gateway that is restarted occasionally sweeps even
   *  if it never stays up an hour) and then hourly, unref'd so it can never hold the process open. */
  #sweepAttachments(): void {
    try {
      const dropped = this.#storage.sweepBotChatAttachments(this.#now(), PHOTO_TTL_MS);
      if (dropped > 0) this.#log(`swept ${dropped} expired chat photo(s)`);
      // Tool steps ride the same hourly pass. They are rows rather than bytes, so the TTL is much
      // longer: the point of persisting them at all is that a chip strip can be expanded long after
      // the turn, and a strip that vanished after a week would defeat that.
      const steps = this.#storage.sweepBotChatToolSteps(this.#now(), TOOL_STEP_TTL_MS);
      if (steps > 0) this.#log(`swept ${steps} expired tool step(s)`);
    } catch (err) {
      // Never fatal: a sweep that cannot run costs disk, and the reads have already stopped serving
      // whatever it would have dropped.
      this.#log(`chat photo sweep failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  #scheduleAttachmentSweep(): void {
    if (this.#closed) return;
    this.#sweepTimer = setTimeout(() => {
      this.#sweepAttachments();
      this.#scheduleAttachmentSweep();
    }, this.#sweepMs);
    this.#sweepTimer.unref();
  }

  /** Creates a bot, then refreshes the roster so the caller receives the same row every device is
   *  about to get on its `bot_roster` frame rather than one this method invented.
   *
   *  The refresh is awaited on purpose: `POST /bots` answering 201 with a row the very next
   *  `GET /bots` does not carry is an inconsistency an app cannot resolve without a manual
   *  refresh. When the bot is not in the refreshed roster (the operator hid its name, or the
   *  refresh itself failed) the row is synthesized from what was just written, so the response is
   *  a complete `BotSummary` either way. */
  async createBot(input: BotCreateRequest): Promise<BotCreated> {
    // Single-flight by name, the same rule `canonicalChat` uses. Upstream's `create_profile` races
    // on the filesystem and answers the loser with `FileExistsError` -> 4062 -> 409, so this is not
    // what makes concurrent creates safe; it is what keeps the SECOND tap from spending a create,
    // a configure and a roster refresh to learn that, and what makes two devices creating the same
    // bot at the same instant answer the same 201 with the same row.
    const key = input.name.trim().toLowerCase();
    const inflight = this.#createInflight.get(key);
    if (inflight !== undefined) return inflight;

    const run = (async () => {
      try {
        const created = await createBotProfile(this.#client, input, this.#now(), this.#bridgeProfile);
        await this.refresh(`bot ${created.name} created`);
        const row = this.#storage.botRoster().bots.find((bot) => bot.name === created.name);
        return {
          bot: row ?? synthesizeSummary(created),
          metaOutcome: created.metaOutcome,
          ...(created.metaError === undefined ? {} : { metaError: created.metaError }),
        };
      } finally {
        this.#createInflight.delete(key);
      }
    })();
    this.#createInflight.set(key, run);
    return run;
  }

  /** Deletes a bot's profile and forgets everything this gateway held about it.
   *
   *  Order matters: Hermes first, cache second. A cache cleared ahead of a delete that then fails
   *  (a blocked command, a backend still holding the profile directory open) would leave the bot
   *  on the roster with its canonical-chat pin thrown away, and the next open would mint a SECOND
   *  chat on a bot that still exists. Failing first means nothing local changed. */
  async deleteBot(name: string): Promise<DeletePath> {
    // Validated and canonicalized BEFORE anything goes on the wire, by the same rule create uses:
    // this name is about to be interpolated into a `cli.exec` argv that this gateway builds itself.
    const canonical = validateExistingBotName(name);
    if (this.#bridgeProfile !== undefined && canonical === this.#bridgeProfile) {
      throw new BotDeleteRefused(
        `"${canonical}" is the profile this gateway's own Hermes link runs on and cannot be deleted from here`,
      );
    }

    const path = await deleteBotProfile(this.#client, canonical, this.#deleteTimeoutMs);
    // Only reached when Hermes CONFIRMED the delete. A timeout or a dropped socket throws above and
    // leaves every local record intact, because a delete that may still be running is not a delete
    // that happened.
    this.#storage.forgetBot(canonical);
    // The live turn poll goes with it. Left running it keeps broadcasting `bot_chat` /
    // `bot_chat_state` frames for a bot that is no longer on the roster, and its next poll rewrites
    // the very watermark `forget` just dropped.
    this.#chat.cancel(canonical);
    this.#approvals.forgetBot(canonical);
    this.#toolActivity.forgetBot(canonical);
    this.#chatInflight.delete(canonical);
    // The unwritten-chat runtime id needs no line of its own: `forgetBot` drops the whole pin row it
    // lives on.
    // Nothing left to watch: a deleted profile's cron store goes with it, and a `cron.changed` that
    // kept re-reading it would spend a round trip per burst on a 404.
    this.#routineWatch.delete(canonical);
    this.#lastRoutinesJson.delete(canonical);
    await this.refresh(`bot ${canonical} deleted`);
    return path;
  }

  /** One bot's edit-screen state.
   *
   *  `#assertBotKnown` runs first for the same reason every other `/bots/:name` route runs it: a
   *  HIDDEN bot must stay editable by name (the hide list is a roster filter, not an access rule,
   *  and chat already works that way), while a name that names no profile at all must read as the
   *  404 it is. Upstream's own `profiles.describe` answers 4064 for a missing profile, which would
   *  surface as a 502 carrying Hermes' text instead of the 404 this API promises. */
  async botProfile(name: string): Promise<BotProfile> {
    await this.#assertBotKnown(name);
    return readBotProfile(this.#client, name);
  }

  /** Applies an edit. Nothing is cached and nothing is derived: the reply is Hermes' own per-section
   *  verdict, echoed. A write can change what a bot can do (skills, toolsets, MCP), which is what
   *  the roster's descriptions and the prompt builder's capability epoch key on, so the roster is
   *  refreshed behind it.
   *
   *  SERIALIZED PER BOT, and this is a correctness rule rather than an economy. Upstream's
   *  `profiles.configure` runs on a worker pool and performs up to THREE separate load/save cycles
   *  in one call (skills, then toolsets, then MCP). Its config lock is held inside each save, so it
   *  makes one WRITE atomic, not the read-modify-write around it, and each save rewrites the whole
   *  document. Two overlapping configures therefore silently lose the loser's sections. The desktop
   *  never hit this because it is one client; a gateway is the surface where two phones, or a phone
   *  and a desktop, save the same bot.
   *
   *  A CHAIN, not the dedupe `canonicalChat` and `createBot` use: the second write asked for
   *  something different from the first and must still happen, just after it. The chain link is
   *  installed before awaiting, so a third caller queues behind the second rather than behind the
   *  first. A failed write does not poison the queue (the tail is caught), and a chain whose tail
   *  is still the promise that just settled is deleted, so an idle bot leaves nothing behind.
   *
   *  It bounds nothing across gateways: a desktop writing the same profile directly still races
   *  upstream. Serializing what this gateway can see is the half that is ours to fix. */
  async configureProfile(name: string, patch: BotProfilePatch): Promise<ProfileConfigureResult> {
    await this.#assertBotKnown(name);
    const previous = this.#configureChain.get(name);
    const run = (async () => {
      // A predecessor's failure is not this write's failure, so the wait swallows it.
      if (previous !== undefined) await previous.catch(() => {});
      try {
        return await configureBotProfile(this.#client, name, patch);
      } finally {
        this.refreshSoon(`profile ${name} configured`);
      }
    })();
    this.#configureChain.set(name, run);
    try {
      return await run;
    } finally {
      if (this.#configureChain.get(name) === run) this.#configureChain.delete(name);
    }
  }

  async modelConfig(name: string): Promise<BotModelConfig> {
    await this.#assertBotKnown(name);
    return readBotModelConfig(this.#client, name);
  }

  async configureModel(name: string, patch: BotModelConfigPatch): Promise<BotModelConfig> {
    await this.#assertBotKnown(name);
    const previous = this.#configureChain.get(name);
    const run = (async () => {
      if (previous !== undefined) await previous.catch(() => {});
      return writeBotModelConfig(this.#client, name, patch);
    })();
    this.#configureChain.set(name, run);
    try {
      return await run;
    } finally {
      if (this.#configureChain.get(name) === run) this.#configureChain.delete(name);
    }
  }

  /** The edit screen's menus, briefly cached per skill query.
   *
   *  Single-flight AND cached: opening the screen on two devices at once, or a client that reads
   *  the catalog on every tab switch, must cost one round of three calls rather than one per read.
   *
   *  A TRANSPORT failure is not cached at all: it throws out of `readBotCatalog` before anything is
   *  stored, so a gateway that was down when the screen opened is retried on the next read rather
   *  than serving an empty catalog for a minute.
   *
   *  A DEGRADED answer (one section's RPC rejected, the rest fine) is cached, but only for
   *  `CATALOG_DEGRADED_TTL_MS`. It used to take the full minute, which is how a single flaky
   *  `model.options` refresh pinned an empty model picker in front of a user for 60 s under a
   *  message that reads "your gateway is too old". A few seconds keeps a struggling gateway from
   *  being hammered per keystroke without turning one bad moment into a stuck screen. */
  async catalog(query: string): Promise<BotCatalog> {
    const key = query;
    const cached = this.#catalogCache.get(key);
    if (cached !== undefined && this.#now() - cached.fetchedAt < cached.ttlMs) return cached.catalog;
    const inflight = this.#catalogInflight.get(key);
    if (inflight !== undefined) return inflight;

    const run = (async () => {
      try {
        const fetchedAt = this.#now();
        const catalog = await readBotCatalog(this.#client, query, fetchedAt);
        const ttlMs = catalog.unavailable.length === 0 ? this.#catalogTtlMs : this.#catalogDegradedTtlMs;
        this.#rememberCatalog(key, { catalog, fetchedAt, ttlMs });
        return catalog;
      } finally {
        this.#catalogInflight.delete(key);
      }
    })();
    this.#catalogInflight.set(key, run);
    return run;
  }

  /** Stores one catalog answer, sweeping the cache on the way in.
   *
   *  The key is the client's own search string, so the key SPACE is client-chosen: an edit screen
   *  reading per keystroke mints one entry per prefix, each holding a full skills + MCP + models
   *  payload, and the query-length cap on the route bounds the key, not the number of keys. Expired
   *  entries go first (they are dead weight by definition), and if that is not enough the oldest
   *  insertion is evicted, which `Map` iteration order hands over for free. */
  #rememberCatalog(key: string, entry: CachedCatalog): void {
    const now = this.#now();
    for (const [cachedKey, cached] of this.#catalogCache) {
      if (now - cached.fetchedAt >= cached.ttlMs) this.#catalogCache.delete(cachedKey);
    }
    this.#catalogCache.set(key, entry);
    while (this.#catalogCache.size > CATALOG_CACHE_MAX) {
      const oldest = this.#catalogCache.keys().next();
      if (oldest.done === true) break;
      this.#catalogCache.delete(oldest.value);
    }
  }

  /** One bot's routines, read fresh.
   *
   *  Not cached: a routines pane is opened deliberately and rarely, the answer carries next-run
   *  times that go stale by the second, and the read has a SIDE EFFECT (the legacy auto-pause) that
   *  a cache would skip. What is shared is the call itself, so two devices opening the pane together
   *  cost one round trip and one pause attempt.
   *
   *  Reading also arms the `cron.changed` fan-out for this bot, which is what turns a one-shot read
   *  into a live pane without any client polling. */
  async routines(name: string): Promise<BotRoutineList> {
    await this.#assertBotKnown(name);
    return this.#readRoutines(name);
  }

  /** Creates a routine and broadcasts the bot's new list.
   *
   *  The list is re-read rather than assembled from the create's own answer: the backend normalizes
   *  a schedule on the way in, and a client watching `bot_routines` must not see a row that
   *  disagrees with the one the next read produces. */
  async createRoutine(name: string, input: BotRoutineCreateRequest): Promise<RoutineWriteResult> {
    await this.#assertBotKnown(name);
    return this.#chainRoutineWrite(name, async () => {
      // Publish in `finally`: a failed write can still have MOVED state (an add that landed but
      // could not be read back, a pause taken before a replacement that was never confirmed), and
      // a client watching `bot_routines` must not keep showing the pre-write rows.
      try {
        const created = await createBotRoutine(this.#client, name, input, this.#bridgeProfile);
        // Surveyed Hermes has session-lifetime `session.create {model, provider,
        // reasoning_effort}`, but no single-turn equivalent. Its authenticated
        // `cron.manage {action:"add"}` forwards schedule/prompt/repeat/continuity only, so these
        // stay inert metadata. Never set and restore the profile around a run.
        const overrides = {
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
        };
        this.#storage.setBotRoutineOverrides(name, created.id, overrides);
        return { routine: { ...created, ...overrides } };
      } finally {
        await this.#publishRoutines(name);
      }
    });
  }

  async patchRoutine(name: string, id: string, patch: BotRoutinePatch): Promise<RoutineWriteResult> {
    await this.#assertBotKnown(name);
    return this.#chainRoutineWrite(name, async () => {
      try {
        const existing = this.#storage.botRoutineOverrides(name, id) ?? {};
        const result = await patchBotRoutine(this.#client, name, id, patch, this.#bridgeProfile);
        const overrides = {
          ...existing,
          ...(patch.model === undefined ? {} : { model: patch.model }),
          ...(patch.effort === undefined ? {} : { effort: patch.effort }),
        };
        if (result.routine.id !== id) this.#storage.deleteBotRoutineOverrides(name, id);
        this.#storage.setBotRoutineOverrides(name, result.routine.id, overrides);
        return { ...result, routine: { ...result.routine, ...overrides } };
      } finally {
        await this.#publishRoutines(name);
      }
    });
  }

  async deleteRoutine(name: string, id: string): Promise<void> {
    await this.#assertBotKnown(name);
    await this.#chainRoutineWrite(name, async () => {
      await deleteBotRoutine(this.#client, name, id);
      this.#storage.deleteBotRoutineOverrides(name, id);
      await this.#publishRoutines(name);
    });
  }

  /** Runs one routine write for a bot, SERIALIZED behind that bot's other routine writes.
   *
   *  A correctness rule, not an economy, and the same one `configureProfile` follows. `cron.manage`
   *  has no update action, so an edit is a read-modify-write across four separate RPCs (find, pause,
   *  add, remove). Two overlapping edits of the same routine both find the job, both pause it, both
   *  add a replacement, and both remove the same old one, which leaves the user with ONE routine on
   *  their screen and TWO live cron jobs firing forever. A double-tapped Save on a phone is the
   *  ordinary path into that, and a scheduler that quietly doubles is the worst kind of bug because
   *  nothing on the surface shows it.
   *
   *  A chain rather than a dedupe: the second write asked for something different and must still
   *  happen, just after the first. The link is installed before awaiting, so a third caller queues
   *  behind the second. A failed write does not poison the queue (the wait swallows its predecessor's
   *  failure), and a chain whose tail is the promise that just settled is dropped, so an idle bot
   *  leaves nothing behind. It bounds this gateway only: a desktop editing the same cron store still
   *  races upstream, and serializing what we can see is the half that is ours. */
  async #chainRoutineWrite<T>(name: string, write: () => Promise<T>): Promise<T> {
    const previous = this.#routineWriteChain.get(name);
    const run = (async () => {
      if (previous !== undefined) await previous.catch(() => {});
      return write();
    })();
    this.#routineWriteChain.set(name, run);
    try {
      return await run;
    } finally {
      if (this.#routineWriteChain.get(name) === run) this.#routineWriteChain.delete(name);
    }
  }

  /** Reads a bot's routines, single-flight, and broadcasts when the list actually changed. */
  async #readRoutines(name: string, opts: { renew?: boolean; fresh?: boolean } = {}): Promise<BotRoutineList> {
    if (opts.fresh === true) {
      // A read that STARTED before this gateway's write cannot describe the store after it. Joining
      // it would broadcast the pre-write list and cache it in `#lastRoutinesJson`, which then
      // suppresses the correct frame as "unchanged" and leaves every client a poll behind.
      for (let guard = 0; guard < 4; guard += 1) {
        const pending = this.#routineInflight.get(name);
        if (pending === undefined) break;
        await pending.catch(() => {});
      }
    }
    const inflight = this.#routineInflight.get(name);
    if (inflight !== undefined) return inflight;
    const run = (async () => {
      try {
        const listed = await listBotRoutines(this.#client, name);
        const routines = listed.routines.map((routine) => ({
          ...routine,
          ...(this.#storage.botRoutineOverrides(name, routine.id) ?? {}),
        }));
        const view: BotRoutineList = { name, routines, updatedAt: this.#now() };
        // A read the fan-out itself performed does NOT renew the watch. Renewing it would make a
        // gateway with steady cron traffic keep every bot ever opened warm forever, which is the
        // one thing the TTL exists to prevent.
        if (opts.renew !== false) this.#routineWatch.set(name, this.#now());
        this.#publishRoutineFrame(view);
        return view;
      } finally {
        this.#routineInflight.delete(name);
      }
    })();
    this.#routineInflight.set(name, run);
    return run;
  }

  /** Re-reads a bot's routines after this gateway changed them. Never fails the write that caused
   *  it: the change landed, and a broadcast that could not be built is a missing frame, not a failed
   *  operation. The client's own response already carries the row. */
  async #publishRoutines(name: string, opts: { renew?: boolean } = {}): Promise<void> {
    try {
      await this.#readRoutines(name, { ...opts, fresh: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown failure";
      this.#log(`routines refresh failed for ${name}: ${detail}`);
    }
  }

  #publishRoutineFrame(view: BotRoutineList): void {
    const json = JSON.stringify(view.routines);
    if (this.#lastRoutinesJson.get(view.name) === json) return;
    this.#lastRoutinesJson.set(view.name, json);
    this.#broadcast({ type: "bot_routines", bot: view.name, routines: view.routines, updatedAt: view.updatedAt });
  }

  /** Debounced fan-out over the watched bots. A burst of `cron.changed` during one edit costs one
   *  read per watched bot, not one per event. */
  #refreshRoutinesSoon(): void {
    if (this.#closed) return;
    if (this.#routineDebounceTimer !== undefined) return;
    this.#routineDebounceTimer = setTimeout(() => {
      this.#routineDebounceTimer = undefined;
      const cutoff = this.#now() - ROUTINE_WATCH_TTL_MS;
      for (const [bot, at] of this.#routineWatch) {
        if (at < cutoff) {
          this.#routineWatch.delete(bot);
          this.#lastRoutinesJson.delete(bot);
          continue;
        }
        void this.#publishRoutines(bot, { renew: false });
      }
    }, CHANGE_DEBOUNCE_MS);
    this.#routineDebounceTimer.unref();
  }

  /** Test seam: true while a turn poll is live for this bot. */
  chatPolling(name: string): boolean {
    return this.#chat.polling(name);
  }

  /** Test seam: resolves when the bot's live turn poll finishes. */
  async chatSettled(name: string): Promise<void> {
    await this.#chat.settled(name);
  }

  setFocus(deviceId: string, screen: BotFocusScreen | null): void {
    if (screen === null) this.#focus.delete(deviceId);
    else this.#focus.set(deviceId, { screen, at: this.#now() });
    this.#schedulePoll();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#chat.close();
    this.#stream.close();
    this.#approvals.close();
    this.#toolActivity.close();
    this.#scheduledPush?.close();
    // Awaited: a room drive that is mid-turn holds a reference to the storage the caller is about
    // to close, and it must be finished with it before this resolves.
    await this.#groups.close();
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
    if (this.#sweepTimer !== undefined) clearTimeout(this.#sweepTimer);
    this.#sweepTimer = undefined;
    if (this.#debounceTimer !== undefined) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = undefined;
    if (this.#routineDebounceTimer !== undefined) clearTimeout(this.#routineDebounceTimer);
    this.#routineDebounceTimer = undefined;
    if (this.#inboxDebounceTimer !== undefined) clearTimeout(this.#inboxDebounceTimer);
    this.#inboxDebounceTimer = undefined;
    this.#inboxRefreshDirty = false;
    this.#inboxWatch.clear();
    await this.#client.close();
  }

  /** The cached `ui_meta` pin for a bot. Three-valued, and it must agree key-for-key with what
   *  `buildRoster` reports, or `GET /bots` and `GET /bots/:name/chat` answer differently for the
   *  same bot: `undefined` only when the server carries no bot blob at all (or the bot is not in
   *  the cache yet), the pin when the blob names one, and `null` otherwise, because a blob without
   *  a `chat` key is an authoritative clear (dissection 3.2). */
  async #serverPinOf(name: string): Promise<string | null | undefined> {
    const roster = this.#storage.botRoster();
    const cached = roster.bots.find((bot) => bot.name === name);
    if (cached !== undefined) {
      // Exactly the rule `buildRoster` applied to this same snapshot, so `GET /bots` and this route
      // cannot answer differently for the same bot.
      return resolveChatPin(cached.meta, this.#storage.botChatPinEntry(name), roster.updatedAt, this.#uiMetaWriteback);
    }

    // Not in the cache. A HIDDEN bot is the case that matters: the hide list is a roster filter,
    // not an access rule, so hidden bots are still chattable by name, but they are deliberately
    // absent from `bot_roster` and therefore from this cache. Reading that absence as "the server
    // knows nothing" made every hidden bot's server pin invisible: the desktop's authoritative pin
    // (and its authoritative CLEAR) were never honored, and only the gateway-local pin was
    // consulted. So fetch this one profile fresh instead of guessing. A cold cache takes the same
    // path, which is strictly better than the guess it replaces.
    const at = this.#now();
    const uiMeta = await this.#freshUiMeta(name);
    if (uiMeta === undefined) return undefined;
    return resolveChatPin(readBotMeta(uiMeta).meta, this.#storage.botChatPinEntry(name), at, this.#uiMetaWriteback);
  }

  /** One profile's raw `ui_meta` value, read fresh off the wire. `undefined` when the profile is not
   *  in the answer at all; a profile that is there but carries no `ui_meta` yields `null`, which is
   *  the difference between "we do not know" and "there is no blob".
   *
   *  Throws nothing: a read that cannot be made answers `undefined`, which every caller already
   *  treats as "the server knows nothing" and degrades to the local record for. */
  async #freshUiMeta(name: string): Promise<unknown | undefined> {
    try {
      const raw = await this.#client.request("profiles.list", {});
      const profiles = (raw as Record<string, unknown> | null)?.["profiles"];
      if (!Array.isArray(profiles)) return undefined;
      const row = profiles.find(
        (entry) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["name"] === name,
      );
      if (row === undefined) return undefined;
      return (row as Record<string, unknown>)["ui_meta"] ?? null;
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown";
      this.#log(`fresh ui_meta read failed for ${name}: ${detail}`);
      return undefined;
    }
  }

  /** Writes the canonical-chat pin into the bot's `ui_meta`, the desktop's `saveBotMeta`
   *  (dissection 3.1). Nothing here is ever allowed to fail the caller: a gateway that cannot store
   *  `ui_meta` still gets a working chat, the pin just stays gateway-local.
   *
   *  `profiles.configure` REPLACES the whole blob, which makes this a read-modify-write, and the
   *  read must be FRESH. Building it from the cached roster (up to one poll interval old) silently
   *  reverted any desktop `saveBotMeta` that landed since the last refresh, and, worse, pushed a
   *  re-derived pin back into a blob the desktop had authoritatively cleared: the dissection-3.2
   *  resurrection, re-entering through the write path. So: re-read `profiles.list`, skip the write
   *  when the server already carries this pin, and honor a clear that is newer than our own pin.
   *
   *  What goes on the wire is filtered too (`botMetaForWriteback`): `image`/`pet`/`custom` are
   *  stripped and a legacy pre-namespace blob contributes only the fields the plugin owns, because
   *  `ui_meta` is capped at 64 KB and rides every `profiles.list`. */
  async #saveServerPin(
    name: string,
    sessionId: string,
    previousServerPin: string | null | undefined,
  ): Promise<void> {
    if (!this.#uiMetaWriteback) return;
    try {
      const uiMeta = await this.#freshUiMeta(name);
      const fresh = readBotMeta(uiMeta).meta;

      if (fresh !== null && fresh["chat"] === sessionId) return; // The server already agrees.
      // A fresh blob that carries no `chat` is a clear, and the fresh read is by definition newer
      // than anything this gateway holds. The ONE case that is not a clear is the resolve having
      // observed that same pinless blob itself (`previousServerPin === null`) and having decided to
      // adopt or mint anyway: that is the first pin on a bot whose look blob already exists, which
      // is the ordinary create-then-open sequence.
      //
      // Requiring `previousServerPin` to be a STRING here was one branch too narrow: a cold roster
      // cache (or the stamp exception) makes it `undefined`, and a blob cleared server-side between
      // resolve and writeback was then re-pinned anyway.
      const clearedSinceResolve =
        previousServerPin !== null && fresh !== null && typeof fresh["chat"] !== "string";
      if (clearedSinceResolve) {
        // The server's blob says the pin is gone, and that clear is authoritative (dissection 3.2).
        // Writing here would resurrect it.
        this.#log(`ui_meta pin writeback skipped for ${name}: the server carries no pin`);
        return;
      }

      const meta = botMetaForWriteback(uiMeta, { chat: sessionId });
      if (meta === null) {
        this.#log(`ui_meta pin writeback skipped for ${name}: the blob exceeds the 64KB cap`);
        return;
      }

      const result = await this.#client.request("profiles.configure", {
        name,
        ui_meta: { [UI_META_KEY]: meta },
      });
      const applied =
        typeof result === "object" && result !== null
          ? (result as Record<string, unknown>)["applied"]
          : undefined;
      if (typeof applied !== "object" || applied === null) {
        // No `applied` map at all is dissection 3.1's `unsupported`: an older gateway. Stop asking.
        this.#uiMetaWriteback = false;
        this.#log(`ui_meta pin writeback unsupported by this hermes, keeping pins gateway-local`);
        return;
      }
      if ((applied as Record<string, unknown>)["ui_meta"] !== true) {
        this.#log(`ui_meta pin writeback not applied for ${name}, keeping it gateway-local`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown";
      if (/unknown method/i.test(detail)) this.#uiMetaWriteback = false;
      this.#log(`ui_meta pin writeback failed for ${name}: ${detail}`);
    }
  }

  #gatewayState(): "idle" | "connecting" | "open" | "busy" {
    if (this.#busyDepth > 0) return "busy";
    const state = this.#client.state();
    if (state === "online") return "open";
    return state === "connecting" ? "connecting" : "idle";
  }

  /** The poll implied by what devices say they are looking at, or undefined for idle. `routines` is
   *  reported alongside the interval rather than folded into it: a routines pane needs the cron
   *  store re-read, which the roster refresh does not touch. */
  #pollIntervalMs(): { ms: number; routines: boolean } | undefined {
    const cutoff = this.#now() - this.#focusTtlMs;
    let roster = false;
    let routines = false;
    for (const [deviceId, entry] of this.#focus) {
      if (entry.at < cutoff) {
        this.#focus.delete(deviceId);
        continue;
      }
      if (entry.screen === "roster") roster = true;
      if (entry.screen === "routines") routines = true;
    }
    if (roster) return { ms: this.#rosterPollMs, routines };
    if (routines) return { ms: this.#routinesPollMs, routines: true };
    return undefined;
  }

  #schedulePoll(): void {
    if (this.#pollTimer !== undefined) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (this.#closed) return;
    const poll = this.#pollIntervalMs();
    if (poll === undefined) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      // The routines poll is the FALLBACK for a gateway that does not broadcast `cron.changed`.
      // Where the broadcast exists it has already fired, and this re-read finds nothing new and
      // stays silent, because a frame is only sent when the list actually changed.
      if (poll.routines) this.#refreshRoutinesSoon();
      void this.refresh("poll").finally(() => this.#schedulePoll());
    }, poll.ms);
    this.#pollTimer.unref();
  }
}

/** The roster row for a bot that exists but is not in the cached roster: hidden by config, or
 *  created while the refresh behind it failed. Built from the blob just written, so it matches
 *  what a later refresh will produce for the same profile. A brand new profile has no sessions and
 *  no activity, which is why every live field here is empty rather than guessed. */
function synthesizeSummary(created: CreatedBot): BotSummary {
  const meta: Record<string, unknown> = { ...created.meta };
  return {
    name: created.name,
    displayName: botDisplayName(created.name, meta),
    handle: botHandle(created.name),
    description: created.description.length === 0 ? null : created.description,
    hasAvatar: false,
    group: null,
    pinned: false,
    active: false,
    lastActiveAt: null,
    chatSessionId: null,
    preview: classifyPreview(null, created.description.length === 0 ? null : created.description),
    meta,
  };
}

/** True when a failure means "Hermes is not reachable right now" rather than "Hermes said no". */
export function isHermesUnavailable(err: unknown): boolean {
  return err instanceof HermesUnavailable;
}

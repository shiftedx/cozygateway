import type {
  BotApprovalGrant,
  BotComposerDraft,
  BotMobilePreferredDevice,
  BotMobileRequest,
  BotAttachmentHistoryItem,
  BotCatalog,
  BotCreateRequest,
  BotCreateResponse,
  BotDeleteResponse,
  BotDesktopHermesSession,
  BotDesktopHermesResumeResponse,
  BotChatMessage,
  BotChatContextReading,
  BotChatStateCause,
  BotMobileReceipt,
  BotChatStatus,
  BotGroup,
  BotGroupDetail,
  BotGroupMessage,
  BotGroupPatchRequest,
  BotModelConfig,
  BotModelConfigPatch,
  BotVoice,
  BotModelProviderOAuthSession,
  BotModelProviderSetupCatalog,
  BotInteractionSettlement,
  BotPendingClarification,
  BotPendingApproval,
  BotProfile,
  BotProfilePatch,
  BotPresentationPatch,
  BotPresentationResponse,
  BotRelayAgent,
  BotRelayDeliverRequest,
  BotRelayDeliverResponse,
  BotRelayDrainResponse,
  BotRelayReplyRequest,
  BotCanonicalChatResponse,
  BotChatReactionResponse,
  BotAvatarGenerateRequest,
  BotAvatarGenerateResponse,
  BotAvatarPetGallery,
  BotAvatarPetThumbResponse,
  BotAvatarSetResponse,
  BotReadiness,
  BotRuntimeProjection,
  BotRuntimeRecoveryResponse,
  BotRoutine,
  BotRoutineBlueprint,
  BotRoutineCreateRequest,
  BotRoutinePatch,
  BotRoutineRunRecord,
  BotSummary,
  BotSlashCommand,
  BotTurnToolSteps,
  BotTurnDelegations,
  BridgeLiveness,
  BotIdentityPatch,
  BotModelPinRequest,
  ServerFrame,
} from "cozygateway-contract";
import type { AttachV1EventFrame } from "../adapters/attach/protocol-v1.ts";
import { BackendUnavailable } from "../errors.ts";
import type { Storage } from "../storage.ts";
import {
  HermesRpcError,
  type HermesClient,
  type HermesState,
} from "./client.ts";
import {
  sessionKind,
  isDesktopHermesSession,
  interactiveHermesSessionSource,
  listBotSessions,
} from "./sessions.ts";
import { parseChatSnapshot } from "./chat-messages.ts";
import { redactHostPaths } from "./photos.ts";
import {
  botDisplayName,
  botHandle,
  buildRoster,
  parseProfilesList,
  UI_META_KEY,
} from "./roster.ts";
import type { GroupMember } from "./group-protocol.ts";
import type {
  BotApprovalDecision,
  BotApprovalDecisionScope,
  BotClarifyResolveOutcome,
  BotApprovalResolveOutcome,
} from "./approvals.ts";
import { GroupRooms, type RoomInteractionExpiry } from "./group-rooms.ts";
import { readPresentation, writePresentation } from "./presentation.ts";
import { relayDeliver, relayDrain, relayInstallId, relayReply, relayRosterSync } from "./relay.ts";
import { createCanonicalBotChat, ensureBotModeMarker, findCanonicalBotChat } from "./bot-chat.ts";
import { AvatarFingerprints, clearAvatar, generatePortrait, petGallery, petThumb, readAvatar, writeAvatar } from "./avatar.ts";
import type { NativeGroupTurnEndpoint } from "./group-turn.ts";
import type { ProfileChangeEvent } from "./profile-provisioner.ts";
import type { ObservationRing } from "../observe/ring.ts";
import {
  BotNameInvalid,
  BotNameTaken,
  BotNotFound,
  BotTurnActive,
  RESERVED_PROFILE_NAMES,
  normalizeProfileName,
  validateNewBotName,
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
  instantiateRoutineBlueprint,
  listBotRoutineRuns,
  listBotRoutines,
  listRoutineBlueprints,
  patchBotRoutine,
  readBotRoutineRunOutput,
  runBotRoutine,
  type RoutineWriteResult,
} from "./routines.ts";
import { readBotModelConfig, writeBotModelConfig } from "./model-config.ts";
import { readBotVoice, speakThroughHermes, type BotSpeech } from "./voice.ts";
import {
  ProfileOpInvalid,
  copyBotLook,
  describeProfileAuto,
  disconnectProvider,
  exportProfileArchive,
  freeDuplicateName,
  importProfileArchive,
  installHubSkill,
  listProviderKeys,
  pinProfileModel,
  readProfileModelPin,
  renameProfile,
  saveProviderKey,
  searchSkillsHub,
  setBotIdentity,
  unpinProfileModel,
} from "./profile-ops.ts";
import {
  cancelProviderOAuth,
  deleteProviderSetupField,
  pollProviderOAuth,
  readProviderSetupCatalog,
  startProviderOAuth,
  submitProviderOAuthCode,
  writeProviderSetupField,
} from "./provider-setup.ts";
import {
  BLANK_SLATE_SKILLS_ON,
  seedBlankSlateProfile,
  type BlankSlateSelection,
} from "./blank-slate-seed.ts";

const CHANGE_DEBOUNCE_MS = 250;
/** A seed is an idempotent profile write.  Retrying quickly handles a short Dashboard rate-limit
 * window; the cap prevents one unavailable Dashboard from becoming a hot loop. */
const SEED_RETRY_BASE_MS = 1_000;
const SEED_RETRY_MAX_MS = 5 * 60_000;
/** The answer a bridge with no runtime bots configured gives, allocated once: this is read on every
 *  member boundary of every room. */
const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();
export type BotFocusScreen = "roster" | "routines";
export type { ProfileChangeEvent } from "./profile-provisioner.ts";
export interface BotRosterView {
  bots: BotSummary[];
  updatedAt: number | null;
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
export interface BotSessionDeletion {
  name: string;
  sessionId: string;
  deletedAt: number;
}
export interface BotNewSessionResult {
  sessionId: string;
  previousSessionId: string;
}
export interface BotChatPhotoUpload {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  text: string;
  clientId?: string;
}
export interface BotChatFileUpload {
  bytes: Uint8Array;
  mime: string;
  name: string;
  text: string;
  clientId?: string;
}
export interface BotChatAttachmentBytes {
  bytes: Uint8Array;
  mime: string;
  name: string;
  size: number;
}
export type BotChatAttachmentInfo = Omit<BotChatAttachmentBytes, "bytes">;
export interface ChatResetResult {
  sessionId: string;
  previousSessionId?: string;
}
export interface BotRoutineList {
  name: string;
  routines: BotRoutine[];
  updatedAt: number;
  /** Capability 83: Hermes's `gateway_running`, when it reported one. */
  schedulerRunning?: boolean;
}
/** Capability 83: a run-now that Hermes accepted. */
export interface BotRoutineRunStarted {
  routine: BotRoutine;
  startedAt: number;
}
export interface BotChatHistory {
  sessionId: string;
  adoption: ChatAdoption;
  messages: BotChatMessage[];
  mobileReceipts: BotMobileReceipt[];
  running: boolean;
  inflight: boolean;
  /** Capability 23 exact turn status. Absent only when this session has never run a turn. */
  status?: BotChatStatus;
  cause?: BotChatStateCause;
  queuedAt?: number;
  toolSteps?: BotTurnToolSteps[];
  /** Capability 34 delegation batches (subagent visibility) for turns of this session. */
  delegations?: BotTurnDelegations[];
  updatedAt: number;
  suggestion?: string;
}
export type ChatAdoption = "pin" | "created";
export interface CanonicalChatResult {
  sessionId: string;
  adoption: ChatAdoption;
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

/** Capability 82: one profile operation on a Hermes-backed bot (`profile-ops.ts`). */
export type BotProfileOp =
  | { kind: "identity"; patch: BotIdentityPatch }
  | { kind: "rename"; newName: string }
  | { kind: "describeAuto"; overwrite: boolean }
  | { kind: "duplicate"; newName?: string; avoid?: readonly string[] }
  | { kind: "export" }
  | { kind: "import"; archive: ReadableStream<Uint8Array> | null }
  | { kind: "modelPin" }
  | { kind: "pinModel"; request: BotModelPinRequest }
  | { kind: "unpinModel" }
  | { kind: "providerKeys" }
  | { kind: "saveProviderKey"; provider: string; apiKey: string }
  | { kind: "disconnectProvider"; provider: string }
  | { kind: "skillsHubSearch"; query: string }
  | { kind: "skillsHubInstall"; identifier: string };

export interface BotControlSurface {
  roster(): BotRosterView;
  /** Capability 82. The result's shape is the route's own; a `bot` member is a roster row. */
  profileOp?(name: string, op: BotProfileOp): Promise<unknown>;
  createBot(input: BotCreateRequest): Promise<BotCreateResponse>;
  deleteBot(name: string, opts?: { force?: boolean }): Promise<BotDeleteResponse>;
  health(): BridgeLiveness;
  refreshSoon(reason: string): void;
  botProfile(name: string): Promise<BotProfile>;
  configureProfile(
    name: string,
    patch: BotProfilePatch,
  ): Promise<ProfileConfigureResult>;
  /** Capability 80. Optional so a surface with no Hermes profile behind it simply lacks the route. */
  botPresentation?(name: string): Promise<BotPresentationResponse>;
  configurePresentation?(name: string, patch: BotPresentationPatch): Promise<BotPresentationResponse>;
  /** Capability 87, the relay doors. Optional so only a surface with a Hermes behind it relays. */
  relayRosterSync?(agents: BotRelayAgent[]): Promise<{ count: number }>;
  /** The Hermes install id behind this surface, for the relay identity. */
  relayInstallId?(): Promise<string | undefined>;
  relayDrain?(): Promise<BotRelayDrainResponse>;
  relayDeliver?(req: BotRelayDeliverRequest): Promise<BotRelayDeliverResponse>;
  relayReply?(req: BotRelayReplyRequest): Promise<{ ok: true }>;
  /** Capability 86, control-plane half. The profile's canonical `Bot Chat` registry row (fail
   *  closed), minted when `create` and absent, with the Bot-Mode marker ensured. Optional so a
   *  surface with no Hermes profile behind it simply lacks the route. */
  canonicalBotChat?(name: string, create: boolean): Promise<{ hermesSessionId: string; created: boolean } | null>;
  /** Capability 86. Archive (and hide) one Hermes session, which retires a Bot Chat. */
  archiveHermesSession?(name: string, hermesSessionId: string): Promise<void>;
  /** Capability 81. Optional for the same reason: only a Hermes profile has an avatar asset. */
  botAvatar?(name: string): Promise<{ mime: string; bytes: Buffer } | undefined>;
  setBotAvatar?(name: string, data: string | null): Promise<BotAvatarSetResponse>;
  generateBotAvatar?(name: string, request: BotAvatarGenerateRequest): Promise<BotAvatarGenerateResponse>;
  botAvatarPets?(name: string, localOnly: boolean): Promise<BotAvatarPetGallery>;
  botAvatarPetThumb?(name: string, slug: string, url: string): Promise<BotAvatarPetThumbResponse>;
  /** Capability 86 (voice). Optional so a surface with no Hermes profile behind it lacks the routes. */
  botVoice?(name: string): Promise<BotVoice>;
  speakBot?(name: string, text: string, signal?: AbortSignal): Promise<BotSpeech>;
  modelConfig(name: string): Promise<BotModelConfig>;
  configureModel(
    name: string,
    patch: BotModelConfigPatch,
  ): Promise<BotModelConfig>;
  modelProviders(name: string): Promise<BotModelProviderSetupCatalog>;
  configureModelProviderField(
    name: string, provider: string, field: string, value: string,
  ): Promise<BotModelProviderSetupCatalog>;
  clearModelProviderField(
    name: string, provider: string, field: string,
  ): Promise<BotModelProviderSetupCatalog>;
  startModelProviderOAuth(name: string, provider: string): Promise<BotModelProviderOAuthSession>;
  pollModelProviderOAuth(
    name: string, provider: string, sessionId: string,
  ): Promise<BotModelProviderOAuthSession>;
  submitModelProviderOAuthCode(
    name: string, provider: string, sessionId: string, code: string,
  ): Promise<BotModelProviderOAuthSession>;
  cancelModelProviderOAuth(name: string, provider: string, sessionId: string): Promise<void>;
  catalog(query: string): Promise<BotCatalog>;
  /** Source-qualified discovery only. These ids are raw Hermes ids and never enter native Bot
   * Mode session identity; the data plane asks for explicit adoption separately. */
  desktopSessions(name: string): Promise<BotDesktopHermesSession[]>;
  desktopSessionTranscript(name: string, hermesSessionId: string): Promise<BotChatMessage[]>;
  routines(name: string): Promise<BotRoutineList>;
  createRoutine(
    name: string,
    input: BotRoutineCreateRequest,
  ): Promise<RoutineWriteResult>;
  patchRoutine(
    name: string,
    id: string,
    patch: BotRoutinePatch,
  ): Promise<RoutineWriteResult>;
  deleteRoutine(name: string, id: string): Promise<void>;
  /** Capability 83. Optional so a surface without Hermes's dashboard leaves the routes 404. */
  runRoutine?(name: string, id: string): Promise<BotRoutineRunStarted>;
  routineRuns?(name: string, id: string, limit?: number): Promise<BotRoutineRunRecord[]>;
  routineRunOutput?(name: string, id: string, runId: string): Promise<string | null>;
  routineBlueprints?(name: string): Promise<BotRoutineBlueprint[]>;
  instantiateRoutineBlueprint?(name: string, key: string, values: Record<string, string>): Promise<BotRoutine>;
  setFocus(deviceId: string, screen: BotFocusScreen | null): void;
  groups(): BotGroup[];
  createGroup(name: string, members: string[], owningHost?: string): Promise<BotGroup>;
  deleteGroup(name: string): void;
  groupDetail(name: string): BotGroupDetail;
  sendGroupMessage(
    name: string,
    text: string,
    opts?: { clientId?: string; threadId?: string },
  ): BotGroupMessage;
  /** Capability 84. */
  updateGroup(name: string, patch: BotGroupPatchRequest): Promise<BotGroup>;
  stopGroup(name: string): BotGroup;
  compressGroupMember(name: string, member: string): Promise<{ member: string; text: string }>;
  /** Capability 84. A room picture from Hermes `image.generate`; absent without a Hermes endpoint. */
  generateGroupPicture?(prompt: string): Promise<string>;
}
export interface BotsSurface extends BotControlSurface {
  readiness(name: string): BotReadiness;
  /** Capability 49: the runtime projection for a gateway-owned runtime bot. Optional because a
   * gateway with no runner lane has no runtime to project and the route is then not registered at
   * all, which is the honest answer rather than a stage invented from nothing. */
  botRuntime?(name: string): BotRuntimeProjection;
  /** Capability 61: accept one exact retry for the current terminal runtime operation. Optional
   * for the same assembly reason as `botRuntime`: a gateway without lifecycle ownership cannot
   * honestly expose a recovery control. */
  recoverBotRuntime?(name: string): BotRuntimeRecoveryResponse;
  commands(name: string): readonly BotSlashCommand[];
  /** Capability 27: current durable approvals only; terminal records stay private to lifecycle
   * settlement and never appear in the user's decision inbox. */
  pendingApprovals(): readonly BotPendingApproval[];
  /** Capability 29 recovery snapshot complements the approval inbox. Terminal receipts are
   * confirmation from a later Hermes event or expiry, never the action POST. */
  pendingClarifications(): readonly BotPendingClarification[];
  terminalSettlements(): readonly BotInteractionSettlement[];
  attachmentHistory(input: {
    query?: string;
    kind?: "image" | "video" | "audio" | "file";
    bot?: string;
    since?: number;
    offset: number;
    limit: number;
  }): { items: BotAttachmentHistoryItem[]; nextOffset: number | null };
  canonicalChat(name: string): Promise<CanonicalChatResult>;
  /** Capability 86: resolve or mint the Hermes `Bot Chat` and bind the current chat to it. */
  openBotChat?(name: string): Promise<BotCanonicalChatResponse>;
  /** Capability 86: this user's Tapback on one message (null clears). */
  reactToChatMessage?(name: string, messageId: string, emoji: string | null): Promise<BotChatReactionResponse>;
  newSession(name: string): Promise<BotNewSessionResult>;
  resetChat(name: string): Promise<ChatResetResult>;
  sessions(name: string, limit: number): Promise<BotSessionsView>;
  adoptSession(
    name: string,
    sessionId: string,
    limit: number,
  ): Promise<BotSessionAdoption>;
  deleteSession(name: string, sessionId: string): Promise<BotSessionDeletion>;
  chatHistory(name: string): Promise<BotChatHistory>;
  /** Optional runtime context reading. `null` means the selected runtime does not report one. */
  chatContext?(name: string): Promise<{ sessionId: string; context: BotChatContextReading | null }>;
  /** A successful chat-configuration write may change the next context window or model. */
  contextConfigurationChanged?(name: string, sessionId?: string): void;
  sendChatMessage(
    name: string,
    text: string,
    opts?: { clientId?: string; deviceId?: string },
  ): Promise<{ sessionId: string; message: BotChatMessage }>;
  stopChat(name: string): Promise<"stopped" | "idle">;
  sendChatPhoto(
    name: string,
    photo: BotChatPhotoUpload,
    opts?: { deviceId?: string },
  ): Promise<{ sessionId: string; message: BotChatMessage }>;
  sendChatAttachment(
    name: string,
    file: BotChatFileUpload,
    opts?: { deviceId?: string },
  ): Promise<{ sessionId: string; message: BotChatMessage }>;
  chatAttachmentInfo(
    name: string,
    fileId: string,
  ): BotChatAttachmentInfo | undefined;
  chatAttachmentSlice(
    name: string,
    fileId: string,
    offset: number,
    length: number,
  ): Uint8Array | undefined;
  resolveApproval(
    name: string,
    toolCallId: string,
    decision: BotApprovalDecision,
    deviceId: string,
    /** Capability 66. Absent is the pre-66 request: this invocation only, no standing grant. */
    scope?: BotApprovalDecisionScope,
  ): Promise<BotApprovalResolveOutcome>;
  /** Capability 66. The standing approvals this bot holds that are neither expired nor revoked. */
  approvalGrants?(name: string): BotApprovalGrant[];
  /** Capability 66. Revocation is immediate: the grant leaves every later consult at once. */
  revokeApprovalGrant?(name: string, grantId: string): "revoked" | "unknown";
  /** Capability 68. The typed lifecycle of the phone capability requests one conversation opened,
   *  which is what an app resuming from the background reconciles its pending requests against. */
  mobileRequests?(name: string, sessionId: string): BotMobileRequest[];
  /** Capability 70. The device this conversation's capability requests should go to, read at
   *  admission and nowhere else. `unknown_device` refuses an id naming no paired device rather
   *  than storing a choice that would resolve to nothing; `null` clears. */
  /** `undefined` means this gateway holds no such bot, which is a 404 rather than an answer. */
  mobilePreferredDevice?(name: string, sessionId: string): BotMobilePreferredDevice | undefined;
  setMobilePreferredDevice?(
    name: string, sessionId: string, deviceId: string | null,
  ): "ok" | "unknown_device" | "unknown_bot";
  /** Capability 71. One composer draft per conversation, per PERSON and never per device. The
   *  empty string is the clear a send writes, and the write broadcasts it to every paired
   *  device unless the text is the one already stored. */
  composerDraft?(name: string, sessionId: string): BotComposerDraft | undefined;
  setComposerDraft?(name: string, sessionId: string, text: string): BotComposerDraft | undefined;
  resolveClarify(
    name: string,
    clarifyId: string,
    optionId: string,
    deviceId: string,
  ): Promise<BotClarifyResolveOutcome>;
  /** Capability 31. Records that this device displayed these wire ids; returns how many became a
   * NEW receipt. Idempotent, first-write-wins, and unknown ids are ignored. */
  recordDisplayed(
    name: string,
    messageIds: readonly string[],
    deviceId: string,
    /** Capability 73. The app's own perceived latency and network path for this report. Optional
     * everywhere: a client below 73 sends neither and is byte identical to its pre-73 self, and a
     * backend that has nowhere to put them ignores them. */
    perceived?: {
      feltLatencyMs?: number;
      networkPath?: "wifi" | "cellular" | "wired" | "other";
      vpn?: boolean;
      edgeRttMs?: number;
      edgeColo?: string;
    },
  ): { recorded: number };
  desktopSessions(name: string): Promise<BotDesktopHermesSession[]>;
  resumeDesktopSession(name: string, hermesSessionId: string): Promise<BotDesktopHermesResumeResponse>;
}

export interface HermesBridgeOptions {
  client: HermesClient;
  storage: Storage;
  observe?: ObservationRing;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  hiddenProfiles?: Iterable<string>;
  bridgeProfile?: string;
  /** Whether a newly created bot is seeded as a blank slate (file + terminal, manual approvals).
   *  Default true. Turning it off leaves a created profile on Hermes' broad platform defaults,
   *  which is the pre-blank-slate behaviour. */
  seedBlankSlateBots?: boolean;
  /** Skill names a blank-slate bot keeps ON. Default `[]`: no playbooks until asked. Ignored when
   *  `seedBlankSlateBots` is false. */
  blankSlateSkillsOn?: readonly string[];
  /** Internal test seam for the persisted seed retry. Production uses one second then exponential
   * backoff capped at five minutes; this is intentionally not configuration or a wire option. */
  seedRetryBaseMs?: number;
  /** Bot names served by a non-Hermes runtime (capability 45), read fresh on every call because
   *  the set is config-declared and the bridge is built before the data plane that knows it.
   *
   *  Room membership is the only thing that consults it. A runtime bot has no Dashboard profile,
   *  so `profiles.list` can never name it, and every membership check that asks Hermes alone would
   *  report a bot the roster is visibly listing as "not a bot on this gateway". Capability 46 makes
   *  the runtime set an equal source of that answer, which is also what lets a room made only of
   *  runtime bots run on a gateway whose Hermes is unreachable. */
  runtimeBotNames?: () => ReadonlySet<string>;
  /** This endpoint's id when the gateway namespaces its bot names, i.e. the `<id>` in the
   *  `<id>:<profile>` name every app-facing surface uses on a federated gateway (see
   *  `publicProfileId`). Absent on the one un-namespaced endpoint, where a public bot name and a
   *  Hermes profile id are the same string.
   *
   *  Rooms are the only thing that needs it. A room hosted here on a federated gateway is created,
   *  addressed and answered in PUBLIC names, because the attach identity a member turn is
   *  dispatched to is the public name (`publicProfileId` is what registers the token), while
   *  `profiles.list` and this endpoint's roster cache only ever speak profile ids. Without the
   *  prefix to strip, every membership check would answer "not a bot on this gateway" for a bot
   *  the roster is visibly listing. */
  roomMemberNamespace?: string;
  catalogTtlMs?: number;
  catalogDegradedTtlMs?: number;
  onGroupEscalation?: (event: {
    group: string;
    member: string;
    displayName: string;
    text: string;
  }) => void;
  logSink?: (line: string) => void;
  /** Kills the bot's attach identity the moment `deleteBot` commits: token map entry, live
   *  socket, adapter, capability grant. Returns whether an identity was actually held. Wired by
   *  the server, absent in bridge-only tests. */
  revokeAttachIdentity?: (name: string) => boolean;
  /** Told once per Hermes profile this bridge created or deleted, after the roster already reflects
   *  the change and the response is about to go out. The server hands it to the profile
   *  provisioner, which is what moves a phone-created bot past `setup_required` on a native
   *  install. A throwing hook is logged and never fails the request; a refused create or delete
   *  never reaches it. Absent in bridge-only tests and on gateways nothing may reprovision. */
  onProfileChange?: (event: ProfileChangeEvent) => void;
}

/** Dashboard control/read plane. All Bot Mode conversation traffic is attach-v1. */
export class HermesBridge implements BotControlSurface {
  readonly #client: HermesClient;
  readonly #avatarFingerprints = new AvatarFingerprints();
  #rosterGeneration = 0;
  #petGallery: { at: number; pets: Map<string, string> } | undefined;
  readonly #storage: Storage;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #hidden: ReadonlySet<string>;
  readonly #bridgeProfile: string | undefined;
  readonly #seedBlankSlateBots: boolean;
  readonly #blankSlateSkillsOn: readonly string[];
  readonly #seedRetryBaseMs: number;
  readonly #log: (line: string) => void;
  readonly #groups: GroupRooms;
  readonly #catalog = new Map<string, CachedCatalog>();
  readonly #catalogInflight = new Map<string, Promise<BotCatalog>>();
  readonly #catalogTtlMs: number;
  readonly #catalogDegradedTtlMs: number;
  readonly #revokeAttachIdentity: (name: string) => boolean;
  readonly #onProfileChange: ((event: ProfileChangeEvent) => void) | undefined;
  readonly #runtimeBotNames: () => ReadonlySet<string>;
  readonly #roomNamespace: string | undefined;
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #routineWatch = new Map<string, number>();
  readonly #lastRoutines = new Map<string, string>();
  readonly #focus = new Map<string, { screen: BotFocusScreen; at: number }>();
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #routineTimer: ReturnType<typeof setTimeout> | undefined;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #seedRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #seedRetryAt: number | undefined;
  #seedRetryInFlight: Promise<void> | undefined;
  #refreshing: Promise<void> | undefined;
  #dirty = false;
  #closed = false;
  #lastRoster = "";
  #lastActive = "";
  #rosterOverlay: ((bots: readonly BotSummary[]) => BotSummary[]) | undefined;
  constructor(opts: HermesBridgeOptions) {
    this.#client = opts.client;
    this.#storage = opts.storage;
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#hidden = new Set(
      [...(opts.hiddenProfiles ?? [])].map((name) => name.trim().toLowerCase()),
    );
    const profile = opts.bridgeProfile?.trim().toLowerCase();
    this.#bridgeProfile = profile || undefined;
    this.#seedBlankSlateBots = opts.seedBlankSlateBots ?? true;
    this.#blankSlateSkillsOn = opts.blankSlateSkillsOn ?? BLANK_SLATE_SKILLS_ON;
    this.#seedRetryBaseMs = Math.max(1, opts.seedRetryBaseMs ?? SEED_RETRY_BASE_MS);
    this.#catalogTtlMs = opts.catalogTtlMs ?? CATALOG_TTL_MS;
    this.#catalogDegradedTtlMs =
      opts.catalogDegradedTtlMs ?? CATALOG_DEGRADED_TTL_MS;
    this.#revokeAttachIdentity = opts.revokeAttachIdentity ?? (() => false);
    this.#onProfileChange = opts.onProfileChange;
    this.#runtimeBotNames = opts.runtimeBotNames ?? ((): ReadonlySet<string> => EMPTY_NAMES);
    this.#roomNamespace = opts.roomMemberNamespace?.trim().toLowerCase() || undefined;
    this.#log =
      opts.logSink ??
      ((line) => void process.stderr.write(`[hermes-bridge] ${line}\n`));
    this.#groups = new GroupRooms({
      storage: this.#storage,
      ...(opts.observe === undefined ? {} : { observe: opts.observe }),
      broadcast: this.#broadcast,
      now: this.#now,
      memberInfo: (name) => this.#memberInfo(name),
      missingMembers: async (names) => {
        // A runtime bot is present by construction: it is declared in this gateway's own config
        // and its attach identity is minted at startup, so there is nothing to ask anyone about.
        // Answering it here also means a room of only runtime bots never touches Hermes, which is
        // what lets such a room be created while the Dashboard is down.
        const runtime = this.#runtimeBotNames();
        const asked = names.filter((name) => !runtime.has(name));
        if (asked.length === 0) return [];
        // A public name this endpoint cannot own is missing here without asking anyone: on a
        // federated gateway it belongs to a different endpoint, and this room is not that room.
        const local = new Map(asked.map((name) => [name, this.#localProfile(name)] as const));
        const mine = asked.filter((name) => local.get(name) !== undefined);
        const foreign = asked.filter((name) => local.get(name) === undefined);
        if (mine.length === 0) return foreign;
        const known = await this.#freshProfileNames();
        return [...foreign, ...mine.filter((name) => !known.has(local.get(name)!))];
      },
      memberKnown: (name) => {
        if (this.#runtimeBotNames().has(name)) return true;
        const local = this.#localProfile(name);
        if (local === undefined) return false;
        const bots = this.#storage.botRoster().bots;
        return bots.length === 0
          ? undefined
          : bots.some((bot) => bot.name === local);
      },
      // Capability 51. Only a runtime member's room turn projects approvals, clarifications and
      // tool steps; a Hermes member's room turn keeps dropping them.
      isRuntimeMember: (name) => this.#runtimeBotNames().has(name),
      memberExists: async (name) => {
        // Checked before the round trip for the same reason: `profiles.list` never names a runtime
        // bot, so asking it would answer `false` and retire a perfectly live member.
        if (this.#runtimeBotNames().has(name)) return true;
        const local = this.#localProfile(name);
        if (local === undefined) return false;
        try {
          return (await this.#freshProfileNames()).has(local);
        } catch {
          return true;
        }
      },
      ...(opts.onGroupEscalation === undefined
        ? {}
        : { escalate: opts.onGroupEscalation }),
    });
  }
  /** The Hermes profile id behind a PUBLIC room member name, or `undefined` when this endpoint
   *  cannot own that name at all. Identity on the un-namespaced endpoint; the part after this
   *  endpoint's prefix on a namespaced one, where a name carrying somebody else's prefix (or no
   *  prefix, which is how a gateway runtime bot is named) is not a profile here. */
  #localProfile(name: string): string | undefined {
    if (this.#roomNamespace === undefined) return name;
    const prefix = `${this.#roomNamespace}:`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
  }
  #memberInfo(name: string): GroupMember {
    const local = this.#localProfile(name) ?? name;
    const row = this.#rosterRow(local);
    return {
      name,
      // The handle is the address a client @-mentions, so on a namespaced endpoint it is the
      // public name, not the profile id the roster cache stores its row under.
      handle: this.#roomNamespace === undefined ? row?.handle ?? botHandle(name) : name,
      displayName: row?.displayName ?? botDisplayName(local, null),
    };
  }
  /** The roster row a room member is named after. The cached Hermes rows answer for every
   *  Dashboard-backed bot; a runtime bot has no row there at all, and its row exists only in the
   *  data plane's overlay, so that is asked second and only for a name the runtime set claims.
   *  Reading the overlay for every member would make a room turn pay for the whole roster. */
  #rosterRow(name: string): BotSummary | undefined {
    const bots = this.#storage.botRoster().bots;
    const row = bots.find((bot) => bot.name === name);
    if (row !== undefined) return row;
    if (this.#rosterOverlay === undefined || !this.#runtimeBotNames().has(name)) return undefined;
    return this.#rosterOverlay(bots).find((bot) => bot.name === name);
  }
  groups(): BotGroup[] {
    return this.#groups.list();
  }
  createGroup(name: string, members: string[], owningHost?: string): Promise<BotGroup> {
    return this.#groups.create(name, members, owningHost);
  }
  deleteGroup(name: string): void {
    this.#groups.remove(name);
  }
  groupDetail(name: string): BotGroupDetail {
    return this.#groups.detail(name);
  }
  sendGroupMessage(
    name: string,
    text: string,
    opts: { clientId?: string; threadId?: string } = {},
  ): BotGroupMessage {
    return this.#groups.send(name, text, opts);
  }
  updateGroup(name: string, patch: BotGroupPatchRequest): Promise<BotGroup> {
    return this.#groups.update(name, patch);
  }
  stopGroup(name: string): BotGroup {
    return this.#groups.stop(name);
  }
  compressGroupMember(name: string, member: string): Promise<{ member: string; text: string }> {
    return this.#groups.compress(name, member);
  }
  /** Capability 84. Hermes answers `image_data` (a data URL) or, when its download failed, `image`. */
  async generateGroupPicture(prompt: string): Promise<string> {
    const result = await this.#client.request("image.generate", { prompt, aspect_ratio: "square" }, { timeoutMs: 180_000 }) as
      { success?: boolean; image_data?: string; image?: string; error?: string } | null;
    const image = result?.image_data ?? result?.image;
    if (result?.success !== true || typeof image !== "string" || !image.startsWith("data:image/")) {
      throw new BackendUnavailable(result?.error ?? "Hermes could not generate a picture");
    }
    return image;
  }
  setGroupNativeTurns(endpoint: NativeGroupTurnEndpoint): void {
    this.#groups.setNativeTurns(endpoint);
  }
  /** Capability 51. Hands the rooms the native plane's interaction bookkeeping, once that plane
   *  exists. Without it a room still projects its cards; it just cannot arm their deadlines. */
  setGroupInteractionExpiry(expiry: RoomInteractionExpiry): void {
    this.#groups.setInteractionExpiry(expiry);
  }
  canAcceptGroupAttachEvent(
    agentId: string,
    frame: AttachV1EventFrame,
  ): boolean {
    return this.#groups.canAcceptAttachEvent(agentId, frame);
  }
  handleGroupAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean {
    return this.#groups.handleAttachEvent(agentId, frame);
  }
  start(): void {
    this.#client.onStateChange((state) => {
      if (state === "online") {
        this.refreshSoon("hermes online");
        this.#schedulePendingSeedRetry();
      }
    });
    this.#client.onEvent((event) => {
      if (event.type === "sessions.changed") this.refreshSoon(event.type);
      if (event.type === "cron.changed") this.#refreshRoutinesSoon();
      // Capability 87: an envelope landed in this Hermes's relay outbox. The courier is the phone.
      if (event.type === "bot_relay.outbox.pending") this.#broadcast({ type: "bot_relay_pending" });
    });
    this.#client.start();
    // Discovery can connect the shared client before this bridge subscribes.
    if (this.#client.state() === "online") {
      this.refreshSoon("hermes already online");
      this.#schedulePendingSeedRetry();
    }
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
  async createBot(input: BotCreateRequest): Promise<BotCreateResponse> {
    const name = validateNewBotName(input.name);
    const cloneFrom = input.cloneFrom === undefined ? undefined : normalizeProfileName(input.cloneFrom);
    // Capability 82: "Share keys & accounts" is on unless the person turned it off, which is the
    // only create any client below 82 ever sent (`share_auth: true`, keys mirrored by default).
    const shareKeys = input.shareKeys !== false;
    try {
      await this.#client.request("profiles.create", {
        name,
        description: input.description?.trim() ?? "",
        share_auth: shareKeys,
        ...(shareKeys ? {} : { mirror_credentials: false }),
        ...(cloneFrom === undefined ? {} : { clone_from: cloneFrom }),
        ...(input.cloneAll === true ? { clone_all: true } : {}),
        ...(input.noSkills === true ? { no_skills: true } : {}),
      });
    } catch (error) {
      if (
        error instanceof HermesRpcError &&
        (/already exists|file exists/i.test(error.message) ||
          (error.code === 4062 && cloneFrom === undefined && input.noSkills !== true))
      ) {
        throw new BotNameTaken(name);
      }
      // A missing clone source or `no_skills` beside a clone: Hermes' own sentence says which.
      if (error instanceof HermesRpcError && error.code === 4062) throw new ProfileOpInvalid(error.message);
      throw error;
    }
    // A clone brings the source's skills and toolsets, and that is the point of it: the blank
    // slate is for a bot starting from nothing.
    return this.#settleCreatedProfile(name, input, cloneFrom === undefined);
  }
  /** Everything after Hermes accepted a new profile, shared by a create, a duplicate and an
   *  import: restore, the attach-enrolling seed, the title, the roster row and the provisioner. */
  async #settleCreatedProfile(
    name: string,
    input: BotCreateRequest,
    blankSlate: boolean,
  ): Promise<BotCreateResponse> {
    this.#storage.restoreBot(name);

    // The profile exists from here on. Metadata is best-effort decoration, but the idempotent seed
    // is what enrolls its attach plugin.  Persist its original selection if Hermes is transiently
    // unavailable, rather than leaving a phone-created profile permanently outside the watcher.
    const warnings: string[] = [];
    let seedDeferred = false;
    const selection: BlankSlateSelection = {
      ...(input.toolsets === undefined ? {} : { toolsets: input.toolsets }),
      ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
    };
    // This lands immediately after Hermes accepted the profile.  A process crash or 429 during
    // the very first config read therefore cannot strand a real profile outside recovery.
    this.#storage.savePendingHermesProfileSeed({
      profile: name,
      selection,
      ...(blankSlate ? {} : { blankSlate: false }),
      attempts: 1,
      nextAttemptAt: this.#now() + this.#seedRetryDelay(1),
    });
    // Unconditional, where this used to be gated on the flag or a selection. The seed now also
    // writes the attach-plugin binding, and a bot without that binding is one nobody can talk to
    // (issue #183), so there is no configuration under which skipping this pass is correct.
    try {
      const seed = await this.#chain(name, () => seedBlankSlateProfile(this.#client, name, {
        blankSlate: this.#seedBlankSlateBots && blankSlate,
        selection,
        skillsOn: this.#blankSlateSkillsOn,
      }));
      this.#log(
        `bot ${name} seed: ${seed.wrote ? "written" : "already present"}` +
          `, blankSlate=${this.#seedBlankSlateBots}`,
      );
      this.#storage.removePendingHermesProfileSeed(name);
      if (seed.skillCatalogUnavailable) {
        // Loud, and named as its own failure rather than folded into the generic seed warning:
        // everything else about this bot came out right, and the one thing that did not is the
        // one that leaves it holding every installed playbook.
        this.#log(
          `bot ${name} skills NOT seeded: its skill catalog could not be read, so every installed skill starts on`,
        );
        warnings.push(
          "this bot's skill list could not be read, so it starts with every installed skill on; turn the ones you do not want off in its settings",
        );
      }
      if (seed.unknownToolsets.length > 0) {
        warnings.push(
          `hermes does not report these toolsets, so they were skipped: ${seed.unknownToolsets.join(", ")}`,
        );
      }
      if (seed.unknownMcpServers.length > 0) {
        warnings.push(
          `this bot's config defines no such MCP server, so they were skipped: ${seed.unknownMcpServers.join(", ")}`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#storage.savePendingHermesProfileSeed({
        profile: name,
        selection,
        ...(blankSlate ? {} : { blankSlate: false }),
        attempts: 1,
        nextAttemptAt: this.#now() + this.#seedRetryDelay(1),
      });
      seedDeferred = true;
      this.#schedulePendingSeedRetry();
      this.#log(`bot ${name} seed deferred for retry: ${detail}`);
      warnings.push(
        "the starting tool set could not be written yet; setup will retry automatically",
      );
    }

    const title = input.title?.trim();
    const meta: Record<string, unknown> = { ...(title ? { title } : {}), created: this.#now() };
    try {
      await this.#client.request("profiles.configure", { name, ui_meta: { [UI_META_KEY]: meta } });
    } catch {
      // The profile already exists. Metadata is presentation-only, so never turn a successful
      // create into a retry that can only collide with itself.
    }
    await this.refresh(`bot ${name} created`);
    let bot = this.#storage.botRoster().bots.find((row) => row.name === name);
    if (bot === undefined) {
      // Hidden is the one honest absence: the operator keeps this name off the roster this gateway
      // serves, so a 404 tells the truth. Anything else is the refresh having failed (it swallows
      // its own errors, by design), and a 404 for a profile Hermes just accepted is a lie the app
      // acts on: it drops the create and the bot appears, unexplained, on the next roster read.
      if (this.#hidden.has(name)) throw new BotNotFound(name);
      bot = this.#adoptCreatedRow(name, input.description?.trim() ?? "", meta);
    }
    // The provisioner can only make this bot chattable after its seed enables the attach plugin.
    // A deferred seed emits this lifecycle event from its successful retry instead.
    if (!seedDeferred)
      this.#profileChanged({ profile: name, change: "created" });
    return { bot, ...(warnings.length === 0 ? {} : { warnings }) };
  }
  /** The row for a profile Hermes accepted but `profiles.list` could not read back: built from
   *  exactly what the create sent, appended to the cached roster so a read in the meantime shows
   *  it, published, and superseded by Hermes' own row on the next successful refresh, which is
   *  requested right away. */
  #adoptCreatedRow(name: string, description: string, meta: Record<string, unknown>): BotSummary {
    const at = this.#now();
    const [row] = buildRoster(
      [{ name, description: description.length === 0 ? null : description, hasAvatar: false, meta, lastActiveAt: null, workerActiveAt: null, preview: null }],
      { hidden: this.#hidden, routedProfile: null, gatewayState: "idle", now: at },
    );
    if (row === undefined) throw new BotNotFound(name);
    const bots = [...this.#storage.botRoster().bots.filter((existing) => existing.name !== name), row];
    this.#storage.replaceBotRoster(bots.map((summary) => ({ name: summary.name, summary })), at);
    this.#publish(bots, at);
    this.#log(`bot ${name} created but the roster could not be read back; answering from the create and refreshing`);
    this.refreshSoon(`bot ${name} created (retry)`);
    return row;
  }
  #seedRetryDelay(attempts: number): number {
    return Math.min(
      SEED_RETRY_MAX_MS,
      this.#seedRetryBaseMs * (2 ** Math.max(0, attempts - 1)),
    );
  }
  /** Arms one timer for the earliest persisted profile seed.  The table, rather than this timer,
   * is the source of truth, so a container restart simply re-arms the same work after reconnect. */
  #schedulePendingSeedRetry(): void {
    if (this.#closed || this.#seedRetryInFlight !== undefined) return;
    const next = this.#storage.pendingHermesProfileSeeds()[0];
    if (next === undefined) return;
    // A second failed create may be due sooner than the timer already armed for the first one.
    // Re-arm only for that earlier durable deadline; otherwise preserve the existing timer.
    if (this.#seedRetryTimer !== undefined) {
      if (this.#seedRetryAt !== undefined && this.#seedRetryAt <= next.nextAttemptAt) return;
      clearTimeout(this.#seedRetryTimer);
      this.#seedRetryTimer = undefined;
    }
    const wait = Math.max(0, next.nextAttemptAt - this.#now());
    this.#seedRetryAt = next.nextAttemptAt;
    this.#seedRetryTimer = setTimeout(() => {
      this.#seedRetryTimer = undefined;
      this.#seedRetryAt = undefined;
      const retry = this.#retryPendingSeed(next.profile);
      this.#seedRetryInFlight = retry;
      const settled = (): void => {
        if (this.#seedRetryInFlight !== retry) return;
        this.#seedRetryInFlight = undefined;
        this.#schedulePendingSeedRetry();
      };
      void retry.then(settled, settled);
    }, wait);
    this.#seedRetryTimer.unref();
  }
  async #retryPendingSeed(profile: string): Promise<void> {
    await this.#chain(profile, async () => {
      const row = this.#storage.pendingHermesProfileSeeds()
        .find((seed) => seed.profile === profile);
      if (row === undefined || this.#closed) return;
      try {
        const seed = await seedBlankSlateProfile(this.#client, profile, {
          blankSlate: this.#seedBlankSlateBots && row.blankSlate !== false,
          selection: row.selection,
          skillsOn: this.#blankSlateSkillsOn,
        });
        // `close()` may have run while Hermes was answering.  The durable row is deliberately
        // left untouched for the next bridge process; its storage may already be closed.
        if (this.#closed) return;
        // A delete may have won while Hermes answered the seed request.  Do not emit a created
        // lifecycle event for that cancelled intent (and do not recreate any local state).
        if (!this.#storage.removePendingHermesProfileSeed(profile)) return;
        this.#log(
          `bot ${profile} deferred seed: ${seed.wrote ? "written" : "already present"}`,
        );
        this.#profileChanged({ profile, change: "created" });
      } catch (error) {
        // A delete (or shutdown) may have cancelled this intent while Hermes was answering.  Never
        // upsert from a stale retry, or a deleted profile could acquire a fresh recovery record.
        if (this.#closed) return;
        const current = this.#storage.pendingHermesProfileSeeds()
          .find((seed) => seed.profile === profile);
        if (this.#closed || current === undefined || current.attempts !== row.attempts) return;
        const detail = error instanceof Error ? error.message : String(error);
        const attempts = row.attempts + 1;
        // Keep `row.selection`, never an accidental later profile patch, as the create's intent.
        this.#storage.savePendingHermesProfileSeed({
          profile,
          selection: row.selection,
          ...(row.blankSlate === false ? { blankSlate: false } : {}),
          attempts,
          nextAttemptAt: this.#now() + this.#seedRetryDelay(attempts),
        });
        this.#log(`bot ${profile} deferred seed retry ${attempts} failed: ${detail}`);
      }
    });
  }
  /** The inverse of `createBot`, built for "no traces on the Hermes host": the dashboard's
   *  `DELETE /api/profiles/:name` removes the whole profile directory (config, API keys,
   *  memories, sessions, skills, cron, the synced attach plugin and its .env with the tokens),
   *  and only after that does the gateway purge its own projection and revoke the attach
   *  identity. Hermes being unreachable is therefore a refusal, never a local-only delete: a
   *  purge that leaves the profile alive on the host is the opposite of what this route
   *  promises. Hermes answering 404 with local state still present is the recovery half of the
   *  same promise: the purge and revocation proceed, reported as `already_absent`. */
  async deleteBot(name: string, opts: { force?: boolean } = {}): Promise<BotDeleteResponse> {
    const canon = normalizeProfileName(name);
    if (RESERVED_PROFILE_NAMES.has(canon))
      throw new BotNameInvalid(`"${canon}" is reserved and cannot be deleted through this route`);
    const active = this.#storage.nativeBotActiveTurn(canon);
    if (active !== undefined && opts.force !== true)
      throw new BotTurnActive(canon, active.turnId);
    return this.#chain(canon, async () => {
      let hermesProfile: BotDeleteResponse["hermesProfile"];
      try {
        await this.#client.dashboardJson(`/api/profiles/${encodeURIComponent(canon)}`, {
          method: "DELETE",
        });
        hermesProfile = "deleted";
      } catch (error) {
        if (error instanceof HermesRpcError && error.code === 404) {
          hermesProfile = "already_absent";
        } else if (error instanceof HermesRpcError) {
          // 400 is the dashboard's own refusal (the default-profile guard); anything else is the
          // backend failing. Either way nothing was deleted anywhere, so nothing is purged here.
          throw new BackendUnavailable(
            `hermes refused to delete profile "${canon}": ${error.message}`,
          );
        } else {
          throw new BackendUnavailable(
            `hermes could not be reached to delete profile "${canon}"; nothing was removed`,
          );
        }
      }
      // Remove only once Hermes has confirmed absence. A refused delete leaves its durable retry
      // intact; sharing this profile chain prevents an in-flight retry from restoring it later.
      this.#storage.removePendingHermesProfileSeed(canon);
      // Read BEFORE the purge empties the roster cache: this is the "did the gateway know it"
      // half of the 404 decision.
      const known = this.#storage.botRoster().bots.some((bot) => bot.name === canon);
      // The FIRST mutation once the host has committed, deliberately ahead of the purge: from here
      // on the bot's token authenticates nothing and its socket is closed, so no connection can
      // race the sweep and write rows back in behind it. It is not moved ahead of the Hermes call
      // for the mirror-image reason: a refusal above means nothing was deleted anywhere, and a bot
      // still alive on its host must keep its identity.
      const tokenRevoked = this.#revokeAttachIdentity(canon);
      const purged = this.#storage.purgeBot(canon);
      if (hermesProfile === "already_absent" && !known && Object.keys(purged).length === 0)
        throw new BotNotFound(canon);
      await this.refresh(`bot ${canon} deleted`);
      this.#profileChanged({ profile: canon, change: "deleted" });
      return {
        name: canon,
        hermesProfile,
        purged,
        tokenRevoked,
        residue: [
          `the box gateway config still maps profile ${canon} to its token env var`,
          `the box .env still carries this bot's attach token line (it can no longer authenticate)`,
          `the Hermes host may still have the launchd service ai.hermes.gateway-${canon} installed`,
          `host cleanup is queued when this gateway has an installer provisioner; the deletion fence keeps stale config and credentials disabled while cleanup completes`,
        ],
      };
    });
  }
  /** The create or delete has already succeeded on Hermes and in the roster; from here the hook
   *  is a courtesy to whoever provisions, never a reason to fail a request that is already true. */
  #profileChanged(event: ProfileChangeEvent): void {
    if (this.#onProfileChange === undefined) return;
    try {
      this.#onProfileChange(event);
    } catch (error) {
      this.#log(
        `profile change hook failed for ${event.profile} (${event.change}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  health(): BridgeLiveness {
    const liveness = this.#client.liveness();
    return {
      online: liveness.state === "online",
      since: liveness.since,
      reconnectAttempt: liveness.reconnectAttempt,
    };
  }
  refreshSoon(reason: string): void {
    if (this.#closed || this.#refreshTimer !== undefined) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.refresh(reason);
    }, CHANGE_DEBOUNCE_MS);
    this.#refreshTimer.unref();
  }
  async refresh(reason: string): Promise<void> {
    if (this.#closed) return;
    if (this.#refreshing !== undefined) {
      this.#dirty = true;
      return this.#refreshing;
    }
    const run = (async () => {
      try {
        const at = this.#now();
        const { profiles: listed } = parseProfilesList(
          await this.#client.request("profiles.list", {}),
        );
        const profiles = listed.filter((profile) => !this.#storage.isBotDeleted(profile.name));
        const publish = () => {
          const bots = buildRoster(profiles, {
            hidden: this.#hidden,
            routedProfile: null,
            gatewayState: "idle",
            now: at,
          });
          this.#storage.replaceBotRoster(
            bots.map((summary) => ({ name: summary.name, summary })),
            at,
          );
          this.#publish(bots, at);
        };
        // Publish with the fingerprints already known, then read what is due in the background
        // and republish only if a picture changed, and only if no newer refresh has run since.
        this.#avatarFingerprints.applyCached(profiles);
        publish();
        const generation = ++this.#rosterGeneration;
        void this.#avatarFingerprints.refresh(this.#client, profiles, at).then((changed) => {
          if (changed && generation === this.#rosterGeneration && !this.#closed) publish();
        }, () => {});
      } catch (error) {
        this.#log(
          `roster refresh failed (${reason}): ${error instanceof Error ? error.message : "unknown failure"}`,
        );
      } finally {
        this.#refreshing = undefined;
        if (this.#dirty && !this.#closed) {
          this.#dirty = false;
          void this.refresh(`${reason} (trailing)`);
        }
      }
    })();
    this.#refreshing = run;
    return run;
  }
  /** The native data plane is assembled after this bridge and owns the local conversation
   * identity, so it hands its overlay back here. Without it the `bot_roster` frame is built from
   * `profiles.list` alone and disagrees with `GET /bots` about the same rows. */
  setRosterOverlay(overlay: (bots: readonly BotSummary[]) => BotSummary[]): void {
    this.#rosterOverlay = overlay;
    // A frame published before the overlay existed carried the un-overlaid rows. Drop the
    // dedupe memory so the corrected roster goes out on the next refresh rather than being
    // suppressed as unchanged.
    this.#lastRoster = "";
    this.#lastActive = "";
  }
  #publish(rawBots: BotSummary[], updatedAt: number): void {
    const bots =
      this.#rosterOverlay === undefined ? rawBots : this.#rosterOverlay(rawBots);
    const json = JSON.stringify(bots);
    if (json !== this.#lastRoster) {
      this.#lastRoster = json;
      this.#broadcast({ type: "bot_roster", bots, updatedAt });
    }
    const active = bots.filter((bot) => bot.active).map((bot) => bot.name);
    const activeJson = JSON.stringify(active);
    if (activeJson !== this.#lastActive) {
      this.#lastActive = activeJson;
      this.#broadcast({ type: "bot_presence", active, updatedAt });
    }
  }
  async #assertBotKnown(name: string): Promise<void> {
    if (!(await this.#freshProfileNames()).has(name))
      throw new BotNotFound(name);
  }
  async #freshProfileNames(): Promise<Set<string>> {
    const { profiles } = parseProfilesList(
      // Membership needs names only. Avoid a state.db walk per profile on hot route checks; the
      // roster refresh remains the one reader that requests session previews and activity.
      await this.#client.request("profiles.list", { include_sessions: false }),
    );
    return new Set(profiles.map((profile) => profile.name));
  }
  /** Capability 82. One door for the profile operations, so a federation member and the native
   *  plane each route them with one line rather than twelve. */
  async profileOp(name: string, op: BotProfileOp): Promise<unknown> {
    const client = this.#client;
    // Hermes resolves the profile name `current` to the launch profile, so an env or hub call
    // addressed to it would change a different bot. It is reserved for new names too (crud.ts).
    if (normalizeProfileName(name) === "current")
      throw new BotNameInvalid(`"current" names the launch profile in Hermes and cannot be operated on here`);
    switch (op.kind) {
      case "import": {
        const target = validateNewBotName(name);
        const imported = await importProfileArchive(client, target, op.archive);
        return this.#settleCreatedProfile(imported, { name: imported }, false);
      }
      case "rename": {
        const canon = normalizeProfileName(name);
        if (RESERVED_PROFILE_NAMES.has(canon))
          throw new BotNameInvalid(`"${canon}" is reserved and cannot be renamed through this route`);
        const target = validateNewBotName(op.newName);
        await this.#assertBotKnown(canon);
        const active = this.#storage.nativeBotActiveTurn(canon);
        if (active !== undefined) throw new BotTurnActive(canon, active.turnId);
        return this.#chain(canon, async () => {
          const renamed = await renameProfile(client, canon, target);
          // The old attach identity names a profile that no longer exists; the provisioner enrols
          // the new name the same way it enrols a phone-created bot.
          this.#revokeAttachIdentity(canon);
          await this.refresh(`bot ${canon} renamed to ${renamed}`);
          this.#profileChanged({ profile: renamed, change: "created" });
          const bot = this.#storage.botRoster().bots.find((row) => row.name === renamed)
            ?? this.#adoptCreatedRow(renamed, "", {});
          return { bot };
        });
      }
      case "duplicate": {
        await this.#assertBotKnown(name);
        const target = op.newName === undefined
          ? await freeDuplicateName(client, name, op.avoid)
          : validateNewBotName(op.newName);
        const source = this.#storage.botRoster().bots.find((row) => row.name === name);
        const created = await this.createBot({
          name: target,
          cloneFrom: name,
          cloneAll: true,
          ...(source?.description ? { description: source.description } : {}),
        });
        await copyBotLook(client, name, target);
        await this.refresh(`bot ${target} duplicated from ${name}`);
        const bot = this.#storage.botRoster().bots.find((row) => row.name === target) ?? created.bot;
        return { ...created, bot };
      }
      default:
        break;
    }
    await this.#assertBotKnown(name);
    switch (op.kind) {
      case "identity": {
        const identity = await this.#chain(name, () => setBotIdentity(client, name, op.patch));
        this.refreshSoon(`bot ${name} identity`);
        return identity;
      }
      case "describeAuto": {
        const described = await describeProfileAuto(client, name, op.overwrite);
        this.refreshSoon(`bot ${name} described`);
        return described;
      }
      case "export":
        return exportProfileArchive(client, name);
      case "modelPin":
        return readProfileModelPin(client, name);
      case "pinModel":
        return this.#chain(name, () => pinProfileModel(client, name, op.request));
      case "unpinModel":
        return this.#chain(name, () => unpinProfileModel(client, name));
      case "providerKeys":
        return listProviderKeys(client, name);
      case "saveProviderKey":
        return this.#chain(name, () => saveProviderKey(client, name, op.provider, op.apiKey));
      case "disconnectProvider":
        return this.#chain(name, () => disconnectProvider(client, name, op.provider));
      case "skillsHubSearch":
        return searchSkillsHub(client, name, op.query);
      case "skillsHubInstall":
        return this.#chain(name, () => installHubSkill(client, name, op.identifier));
    }
  }
  async botProfile(name: string): Promise<BotProfile> {
    await this.#assertBotKnown(name);
    return readBotProfile(this.#client, name);
  }
  async configureProfile(
    name: string,
    patch: BotProfilePatch,
  ): Promise<ProfileConfigureResult> {
    await this.#assertBotKnown(name);
    return this.#chain(name, () =>
      configureBotProfile(this.#client, name, patch),
    );
  }
  async botPresentation(name: string): Promise<BotPresentationResponse> {
    const read = await readPresentation(this.#client, name);
    if (read === undefined) throw new BotNotFound(name);
    return { name, presentation: read.presentation, revision: read.revision ?? 0 };
  }
  async canonicalBotChat(name: string, create: boolean): Promise<{ hermesSessionId: string; created: boolean } | null> {
    await this.#assertBotKnown(name);
    const found = await findCanonicalBotChat(this.#client, name);
    if (found === null && !create) return null;
    // Serialized with every other write to this profile, so two taps cannot mint two chats here.
    const result = found !== null
      ? { hermesSessionId: found.hermesSessionId, created: false }
      : await this.#chain(name, async () => {
          const again = await findCanonicalBotChat(this.#client, name);
          if (again !== null) return { hermesSessionId: again.hermesSessionId, created: false };
          return { hermesSessionId: (await createCanonicalBotChat(this.#client, name)).hermesSessionId, created: true };
        });
    try {
      if (await this.#chain(name, () => ensureBotModeMarker(this.#client, name)))
        this.refreshSoon(`bot ${name} bot-mode marker`);
    } catch {
      // The marker switches on bot-to-bot messaging; its absence never blocks the chat itself.
    }
    return result;
  }
  async archiveHermesSession(name: string, hermesSessionId: string): Promise<void> {
    await this.#assertBotKnown(name);
    // Archived AND hidden: Hermes retires a Bot Chat (hands its title to the next one) only then.
    await this.#client.dashboardJson(`/api/sessions/${encodeURIComponent(hermesSessionId)}`, {
      method: "PATCH",
      body: { archived: true, hidden: true, profile: name },
    });
  }
  async configurePresentation(name: string, patch: BotPresentationPatch): Promise<BotPresentationResponse> {
    // Chained per profile with every other write to it, so this gateway never races itself; the
    // CAS inside `writePresentation` is for the OTHER clients (a desktop, another gateway).
    const written = await this.#chain(name, () => writePresentation(this.#client, name, patch));
    if (written === undefined) throw new BotNotFound(name);
    // `bot_roster` carries the blob as `meta`, so every paired phone sees the write on this refresh.
    this.refreshSoon(`bot ${name} presentation`);
    return { name, presentation: written.presentation, revision: written.revision ?? 0 };
  }
  relayRosterSync(agents: BotRelayAgent[]): Promise<{ count: number }> {
    return relayRosterSync(this.#client, agents);
  }
  #installId: Promise<string | undefined> | undefined;
  relayInstallId(): Promise<string | undefined> {
    // Stable for the install's life; a failed read is retried on the next ask.
    const read = this.#installId ?? relayInstallId(this.#client);
    this.#installId = read.then((id) => {
      if (id === undefined) this.#installId = undefined;
      return id;
    });
    return this.#installId;
  }
  relayDrain(): Promise<BotRelayDrainResponse> {
    return relayDrain(this.#client);
  }
  relayDeliver(req: BotRelayDeliverRequest): Promise<BotRelayDeliverResponse> {
    return relayDeliver(this.#client, req);
  }
  relayReply(req: BotRelayReplyRequest): Promise<{ ok: true }> {
    return relayReply(this.#client, req);
  }
  async botAvatar(name: string): Promise<{ mime: string; bytes: Buffer } | undefined> {
    // Every row image is a GET; the cached roster answers "is this a bot" without a profiles.list.
    if (!this.#storage.botRoster().bots.some((bot) => bot.name === name)) await this.#assertBotKnown(name);
    return readAvatar(this.#client, name);
  }
  async setBotAvatar(name: string, data: string | null): Promise<BotAvatarSetResponse> {
    await this.#assertBotKnown(name);
    const size = await this.#chain(name, async () => {
      if (data === null) {
        await clearAvatar(this.#client, name);
        return 0;
      }
      return writeAvatar(this.#client, name, data);
    });
    // `has_avatar` rides `profiles.list`, so the roster learns of it on this refresh, and the
    // fingerprint is re-read so the image URL moves with the picture.
    this.#avatarFingerprints.forget(name);
    this.refreshSoon(`bot ${name} avatar`);
    return { name, hasAvatar: data !== null, size };
  }
  // Image generation and the pet gallery are host-wide in Hermes; the bot name only routes the call
  // (federation) and scopes the device's permission. No per-call `profiles.list` for them.
  async generateBotAvatar(_name: string, request: BotAvatarGenerateRequest): Promise<BotAvatarGenerateResponse> {
    return generatePortrait(this.#client, request);
  }
  async botAvatarPets(_name: string, localOnly: boolean): Promise<BotAvatarPetGallery> {
    return { pets: await petGallery(this.#client, localOnly) };
  }
  /** The spritesheet URL is resolved HERE, from Hermes's own gallery, never taken from the client:
   *  Hermes caches a thumbnail by slug, so a client naming another sheet could poison that slug's
   *  thumbnail for every desktop. The gallery is cached for five minutes. */
  async botAvatarPetThumb(_name: string, slug: string, _clientUrl: string): Promise<BotAvatarPetThumbResponse> {
    const now = this.#now();
    if (this.#petGallery === undefined || now - this.#petGallery.at > 300_000) {
      const pets = await petGallery(this.#client, false);
      this.#petGallery = { at: now, pets: new Map(pets.map((pet) => [pet.slug, pet.spritesheetUrl])) };
    }
    const image = await petThumb(this.#client, slug, this.#petGallery.pets.get(slug) ?? "");
    return image === undefined ? { ok: false } : { ok: true, image };
  }
  async botVoice(name: string): Promise<BotVoice> {
    await this.#assertBotKnown(name);
    return readBotVoice(this.#client, name);
  }
  async speakBot(name: string, text: string, signal?: AbortSignal): Promise<BotSpeech> {
    await this.#assertBotKnown(name);
    return speakThroughHermes(this.#client, name, text, signal === undefined ? {} : { signal });
  }
  async modelConfig(name: string): Promise<BotModelConfig> {
    await this.#assertBotKnown(name);
    return readBotModelConfig(this.#client, name);
  }
  async configureModel(
    name: string,
    patch: BotModelConfigPatch,
  ): Promise<BotModelConfig> {
    await this.#assertBotKnown(name);
    return this.#chain(name, () =>
      writeBotModelConfig(this.#client, name, patch),
    );
  }
  async modelProviders(name: string): Promise<BotModelProviderSetupCatalog> {
    await this.#assertBotKnown(name);
    return readProviderSetupCatalog(this.#client, name, this.#now);
  }
  async configureModelProviderField(
    name: string, provider: string, field: string, value: string,
  ): Promise<BotModelProviderSetupCatalog> {
    await this.#assertBotKnown(name);
    return this.#chain(name, () => writeProviderSetupField(this.#client, name, provider, field, value));
  }
  async clearModelProviderField(
    name: string, provider: string, field: string,
  ): Promise<BotModelProviderSetupCatalog> {
    await this.#assertBotKnown(name);
    return this.#chain(name, () => deleteProviderSetupField(this.#client, name, provider, field));
  }
  async startModelProviderOAuth(
    name: string, provider: string,
  ): Promise<BotModelProviderOAuthSession> {
    await this.#assertBotKnown(name);
    return this.#chain(name, () => startProviderOAuth(this.#client, name, provider));
  }
  async pollModelProviderOAuth(
    name: string, provider: string, sessionId: string,
  ): Promise<BotModelProviderOAuthSession> {
    await this.#assertBotKnown(name);
    return pollProviderOAuth(this.#client, name, provider, sessionId);
  }
  async submitModelProviderOAuthCode(
    name: string, provider: string, sessionId: string, code: string,
  ): Promise<BotModelProviderOAuthSession> {
    await this.#assertBotKnown(name);
    return this.#chain(name, () => submitProviderOAuthCode(this.#client, name, provider, sessionId, code));
  }
  async cancelModelProviderOAuth(name: string, provider: string, sessionId: string): Promise<void> {
    await this.#assertBotKnown(name);
    await cancelProviderOAuth(this.#client, name, provider, sessionId);
  }
  async catalog(query: string): Promise<BotCatalog> {
    const cached = this.#catalog.get(query);
    const now = this.#now();
    if (cached !== undefined && now - cached.fetchedAt < cached.ttlMs)
      return cached.catalog;
    const pending = this.#catalogInflight.get(query);
    if (pending !== undefined) return pending;
    const run = readBotCatalog(this.#client, query, now)
      .then((catalog) => {
        this.#catalog.set(query, {
          catalog,
          fetchedAt: now,
          ttlMs:
            catalog.unavailable.length === 0
              ? this.#catalogTtlMs
              : this.#catalogDegradedTtlMs,
        });
        while (this.#catalog.size > CATALOG_CACHE_MAX)
          this.#catalog.delete(this.#catalog.keys().next().value!);
        return catalog;
      })
      .finally(() => this.#catalogInflight.delete(query));
    this.#catalogInflight.set(query, run);
    return run;
  }
  async desktopSessions(name: string): Promise<BotDesktopHermesSession[]> {
    await this.#assertBotKnown(name);
    // Never project Dashboard text into this seam. A title/preview can contain a prompt, a host
    // path, tool output, or a private desktop-only label. Source + opaque id + timestamps are
    // sufficient for an explicit resume picker.
    return (await listBotSessions(this.#client, name, 200))
      .filter(isDesktopHermesSession)
      .map((row) => {
        const origin = interactiveHermesSessionSource(row)!;
        const lastResumedAt = this.#storage.nativeDesktopResumeAt(name, row.id);
        return {
          source: "hermes_desktop" as const,
          origin,
          hermesSessionId: row.id,
          // Do not forward a host-authored title: it can be a prompt, a path, or a private desktop
          // label. The stable generic label still lets a client render an accessible picker row.
          title: origin === "desktop" ? "Hermes Desktop session"
            : origin === "tui" ? "Hermes TUI session" : "Hermes CLI session",
          startedAt: row.startedAt,
          lastActiveAt: row.lastActiveAt,
          ...(lastResumedAt === undefined ? {} : { lastResumedAt }),
        };
      })
      .sort((a, b) =>
        b.lastActiveAt - a.lastActiveAt ||
        b.startedAt - a.startedAt ||
        a.hermesSessionId.localeCompare(b.hermesSessionId));
  }
  async desktopSessionTranscript(name: string, hermesSessionId: string): Promise<BotChatMessage[]> {
    await this.#assertBotKnown(name);
    const snapshot = parseChatSnapshot(
      await this.#client.request("session.resume", { profile: name, session_id: hermesSessionId }),
      hermesSessionId,
    );
    // parseChatSnapshot drops system/tool rows and Hermes media directives. Strip any remaining
    // disk paths in ordinary rendered text as a defense-in-depth boundary before persistence.
    return snapshot.messages.map((message) => ({
      ...message,
      text: redactHostPaths(message.text),
    }));
  }
  async routines(name: string): Promise<BotRoutineList> {
    await this.#assertBotKnown(name);
    return this.#readRoutines(name);
  }
  async createRoutine(
    name: string,
    input: BotRoutineCreateRequest,
  ): Promise<RoutineWriteResult> {
    await this.#assertBotKnown(name);
    return this.#chain(name, async () => {
      try {
        const routine = await createBotRoutine(
          this.#client,
          name,
          input,
          this.#bridgeProfile,
        );
        const overrides = {
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
        };
        this.#storage.setBotRoutineOverrides(name, routine.id, overrides);
        return { routine: { ...routine, ...overrides } };
      } finally {
        await this.#publishRoutines(name);
      }
    });
  }
  async patchRoutine(
    name: string,
    id: string,
    patch: BotRoutinePatch,
  ): Promise<RoutineWriteResult> {
    await this.#assertBotKnown(name);
    return this.#chain(name, async () => {
      try {
        const result = await patchBotRoutine(
          this.#client,
          name,
          id,
          patch,
          this.#bridgeProfile,
        );
        const overrides = {
          ...(this.#storage.botRoutineOverrides(name, id) ?? {}),
          ...(patch.model === undefined ? {} : { model: patch.model }),
          ...(patch.effort === undefined ? {} : { effort: patch.effort }),
        };
        if (result.routine.id !== id)
          this.#storage.deleteBotRoutineOverrides(name, id);
        this.#storage.setBotRoutineOverrides(
          name,
          result.routine.id,
          overrides,
        );
        return { ...result, routine: { ...result.routine, ...overrides } };
      } finally {
        await this.#publishRoutines(name);
      }
    });
  }
  async deleteRoutine(name: string, id: string): Promise<void> {
    await this.#assertBotKnown(name);
    await this.#chain(name, async () => {
      try {
        await deleteBotRoutine(this.#client, name, id);
        this.#storage.deleteBotRoutineOverrides(name, id);
      } finally {
        await this.#publishRoutines(name);
      }
    });
  }
  async runRoutine(name: string, id: string): Promise<BotRoutineRunStarted> {
    await this.#assertBotKnown(name);
    const started = await runBotRoutine(this.#client, name, id, this.#now);
    // The run finishes long after the answer; the list it changed goes out when it does.
    void started.settled.then(() => this.#publishRoutines(name));
    return { routine: started.routine, startedAt: started.startedAt };
  }
  async routineRuns(name: string, id: string, limit?: number): Promise<BotRoutineRunRecord[]> {
    await this.#assertBotKnown(name);
    return listBotRoutineRuns(this.#client, name, id, limit);
  }
  async routineRunOutput(name: string, id: string, runId: string): Promise<string | null> {
    await this.#assertBotKnown(name);
    return readBotRoutineRunOutput(this.#client, name, id, runId);
  }
  async routineBlueprints(name: string): Promise<BotRoutineBlueprint[]> {
    await this.#assertBotKnown(name);
    return listRoutineBlueprints(this.#client, name);
  }
  async instantiateRoutineBlueprint(name: string, key: string, values: Record<string, string>): Promise<BotRoutine> {
    await this.#assertBotKnown(name);
    return this.#chain(name, async () => {
      try {
        return await instantiateRoutineBlueprint(this.#client, name, key, values);
      } finally {
        await this.#publishRoutines(name);
      }
    });
  }
  async #chain<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(name);
    const run = (async () => {
      await previous?.catch(() => {});
      return work();
    })();
    this.#chains.set(name, run);
    try {
      return await run;
    } finally {
      if (this.#chains.get(name) === run) this.#chains.delete(name);
    }
  }
  async #readRoutines(name: string): Promise<BotRoutineList> {
    const listed = await listBotRoutines(this.#client, name);
    const routines = listed.routines.map(
      (routine) => ({
        ...routine,
        ...(this.#storage.botRoutineOverrides(name, routine.id) ?? {}),
      }),
    );
    const updatedAt = this.#now();
    this.#routineWatch.set(name, updatedAt);
    const json = JSON.stringify(routines);
    if (json !== this.#lastRoutines.get(name)) {
      this.#lastRoutines.set(name, json);
      this.#broadcast({ type: "bot_routines", bot: name, routines, updatedAt });
    }
    return {
      name,
      routines,
      updatedAt,
      ...(listed.schedulerRunning === undefined ? {} : { schedulerRunning: listed.schedulerRunning }),
    };
  }
  async #publishRoutines(name: string): Promise<void> {
    try {
      await this.#readRoutines(name);
    } catch (error) {
      this.#log(
        `routines refresh failed for ${name}: ${error instanceof Error ? error.message : "unknown failure"}`,
      );
    }
  }
  #refreshRoutinesSoon(): void {
    if (this.#routineTimer !== undefined) return;
    this.#routineTimer = setTimeout(() => {
      this.#routineTimer = undefined;
      for (const name of this.#routineWatch.keys())
        void this.#publishRoutines(name);
    }, CHANGE_DEBOUNCE_MS);
    this.#routineTimer.unref();
  }
  setFocus(deviceId: string, screen: BotFocusScreen | null): void {
    if (screen === null) this.#focus.delete(deviceId);
    else this.#focus.set(deviceId, { screen, at: this.#now() });
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    if (this.#routineTimer !== undefined) clearTimeout(this.#routineTimer);
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    if (this.#seedRetryTimer !== undefined) clearTimeout(this.#seedRetryTimer);
    await this.#groups.close();
    await this.#client.close();
  }
}

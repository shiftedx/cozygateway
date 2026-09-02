import type {
  BotAttachmentHistoryItem,
  BotCatalog,
  BotCreateRequest,
  BotCreateResponse,
  BotDeleteResponse,
  BotDesktopHermesSession,
  BotDesktopHermesResumeResponse,
  BotChatMessage,
  BotChatStateCause,
  BotMobileReceipt,
  BotChatStatus,
  BotGroup,
  BotGroupDetail,
  BotGroupMessage,
  BotModelConfig,
  BotModelConfigPatch,
  BotModelProviderOAuthSession,
  BotModelProviderSetupCatalog,
  BotInteractionSettlement,
  BotPendingClarification,
  BotPendingApproval,
  BotProfile,
  BotProfilePatch,
  BotReadiness,
  BotRuntimeProjection,
  BotRoutine,
  BotRoutineCreateRequest,
  BotRoutinePatch,
  BotSummary,
  BotSlashCommand,
  BotTurnToolSteps,
  BotTurnDelegations,
  BridgeLiveness,
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
  classifyPreview,
  parseProfilesList,
  UI_META_KEY,
} from "./roster.ts";
import type { GroupMember } from "./group-protocol.ts";
import type {
  BotApprovalDecision,
  BotClarifyResolveOutcome,
  BotApprovalResolveOutcome,
} from "./approvals.ts";
import { GroupRooms, type RoomInteractionExpiry } from "./group-rooms.ts";
import type { NativeGroupTurnEndpoint } from "./group-turn.ts";
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
  listBotRoutines,
  patchBotRoutine,
  type RoutineWriteResult,
} from "./routines.ts";
import { readBotModelConfig, writeBotModelConfig } from "./model-config.ts";
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
/** The answer a bridge with no runtime bots configured gives, allocated once: this is read on every
 *  member boundary of every room. */
const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();
export type BotFocusScreen = "roster" | "routines";
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

export interface BotControlSurface {
  roster(): BotRosterView;
  createBot(input: BotCreateRequest): Promise<BotCreateResponse>;
  deleteBot(name: string, opts?: { force?: boolean }): Promise<BotDeleteResponse>;
  health(): BridgeLiveness;
  refreshSoon(reason: string): void;
  botProfile(name: string): Promise<BotProfile>;
  configureProfile(
    name: string,
    patch: BotProfilePatch,
  ): Promise<ProfileConfigureResult>;
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
  setFocus(deviceId: string, screen: BotFocusScreen | null): void;
  groups(): BotGroup[];
  createGroup(name: string, members: string[]): Promise<BotGroup>;
  deleteGroup(name: string): void;
  groupDetail(name: string): BotGroupDetail;
  sendGroupMessage(
    name: string,
    text: string,
    opts?: { clientId?: string },
  ): BotGroupMessage;
}
export interface BotsSurface extends BotControlSurface {
  readiness(name: string): BotReadiness;
  /** Capability 49: the runtime projection for a gateway-owned runtime bot. Optional because a
   * gateway with no runner lane has no runtime to project and the route is then not registered at
   * all, which is the honest answer rather than a stage invented from nothing. */
  botRuntime?(name: string): BotRuntimeProjection;
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
  newSession(name: string): Promise<BotNewSessionResult>;
  resetChat(name: string): Promise<ChatResetResult>;
  sessions(name: string, limit: number): Promise<BotSessionsView>;
  adoptSession(
    name: string,
    sessionId: string,
    limit: number,
  ): Promise<BotSessionAdoption>;
  chatHistory(name: string): Promise<BotChatHistory>;
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
  ): Promise<BotApprovalResolveOutcome>;
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
  ): { recorded: number };
  desktopSessions(name: string): Promise<BotDesktopHermesSession[]>;
  resumeDesktopSession(name: string, hermesSessionId: string): Promise<BotDesktopHermesResumeResponse>;
}

export interface HermesBridgeOptions {
  client: HermesClient;
  storage: Storage;
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
  /** Bot names served by a non-Hermes runtime (capability 45), read fresh on every call because
   *  the set is config-declared and the bridge is built before the data plane that knows it.
   *
   *  Room membership is the only thing that consults it. A runtime bot has no Dashboard profile,
   *  so `profiles.list` can never name it, and every membership check that asks Hermes alone would
   *  report a bot the roster is visibly listing as "not a bot on this gateway". Capability 46 makes
   *  the runtime set an equal source of that answer, which is also what lets a room made only of
   *  runtime bots run on a gateway whose Hermes is unreachable. */
  runtimeBotNames?: () => ReadonlySet<string>;
  rosterPollMs?: number;
  routinesPollMs?: number;
  focusTtlMs?: number;
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
}

/** Dashboard control/read plane. All Bot Mode conversation traffic is attach-v1. */
export class HermesBridge implements BotControlSurface {
  readonly #client: HermesClient;
  readonly #storage: Storage;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #hidden: ReadonlySet<string>;
  readonly #bridgeProfile: string | undefined;
  readonly #seedBlankSlateBots: boolean;
  readonly #blankSlateSkillsOn: readonly string[];
  readonly #log: (line: string) => void;
  readonly #groups: GroupRooms;
  readonly #catalog = new Map<string, CachedCatalog>();
  readonly #catalogInflight = new Map<string, Promise<BotCatalog>>();
  readonly #catalogTtlMs: number;
  readonly #catalogDegradedTtlMs: number;
  readonly #revokeAttachIdentity: (name: string) => boolean;
  readonly #runtimeBotNames: () => ReadonlySet<string>;
  readonly #chains = new Map<string, Promise<unknown>>();
  readonly #routineWatch = new Map<string, number>();
  readonly #lastRoutines = new Map<string, string>();
  readonly #focus = new Map<string, { screen: BotFocusScreen; at: number }>();
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #routineTimer: ReturnType<typeof setTimeout> | undefined;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.#catalogTtlMs = opts.catalogTtlMs ?? CATALOG_TTL_MS;
    this.#catalogDegradedTtlMs =
      opts.catalogDegradedTtlMs ?? CATALOG_DEGRADED_TTL_MS;
    this.#revokeAttachIdentity = opts.revokeAttachIdentity ?? (() => false);
    this.#runtimeBotNames = opts.runtimeBotNames ?? ((): ReadonlySet<string> => EMPTY_NAMES);
    this.#log =
      opts.logSink ??
      ((line) => void process.stderr.write(`[hermes-bridge] ${line}\n`));
    this.#groups = new GroupRooms({
      storage: this.#storage,
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
        const known = await this.#freshProfileNames();
        return asked.filter((name) => !known.has(name));
      },
      memberKnown: (name) => {
        if (this.#runtimeBotNames().has(name)) return true;
        const bots = this.#storage.botRoster().bots;
        return bots.length === 0
          ? undefined
          : bots.some((bot) => bot.name === name);
      },
      // Capability 51. Only a runtime member's room turn projects approvals, clarifications and
      // tool steps; a Hermes member's room turn keeps dropping them.
      isRuntimeMember: (name) => this.#runtimeBotNames().has(name),
      memberExists: async (name) => {
        // Checked before the round trip for the same reason: `profiles.list` never names a runtime
        // bot, so asking it would answer `false` and retire a perfectly live member.
        if (this.#runtimeBotNames().has(name)) return true;
        try {
          return (await this.#freshProfileNames()).has(name);
        } catch {
          return true;
        }
      },
      ...(opts.onGroupEscalation === undefined
        ? {}
        : { escalate: opts.onGroupEscalation }),
    });
  }
  #memberInfo(name: string): GroupMember {
    const row = this.#rosterRow(name);
    return {
      name,
      handle: row?.handle ?? botHandle(name),
      displayName: row?.displayName ?? botDisplayName(name, null),
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
  createGroup(name: string, members: string[]): Promise<BotGroup> {
    return this.#groups.create(name, members);
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
    opts: { clientId?: string } = {},
  ): BotGroupMessage {
    return this.#groups.send(name, text, opts);
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
      if (state === "online") this.refreshSoon("hermes online");
    });
    this.#client.onEvent((event) => {
      if (event.type === "sessions.changed") this.refreshSoon(event.type);
      if (event.type === "cron.changed") this.#refreshRoutinesSoon();
    });
    this.#client.start();
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
    try {
      await this.#client.request("profiles.create", {
        name,
        description: input.description?.trim() ?? "",
        share_auth: true,
      });
    } catch (error) {
      if (
        error instanceof HermesRpcError &&
        (error.code === 4062 || /already exists|file exists/i.test(error.message))
      ) {
        throw new BotNameTaken(name);
      }
      throw error;
    }

    // The profile exists from here on. Everything below is best-effort decoration of a create that
    // already succeeded: a failure is logged loudly and reported in `warnings`, never turned into a
    // retry that can only collide with itself or into a 500 over a bot that now exists.
    const warnings: string[] = [];
    const selection: BlankSlateSelection = {
      ...(input.toolsets === undefined ? {} : { toolsets: input.toolsets }),
      ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
    };
    // Unconditional, where this used to be gated on the flag or a selection. The seed now also
    // writes the attach-plugin binding, and a bot without that binding is one nobody can talk to
    // (issue #183), so there is no configuration under which skipping this pass is correct.
    try {
      const seed = await seedBlankSlateProfile(this.#client, name, {
        blankSlate: this.#seedBlankSlateBots,
        selection,
        skillsOn: this.#blankSlateSkillsOn,
      });
      this.#log(
        `bot ${name} seed: ${seed.wrote ? "written" : "already present"}` +
          `, blankSlate=${this.#seedBlankSlateBots}`,
      );
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
      this.#log(`bot ${name} seed FAILED, it starts on hermes platform defaults: ${detail}`);
      warnings.push(
        "the starting tool set could not be written, so this bot starts on Hermes' own defaults",
      );
    }

    const title = input.title?.trim();
    try {
      await this.#client.request("profiles.configure", {
        name,
        ui_meta: {
          [UI_META_KEY]: {
            ...(title ? { title } : {}),
            created: this.#now(),
          },
        },
      });
    } catch {
      // The profile already exists. Metadata is presentation-only, so never turn a successful
      // create into a retry that can only collide with itself.
    }
    await this.refresh(`bot ${name} created`);
    const bot = this.#storage.botRoster().bots.find((row) => row.name === name);
    if (bot === undefined) throw new BotNotFound(name);
    return { bot, ...(warnings.length === 0 ? {} : { warnings }) };
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
    return {
      name: canon,
      hermesProfile,
      purged,
      tokenRevoked,
      residue: [
        `the box gateway config still maps profile ${canon} to its token env var`,
        `the box .env still carries this bot's attach token line (it can no longer authenticate)`,
        `the Hermes host may still have the launchd service ai.hermes.gateway-${canon} installed`,
        `run scripts/deprovision-bot.sh ${canon} to sweep all of these and restart the box gateway`,
      ],
    };
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
        const { profiles } = parseProfilesList(
          await this.#client.request("profiles.list", {}),
        );
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
      await this.#client.request("profiles.list", {}),
    );
    return new Set(profiles.map((profile) => profile.name));
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
    const routines = (await listBotRoutines(this.#client, name)).routines.map(
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
    return { name, routines, updatedAt };
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
    await this.#groups.close();
    await this.#client.close();
  }
}

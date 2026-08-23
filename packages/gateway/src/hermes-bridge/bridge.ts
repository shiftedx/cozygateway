import type {
  BotCatalog,
  BotCreateRequest,
  BotChatMessage,
  BotChatStateCause,
  BotChatStatus,
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
import type { AttachV1EventFrame } from "../adapters/attach/protocol-v1.ts";
import type { Storage } from "../storage.ts";
import {
  HermesRpcError,
  HermesUnavailable,
  type HermesClient,
  type HermesState,
} from "./client.ts";
import {
  listBotSessions,
  sessionKind,
} from "./sessions.ts";
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
  BotApprovalResolveOutcome,
} from "./approvals.ts";
import { parseChatSnapshot } from "./chat-messages.ts";
import { inboxMessages as projectInboxMessages, inboxThread } from "./inbox.ts";
import { GroupRooms } from "./group-rooms.ts";
import type { NativeGroupTurnEndpoint } from "./group-turn.ts";
import { BotNameTaken, BotNotFound, validateNewBotName } from "./crud.ts";
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

export const ROSTER_POLL_MS = 5_000;
export const ROUTINES_POLL_MS = 20_000;
export const FOCUS_TTL_MS = 60_000;
export const ROUTINE_WATCH_TTL_MS = 5 * 60_000;
export const INBOX_THREAD_LIMIT = 50;
export const INBOX_SESSION_SCAN_LIMIT = 200;
const CHANGE_DEBOUNCE_MS = 250;
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
export interface BotInboxView {
  threads: BotInboxThread[];
}
export interface BotInboxMessagesView {
  messages: BotGroupMessage[];
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
  running: boolean;
  inflight: boolean;
  /** Capability 23 exact turn status. Absent only when this session has never run a turn. */
  status?: BotChatStatus;
  cause?: BotChatStateCause;
  queuedAt?: number;
  toolSteps?: BotTurnToolSteps[];
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
  createBot(input: BotCreateRequest): Promise<{ bot: BotSummary }>;
  health(): BridgeLiveness;
  refreshSoon(reason: string): void;
  inbox(name: string): Promise<BotInboxView>;
  inboxMessages(name: string, threadId: string): Promise<BotInboxMessagesView>;
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
  catalog(query: string): Promise<BotCatalog>;
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
  ): Promise<
    | "selected"
    | "unknown"
    | "not_pending"
    | "expired"
    | "invalid_option"
    | "unsupported"
  >;
}

export interface HermesBridgeOptions {
  client: HermesClient;
  storage: Storage;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  hiddenProfiles?: Iterable<string>;
  bridgeProfile?: string;
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
}

/** Dashboard control/read plane. All Bot Mode conversation traffic is attach-v1. */
export class HermesBridge implements BotControlSurface {
  readonly #client: HermesClient;
  readonly #storage: Storage;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #hidden: ReadonlySet<string>;
  readonly #bridgeProfile: string | undefined;
  readonly #log: (line: string) => void;
  readonly #groups: GroupRooms;
  readonly #catalog = new Map<string, CachedCatalog>();
  readonly #catalogInflight = new Map<string, Promise<BotCatalog>>();
  readonly #catalogTtlMs: number;
  readonly #catalogDegradedTtlMs: number;
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
    this.#catalogTtlMs = opts.catalogTtlMs ?? CATALOG_TTL_MS;
    this.#catalogDegradedTtlMs =
      opts.catalogDegradedTtlMs ?? CATALOG_DEGRADED_TTL_MS;
    this.#log =
      opts.logSink ??
      ((line) => void process.stderr.write(`[hermes-bridge] ${line}\n`));
    this.#groups = new GroupRooms({
      storage: this.#storage,
      broadcast: this.#broadcast,
      now: this.#now,
      memberInfo: (name) => this.#memberInfo(name),
      missingMembers: async (names) => {
        const known = await this.#freshProfileNames();
        return names.filter((name) => !known.has(name));
      },
      memberKnown: (name) => {
        const bots = this.#storage.botRoster().bots;
        return bots.length === 0
          ? undefined
          : bots.some((bot) => bot.name === name);
      },
      memberExists: async (name) => {
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
  async createBot(input: BotCreateRequest): Promise<{ bot: BotSummary }> {
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
    return { bot };
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
  #publish(bots: BotSummary[], updatedAt: number): void {
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
  async inbox(name: string): Promise<BotInboxView> {
    await this.#assertBotKnown(name);
    const rows = (
      await listBotSessions(this.#client, name, INBOX_SESSION_SCAN_LIMIT)
    )
      .filter((row) => sessionKind(row) === "a2a")
      .slice(0, INBOX_THREAD_LIMIT);
    return {
      threads: rows.map((row) => inboxThread(row, row.messageCount ?? 0)),
    };
  }
  async inboxMessages(
    name: string,
    threadId: string,
  ): Promise<BotInboxMessagesView> {
    await this.#assertBotKnown(name);
    const row = (
      await listBotSessions(this.#client, name, INBOX_SESSION_SCAN_LIMIT)
    ).find((item) => item.id === threadId);
    if (row === undefined || sessionKind(row) !== "a2a")
      throw new BotSessionNotFound(threadId);
    const snapshot = parseChatSnapshot(
      await this.#client.request("session.resume", {
        session_id: threadId,
        profile: name,
        omit_messages: false,
      }),
      threadId,
    );
    return {
      messages: projectInboxMessages(
        snapshot,
        name,
        (bot) => this.#memberInfo(bot).displayName,
      ),
    };
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
export function isHermesUnavailable(error: unknown): boolean {
  return error instanceof HermesUnavailable;
}

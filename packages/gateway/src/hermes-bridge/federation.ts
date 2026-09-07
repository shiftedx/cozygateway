import type {
  BotCatalog, BotCreateRequest, BotCreateResponse, BotDeleteResponse, BotGroup,
  BotGroupDetail, BotGroupMessage, BotModelConfig, BotModelConfigPatch, BotProfile,
  BotModelProviderOAuthSession, BotModelProviderSetupCatalog, BotProfilePatch,
  BotRoutineCreateRequest, BotRoutinePatch, BotSummary, BridgeLiveness,
  BotDesktopHermesSession,
} from "cozygateway-contract";
import { BackendUnavailable } from "../errors.ts";
import type { Storage } from "../storage.ts";
import type { BotControlSurface, BotFocusScreen, BotRoutineList, BotRosterView } from "./bridge.ts";
import type { GatewayRoomHost, RoomHost } from "./group-rooms.ts";
import type { ProfileConfigureResult } from "./profile.ts";
import type { RoutineWriteResult } from "./routines.ts";

export interface FederationMember {
  id: string;
  label?: string;
  /** A `HermesBridge`. It is also a `RoomHost`, because a room whose members all live on this
   *  endpoint is hosted by this endpoint's own `GroupRooms` (F8). */
  bridge: BotControlSurface & RoomHost;
}

export function federatedBotName(endpointId: string, profileId: string): string {
  return `${endpointId}:${profileId.trim().toLowerCase()}`;
}

export function splitFederatedBotName(name: string): { endpointId: string; profileId: string } | undefined {
  const separator = name.indexOf(":");
  if (separator < 1 || separator === name.length - 1) return undefined;
  return { endpointId: name.slice(0, separator), profileId: name.slice(separator + 1) };
}

/** The refusal a room spanning two Hermes endpoints has always got, kept verbatim: a room's durable
 *  state lives inside one endpoint's `GroupRooms`, so there is no host for a membership that is not
 *  all on one side. */
export const CROSS_ENDPOINT_ROOMS = "cross-endpoint groups are not supported";

/** F8's ruling, by name. A room is hosted by the endpoint its membership resolved to when it was
 *  created, and it stays there: moving a live room's transcript, turn bindings and drive from one
 *  endpoint's `GroupRooms` to another's is not something this gateway can do, so a membership that
 *  has come to name a bot on some other endpoint is refused rather than silently re-homed.
 *
 *  A `BackendUnavailable` on purpose, so the wire answer is the same 503 `backend_unavailable` a
 *  cross-endpoint room has always got. No route, frame or schema moves for this. */
export class RoomEndpointMismatch extends BackendUnavailable {
  readonly room: string;
  readonly host: string;
  readonly foreign: readonly string[];
  constructor(room: string, host: string, foreign: readonly string[]) {
    super(
      `room "${room}" is hosted by Hermes endpoint "${host}" and cannot take a member on `
      + `${foreign.map((id) => `"${id}"`).join(", ")}: a room stays on the endpoint it was created on`,
    );
    this.name = "RoomEndpointMismatch";
    this.room = room;
    this.host = host;
    this.foreign = foreign;
  }
}

/** The gateway itself, as a room owner id. A room whose members are all gateway runtime bots
 *  resolves to no Hermes endpoint at all, and belongs to the Hermes-free host (R1). */
const GATEWAY_HOST = "";
const ROOM_HOST_CACHE_CAPACITY = 256;

/** How a host is named in an error. The gateway's own host has no endpoint id to print. */
function hostLabel(id: string): string {
  return id === GATEWAY_HOST ? "(gateway)" : id;
}

function summary(id: string, bot: BotSummary): BotSummary {
  const name = federatedBotName(id, bot.name);
  return { ...bot, name, handle: name };
}

/** Gives each HermesBridge an isolated roster cache while retaining the shared durable
 * conversation store. This prevents one endpoint refresh from erasing another endpoint's rows. */
export function endpointStorage(storage: Storage, endpointId: string): Storage {
  let roster: { bots: BotSummary[]; updatedAt: number | null } = { bots: [], updatedAt: null };
  return new Proxy(storage, {
    get(target, property) {
      if (property === "botRoster") return () => roster;
      if (property === "replaceBotRoster") return (rows: Array<{ summary: BotSummary }>, updatedAt: number) => {
        roster = { bots: rows.map((row) => row.summary), updatedAt };
      };
      if (property === "nativeBotActiveTurn") return (name: string) => target.nativeBotActiveTurn(federatedBotName(endpointId, name));
      if (property === "isBotDeleted") return (name: string) => target.isBotDeleted(federatedBotName(endpointId, name));
      if (property === "restoreBot") return (name: string) => target.restoreBot(federatedBotName(endpointId, name));
      if (property === "purgeBot") return (name: string) => target.purgeBot(federatedBotName(endpointId, name));
      if (property === "botRoutineOverrides") return (name: string, routineId: string) =>
        target.botRoutineOverrides(federatedBotName(endpointId, name), routineId);
      if (property === "setBotRoutineOverrides") return (name: string, routineId: string, overrides: Parameters<Storage["setBotRoutineOverrides"]>[2]) =>
        target.setBotRoutineOverrides(federatedBotName(endpointId, name), routineId, overrides);
      if (property === "deleteBotRoutineOverrides") return (name: string, routineId: string) =>
        target.deleteBotRoutineOverrides(federatedBotName(endpointId, name), routineId);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Dispatches every by-bot control request to its owning Hermes endpoint and aggregates cached
 * rosters. An offline member makes the aggregate stale/unready but never hides healthy members or
 * the last known rows from the failed member. */
export class FederatedBotControlSurface implements BotControlSurface {
  readonly #members: Map<string, FederationMember>;
  readonly #broadcast?: (view: BotRosterView) => void;
  #overlay: ((bots: readonly BotSummary[]) => BotSummary[]) | undefined;
  /** The gateway's OWN room host (finding V1-F1). A room is gateway-owned, so the absence of a
   *  Hermes endpoint is not a reason to refuse one; it also owns a room on a federated gateway
   *  whose members are all gateway runtime bots, which likewise resolves to no endpoint. */
  readonly #rooms: GatewayRoomHost | undefined;
  /** Immutable room membership, read only to resolve and backfill a legacy NULL owner. */
  readonly #roomMembers: ((key: string) => readonly string[] | undefined) | undefined;
  /** A bounded read-through cache. The durable owner, not this memo, remains the source of truth
   * across restart and for deleted-room turn tombstones. */
  readonly #roomHosts = new Map<string, { host: string; lastLookup: number }>();
  #roomHostTick = 0;
  constructor(
    members: FederationMember[],
    broadcast?: (view: BotRosterView) => void,
    rooms?: GatewayRoomHost,
    roomMembers?: (key: string) => readonly string[] | undefined,
    roomOwner?: (key: string) => string | undefined,
    backfillRoomOwner?: (key: string, owner: string) => void,
  ) {
    this.#members = new Map(members.map((member) => [member.id, member]));
    this.#broadcast = broadcast;
    this.#rooms = rooms;
    this.#roomMembers = roomMembers;
    this.#roomOwner = roomOwner;
    this.#backfillRoomOwner = backfillRoomOwner;
  }
  readonly #roomOwner: ((key: string) => string | undefined) | undefined;
  readonly #backfillRoomOwner: ((key: string, owner: string) => void) | undefined;
  #cachedHost(key: string): string | undefined {
    const cached = this.#roomHosts.get(key);
    if (cached === undefined) return undefined;
    cached.lastLookup = ++this.#roomHostTick;
    return cached.host;
  }
  #rememberHost(key: string, host: string): void {
    this.#roomHosts.set(key, { host, lastLookup: ++this.#roomHostTick });
    if (this.#roomHosts.size <= ROOM_HOST_CACHE_CAPACITY) return;
    let oldestKey: string | undefined;
    let oldestLookup = Number.POSITIVE_INFINITY;
    for (const [candidate, value] of this.#roomHosts) {
      if (value.lastLookup < oldestLookup) { oldestKey = candidate; oldestLookup = value.lastLookup; }
    }
    if (oldestKey !== undefined) this.#roomHosts.delete(oldestKey);
  }
  roomHostCacheSizeForTesting(): number { return this.#roomHosts.size; }
  #route(name: string): { member: FederationMember; profile: string } {
    const parsed = splitFederatedBotName(name);
    const member = parsed === undefined ? undefined : this.#members.get(parsed.endpointId);
    if (parsed === undefined || member === undefined) throw new BackendUnavailable(`no Hermes endpoint owns bot "${name}"`);
    return { member, profile: parsed.profileId };
  }
  roster(): BotRosterView {
    const views = [...this.#members.values()].map((member) => ({ member, view: member.bridge.roster() }));
    const bots = views.flatMap(({ member, view }) => view.bots.map((bot) => summary(member.id, bot)));
    return {
      bots: this.#overlay === undefined ? bots : this.#overlay(bots),
      updatedAt: views.reduce<number | null>((latest, { view }) => view.updatedAt === null ? latest : Math.max(latest ?? 0, view.updatedAt), null),
      stale: views.some(({ view }) => view.stale),
      hermesState: views.every(({ view }) => view.hermesState === "online") ? "online" : "absent",
    };
  }
  health(): BridgeLiveness {
    const health = [...this.#members.values()].map((member) => member.bridge.health());
    return {
      online: health.length > 0 && health.every((item) => item.online),
      since: health.reduce((oldest, item) => Math.min(oldest, item.since), Date.now()),
      reconnectAttempt: health.reduce((sum, item) => sum + item.reconnectAttempt, 0),
    };
  }
  refreshSoon(reason: string): void { for (const member of this.#members.values()) member.bridge.refreshSoon(reason); }
  setRosterOverlay(overlay: (bots: readonly BotSummary[]) => BotSummary[]): void { this.#overlay = overlay; }
  publish(): void { this.#broadcast?.(this.roster()); }
  async createBot(input: BotCreateRequest): Promise<BotCreateResponse> {
    const route = this.#route(input.name);
    const result = await route.member.bridge.createBot({ ...input, name: route.profile });
    return { ...result, bot: summary(route.member.id, result.bot) };
  }
  async deleteBot(name: string, opts?: { force?: boolean }): Promise<BotDeleteResponse> { const r = this.#route(name); const result = await r.member.bridge.deleteBot(r.profile, opts); return { ...result, name }; }
  async botProfile(name: string): Promise<BotProfile> { const r = this.#route(name); return r.member.bridge.botProfile(r.profile); }
  async configureProfile(name: string, patch: BotProfilePatch): Promise<ProfileConfigureResult> { const r = this.#route(name); return r.member.bridge.configureProfile(r.profile, patch); }
  async modelConfig(name: string): Promise<BotModelConfig> { const r = this.#route(name); return r.member.bridge.modelConfig(r.profile); }
  async configureModel(name: string, patch: BotModelConfigPatch): Promise<BotModelConfig> { const r = this.#route(name); return r.member.bridge.configureModel(r.profile, patch); }
  async modelProviders(name: string): Promise<BotModelProviderSetupCatalog> { const r = this.#route(name); return r.member.bridge.modelProviders(r.profile); }
  async configureModelProviderField(name: string, provider: string, field: string, value: string): Promise<BotModelProviderSetupCatalog> { const r = this.#route(name); return r.member.bridge.configureModelProviderField(r.profile, provider, field, value); }
  async clearModelProviderField(name: string, provider: string, field: string): Promise<BotModelProviderSetupCatalog> { const r = this.#route(name); return r.member.bridge.clearModelProviderField(r.profile, provider, field); }
  async startModelProviderOAuth(name: string, provider: string): Promise<BotModelProviderOAuthSession> { const r = this.#route(name); return r.member.bridge.startModelProviderOAuth(r.profile, provider); }
  async pollModelProviderOAuth(name: string, provider: string, sessionId: string): Promise<BotModelProviderOAuthSession> { const r = this.#route(name); return r.member.bridge.pollModelProviderOAuth(r.profile, provider, sessionId); }
  async submitModelProviderOAuthCode(name: string, provider: string, sessionId: string, code: string): Promise<BotModelProviderOAuthSession> { const r = this.#route(name); return r.member.bridge.submitModelProviderOAuthCode(r.profile, provider, sessionId, code); }
  async cancelModelProviderOAuth(name: string, provider: string, sessionId: string): Promise<void> { const r = this.#route(name); return r.member.bridge.cancelModelProviderOAuth(r.profile, provider, sessionId); }
  async catalog(query: string): Promise<BotCatalog> {
    const member = [...this.#members.values()].find((item) => item.bridge.health().online) ?? [...this.#members.values()][0];
    if (member === undefined) throw new BackendUnavailable("no Hermes endpoint is configured");
    return member.bridge.catalog(query);
  }
  async desktopSessions(name: string): Promise<BotDesktopHermesSession[]> {
    const r = this.#route(name);
    return r.member.bridge.desktopSessions(r.profile);
  }
  async desktopSessionTranscript(name: string, hermesSessionId: string) {
    const r = this.#route(name);
    return r.member.bridge.desktopSessionTranscript(r.profile, hermesSessionId);
  }
  async routines(name: string): Promise<BotRoutineList> { const r = this.#route(name); const result = await r.member.bridge.routines(r.profile); return { ...result, name }; }
  async createRoutine(name: string, input: BotRoutineCreateRequest): Promise<RoutineWriteResult> { const r = this.#route(name); return r.member.bridge.createRoutine(r.profile, input); }
  async patchRoutine(name: string, id: string, patch: BotRoutinePatch): Promise<RoutineWriteResult> { const r = this.#route(name); return r.member.bridge.patchRoutine(r.profile, id, patch); }
  async deleteRoutine(name: string, id: string): Promise<void> { const r = this.#route(name); return r.member.bridge.deleteRoutine(r.profile, id); }
  setFocus(deviceId: string, screen: BotFocusScreen | null): void { for (const member of this.#members.values()) member.bridge.setFocus(deviceId, screen); }
  /** The endpoint that owns a public bot name, or `GATEWAY_HOST` when no endpoint does. A gateway
   *  runtime bot is named bare on every gateway shape and belongs to no endpoint; so does a name
   *  carrying a prefix no configured endpoint answers to, which the host's own membership check
   *  then refuses as "not a bot on this gateway" rather than a 503 about federation. */
  #owningEndpoint(name: string): string {
    const parsed = splitFederatedBotName(name.trim().toLowerCase());
    if (parsed === undefined) return GATEWAY_HOST;
    return this.#members.has(parsed.endpointId) ? parsed.endpointId : GATEWAY_HOST;
  }
  /** The one host a membership resolves to. Endpoint-owned members must all sit on the SAME
   *  endpoint; bare runtime members are endpoint-agnostic and join whichever host the rest picks. */
  #resolveHost(members: readonly string[]): { host: string } | { spans: string[] } {
    const endpoints: string[] = [];
    for (const member of members) {
      const owner = this.#owningEndpoint(member);
      if (owner !== GATEWAY_HOST && !endpoints.includes(owner)) endpoints.push(owner);
    }
    if (endpoints.length > 1) return { spans: endpoints };
    return { host: endpoints[0] ?? GATEWAY_HOST };
  }
  #hostById(id: string): RoomHost {
    if (id === GATEWAY_HOST) {
      if (this.#rooms === undefined) throw new BackendUnavailable(CROSS_ENDPOINT_ROOMS);
      return this.#rooms;
    }
    const member = this.#members.get(id);
    if (member === undefined) throw new BackendUnavailable(CROSS_ENDPOINT_ROOMS);
    return member.bridge;
  }
  /** The host of an existing room. A durable owner avoids a membership walk; only a legacy NULL
   * derives once from immutable membership and backfills. Surface-only tests without storage retain
   * F8's original membership guard. */
  #hostOf(name: string): RoomHost {
    const key = name.trim().toLowerCase();
    const remembered = this.#cachedHost(key);
    // The durable owner backs the cache. Its tombstone is also the sole ownership source after a
    // room has been deleted, while its attach turn rows still exist.
    if (remembered !== undefined && this.#roomOwner !== undefined) return this.#hostById(remembered);
    const owner = this.#roomOwner?.(key);
    if (owner !== undefined) {
      this.#rememberHost(key, owner);
      return this.#hostById(owner);
    }
    const members = this.#roomMembers?.(key);
    if (members === undefined) {
      // No such room. Hand it to the remembered host, or to the gateway's own, so the caller gets
      // the host's ordinary `GroupNotFound` (404) instead of a 503 about federation.
      return this.#hostById(remembered ?? GATEWAY_HOST);
    }
    const resolved = this.#resolveHost(members);
    if (remembered === undefined) {
      if ("spans" in resolved) throw new BackendUnavailable(CROSS_ENDPOINT_ROOMS);
      this.#backfillRoomOwner?.(key, resolved.host);
      this.#rememberHost(key, resolved.host);
      return this.#hostById(resolved.host);
    }
    const foreign = "spans" in resolved
      ? resolved.spans.filter((id) => id !== remembered)
      : resolved.host === remembered ? [] : [resolved.host];
    if (foreign.length > 0) {
      throw new RoomEndpointMismatch(name.trim(), hostLabel(remembered), foreign.map(hostLabel));
    }
    return this.#hostById(remembered);
  }
  /** Every room on this gateway, from the gateway's own host: room rows are gateway-wide durable
   *  state, so one host lists them all whichever host drives each one. */
  groups(): BotGroup[] { return this.#rooms?.groups() ?? []; }
  async createGroup(name: string, members: string[]): Promise<BotGroup> {
    const resolved = this.#resolveHost(members);
    if ("spans" in resolved) throw new BackendUnavailable(CROSS_ENDPOINT_ROOMS);
    const group = await this.#hostById(resolved.host).createGroup(name, members, resolved.host);
    this.#rememberHost(group.name.trim().toLowerCase(), resolved.host);
    return group;
  }
  deleteGroup(name: string): void {
    // Storage retains the owner with an existing turn tombstone, so a bounded cache eviction cannot
    // reroute a late terminal to the gateway host. A recreated live room takes precedence over its
    // old tombstone in storage.
    this.#hostOf(name).deleteGroup(name);
  }
  groupDetail(name: string): BotGroupDetail { return this.#hostOf(name).groupDetail(name); }
  sendGroupMessage(name: string, text: string, opts?: { clientId?: string }): BotGroupMessage { return this.#hostOf(name).sendGroupMessage(name, text, opts ?? {}); }
  /** The host that drives a room, for the server's attach-event and room-turn wiring. Never
   *  throws: an event for a room whose ownership no longer resolves has no host to project it. */
  roomHostFor(key: string): RoomHost | undefined {
    try {
      return this.#hostOf(key);
    } catch {
      return undefined;
    }
  }
}

import type {
  BotCatalog, BotCreateRequest, BotCreateResponse, BotDeleteResponse, BotGroup,
  BotGroupDetail, BotGroupMessage, BotModelConfig, BotModelConfigPatch, BotProfile,
  BotProfilePatch, BotRoutineCreateRequest, BotRoutinePatch, BotSummary, BridgeLiveness,
} from "cozygateway-contract";
import { BackendUnavailable } from "../errors.ts";
import type { Storage } from "../storage.ts";
import type {
  BotControlSurface, BotFocusScreen, BotInboxMessagesView, BotInboxView,
  BotRoutineList, BotRosterView,
} from "./bridge.ts";
import type { ProfileConfigureResult } from "./profile.ts";
import type { RoutineWriteResult } from "./routines.ts";

export interface FederationMember {
  id: string;
  label?: string;
  bridge: BotControlSurface;
}

export function federatedBotName(endpointId: string, profileId: string): string {
  return `${endpointId}:${profileId.trim().toLowerCase()}`;
}

export function splitFederatedBotName(name: string): { endpointId: string; profileId: string } | undefined {
  const separator = name.indexOf(":");
  if (separator < 1 || separator === name.length - 1) return undefined;
  return { endpointId: name.slice(0, separator), profileId: name.slice(separator + 1) };
}

function summary(id: string, bot: BotSummary): BotSummary {
  const name = federatedBotName(id, bot.name);
  return { ...bot, name, handle: name };
}

/** Gives each legacy HermesBridge an isolated roster cache while retaining the shared durable
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
  constructor(members: FederationMember[], broadcast?: (view: BotRosterView) => void) {
    this.#members = new Map(members.map((member) => [member.id, member]));
    this.#broadcast = broadcast;
  }
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
  async inbox(name: string): Promise<BotInboxView> { const r = this.#route(name); return r.member.bridge.inbox(r.profile); }
  async inboxMessages(name: string, id: string): Promise<BotInboxMessagesView> { const r = this.#route(name); return r.member.bridge.inboxMessages(r.profile, id); }
  async botProfile(name: string): Promise<BotProfile> { const r = this.#route(name); return r.member.bridge.botProfile(r.profile); }
  async configureProfile(name: string, patch: BotProfilePatch): Promise<ProfileConfigureResult> { const r = this.#route(name); return r.member.bridge.configureProfile(r.profile, patch); }
  async modelConfig(name: string): Promise<BotModelConfig> { const r = this.#route(name); return r.member.bridge.modelConfig(r.profile); }
  async configureModel(name: string, patch: BotModelConfigPatch): Promise<BotModelConfig> { const r = this.#route(name); return r.member.bridge.configureModel(r.profile, patch); }
  async catalog(query: string): Promise<BotCatalog> {
    const member = [...this.#members.values()].find((item) => item.bridge.health().online) ?? [...this.#members.values()][0];
    if (member === undefined) throw new BackendUnavailable("no Hermes endpoint is configured");
    return member.bridge.catalog(query);
  }
  async routines(name: string): Promise<BotRoutineList> { const r = this.#route(name); const result = await r.member.bridge.routines(r.profile); return { ...result, name }; }
  async createRoutine(name: string, input: BotRoutineCreateRequest): Promise<RoutineWriteResult> { const r = this.#route(name); return r.member.bridge.createRoutine(r.profile, input); }
  async patchRoutine(name: string, id: string, patch: BotRoutinePatch): Promise<RoutineWriteResult> { const r = this.#route(name); return r.member.bridge.patchRoutine(r.profile, id, patch); }
  async deleteRoutine(name: string, id: string): Promise<void> { const r = this.#route(name); return r.member.bridge.deleteRoutine(r.profile, id); }
  setFocus(deviceId: string, screen: BotFocusScreen | null): void { for (const member of this.#members.values()) member.bridge.setFocus(deviceId, screen); }
  groups(): BotGroup[] { return []; }
  createGroup(_name: string, _members: string[]): Promise<BotGroup> { throw new BackendUnavailable("cross-endpoint groups are not supported"); }
  deleteGroup(_name: string): void { throw new BackendUnavailable("cross-endpoint groups are not supported"); }
  groupDetail(_name: string): BotGroupDetail { throw new BackendUnavailable("cross-endpoint groups are not supported"); }
  sendGroupMessage(_name: string, _text: string, _opts?: { clientId?: string }): BotGroupMessage { throw new BackendUnavailable("cross-endpoint groups are not supported"); }
}

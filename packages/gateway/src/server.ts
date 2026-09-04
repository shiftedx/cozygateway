import type { Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { serve } from "@hono/node-server";
import {
  APPROVALS_CAPABILITY_ID,
  APPROVALS_CAPABILITY_VERSION,
  BOTS_CAPABILITY_ID,
  BOTS_CAPABILITY_VERSION,
  HERMES_DESKTOP_SESSIONS_CAPABILITY_ID,
  HERMES_DESKTOP_SESSIONS_CAPABILITY_VERSION,
  HERMES_SESSION_MANAGEMENT_CAPABILITY_ID,
  MOBILE_NODE_CAPABILITY_ID,
  MOBILE_NODE_CAPABILITY_VERSION,
  GATEWAY_MANAGEMENT_CAPABILITY_ID,
  GATEWAY_MANAGEMENT_CAPABILITY_VERSION,
  GATEWAY_MAINTENANCE_CAPABILITY_ID,
  GATEWAY_MAINTENANCE_CAPABILITY_VERSION,
  HARNESS_SETTINGS_CAPABILITY_ID,
  HARNESS_SETTINGS_CAPABILITY_VERSION,
  HARNESS_WORKSPACE_CAPABILITY_ID,
  HARNESS_WORKSPACE_CAPABILITY_VERSION,
  HARNESS_UPDATE_CAPABILITY_ID,
  HARNESS_UPDATE_CAPABILITY_VERSION,
  COZYAPPS_CAPABILITY_ID,
  COZYAPPS_CAPABILITY_VERSION,
  assertValidCozyAppTree,
  type GatewayInfo,
  type ServerFrame,
} from "cozygateway-contract";

import { hermesEndpoints, nativeBots, publicProfileId, validatePublicDeployment, type GatewayConfig } from "./config.ts";
import { fileGatewaySettings, type GatewaySettingsStore } from "./gateway-settings.ts";
import {
  discoverGatewayMaintenance,
  type GatewayMaintenanceRuntimeHealth,
} from "./gateway-maintenance.ts";
import { cozyAppPhysicalId, openStorage, type Storage } from "./storage.ts";
import {
  ATTACH_V1_CAPABILITIES,
  AttachV1Ingress,
} from "./adapters/attach/ingress-v1.ts";
import type { AttachV1Capability, AttachV1EventFrame } from "./adapters/attach/protocol-v1.ts";
import { AttachNativeSink } from "./adapters/attach/native-sink.ts";
import {
  AttachRouter,
  collectAttachTokens,
  createAttachAdapter,
  type TurnEndpoint,
} from "./adapters/attach/adapter.ts";
import { revokeAttachTokens } from "./adapters/attach/token-auth.ts";
import { createApp } from "./http.ts";
import { listenerOrigin } from "./configure.ts";
import { primaryLanAddress } from "./lan.ts";
import { RunnerLane } from "./runner/lane.ts";
import {
  LEGACY_RUNNER_ID,
  LEGACY_RUNNER_NAME,
  RunnerRoster,
  createRunnerResolver,
  effectiveRunnerName,
} from "./runner/roster.ts";
import { RuntimeBotService, mergeRuntimeBots, runtimeSpecDefaults } from "./runner/runtime-bots.ts";
import type { PairingAttemptLimiter } from "./pairing-admission.ts";
import { WsHub } from "./ws-hub.ts";
import { MobileNodeBroker } from "./mobile-node.ts";
import { TurnRunner } from "./turns.ts";
import { RelayNotifier, type ChatMessagePushEvent } from "./push-notifier.ts";
import { LiveActivityNotifier } from "./live-activity-notifier.ts";
import type { ApprovalPushPayload } from "./push-crypto.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";
import {
  createUpgradeDispatcher,
  type UpgradeHandler,
} from "./upgrade-dispatcher.ts";
import { createHermesClient } from "./hermes-bridge/client.ts";
import { DEFAULT_CHAT_SUGGESTION, parseHermesOptions } from "./hermes-bridge/config.ts";
import { HermesBridge, type BotsSurface } from "./hermes-bridge/bridge.ts";
import { FederatedBotControlSurface, endpointStorage } from "./hermes-bridge/federation.ts";
import { NativeBotDataPlane } from "./hermes-bridge/native-data-plane.ts";
import { AttachConfigSurface } from "./hermes-bridge/bot-config.ts";
import { AttachHistorySurface } from "./hermes-bridge/bot-history.ts";
import { AttachMemorySurface } from "./hermes-bridge/memory.ts";
import { PHOTO_SWEEP_MS } from "./hermes-bridge/photos.ts";
import { resolveTlsMaterial } from "./tls.ts";
import type { TraceLog } from "./trace.ts";
import { GatewayHarnessSettings, HermesHarnessModelSettingsAdapter } from "./harness-settings.ts";
import { GatewayHarnessWorkspace, discoverHermesWorkspace } from "./hermes-bridge/workspace.ts";
import { GatewayHarnessUpdates, discoverHermesUpdates } from "./hermes-bridge/update.ts";
import {
  discoverHermesSessionManagement,
  GatewayHermesSessionManagement,
} from "./hermes-bridge/session-management.ts";
import {
  GatewayHermesGlobalSkills,
  HERMES_GLOBAL_SKILLS_CAPABILITY_ID,
  HERMES_GLOBAL_SKILLS_CAPABILITY_VERSION,
} from "./hermes-bridge/global-skills.ts";

export const GATEWAY_VERSION = "0.7.2";
export const PUSH_PROXY_CAPABILITY_ID = "com.cozylabs.push-proxy";
export const PUSH_PROXY_CAPABILITY_VERSION = 1;

/** Seconds from the config file in the units the data plane takes. An omitted knob stays omitted,
 *  so the plane keeps ownership of its own defaults instead of having them restated here. */
function millis(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1000;
}

/** Last stop of the attach apply chain. An event no projection claims is either transiently
 *  unappliable (declining is right: the ingress retries it and eventually dead-letters) or
 *  PERMANENTLY orphaned: the durable binding it was authorized against -- its turn command or
 *  its scheduled delivery target -- is gone or points elsewhere, so no retry can ever apply it.
 *  Declining those bricked whole agents in production (issue #193): one orphan dead-letters,
 *  and every later journaled event for that identity is acknowledged on the wire yet never
 *  applied. An orphan is a fact about the past, not future work: acknowledge it out loud and
 *  let the stream move. */
function acknowledgeOrphanedAttachEvent(
  storage: Storage,
  agentId: string,
  frame: AttachV1EventFrame,
): boolean {
  const event = frame.event;
  const acknowledge = (reason: string): true => {
    console.warn(
      `attach-v1: acknowledged orphaned ${event.kind} event for profile "${agentId}": ${reason}`,
    );
    return true;
  };
  if (event.kind === "scheduled") {
    const delivery = storage.attachScheduledDelivery(agentId, event.deliveryId);
    if (delivery === undefined || delivery.messageId !== event.messageId)
      return acknowledge("no durable delivery binding");
    if (
      storage.threadById(delivery.threadId) === undefined &&
      !storage.nativeBotHasSession(agentId, delivery.threadId)
    )
      return acknowledge("the delivery target no longer exists");
    return false;
  }
  if ("turnId" in event) {
    const command = storage.attachTurnCommand(agentId, event.turnId);
    if (command === undefined) return acknowledge("no durable turn command");
    if ("threadId" in event && command.threadId !== event.threadId)
      return acknowledge("the turn command is bound to another thread");
    if (
      "threadId" in event &&
      storage.threadById(event.threadId) === undefined &&
      !storage.nativeBotHasSession(agentId, event.threadId)
    )
      return acknowledge("the turn's thread no longer exists");
  }
  return false;
}

function allowedAttachMedia(config: GatewayConfig, agentId: string): boolean {
  // The media rollout gate covers every attach identity, not just Hermes profiles: a runtime
  // bot (declared under the top-level `bots` array, capability 45+) negotiates the same `media`
  // capability over /attach/v1 and must clear this same gate on GET /attach/v1/media/:mediaId.
  if (nativeBots(config).some((bot) => bot.id === agentId)) return true;
  return hermesEndpoints(config).some((endpoint) =>
    Object.keys(endpoint.config.profiles).some((profile) => publicProfileId(endpoint, profile) === agentId));
}

export interface RunningGateway {
  url: string;
  port: number;
  storage: Storage;
  issueSetupCode(): string;
  close(): Promise<void>;
}

export interface StartGatewayOptions {
  /** Writable source JSON path. Enables authenticated device management and atomic persistence. */
  configPath?: string;
  /** Overrides the push notifier's fire-and-forget failure log sink. Not part of
   *  `GatewayConfig` (which is JSON-schema-validated and loadable from disk) since a log
   *  function isn't serializable; this is a programmatic-only seam. Defaults to the
   *  notifier's own stderr writer, so production behavior is unchanged when omitted. Exists
   *  for hosts (e.g. the conformance suite's reference gateway) that intentionally register
   *  an unroutable relay and want to observe or silence the resulting failure log instead of
   *  it reaching real stderr (design decision, issue #10). */
  notifierLog?: (message: string) => void;
  /** Overrides the sink for the approval audit line the runner writes on every resolved approval
   *  (issue #19). Defaults to stderr, like the other two. The line names the thread, turn,
   *  toolCallId, outcome, and deciding device, and never the approval's argument summary. Exists
   *  so a test can read the audit trail without scraping real stderr. */
  approvalLog?: (message: string) => void;
  /** JSON-line, privacy-safe transport transition diagnostics. */
  traceLog?: TraceLog;
  /** Test-only `/pair` admission seam. The production path always uses the default bucket built
   *  from its wall clock; a long-running black-box harness may supply a virtual-clock bucket. */
  pairingAdmission?: PairingAttemptLimiter;
}

/** The assembly seam between Hermes' settled-chat event and the relay notifier. Kept pure so the
 *  live hub snapshot, rather than a startup-time set, is pinned by a unit test. */
export function createChatMessagePushHandler(
  notifier: Pick<RelayNotifier, "notifyChatMessage">,
  connectedDeviceIds: () => ReadonlySet<string>,
  liveActivityDeviceIds: (
    event: ChatMessagePushEvent,
  ) => ReadonlySet<string> = () => new Set(),
): (event: ChatMessagePushEvent) => void {
  return (event) =>
    notifier.notifyChatMessage(
      event,
      new Set([...connectedDeviceIds(), ...liveActivityDeviceIds(event)]),
    );
}

/** One shared immutable GatewayInfo for health, pairing, and the ready frame. */
export function gatewayInfoForConfig(
  config: GatewayConfig,
  management = false,
  harnessWorkspace = false,
  harnessUpdates = false,
  hermesSessionManagementVersion?: number,
  hermesGlobalSkills = false,
  maintenance = false,
): GatewayInfo {
  const configuredCapabilities = Object.fromEntries(
    Object.entries(config.capabilities ?? {})
      .filter(([id]) => id !== HARNESS_UPDATE_CAPABILITY_ID
        && id !== GATEWAY_MANAGEMENT_CAPABILITY_ID
        && id !== HERMES_SESSION_MANAGEMENT_CAPABILITY_ID
        && id !== HERMES_GLOBAL_SKILLS_CAPABILITY_ID
        && id !== GATEWAY_MAINTENANCE_CAPABILITY_ID),
  );
  return {
    name: config.name,
    version: GATEWAY_VERSION,
    contract: "v1",
    capabilities: {
      ...configuredCapabilities,
      [APPROVALS_CAPABILITY_ID]: APPROVALS_CAPABILITY_VERSION,
      [COZYAPPS_CAPABILITY_ID]: COZYAPPS_CAPABILITY_VERSION,
      ...(management ? { [GATEWAY_MANAGEMENT_CAPABILITY_ID]: GATEWAY_MANAGEMENT_CAPABILITY_VERSION } : {}),
      // Capability 52: the bots capability is advertised whether or not a Hermes endpoint is
      // configured, because a CozyAgents-only gateway serves `/bots`, `/runners` and the runtime
      // projection from its own rows. The three Hermes-shaped surfaces beside it stay gated on an
      // endpoint, since there is genuinely no Dashboard, no desktop session and no harness setting
      // behind them.
      [BOTS_CAPABILITY_ID]: BOTS_CAPABILITY_VERSION,
      ...(hermesEndpoints(config).length === 0
        ? {}
        : {
            [HERMES_DESKTOP_SESSIONS_CAPABILITY_ID]: HERMES_DESKTOP_SESSIONS_CAPABILITY_VERSION,
            [MOBILE_NODE_CAPABILITY_ID]: MOBILE_NODE_CAPABILITY_VERSION,
            [HARNESS_SETTINGS_CAPABILITY_ID]: HARNESS_SETTINGS_CAPABILITY_VERSION,
          }),
      ...(config.pushRelayUrl === undefined
        ? {}
        : { [PUSH_PROXY_CAPABILITY_ID]: PUSH_PROXY_CAPABILITY_VERSION }),
      ...(harnessWorkspace
        ? { [HARNESS_WORKSPACE_CAPABILITY_ID]: HARNESS_WORKSPACE_CAPABILITY_VERSION }
        : {}),
      ...(harnessUpdates
        ? { [HARNESS_UPDATE_CAPABILITY_ID]: HARNESS_UPDATE_CAPABILITY_VERSION }
        : {}),
      ...(hermesSessionManagementVersion === undefined
        ? {}
        : { [HERMES_SESSION_MANAGEMENT_CAPABILITY_ID]: hermesSessionManagementVersion }),
      ...(hermesGlobalSkills
        ? { [HERMES_GLOBAL_SKILLS_CAPABILITY_ID]: HERMES_GLOBAL_SKILLS_CAPABILITY_VERSION }
        : {}),
      ...(maintenance
        ? { [GATEWAY_MAINTENANCE_CAPABILITY_ID]: GATEWAY_MAINTENANCE_CAPABILITY_VERSION }
        : {}),
    },
  };
}

export function maintenanceRuntimeHealth(input: {
  harness: "hermes" | "cozyagents";
  attach?: { configured: number; online: number };
  deadLetters?: number;
  coLocatedRunnerId?: string;
  connectedRunners?: readonly string[];
}): GatewayMaintenanceRuntimeHealth {
  if (input.harness === "hermes") return {
    harness: "hermes",
    ...(input.attach === undefined ? {} : {
      attach: { ...input.attach, deadLetters: input.deadLetters ?? 0 },
    }),
  };
  return {
    harness: "cozyagents",
    localRunnerAttached: input.coLocatedRunnerId !== undefined
      && input.connectedRunners?.includes(input.coLocatedRunnerId) === true,
  };
}

export async function startGateway(
  config: GatewayConfig,
  options: StartGatewayOptions = {},
): Promise<RunningGateway> {
  // Validate the public posture before TLS files, storage, bridges, or the listener can produce a
  // side effect. Programmatic hosts do not necessarily pass through loadConfig(), so startup owns
  // this last fail-closed check too.
  config = validatePublicDeployment(config);
  // Transition records deliberately have a useful production default. They remain injectable so
  // embedded hosts and tests can collect them without intercepting stderr.
  const traceLog = options.traceLog ?? ((line: string) => process.stderr.write(`${line}\n`));
  let gatewaySettings: GatewaySettingsStore | undefined;
  if (options.configPath !== undefined) {
    try {
      gatewaySettings = fileGatewaySettings(options.configPath);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "invalid-source-config";
      traceLog(JSON.stringify({
        component: "gateway-settings",
        event: "persistence-unavailable",
        configPath: options.configPath,
        code,
      }));
    }
  }
  // First thing, before the database is opened or a single socket is dialed: if the operator asked
  // for TLS, prove the pair is usable. Absent config resolves to undefined and every line below
  // behaves exactly as it did before TLS existed. Present-but-broken throws here, so the failure is
  // a refusal to start rather than a plaintext listener on a port believed to be encrypted.
  const tls = resolveTlsMaterial(config.tls);
  const scheme = tls === undefined ? "http" : "https";
  const storage = openStorage(config.dbPath);
  storage.pruneExpiredAttachMedia(Date.now());
  const endpoints = hermesEndpoints(config);
  const profileEntries = endpoints.flatMap((endpoint) => Object.entries(endpoint.config.profiles).map(
    ([rawId, profile]) => [publicProfileId(endpoint, rawId), profile] as const,
  ));
  for (const [id, profile] of profileEntries) {
    storage.upsertAgent({
      id,
      name: profile.name ?? id,
      avatar: profile.avatar ?? null,
      backend: "attach",
    });
  }
  // Bots served by a non-Hermes runtime (e.g. CozyAgents). Additive to the Hermes profiles above:
  // same storage row, same attach identity shape, no Hermes Dashboard consulted for them.
  // Two sources, one namespace, merged by one shared function so the precedence rule lives in one
  // place: the config file remains a BOOTSTRAP source (capability 45), and a storage row created
  // through `POST /bots {runtime}` (capability 49) wins on collision.
  // Capability 52/54. The roster is built here rather than beside the lane below, because the
  // runtime bot rows that name its runners are read on the very next line and the roster row a bot
  // names is what the app renders beside it.
  const runnerRoster = new RunnerRoster({ storage, now: () => Date.now() });
  const runnerToken = process.env["COZYGATEWAY_RUNNER_TOKEN"];
  const legacyRunnerConfigured = runnerToken !== undefined && runnerToken.length > 0;
  /** Capability 54/55. What a recorded runner id is called right now: the paired row's display
   *  name when a person set one, else the name it reported, or the one name the operator-placed
   *  shared credential has. A revoked runner has none, and nothing is invented for it. */
  const runnerName = (id: string): string | undefined => {
    const row = runnerRoster.get(id);
    if (row !== undefined) return effectiveRunnerName(row);
    return id === LEGACY_RUNNER_ID && legacyRunnerConfigured ? LEGACY_RUNNER_NAME : undefined;
  };
  const storedRuntimeBots = storage.runtimeBots();
  const merged = mergeRuntimeBots(nativeBots(config), storedRuntimeBots);
  const runtimeBots = merged.bots;
  /** Only until the plane exists; every later read is the plane's live set. */
  const bootRuntimeBotNames: ReadonlySet<string> = new Set(merged.bots.map((bot) => bot.id));
  const configRuntimeBots = nativeBots(config).filter((bot) => merged.fromConfig.includes(bot.id));
  // loadConfig() rejects this same collision (config.ts:246-249), but startGateway takes a
  // GatewayConfig directly and skips loadConfig on the programmatic path (tests, embedders), so
  // the check is re-derived here rather than trusted to have already run. Two ids resolving the
  // same agentId would otherwise let two different tokens authenticate as one identity silently.
  const hermesProfileIds = new Set(profileEntries.map(([id]) => id));
  for (const bot of runtimeBots) {
    if (hermesProfileIds.has(bot.id)) {
      throw new Error(`bot "${bot.id}": id collides with a Hermes profile id; every bot needs a distinct id`);
    }
    storage.upsertAgent({
      id: bot.id,
      name: bot.name,
      avatar: bot.avatar,
      backend: "attach",
    });
  }
  // capabilities is always present, empty when unconfigured, so the shape is uniform across
  // /health, the pair response, and the ready frame (contract v1.md section 5). Absence is a
  // valid wire shape too (older gateways), but this implementation always advertises the field.
  //
  // Built-in optional surfaces advertise vendor capability ids only when their backing config is
  // present. Each integer version advances independently of the frozen contract literal.
  const parsedEndpoints = endpoints.map((endpoint) => ({ endpoint, options: parseHermesOptions(endpoint.config, process.env) }));
  // Capability 52. A gateway with no Hermes endpoint has no endpoint options to read, so the one
  // setting the native plane borrows from them falls back to the same default `parseHermesOptions`
  // would have produced. Nothing else below reads this object.
  const chatSuggestion = parsedEndpoints[0]?.options.chatSuggestion ?? DEFAULT_CHAT_SUGGESTION;
  const clientMembers = parsedEndpoints.map(({ endpoint, options: memberOptions }) => ({
    endpoint,
    options: memberOptions,
    client: createHermesClient({ url: memberOptions.url, auth: memberOptions.auth }),
  }));
  // The global-skills discovery needs the same authenticated profile catalogue as its mutation.
  // Start the transport now; HermesBridge.start() below is idempotent and still owns all bridge
  // subscriptions and roster work after the listener is ready.
  for (const member of clientMembers) member.client.start();
  const candidateGlobalSkills = clientMembers.length === 0
    ? undefined
    : new GatewayHermesGlobalSkills(
      clientMembers.flatMap(({ endpoint, client }) => Object.keys(endpoint.config.profiles).map((profile) => ({
        id: publicProfileId(endpoint, profile), profile, client,
      }))),
      storage,
    );
  const harnessModelAdapters = clientMembers.map(
    ({ endpoint, client }) => new HermesHarnessModelSettingsAdapter(endpoint, client),
  );
  // Optional Hermes surfaces are evidence-gated, not configuration-gated. A missing,
  // malformed, or unreachable pinned response yields no adapter and no advertised route.
  const [workspaceResults, updateResults, sessionResults, hermesGlobalSkills] = await Promise.all([
    Promise.all(clientMembers.map(({ client }, index) =>
      discoverHermesWorkspace(client, harnessModelAdapters[index]!.descriptor()))),
    Promise.all(clientMembers.map(({ client }, index) =>
      discoverHermesUpdates(client, harnessModelAdapters[index]!.descriptor()))),
    Promise.all(clientMembers.map(({ client }, index) =>
      discoverHermesSessionManagement(client, harnessModelAdapters[index]!.descriptor()))),
    candidateGlobalSkills === undefined
      ? Promise.resolve(undefined)
      : candidateGlobalSkills.probe().then(() => candidateGlobalSkills).catch(() => undefined),
  ]);
  const discoveredWorkspaceAdapters = workspaceResults.filter((adapter) => adapter !== undefined);
  const discoveredSessionAdapters = sessionResults.filter((adapter) => adapter !== undefined);
  const hermesSessions = new GatewayHermesSessionManagement(discoveredSessionAdapters);
  const harnessWorkspace = new GatewayHarnessWorkspace(discoveredWorkspaceAdapters);
  const harnessUpdates = new GatewayHarnessUpdates(
    updateResults.filter((adapter) => adapter !== undefined),
  );
  let readMaintenanceRuntimeHealth = () => ({
    harness: endpoints.length === 0 ? "cozyagents" as const : "hermes" as const,
  });
  const maintenance = await discoverGatewayMaintenance(
    process.env,
    storage,
    GATEWAY_VERSION,
    () => readMaintenanceRuntimeHealth(),
    () => Date.now(),
  );
  const gatewayInfo = gatewayInfoForConfig(
    config,
    gatewaySettings !== undefined,
    harnessWorkspace.available,
    harnessUpdates.available,
    hermesSessions.capabilityVersion,
    hermesGlobalSkills !== undefined,
    maintenance !== undefined,
  );
  let mobileNode: MobileNodeBroker | undefined;
  const hub = new WsHub({
    storage, gatewayInfo, now: () => Date.now(), trace: traceLog,
    onMobileResult: (deviceId, frame) => mobileNode?.result(deviceId, frame),
    onDeviceDisconnect: (deviceId) => mobileNode?.disconnectDevice(deviceId),
    onMobileAvailable: (deviceId) => mobileNode?.reconnectDevice(deviceId),
  });

  // Dial-out JSON-RPC client to the Hermes gateway plus the cache/refresh/focus machinery on top
  // of it. Credential resolution already happened above, before the port is bound, so a
  // misconfigured bridge fails startup instead of half-starting.
  // The push notifier is built further down (it needs the hub's presence check, which needs the
  // hub), but the bridge above it has to be able to raise a group escalation. This indirection is
  // the whole of the coupling: unset until the notifier exists, which is before the listener is
  // bound and therefore before any room can run a round.
  let raisePush: (event: {
    threadId: string;
    agentName: string;
    preview: string;
  }) => void = () => {};
  // Same indirection, for the bots bridge's approval lifecycle (issue #19 bridge lane): the
  // notifier does not exist yet, and no approval can be raised before the listener is bound.
  let raiseApprovalPush: (payload: ApprovalPushPayload) => void = () => {};
  let raiseChatMessagePush: (event: ChatMessagePushEvent) => void = () => {};
  // Same indirection again, for capability 37's delete. The runtime attach identity (token map,
  // live socket, capability grant, adapter) is built below the bridge, so the bridge reaches it
  // through this hole rather than the construction order being rearranged around one route.
  // Until it is filled no bot can be deleted, because the listener is not bound yet.
  let killAttachIdentity: (name: string) => boolean = () => false;
  // Capability 49. Assembled below the plane, for the same construction-order reason.
  let runtimeBotService: RuntimeBotService | undefined;
  let raiseLiveActivityFrame: (frame: ServerFrame) => void = () => {};

  let federation: FederatedBotControlSurface | undefined;
  const bridgeMembers = clientMembers.map(({ endpoint, options: memberOptions, client }) => {
    const memberStorage = endpoint.namespace ? endpointStorage(storage, endpoint.id!) : storage;
    const member = new HermesBridge({
    client,
    storage: memberStorage,
    broadcast: (frame) => {
      if (endpoint.namespace && (frame.type === "bot_roster" || frame.type === "bot_presence")) {
        federation?.publish();
      } else if (endpoint.namespace && frame.type === "bot_routines") {
        const namespaced = { ...frame, bot: publicProfileId(endpoint, frame.bot) };
        hub.broadcast(namespaced);
        raiseLiveActivityFrame(namespaced);
      } else {
        hub.broadcast(frame);
        raiseLiveActivityFrame(frame);
      }
    },
    now: () => Date.now(),
    hiddenProfiles: memberOptions.hiddenProfiles,
    ...(memberOptions.bridgeProfile === undefined
      ? {}
      : { bridgeProfile: memberOptions.bridgeProfile }),
    seedBlankSlateBots: memberOptions.seedBlankSlateBots,
    blankSlateSkillsOn: memberOptions.blankSlateSkillsOn,
    revokeAttachIdentity: (name) => killAttachIdentity(publicProfileId(endpoint, name)),
    // Capability 46. Room membership is the only thing that reads this: a runtime bot has no
    // Dashboard profile, so a room naming one has to be answered from config rather than from
    // `profiles.list`. Shared by every bridge member because a runtime bot belongs to the gateway
    // rather than to any one Hermes endpoint.
    // Live, not a boot-time snapshot: a bot created from the app joins a room without a restart.
    // Evaluated per call, and the plane exists long before any room turn is dispatched.
    runtimeBotNames: () => nativeBotPlane?.runtimeBotNames() ?? bootRuntimeBotNames,
    // Spec section 4's `@user` escalation. The room's own state and frame already went out; this
    // is the leg that reaches a backgrounded phone. The thread id is namespaced `group:<name>`
    // rather than borrowed from a chat thread, so a client that does not know about rooms yet
    // cannot mistake it for one of its threads. Client-side handling of that id is the documented
    // follow-up (contract, "needs you").
    onGroupEscalation: (event) => {
      raisePush({
        threadId: `group:${event.group}`,
        agentName: event.displayName,
        preview: event.text,
      });
    },
    });
    return { endpoint, client, bridge: member };
  });
  const bridge = bridgeMembers.length === 1 && bridgeMembers[0]!.endpoint.namespace === false
    ? bridgeMembers[0]!.bridge
    : (federation = new FederatedBotControlSurface(
        bridgeMembers.map(({ endpoint, bridge: member }) => ({ id: endpoint.id!, bridge: member })),
        (view) => {
          const updatedAt = view.updatedAt ?? Date.now();
          const roster = { type: "bot_roster" as const, bots: view.bots, updatedAt };
          const presence = { type: "bot_presence" as const, active: view.bots.filter((bot) => bot.active).map((bot) => bot.name), updatedAt };
          hub.broadcast(roster);
          hub.broadcast(presence);
          raiseLiveActivityFrame(roster);
          raiseLiveActivityFrame(presence);
        },
      ));
  const harnessSettings = new GatewayHarnessSettings(
    harnessModelAdapters,
  );
  // Every configured Hermes profile has one attach identity shared by the core thread surface and
  // Bot Mode. Token resolution fails closed before the listener opens.
  const nativeBotIds = [
    ...profileEntries.map(([profileId]) => profileId),
    ...runtimeBots.map((bot) => bot.id),
  ];
  const router = new AttachRouter();
  let nativeSink: AttachNativeSink | undefined;
  const attachTokens = new Map<string, string>();
  for (const { endpoint } of parsedEndpoints) {
    const tokens = collectAttachTokens(endpoint.config.profiles, process.env);
    for (const [token, rawProfile] of tokens) {
      if (attachTokens.has(token))
        throw new Error("duplicate attach credential across Hermes endpoints; every profile must use a distinct token");
      attachTokens.set(token, publicProfileId(endpoint, rawProfile));
    }
  }
  // Native runtime bots share the same token map and the same collision rule: the token IS the
  // agent identity on /attach/v1, so a bot reusing a Hermes profile's token (or another bot's) is
  // a startup error, not a silent overwrite.
  const runtimeBotTokens = collectAttachTokens(
    Object.fromEntries(configRuntimeBots.map((bot) => [bot.id, { tokenEnv: bot.tokenEnv }])),
    process.env,
    "bot",
  );
  for (const [token, botId] of runtimeBotTokens) {
    if (attachTokens.has(token))
      throw new Error("duplicate attach credential; every bot must use a distinct token");
    attachTokens.set(token, botId);
  }
  // A gateway-created runtime bot carries its minted credential in its own storage row rather than
  // in an environment variable, because nothing placed it there: the gateway minted it during a
  // `POST /bots` that had to work with no operator at a terminal.
  for (const bot of storedRuntimeBots) {
    if (attachTokens.has(bot.token))
      throw new Error("duplicate attach credential; every bot must use a distinct token");
    attachTokens.set(bot.token, bot.id);
  }
  let nativeBotPlane: NativeBotDataPlane | undefined;
  let memorySurface: AttachMemorySurface | undefined;
  let configSurface: AttachConfigSurface | undefined;
  let historySurface: AttachHistorySurface | undefined;
  let botsSurface: BotsSurface;
  // Hermes profiles only: runtime bot ids (from `nativeBots(config)`) are intentionally absent
  // here. AttachV1Ingress#allowed falls back to the full capability set for any agentId with no
  // entry in this map, which is exactly what a runtime bot needs today -- so leaving them out is
  // fine, not an oversight.
  const allowedCapabilities = new Map<string, ReadonlySet<AttachV1Capability>>(
    profileEntries.map(([profileId]) => [
      profileId,
      new Set(ATTACH_V1_CAPABILITIES),
    ]),
  );
  const attachV1Ingress = new AttachV1Ingress({
    tokens: attachTokens,
    storage,
    allowedCapabilities,
    trace: traceLog,
    events: {
      canAcceptEvent: (agentId, frame) => {
        if (bridge instanceof HermesBridge && bridge.canAcceptGroupAttachEvent(agentId, frame)) return true;
        if (nativeBotPlane?.canAccept(agentId, frame)) return true;
        if (!("threadId" in frame.event))
          return (
            frame.event.kind === "presence" || frame.event.kind === "media" || frame.event.kind === "cozyapp_upsert" || frame.event.kind === "cozyapp_action_status"
          );
        const thread = storage.threadById(frame.event.threadId);
        return thread !== undefined && thread.agentId === agentId;
      },
      onEvent: (agentId, frame) => {
        if (frame.event.kind === "cozyapp_upsert") {
          try {
            assertValidCozyAppTree(frame.event.tree);
            storage.upsertCozyApp({ id: cozyAppPhysicalId(agentId, frame.event.appId), name: frame.event.name, creatorBot: agentId, tree: frame.event.tree, now: Date.now() });
            hub.broadcast({ type: "cozyapps_snapshot", ...storage.cozyAppsSnapshot() });
            return true;
          } catch {
            // Another creator already owns this stable client id. The malicious/buggy upsert is
            // refused without letting one bad event dead-letter and block that bot's whole stream.
            return true;
          }
        }
        if (frame.event.kind === "cozyapp_action_status") {
          if (storage.settleCozyAppAction({ id: frame.event.actionRequestId, appId: frame.event.appId, creatorBot: agentId, actionId: frame.event.actionId, status: frame.event.status, now: Date.now() })) {
            nativeBotPlane?.clearCozyAppActionOrigin(agentId, frame.event.appId, frame.event.actionRequestId);
            hub.broadcast({ type: "cozyapps_snapshot", ...storage.cozyAppsSnapshot() });
            return true;
          }
          return false;
        }
        if (bridge instanceof HermesBridge && bridge.handleGroupAttachEvent(agentId, frame)) return true;
        if (router.onV1Event(agentId, frame)) return true;
        if (nativeBotPlane?.handle(agentId, frame)) return true;
        if (frame.event.kind === "media" || frame.event.kind === "presence")
          return true;
        if (nativeSink?.handle(agentId, frame) === true) return true;
        return acknowledgeOrphanedAttachEvent(storage, agentId, frame);
      },
      onMobileRequest: (agentId, frame) => nativeBotPlane?.mobileRequest(agentId, frame),
      onMobileCancel: (agentId, frame) => mobileNode?.cancelRequest(agentId, frame.requestId),
      onMemoryResult: (agentId, frame) => { memorySurface?.handle(agentId, frame); },
      onConfigResult: (agentId, frame) => { configSurface?.handle(agentId, frame); },
      onHistoryResult: (agentId, frame) => { historySurface?.handle(agentId, frame); },
      // The plugin-facing receipt is the ingress' own business; this is the half the USER sees.
      onScheduledDeliveryFailed: (agentId, failure) =>
        nativeBotPlane?.recordScheduledDeliveryFailure(agentId, failure),
      onPresence: (agentId, state) => {
        hub.broadcast({
          type: "presence",
          agentId,
          state: state === "online" ? "online" : "absent",
        });
        nativeBotPlane?.handleAttachPresence(agentId, state);
        if (state === "absent") mobileNode?.disconnectAgent(agentId);
      },
    },
  });
  memorySurface = new AttachMemorySurface(attachV1Ingress, 12_000, traceLog);
  configSurface = new AttachConfigSurface(attachV1Ingress, 12_000, traceLog);
  historySurface = new AttachHistorySurface(attachV1Ingress, 12_000, traceLog);
  const attachEndpoint: TurnEndpoint = {
    isAttached: (agentId) => attachV1Ingress.isAttached(agentId),
    canQueue: (agentId) => attachV1Ingress.canQueue(agentId),
    sendTurn: (agentId, frame) => attachV1Ingress.sendTurn(agentId, frame),
    sendSteer: (agentId, frame) => attachV1Ingress.sendSteer(agentId, frame),
    sendInterrupt: (agentId, frame) =>
      attachV1Ingress.sendInterrupt(agentId, frame),
    sendApprovalResolution: (agentId, input) =>
      attachV1Ingress.sendApprovalResolution(agentId, input),
  };
  if (bridge instanceof HermesBridge) bridge.setGroupNativeTurns({
    canQueue: (agentId) => attachV1Ingress.canQueue(agentId),
    sendNativeTurn: (agentId, input) =>
      attachV1Ingress.sendNativeTurn(agentId, input),
  });
  const adapters = new Map(
    profileEntries.map(([profileId]) => {
      const adapter = createAttachAdapter({
        agentId: profileId,
        endpoint: attachEndpoint,
        turnTimeoutMs: config.turnTimeoutSeconds * 1000,
      });
      router.register(profileId, adapter);
      return [profileId, adapter] as const;
    }),
  );
  // Capability 37. Every runtime surface that would still answer for a deleted bot, torn down in
  // one place: the token map both public attach surfaces authenticate against (the WebSocket
  // upgrade and HTTP media share this exact Map object, so one delete covers both), the live
  // socket and its per-profile ingress state, the capability grant, and the adapter that would
  // otherwise keep a turn pending forever. Returns whether an attach identity was actually held,
  // which is what the delete response reports as `tokenRevoked`.
  killAttachIdentity = (name: string): boolean => {
    const revoked = revokeAttachTokens(attachTokens, name);
    attachV1Ingress.disconnectAgent(name);
    allowedCapabilities.delete(name);
    router.unregister(name);
    adapters.delete(name);
    return revoked;
  };
  const notifier = new RelayNotifier({
    storage,
    ...(config.pushRelayUrl === undefined
      ? {}
      : { relayBaseUrl: config.pushRelayUrl }),
    log: options.notifierLog,
    trace: traceLog,
    isDeviceConnected: (deviceId) => hub.isDeviceConnected(deviceId),
  });
  const liveActivityNotifier = new LiveActivityNotifier({
    storage,
    ...(config.pushRelayUrl === undefined
      ? {}
      : { relayBaseUrl: config.pushRelayUrl }),
    log: options.notifierLog,
    trace: traceLog,
  });
  raiseLiveActivityFrame = (frame) => liveActivityNotifier.handleFrame(frame);
  // Same targeting rule a 1:1 turn gets: a device holding a live socket saw the room's frame and is
  // excluded here rather than pushed to twice.
  raisePush = (event) => notifier.notify(event, hub.connectedDeviceIds());
  raiseApprovalPush = (payload) =>
    notifier.notifyApproval(payload, hub.connectedDeviceIds());
  raiseChatMessagePush = createChatMessagePushHandler(
    notifier,
    () => hub.connectedDeviceIds(),
    (event) => liveActivityNotifier.coveredDeviceIdsForChat(event),
  );
  mobileNode = new MobileNodeBroker({
    route: (deviceId, command) => hub.mobileNodeRoute(deviceId, command),
    wake: (deviceId) => notifier.notifyMobileNodeWake(deviceId),
    send: (deviceId, frame) => hub.sendMobileNodeFrame(deviceId, frame),
    result: (agentId, frame) => { attachV1Ingress.sendMobileResult(agentId, frame); },
    receipt: (receipt) => nativeBotPlane?.recordMobileReceipt(receipt) !== undefined,
    trace: traceLog,
  });
  nativeBotPlane = new NativeBotDataPlane({
    control: bridge,
    storage,
    ingress: attachV1Ingress,
    nativeBots: nativeBotIds,
    runtimeBots,
    runnerName,
    // Capability 49. The methods are forwarded rather than the service handed over, because the
    // service needs the plane (for the roster row and the live registration) as much as the plane
    // needs the service; one hole rather than a two-phase construction.
    runtimeLifecycle: {
      owns: (id) => runtimeBotService?.owns(id) === true,
      hasRuntime: (id) => runtimeBotService?.hasRuntime(id) === true,
      create: (input, row) => {
        if (runtimeBotService === undefined)
          throw new Error("the runtime bot service is not assembled yet");
        return runtimeBotService.create(input, row);
      },
      delete: (name, deleteOptions) => {
        if (runtimeBotService === undefined)
          throw new Error("the runtime bot service is not assembled yet");
        // The options are forwarded, not dropped: `?force=1` is the only way to delete a runtime
        // bot whose turn never settled, and a hole here makes that bot undeletable.
        return runtimeBotService.delete(name, deleteOptions);
      },
      recover: (name) => {
        if (runtimeBotService === undefined)
          throw new Error("the runtime bot service is not assembled yet");
        return runtimeBotService.recover(name);
      },
      projection: (name) => {
        if (runtimeBotService === undefined)
          throw new Error("the runtime bot service is not assembled yet");
        return runtimeBotService.projection(name);
      },
    },
    botConfig: configSurface,
    botHistory: historySurface,
    chatSuggestion,
    turnTimeoutMs: config.turnTimeoutSeconds * 1000,
    staleTurnSweepMs: millis(config.staleTurnSweepSeconds),
    staleTurnInterruptGraceMs: millis(config.staleTurnInterruptGraceSeconds),
    staleTurnCeilingMs: millis(config.staleTurnCeilingSeconds),
    broadcast: (frame) => {
      hub.broadcast(frame);
      raiseLiveActivityFrame(frame);
    },
    onChatMessage: (event) => raiseChatMessagePush(event),
    onApproval: (event) => {
      raiseApprovalPush(
        event.outcome === undefined
          ? {
              kind: "approval_pending",
              threadId: `bot:${event.bot}`,
              agentId: event.bot,
              turnId: event.turnId,
              toolCallId: event.toolCallId,
              name: event.name ?? "tool",
            }
          : {
              kind: "approval_resolved",
              threadId: `bot:${event.bot}`,
              agentId: event.bot,
              turnId: event.turnId,
              toolCallId: event.toolCallId,
              outcome: event.outcome,
            },
      );
    },
    now: () => Date.now(),
    trace: traceLog,
    mobileNode,
  });
  const nativePlane = nativeBotPlane;
  // Capability 51. A room member turn records ordinary interaction rows, so it borrows the plane's
  // own deadline wheel and turn-settlement rule rather than growing a second copy. Wired here, like
  // the room turn transport above, because the plane is assembled after the bridge that owns rooms.
  if (bridge instanceof HermesBridge) bridge.setGroupInteractionExpiry(nativePlane.groupInteractions());
  // Capability 49, multi-tenant since 52. The lane is always assembled now: a runner paired through
  // `POST /pair {kind: "runner"}` gets its token at runtime, long after this line ran, so a lane
  // built only for an operator-placed `COZYGATEWAY_RUNNER_TOKEN` would leave a freshly paired
  // runner with nowhere to dial. The shared token stays supported as the legacy credential.
  const runnerLane = new RunnerLane({
    ...(legacyRunnerConfigured ? { token: runnerToken } : {}),
    roster: runnerRoster,
    storage,
    attachTokenFor: (botId) => storage.runtimeBot(botId)?.token,
    onReceipt: () => bridge.refreshSoon("runner receipt"),
    now: () => Date.now(),
  });
  readMaintenanceRuntimeHealth = () => {
    if (endpoints.length === 0) {
      return maintenanceRuntimeHealth({
        harness: "cozyagents",
        coLocatedRunnerId: maintenance?.coLocatedRunnerId(),
        connectedRunners: runnerLane.connectedRunners(),
      });
    }
    const attach = attachV1Ingress.health();
    return maintenanceRuntimeHealth({
      harness: "hermes",
      attach: { configured: attach.configured, online: attach.online },
      deadLetters: storage.attachProjectionDeadLetters().length,
    });
  };
  runtimeBotService = new RuntimeBotService({
    storage,
    lane: runnerLane,
    spec: () => runtimeSpecDefaults(process.env),
    now: () => Date.now(),
    // Capability 54. Which computer a create belongs to, and what it is called on every row that
    // names it.
    resolveRunner: createRunnerResolver({
      roster: runnerRoster,
      legacyConfigured: () => legacyRunnerConfigured,
    }),
    runnerName,
    register: (bot) => {
      // The exact inverse of `killAttachIdentity`: the token map both public attach surfaces
      // authenticate against, then the sets that decide which bots this gateway serves at all.
      attachTokens.set(bot.token, bot.id);
      nativePlane.addRuntimeBot({
        id: bot.id,
        name: bot.name,
        avatar: bot.avatar,
        runtime: bot.runtime,
        ...(bot.runnerId === undefined || bot.runnerId === null ? {} : { runnerId: bot.runnerId }),
      });
    },
    unregister: (id) => {
      const revoked = killAttachIdentity(id);
      nativePlane.removeRuntimeBot(id);
      return revoked;
    },
    reservedName: (id) => hermesProfileIds.has(id),
    rosterChanged: (reason) => bridge.refreshSoon(reason),
  });
  botsSurface = nativePlane.surface();
  const nativeHistory = nativePlane.historySurface();
  const nativeRunRoutine = nativePlane.runRoutineSurface();
  // Same rows, same overlay, both surfaces: the `bot_roster` frame and `GET /bots` are now built
  // by one function, so a WS row carries the chat session id its REST twin carries.
  bridge.setRosterOverlay((bots) => nativePlane.rosterBots(bots));
  nativeSink = new AttachNativeSink({
    storage,
    broadcast: (frame) => {
      hub.broadcast(frame);
      raiseLiveActivityFrame(frame);
    },
    notifier,
    connectedDeviceIds: () => hub.connectedDeviceIds(),
    now: () => Date.now(),
  });
  for (const [profileId] of profileEntries)
    attachV1Ingress.replayUnapplied(profileId);
  const runner = new TurnRunner({
    storage,
    hub,
    adapters,
    notifier,
    now: () => Date.now(),
    turnTimeoutMs: config.turnTimeoutSeconds * 1000,
    ...(options.approvalLog === undefined
      ? {}
      : { approvalLog: options.approvalLog }),
  });

  const app = createApp({
    storage,
    config,
    gatewayInfo,
    ...(options.notifierLog === undefined ? {} : { pushRelayLog: options.notifierLog }),
    ...(gatewaySettings === undefined ? {} : { gatewaySettings }),
    ...(maintenance === undefined ? {} : { maintenance }),
    gatewaySettingsLog: traceLog,
    harnessSettings,
    ...(harnessUpdates.available ? { harnessUpdates } : {}),
    ...(hermesSessions.available ? { hermesSessions } : {}),
    ...(hermesGlobalSkills === undefined ? {} : { hermesGlobalSkills }),
    hermesGlobalSkillsLog: traceLog,
    ...(harnessWorkspace.available ? { harnessWorkspace } : {}),
    ...(options.pairingAdmission === undefined ? {} : { pairingAdmission: options.pairingAdmission }),
    attachHealth: () => attachV1Ingress.health(),
    attachDeadLetters: () => storage.attachProjectionDeadLetters(),
    releaseAttachDeadLetter: (agentId, eventId) =>
      attachV1Ingress.releaseProjectionDeadLetter(agentId, eventId),
    bots: botsSurface,
    memory: memorySurface,
    // The plane's guard, not the raw lane: history is a runtime-bot fact, and the 409 a Hermes bot
    // gets is decided in one place rather than in each of the five routes.
    ...(nativeHistory === undefined ? {} : { history: nativeHistory }),
    ...(nativeRunRoutine === undefined ? {} : { runRoutine: nativeRunRoutine }),
    attachTokens,
    attachMediaAllowed: (agentId: string) =>
      // Capability 49: a bot created through `POST /bots {runtime}` has no config line to be found
      // in, so the gateway-owned row is the other half of the same rollout gate.
      storage.runtimeBot(agentId) !== undefined || allowedAttachMedia(config, agentId),
    sendCozyAppAction: (action, deviceId) => {
      if (!nativeBotPlane?.registerCozyAppActionOrigin(action.creatorBot, action.appId, action.id, deviceId, Math.max(30_000, config.turnTimeoutSeconds * 1000))) return false;
      const queued = attachV1Ingress.sendCozyAppAction(action.creatorBot, { appId: action.appId, actionId: action.actionId, actionRequestId: action.id });
      if (!queued) nativeBotPlane.clearCozyAppActionOrigin(action.creatorBot, action.appId, action.id);
      return queued;
    },
    cozyAppsChanged: () => hub.broadcast({ type: "cozyapps_snapshot", ...storage.cozyAppsSnapshot() }),
    beginMobileMediaUpload: (deviceId, requestId, lease) => {
      const claim = mobileNode?.beginMediaUpload(deviceId, requestId, lease);
      return claim === undefined ? undefined : {
        agentId: claim.agentId,
        complete: (media, reason) => mobileNode?.completeMediaUpload(claim, media, reason) ?? false,
      };
    },
    presenceOf: (agentId) => adapters.get(agentId)?.presence() ?? "unknown",
    submitUserMessage: (threadId, blocks) =>
      runner.submitUserMessage(threadId, blocks),
    // The runner's "unsupported" outcome collapses to "interrupting" here: a turn WAS in
    // flight, so REST answers 202, and the runner has already emitted the interrupt_unsupported
    // error frame over the WebSocket.
    interruptThread: (threadId) =>
      runner.interrupt(threadId) === "idle" ? "idle" : "interrupting",
    resolveApproval: (input) =>
      runner.resolveApproval(
        input.threadId,
        input.toolCallId,
        input.decision,
        input.deviceId,
      ),
    onDeviceRevoked: (deviceId) => hub.closeDevice(deviceId),
    // Capability 52. The roster and the lane are two views of the same runners, so the routes read
    // the rows from one and the liveness from the other rather than either inventing the other.
    runners: runnerRoster,
    runnerPresence: {
      online: (runnerId) => runnerLane.connectedRunners().includes(runnerId),
      lastContactAt: (runnerId) => runnerLane.lastContactAt(runnerId),
    },
    legacyRunnerConfigured,
    // The LISTENING port, not the configured one: a host that asked for port 0 (every test, and a
    // supervisor that hands out ports) would otherwise mint codes naming a port nothing serves.
    pairingUrl: () => pairingOrigin(),
    onRunnerRevoked: (runnerId) => { runnerLane.disconnectRunner(runnerId); },
    hermesBridgeAbsent: endpoints.length === 0,
    now: () => Date.now(),
  });

  // Filled in once the listener is bound, below. Read only from inside a request handler, which
  // cannot run before then.
  let boundPort = config.port;
  const pairingOrigin = (): string => {
    if (config.publicUrl !== undefined) return config.publicUrl;
    const host = config.host;
    const advertised =
      host !== undefined && host !== "0.0.0.0" && host !== "::"
        ? host
        : primaryLanAddress() ?? "127.0.0.1";
    return listenerOrigin(advertised, boundPort, scheme);
  };

  const server = await new Promise<Server>((resolve) => {
    // The TLS branch swaps only the factory and its options; the fetch handler, the port, the
    // hostname, and the upgrade dispatcher below are identical either way. https.Server extends
    // http.Server, so everything downstream (including the 'upgrade' listener that carries /ws and
    // /attach/v1, which therefore become wss automatically) is unchanged.
    const s = serve(
      {
        fetch: app.fetch,
        port: config.port,
        hostname: config.host ?? "127.0.0.1",
        ...(tls === undefined
          ? {}
          : {
              createServer: createHttpsServer,
              serverOptions: { cert: tls.cert, key: tls.key },
            }),
      },
      () => {
        resolve(s as Server);
      },
    );
  });
  // Two ws WebSocketServer instances constructed with {server, path} on the SAME http.Server
  // would each attach their own 'upgrade' listener, and Node invokes both for every request; the
  // non-matching one's default path check fails and it aborts the handshake, corrupting the
  // socket the OTHER instance already claimed. Both are constructed with {noServer: true}
  // instead, so this is the only 'upgrade' listener on the server: it dispatches by pathname, and
  // a path matching neither endpoint gets a clean HTTP error instead of hanging.
  const routes = new Map<string, UpgradeHandler>([
    ["/ws", (req, socket, head) => hub.handleUpgrade(req, socket, head)],
  ]);
  routes.set("/attach/v1", (req, socket, head) =>
    attachV1Ingress.handleUpgrade(req, socket, head),
  );
  // Capability 49, beside `/attach/v1` and authenticated the same way. Since 52 the path is always
  // registered: a runner pairs at runtime and every credential is resolved per connection, so a
  // socket nothing can authenticate is closed `1008` rather than never accepted.
  routes.set("/runner/v1", (req, socket, head) => runnerLane.handleUpgrade(req, socket, head));
  server.on("upgrade", createUpgradeDispatcher(routes));
  // Started after the listener is up so the first roster refresh cannot race the hub it
  // broadcasts through.
  for (const member of bridgeMembers) member.bridge.start();
  // Start periodic retention only after startup succeeds. A failed startup must not leave a timer
  // repeatedly touching a database that no running gateway owns, and a later disk fault must not
  // escape the timer callback and terminate an otherwise healthy process.
  const attachMediaSweep = setInterval(() => {
    try {
      storage.pruneExpiredAttachMedia(Date.now());
    } catch (error) {
      console.error(
        `attachment media retention sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, PHOTO_SWEEP_MS);
  attachMediaSweep.unref?.();
  const address = server.address();
  const port =
    address !== null && typeof address === "object"
      ? address.port
      : config.port;
  boundPort = port;

  return {
    url: `${scheme}://${config.host ?? "127.0.0.1"}:${port}`,
    port,
    storage,
    issueSetupCode: () => {
      const code = newSetupCode();
      storage.createSetupCode(code, Date.now() + SETUP_CODE_TTL_MS);
      return code;
    },
    close: async () => {
      clearInterval(attachMediaSweep);
      const durableAttachShutdown = profileEntries.some(([profileId]) =>
        attachV1Ingress.hasNegotiated(profileId),
      );
      hub.close();
      // Closing attach sockets fires the disconnect path, which fails in-flight turns, so the
      // runner's per-thread chains settle before closeAll drains them.
      memorySurface?.close();
      configSurface?.close();
      historySurface?.close();
      attachV1Ingress.close();
      // The bots bridge holds a dial-out socket and its own timers; closing it cancels both.
      await Promise.all(bridgeMembers.map((member) => member.bridge.close()));
      nativeBotPlane.close();
      runnerLane.close();
      mobileNode?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (durableAttachShutdown) runner.abandonAll();
      else await runner.closeAll();
      storage.close();
    },
  };
}

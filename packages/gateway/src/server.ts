import type { Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { serve } from "@hono/node-server";
import {
  APPROVALS_CAPABILITY_ID,
  APPROVALS_CAPABILITY_VERSION,
  BOTS_CAPABILITY_ID,
  BOTS_CAPABILITY_VERSION,
  type GatewayInfo,
  type ServerFrame,
} from "cozygateway-contract";

import type { GatewayConfig } from "./config.ts";
import { openStorage, type Storage } from "./storage.ts";
import {
  ATTACH_V1_CAPABILITIES,
  AttachV1Ingress,
} from "./adapters/attach/ingress-v1.ts";
import type { AttachV1Capability } from "./adapters/attach/protocol-v1.ts";
import { AttachNativeSink } from "./adapters/attach/native-sink.ts";
import {
  AttachRouter,
  collectAttachTokens,
  createAttachAdapter,
  type TurnEndpoint,
} from "./adapters/attach/adapter.ts";
import { createApp } from "./http.ts";
import { WsHub } from "./ws-hub.ts";
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
import { parseHermesOptions } from "./hermes-bridge/config.ts";
import { HermesBridge, type BotsSurface } from "./hermes-bridge/bridge.ts";
import { NativeBotDataPlane } from "./hermes-bridge/native-data-plane.ts";
import { resolveTlsMaterial } from "./tls.ts";
import type { TraceLog } from "./trace.ts";

export const GATEWAY_VERSION = "0.2.5";
export const PUSH_PROXY_CAPABILITY_ID = "com.cozylabs.push-proxy";
export const PUSH_PROXY_CAPABILITY_VERSION = 1;

function allowedAttachMedia(config: GatewayConfig, agentId: string): boolean {
  return Object.keys(config.hermes.profiles).some(
    (profile) => profile.trim().toLowerCase() === agentId,
  );
}

export interface RunningGateway {
  url: string;
  port: number;
  storage: Storage;
  issueSetupCode(): string;
  close(): Promise<void>;
}

export interface StartGatewayOptions {
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
export function gatewayInfoForConfig(config: GatewayConfig): GatewayInfo {
  return {
    name: config.name,
    version: GATEWAY_VERSION,
    contract: "v1",
    capabilities: {
      ...(config.capabilities ?? {}),
      [APPROVALS_CAPABILITY_ID]: APPROVALS_CAPABILITY_VERSION,
      ...(config.hermes === undefined
        ? {}
        : { [BOTS_CAPABILITY_ID]: BOTS_CAPABILITY_VERSION }),
      ...(config.pushRelayUrl === undefined
        ? {}
        : { [PUSH_PROXY_CAPABILITY_ID]: PUSH_PROXY_CAPABILITY_VERSION }),
    },
  };
}

export async function startGateway(
  config: GatewayConfig,
  options: StartGatewayOptions = {},
): Promise<RunningGateway> {
  // Transition records deliberately have a useful production default. They remain injectable so
  // embedded hosts and tests can collect them without intercepting stderr.
  const traceLog = options.traceLog ?? ((line: string) => process.stderr.write(`${line}\n`));
  // First thing, before the database is opened or a single socket is dialed: if the operator asked
  // for TLS, prove the pair is usable. Absent config resolves to undefined and every line below
  // behaves exactly as it did before TLS existed. Present-but-broken throws here, so the failure is
  // a refusal to start rather than a plaintext listener on a port believed to be encrypted.
  const tls = resolveTlsMaterial(config.tls);
  const scheme = tls === undefined ? "http" : "https";
  const storage = openStorage(config.dbPath);
  const profileEntries = Object.entries(config.hermes.profiles).map(
    ([rawId, profile]) => [rawId.trim().toLowerCase(), profile] as const,
  );
  for (const [id, profile] of profileEntries) {
    storage.upsertAgent({
      id,
      name: profile.name ?? id,
      avatar: profile.avatar ?? null,
      backend: "attach",
    });
  }
  // capabilities is always present, empty when unconfigured, so the shape is uniform across
  // /health, the pair response, and the ready frame (contract v1.md section 5). Absence is a
  // valid wire shape too (older gateways), but this implementation always advertises the field.
  //
  // Built-in optional surfaces advertise vendor capability ids only when their backing config is
  // present. Each integer version advances independently of the frozen contract literal.
  const hermesOptions = parseHermesOptions(config.hermes, process.env);
  const gatewayInfo = gatewayInfoForConfig(config);
  const hub = new WsHub({ storage, gatewayInfo, now: () => Date.now(), trace: traceLog });

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
  let raiseLiveActivityFrame: (frame: ServerFrame) => void = () => {};

  const client = createHermesClient({
    url: hermesOptions.url,
    auth: hermesOptions.auth,
  });
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => {
      hub.broadcast(frame);
      raiseLiveActivityFrame(frame);
    },
    now: () => Date.now(),
    hiddenProfiles: hermesOptions.hiddenProfiles,
    ...(hermesOptions.bridgeProfile === undefined
      ? {}
      : { bridgeProfile: hermesOptions.bridgeProfile }),
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

  // Every configured Hermes profile has one attach identity shared by the core thread surface and
  // Bot Mode. Token resolution fails closed before the listener opens.
  const nativeBotEntries = profileEntries;
  const router = new AttachRouter();
  let nativeSink: AttachNativeSink | undefined;
  const attachTokens = collectAttachTokens(config.hermes.profiles, process.env);
  let nativeBotPlane: NativeBotDataPlane | undefined;
  let botsSurface: BotsSurface;
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
        if (bridge.canAcceptGroupAttachEvent(agentId, frame)) return true;
        if (nativeBotPlane?.canAccept(agentId, frame)) return true;
        if (!("threadId" in frame.event))
          return (
            frame.event.kind === "presence" || frame.event.kind === "media"
          );
        const thread = storage.threadById(frame.event.threadId);
        return thread !== undefined && thread.agentId === agentId;
      },
      onEvent: (agentId, frame) => {
        if (bridge.handleGroupAttachEvent(agentId, frame)) return true;
        if (router.onV1Event(agentId, frame)) return true;
        if (nativeBotPlane?.handle(agentId, frame)) return true;
        if (frame.event.kind === "media" || frame.event.kind === "presence")
          return true;
        return nativeSink?.handle(agentId, frame) ?? false;
      },
      onPresence: (agentId, state) => {
        hub.broadcast({
          type: "presence",
          agentId,
          state: state === "online" ? "online" : "absent",
        });
        nativeBotPlane?.handleAttachPresence(agentId, state);
      },
    },
  });
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
  bridge.setGroupNativeTurns({
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
  nativeBotPlane = new NativeBotDataPlane({
    control: bridge,
    storage,
    ingress: attachV1Ingress,
    nativeBots: nativeBotEntries.map(([bot]) => bot),
    chatSuggestion: hermesOptions.chatSuggestion,
    turnTimeoutMs: config.turnTimeoutSeconds * 1000,
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
  });
  botsSurface = nativeBotPlane.surface();
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
    attachHealth: () => attachV1Ingress.health(),
    bots: botsSurface,
    attachTokens,
    attachMediaAllowed: (agentId: string) =>
      allowedAttachMedia(config, agentId),
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
    now: () => Date.now(),
  });

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
  server.on("upgrade", createUpgradeDispatcher(routes));
  // Started after the listener is up so the first roster refresh cannot race the hub it
  // broadcasts through.
  bridge.start();
  const address = server.address();
  const port =
    address !== null && typeof address === "object"
      ? address.port
      : config.port;

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
      const durableAttachShutdown = profileEntries.some(([profileId]) =>
        attachV1Ingress.hasNegotiated(profileId),
      );
      hub.close();
      // Closing attach sockets fires the disconnect path, which fails in-flight turns, so the
      // runner's per-thread chains settle before closeAll drains them.
      attachV1Ingress.close();
      // The bots bridge holds a dial-out socket and its own timers; closing it cancels both.
      await bridge.close();
      nativeBotPlane.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (durableAttachShutdown) runner.abandonAll();
      else await runner.closeAll();
      storage.close();
    },
  };
}

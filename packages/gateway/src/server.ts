import type { Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { serve } from "@hono/node-server";
import {
  APPROVALS_CAPABILITY_ID,
  APPROVALS_CAPABILITY_VERSION,
  BOTS_CAPABILITY_ID,
  BOTS_CAPABILITY_VERSION,
  type GatewayInfo,
} from "cozygateway-contract";

import type { GatewayConfig } from "./config.ts";
import { openStorage, type Storage } from "./storage.ts";
import { buildAdapters } from "./adapters/registry.ts";
import { AttachIngress } from "./adapters/attach/ingress.ts";
import { ATTACH_V1_CAPABILITIES, AttachV1Ingress } from "./adapters/attach/ingress-v1.ts";
import type { AttachV1Capability } from "./adapters/attach/protocol-v1.ts";
import { AttachNativeSink } from "./adapters/attach/native-sink.ts";
import { AttachRouter, collectAttachTokens } from "./adapters/attach/adapter.ts";
import type { OpenClawClient } from "./adapters/openclaw/client.ts";
import { parseOpenClawOptions } from "./adapters/openclaw/config.ts";
import { createApp } from "./http.ts";
import { WsHub } from "./ws-hub.ts";
import { TurnRunner } from "./turns.ts";
import { RelayNotifier, type ChatMessagePushEvent } from "./push-notifier.ts";
import type { ApprovalPushPayload } from "./push-crypto.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";
import { createUpgradeDispatcher, type UpgradeHandler } from "./upgrade-dispatcher.ts";
import { createHermesClient } from "./hermes-bridge/client.ts";
import { parseHermesOptions } from "./hermes-bridge/config.ts";
import { HermesBridge, type BotsSurface } from "./hermes-bridge/bridge.ts";
import { NativeBotDataPlane } from "./hermes-bridge/native-data-plane.ts";
import { resolveTlsMaterial } from "./tls.ts";

export const GATEWAY_VERSION = "0.1.0";
export const PUSH_PROXY_CAPABILITY_ID = "com.cozylabs.push-proxy";
export const PUSH_PROXY_CAPABILITY_VERSION = 1;

function allowedAttachMedia(config: GatewayConfig, agentId: string): boolean {
  const entry = Object.entries(config.hermes?.nativeDataPlane ?? {})
    .find(([bot]) => bot.trim().toLowerCase() === agentId)?.[1];
  return entry?.features?.media !== false;
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
  /** Overrides the sink for the OpenClaw backend's startup root-token caveat (one line per
   *  configured openclaw agent). Defaults to stderr. The line NEVER contains the token value,
   *  only the env var NAME it rides. Exists so tests can assert the caveat text (and the token's
   *  absence from it) without scraping real stderr. */
  openclawLog?: (message: string) => void;
  /** Overrides the sink for the approval audit line the runner writes on every resolved approval
   *  (issue #19). Defaults to stderr, like the other two. The line names the thread, turn,
   *  toolCallId, outcome, and deciding device, and never the approval's argument summary. Exists
   *  so a test can read the audit trail without scraping real stderr. */
  approvalLog?: (message: string) => void;
}

/** The assembly seam between Hermes' settled-chat event and the relay notifier. Kept pure so the
 *  live hub snapshot, rather than a startup-time set, is pinned by a unit test. */
export function createChatMessagePushHandler(
  notifier: Pick<RelayNotifier, "notifyChatMessage">,
  connectedDeviceIds: () => ReadonlySet<string>,
): (event: ChatMessagePushEvent) => void {
  return (event) => notifier.notifyChatMessage(event, connectedDeviceIds());
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
      ...(config.hermes === undefined ? {} : { [BOTS_CAPABILITY_ID]: BOTS_CAPABILITY_VERSION }),
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
  // First thing, before the database is opened or a single socket is dialed: if the operator asked
  // for TLS, prove the pair is usable. Absent config resolves to undefined and every line below
  // behaves exactly as it did before TLS existed. Present-but-broken throws here, so the failure is
  // a refusal to start rather than a plaintext listener on a port believed to be encrypted.
  const tls = resolveTlsMaterial(config.tls);
  const scheme = tls === undefined ? "http" : "https";
  const storage = openStorage(config.dbPath);
  for (const agent of config.agents) {
    storage.upsertAgent({ id: agent.id, name: agent.name, avatar: agent.avatar ?? null, backend: agent.backend });
  }
  // capabilities is always present, empty when unconfigured, so the shape is uniform across
  // /health, the pair response, and the ready frame (contract v1.md section 5). Absence is a
  // valid wire shape too (older gateways), but this implementation always advertises the field.
  //
  // Built-in optional surfaces advertise vendor capability ids only when their backing config is
  // present. Each integer version advances independently of the frozen contract literal.
  const hermesOptions = config.hermes === undefined ? undefined : parseHermesOptions(config.hermes, process.env);
  const gatewayInfo = gatewayInfoForConfig(config);
  const hub = new WsHub({ storage, gatewayInfo, now: () => Date.now() });

  // Dial-out JSON-RPC client to the Hermes gateway plus the cache/refresh/focus machinery on top
  // of it. Credential resolution already happened above, before the port is bound, so a
  // misconfigured bridge fails startup instead of half-starting.
  // The push notifier is built further down (it needs the hub's presence check, which needs the
  // hub), but the bridge above it has to be able to raise a group escalation. This indirection is
  // the whole of the coupling: unset until the notifier exists, which is before the listener is
  // bound and therefore before any room can run a round.
  let raisePush: (event: { threadId: string; agentName: string; preview: string }) => void = () => {};
  // Same indirection, for the bots bridge's approval lifecycle (issue #19 bridge lane): the
  // notifier does not exist yet, and no approval can be raised before the listener is bound.
  let raiseApprovalPush: (payload: ApprovalPushPayload) => void = () => {};
  let raiseChatMessagePush: (event: ChatMessagePushEvent) => void = () => {};

  let bridge: HermesBridge | undefined;
  if (hermesOptions !== undefined) {
    const client = createHermesClient({
      url: hermesOptions.url,
      auth: hermesOptions.auth,
    });
    bridge = new HermesBridge({
      client,
      storage,
      broadcast: (frame) => hub.broadcast(frame),
      now: () => Date.now(),
      hideBotChats: hermesOptions.hideBotChats,
      chatSuggestion: hermesOptions.chatSuggestion,
      hiddenProfiles: hermesOptions.hiddenProfiles,
      ...(hermesOptions.bridgeProfile === undefined ? {} : { bridgeProfile: hermesOptions.bridgeProfile }),
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
      // Capability 10. The bots surface has no threads, so the push payload's `threadId` is the
      // namespaced `bot:<name>` -- the same shape `group:<name>` already uses, so a client that
      // does not know the namespace cannot mistake it for one of its threads -- and `agentId` is
      // the bot's own profile name, which is what a bots client addresses everything else by.
      onApproval: (event) => {
        raiseApprovalPush(
          event.kind === "approval_pending"
            ? {
                kind: "approval_pending",
                threadId: `bot:${event.bot}`,
                agentId: event.bot,
                turnId: event.turnId,
                toolCallId: event.toolCallId,
                name: event.name,
                // No argSummary: the hermes approval surface carries no structured arguments to
                // summarize, so there is nothing to redact and nothing to send.
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
      onChatMessage: (event) => raiseChatMessagePush(event),
      ...(options.approvalLog === undefined ? {} : { approvalLog: options.approvalLog }),
      ...(hermesOptions.approvalTimeoutMs === undefined
        ? {}
        : { approvalTimeoutMs: hermesOptions.approvalTimeoutMs }),
    });
  }

  // The attach ingress exists only when an attach agent is configured. Token resolution fails
  // closed BEFORE the listener opens, so a misconfigured gateway never half-starts.
  const attachAgents = config.agents.filter((a) => a.backend === "attach");
  const nativeBotEntries = Object.entries(config.hermes?.nativeDataPlane ?? {});
  const router = new AttachRouter();
  let nativeSink: AttachNativeSink | undefined;
  let attachIngress: AttachIngress | undefined;
  let attachV1Ingress: AttachV1Ingress | undefined;
  let attachEndpoint: import("./adapters/attach/adapter.ts").TurnEndpoint | undefined;
  let attachTokens: Map<string, string> | undefined;
  let nativeBotPlane: NativeBotDataPlane | undefined;
  let botsSurface: BotsSurface | undefined = bridge;
  if (attachAgents.length > 0 || nativeBotEntries.length > 0) {
    const tokens = collectAttachTokens(config.agents, process.env);
    for (const [rawBot, native] of nativeBotEntries) {
      const bot = rawBot.trim().toLowerCase();
      const token = process.env[native.tokenEnv];
      if (token === undefined || token.length === 0) {
        throw new Error(`native bot "${bot}": environment variable "${native.tokenEnv}" is not set`);
      }
      const holder = tokens.get(token);
      if (holder !== undefined) throw new Error(`native bot "${bot}": attach token collides with "${holder}"`);
      tokens.set(token, bot);
    }
    attachTokens = tokens;
    attachIngress = new AttachIngress({
      tokens,
      events: {
        onUpdate: (agentId, threadId, update) => router.onUpdate(agentId, threadId, update),
        onDisconnect: (agentId) => router.onDisconnect(agentId),
        onPresence: (agentId, state) => hub.broadcast({ type: "presence", agentId, state }),
      },
    });
    const allowedCapabilities = new Map<string, ReadonlySet<AttachV1Capability>>();
    for (const [rawBot, native] of nativeBotEntries) {
      const features = native.features;
      allowedCapabilities.set(rawBot.trim().toLowerCase(), new Set(ATTACH_V1_CAPABILITIES.filter((capability) => {
        if (capability === "media") return features?.media !== false;
        if (capability === "tools") return features?.tools !== false;
        if (capability === "approvals") return features?.interactions !== false;
        if (capability === "clarify") return features?.clarify !== false;
        if (capability === "scheduled") return features?.scheduled !== false;
        return true;
      })));
    }
    attachV1Ingress = new AttachV1Ingress({
      tokens,
      storage,
      allowedCapabilities,
      events: {
        canAcceptEvent: (agentId, frame) => {
          if (nativeBotPlane?.handles(agentId)) return nativeBotPlane.canAccept(agentId, frame);
          if (frame.event.kind !== "scheduled") return true;
          const thread = storage.threadById(frame.event.threadId);
          return thread !== undefined && thread.agentId === agentId;
        },
        onEvent: (agentId, frame) => {
          if (router.onV1Event(agentId, frame)) return true;
          if (nativeBotPlane?.handle(agentId, frame)) return true;
          if (frame.event.kind === "media" || frame.event.kind === "presence") return true;
          return nativeSink?.handle(agentId, frame) ?? false;
        },
        onPresence: (agentId, state) =>
          hub.broadcast({ type: "presence", agentId, state: state === "online" ? "online" : "absent" }),
      },
    });
    const v0 = attachIngress;
    const v1 = attachV1Ingress;
    attachEndpoint = {
      isAttached: (agentId) => v1.isAttached(agentId) || v0.isAttached(agentId),
      canQueue: (agentId) => v1.hasNegotiated(agentId),
      sendTurn: (agentId, frame) =>
        v1.hasNegotiated(agentId) ? v1.sendTurn(agentId, frame) : v0.sendTurn(agentId, frame),
      sendSteer: (agentId, frame) =>
        v1.hasNegotiated(agentId) ? v1.sendSteer(agentId, frame) : v0.sendSteer(agentId, frame),
      sendInterrupt: (agentId, frame) =>
        v1.hasNegotiated(agentId) ? v1.sendInterrupt(agentId, frame) : v0.sendInterrupt(agentId, frame),
      sendApprovalResolution: (agentId, input) =>
        v1.hasNegotiated(agentId) ? v1.sendApprovalResolution(agentId, input) : false,
    };
  }

  // The openclaw backend dials OUT (one OpenClawClient per configured agent, no shared ingress).
  // Token resolution still fails closed BEFORE the listener opens, mirroring collectAttachTokens's
  // placement for attach: a misconfigured openclaw agent (missing/invalid options, unset token
  // env) throws here, before any client dials out or the port is bound.
  const openclawAgents = config.agents.filter((a) => a.backend === "openclaw");
  const openclawLog = options.openclawLog ?? ((message: string) => void process.stderr.write(`${message}\n`));
  for (const agent of openclawAgents) {
    const parsed = parseOpenClawOptions(agent, process.env);
    // Root-token caveat: an OpenClaw operator token is ROOT on the target gateway. Name the agent,
    // the target, and the env var the token rides -- but never the token value itself.
    openclawLog(
      `[openclaw] agent "${agent.id}": connecting as OPERATOR to ${parsed.url}. ` +
        `The operator token is ROOT on the target OpenClaw gateway; it rides env "${agent.options?.["tokenEnv"] as string}" and is never logged.`,
    );
  }
  const openclawClients = new Map<string, OpenClawClient>();

  const adapters = buildAdapters(
    config.agents,
    attachEndpoint === undefined
      ? undefined
      : {
          endpoint: attachEndpoint,
          env: process.env,
          register: (agentId, adapter) => {
            router.register(agentId, adapter);
          },
        },
    openclawAgents.length === 0
      ? undefined
      : {
          env: process.env,
          register: (agentId, client) => {
            openclawClients.set(agentId, client);
            client.onStateChange((state) =>
              hub.broadcast({
                type: "presence",
                agentId,
                state: state === "online" ? "online" : "absent",
              }),
            );
          },
        },
  );
  const notifier = new RelayNotifier({
    storage,
    ...(config.pushRelayUrl === undefined ? {} : { relayBaseUrl: config.pushRelayUrl }),
    log: options.notifierLog,
    isDeviceConnected: (deviceId) => hub.isDeviceConnected(deviceId),
  });
  // Same targeting rule a 1:1 turn gets: a device holding a live socket saw the room's frame and is
  // excluded here rather than pushed to twice.
  raisePush = (event) => notifier.notify(event, hub.connectedDeviceIds());
  raiseApprovalPush = (payload) => notifier.notifyApproval(payload, hub.connectedDeviceIds());
  raiseChatMessagePush = createChatMessagePushHandler(notifier, () => hub.connectedDeviceIds());
  if (bridge !== undefined && attachV1Ingress !== undefined && nativeBotEntries.length > 0) {
    nativeBotPlane = new NativeBotDataPlane({
      control: bridge,
      storage,
      ingress: attachV1Ingress,
      nativeBots: nativeBotEntries.filter(([, item]) => (item.mode ?? "native") === "native").map(([bot]) => bot),
      shadowBots: nativeBotEntries.filter(([, item]) => item.mode === "shadow").map(([bot]) => bot),
      broadcast: (frame) => hub.broadcast(frame),
      onChatMessage: (event) => raiseChatMessagePush(event),
      onApproval: (event) => {
        raiseApprovalPush(
          event.outcome === undefined
            ? { kind: "approval_pending", threadId: `bot:${event.bot}`, agentId: event.bot, turnId: event.turnId, toolCallId: event.toolCallId, name: event.name ?? "tool" }
            : { kind: "approval_resolved", threadId: `bot:${event.bot}`, agentId: event.bot, turnId: event.turnId, toolCallId: event.toolCallId, outcome: event.outcome },
        );
      },
      now: () => Date.now(),
    });
    botsSurface = nativeBotPlane.surface();
  }
  nativeSink = new AttachNativeSink({
    storage,
    broadcast: (frame) => hub.broadcast(frame),
    notifier,
    connectedDeviceIds: () => hub.connectedDeviceIds(),
    now: () => Date.now(),
  });
  if (attachV1Ingress !== undefined) {
    for (const agent of attachAgents) attachV1Ingress.replayUnapplied(agent.id);
    for (const [bot] of nativeBotEntries) attachV1Ingress.replayUnapplied(bot.trim().toLowerCase());
  }
  const runner = new TurnRunner({
    storage,
    hub,
    adapters,
    notifier,
    now: () => Date.now(),
    turnTimeoutMs: config.turnTimeoutSeconds * 1000,
    ...(options.approvalLog === undefined ? {} : { approvalLog: options.approvalLog }),
  });

  const app = createApp({
    storage,
    config,
    gatewayInfo,
    ...(botsSurface === undefined ? {} : { bots: botsSurface }),
    ...(attachTokens === undefined ? {} : { attachTokens }),
    ...(attachTokens === undefined ? {} : { attachMediaAllowed: (agentId: string) => allowedAttachMedia(config, agentId) }),
    presenceOf: (agentId) => adapters.get(agentId)?.presence() ?? "unknown",
    submitUserMessage: (threadId, blocks) => runner.submitUserMessage(threadId, blocks),
    // The runner's "unsupported" outcome collapses to "interrupting" here: a turn WAS in
    // flight, so REST answers 202, and the runner has already emitted the interrupt_unsupported
    // error frame over the WebSocket.
    interruptThread: (threadId) => (runner.interrupt(threadId) === "idle" ? "idle" : "interrupting"),
    resolveApproval: (input) =>
      runner.resolveApproval(input.threadId, input.toolCallId, input.decision, input.deviceId),
    onDeviceRevoked: (deviceId) => hub.closeDevice(deviceId),
    now: () => Date.now(),
  });

  const server = await new Promise<Server>((resolve) => {
    // The TLS branch swaps only the factory and its options; the fetch handler, the port, the
    // hostname, and the upgrade dispatcher below are identical either way. https.Server extends
    // http.Server, so everything downstream (including the 'upgrade' listener that carries /ws and
    // /attach, which therefore become wss automatically) is unchanged.
    const s = serve(
      {
        fetch: app.fetch,
        port: config.port,
        hostname: config.host ?? "127.0.0.1",
        ...(tls === undefined
          ? {}
          : { createServer: createHttpsServer, serverOptions: { cert: tls.cert, key: tls.key } }),
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
  if (attachIngress !== undefined) {
    routes.set("/attach", (req, socket, head) => attachIngress.handleUpgrade(req, socket, head));
    routes.set("/attach/v1", (req, socket, head) => attachV1Ingress!.handleUpgrade(req, socket, head));
  }
  server.on("upgrade", createUpgradeDispatcher(routes));
  // Started after the listener is up so the first roster refresh cannot race the hub it
  // broadcasts through.
  bridge?.start();
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : config.port;

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
      const durableAttachShutdown = attachV1Ingress !== undefined && [...attachAgents.map((agent) => agent.id), ...nativeBotEntries.map(([bot]) => bot.trim().toLowerCase())].some((agentId) => attachV1Ingress!.hasNegotiated(agentId));
      hub.close();
      // Closing attach sockets fires the disconnect path, which fails in-flight turns, so the
      // runner's per-thread chains settle before closeAll drains them.
      attachIngress?.close();
      attachV1Ingress?.close();
      // Same ordering for openclaw: close every dial-out client (cancels any pending reconnect
      // timer and fails in-flight turns) before the HTTP server stops and the runner drains.
      await Promise.all([...openclawClients.values()].map((client) => client.close()));
      // The bots bridge holds a dial-out socket and its own timers; closing it cancels both.
      await bridge?.close();
      nativeBotPlane?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (durableAttachShutdown) runner.abandonAll();
      else await runner.closeAll();
      storage.close();
    },
  };
}

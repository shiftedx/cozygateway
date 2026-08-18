import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import { BOTS_CAPABILITY_ID, BOTS_CAPABILITY_VERSION, type GatewayInfo } from "cozygateway-contract";

import type { GatewayConfig } from "./config.ts";
import { openStorage, type Storage } from "./storage.ts";
import { buildAdapters } from "./adapters/registry.ts";
import { AttachIngress } from "./adapters/attach/ingress.ts";
import { AttachRouter, collectAttachTokens } from "./adapters/attach/adapter.ts";
import type { OpenClawClient } from "./adapters/openclaw/client.ts";
import { parseOpenClawOptions } from "./adapters/openclaw/config.ts";
import { createApp } from "./http.ts";
import { WsHub } from "./ws-hub.ts";
import { TurnRunner } from "./turns.ts";
import { RelayNotifier } from "./push-notifier.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";
import { createUpgradeDispatcher, type UpgradeHandler } from "./upgrade-dispatcher.ts";
import { createHermesClient } from "./hermes-bridge/client.ts";
import { parseHermesOptions } from "./hermes-bridge/config.ts";
import { HermesBridge } from "./hermes-bridge/bridge.ts";

export const GATEWAY_VERSION = "0.1.0";

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
}

export async function startGateway(
  config: GatewayConfig,
  options: StartGatewayOptions = {},
): Promise<RunningGateway> {
  const storage = openStorage(config.dbPath);
  for (const agent of config.agents) {
    storage.upsertAgent({ id: agent.id, name: agent.name, avatar: agent.avatar ?? null, backend: agent.backend });
  }
  // capabilities is always present, empty when unconfigured, so the shape is uniform across
  // /health, the pair response, and the ready frame (contract v1.md section 5). Absence is a
  // valid wire shape too (older gateways), but this implementation always advertises the field.
  //
  // The bots bridge advertises itself the sanctioned way: a vendor capability id, versioned
  // independently of the frozen contract literal. The wire value is the integer version the
  // capabilities map is typed for (contract/v1.md section 5); the design's "{ v: 1 }" shorthand
  // means exactly this version 1. Only advertised when a hermes bridge is actually configured.
  const hermesOptions = config.hermes === undefined ? undefined : parseHermesOptions(config.hermes, process.env);
  const gatewayInfo: GatewayInfo = {
    name: config.name,
    version: GATEWAY_VERSION,
    contract: "v1",
    capabilities: {
      ...(config.capabilities ?? {}),
      ...(hermesOptions === undefined ? {} : { [BOTS_CAPABILITY_ID]: BOTS_CAPABILITY_VERSION }),
    },
  };
  const hub = new WsHub({ storage, gatewayInfo, now: () => Date.now() });

  // Dial-out JSON-RPC client to the Hermes gateway plus the cache/refresh/focus machinery on top
  // of it. Credential resolution already happened above, before the port is bound, so a
  // misconfigured bridge fails startup instead of half-starting.
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
      hiddenProfiles: hermesOptions.hiddenProfiles,
    });
  }

  // The attach ingress exists only when an attach agent is configured. Token resolution fails
  // closed BEFORE the listener opens, so a misconfigured gateway never half-starts.
  const attachAgents = config.agents.filter((a) => a.backend === "attach");
  const router = new AttachRouter();
  let attachIngress: AttachIngress | undefined;
  if (attachAgents.length > 0) {
    const tokens = collectAttachTokens(config.agents, process.env);
    attachIngress = new AttachIngress({
      tokens,
      events: {
        onUpdate: (agentId, threadId, update) => router.onUpdate(agentId, threadId, update),
        onDisconnect: (agentId) => router.onDisconnect(agentId),
        onPresence: (agentId, state) => hub.broadcast({ type: "presence", agentId, state }),
      },
    });
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
    attachIngress === undefined
      ? undefined
      : {
          endpoint: attachIngress,
          env: process.env,
          register: (agentId, adapter) => router.register(agentId, adapter),
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
  const runner = new TurnRunner({
    storage,
    hub,
    adapters,
    notifier: new RelayNotifier({
      storage,
      log: options.notifierLog,
      isDeviceConnected: (deviceId) => hub.isDeviceConnected(deviceId),
    }),
    now: () => Date.now(),
    turnTimeoutMs: config.turnTimeoutSeconds * 1000,
  });

  const app = createApp({
    storage,
    config,
    gatewayInfo,
    ...(bridge === undefined ? {} : { bots: bridge }),
    presenceOf: (agentId) => adapters.get(agentId)?.presence() ?? "unknown",
    submitUserMessage: (threadId, blocks) => runner.submitUserMessage(threadId, blocks),
    // The runner's "unsupported" outcome collapses to "interrupting" here: a turn WAS in
    // flight, so REST answers 202, and the runner has already emitted the interrupt_unsupported
    // error frame over the WebSocket.
    interruptThread: (threadId) => (runner.interrupt(threadId) === "idle" ? "idle" : "interrupting"),
    onDeviceRevoked: (deviceId) => hub.closeDevice(deviceId),
    now: () => Date.now(),
  });

  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: config.host ?? "127.0.0.1" }, () => {
      resolve(s as Server);
    });
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
  }
  server.on("upgrade", createUpgradeDispatcher(routes));
  // Started after the listener is up so the first roster refresh cannot race the hub it
  // broadcasts through.
  bridge?.start();
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : config.port;

  return {
    url: `http://${config.host ?? "127.0.0.1"}:${port}`,
    port,
    storage,
    issueSetupCode: () => {
      const code = newSetupCode();
      storage.createSetupCode(code, Date.now() + SETUP_CODE_TTL_MS);
      return code;
    },
    close: async () => {
      hub.close();
      // Closing attach sockets fires the disconnect path, which fails in-flight turns, so the
      // runner's per-thread chains settle before closeAll drains them.
      attachIngress?.close();
      // Same ordering for openclaw: close every dial-out client (cancels any pending reconnect
      // timer and fails in-flight turns) before the HTTP server stops and the runner drains.
      await Promise.all([...openclawClients.values()].map((client) => client.close()));
      // The bots bridge holds a dial-out socket and its own timers; closing it cancels both.
      await bridge?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await runner.closeAll();
      storage.close();
    },
  };
}

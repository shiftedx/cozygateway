import type { IncomingMessage, Server } from "node:http";
import { EventEmitter } from "node:events";

import { serve } from "@hono/node-server";
import type { GatewayInfo } from "cozygateway-contract";

import type { GatewayConfig } from "./config.ts";
import { openStorage, type Storage } from "./storage.ts";
import { buildAdapters } from "./adapters/registry.ts";
import { AttachIngress } from "./adapters/attach/ingress.ts";
import { AttachRouter, collectAttachTokens } from "./adapters/attach/adapter.ts";
import { createApp } from "./http.ts";
import { WsHub } from "./ws-hub.ts";
import { TurnRunner } from "./turns.ts";
import { RelayNotifier } from "./push-notifier.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";

export const GATEWAY_VERSION = "0.1.0";

/** ws attaches its own 'upgrade' listener per WebSocketServer instance constructed with
 *  {server, path}. With two such instances on ONE real http.Server, Node still invokes BOTH
 *  listeners for every upgrade request; the non-matching one's default path check fails and it
 *  aborts the handshake by writing to (and destroying) the socket the OTHER instance already
 *  claimed, corrupting that connection. This facade forwards 'upgrade' only for its own path, so
 *  the hub's and the attach ingress's WebSocketServer instances never see each other's
 *  connections. See the ws README, "Multiple servers sharing a single HTTP/S server". */
function upgradeOnlyFor(server: Server, path: string): Server {
  const facade = new EventEmitter();
  server.on("listening", (...args: unknown[]) => facade.emit("listening", ...args));
  server.on("error", (...args: unknown[]) => facade.emit("error", ...args));
  server.on("upgrade", (req: IncomingMessage, socket: unknown, head: unknown) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname === path) facade.emit("upgrade", req, socket, head);
  });
  return facade as unknown as Server;
}

export interface RunningGateway {
  url: string;
  port: number;
  storage: Storage;
  issueSetupCode(): string;
  close(): Promise<void>;
}

export async function startGateway(config: GatewayConfig): Promise<RunningGateway> {
  const storage = openStorage(config.dbPath);
  for (const agent of config.agents) {
    storage.upsertAgent({ id: agent.id, name: agent.name, avatar: agent.avatar ?? null, backend: agent.backend });
  }
  const gatewayInfo: GatewayInfo = { name: config.name, version: GATEWAY_VERSION, contract: "v1" };
  const hub = new WsHub({ storage, gatewayInfo, now: () => Date.now() });

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

  const adapters = buildAdapters(
    config.agents,
    attachIngress === undefined
      ? undefined
      : {
          endpoint: attachIngress,
          env: process.env,
          register: (agentId, adapter) => router.register(agentId, adapter),
        },
  );
  const runner = new TurnRunner({
    storage,
    hub,
    adapters,
    notifier: new RelayNotifier({ storage }),
    now: () => Date.now(),
  });

  const app = createApp({
    storage,
    config,
    gatewayInfo,
    presenceOf: (agentId) => adapters.get(agentId)?.presence() ?? "unknown",
    submitUserMessage: (threadId, blocks) => runner.submitUserMessage(threadId, blocks),
    onDeviceRevoked: (deviceId) => hub.closeDevice(deviceId),
    now: () => Date.now(),
  });

  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, () => {
      resolve(s as Server);
    });
  });
  hub.attach(upgradeOnlyFor(server, "/ws"));
  attachIngress?.attach(upgradeOnlyFor(server, "/attach"));
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : config.port;

  return {
    url: `http://127.0.0.1:${port}`,
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
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await runner.closeAll();
      storage.close();
    },
  };
}

import type { Server } from "node:http";

import { serve } from "@hono/node-server";
import type { GatewayInfo } from "cozygateway-contract";

import type { GatewayConfig } from "./config.ts";
import { openStorage, type Storage } from "./storage.ts";
import { buildAdapters } from "./adapters/registry.ts";
import { createApp } from "./http.ts";
import { WsHub } from "./ws-hub.ts";
import { TurnRunner, nullNotifier } from "./turns.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";

export const GATEWAY_VERSION = "0.1.0";

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
  const adapters = buildAdapters(config.agents);
  const gatewayInfo: GatewayInfo = { name: config.name, version: GATEWAY_VERSION, contract: "v1" };
  const hub = new WsHub({ storage, gatewayInfo, now: () => Date.now() });
  const runner = new TurnRunner({ storage, hub, adapters, notifier: nullNotifier, now: () => Date.now() });

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
  hub.attach(server);
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
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await runner.closeAll();
      storage.close();
    },
  };
}

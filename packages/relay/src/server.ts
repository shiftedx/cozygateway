import type { Server } from "node:http";

import { serve } from "@hono/node-server";

import { createRelayApp } from "./http.ts";
import { openRelayStorage, type RelayStorage } from "./storage.ts";
import { webhookTransport } from "./transports.ts";

export const RELAY_VERSION = "0.1.0";
export const DEFAULT_DAILY_CAP = 500;

export interface RelayConfig {
  port: number;
  host: string;
  dbPath: string;
  dailyCap: number;
}

export interface RunningRelay {
  url: string;
  port: number;
  storage: RelayStorage;
  close(): Promise<void>;
}

export async function startRelay(config: RelayConfig): Promise<RunningRelay> {
  const storage = openRelayStorage(config.dbPath);
  const app = createRelayApp({
    storage,
    transports: { webhook: webhookTransport() },
    dailyCap: config.dailyCap,
    version: RELAY_VERSION,
    now: () => Date.now(),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
      resolve(s as Server);
    });
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : config.port;
  let closed = false;
  return {
    url: `http://${config.host}:${port}`,
    port,
    storage,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      } finally {
        storage.close();
      }
    },
  };
}

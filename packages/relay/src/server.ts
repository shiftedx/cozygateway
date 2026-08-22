import type { Server } from "node:http";

import { serve } from "@hono/node-server";

import { apnsTransport, type ApnsConfig } from "./apns.ts";
import { createRelayApp } from "./http.ts";
import { openRelayStorage, type RelayStorage } from "./storage.ts";
import { webhookTransport } from "./transports.ts";

export const RELAY_VERSION = "0.1.0";
export const DEFAULT_DAILY_CAP = 500;
/** Generous for a self-host, finite against an unauthenticated registration flood ahead
 *  of the auth-hook slot landing (design decision, issue #9). */
export const DEFAULT_MAX_REGISTRATIONS = 10000;

export interface RelayConfig {
  port: number;
  host: string;
  dbPath: string;
  dailyCap: number;
  /** Total-row cap on `registrations` (design decision, issue #9). */
  maxRegistrations: number;
  /** TTL in days for relay registrations, from created_at (issue #28). Defaults to
   *  DEFAULT_REGISTRATION_TTL_DAYS when omitted. */
  registrationTtlDays?: number;
  /** Restrict webhook egress to public addresses (design decision, issue #8). See
   *  `parseCliConfig` in `cli.ts` for how the CLI derives this default from `host`. */
  restrictEgress: boolean;
  /** Honor the rightmost X-Forwarded-For hop. Enable only behind a trusted proxy. */
  trustForwarded?: boolean;
  /** When set, the relay serves the "apns" platform; unset means webhook-only. */
  apns?: ApnsConfig;
}

export interface RunningRelay {
  url: string;
  port: number;
  storage: RelayStorage;
  close(): Promise<void>;
}

export async function startRelay(config: RelayConfig): Promise<RunningRelay> {
  const storage = openRelayStorage(config.dbPath);
  const transports: Record<string, ReturnType<typeof webhookTransport> | undefined> = {
    webhook: webhookTransport({ restrictEgress: config.restrictEgress }),
  };
  if (config.apns !== undefined) {
    // Keep the configured environment as the legacy default for clients that predate explicit
    // APNs routing, while allowing one public relay to serve development and production tokens.
    transports.apns = apnsTransport(config.apns);
    transports["apns:development"] = apnsTransport({ ...config.apns, environment: "development" });
    transports["apns:production"] = apnsTransport({ ...config.apns, environment: "production" });
  }
  const app = createRelayApp({
    storage,
    transports,
    dailyCap: config.dailyCap,
    maxRegistrations: config.maxRegistrations,
    registrationTtlDays: config.registrationTtlDays,
    version: RELAY_VERSION,
    now: () => Date.now(),
    restrictEgress: config.restrictEgress,
    trustForwarded: config.trustForwarded,
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

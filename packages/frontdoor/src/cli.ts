#!/usr/bin/env node

import { startFrontdoor, type FrontdoorConfig } from "./server.ts";

export function parseFrontdoorConfig(env: Record<string, string | undefined>): FrontdoorConfig {
  const pool = (env.FRONTDOOR_POOL ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (pool.length === 0) throw new Error("FRONTDOOR_POOL is required (comma-separated relay hostnames)");
  const api = (env.FRONTDOOR_API_HOSTNAMES ?? "relay.cozylabs.ai").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    port: Number(env.FRONTDOOR_PORT ?? 8790),
    host: env.FRONTDOOR_HOST ?? "0.0.0.0",
    dbPath: env.FRONTDOOR_DB ?? "/data/frontdoor.db",
    pool,
    apiHostnames: api,
    maxHouseholds: Number(env.FRONTDOOR_MAX_HOUSEHOLDS ?? 500),
    provisionsPerHourPerIp: Number(env.FRONTDOOR_PROVISIONS_PER_HOUR ?? 5),
  };
}

const invokedDirectly = process.argv[1]?.endsWith("cli.js") ?? false;
if (invokedDirectly) {
  const fd = await startFrontdoor(parseFrontdoorConfig(process.env));
  console.log(`cozy-frontdoor listening on ${fd.url}`);
}

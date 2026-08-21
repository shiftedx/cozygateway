import { Hono } from "hono";

import { errorBody } from "./schemas.ts";
import type { FrontdoorStorage } from "./storage.ts";

export interface ProvisionAppOptions {
  storage: FrontdoorStorage;
  now: () => number;
  maxHouseholds: number;
  provisionsPerHourPerIp: number;
}

const HOUR_MS = 60 * 60 * 1000;

export function createProvisionApp(opts: ProvisionAppOptions): Hono {
  const app = new Hono();
  // per-ip sliding hour window; in-memory is fine, the front door is a single process
  const recent = new Map<string, number[]>();

  const clientIp = (headers: Headers): string =>
    headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

  app.get("/healthz", (c) => c.json({ ok: true, households: opts.storage.householdCount() }));

  app.post("/provision", (c) => {
    const ip = clientIp(c.req.raw.headers);
    const now = opts.now();
    const stamps = (recent.get(ip) ?? []).filter((t) => now - t < HOUR_MS);
    if (stamps.length >= opts.provisionsPerHourPerIp) {
      recent.set(ip, stamps);
      return c.json(errorBody("rate_limited", "Too many provision requests from this address. Try again later."), 429);
    }
    if (opts.storage.householdCount() >= opts.maxHouseholds) {
      return c.json(errorBody("over_cap", "The pilot household cap has been reached."), 503);
    }
    const grant = opts.storage.provisionHousehold(now);
    if (grant === undefined) {
      return c.json(errorBody("pool_exhausted", "No relay hostnames are free right now."), 503);
    }
    stamps.push(now);
    recent.set(ip, stamps);
    console.log(`frontdoor: provisioned ${grant.householdId} -> ${grant.hostname}`);
    return c.json({ ...grant, protocol: "frontdoor-v0" as const });
  });

  return app;
}

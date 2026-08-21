import { Hono } from "hono";

import { errorBody } from "./schemas.ts";
import type { FrontdoorStorage } from "./storage.ts";

export interface ProvisionAppOptions {
  storage: FrontdoorStorage;
  now: () => number;
  maxHouseholds: number;
  provisionsPerHourPerIp: number;
  disconnectHousehold?: (householdId: string) => void;
}

const HOUR_MS = 60 * 60 * 1000;

export function createProvisionApp(opts: ProvisionAppOptions): Hono {
  const app = new Hono();
  // per-ip sliding hour window; in-memory is fine, the front door is a single process
  const recent = new Map<string, number[]>();

  const clientIp = (headers: Headers): string =>
    headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

  const currentHousehold = (headers: Headers): string | undefined => {
    const authorization = headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return undefined;
    return opts.storage.householdIdForCredential(authorization.slice(7));
  };

  const warnIfNearExhaustion = (): void => {
    const total = opts.storage.hostnamePoolCount();
    const free = opts.storage.freeHostnameCount();
    if (total > 0 && free <= Math.max(1, Math.ceil(total * 0.1))) {
      console.warn(`frontdoor: WARNING hostname pool near exhaustion, ${free}/${total} hostnames remain free`);
    }
  };

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
    warnIfNearExhaustion();
    console.log(`frontdoor: provisioned ${grant.householdId} -> ${grant.hostname}`);
    return c.json({ ...grant, protocol: "frontdoor-v0" as const });
  });

  app.post("/rotate", (c) => {
    const householdId = currentHousehold(c.req.raw.headers);
    if (householdId === undefined) return c.json(errorBody("unauthorized", "A current bearer credential is required."), 401);
    const credential = opts.storage.rotateCredential(householdId);
    if (credential === undefined) return c.json(errorBody("not_found", "The household no longer exists."), 404);
    opts.disconnectHousehold?.(householdId);
    return c.json({ credential, protocol: "frontdoor-v0" as const });
  });

  app.post("/deprovision", (c) => {
    const householdId = currentHousehold(c.req.raw.headers);
    if (householdId === undefined) return c.json(errorBody("unauthorized", "A current bearer credential is required."), 401);
    if (!opts.storage.deprovisionHousehold(householdId)) {
      return c.json(errorBody("not_found", "The household no longer exists."), 404);
    }
    opts.disconnectHousehold?.(householdId);
    return c.json({ ok: true });
  });

  return app;
}

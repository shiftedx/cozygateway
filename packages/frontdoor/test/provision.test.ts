import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProvisionApp } from "../src/provision.ts";
import { openFrontdoorStorage, type FrontdoorStorage } from "../src/storage.ts";

let dir: string;
let storage: FrontdoorStorage;

afterEach(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });

function app(pool: string[], opts?: { maxHouseholds?: number; perHour?: number; now?: () => number }) {
  dir = mkdtempSync(join(tmpdir(), "fd-prov-"));
  storage = openFrontdoorStorage(join(dir, "db.sqlite"));
  storage.syncPool(pool);
  return createProvisionApp({
    storage,
    now: opts?.now ?? (() => 1_000_000),
    maxHouseholds: opts?.maxHouseholds ?? 500,
    provisionsPerHourPerIp: opts?.perHour ?? 5,
  });
}

function provision(a: ReturnType<typeof app>, ip = "1.2.3.4") {
  return a.request("/provision", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: "{}",
  });
}

describe("POST /provision", () => {
  it("returns a full grant", async () => {
    const res = await provision(app(["relay-01.cozylabs.ai"]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.householdId).toMatch(/^hh_/);
    expect(body.credential).toMatch(/^fdc_/);
    expect(body.hostname).toBe("relay-01.cozylabs.ai");
    expect(body.protocol).toBe("frontdoor-v0");
  });

  it("503 pool_exhausted when the pool is empty", async () => {
    const a = app(["relay-01.cozylabs.ai"]);
    await provision(a);
    const res = await provision(a, "5.6.7.8");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("pool_exhausted");
  });

  it("rate limits per ip per hour", async () => {
    let t = 0;
    const a = app(
      ["relay-01.cozylabs.ai", "relay-02.cozylabs.ai", "relay-03.cozylabs.ai"],
      { perHour: 2, now: () => t },
    );
    expect((await provision(a)).status).toBe(200);
    expect((await provision(a)).status).toBe(200);
    expect((await provision(a)).status).toBe(429);
    t = 61 * 60 * 1000; // window rolls over
    expect((await provision(a)).status).toBe(200);
  });

  it("503 over_cap at the global household cap", async () => {
    const a = app(["relay-01.cozylabs.ai", "relay-02.cozylabs.ai"], { maxHouseholds: 1 });
    await provision(a);
    const res = await provision(a, "5.6.7.8");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("over_cap");
  });

  it("healthz reports household count", async () => {
    const a = app(["relay-01.cozylabs.ai"]);
    await provision(a);
    const res = await a.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, households: 1 });
  });

  it("rotates and deprovisions with the current bearer credential", async () => {
    const a = app(["relay-01.cozylabs.ai", "relay-02.cozylabs.ai"]);
    const first = await (await provision(a)).json() as { householdId: string; credential: string; hostname: string };
    const rotatedResponse = await a.request("/rotate", {
      method: "POST", headers: { authorization: `Bearer ${first.credential}` },
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as { credential: string };
    expect((await a.request("/rotate", {
      method: "POST", headers: { authorization: `Bearer ${first.credential}` },
    })).status).toBe(401);
    expect((await a.request("/deprovision", {
      method: "POST", headers: { authorization: `Bearer ${rotated.credential}` },
    })).status).toBe(200);
    const reused = await (await provision(a, "5.6.7.8")).json() as { hostname: string };
    expect(reused.hostname).toBe(first.hostname);
  });

  it("warns loudly when the free pool is nearly exhausted", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await provision(app(["relay-01.cozylabs.ai"]));
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("hostname pool near exhaustion"));
    } finally {
      warning.mockRestore();
    }
  });
});

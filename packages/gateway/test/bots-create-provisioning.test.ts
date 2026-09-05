import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge, type ProfileChangeEvent } from "../src/hermes-bridge/bridge.ts";
import {
  startFakeHermesServer,
  type FakeHermesBehavior,
  type FakeHermesServer,
} from "./support/fake-hermes-server.ts";

/** A phone-created Hermes profile is born `setup_required`: it is not in the config attach map,
 *  and on a native install the only thing that can put it there is the installer's provisioning
 *  run. The bridge hands every profile lifecycle change to `onProfileChange` so the server can
 *  start that run without anyone at a terminal. The hook fires exactly once per successful
 *  create/delete, after the roster already reflects the change, and never for a refused one. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
});

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Seen {
  event: ProfileChangeEvent;
  /** Roster names the bridge's storage held at the moment the hook fired. */
  rosterAtCall: string[];
}

async function setup(opts: {
  hookThrows?: boolean;
  /** First N dashboard requests fail with the transient 429 the real create saw. */
  dashboardFailures?: number;
  deleteFails?: boolean;
  /** Holds the successful retry's dashboard read so shutdown can race an in-flight seed. */
  dashboardRetryGate?: () => Promise<void>;
  dashboardShouldFail?: (
    request: Parameters<NonNullable<FakeHermesBehavior["dashboard"]>>[0],
  ) => boolean | Promise<boolean>;
  seedRetryBaseMs?: number;
  dbPath?: string;
  now?: () => number;
} = {}) {
  const names = new Set<string>(["default"]);
  const seen: Seen[] = [];
  const logs: string[] = [];
  let dashboardFailures = opts.dashboardFailures ?? 0;
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({
        profiles: [...names].map((name) => ({ name, description: "", has_avatar: false })),
        bot_mode_protocol: true,
      }),
      "profiles.create": (params) => {
        const name = String(params["name"]);
        if (names.has(name)) throw { code: 4062, message: `Profile '${name}' already exists` };
        names.add(name);
        return {};
      },
      "profiles.configure": () => ({ applied: { ui_meta: true } }),
      "profiles.describe": () => ({ name: "x", toolsets: [], skills: [] }),
    },
    dashboard: async (request) => {
      if (await opts.dashboardShouldFail?.(request))
        return { status: 429, body: { detail: "too many login attempts" } };
      if (dashboardFailures > 0) {
        dashboardFailures -= 1;
        return { status: 429, body: { detail: "too many login attempts" } };
      }
      if (request.method === "GET") await opts.dashboardRetryGate?.();
      const match = /^\/api\/profiles\/([^/]+)$/.exec(request.path);
      if (request.method === "DELETE" && match !== null) {
        if (opts.deleteFails === true) return { status: 500, body: { detail: "dashboard unavailable" } };
        const name = decodeURIComponent(match[1]!);
        if (!names.has(name)) return { status: 404, body: { detail: `Profile '${name}' does not exist.` } };
        names.delete(name);
        return { body: { ok: true } };
      }
      return { body: request.method === "GET" ? {} : { ok: true } };
    },
  });
  servers.push(server);
  const storage = openStorage(opts.dbPath ?? ":memory:");
  storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: () => {},
    now: opts.now ?? (() => 1_800_000_000_000),
    logSink: (line) => logs.push(line),
    ...(opts.seedRetryBaseMs === undefined ? {} : { seedRetryBaseMs: opts.seedRetryBaseMs }),
    onProfileChange: (event) => {
      seen.push({ event, rosterAtCall: storage.botRoster().bots.map((bot) => bot.name) });
      if (opts.hookThrows === true) throw new Error("provisioner exploded");
    },
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 37 } },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("unused");
    },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
  const pairRes = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await pairRes.json()) as { deviceToken: string };
  const authed = async (path: string, init?: RequestInit): Promise<Response> =>
    app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
    });

  bridge.start();
  await until(() => client.state() === "online");
  return { authed, seen, logs, storage, bridge, server };
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("profile lifecycle hands the change to the provisioner", () => {
  it("fires once with `created` after a Hermes create, once the roster already names the bot", async () => {
    const { authed, seen } = await setup();

    const res = await authed("/bots", post({ name: "night-owl" }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { bot: { syncState: string } }).bot.syncState).toBe("setup_required");

    expect(seen.map((s) => s.event)).toEqual([{ profile: "night-owl", change: "created" }]);
    expect(seen[0]?.rosterAtCall).toContain("night-owl");
  });

  it("fires nothing for a create Hermes refused", async () => {
    const { authed, seen } = await setup();
    expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
    seen.splice(0);

    const res = await authed("/bots", post({ name: "night-owl" }));
    expect(res.status).toBe(409);
    expect(seen).toEqual([]);
  });

  it("fires once with `deleted` after a Hermes delete, once the roster no longer names the bot", async () => {
    const { authed, seen } = await setup();
    expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
    seen.splice(0);

    const res = await authed("/bots/night-owl", { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(seen.map((s) => s.event)).toEqual([{ profile: "night-owl", change: "deleted" }]);
    expect(seen[0]?.rosterAtCall).not.toContain("night-owl");
  });

  it("fires nothing for a delete of a bot that does not exist anywhere", async () => {
    const { authed, seen } = await setup();

    const res = await authed("/bots/ghost", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("a hook that throws never fails the request that fired it", async () => {
    const { authed, seen, logs } = await setup({ hookThrows: true });

    const res = await authed("/bots", post({ name: "night-owl" }));
    expect(res.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(logs.some((line) => line.includes("provisioner exploded"))).toBe(true);
  });

  it("persists a transient 429 seed, resumes it after bridge restart, then provisions once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cozygateway-pending-hermes-seed-"));
    const dbPath = join(dir, "gateway.sqlite");
    try {
      const first = await setup({ dashboardFailures: 1, seedRetryBaseMs: 10, dbPath });
      const res = await first.authed("/bots", post({ name: "night-owl", toolsets: ["file"] }));
      expect(res.status).toBe(201);
      expect(((await res.json()) as { warnings: string[] }).warnings[0]).toContain("retry automatically");
      expect(first.seen).toEqual([]);
      expect(first.storage.pendingHermesProfileSeeds()).toEqual([
        expect.objectContaining({ profile: "night-owl", selection: { toolsets: ["file"] }, attempts: 1 }),
      ]);

      // A restart creates a new bridge over the same durable row.  No create callback happened
      // before it, so the installer sees one successful lifecycle event, not a create plus retry.
      await first.bridge.close();
      bridges.splice(bridges.indexOf(first.bridge), 1);
      first.storage.close();
      storages.splice(storages.indexOf(first.storage), 1);
      const resumedStorage = openStorage(dbPath);
      storages.push(resumedStorage);
      const resumedSeen: ProfileChangeEvent[] = [];
      const client = createHermesClient({
        url: first.server.url,
        auth: { mode: "token", token: "T" },
        reconnect: { minMs: 15, maxMs: 60 },
      });
      const resumed = new HermesBridge({
        client,
        storage: resumedStorage,
        broadcast: () => {},
        now: () => 1_800_000_000_000,
        seedRetryBaseMs: 10,
        onProfileChange: (event) => resumedSeen.push(event),
      });
      bridges.push(resumed);
      resumed.start();
      await until(() => client.state() === "online");
      await until(() => resumedSeen.length === 1);
      expect(resumedSeen).toEqual([{ profile: "night-owl", change: "created" }]);
      expect(resumedStorage.pendingHermesProfileSeeds()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels a deferred seed before deletion so it cannot provision a removed profile", async () => {
    const { authed, seen, storage } = await setup({ dashboardFailures: 1, seedRetryBaseMs: 20 });
    expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
    expect(storage.pendingHermesProfileSeeds()).toHaveLength(1);

    expect((await authed("/bots/night-owl", { method: "DELETE" })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(storage.pendingHermesProfileSeeds()).toEqual([]);
    expect(seen).toEqual([{ event: { profile: "night-owl", change: "deleted" }, rosterAtCall: ["default"] }]);
  });

  it("keeps deferred seed recovery when Hermes refuses deletion", async () => {
    const { authed, storage } = await setup({
      dashboardFailures: 1,
      deleteFails: true,
      seedRetryBaseMs: 200,
    });
    expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
    const before = storage.pendingHermesProfileSeeds();
    expect(before).toHaveLength(1);

    expect((await authed("/bots/night-owl", { method: "DELETE" })).status).toBe(503);
    expect(storage.pendingHermesProfileSeeds()).toEqual(before);
  });

  it("leaves an in-flight deferred seed durable when the bridge and storage close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cozygateway-pending-hermes-close-"));
    const dbPath = join(dir, "gateway.sqlite");
    let releaseGate: (() => void) | undefined;
    let retryStarted = false;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    try {
      const first = await setup({
        dashboardFailures: 1,
        seedRetryBaseMs: 5,
        dbPath,
        dashboardRetryGate: async () => {
          retryStarted = true;
          await gate;
        },
      });
      expect((await first.authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
      await until(() => retryStarted);

      await first.bridge.close();
      bridges.splice(bridges.indexOf(first.bridge), 1);
      first.storage.close();
      storages.splice(storages.indexOf(first.storage), 1);
      releaseGate?.();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const reopened = openStorage(dbPath);
      expect(reopened.pendingHermesProfileSeeds()).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not arm the same durable retry again while its attempt is in flight", async () => {
    let releaseRetry: (() => void) | undefined;
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
    let nightOwlReads = 0;
    let retryStarted = false;
    const { authed, storage } = await setup({
      seedRetryBaseMs: 250,
      now: Date.now,
      dashboardShouldFail: async (request) => {
        if (request.method !== "GET") return false;
        const profile = request.query.get("profile");
        if (profile === "night-owl") {
          nightOwlReads += 1;
          if (nightOwlReads === 2) {
            retryStarted = true;
            await retryGate;
          }
          return nightOwlReads <= 2;
        }
        return profile === "second-bot";
      },
    });

    expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
    await until(() => retryStarted);

    // This second deferred create calls the scheduler while night-owl's due row is still present.
    // It must not enqueue night-owl again behind the attempt already holding that profile's chain.
    expect((await authed("/bots", post({ name: "second-bot" }))).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseRetry?.();

    await until(() => nightOwlReads >= 3 || storage.pendingHermesProfileSeeds()
      .some((row) => row.profile === "night-owl" && row.attempts === 2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(nightOwlReads).toBe(2);
    expect(storage.pendingHermesProfileSeeds()).toContainEqual(
      expect.objectContaining({ profile: "night-owl", attempts: 2 }),
    );
  });
});

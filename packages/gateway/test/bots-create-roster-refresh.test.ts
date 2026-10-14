import { afterEach, expect, it } from "vitest";
import type { BotSummary, ServerFrame } from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** A create the Hermes host ACCEPTED must never come back as 404. The roster refresh that follows
 *  `profiles.create` rides `profiles.list`, and under a Dashboard stall that call times out (seen
 *  live 2026-09-04: "profiles.list timed out after 30000ms"). `refresh` swallows the failure by
 *  design, so the cache still lacks the row; the create used to look it up, miss, and answer
 *  `404 not_found` for a bot that exists. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};
const NOW = 1_800_000_000_000;

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

async function setup() {
  const names = new Set<string>(["default"]);
  let listFails = false;
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => {
        if (listFails) throw { code: 5061, message: "profiles.list stalled" };
        return {
          profiles: [...names].map((name) => ({ name, description: `about ${name}`, has_avatar: false })),
          bot_mode_protocol: true,
        };
      },
      "profiles.create": (params) => {
        names.add(String(params["name"]));
        return {};
      },
      "profiles.configure": () => ({ applied: { ui_meta: true } }),
      "profiles.describe": () => ({ name: "x", toolsets: [], skills: [] }),
    },
    dashboard: (request) => ({ body: request.method === "GET" ? {} : { ok: true } }),
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "T" }, reconnect: { minMs: 15, maxMs: 60 } });
  const frames: ServerFrame[] = [];
  const logs: string[] = [];
  const bridge = new HermesBridge({
    client, storage, broadcast: (frame) => frames.push(frame), now: () => NOW, logSink: (line) => logs.push(line),
  });
  bridges.push(bridge);
  const app = createApp({
    storage, config, bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 43 } },
    presenceOf: () => "online",
    submitUserMessage: () => { throw new Error("unused"); },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
  const pair = await app.request("/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: code, deviceName: "phone" }) });
  const { deviceToken } = (await pair.json()) as { deviceToken: string };
  const authed = (path: string, init?: RequestInit) =>
    app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } });
  bridge.start();
  await until(() => client.state() === "online");
  await until(() => storage.botRoster().bots.length === 1);
  return { authed, bridge, storage, frames, logs, failList: (fail: boolean) => { listFails = fail; } };
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

it("answers 201 with the new row when the post-create roster refresh fails", async () => {
  const { authed, storage, frames, logs, failList } = await setup();
  failList(true);

  const res = await authed("/bots", post({ name: "night-owl", description: "  keeps watch ", title: "Night Owl" }));
  expect(res.status).toBe(201);
  const { bot } = (await res.json()) as { bot: BotSummary };
  expect(bot.name).toBe("night-owl");
  expect(bot.displayName).toBe("Night Owl");
  expect(bot.description).toBe("keeps watch");
  expect(bot.syncState).toBe("setup_required");
  expect(bot.chatSessionId).toBeNull();
  expect(logs.some((line) => line.includes("roster refresh failed"))).toBe(true);

  // The stale cache was patched rather than left pre-create: a roster read right now shows the bot.
  expect(storage.botRoster().bots.map((row) => row.name)).toEqual(["default", "night-owl"]);
  const list = await authed("/bots");
  expect(((await list.json()) as { bots: BotSummary[] }).bots.map((row) => row.name)).toContain("night-owl");
  const roster = frames.filter((frame) => frame.type === "bot_roster").at(-1);
  expect(roster && roster.type === "bot_roster" ? roster.bots.map((row) => row.name) : []).toContain("night-owl");
});

it("replaces the interim row with Hermes' own once profiles.list answers again", async () => {
  const { authed, storage, failList, bridge } = await setup();
  failList(true);
  expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
  failList(false);
  await bridge.refresh("test");
  const row = storage.botRoster().bots.find((bot) => bot.name === "night-owl");
  expect(row?.description).toBe("about night-owl");
});

it("still answers 404 when the profile is hidden from this gateway's roster", async () => {
  // A hidden name is a real absence the client should hear about, not a refresh failure.
  const { authed, failList } = await setup();
  failList(false);
  const res = await authed("/bots", post({ name: "default" }));
  expect(res.status).not.toBe(201);
});

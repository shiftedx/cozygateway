import { afterEach, describe, expect, it } from "vitest";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge, type ProfileChangeEvent } from "../src/hermes-bridge/bridge.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

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

async function setup(opts: { hookThrows?: boolean } = {}) {
  const names = new Set<string>(["default"]);
  const seen: Seen[] = [];
  const logs: string[] = [];
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
    dashboard: (request) => {
      const match = /^\/api\/profiles\/([^/]+)$/.exec(request.path);
      if (request.method === "DELETE" && match !== null) {
        const name = decodeURIComponent(match[1]!);
        if (!names.has(name)) return { status: 404, body: { detail: `Profile '${name}' does not exist.` } };
        names.delete(name);
        return { body: { ok: true } };
      }
      return { body: request.method === "GET" ? {} : { ok: true } };
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
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
    now: () => 1_800_000_000_000,
    logSink: (line) => logs.push(line),
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
  return { authed, seen, logs };
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
});

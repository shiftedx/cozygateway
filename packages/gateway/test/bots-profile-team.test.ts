import { afterEach, describe, expect, it } from "vitest";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { AssignmentRooms } from "../src/hermes-bridge/assignments.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 88. Role and reports are the gateway's, not Hermes's: they are merged into the
 *  profile read, and a patch carrying them forwards only the Hermes fields. */

const config: GatewayConfig = {
  name: "g", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};
const describeResult = {
  name: "scout", description: "watches CI", soul: "# Scout\n", model: { provider: "nous", default: "hermes-4" },
  skills: [], toolsets: [], toolsets_pinned: false, mcp_servers: [],
};

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const rooms: AssignmentRooms[] = [];
const storages: Storage[] = [];
afterEach(async () => {
  for (const room of rooms.splice(0)) room.close();
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
});

async function setup() {
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({ profiles: [{ name: "scout", description: "", has_avatar: false }, { name: "sage", description: "", has_avatar: false }], bot_mode_protocol: true }),
      "profiles.describe": () => describeResult,
      "profiles.configure": () => ({ applied: { soul: true } }),
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "T" }, reconnect: { minMs: 15, maxMs: 60 } });
  const bridge = new HermesBridge({ client, storage, broadcast: () => {}, now: () => 1_000, logSink: () => {}, hiddenProfiles: [] });
  bridges.push(bridge);
  const assignments = new AssignmentRooms({
    storage, broadcast: () => {}, now: () => 1_000, displayName: (name) => name,
    knownBot: (name) => ["scout", "sage"].includes(name), isAttached: () => true,
  });
  rooms.push(assignments);
  const app = createApp({
    storage, config, bots: bridge, assignments,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: {} },
    presenceOf: () => "online", submitUserMessage: () => { throw new Error("unused"); },
    interruptThread: () => "idle", resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {}, now: () => 1_000,
  });
  storage.createSetupCode("team-pair", 10_000);
  const paired = await app.request("/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: "team-pair", deviceName: "phone" }) });
  const { deviceToken } = await paired.json() as { deviceToken: string };
  bridge.start();
  for (const start = Date.now(); client.state() !== "online";) {
    if (Date.now() - start > 4_000) throw new Error("hermes client never came online");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const authed = (path: string, init?: RequestInit) => app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } });
  return { server, storage, authed };
}

const patch = (body: unknown): RequestInit => ({ method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("team fields on the bot profile", () => {
  it("stores role and reports on the gateway, touches no peer, and merges them into the read", async () => {
    const h = await setup();
    const res = await h.authed("/bots/scout/profile", patch({ role: "leader", reports: ["sage"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "scout", outcome: "applied", ok: true, applied: { team: true }, requested: ["role", "reports"] });
    expect(h.server.callsOf("profiles.configure")).toHaveLength(0);
    expect(await (await h.authed("/bots/scout/profile")).json()).toMatchObject({ soul: "# Scout\n", role: "leader", reports: ["sage"] });
    await h.authed("/bots/scout/profile", patch({ role: "member" }));
    const read = await (await h.authed("/bots/scout/profile")).json() as Record<string, unknown>;
    expect(read["role"]).toBe("member");
    expect(read).not.toHaveProperty("reports");
  });

  it("refuses reports on a member, an unknown bot, and the bot itself, and writes nothing", async () => {
    const h = await setup();
    expect((await h.authed("/bots/scout/profile", patch({ reports: ["sage"] }))).status).toBe(400);
    expect((await h.authed("/bots/scout/profile", patch({ role: "leader", reports: ["nobody"] }))).status).toBe(400);
    expect((await h.authed("/bots/scout/profile", patch({ role: "leader", reports: ["scout"], soul: "# x" }))).status).toBe(400);
    expect((await h.authed("/bots/ghost/profile", patch({ role: "leader" }))).status).toBe(400);
    expect(h.storage.botTeam("scout")).toBeUndefined();
    expect(h.server.callsOf("profiles.configure")).toHaveLength(0);
  });

  it("a mixed patch forwards only the Hermes fields and reports both halves", async () => {
    const h = await setup();
    const res = await h.authed("/bots/scout/profile", patch({ role: "leader", reports: ["sage"], soul: "# Scout" }));
    expect(await res.json()).toMatchObject({ ok: true, applied: { soul: true, team: true }, requested: ["soul", "role", "reports"] });
    const call = h.server.callsOf("profiles.configure").at(-1)!;
    expect(JSON.stringify(call.params)).not.toMatch(/reports|role|leader/);
    expect(h.storage.botTeam("scout")).toMatchObject({ role: "leader", reports: ["sage"] });
  });
});

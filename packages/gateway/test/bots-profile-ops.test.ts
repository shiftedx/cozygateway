import { afterEach, describe, expect, it } from "vitest";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { ProfileArchiveTooLarge, multipartArchiveStream } from "../src/hermes-bridge/profile-ops.ts";
import {
  startFakeHermesServer,
  type FakeHermesBehavior,
  type FakeHermesServer,
} from "./support/fake-hermes-server.ts";

/** Capability 82, profile operations (contract/ext-bots-v1.md row 82), against the fake Hermes so
 *  what goes on the wire is asserted on the wire: the RPC params and the dashboard requests. */

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

interface Row {
  name: string;
  description?: string;
  is_default?: boolean;
  path?: string;
  ui_meta?: Record<string, unknown>;
  ui_meta_revisions?: Record<string, number>;
  has_avatar?: boolean;
  previous_names?: string[];
}

interface DashboardRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

async function setup(opts: {
  rows?: Row[];
  methods?: FakeHermesBehavior["methods"];
  dashboard?: (request: DashboardRequest) => { status?: number; body: unknown } | undefined;
  /** Seeds durable state before the bridge starts (its first roster refresh reads it). */
  seed?: (storage: Storage) => void;
} = {}) {
  const rows: Row[] = opts.rows ?? [
    { name: "default", is_default: true, path: "/home/h/.hermes" },
    {
      name: "scout",
      description: "watches CI",
      path: "/home/h/.hermes/profiles/scout",
      ui_meta: { "hermes-bots": { title: "Scout", color: "honey" }, other: { keep: true } },
      ui_meta_revisions: { "hermes-bots": 3, other: 1 },
      has_avatar: true,
    },
  ];
  const dashboardCalls: DashboardRequest[] = [];
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({ profiles: rows, bot_mode_protocol: true }),
      "profiles.create": (params) => {
        rows.push({ name: String(params["name"]), description: String(params["description"] ?? ""), path: `/p/${String(params["name"])}` });
        return { ok: true, name: params["name"] };
      },
      "profiles.configure": () => ({ ok: true, applied: { ui_meta: true, description: true } }),
      "profiles.describe": () => ({ skills: [], toolsets: [] }),
      ...(opts.methods ?? {}),
    },
    dashboard: (request) => {
      dashboardCalls.push(request);
      const custom = opts.dashboard?.(request);
      if (custom !== undefined) return custom;
      if (request.path === "/api/config") return { body: { config: {} } };
      return { status: 404, body: { detail: "Not Found" } };
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  opts.seed?.(storage);
  const frames: Array<Record<string, unknown>> = [];
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => { frames.push(frame as unknown as Record<string, unknown>); },
    now: () => 1_800_000_000_000,
    logSink: () => {},
    hiddenProfiles: [],
    seedRetryBaseMs: 20,
  });
  bridges.push(bridge);
  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 82 } },
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
    app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } });
  bridge.start();
  await until(() => client.state() === "online");
  return { server, rows, dashboardCalls, authed, storage, bridge, frames };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("capability 82: identity", () => {
  it("merges the title into hermes-bots only, re-reading once on a revision conflict", async () => {
    let configures = 0;
    const h = await setup({
      methods: {
        "profiles.configure": (params) => {
          if (params["ui_meta"] !== undefined) {
            configures += 1;
            // The first write lost a race with another device: Hermes names the conflict.
            if (configures === 1) return { ok: false, applied: { ui_meta: false, ui_meta_conflicts: { "hermes-bots": { expected: 3, actual: 4 } } } };
          }
          return { ok: true, applied: { ui_meta: true, description: true } };
        },
      },
    });
    const res = await h.authed("/bots/scout/identity", json("PATCH", { title: "Scout Prime", description: " watches deploys " }));
    expect(res.status).toBe(200);
    const writes = h.server.callsOf("profiles.configure").filter((call) => call.params["ui_meta"] !== undefined);
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      // Only the one key, with the rest of the look intact, and never the `other` key.
      expect(write.params["ui_meta"]).toEqual({ "hermes-bots": { title: "Scout Prime", color: "honey" } });
      expect(write.params["ui_meta_expected_revisions"]).toEqual({ "hermes-bots": 3 });
    }
    const description = h.server.callsOf("profiles.configure").find((call) => call.params["description"] !== undefined);
    expect(description?.params).toEqual({ name: "scout", description: "watches deploys" });
  });

  it("an empty title clears the field rather than storing a blank", async () => {
    const h = await setup();
    expect((await h.authed("/bots/scout/identity", json("PATCH", { title: "" }))).status).toBe(200);
    const write = h.server.callsOf("profiles.configure").find((call) => call.params["ui_meta"] !== undefined);
    // Cleared the way the desktop clears it, through row 80's writer.
    expect(write?.params["ui_meta"]).toEqual({ "hermes-bots": { title: null, color: "honey" } });
  });

  it("refuses an empty patch", async () => {
    const h = await setup();
    expect((await h.authed("/bots/scout/identity", json("PATCH", {}))).status).toBe(400);
  });
});

describe("capability 82: rename and describe-auto", () => {
  it("renames through the dashboard and answers the new roster row", async () => {
    const h = await setup({
      dashboard: (request) => {
        if (request.method === "PATCH" && request.path === "/api/profiles/scout") {
          const row = h.rows.find((r) => r.name === "scout");
          if (row !== undefined) row.name = String((request.body as Record<string, unknown>)["new_name"]);
          return { body: { ok: true, name: "lookout", path: "/p/lookout" } };
        }
        return undefined;
      },
    });
    const res = await h.authed("/bots/scout/rename", json("POST", { newName: "lookout" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bot: { name: string } };
    expect(body.bot.name).toBe("lookout");
    expect(h.dashboardCalls.find((call) => call.method === "PATCH")?.body).toEqual({ new_name: "lookout" });
  });

  it("a taken name is a 409 conflict carrying Hermes' own sentence", async () => {
    const h = await setup({
      dashboard: (request) => request.method === "PATCH"
        ? { status: 400, body: { detail: "Profile 'default' already exists" } }
        : undefined,
    });
    const res = await h.authed("/bots/scout/rename", json("POST", { newName: "taken" }));
    expect(res.status).toBe(409);
  });

  it("refuses an invalid new name before Hermes is asked", async () => {
    const h = await setup();
    expect((await h.authed("/bots/scout/rename", json("POST", { newName: "Bad Name!" }))).status).toBe(400);
    expect(h.dashboardCalls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("passes describe-auto's inline refusal through as ok false", async () => {
    const h = await setup({
      dashboard: (request) => request.path === "/api/profiles/scout/describe-auto"
        ? { body: { ok: false, reason: "no auxiliary model", description: "", description_auto: false } }
        : undefined,
    });
    const res = await h.authed("/bots/scout/describe-auto", json("POST", { overwrite: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "no auxiliary model" });
    expect(h.dashboardCalls.find((call) => call.path.endsWith("describe-auto"))?.body).toEqual({ overwrite: true });
  });
});

describe("rename carries rooms, the Bot Chat binding and routines", () => {
  const seedRoom = (storage: Storage): void => {
    storage.createBotGroup({ key: "crew", name: "Crew", members: ["scout", "default"], createdAt: 1 });
    storage.setBotGroupWatermark("crew", "scout", 7);
    storage.setBotGroupMeta("crew", {
      holds: { scout: { at: 5 } },
      held: { scout: [3] },
      marks: { t1: { scout: 4, default: 2 } },
    });
    storage.setCanonicalBotChat("scout", "hermes-bot-chat-1", 10);
    storage.setBotRoutineOverrides("scout", "job-1", { model: "m1" });
  };

  it("a bot renamed through the gateway stays in its rooms and keeps its Bot Chat", async () => {
    const puts: DashboardRequest[] = [];
    const h = await setup({
      seed: seedRoom,
      methods: {
        "cron.manage": () => ({
          success: true,
          jobs: [
            { job_id: "job-1", name: "[bot:scout] Morning", enabled: true },
            { job_id: "job-2", name: "[bot:other] Theirs", enabled: true },
          ],
        }),
      },
      dashboard: (request) => {
        if (request.method === "PATCH" && request.path === "/api/profiles/scout") {
          const row = h.rows.find((r) => r.name === "scout");
          // No previous_names here, so the re-link defense cannot be what moves the state.
          if (row !== undefined) row.name = "lookout";
          return { body: { ok: true, name: "lookout", path: "/p/lookout" } };
        }
        if (request.path === "/api/cron/jobs/job-1" && request.method === "GET") {
          return { body: { id: "job-1", prompt: "[bot-mode:routine:v2] You are running the scheduled routine \"Morning\" for agent 'scout'. x -q '[Scheduled routine] Say hi'\n\nIf the command fails, report the error instead." } };
        }
        if (request.method === "PUT") {
          puts.push(request);
          return { body: { ok: true } };
        }
        return undefined;
      },
    });
    h.frames.length = 0;
    const res = await h.authed("/bots/scout/rename", json("POST", { newName: "lookout" }));
    expect(res.status).toBe(200);

    // The room still lists the bot, under its new name, with its per-member state.
    expect(h.bridge.groups().find((room) => room.name === "Crew")?.members).toEqual(["lookout", "default"]);
    const room = h.storage.botGroup("crew")!;
    expect(room.meta.holds).toEqual({ lookout: { at: 5 } });
    expect(room.meta.held).toEqual({ lookout: [3] });
    expect(room.meta.marks).toEqual({ t1: { lookout: 4, default: 2 } });
    const members = h.storage.botGroupMembers("crew");
    expect(members.get("lookout")?.watermark).toBe(7);
    expect(members.get("lookout")?.sessionId).toBe("group:crew:scout");
    expect(members.has("scout")).toBe(false);

    // The Bot Chat binding and routine overrides moved; nothing is left under the old name.
    expect(h.storage.canonicalBotChat("lookout")).toBe("hermes-bot-chat-1");
    expect(h.storage.canonicalBotChat("scout")).toBeUndefined();
    expect(h.storage.botRoutineOverrides("lookout", "job-1")).toEqual({ model: "m1" });
    expect(h.storage.botRoutineOverrides("scout", "job-1")).toBeUndefined();

    // Only this bot's routine is retagged, and its delegation names the new profile.
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe("/api/cron/jobs/job-1");
    expect(puts[0]?.query.get("profile")).toBe("lookout");
    const updates = (puts[0]?.body as { updates: Record<string, string> }).updates;
    expect(updates["name"]).toBe("[bot:lookout] Morning");
    expect(updates["prompt"]).toContain("hermes -p 'lookout'");
    expect(updates["prompt"]).toContain("Say hi");

    // Clients hear about the room and the roster.
    const roomFrame = h.frames.find((frame) => frame["type"] === "bot_group_state");
    expect((roomFrame?.["room"] as { members: string[] } | undefined)?.members).toEqual(["lookout", "default"]);
    const roster = h.frames.filter((frame) => frame["type"] === "bot_roster").at(-1);
    expect((roster?.["bots"] as Array<{ name: string }>).map((bot) => bot.name)).toContain("lookout");
  });

  it("re-links a member renamed outside the gateway through previous_names", async () => {
    const h = await setup({
      rows: [
        { name: "default", is_default: true, path: "/home/h/.hermes" },
        { name: "lookout", path: "/home/h/.hermes/profiles/lookout", previous_names: ["scout"] },
      ],
      seed: (storage) => {
        seedRoom(storage);
        // Nobody claims `ghost`, so it stays a missing member.
        storage.createBotGroup({ key: "haunt", name: "Haunt", members: ["ghost", "default"], createdAt: 2 });
      },
    });
    await until(() => h.storage.botGroup("crew")?.members.includes("lookout") === true);
    expect(h.storage.botGroup("crew")?.members).toEqual(["lookout", "default"]);
    expect(h.storage.botGroupMembers("crew").get("lookout")?.watermark).toBe(7);
    expect(h.storage.canonicalBotChat("lookout")).toBe("hermes-bot-chat-1");
    expect(h.storage.canonicalBotChat("scout")).toBeUndefined();
    expect(h.storage.botGroup("haunt")?.members).toEqual(["ghost", "default"]);
    expect(h.frames.some((frame) => frame["type"] === "bot_group_state"
      && (frame["room"] as { members: string[] } | undefined)?.members.includes("lookout") === true)).toBe(true);
  });

  it("refuses to rename a bot whose room turn is still pending", async () => {
    const h = await setup({
      seed: (storage) => {
        seedRoom(storage);
        storage.beginBotGroupTurn({
          key: "crew", turnId: "turn-1", member: "scout", agentId: "scout", threadId: "group:crew:scout",
          messageId: "m-1", epoch: 1, watermark: 0, createdAt: 1,
        });
      },
    });
    const res = await h.authed("/bots/scout/rename", json("POST", { newName: "lookout" }));
    expect(res.status).toBe(409);
    expect(h.dashboardCalls.some((call) => call.method === "PATCH")).toBe(false);
    expect(h.storage.botGroup("crew")?.members).toEqual(["scout", "default"]);
  });
});

describe("capability 82: duplicate and create options", () => {
  it("clones the whole profile, then copies the look (title marked a copy) and the avatar", async () => {
    const h = await setup({
      methods: {
        "profiles.get_asset": () => ({ found: true, mime: "image/png", data: "data:image/png;base64,AAAA" }),
        "profiles.set_asset": () => ({ ok: true }),
      },
    });
    const res = await h.authed("/bots/scout/duplicate", json("POST", {}));
    expect(res.status).toBe(201);
    const create = h.server.callsOf("profiles.create")[0];
    expect(create?.params).toMatchObject({ name: "scout-2", clone_from: "scout", clone_all: true, share_auth: true });
    const look = h.server.callsOf("profiles.configure")
      .filter((call) => call.params["name"] === "scout-2" && call.params["ui_meta"] !== undefined)
      .at(-1);
    expect(look?.params["ui_meta"]).toMatchObject({ "hermes-bots": { title: "Scout (copy)", color: "honey" } });
    expect(h.server.callsOf("profiles.set_asset")[0]?.params).toEqual({ name: "scout-2", asset: "avatar", data: "data:image/png;base64,AAAA" });
  });

  it("POST /bots carries clone, empty and share-keys choices to profiles.create", async () => {
    const h = await setup();
    expect((await h.authed("/bots", json("POST", { name: "blank", noSkills: true, shareKeys: false }))).status).toBe(201);
    expect(h.server.callsOf("profiles.create")[0]?.params).toEqual({
      name: "blank", description: "", share_auth: false, mirror_credentials: false, no_skills: true,
    });
    expect((await h.authed("/bots", json("POST", { name: "twin", cloneFrom: "scout" }))).status).toBe(201);
    expect(h.server.callsOf("profiles.create")[1]?.params).toEqual({
      name: "twin", description: "", share_auth: true, clone_from: "scout",
    });
  });

  it("answers 400, not 500, when Hermes refuses the clone source", async () => {
    const h = await setup({
      methods: {
        "profiles.create": () => {
          throw { code: 4062, message: "Source profile 'ghost' does not exist." };
        },
      },
    });
    const res = await h.authed("/bots", json("POST", { name: "twin", cloneFrom: "ghost" }));
    expect(res.status).toBe(400);
  });

  it("reserves `current`, which Hermes resolves to the launch profile", async () => {
    const h = await setup();
    expect((await h.authed("/bots", json("POST", { name: "Current" }))).status).toBe(400);
    expect((await h.authed("/bots/scout/rename", json("POST", { newName: "current" }))).status).toBe(400);
    expect((await h.authed("/bots/scout/duplicate", json("POST", { newName: "CURRENT" }))).status).toBe(400);
    expect((await h.authed("/bots/import?name=current", { method: "POST", body: new Uint8Array([1]) })).status).toBe(400);
    expect((await h.authed("/bots/current/provider-keys")).status).toBe(400);
    expect((await h.authed("/bots/current/skills-hub?q=pdf")).status).toBe(400);
    expect(h.server.callsOf("profiles.create")).toHaveLength(0);
    expect(h.dashboardCalls.some((call) => call.path === "/api/env" || call.path.startsWith("/api/skills"))).toBe(false);
  });

  it("a deferred seed for a clone keeps its skills when it is retried", async () => {
    let failSeed = true;
    const h = await setup({
      dashboard: (request) => {
        if (request.path !== "/api/config") return undefined;
        if (failSeed) return { status: 503, body: { detail: "busy" } };
        return { body: { config: {} } };
      },
    });
    expect((await h.authed("/bots", json("POST", { name: "twin", cloneFrom: "scout" }))).status).toBe(201);
    expect(h.storage.pendingHermesProfileSeeds().find((row) => row.profile === "twin")?.blankSlate).toBe(false);
    expect((await h.authed("/bots", json("POST", { name: "fresh" }))).status).toBe(201);
    expect(h.storage.pendingHermesProfileSeeds().find((row) => row.profile === "fresh")?.blankSlate).toBeUndefined();
    failSeed = false;
    const described = h.server.callsOf("profiles.describe").length;
    await until(() => h.storage.pendingHermesProfileSeeds().length === 0, 20_000);
    // The blank slate reads the skill catalog to switch skills off; the clone's retry must not.
    const describes = h.server.callsOf("profiles.describe").slice(described).map((call) => call.params["name"]);
    expect(describes).not.toContain("twin");
    expect(describes).toContain("fresh");
  }, 30_000);

  it("a create with none of the new fields is byte identical to a pre-82 create", async () => {
    const h = await setup();
    expect((await h.authed("/bots", json("POST", { name: "plain" }))).status).toBe(201);
    expect(h.server.callsOf("profiles.create")[0]?.params).toEqual({ name: "plain", description: "", share_auth: true });
  });
});

describe("capability 82: export and import", () => {
  it("streams the archive's bytes and removes the staged copy from the host", async () => {
    const archive = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]);
    const h = await setup({
      dashboard: (request) => {
        if (request.path === "/api/profiles/scout/export") return { body: { ok: true, archive: "/home/h/.hermes/profile-exports/scout-1.tar.gz" } };
        if (request.path === "/api/files/download") return { body: archive };
        if (request.method === "DELETE" && request.path === "/api/files") return { body: { ok: true } };
        return undefined;
      },
    });
    const res = await h.authed("/bots/scout/export", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toContain("scout-1.tar.gz");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(archive);
    expect(h.dashboardCalls.find((call) => call.path === "/api/files/download")?.query.get("path"))
      .toBe("/home/h/.hermes/profile-exports/scout-1.tar.gz");
    await until(() => h.dashboardCalls.some((call) => call.method === "DELETE"));
    expect(h.dashboardCalls.find((call) => call.method === "DELETE")?.body)
      .toEqual({ path: "/home/h/.hermes/profile-exports/scout-1.tar.gz" });
  });

  /** A fake Hermes that stages an upload-stream and imports it, recording what arrived. */
  function importingHermes(state: { staged: string; bytes: Buffer }, rows: () => Row[]) {
    return (request: DashboardRequest): { status?: number; body: unknown } | undefined => {
      if (request.path === "/api/files/upload-stream") {
        const raw = request.body as Buffer;
        const text = raw.toString("latin1");
        state.staged = /name="path"\r\n\r\n([^\r]+)\r\n/.exec(text)?.[1] ?? "";
        const start = text.indexOf("\r\n\r\n", text.indexOf('name="file"')) + 4;
        const end = text.lastIndexOf("\r\n--");
        state.bytes = raw.subarray(start, end);
        return { body: { ok: true } };
      }
      if (request.path === "/api/profiles/import") {
        const body = request.body as Record<string, unknown>;
        rows().push({ name: String(body["name"]), path: "/p/imported" });
        return { body: { ok: true, name: body["name"], path: "/p/imported", desktop: null } };
      }
      if (request.method === "DELETE" && request.path === "/api/files") return { body: { ok: true } };
      return undefined;
    };
  }

  it("streams the upload beside Hermes' own exports, imports it, and cleans up", async () => {
    const archive = new Uint8Array([0x1f, 0x8b, 8, 0, 9, 9]);
    const state = { staged: "", bytes: Buffer.alloc(0) };
    const h = await setup({ dashboard: (request) => importingHermes(state, () => h.rows)(request) });
    const res = await h.authed("/bots/import?name=imported", {
      method: "POST",
      headers: { "content-type": "application/gzip" },
      body: archive,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { bot: { name: string } }).bot.name).toBe("imported");
    expect(state.staged).toMatch(/^\/home\/h\/\.hermes\/profile-exports\/cozy-import-[a-z0-9]+\.tar\.gz$/);
    expect(new Uint8Array(state.bytes)).toEqual(archive);
    expect(h.dashboardCalls.find((call) => call.path === "/api/profiles/import")?.body).toEqual({ archive: state.staged, name: "imported" });
    expect(h.dashboardCalls.find((call) => call.method === "DELETE")?.body).toEqual({ path: state.staged });
  });

  it("takes a chunked body with no declared length, streamed through", async () => {
    const chunks = [new Uint8Array([0x1f, 0x8b]), new Uint8Array([8, 0]), new Uint8Array([7, 7, 7])];
    const state = { staged: "", bytes: Buffer.alloc(0) };
    const h = await setup({ dashboard: (request) => importingHermes(state, () => h.rows)(request) });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await h.authed("/bots/import?name=chunked", {
      method: "POST",
      headers: { "content-type": "application/gzip" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(201);
    expect(new Uint8Array(state.bytes)).toEqual(new Uint8Array([0x1f, 0x8b, 8, 0, 7, 7, 7]));
  });

  it("refuses a declared length over 100 MiB before any byte moves, and maps Hermes' own 413", async () => {
    const h = await setup({
      dashboard: (request) => request.path === "/api/files/upload-stream"
        ? { status: 413, body: { detail: "File is too large" } }
        : request.method === "DELETE" ? { body: { ok: true } } : undefined,
    });
    const declared = await h.authed("/bots/import?name=huge", {
      method: "POST",
      headers: { "content-type": "application/gzip", "content-length": String(101 * 1024 * 1024) },
      body: new Uint8Array([1]),
    });
    expect(declared.status).toBe(413);
    expect(h.dashboardCalls.some((call) => call.path === "/api/files/upload-stream")).toBe(false);
    const upstream = await h.authed("/bots/import?name=huge", { method: "POST", body: new Uint8Array([1, 2]) });
    expect(upstream.status).toBe(413);
  });

  it("counts streamed bytes and cuts a body off at the bound, whatever it declared", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i += 1) controller.enqueue(new Uint8Array(10));
        controller.close();
      },
    });
    const { body } = multipartArchiveStream(source, "/x.tar.gz", "b", 25);
    const reader = body.getReader();
    await expect((async () => { for (;;) { if ((await reader.read()).done) return; } })())
      .rejects.toBeInstanceOf(ProfileArchiveTooLarge);
  });

  it("requires a name for an import", async () => {
    const h = await setup();
    expect((await h.authed("/bots/import", { method: "POST", body: new Uint8Array([1]) })).status).toBe(400);
  });
});

describe("capability 82: model pin, provider keys, skills hub", () => {
  it("answers the expensive-model handshake without writing, then pins on confirmation", async () => {
    const h = await setup({
      methods: {
        "profiles.configure": (params) => params["confirm_expensive_model"] === true
          ? { ok: true, applied: { model: true } }
          : { ok: true, applied: {}, confirm_required: true, confirm_message: "opus costs $$$" },
      },
    });
    const first = await h.authed("/bots/scout/model-pin", json("PUT", { model: "opus", provider: "anthropic" }));
    expect(await first.json()).toEqual({ pinned: false, confirmRequired: true, confirmMessage: "opus costs $$$" });
    const second = await h.authed("/bots/scout/model-pin", json("PUT", { model: "opus", provider: "anthropic", confirmExpensiveModel: true }));
    expect(await second.json()).toEqual({ pinned: true, model: { provider: "anthropic", model: "opus" } });
    expect(h.server.callsOf("profiles.configure").map((call) => call.params)).toEqual([
      { name: "scout", model: "opus", provider: "anthropic" },
      { name: "scout", model: "opus", provider: "anthropic", confirm_expensive_model: true },
    ]);
  });

  it("reads the pin from profiles.describe, where an empty model is no pin", async () => {
    let described = { provider: "nous", default: "hermes-4" };
    const h = await setup({ methods: { "profiles.describe": () => ({ model: described, skills: [], toolsets: [] }) } });
    expect(await (await h.authed("/bots/scout/model-pin")).json()).toEqual({ pinned: true, model: { provider: "nous", model: "hermes-4" } });
    described = { provider: "", default: "" };
    expect(await (await h.authed("/bots/scout/model-pin")).json()).toEqual({ pinned: false });
  });

  it("unpins by unsetting the profile's model key", async () => {
    const h = await setup({ methods: { "cli.exec": () => ({ blocked: false, code: 0, output: "ok" }) } });
    const res = await h.authed("/bots/scout/model-pin", { method: "DELETE" });
    expect(await res.json()).toEqual({ pinned: false });
    expect(h.server.callsOf("cli.exec")[0]?.params["argv"]).toEqual(["--profile", "scout", "config", "unset", "model"]);
  });

  it("keeps provider keys on the bot's own profile through /api/env, write-only", async () => {
    const env: Record<string, { provider: string; provider_label: string; is_password: boolean; is_set: boolean }> = {
      OPENROUTER_API_KEY: { provider: "openrouter", provider_label: "OpenRouter", is_password: true, is_set: false },
      OPENROUTER_BASE_URL: { provider: "openrouter", provider_label: "OpenRouter", is_password: false, is_set: false },
      GOOGLE_API_KEY: { provider: "gemini", provider_label: "Google AI Studio", is_password: true, is_set: true },
      GEMINI_API_KEY: { provider: "gemini", provider_label: "Google AI Studio", is_password: true, is_set: true },
      SOME_TOOL_KEY: { provider: "", provider_label: "", is_password: true, is_set: true },
    };
    const h = await setup({
      dashboard: (request) => {
        if (request.path !== "/api/env") return undefined;
        const body = request.body as Record<string, string> | undefined;
        if (request.method === "PUT") env[body!["key"]!]!.is_set = true;
        if (request.method === "DELETE") env[body!["key"]!]!.is_set = false;
        return { body: request.method === "GET" ? env : { ok: true } };
      },
    });
    const listed = await (await h.authed("/bots/scout/provider-keys")).json();
    expect(listed).toEqual({ providers: [
      { slug: "openrouter", name: "OpenRouter", connected: false },
      { slug: "gemini", name: "Google AI Studio", connected: true },
    ] });
    const saved = await h.authed("/bots/scout/provider-keys/openrouter", json("PUT", { apiKey: "sk-secret" }));
    const text = await saved.text();
    expect(text).not.toContain("sk-secret");
    expect(JSON.parse(text)).toEqual({ provider: "openrouter", connected: true });
    const put = h.dashboardCalls.find((call) => call.method === "PUT");
    expect(put?.query.get("profile")).toBe("scout");
    expect(put?.body).toEqual({ key: "OPENROUTER_API_KEY", value: "sk-secret", profile: "scout" });
    // Disconnect clears every set key of that provider, and only those.
    expect(await (await h.authed("/bots/scout/provider-keys/gemini", { method: "DELETE" })).json())
      .toEqual({ provider: "gemini", connected: false });
    expect(h.dashboardCalls.filter((call) => call.method === "DELETE").map((call) => call.body)).toEqual([
      { key: "GOOGLE_API_KEY", profile: "scout" },
      { key: "GEMINI_API_KEY", profile: "scout" },
    ]);
    expect((await h.authed("/bots/scout/provider-keys/nope", json("PUT", { apiKey: "x" }))).status).toBe(400);
  });

  it("searches the hub and installs into this bot's own profile", async () => {
    const h = await setup({
      dashboard: (request) => {
        if (request.path === "/api/skills/hub/search")
          return { body: { results: [
            { name: "pdf", description: "read PDFs", identifier: "anthropics/skills/pdf" },
            { name: "pdf", description: "other", identifier: "openai/skills/pdf" },
          ], installed: { "openai/skills/pdf": "1.0" } } };
        if (request.path === "/api/skills/hub/install") return { body: { ok: true, pid: 42, name: "install-pdf" } };
        return undefined;
      },
    });
    const found = await h.authed("/bots/scout/skills-hub?q=pdf");
    expect(await found.json()).toEqual({ results: [
      { name: "pdf", description: "read PDFs", identifier: "anthropics/skills/pdf" },
      { name: "pdf", description: "other", identifier: "openai/skills/pdf", installed: true },
    ] });
    expect(h.dashboardCalls.find((call) => call.path === "/api/skills/hub/search")?.query.get("profile")).toBe("scout");
    const installed = await h.authed("/bots/scout/skills-hub/install", json("POST", { identifier: "anthropics/skills/pdf" }));
    expect(await installed.json()).toEqual({ started: true, identifier: "anthropics/skills/pdf" });
    const install = h.dashboardCalls.find((call) => call.path === "/api/skills/hub/install");
    expect(install?.body).toEqual({ identifier: "anthropics/skills/pdf", profile: "scout" });
    expect(install?.query.get("profile")).toBe("scout");
  });

  it("answers 404 for a bot Hermes does not have", async () => {
    const h = await setup();
    expect((await h.authed("/bots/ghost/model-pin", { method: "DELETE" })).status).toBe(404);
  });
});

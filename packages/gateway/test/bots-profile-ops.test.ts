import { afterEach, describe, expect, it } from "vitest";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
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
    logSink: () => {},
    hiddenProfiles: [],
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
  return { server, rows, dashboardCalls, authed };
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

  it("an empty title removes the field rather than storing a blank", async () => {
    const h = await setup();
    expect((await h.authed("/bots/scout/identity", json("PATCH", { title: "" }))).status).toBe(200);
    const write = h.server.callsOf("profiles.configure").find((call) => call.params["ui_meta"] !== undefined);
    expect(write?.params["ui_meta"]).toEqual({ "hermes-bots": { color: "honey" } });
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

  it("a create with none of the new fields is byte identical to a pre-82 create", async () => {
    const h = await setup();
    expect((await h.authed("/bots", json("POST", { name: "plain" }))).status).toBe(201);
    expect(h.server.callsOf("profiles.create")[0]?.params).toEqual({ name: "plain", description: "", share_auth: true });
  });
});

describe("capability 82: export and import", () => {
  it("answers the archive's bytes and removes the staged copy from the host", async () => {
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
    expect(h.dashboardCalls.find((call) => call.method === "DELETE")?.body)
      .toEqual({ path: "/home/h/.hermes/profile-exports/scout-1.tar.gz" });
  });

  it("stages the upload beside Hermes' own exports, imports it, and cleans up", async () => {
    const archive = new Uint8Array([0x1f, 0x8b, 8, 0, 9, 9]);
    let staged = "";
    const h = await setup({
      dashboard: (request) => {
        const body = request.body as Record<string, unknown>;
        if (request.path === "/api/files/upload") {
          staged = String(body["path"]);
          return { body: { ok: true } };
        }
        if (request.path === "/api/profiles/import") {
          h.rows.push({ name: String(body["name"]), path: "/p/imported" });
          return { body: { ok: true, name: body["name"], path: "/p/imported", desktop: null } };
        }
        if (request.method === "DELETE" && request.path === "/api/files") return { body: { ok: true } };
        return undefined;
      },
    });
    const res = await h.authed("/bots/import?name=imported", {
      method: "POST",
      headers: { "content-type": "application/gzip" },
      body: archive,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { bot: { name: string } }).bot.name).toBe("imported");
    expect(staged).toMatch(/^\/home\/h\/\.hermes\/profile-exports\/cozy-import-[a-z0-9]+\.tar\.gz$/);
    const upload = h.dashboardCalls.find((call) => call.path === "/api/files/upload")?.body as Record<string, unknown>;
    expect(upload["data_url"]).toBe(`data:application/gzip;base64,${Buffer.from(archive).toString("base64")}`);
    expect(h.dashboardCalls.find((call) => call.path === "/api/profiles/import")?.body).toEqual({ archive: staged, name: "imported" });
    expect(h.dashboardCalls.find((call) => call.method === "DELETE")?.body).toEqual({ path: staged });
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

  it("unpins by unsetting the profile's model key", async () => {
    const h = await setup({ methods: { "cli.exec": () => ({ blocked: false, code: 0, output: "ok" }) } });
    const res = await h.authed("/bots/scout/model-pin", { method: "DELETE" });
    expect(await res.json()).toEqual({ pinned: false });
    expect(h.server.callsOf("cli.exec")[0]?.params["argv"]).toEqual(["--profile", "scout", "config", "unset", "model"]);
  });

  it("saves a provider key write-only and treats an absent key as already disconnected", async () => {
    const h = await setup({
      methods: {
        "model.save_key": () => ({ provider: { slug: "openrouter", authenticated: true } }),
        "model.disconnect": () => {
          throw { code: 4005, message: "no credentials found for openrouter" };
        },
      },
    });
    const saved = await h.authed("/bots/scout/provider-keys/openrouter", json("PUT", { apiKey: "sk-secret" }));
    const text = await saved.text();
    expect(text).not.toContain("sk-secret");
    expect(JSON.parse(text)).toEqual({ provider: "openrouter", connected: true });
    expect(h.server.callsOf("model.save_key")[0]?.params).toEqual({ profile: "scout", slug: "openrouter", api_key: "sk-secret" });
    const gone = await h.authed("/bots/scout/provider-keys/openrouter", { method: "DELETE" });
    expect(await gone.json()).toEqual({ provider: "openrouter", connected: false });
  });

  it("searches the hub and installs into this bot", async () => {
    const h = await setup({
      methods: {
        "skills.manage": (params) => params["action"] === "search"
          ? { results: [{ name: "pdf-tools", description: "read PDFs" }] }
          : { installed: true, name: params["query"] },
      },
    });
    const found = await h.authed("/bots/scout/skills-hub?q=pdf");
    expect(await found.json()).toEqual({ results: [{ name: "pdf-tools", description: "read PDFs" }] });
    const installed = await h.authed("/bots/scout/skills-hub/install", json("POST", { identifier: "pdf-tools" }));
    expect(await installed.json()).toEqual({ installed: true, name: "pdf-tools" });
    expect(h.server.callsOf("skills.manage").map((call) => call.params)).toEqual([
      { profile: "scout", action: "search", query: "pdf" },
      { profile: "scout", action: "install", query: "pdf-tools" },
    ]);
  });

  it("answers 404 for a bot Hermes does not have", async () => {
    const h = await setup();
    expect((await h.authed("/bots/ghost/model-pin", { method: "DELETE" })).status).toBe(404);
  });
});

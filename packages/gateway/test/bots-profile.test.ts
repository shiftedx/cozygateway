import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { mapProfileDescribe, buildConfigurePayload, readConfigureResult } from "../src/hermes-bridge/profile.ts";
import {
  startFakeHermesServer,
  type FakeHermesBehavior,
  type FakeHermesServer,
} from "./support/fake-hermes-server.ts";

/** The edit-profile surface over the bridge (contract/ext-bots-v1.md section 4): the profile read
 *  and its three list semantics, the patch and the `applied` echo, and the edit-screen catalog.
 *  Everything runs against the fake Hermes so what goes on the wire is asserted on the wire. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  agents: [{ id: "mock", name: "Mock", backend: "mock" }],
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

interface Harness {
  server: FakeHermesServer;
  bridge: HermesBridge;
  client: HermesClient;
  storage: Storage;
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  /** The same app without the device token, for the auth checks. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

const scoutRow = {
  name: "scout",
  description: "watches CI",
  has_avatar: false,
  last_session: { last_active: Math.round(NOW / 1000) - 5, preview: "all green" },
};

const hiddenRow = { name: "ops-runner", description: "internal", has_avatar: false };

function profilesListResult(rows: Array<Record<string, unknown>> = [scoutRow, hiddenRow]): Record<string, unknown> {
  return { profiles: rows, bot_mode_protocol: true };
}

/** A `profiles.describe` reply in the exact shape upstream builds (methods_profiles.py:411). */
const describeResult = {
  name: "scout",
  description: "watches CI",
  soul: "# Scout\nWatches CI.\n",
  model: { provider: "nous", default: "hermes-4" },
  // Skills are a DISABLED list server-side: `enabled` is already resolved for us.
  skills: [
    { name: "ci-watch", enabled: true },
    { name: "deploy", enabled: false },
  ],
  // Toolsets carry the resolved pin state plus whether a pin exists at all.
  toolsets: [
    { name: "files", label: "Files", description: "read and write", tool_count: 7, enabled: true },
    { name: "shell", label: "Shell", description: "run commands", tool_count: 2, enabled: false },
  ],
  toolsets_pinned: true,
  // Only the servers the PROFILE defines; `enabled` is the inverse of the `disabled` flag.
  mcp_servers: [
    { name: "github", enabled: true, transport: "stdio" },
    { name: "linear", enabled: false, transport: "http" },
  ],
};

const catalogResult = {
  servers: [
    { name: "github", description: "issues and PRs", installed: true, enabled: true, requires: [], transport: "stdio" },
    {
      name: "slack",
      description: "messages",
      installed: false,
      enabled: true,
      requires: ["SLACK_TOKEN"],
      transport: "stdio",
    },
  ],
};

async function setup(
  behavior: FakeHermesBehavior = {},
  opts: { hiddenProfiles?: string[]; catalogTtlMs?: number; now?: () => number } = {},
): Promise<Harness> {
  const server = await startFakeHermesServer({
    ...behavior,
    methods: { "profiles.list": () => profilesListResult(), ...(behavior.methods ?? {}) },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const frames: ServerFrame[] = [];
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: opts.now ?? (() => NOW),
    logSink: () => {},
    hiddenProfiles: opts.hiddenProfiles ?? ["ops-runner"],
    ...(opts.catalogTtlMs === undefined ? {} : { catalogTtlMs: opts.catalogTtlMs }),
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 3 } },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("unused");
    },
    interruptThread: () => "idle",
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
  return {
    server,
    bridge,
    client,
    storage,
    authed,
    request: async (path: string, init?: RequestInit): Promise<Response> => app.request(path, init),
  };
}

function patch(body: unknown): RequestInit {
  return { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("mapProfileDescribe: the three list semantics", () => {
  it("reports skills from the enabled flag the disabled list resolves to", () => {
    const mapped = mapProfileDescribe(describeResult);
    expect(mapped.skills).toEqual([
      { name: "ci-watch", enabled: true },
      { name: "deploy", enabled: false },
    ]);
  });

  it("treats a skill with no enabled flag as enabled, because the server model is a DISABLED list", () => {
    const mapped = mapProfileDescribe({ skills: [{ name: "quiet" }] });
    expect(mapped.skills).toEqual([{ name: "quiet", enabled: true }]);
  });

  it("reports toolsets from the pin, and says whether a pin exists at all", () => {
    const mapped = mapProfileDescribe(describeResult);
    expect(mapped.toolsets).toEqual([
      { name: "files", enabled: true, label: "Files", description: "read and write", toolCount: 7 },
      { name: "shell", enabled: false, label: "Shell", description: "run commands", toolCount: 2 },
    ]);
    expect(mapped.toolsetsPinned).toBe(true);
    expect(mapProfileDescribe({ ...describeResult, toolsets_pinned: false }).toolsetsPinned).toBe(false);
  });

  it("unions the profile's own mcp servers with the catalog, and never borrows the catalog's enabled flag", () => {
    const mapped = mapProfileDescribe(describeResult, catalogResult);
    expect(mapped.mcpServers).toEqual([
      // Defined by the profile: installed for it whatever the catalog says, enabled from `disabled`.
      { name: "github", installed: true, enabled: true, description: "issues and PRs", transport: "stdio" },
      // Defined but disabled. Still `installed`: the profile carries its definition either way.
      { name: "linear", installed: true, enabled: false, transport: "http" },
      // Offered by the catalog and NOT defined by the profile: off for this bot, even though the
      // catalog reports `enabled: true` (that flag describes the launch profile).
      {
        name: "slack",
        installed: false,
        enabled: false,
        description: "messages",
        transport: "stdio",
        requires: ["SLACK_TOKEN"],
        fromCatalog: true,
      },
    ]);
  });

  it("passes an auth hint through when the gateway sends one, and omits it otherwise", () => {
    const withAuth = mapProfileDescribe(describeResult, {
      servers: [{ name: "notion", installed: true, auth: "oauth" }],
    });
    expect(withAuth.mcpServers.find((server) => server.name === "notion")).toEqual({
      name: "notion",
      installed: true,
      enabled: false,
      auth: "oauth",
      fromCatalog: true,
    });
    expect(mapProfileDescribe(describeResult, catalogResult).mcpServers[0]).not.toHaveProperty("auth");
  });

  it("degrades every missing field rather than failing the read", () => {
    expect(mapProfileDescribe(null)).toEqual({
      name: "",
      description: "",
      soul: "",
      skills: [],
      toolsets: [],
      toolsetsPinned: false,
      mcpServers: [],
      model: { provider: "", default: "" },
    });
  });
});

describe("GET /bots/:name/profile", () => {
  it("maps profiles.describe unioned with that profile's mcp catalog", async () => {
    const { authed, server } = await setup({
      methods: {
        "profiles.describe": () => describeResult,
        "mcp.catalog": () => catalogResult,
      },
    });
    const res = await authed("/bots/scout/profile");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["name"]).toBe("scout");
    expect(body["soul"]).toBe("# Scout\nWatches CI.\n");
    expect(body["model"]).toEqual({ provider: "nous", default: "hermes-4" });
    expect(body["toolsetsPinned"]).toBe(true);
    expect(server.callsOf("profiles.describe")[0]?.params).toEqual({ name: "scout" });
    // Scoped to the bot: an unscoped catalog would report the launch profile's install state.
    expect(server.callsOf("mcp.catalog")[0]?.params).toEqual({ profile: "scout" });
  });

  it("still answers when the gateway has no mcp.catalog, with only the profile's own servers", async () => {
    const { authed } = await setup({ methods: { "profiles.describe": () => describeResult } });
    const body = (await (await authed("/bots/scout/profile")).json()) as {
      mcpServers: Array<{ name: string }>;
    };
    expect(body.mcpServers.map((server) => server.name)).toEqual(["github", "linear"]);
  });

  it("edits a hidden bot by name, consistent with chat", async () => {
    const { authed } = await setup({
      methods: { "profiles.describe": () => ({ ...describeResult, name: "ops-runner" }) },
    });
    const res = await authed("/bots/ops-runner/profile");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("ops-runner");
  });

  it("404s a bot no profile answers to, rather than passing Hermes' 4064 through as a 502", async () => {
    const { authed, server } = await setup({
      methods: {
        "profiles.describe": () => {
          throw { code: 4064, message: "profile 'ghost' not found" };
        },
      },
    });
    const res = await authed("/bots/ghost/profile");
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "not_found" } });
    // The assert runs BEFORE the describe, so nothing was asked of Hermes about a bot that is not there.
    expect(server.callsOf("profiles.describe")).toHaveLength(0);
  });

  it("canonicalizes the path name, so one bot has one identity whatever the casing", async () => {
    const { authed, server } = await setup({ methods: { "profiles.describe": () => describeResult } });
    expect((await authed("/bots/Scout/profile")).status).toBe(200);
    expect(server.callsOf("profiles.describe")[0]?.params).toEqual({ name: "scout" });
  });

  it("passes a hermes rejection through verbatim so feature probes keep working", async () => {
    const { authed } = await setup({
      methods: {
        "profiles.describe": () => {
          throw { code: 4001, message: "unknown method: profiles.describe" };
        },
      },
    });
    const res = await authed("/bots/scout/profile");
    expect(res.status).toBe(502);
    expect((await res.json()) as { hermesError: string }).toMatchObject({
      hermesError: "unknown method: profiles.describe",
      hermesErrorCode: 4001,
    });
  });
});

describe("buildConfigurePayload", () => {
  it("sends only the fields the patch carries", () => {
    expect(buildConfigurePayload("scout", { soul: "hi" })).toEqual({
      params: { name: "scout", soul: "hi" },
      requested: ["soul"],
    });
  });

  it("keeps an empty enabledToolsets on the wire, because [] POPS the pin", () => {
    const { params } = buildConfigurePayload("scout", { enabledToolsets: [] });
    expect(params).toEqual({ name: "scout", enabled_toolsets: [] });
  });

  it("maps each field to the hermes param name, inversions included", () => {
    const { params, requested } = buildConfigurePayload("scout", {
      disabledSkills: ["deploy"],
      enabledToolsets: ["files"],
      enabledMcpServers: ["github"],
    });
    expect(params).toEqual({
      name: "scout",
      disabled_skills: ["deploy"],
      enabled_toolsets: ["files"],
      enabled_mcp_servers: ["github"],
    });
    expect(requested).toEqual(["disabledSkills", "enabledToolsets", "enabledMcpServers"]);
  });
});

describe("readConfigureResult", () => {
  it("echoes the applied map verbatim, with hermes' own key names", () => {
    const result = readConfigureResult({ ok: true, applied: { skills: true, toolsets: true } }, [
      "disabledSkills",
      "enabledToolsets",
    ]);
    expect(result).toEqual({
      outcome: "applied",
      applied: { skills: true, toolsets: true },
      ok: true,
      requested: ["disabledSkills", "enabledToolsets"],
    });
  });

  it("is not ok when a REQUESTED section is missing from the map", () => {
    const result = readConfigureResult({ applied: { skills: true } }, ["disabledSkills", "enabledToolsets"]);
    expect(result.ok).toBe(false);
  });

  it("ignores an extra section the gateway reported that nothing asked for", () => {
    const result = readConfigureResult({ applied: { skills: true, ui_meta: false } }, ["disabledSkills"]);
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual({ skills: true, ui_meta: false });
  });

  it("reads a reply with no applied object as unsupported, never as success", () => {
    expect(readConfigureResult({ ok: true }, ["soul"])).toEqual({
      outcome: "unsupported",
      applied: {},
      ok: false,
      requested: ["soul"],
    });
  });
});

describe("PATCH /bots/:name/profile", () => {
  it("writes a subset and echoes what hermes said applied", async () => {
    const configures: Array<Record<string, unknown>> = [];
    const { authed, server } = await setup({
      methods: {
        "profiles.configure": (params) => {
          configures.push(params);
          return { ok: true, applied: { skills: true } };
        },
      },
    });
    const res = await authed("/bots/scout/profile", patch({ disabledSkills: ["deploy"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "scout",
      outcome: "applied",
      ok: true,
      applied: { skills: true },
      requested: ["disabledSkills"],
    });
    expect(configures).toEqual([{ name: "scout", disabled_skills: ["deploy"] }]);
    expect(server.callsOf("profiles.configure")).toHaveLength(1);
  });

  it("writes every section at once and reports a partial failure honestly", async () => {
    const { authed } = await setup({
      methods: {
        "profiles.configure": () => ({
          ok: false,
          applied: { soul: true, skills: true, toolsets: false, mcp_servers: true },
        }),
      },
    });
    const res = await authed(
      "/bots/scout/profile",
      patch({
        soul: "# Scout",
        disabledSkills: ["deploy"],
        enabledToolsets: ["files"],
        enabledMcpServers: ["github"],
      }),
    );
    const body = (await res.json()) as { ok: boolean; applied: Record<string, boolean> };
    expect(body.ok).toBe(false);
    expect(body.applied).toEqual({ soul: true, skills: true, toolsets: false, mcp_servers: true });
  });

  it("clears the toolset pin with an empty list rather than dropping the field", async () => {
    const configures: Array<Record<string, unknown>> = [];
    const { authed } = await setup({
      methods: {
        "profiles.configure": (params) => {
          configures.push(params);
          return { applied: { toolsets: true } };
        },
      },
    });
    const res = await authed("/bots/scout/profile", patch({ enabledToolsets: [] }));
    expect(res.status).toBe(200);
    expect(configures).toEqual([{ name: "scout", enabled_toolsets: [] }]);
  });

  it("reports an older gateway's reply as unsupported, with ok false", async () => {
    const { authed } = await setup({ methods: { "profiles.configure": () => ({ ok: true }) } });
    const res = await authed("/bots/scout/profile", patch({ soul: "# Scout" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "scout",
      outcome: "unsupported",
      ok: false,
      applied: {},
      requested: ["soul"],
    });
  });

  it("404s an unknown bot before anything is written", async () => {
    const { authed, server } = await setup({ methods: { "profiles.configure": () => ({ applied: {} }) } });
    const res = await authed("/bots/ghost/profile", patch({ soul: "x" }));
    expect(res.status).toBe(404);
    expect(server.callsOf("profiles.configure")).toHaveLength(0);
  });

  it("400s a body that asks for nothing", async () => {
    const { authed, server } = await setup({ methods: { "profiles.configure": () => ({ applied: {} }) } });
    const res = await authed("/bots/scout/profile", patch({}));
    expect(res.status).toBe(400);
    expect(server.callsOf("profiles.configure")).toHaveLength(0);
  });

  it("400s a malformed body", async () => {
    const { authed } = await setup();
    const res = await authed("/bots/scout/profile", patch({ disabledSkills: "deploy" }));
    expect(res.status).toBe(400);
  });

  it("passes a hermes rejection through as a 502 carrying its text", async () => {
    const { authed } = await setup({
      methods: {
        "profiles.configure": () => {
          throw { code: 5064, message: "configure failed" };
        },
      },
    });
    const res = await authed("/bots/scout/profile", patch({ soul: "x" }));
    expect(res.status).toBe(502);
    expect((await res.json()) as { hermesError: string }).toMatchObject({ hermesError: "configure failed" });
  });
});

describe("GET /bots/catalog", () => {
  const catalogBehavior: FakeHermesBehavior = {
    methods: {
      "skills.manage": () => ({ results: [{ name: "ci-watch", description: "watch CI" }] }),
      "mcp.catalog": () => catalogResult,
      "model.options": () => ({
        providers: [
          { slug: "nous", name: "Nous", models: ["hermes-4", { id: "hermes-4-mini" }] },
          { slug: "", name: "dropped", models: [] },
        ],
      }),
    },
  };

  it("aggregates the three edit-screen calls into one answer", async () => {
    const { authed, server } = await setup(catalogBehavior);
    const res = await authed("/bots/catalog?q=ci");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      query: "ci",
      skills: [{ name: "ci-watch", description: "watch CI" }],
      mcpServers: [
        {
          name: "github",
          description: "issues and PRs",
          installed: true,
          enabled: true,
          requires: [],
          transport: "stdio",
        },
        {
          name: "slack",
          description: "messages",
          installed: false,
          enabled: true,
          requires: ["SLACK_TOKEN"],
          transport: "stdio",
        },
      ],
      models: [{ slug: "nous", name: "Nous", models: ["hermes-4", "hermes-4-mini"] }],
      unavailable: [],
      updatedAt: NOW,
    });
    expect(server.callsOf("skills.manage")[0]?.params).toEqual({ action: "search", query: "ci" });
    // The catalog is the MENU, so it is asked for unscoped: per-bot state comes from the profile route.
    expect(server.callsOf("mcp.catalog")[0]?.params).toEqual({});
    expect(server.callsOf("model.options")[0]?.params).toEqual({
      include_unconfigured: true,
      explicit_only: false,
      refresh: true,
    });
  });

  it("searches broadly when no query is given", async () => {
    const { authed, server } = await setup(catalogBehavior);
    await authed("/bots/catalog");
    expect(server.callsOf("skills.manage")[0]?.params).toEqual({ action: "search", query: "" });
  });

  it("degrades a section an older gateway does not offer, and names it", async () => {
    const { authed } = await setup({
      methods: { "mcp.catalog": () => catalogResult },
    });
    const body = (await (await authed("/bots/catalog")).json()) as {
      skills: unknown[];
      models: unknown[];
      unavailable: string[];
    };
    expect(body.skills).toEqual([]);
    expect(body.models).toEqual([]);
    expect([...body.unavailable].sort()).toEqual(["models", "skills"]);
  });

  it("serves a second read from cache rather than re-spending three calls", async () => {
    const { authed, server } = await setup(catalogBehavior);
    await authed("/bots/catalog?q=ci");
    await authed("/bots/catalog?q=ci");
    expect(server.callsOf("skills.manage")).toHaveLength(1);
    // A different search is a different answer, so it is fetched.
    await authed("/bots/catalog?q=deploy");
    expect(server.callsOf("skills.manage")).toHaveLength(2);
  });

  it("re-fetches once the cache has aged out", async () => {
    let clock = NOW;
    const { authed, server } = await setup(catalogBehavior, { catalogTtlMs: 50, now: () => clock });
    await authed("/bots/catalog?q=ci");
    clock += 51;
    await authed("/bots/catalog?q=ci");
    expect(server.callsOf("skills.manage")).toHaveLength(2);
  });

  it("400s an over-long query rather than caching it", async () => {
    const { authed, server } = await setup(catalogBehavior);
    const res = await authed(`/bots/catalog?q=${"a".repeat(201)}`);
    expect(res.status).toBe(400);
    expect(server.callsOf("skills.manage")).toHaveLength(0);
  });

});

describe("device auth", () => {
  it("refuses all three edit routes without a device token, before anything reaches hermes", async () => {
    const { request, server } = await setup({
      methods: {
        "profiles.describe": () => describeResult,
        "profiles.configure": () => ({ applied: { soul: true } }),
        "skills.manage": () => ({ results: [] }),
      },
    });
    expect((await request("/bots/scout/profile")).status).toBe(401);
    expect((await request("/bots/scout/profile", patch({ soul: "x" }))).status).toBe(401);
    expect((await request("/bots/catalog")).status).toBe(401);
    expect(server.callsOf("profiles.describe")).toHaveLength(0);
    expect(server.callsOf("profiles.configure")).toHaveLength(0);
    expect(server.callsOf("skills.manage")).toHaveLength(0);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import {
  CATALOG_CACHE_MAX,
  mapProfileDescribe,
  buildConfigurePayload,
  readConfigureResult,
} from "../src/hermes-bridge/profile.ts";
import {
  NO_REPLY,
  startFakeHermesServer,
  type FakeHermesBehavior,
  type HermesCallContext,
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
  opts: {
    hiddenProfiles?: string[];
    catalogTtlMs?: number;
    catalogDegradedTtlMs?: number;
    requestTimeoutMs?: number;
    now?: () => number;
  } = {},
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
    ...(opts.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: opts.requestTimeoutMs }),
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
    ...(opts.catalogDegradedTtlMs === undefined ? {} : { catalogDegradedTtlMs: opts.catalogDegradedTtlMs }),
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
      runtimeInert: ["toolsets", "mcpServers"],
    });
  });

  // The honesty note a client renders is gated on this field, so it rides EVERY read, including
  // one whose describe reply carried nothing at all (asserted just above).
  it("reports the runtime-inert sections on every read", () => {
    expect(mapProfileDescribe(describeResult, catalogResult).runtimeInert).toEqual([
      "toolsets",
      "mcpServers",
    ]);
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

  // The client's honesty note for the two describe-visible-but-runtime-inert sections is gated on
  // this field rather than on a backend version string it has no reliable way to read.
  it("names the runtime-inert sections on the wire", async () => {
    const { authed } = await setup({ methods: { "profiles.describe": () => describeResult } });
    const body = (await (await authed("/bots/scout/profile")).json()) as { runtimeInert: string[] };
    expect(body.runtimeInert).toEqual(["toolsets", "mcpServers"]);
  });

  // A slow-but-alive catalog is the OPTIONAL half of this read. Turning a perfectly good
  // profiles.describe into a 504 because the menu was slow answers nothing to a user who asked for
  // their bot's own state.
  it("still answers when mcp.catalog times out, rather than failing the whole read", async () => {
    const { authed } = await setup(
      { methods: { "profiles.describe": () => describeResult, "mcp.catalog": () => NO_REPLY } },
      { requestTimeoutMs: 60 },
    );
    const res = await authed("/bots/scout/profile");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mcpServers: Array<{ name: string }> };
    expect(body.mcpServers.map((server) => server.name)).toEqual(["github", "linear"]);
  });

  // The window `#assertBotKnown` cannot close: the roster cache says the bot exists, and it was
  // deleted since. Hermes' own 4064 is the same news the pre-check would have given.
  it("404s a bot deleted between the roster cache and the describe", async () => {
    const { authed } = await setup({
      methods: {
        "profiles.describe": () => {
          throw { code: 4064, message: "profile 'scout' not found" };
        },
      },
    });
    const res = await authed("/bots/scout/profile");
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "not_found" } });
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

  // The gateway is the layer that owes the backend a clean list. Upstream's own cleaning is uneven
  // across the three, so it is done once here instead of relied on three times there.
  it("trims and dedupes every list before it goes on the wire", () => {
    const { params } = buildConfigurePayload("scout", {
      disabledSkills: [" deploy ", "deploy", "ci-watch"],
      enabledToolsets: ["files", "files"],
      enabledMcpServers: [" github "],
    });
    expect(params).toEqual({
      name: "scout",
      disabled_skills: ["deploy", "ci-watch"],
      enabled_toolsets: ["files"],
      enabled_mcp_servers: ["github"],
    });
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

  // `""` is not "leave it alone", it writes a zero-byte SOUL.md, and the distinction between an
  // absent field and an empty one is the whole reason this body is a PATCH.
  it("sends an empty soul on the wire, because it CLEARS the file rather than being a no-op", async () => {
    const configures: Array<Record<string, unknown>> = [];
    const { authed } = await setup({
      methods: {
        "profiles.configure": (params) => {
          configures.push(params);
          return { applied: { soul: true } };
        },
      },
    });
    expect((await authed("/bots/scout/profile", patch({ soul: "" }))).status).toBe(200);
    expect(configures).toEqual([{ name: "scout", soul: "" }]);
  });

  it("400s a whitespace-only toolset name instead of forwarding the pin-popping empty list", async () => {
    const { authed, server } = await setup({
      methods: { "profiles.configure": () => ({ applied: { toolsets: true } }) },
    });
    expect((await authed("/bots/scout/profile", patch({ enabledToolsets: ["  "] }))).status).toBe(400);
    expect(server.callsOf("profiles.configure")).toHaveLength(0);
  });

  // REGRESSION (blocker B2). Upstream's configure is a read-modify-write across up to three
  // separate save cycles, each rewriting the whole document, so two overlapping calls silently
  // lose the loser's sections. The fake below models exactly that: it snapshots the store on
  // entry, applies its own section, and writes the WHOLE snapshot back on reply.
  //
  // Two asserts, and both matter. `maxInflight` proves the bridge serialized (without it the
  // fake sees two calls at once), and the store proves the outcome the user cares about: both
  // sections survived. Run this against an unserialized `configureProfile` and the store keeps
  // exactly one of the two.
  it("serializes concurrent patches to one bot, so overlapping sections cannot be lost", async () => {
    let store: { soul: string; disabledSkills: string[] } = { soul: "original", disabledSkills: [] };
    let inflight = 0;
    let maxInflight = 0;
    const { authed } = await setup({
      methods: {
        "profiles.configure": (params, ctx: HermesCallContext) => {
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);
          // load_config: a SNAPSHOT, taken now and written back whole later.
          const snapshot = { ...store, disabledSkills: [...store.disabledSkills] };
          setTimeout(() => {
            const applied: Record<string, boolean> = {};
            if (typeof params["soul"] === "string") {
              snapshot.soul = params["soul"];
              applied["soul"] = true;
            }
            if (Array.isArray(params["disabled_skills"])) {
              snapshot.disabledSkills = params["disabled_skills"] as string[];
              applied["skills"] = true;
            }
            // save_config: whole-document rewrite, which is where the loser's section vanishes.
            store = snapshot;
            inflight -= 1;
            ctx.reply({ ok: true, applied });
          }, 25);
          return NO_REPLY;
        },
      },
    });

    const [soulRes, skillsRes] = await Promise.all([
      authed("/bots/scout/profile", patch({ soul: "rewritten" })),
      authed("/bots/scout/profile", patch({ disabledSkills: ["deploy"] })),
    ]);
    expect(soulRes.status).toBe(200);
    expect(skillsRes.status).toBe(200);
    expect(maxInflight).toBe(1);
    expect(store).toEqual({ soul: "rewritten", disabledSkills: ["deploy"] });
  });

  // A chain, not a dedupe: the second write asked for something else and must still run.
  it("runs both patches rather than collapsing the second into the first", async () => {
    const { authed, server } = await setup({
      methods: {
        "profiles.configure": (_params, ctx: HermesCallContext) => {
          setTimeout(() => ctx.reply({ applied: { soul: true } }), 15);
          return NO_REPLY;
        },
      },
    });
    await Promise.all([
      authed("/bots/scout/profile", patch({ soul: "a" })),
      authed("/bots/scout/profile", patch({ soul: "b" })),
    ]);
    expect(server.callsOf("profiles.configure").map((call) => call.params["soul"])).toEqual(["a", "b"]);
  });

  // A failed write is one write's problem. The queue behind it must still drain.
  it("does not poison the chain when a patch fails", async () => {
    let calls = 0;
    const { authed } = await setup({
      methods: {
        "profiles.configure": (_params, ctx: HermesCallContext) => {
          calls += 1;
          const mine = calls;
          setTimeout(() => {
            if (mine === 1) ctx.replyError(5064, "configure failed");
            else ctx.reply({ applied: { soul: true } });
          }, 15);
          return NO_REPLY;
        },
      },
    });
    const [first, second] = await Promise.all([
      authed("/bots/scout/profile", patch({ soul: "a" })),
      authed("/bots/scout/profile", patch({ soul: "b" })),
    ]);
    expect(first.status).toBe(502);
    expect(second.status).toBe(200);
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
    // Sorted on the way out: the three section calls race, so an unsorted list would make the same
    // degradation read as a different answer run to run.
    expect(body.unavailable).toEqual(["models", "skills"]);
  });

  // REGRESSION (blocker B1). A degraded answer used to be cached for the full 60 s, so one flaky
  // `model.options` refresh pinned an empty model picker in front of the user for a minute under a
  // message that reads "your gateway is too old" rather than "retry".
  it("re-asks a degraded catalog after seconds, not after the full TTL", async () => {
    let clock = NOW;
    const { authed, server } = await setup(
      {
        methods: {
          "skills.manage": () => ({ results: [] }),
          "mcp.catalog": () => catalogResult,
          // Unregistered `model.options` rejects with 4001, which is the degradation this covers.
        },
      },
      { catalogTtlMs: 60_000, catalogDegradedTtlMs: 100, now: () => clock },
    );

    const first = (await (await authed("/bots/catalog?q=x")).json()) as { unavailable: string[] };
    expect(first.unavailable).toEqual(["models"]);
    expect(server.callsOf("model.options")).toHaveLength(1);

    // Inside the short retry window: still served from cache, so a client polling per keystroke
    // cannot hammer a struggling gateway.
    await authed("/bots/catalog?q=x");
    expect(server.callsOf("model.options")).toHaveLength(1);

    // Past the retry window but FAR inside the 60 s full TTL: the second read re-asks.
    clock += 101;
    await authed("/bots/catalog?q=x");
    expect(server.callsOf("model.options")).toHaveLength(2);
  });

  it("gives a recovered catalog the full TTL again", async () => {
    let clock = NOW;
    let broken = true;
    const { authed, server } = await setup(
      {
        methods: {
          "skills.manage": () => ({ results: [] }),
          "mcp.catalog": () => catalogResult,
          "model.options": () => {
            if (broken) throw { code: 4001, message: "unknown method: model.options" };
            return { providers: [] };
          },
        },
      },
      { catalogTtlMs: 60_000, catalogDegradedTtlMs: 100, now: () => clock },
    );
    await authed("/bots/catalog?q=x");
    broken = false;
    clock += 101;
    const healthy = (await (await authed("/bots/catalog?q=x")).json()) as { unavailable: string[] };
    expect(healthy.unavailable).toEqual([]);
    expect(server.callsOf("model.options")).toHaveLength(2);
    // Complete answers are worth a minute, so this one is NOT re-asked seconds later.
    clock += 101;
    await authed("/bots/catalog?q=x");
    expect(server.callsOf("model.options")).toHaveLength(2);
  });

  // A TRANSPORT failure is not a degradation: no section is trustworthy, so the route says the
  // bridge is down instead of answering three empty lists that look like an empty gateway.
  it("503s when the bridge is down, rather than caching a hollow catalog", async () => {
    const { authed, bridge, client, server } = await setup(catalogBehavior);
    await bridge.close();
    await client.close();
    const res = await authed("/bots/catalog?q=x");
    expect(res.status).toBe(503);
    // Nothing was stored, so the very next read (against a live bridge) starts from scratch.
    expect(server.callsOf("skills.manage")).toHaveLength(0);
  });

  it("shares one fetch between concurrent reads of the same query", async () => {
    const { authed, server } = await setup({
      methods: {
        "skills.manage": (_params, ctx: HermesCallContext) => {
          setTimeout(() => ctx.reply({ results: [] }), 20);
          return NO_REPLY;
        },
        "mcp.catalog": () => catalogResult,
        "model.options": () => ({ providers: [] }),
      },
    });
    const [a, b, c] = await Promise.all([
      authed("/bots/catalog?q=ci"),
      authed("/bots/catalog?q=ci"),
      authed("/bots/catalog?q=ci"),
    ]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(server.callsOf("skills.manage")).toHaveLength(1);
  });

  // The key is the client's own search string, so the key SPACE is client-chosen: a screen reading
  // per keystroke would otherwise mint one permanent entry per prefix, each holding a full payload.
  it("bounds the number of cached queries, evicting the oldest", async () => {
    const { authed, server } = await setup(catalogBehavior);
    for (let i = 0; i < CATALOG_CACHE_MAX + 1; i += 1) await authed(`/bots/catalog?q=q${i}`);
    expect(server.callsOf("skills.manage")).toHaveLength(CATALOG_CACHE_MAX + 1);
    // The newest is still cached; the oldest was evicted and has to be fetched again.
    await authed(`/bots/catalog?q=q${CATALOG_CACHE_MAX}`);
    expect(server.callsOf("skills.manage")).toHaveLength(CATALOG_CACHE_MAX + 1);
    await authed("/bots/catalog?q=q0");
    expect(server.callsOf("skills.manage")).toHaveLength(CATALOG_CACHE_MAX + 2);
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

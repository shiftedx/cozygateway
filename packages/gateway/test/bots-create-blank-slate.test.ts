import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import {
  BLANK_SLATE_SEED,
  BLANK_SLATE_SKILLS_ON,
  planBlankSlateSeed,
} from "../src/hermes-bridge/blank-slate-seed.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** New bots start as BLANK SLATES: the `file` + `terminal` floor on the platforms they run under,
 *  plus manual approvals so the bot has to ask before it earns anything more. Everything runs
 *  against the fake Hermes, so the seed is asserted on the wire it actually rides -- the
 *  profile-aware Dashboard config surface -- rather than on a mock of the bridge. */

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

interface DashboardCall {
  method: string;
  profile: string | null;
  body: unknown;
}

interface Harness {
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  dashboard: DashboardCall[];
  logs: string[];
}

/** A `profiles.list` that answers with whatever profiles exist so far, so a create is followed by
 *  a roster that actually reflects it. */
function liveProfiles(names: Set<string>) {
  return () => ({
    profiles: [...names].map((name) => ({ name, description: "", has_avatar: false })),
    bot_mode_protocol: true,
  });
}

/** The toolsets a fake Hermes reports for a profile, in `profiles.describe` shape. */
const REPORTED_TOOLSETS = ["file", "terminal", "web", "memory", "cronjob"];

/** The SKILLS a fake Hermes reports for a fresh profile: the catalog it inherited from the launch
 *  profile, every row `enabled` because it has no `skills.disabled` yet. That is the leak the
 *  skills half of the seed closes. */
const REPORTED_SKILLS = ["brainstorming", "pdf-forms", "slack-digest", "tdd", "webapp-testing"];

async function setup(
  opts: {
    /** The config the new profile already carries when the seed reads it. */
    profileConfig?: Record<string, unknown>;
    seedBlankSlateBots?: boolean;
    /** The skills floor an operator configured on the Hermes endpoint. */
    blankSlateSkillsOn?: readonly string[];
    /** The skill rows `profiles.describe` answers with. Defaults to none, which is the shape the
     *  toolset-era tests were written against. */
    reportedSkills?: readonly string[];
    /** When true `profiles.describe` rejects, which is a skill catalog that cannot be read. */
    describeFails?: boolean;
    dashboardFails?: boolean;
  } = {},
): Promise<Harness> {
  const names = new Set<string>(["default"]);
  const dashboard: DashboardCall[] = [];
  const logs: string[] = [];
  const stored: Record<string, unknown> = opts.profileConfig ?? {};
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": liveProfiles(names),
      "profiles.create": (params) => {
        names.add(String(params["name"]));
        return {};
      },
      "profiles.configure": () => ({ applied: { ui_meta: true } }),
      "profiles.describe": () => {
        if (opts.describeFails === true) throw { code: 4064, message: "profile not found" };
        return {
          name: "x",
          toolsets: REPORTED_TOOLSETS.map((name) => ({ name, enabled: false })),
          skills: (opts.reportedSkills ?? []).map((name) => ({ name, enabled: true })),
        };
      },
    },
    dashboard: (request) => {
      dashboard.push({
        method: request.method,
        profile: request.query.get("profile"),
        body: request.body,
      });
      if (opts.dashboardFails === true) return { status: 500, body: { detail: "config is locked" } };
      return { body: request.method === "GET" ? stored : { ok: true } };
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
  const frames: ServerFrame[] = [];
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => NOW,
    logSink: (line) => logs.push(line),
    ...(opts.seedBlankSlateBots === undefined
      ? {}
      : { seedBlankSlateBots: opts.seedBlankSlateBots }),
    ...(opts.blankSlateSkillsOn === undefined
      ? {}
      : { blankSlateSkillsOn: opts.blankSlateSkillsOn }),
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 33 } },
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
  return { authed, dashboard, logs };
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function writes(dashboard: DashboardCall[]): DashboardCall[] {
  return dashboard.filter((call) => call.method === "PUT");
}

describe("POST /bots seeds a blank slate", () => {
  it("writes the floor and manual approvals onto the profile it just created", async () => {
    const { authed, dashboard } = await setup();

    const res = await authed("/bots", post({ name: "night-owl" }));
    expect(res.status).toBe(201);

    // Read first, then a single deep-merge write, both scoped to the NEW profile.
    expect(dashboard.map((call) => [call.method, call.profile])).toEqual([
      ["GET", "night-owl"],
      ["PUT", "night-owl"],
    ]);
    expect(writes(dashboard)[0]?.body).toEqual({
      config: {
        platform_toolsets: {
          // The plugin's own platform, so phone turns resolve here...
          cozygateway: ["file", "terminal"],
          // ...and cli, so a cron run does not fall through to the broad platform default.
          cli: ["file", "terminal"],
        },
        approvals: { mode: "manual" },
        // Without this the bot is a roster row nobody can reach: the profile's own gateway
        // process only opens the attach stream when it loads this plugin (issue #183).
        plugins: {
          enabled: ["cozygateway"],
          disabled: [],
          entries: { cozygateway: { allow_tool_override: false } },
        },
      },
    });
    // The whole seed, asserted as one value rather than a hand-picked subset.
    expect(writes(dashboard)[0]?.body).toEqual({ config: BLANK_SLATE_SEED });
  });

  it("never writes agent.disabled_toolsets, which would fight every later re-enable", async () => {
    const { authed, dashboard } = await setup();
    await authed("/bots", post({ name: "night-owl" }));
    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    expect(body.config["agent"]).toBeUndefined();
    expect(body.config["model"]).toBeUndefined();
    expect(body.config["soul"]).toBeUndefined();
  });

  it("quiets MCP servers the fresh profile inherited, because absent enabled reads as on", async () => {
    const { authed, dashboard } = await setup({
      profileConfig: {
        mcp_servers: {
          // Inherited from the launch profile with no flag at all: on, per _parse_enabled_flag.
          home_assistant: { url: "http://ha.local/api/mcp" },
          // Somebody already decided about this one. Not the seed's to touch.
          xcode: { command: "xpresso-mcp", enabled: true },
        },
      },
    });
    await authed("/bots", post({ name: "night-owl" }));
    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    expect(body.config["mcp_servers"]).toEqual({ home_assistant: { enabled: false } });
  });
});

/** Skills are the fourth dimension of the blank slate, and the one that used to leak: they are
 *  gated by a per-profile `skills.disabled` OFF-list with no enabled allowlist anywhere behind it,
 *  so a fresh profile carrying no such list has every installed skill ON. Kyle's dogfood finding
 *  was a New Bot sheet reading "199 on". */
describe("POST /bots seeds the skills OFF-list", () => {
  it("writes the whole catalog off, because a blank slate has no playbooks until it is asked", async () => {
    const { authed, dashboard } = await setup({ reportedSkills: REPORTED_SKILLS });

    expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);

    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    // Sorted, the way `save_disabled_skills` writes it, so a file this seed wrote and one Hermes'
    // own skills UI wrote read the same.
    expect(body.config["skills"]).toEqual({
      disabled: ["brainstorming", "pdf-forms", "slack-digest", "tdd", "webapp-testing"],
    });
    // The default floor is empty on purpose: autonomy is the toolset floor's job.
    expect(BLANK_SLATE_SKILLS_ON).toEqual([]);
  });

  it("keeps the configured floor ON by leaving those names out of the OFF-list", async () => {
    const { authed, dashboard } = await setup({
      reportedSkills: REPORTED_SKILLS,
      blankSlateSkillsOn: ["tdd", "brainstorming"],
    });
    await authed("/bots", post({ name: "night-owl" }));

    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    expect(body.config["skills"]).toEqual({
      disabled: ["pdf-forms", "slack-digest", "webapp-testing"],
    });
  });

  it("names a floor entry the profile does not have back at nobody: it is simply not in the list", async () => {
    const plan = planBlankSlateSeed({
      current: {},
      blankSlate: true,
      skillCatalog: ["tdd"],
      // `telepathy` is not installed for this profile, so there is nothing to keep on and nothing
      // to switch off. It is never invented into either list.
      skillsOn: ["tdd", "telepathy"],
    });
    expect(plan.config?.["skills"]).toEqual({ disabled: [] });
  });

  it("merges only the disabled array, so a skills stanza Hermes wrote survives", async () => {
    const { authed, dashboard } = await setup({
      reportedSkills: ["tdd"],
      profileConfig: { skills: { external_dirs: ["/custom"], template_vars: true } },
    });
    await authed("/bots", post({ name: "night-owl" }));

    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    // The write is a DEEP MERGE: naming only `disabled` is what keeps `external_dirs` alive.
    expect(body.config["skills"]).toEqual({ disabled: ["tdd"] });
  });

  it("leaves an OFF-list the profile already carries exactly as it is", async () => {
    const { authed, dashboard } = await setup({
      reportedSkills: REPORTED_SKILLS,
      profileConfig: {
        platform_toolsets: { cozygateway: ["file", "terminal"], cli: ["file", "terminal"] },
        approvals: { mode: "manual" },
        skills: { disabled: ["pdf-forms"] },
        plugins: {
          enabled: ["cozygateway"],
          disabled: [],
          entries: { cozygateway: { allow_tool_override: false } },
        },
      },
    });
    expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
    // Every key was already there, including the OFF-list somebody curated. Nothing is written at
    // all, rather than the user's four kept skills being switched back off.
    expect(writes(dashboard)).toEqual([]);
  });

  it("writes nothing when the catalog is empty, rather than an OFF-list that blocks later passes", () => {
    // `profiles.describe` drops the skills section wholesale on a bad read upstream, and
    // `mapProfileDescribe` is deliberately tolerant of that, so an empty catalog is not proof a
    // profile has no skills.
    const plan = planBlankSlateSeed({ current: {}, blankSlate: true, skillCatalog: [] });
    expect(plan.config?.["skills"]).toBeUndefined();
  });

  it("skips the key when the catalog cannot be read, and says so loudly", async () => {
    const { authed, dashboard, logs } = await setup({ describeFails: true });

    const res = await authed("/bots", post({ name: "night-owl" }));
    expect(res.status).toBe(201);

    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    // No partial guess. The rest of the floor is knowable from the config read alone and is still
    // written, so the bot is reachable and holds two toolsets.
    expect(body.config["skills"]).toBeUndefined();
    expect(body.config["platform_toolsets"]).toEqual({
      cozygateway: ["file", "terminal"],
      cli: ["file", "terminal"],
    });
    expect(logs.join("\n")).toContain("skills NOT seeded");
    const reply = (await res.json()) as { warnings: string[] };
    expect(reply.warnings.join(" ")).toContain("every installed skill on");
  });
});

describe("POST /bots create-time tool selection (capability 33)", () => {
  it("grants the selection on TOP of the floor, never instead of it", async () => {
    const { authed, dashboard } = await setup();

    const res = await authed("/bots", post({ name: "night-owl", toolsets: ["web", "memory"] }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ bot: expect.objectContaining({ name: "night-owl" }) });

    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    expect(body.config["platform_toolsets"]).toEqual({
      cozygateway: ["file", "memory", "terminal", "web"],
      cli: ["file", "memory", "terminal", "web"],
    });
  });

  it("enables a selected MCP server the profile defines, and leaves the rest quiet", async () => {
    const { authed, dashboard } = await setup({
      profileConfig: {
        mcp_servers: { github: { command: "gh-mcp" }, home_assistant: { url: "http://ha" } },
      },
    });
    await authed("/bots", post({ name: "night-owl", mcpServers: ["github"] }));
    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    // `enabled`, not `disabled`: the RPC that writes `disabled` is runtime-inert upstream, and
    // enabled_mcp_server_names reads exactly this key.
    expect(body.config["mcp_servers"]).toEqual({
      github: { enabled: true },
      home_assistant: { enabled: false },
    });
  });

  it("skips names hermes does not report and says so in warnings, without failing the create", async () => {
    const { authed } = await setup({ profileConfig: { mcp_servers: { github: {} } } });

    const res = await authed(
      "/bots",
      post({ name: "night-owl", toolsets: ["web", "telepathy"], mcpServers: ["github", "nowhere"] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { bot: { name: string }; warnings: string[] };
    expect(body.bot.name).toBe("night-owl");
    expect(body.warnings).toEqual([
      expect.stringContaining("telepathy"),
      expect.stringContaining("nowhere"),
    ]);
    expect(body.warnings.join(" ")).not.toContain("web");
  });

  it("answers no warnings key at all when every selection landed", async () => {
    const { authed } = await setup();
    const res = await authed("/bots", post({ name: "night-owl", toolsets: ["web"] }));
    expect(await res.json()).not.toHaveProperty("warnings");
  });
});

describe("idempotency", () => {
  it("leaves an existing floor and approval mode exactly as the user left them", async () => {
    const { authed, dashboard } = await setup({
      profileConfig: {
        platform_toolsets: { cozygateway: ["file", "terminal", "web"], cli: ["file"] },
        approvals: { mode: "smart" },
        plugins: {
          enabled: ["cozygateway"],
          disabled: [],
          entries: { cozygateway: { allow_tool_override: false } },
        },
      },
    });

    expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
    // Nothing was missing, so nothing was written: no PUT at all, not a PUT that re-asserts.
    expect(writes(dashboard)).toEqual([]);
  });

  it("seeds only the half that is missing", () => {
    const plan = planBlankSlateSeed({
      current: {
        platform_toolsets: { cozygateway: ["web"] },
        plugins: {
          enabled: ["cozygateway"],
          disabled: [],
          entries: { cozygateway: { allow_tool_override: false } },
        },
      },
      blankSlate: true,
    });
    expect(plan.config).toEqual({
      platform_toolsets: { cli: ["file", "terminal"] },
      approvals: { mode: "manual" },
    });
  });
});

describe("the attach-plugin binding", () => {
  it("unions the enabled list rather than replacing it, because the merge replaces arrays", () => {
    const plan = planBlankSlateSeed({
      current: { plugins: { enabled: ["house-lights"] } },
      blankSlate: true,
    });
    // Writing ["cozygateway"] here would unload house-lights on the next profile load.
    expect(plan.config?.["plugins"]).toEqual({
      enabled: ["house-lights", "cozygateway"],
      disabled: [],
      entries: { cozygateway: { allow_tool_override: false } },
    });
  });

  it("lifts its own name out of disabled, which would otherwise contradict enabled", () => {
    const plan = planBlankSlateSeed({
      current: { plugins: { enabled: [], disabled: ["cozygateway", "house-lights"] } },
      blankSlate: true,
    });
    expect(plan.config?.["plugins"]).toEqual({
      enabled: ["cozygateway"],
      // house-lights stays disabled: this seed only ever overrules the decision about itself.
      disabled: ["house-lights"],
      entries: { cozygateway: { allow_tool_override: false } },
    });
  });

  it("leaves an entry the user has already tuned exactly as it is", () => {
    const plan = planBlankSlateSeed({
      current: {
        platform_toolsets: { cozygateway: ["web"], cli: ["web"] },
        approvals: { mode: "smart" },
        plugins: {
          enabled: ["cozygateway"],
          disabled: [],
          entries: { cozygateway: { allow_tool_override: true } },
        },
      },
      blankSlate: true,
    });
    expect(plan.config).toBeUndefined();
  });
});

describe("the seed is best-effort", () => {
  it("still creates the bot when the config write fails, and warns instead of throwing", async () => {
    const { authed, logs } = await setup({ dashboardFails: true });

    const res = await authed("/bots", post({ name: "night-owl" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { bot: { name: string }; warnings: string[] };
    expect(body.bot.name).toBe("night-owl");
    expect(body.warnings[0]).toContain("Hermes' own defaults");
    expect(logs.join("\n")).toContain("seed FAILED");
  });
});

describe("seedBlankSlateBots: false", () => {
  it("writes the plugin binding and nothing else, leaving hermes' broad defaults in place", async () => {
    const { authed, dashboard } = await setup({
      seedBlankSlateBots: false,
      reportedSkills: REPORTED_SKILLS,
    });
    expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    // The flag is toolset policy, so the floor, the approval mode and the MCP quieting all stop.
    expect(body.config["platform_toolsets"]).toBeUndefined();
    expect(body.config["approvals"]).toBeUndefined();
    expect(body.config["mcp_servers"]).toBeUndefined();
    // Skills mirror the toolset floor exactly: with the flag off the bot keeps Hermes' own
    // default, which for skills means every installed one on.
    expect(body.config["skills"]).toBeUndefined();
    // Reachability is not toolset policy. An operator asking for hermes' broad defaults is not
    // asking for a bot nobody can talk to, so the binding is written whatever the flag says.
    expect(body.config["plugins"]).toEqual({
      enabled: ["cozygateway"],
      disabled: [],
      entries: { cozygateway: { allow_tool_override: false } },
    });
  });

  it("still honours an explicit selection, because that is the user speaking, not a default", async () => {
    const { authed, dashboard } = await setup({
      seedBlankSlateBots: false,
      profileConfig: { mcp_servers: { github: {}, home_assistant: {} } },
    });
    await authed("/bots", post({ name: "night-owl", toolsets: ["web"], mcpServers: ["github"] }));
    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    expect(body.config["platform_toolsets"]).toEqual({
      cozygateway: ["file", "terminal", "web"],
      cli: ["file", "terminal", "web"],
    });
    // The selected server is turned on; the one nobody mentioned keeps its inherited default,
    // because quieting the rest is the blank slate's job and the blank slate is off.
    expect(body.config["mcp_servers"]).toEqual({ github: { enabled: true } });
    expect(body.config["approvals"]).toBeUndefined();
    expect(body.config["plugins"]).toEqual({
      enabled: ["cozygateway"],
      disabled: [],
      entries: { cozygateway: { allow_tool_override: false } },
    });
  });
});

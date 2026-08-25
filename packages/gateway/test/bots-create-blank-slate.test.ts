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
  hermes: testHermes(),
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

async function setup(
  opts: {
    /** The config the new profile already carries when the seed reads it. */
    profileConfig?: Record<string, unknown>;
    seedBlankSlateBots?: boolean;
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
      "profiles.describe": () => ({
        name: "x",
        toolsets: REPORTED_TOOLSETS.map((name) => ({ name, enabled: false })),
      }),
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
    const { authed, dashboard } = await setup({ seedBlankSlateBots: false });
    expect((await authed("/bots", post({ name: "night-owl" }))).status).toBe(201);
    const body = writes(dashboard)[0]?.body as { config: Record<string, unknown> };
    // The flag is toolset policy, so the floor, the approval mode and the MCP quieting all stop.
    expect(body.config["platform_toolsets"]).toBeUndefined();
    expect(body.config["approvals"]).toBeUndefined();
    expect(body.config["mcp_servers"]).toBeUndefined();
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

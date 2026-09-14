import { afterEach, describe, expect, it } from "vitest";

import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesDashboardIntegrations } from "../src/hermes-bridge/integrations.ts";
import { createApp } from "../src/http.ts";
import { openStorage } from "../src/storage.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: ReturnType<typeof openStorage>[] = [];

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Hermes");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const storage of storages.splice(0)) storage.close();
  for (const server of servers.splice(0)) await server.close();
});

type Config = Record<string, unknown>;
type Environment = Record<string, string>;

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

async function setup(opts: { runtimeBot?: boolean } = {}) {
  const configs: Record<string, Config> = {
    source: {
      mcp_servers: {
        github: {
          url: "https://github.example/mcp",
          auth: "header",
          headers: { Authorization: "Bearer $" + "{MCP_GITHUB_API_KEY}" },
        },
        oauth: { url: "https://oauth.example/mcp", auth: "oauth" },
      },
    },
    scout: { mcp_servers: {} },
  };
  const environments: Record<string, Environment> = {
    source: { MCP_GITHUB_API_KEY: "source-secret" },
    scout: {},
  };
  const dashboardCalls: Array<{ method: string; path: string; profile: string | null; body: unknown }> = [];
  const rpcCalls = { profileDescribe: 0 };
  const flow = { flow_id: "scout-flow", server_name: "oauth", status: "authorization_required", authorization_url: "https://oauth.example/authorize" };
  const catalog = [
    {
      name: "linear", description: "Linear issues", source: "builtin", transport: "http", auth_type: "header",
      required_env: [{ name: "LINEAR_API_KEY", prompt: "Linear API key", required: true }],
      command: null, args: [], url: "https://mcp.linear.app", install_url: null, ref: null, bootstrap: null,
      needs_install: false,
    },
    {
      name: "bootstrap", description: "Installed by Hermes", source: "catalog", transport: "stdio", auth_type: "none",
      required_env: [], command: "npx", args: ["-y", "bootstrap-mcp"], url: null,
      install_url: "https://example.test/bootstrap.git", ref: "v1", bootstrap: "install",
      needs_install: true,
    },
  ];

  function summary(profile: string) {
    const map = record(configs[profile]?.["mcp_servers"] ?? {});
    return Object.entries(map).map(([name, raw]) => {
      const cfg = record(raw);
      return {
        name,
        url: typeof cfg["url"] === "string" ? cfg["url"] : null,
        command: typeof cfg["command"] === "string" ? cfg["command"] : null,
        args: Array.isArray(cfg["args"]) ? cfg["args"] : [],
        auth: typeof cfg["auth"] === "string" ? cfg["auth"] : "none",
        enabled: cfg["enabled"] === true,
      };
    });
  }

  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({
        profiles: ["source", "scout"].map((name) => ({ name, description: "", has_avatar: false })),
        bot_mode_protocol: true,
      }),
      "profiles.describe": (params) => {
        rpcCalls.profileDescribe += 1;
        return {
          name: String(params["name"]),
          skills: [],
          toolsets: [],
          mcp_servers: [],
        };
      },
    },
    dashboard: ({ method, path, query, body }) => {
      const bodyProfile = record(body ?? {})["profile"];
      const profile = query.get("profile") ?? (typeof bodyProfile === "string" ? bodyProfile : "source");
      dashboardCalls.push({ method, path, profile, body: clone(body) });
      if (method === "GET" && path === "/api/mcp/catalog") return {
        body: {
          entries: catalog.map((entry) => {
            const saved = record(configs[profile]?.["mcp_servers"] ?? {})[entry.name] as Record<string, unknown> | undefined;
            return { ...entry, installed: saved !== undefined, enabled: saved?.["enabled"] === true };
          }),
        },
      };
      if (method === "POST" && path === "/api/mcp/catalog/install") {
        const request = record(body);
        const name = String(request["name"]);
        if (name === "bootstrap") return { body: { ok: true, name, background: true, action: "mcp-install-bootstrap" } };
        if (name === "linear") {
          const definitions = record(configs[profile]?.["mcp_servers"] ?? {});
          definitions.linear = { url: "https://mcp.linear.app", auth: "header", enabled: request["enable"] === true };
          configs[profile] = { ...configs[profile], mcp_servers: definitions };
          return { body: { ok: true, name, background: false } };
        }
        return { status: 404, body: { detail: "not found" } };
      }
      if (method === "GET" && path === "/api/mcp/servers") return { body: { servers: summary(profile) } };
      if (method === "POST" && path === "/api/mcp/servers") {
        const request = record(body);
        const name = String(request["name"]);
        const definitions = record(configs[profile]?.["mcp_servers"] ?? {});
        definitions[name] = {
          ...(typeof request["url"] === "string" ? { url: request["url"] } : {}),
          ...(typeof request["command"] === "string" ? { command: request["command"] } : {}),
          args: Array.isArray(request["args"]) ? request["args"] : [],
          auth: request["auth"],
          // Dashboard's ordinary add currently defaults this true; the adapter must immediately
          // switch it off so source configuration is never an implicit bot grant.
          enabled: true,
        };
        configs[profile] = { ...configs[profile], mcp_servers: definitions };
        return { body: { ok: true } };
      }
      if (method === "GET" && path === "/api/config") return { body: clone(configs[profile] ?? {}) };
      if (method === "PUT" && path === "/api/mcp/servers") {
        configs[profile] = { ...configs[profile], mcp_servers: clone(record(body)["servers"]) };
        return { body: { ok: true } };
      }
      if (method === "PUT" && path.endsWith("/enabled")) {
        const name = decodeURIComponent(path.split("/").at(-2)!);
        record(record(configs[profile]!["mcp_servers"])[name])["enabled"] = record(body)["enabled"];
        return { body: { ok: true } };
      }
      if (method === "POST" && path === "/api/env/reveal") {
        const key = String(record(body)["key"]);
        const value = environments[profile]?.[key];
        return value === undefined ? { status: 404, body: { detail: "not found" } } : { body: { key, value } };
      }
      if (method === "GET" && path === "/api/env") {
        const values = Object.fromEntries(Object.keys(environments[profile] ?? {}).map((key) => [key, { is_set: true }]));
        return { body: values };
      }
      if (method === "PUT" && path === "/api/env") {
        const request = record(body);
        environments[profile] ??= {};
        environments[profile]![String(request["key"])] = String(request["value"]);
        return { body: { ok: true } };
      }
      if (method === "POST" && path.endsWith("/test")) return { body: { ok: false, error: "source-secret /Users/operator/.hermes", tools: [] } };
      if (method === "POST" && path.endsWith("/auth")) return { body: flow };
      if (method === "GET" && path === "/api/mcp/oauth/flows/scout-flow") return { body: flow };
      if (method === "DELETE" && path === "/api/mcp/oauth/flows/scout-flow") return { body: { ok: true } };
      return { status: 404, body: { detail: "not found" } };
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "dashboard-token" } });
  const bridge = new HermesBridge({ client, storage, broadcast: () => {}, logSink: () => {}, now: Date.now });
  bridges.push(bridge);
  const integrations = new HermesDashboardIntegrations({ client, sourceProfile: "source", now: () => 1_000 });
  const app = createApp({
    storage,
    config: { name: "g", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0 },
    bots: opts.runtimeBot
      ? Object.assign(Object.create(bridge) as HermesBridge, { botRuntime: () => ({}) })
      : bridge,
    integrations,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.integrations": 1 } },
    presenceOf: () => "online",
    submitUserMessage: () => { throw new Error("unused"); },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const pair = async (deviceName: string) => {
    const code = newSetupCode();
    storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
    const response = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName }),
    });
    return (await response.json() as { deviceToken: string }).deviceToken;
  };
  const first = await pair("first");
  const second = await pair("second");
  const authed = (token: string, path: string, init?: RequestInit) => app.request(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: "Bearer " + token },
  });
  bridge.start();
  await until(() => client.state() === "online");
  return { authed, first, second, configs, environments, dashboardCalls, rpcCalls };
}

function put(body: unknown): RequestInit {
  return { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("Dashboard-backed integration routes", () => {
  it("maps pinned Dashboard catalog entries, keeps source installs disabled, and treats bootstrap as an acknowledgement", async () => {
    const h = await setup();
    const catalog = await h.authed(h.first, "/integrations/catalog");
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({ entries: [
      {
        name: "linear", description: "Linear issues", transport: "http", auth: "header",
        requiredEnvironment: [{ name: "LINEAR_API_KEY", prompt: "Linear API key", required: true }],
        url: "https://mcp.linear.app", args: [], needsInstall: false, installed: false, enabled: false,
      },
      {
        name: "bootstrap", description: "Installed by Hermes", transport: "stdio", auth: "none",
        requiredEnvironment: [], command: "npx", args: ["-y", "bootstrap-mcp"],
        needsInstall: true, installed: false, enabled: false,
      },
    ] });

    const installed = await h.authed(h.first, "/integrations/catalog/linear/install", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment: { LINEAR_API_KEY: "line-secret" }, enabled: false }),
    });
    expect(await installed.json()).toEqual({ ok: true, name: "linear", background: false });
    expect(h.dashboardCalls.at(-1)).toMatchObject({
      method: "GET", path: "/api/mcp/servers", profile: "source",
    });
    expect(h.dashboardCalls.find((call) => call.path === "/api/mcp/catalog/install")?.body)
      .toMatchObject({ name: "linear", enable: false, profile: "source", env: { LINEAR_API_KEY: "line-secret" } });
    expect(record(record(h.configs.source!["mcp_servers"])["linear"])["enabled"]).toBe(false);

    const background = await h.authed(h.first, "/integrations/catalog/bootstrap/install", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(await background.json()).toEqual({ ok: true, name: "bootstrap", background: true });
    const afterAck = await h.authed(h.first, "/integrations/catalog");
    expect((await afterAck.json() as { entries: Array<{ name: string; installed: boolean }> }).entries
      .find((entry) => entry.name === "bootstrap"))
      .toMatchObject({ installed: false });
  });

  it("keeps a manually configured source integration disabled and rejects a runtime bot", async () => {
    const h = await setup();
    const created = await h.authed(h.first, "/integrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "manual", url: "https://manual.example/mcp", auth: "none" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: "manual", enabled: false });
    expect(record(record(h.configs.source!["mcp_servers"])["manual"])["enabled"]).toBe(false);

    const runtime = await setup({ runtimeBot: true });
    const denied = await runtime.authed(runtime.first, "/bots/scout/integrations");
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { code: "unsupported_for_runtime" } });
  });

  it("requires pairing, copies only missing credential references, and keeps test errors private", async () => {
    const h = await setup();
    expect((await h.authed(h.first, "/integrations")).status).toBe(200);
    expect((await h.authed("", "/integrations")).status).toBe(401);

    const enabled = await h.authed(h.first, "/bots/scout/integrations/github", put({ enabled: true }));
    if (enabled.status !== 200) throw new Error(await enabled.text());
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ name: "github", enabled: true });
    expect(h.rpcCalls.profileDescribe).toBe(0);
    expect(h.configs.scout).toMatchObject({ mcp_servers: { github: { auth: "header", enabled: true } } });
    expect(h.environments.scout).toEqual({ MCP_GITHUB_API_KEY: "source-secret" });

    const tested = await h.authed(h.first, "/bots/scout/integrations/github/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(await tested.json()).toEqual({
      ok: false, toolCount: 0, error: "Hermes could not connect to this integration.",
    });
  });

  it("binds OAuth to the paired device and target profile, then disables an existing bot integration without a source", async () => {
    const h = await setup();
    expect((await h.authed(h.first, "/bots/scout/integrations/oauth/auth", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).status).toBe(404);
    const enabled = await h.authed(h.first, "/bots/scout/integrations/oauth", put({ enabled: true }));
    if (enabled.status !== 200) throw new Error(await enabled.text());
    const begin = await h.authed(h.first, "/bots/scout/integrations/oauth/auth", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(await begin.json()).toMatchObject({ flowId: "scout-flow", serverName: "oauth" });

    expect((await h.authed(h.second, "/bots/scout/integrations/oauth/auth/scout-flow")).status).toBe(404);
    const ownStatus = await h.authed(h.first, "/bots/scout/integrations/oauth/auth/scout-flow");
    if (ownStatus.status !== 200) throw new Error(await ownStatus.text());

    expect((await h.authed(h.first, "/bots/scout/integrations/github", put({ enabled: true }))).status).toBe(200);
    delete record(h.configs.source!["mcp_servers"])["github"];
    h.environments.scout!.MCP_GITHUB_API_KEY = "bot-specific-secret";
    const before = h.dashboardCalls.length;
    const disabled = await h.authed(h.first, "/bots/scout/integrations/github", put({ enabled: false }));
    expect(disabled.status).toBe(200);
    expect(h.configs.scout).toMatchObject({ mcp_servers: { github: { enabled: false } } });
    expect(h.environments.scout!.MCP_GITHUB_API_KEY).toBe("bot-specific-secret");
    expect(h.dashboardCalls.slice(before).some((call) => call.path === "/api/env/reveal")).toBe(false);
  });

  it("serializes simultaneous target profile clones so neither MCP definition is lost", async () => {
    const h = await setup();
    const [github, oauth] = await Promise.all([
      h.authed(h.first, "/bots/scout/integrations/github", put({ enabled: true })),
      h.authed(h.first, "/bots/scout/integrations/oauth", put({ enabled: true })),
    ]);
    expect(github.status).toBe(200);
    expect(oauth.status).toBe(200);
    expect(Object.keys(record(h.configs.scout!["mcp_servers"])).sort()).toEqual(["github", "oauth"]);
  });
});

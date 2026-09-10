import { afterEach, describe, expect, it, vi } from "vitest";

import { testHermes } from "./support/test-config.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { createApp } from "../src/http.ts";
import { openStorage } from "../src/storage.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const servers: FakeHermesServer[] = [];
const closers: Array<() => Promise<void>> = [];

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Hermes");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const server of servers.splice(0)) await server.close();
});

async function setup() {
  let currentProvider = "openrouter";
  let currentModel = "anthropic/claude-sonnet-4";
  let effort = "high";
  const dashboardCalls: Array<{ method: string; path: string; body: unknown; token: string | undefined }> = [];
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({
        profiles: [{ name: "scout", description: "watches CI", has_avatar: false }],
        bot_mode_protocol: true,
      }),
    },
    dashboard: ({ method, path, query, body, headers }) => {
      dashboardCalls.push({ method, path, body, token: headers["x-hermes-session-token"] as string | undefined });
      expect(query.get("profile")).toBe("scout");
      if (method === "GET" && path === "/api/config") {
        return { body: { model: currentModel, agent: { reasoning_effort: effort } } };
      }
      if (method === "GET" && path === "/api/model/options") {
        expect(query.get("explicit_only")).toBe("1");
        return {
          body: {
            provider: currentProvider,
            model: currentModel,
            providers: [
              {
                slug: "openrouter",
                name: "OpenRouter",
                authenticated: true,
                models: ["anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
              },
            ],
          },
        };
      }
      if (method === "PUT" && path === "/api/config") {
        const config = (body as { config?: { model?: unknown; agent?: { reasoning_effort?: unknown } } }).config ?? {};
        if (config.model === "") {
          currentProvider = "";
          currentModel = "";
        }
        if (typeof config.agent?.reasoning_effort === "string") effort = config.agent.reasoning_effort;
        return { body: { ok: true } };
      }
      if (method === "POST" && path === "/api/model/set") {
        const assignment = body as { provider: string; model: string; confirm_expensive_model: boolean };
        expect(assignment.confirm_expensive_model).toBe(true);
        currentProvider = assignment.provider;
        currentModel = assignment.model;
        return { body: { ok: true, ...assignment } };
      }
      return { status: 404, body: { detail: "Not Found" } };
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "HERMES-TOKEN" } });
  const bridge = new HermesBridge({ client, storage, broadcast: () => {}, logSink: () => {}, now: Date.now });
  const app = createApp({
    storage,
    config: {
      name: "g",
      port: 8787,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
    },
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 18 } },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("unused");
    },
    interruptThread: () => "idle",
    resolveApproval: async () => "unknown",
    onDeviceRevoked: () => {},
    now: Date.now,
  });
  bridge.start();
  await until(() => client.state() === "online");
  const code = newSetupCode();
  storage.createSetupCode(code, Date.now() + SETUP_CODE_TTL_MS);
  const paired = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const token = ((await paired.json()) as { deviceToken: string }).deviceToken;
  closers.push(async () => {
    await bridge.close();
    storage.close();
  });
  return {
    app,
    bridge,
    dashboardCalls,
    authed: (path: string, init?: RequestInit) =>
      app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` } }),
  };
}

describe("bot model config", () => {
  it("exposes supported subagent selection, forwards child-only writes, and preserves null reset", async () => {
    const { authed, bridge } = await setup();
    const state = { model: "provider:primary", effort: "high", catalog: [], efforts: [], subagentModel: null as string | null };
    vi.spyOn(bridge, "modelConfig").mockImplementation(async () => ({ ...state }));
    const write = vi.spyOn(bridge, "configureModel").mockImplementation(async (_name, patch) => {
      if (patch.subagentModel !== undefined) state.subagentModel = patch.subagentModel;
      return { ...state };
    });
    expect(await (await authed("/bots/scout/model-config")).json()).toMatchObject({
      subagentModel: null, subagentModelConfigurable: true,
    });
    for (const selection of ["provider:child", null]) {
      const response = await authed("/bots/scout/model-config", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subagentModel: selection }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        model: "provider:primary", effort: "high", subagentModel: selection, subagentModelConfigurable: true,
      });
      expect(write).toHaveBeenLastCalledWith("scout", { subagentModel: selection });
    }
  });

  it("does not advertise or mutate subagent settings for an older runtime", async () => {
    const { authed, bridge } = await setup();
    vi.spyOn(bridge, "modelConfig").mockResolvedValue({ model: null, effort: null, catalog: [], efforts: [] });
    const write = vi.spyOn(bridge, "configureModel");
    expect(await (await authed("/bots/scout/model-config")).json()).not.toHaveProperty("subagentModelConfigurable");
    const response = await authed("/bots/scout/model-config", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "provider:primary", subagentModel: null }),
    });
    expect(response.status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });

  it.each([{}, { subagentModel: 1 }, { subagentModel: "" }, { subagentModel: "   " }])("refuses invalid model writes %j", async (body) => {
    const { authed, bridge } = await setup();
    const write = vi.spyOn(bridge, "configureModel");
    const response = await authed("/bots/scout/model-config", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });

  it("is device-authenticated and reads Hermes' configured picker authority", async () => {
    const { app, authed, dashboardCalls } = await setup();
    expect((await app.request("/bots/scout/model-config")).status).toBe(401);
    const response = await authed("/bots/scout/model-config");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      model: "openrouter:anthropic/claude-sonnet-4",
      effort: "high",
      subagentModel: null,
      subagentModelConfigurable: true,
      // The Hermes fixture pins no auxiliary.vision block, which is the default, not an
      // unrepresentable pin, so the additive field reads null rather than being omitted.
      visionModel: null,
      catalog: [
        { id: "openrouter:anthropic/claude-sonnet-4", displayName: "OpenRouter: anthropic/claude-sonnet-4" },
        { id: "openrouter:google/gemini-2.5-flash", displayName: "OpenRouter: google/gemini-2.5-flash" },
      ],
      efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
      providers: [{ slug: "openrouter", name: "OpenRouter", authenticated: true, modelCount: 2 }],
    });
    expect(dashboardCalls.every((call) => call.token === "HERMES-TOKEN")).toBe(true);
  });

  it("validates, writes both axes, rereads, and clears with explicit null", async () => {
    const { authed, dashboardCalls } = await setup();
    const bad = await authed("/bots/scout/model-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openrouter:not-real" }),
    });
    expect(bad.status).toBe(400);
    expect(dashboardCalls.filter((call) => call.method !== "GET")).toHaveLength(0);

    const updated = await authed("/bots/scout/model-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openrouter:google/gemini-2.5-flash", effort: "low" }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ model: "openrouter:google/gemini-2.5-flash", effort: "low" });

    const cleared = await authed("/bots/scout/model-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: null, effort: null }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ model: null, effort: null });
  });
});

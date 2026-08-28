import { afterEach, describe, expect, it } from "vitest";

import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { createApp } from "../src/http.ts";
import { openStorage } from "../src/storage.ts";
import { testHermes } from "./support/test-config.ts";
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
  let openRouterKey: string | undefined;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({
        profiles: [{ name: "scout", description: "watches CI", has_avatar: false }],
        bot_mode_protocol: true,
      }),
    },
    dashboard: ({ method, path, query, body }) => {
      calls.push({ method, path, body });
      expect(query.get("profile")).toBe("scout");
      if (method === "GET" && path === "/api/model/options") {
        expect(query.get("include_unconfigured")).toBe("1");
        return { body: { providers: [
          { slug: "openrouter", name: "OpenRouter", authenticated: openRouterKey !== undefined, models: [] },
          { slug: "openai-codex", name: "ChatGPT or Codex Subscription", authenticated: false, models: [] },
          { slug: "anthropic", name: "Anthropic", authenticated: false, models: [] },
          { slug: "qwen-oauth", name: "Qwen", authenticated: false, models: [] },
        ] } };
      }
      if (method === "GET" && path === "/api/env") {
        return { body: {
          OPENROUTER_API_KEY: {
            is_set: openRouterKey !== undefined,
            redacted_value: openRouterKey ? `****${openRouterKey.slice(-4)}` : null,
            description: "OpenRouter API key",
            url: "https://openrouter.ai/keys",
            category: "provider",
            is_password: true,
            advanced: false,
            provider: "openrouter",
            provider_label: "OpenRouter",
          },
        } };
      }
      if (method === "PUT" && path === "/api/env") {
        const update = body as { key?: string; value?: string };
        expect(update.key).toBe("OPENROUTER_API_KEY");
        openRouterKey = update.value;
        return { body: { ok: true } };
      }
      if (method === "DELETE" && path === "/api/env") {
        openRouterKey = undefined;
        return { body: { ok: true } };
      }
      if (method === "GET" && path === "/api/providers/oauth") {
        return { body: { providers: [
          {
            id: "openai-codex", name: "ChatGPT or Codex Subscription", flow: "device_code",
            cli_command: "hermes auth add openai-codex", docs_url: "https://chatgpt.com",
            status: { logged_in: false },
          },
          {
            id: "anthropic", name: "Anthropic", flow: "pkce",
            cli_command: "hermes auth add anthropic", docs_url: "https://claude.ai",
            status: { logged_in: false },
          },
          {
            id: "qwen-oauth", name: "Qwen", flow: "external",
            cli_command: "hermes auth add qwen-oauth", docs_url: "https://qwen.ai",
            status: { logged_in: false },
          },
        ] } };
      }
      if (method === "POST" && path === "/api/providers/oauth/openai-codex/start") {
        return { body: {
          session_id: "oauth-device", flow: "device_code", status: "pending",
          verification_url: "https://example.test/device", user_code: "ABCD-EFGH",
          expires_in: 600, poll_interval: 2,
        } };
      }
      if (method === "GET" && path === "/api/providers/oauth/openai-codex/poll/oauth-device") {
        return { body: { session_id: "oauth-device", status: "approved" } };
      }
      if (method === "POST" && path === "/api/providers/oauth/anthropic/start") {
        return { body: {
          session_id: "oauth-pkce", flow: "pkce", status: "pending",
          auth_url: "https://example.test/authorize",
        } };
      }
      if (method === "POST" && path === "/api/providers/oauth/anthropic/submit") {
        expect(body).toEqual({ session_id: "oauth-pkce", code: "pasted-code" });
        return { body: { ok: true, status: "approved" } };
      }
      if (method === "DELETE" && path === "/api/providers/oauth/sessions/oauth-device") {
        return { body: { ok: true } };
      }
      return { status: 404, body: { detail: "Not Found" } };
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "HERMES-TOKEN" } });
  const bridge = new HermesBridge({ client, storage, broadcast: () => {}, logSink: () => {}, now: () => 1_800_000_000_000 });
  const app = createApp({
    storage,
    config: { name: "g", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() },
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 41 } },
    presenceOf: () => "online",
    submitUserMessage: () => { throw new Error("unused"); },
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
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const token = ((await paired.json()) as { deviceToken: string }).deviceToken;
  closers.push(async () => { await bridge.close(); storage.close(); });
  return {
    app,
    calls,
    authed: (path: string, init?: RequestInit) => app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    }),
  };
}

describe("bot model provider setup", () => {
  it("wraps Hermes' provider universe without returning stored or redacted credentials", async () => {
    const { app, authed } = await setup();
    expect((await app.request("/bots/scout/model-providers")).status).toBe(401);
    const response = await authed("/bots/scout/model-providers");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("****");
    expect(JSON.parse(text)).toEqual({
      providers: [
        {
          slug: "openrouter", name: "OpenRouter", authenticated: false, modelCount: 0,
          methods: [{ id: "fields", kind: "fields", label: "API key", connected: false, fields: [{
            key: "OPENROUTER_API_KEY", label: "API key", secret: true, advanced: false,
            isSet: false, helpUrl: "https://openrouter.ai/keys",
          }] }],
        },
        {
          slug: "openai-codex", name: "ChatGPT or Codex Subscription", authenticated: false,
          modelCount: 0, methods: [{ id: "account", kind: "oauth", label: "Account",
            connected: false, flow: "device_code", helpUrl: "https://chatgpt.com" }],
        },
        {
          slug: "anthropic", name: "Anthropic", authenticated: false, modelCount: 0,
          methods: [{ id: "account", kind: "oauth", label: "Account", connected: false,
            flow: "pkce", helpUrl: "https://claude.ai" }],
        },
        {
          slug: "qwen-oauth", name: "Qwen", authenticated: false, modelCount: 0,
          methods: [{ id: "account", kind: "external", label: "Account", connected: false,
            command: "hermes auth add qwen-oauth", helpUrl: "https://qwen.ai" }],
        },
      ],
      updatedAt: 1_800_000_000_000,
    });
  });

  it("validates field ownership, forwards a secret only to Hermes, and returns refreshed state", async () => {
    const { authed, calls } = await setup();
    const rejected = await authed("/bots/scout/model-providers/openrouter/fields/OTHER_KEY", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "nope" }),
    });
    expect(rejected.status).toBe(400);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);

    const saved = await authed("/bots/scout/model-providers/openrouter/fields/OPENROUTER_API_KEY", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "sk-private-1234" }),
    });
    expect(saved.status).toBe(200);
    const response = await saved.text();
    expect(response).not.toContain("sk-private-1234");
    expect(response).not.toContain("1234");
    expect(JSON.parse(response).providers[0]).toMatchObject({
      authenticated: true,
      methods: [{ connected: true, fields: [{ isSet: true }] }],
    });
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      key: "OPENROUTER_API_KEY", value: "sk-private-1234",
    });
  });

  it("proxies device-code and PKCE sessions while keeping codes out of responses", async () => {
    const { authed } = await setup();
    const started = await authed("/bots/scout/model-providers/openai-codex/oauth", { method: "POST" });
    expect(await started.json()).toMatchObject({
      provider: "openai-codex", sessionId: "oauth-device", flow: "device_code", status: "pending",
      authorizationUrl: "https://example.test/device", userCode: "ABCD-EFGH", pollIntervalMs: 2_000,
    });
    const polled = await authed("/bots/scout/model-providers/openai-codex/oauth/oauth-device");
    expect(await polled.json()).toEqual({
      provider: "openai-codex", sessionId: "oauth-device", flow: "device_code", status: "approved",
    });
    const pkce = await authed("/bots/scout/model-providers/anthropic/oauth", { method: "POST" });
    expect((await pkce.json()).authorizationUrl).toBe("https://example.test/authorize");
    const submitted = await authed("/bots/scout/model-providers/anthropic/oauth/oauth-pkce/code", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "pasted-code" }),
    });
    const body = await submitted.text();
    expect(body).not.toContain("pasted-code");
    expect(JSON.parse(body).status).toBe("approved");
    expect((await authed("/bots/scout/model-providers/openai-codex/oauth/oauth-device", { method: "DELETE" })).status).toBe(204);
  });
});

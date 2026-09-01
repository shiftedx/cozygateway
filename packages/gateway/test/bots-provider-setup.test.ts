import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { clearModelDiscoveryCache } from "../src/hermes-bridge/model-config.ts";
import { createApp } from "../src/http.ts";
import { GatewayHarnessSettings, HermesHarnessModelSettingsAdapter } from "../src/harness-settings.ts";
import { openStorage } from "../src/storage.ts";
import { testHermes } from "./support/test-config.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const servers: FakeHermesServer[] = [];
const closers: Array<() => Promise<void>> = [];
const modelServers: Server[] = [];

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
  for (const server of modelServers.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  clearModelDiscoveryCache();
});

async function startModelServer(models: string[]): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  modelServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("model server address unavailable");
  return `http://127.0.0.1:${address.port}/v1`;
}

async function setup() {
  let openRouterKey: string | undefined;
  let lmStudioUrl: string | undefined;
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
          { slug: "openrouter", name: "OpenRouter", authenticated: openRouterKey !== undefined,
            models: ["openai/gpt-5", { id: "anthropic/claude-sonnet-4" }, { name: "google/gemini-2.5-flash" }] },
          { slug: "lmstudio", name: "LM Studio", authenticated: lmStudioUrl !== undefined,
            ...(lmStudioUrl === undefined ? {} : { api_url: lmStudioUrl }), models: ["stale-model"] },
          { slug: "openai-codex", name: "ChatGPT or Codex Subscription", authenticated: false, models: [] },
          { slug: "anthropic", name: "Anthropic", authenticated: false, models: [] },
          { slug: "qwen-oauth", name: "Qwen", authenticated: false, models: [] },
        ] } };
      }
      if (method === "GET" && path === "/api/env") {
        return { body: {
          OPENROUTER_API_KEY: {
            is_set: openRouterKey !== undefined,
            // An upstream bug must not make a credential readable through CozyGateway.
            value: "upstream-secret-that-must-not-cross-the-wire",
            redacted_value: openRouterKey ? `****${openRouterKey.slice(-4)}` : null,
            description: "OpenRouter API key",
            url: "https://openrouter.ai/keys",
            category: "provider",
            is_password: true,
            advanced: false,
            provider: "openrouter",
            provider_label: "OpenRouter",
          },
          UNKNOWN_PROVIDER_TOKEN: {
            is_set: false,
            value: "metadata-missing-secret-that-must-not-cross-the-wire",
            description: "Unknown provider credential",
            advanced: true,
            provider: "openrouter",
            provider_label: "OpenRouter",
          },
          LM_BASE_URL: {
            is_set: lmStudioUrl !== undefined,
            ...(lmStudioUrl === undefined ? {} : { value: lmStudioUrl }),
            description: "LM Studio API URL",
            is_password: false,
            advanced: false,
            provider: "lmstudio",
            provider_label: "LM Studio",
          },
        } };
      }
      if (method === "PUT" && path === "/api/env") {
        const update = body as { key?: string; value?: string };
        if (update.key === "OPENROUTER_API_KEY") openRouterKey = update.value;
        else if (update.key === "LM_BASE_URL") lmStudioUrl = update.value;
        else throw new Error(`unexpected environment key ${String(update.key)}`);
        return { body: { ok: true } };
      }
      if (method === "DELETE" && path === "/api/env") {
        const update = body as { key?: string };
        if (update.key === "OPENROUTER_API_KEY") openRouterKey = undefined;
        else if (update.key === "LM_BASE_URL") lmStudioUrl = undefined;
        else throw new Error(`unexpected environment key ${String(update.key)}`);
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
  const hermesConfig = {
    ...testHermes(),
    profiles: { scout: { tokenEnv: "TEST_ATTACH_TOKEN" } },
  };
  const harnessSettings = new GatewayHarnessSettings([
    new HermesHarnessModelSettingsAdapter(
      { id: "default", label: undefined, namespace: false, config: hermesConfig },
      client,
    ),
  ], () => 1_800_000_000_000);
  const app = createApp({
    storage,
    config: { name: "g", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...hermesConfig }] },
    bots: bridge,
    harnessSettings,
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

describe("gateway harness model provider setup", () => {
  it("lets a bot configure LM Studio and receives its live model inventory", async () => {
    const lmStudioBaseUrl = await startModelServer(["qwen3.5-9b", "granite-4.0"]);
    const { authed } = await setup();

    const initial = await authed("/bots/scout/model-providers");
    expect(initial.status).toBe(200);
    const initialText = await initial.text();
    expect(initialText).not.toContain("upstream-secret-that-must-not-cross-the-wire");
    expect(initialText).not.toContain("metadata-missing-secret-that-must-not-cross-the-wire");
    const initialBody = JSON.parse(initialText) as {
      providers: Array<{ slug: string; models: string[]; methods: Array<{ fields?: Array<{ key: string; value?: string }> }> }>;
    };
    expect(initialBody.providers)
      .toContainEqual(expect.objectContaining({ slug: "lmstudio", models: ["stale-model"] }));
    const initialEndpoint = initialBody.providers.find((provider) => provider.slug === "lmstudio")
      ?.methods[0]?.fields?.find((field) => field.key === "LM_BASE_URL");
    // An unconfigured profile gets Hermes' safe static list, and does not invent an endpoint.
    expect(initialEndpoint).toBeDefined();
    expect(initialEndpoint).not.toHaveProperty("value");
    expect(initialText).not.toContain(lmStudioBaseUrl);

    const saved = await authed(
      "/bots/scout/model-providers/lmstudio/fields/LM_BASE_URL",
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: lmStudioBaseUrl }) },
    );
    expect(saved.status).toBe(200);
    const savedText = await saved.text();
    expect(savedText).not.toContain("upstream-secret-that-must-not-cross-the-wire");
    const body = JSON.parse(savedText);
    expect(body.providers).toContainEqual(expect.objectContaining({
      slug: "lmstudio", models: ["qwen3.5-9b", "granite-4.0"], modelCount: 2,
      methods: [expect.objectContaining({ fields: [expect.objectContaining({
        key: "LM_BASE_URL", secret: false, value: lmStudioBaseUrl,
      })] })],
    }));
  });

  it("lists the official harness identity and routes a selected configuration scope", async () => {
    const { app, authed, calls } = await setup();
    expect((await app.request("/gateway/harnesses")).status).toBe(401);
    expect(await (await authed("/gateway/harnesses")).json()).toEqual({
      harnesses: [{
        id: "default",
        vendor: {
          id: "hermes-agent",
          name: "Hermes Agent",
          logoAsset: "hermes-agent",
          logoSourceUrl: "https://github.com/NousResearch/hermes-agent/blob/main/website/static/img/favicon.svg",
        },
        scopes: [{ id: "scout", name: "scout" }],
      }],
      updatedAt: 1_800_000_000_000,
    });

    expect((await authed("/gateway/harnesses/missing/scopes/scout/model-providers")).status).toBe(404);
    expect((await authed("/gateway/harnesses/default/scopes/missing/model-providers")).status).toBe(404);
    const catalog = await authed("/gateway/harnesses/default/scopes/scout/model-providers");
    expect(catalog.status).toBe(200);
    expect((await catalog.json() as { providers: unknown[] }).providers).toHaveLength(5);

    const saved = await authed(
      "/gateway/harnesses/default/scopes/scout/model-providers/openrouter/fields/OPENROUTER_API_KEY",
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "sk-gateway-only" }) },
    );
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("sk-gateway-only");
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      key: "OPENROUTER_API_KEY", value: "sk-gateway-only",
    });

    const cleared = await authed(
      "/gateway/harnesses/default/scopes/scout/model-providers/openrouter/fields/OPENROUTER_API_KEY",
      { method: "DELETE" },
    );
    expect(cleared.status).toBe(200);
    expect((await cleared.json() as { providers: Array<{ authenticated: boolean }> }).providers[0]?.authenticated)
      .toBe(false);

    const oauth = await authed(
      "/gateway/harnesses/default/scopes/scout/model-providers/openai-codex/oauth",
      { method: "POST" },
    );
    expect(await oauth.json()).toMatchObject({
      provider: "openai-codex", sessionId: "oauth-device", status: "pending",
    });
    const polled = await authed(
      "/gateway/harnesses/default/scopes/scout/model-providers/openai-codex/oauth/oauth-device",
    );
    expect(await polled.json()).toMatchObject({ provider: "openai-codex", status: "approved" });
    expect((await authed(
      "/gateway/harnesses/default/scopes/scout/model-providers/openai-codex/oauth/oauth-device",
      { method: "DELETE" },
    )).status).toBe(204);

    const pkce = await authed(
      "/gateway/harnesses/default/scopes/scout/model-providers/anthropic/oauth",
      { method: "POST" },
    );
    expect(await pkce.json()).toMatchObject({ provider: "anthropic", sessionId: "oauth-pkce" });
    const submitted = await authed(
      "/gateway/harnesses/default/scopes/scout/model-providers/anthropic/oauth/oauth-pkce/code",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "pasted-code" }) },
    );
    const submittedText = await submitted.text();
    expect(submittedText).not.toContain("pasted-code");
    expect(JSON.parse(submittedText)).toMatchObject({ provider: "anthropic", status: "approved" });
  });
});

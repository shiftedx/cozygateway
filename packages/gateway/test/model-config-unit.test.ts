import { afterEach, describe, expect, it, vi } from "vitest";

import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import {
  ModelConfigInvalid,
  MODEL_DISCOVERY_CACHE_MS,
  clearModelDiscoveryCache,
  readBotModelConfig,
  writeBotModelConfig,
} from "../src/hermes-bridge/model-config.ts";

afterEach(() => {
  clearModelDiscoveryCache();
  vi.restoreAllMocks();
});

function modelClient() {
  let model = "anthropic/claude-sonnet-4";
  let provider = "openrouter";
  let effort = "high";
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const client = {
    dashboardJson: async (path: string, init: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {}) => {
      const method = init.method ?? "GET";
      calls.push({ path, method, body: init.body });
      if (path.startsWith("/api/config?")) {
        if (method === "PUT") {
          const patch = (init.body as { config: { model?: unknown; agent?: { reasoning_effort?: unknown } } }).config;
          if (patch.model === "") {
            model = "";
            provider = "";
          }
          if (typeof patch.agent?.reasoning_effort === "string") effort = patch.agent.reasoning_effort;
          return { ok: true };
        }
        return { model, agent: { reasoning_effort: effort } };
      }
      if (path.startsWith("/api/model/options?")) {
        return {
          model,
          provider,
          providers: [
            {
              slug: "openrouter",
              name: "OpenRouter",
              authenticated: true,
              models: ["anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
            },
          ],
        };
      }
      if (path.startsWith("/api/model/set?")) {
        const selection = init.body as { model: string; provider: string };
        model = selection.model;
        provider = selection.provider;
        return { ok: true };
      }
      throw new Error(`unexpected dashboard path ${path}`);
    },
  } as HermesClient;
  return { client, calls };
}

describe("Hermes model config", () => {
  it("discovers every live OpenAI-compatible model and drops stale rows after that provider goes down", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const client = {
      dashboardJson: async (path: string) => path.startsWith("/api/config?")
        ? { model: "aeon-27b", agent: { reasoning_effort: "high" } }
        : {
            model: "aeon-27b",
            provider: "mtplx",
            providers: [{
              slug: "mtplx", name: "MTPLX", authenticated: true,
              api_url: "http://127.0.0.1:8000/v1", models: ["hand-entered"],
            }],
          },
    } as HermesClient;
    let online = true;
    const fetcher = async () => {
      if (!online) throw new Error("offline");
      return new Response(JSON.stringify({ data: [
        { id: "aeon-27b", context_length: 131072 },
        { id: "qwen3-30b", context_length: 65536 },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    };

    expect((await readBotModelConfig(client, "scout", fetcher)).catalog.map((row) => row.id)).toEqual([
      "mtplx:aeon-27b", "mtplx:qwen3-30b",
    ]);
    online = false;
    now += MODEL_DISCOVERY_CACHE_MS + 1;
    expect((await readBotModelConfig(client, "scout", fetcher)).catalog).toEqual([]);
  });

  it("reads the configured picker authority and validates before writing", async () => {
    const { client, calls } = modelClient();
    expect(await readBotModelConfig(client, "scout")).toMatchObject({
      model: "openrouter:anthropic/claude-sonnet-4",
      effort: "high",
      catalog: [
        { id: "openrouter:anthropic/claude-sonnet-4", displayName: "OpenRouter: anthropic/claude-sonnet-4" },
        { id: "openrouter:google/gemini-2.5-flash", displayName: "OpenRouter: google/gemini-2.5-flash" },
      ],
    });

    await expect(writeBotModelConfig(client, "scout", { effort: "impossible" })).rejects.toBeInstanceOf(
      ModelConfigInvalid,
    );
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);

    const changed = await writeBotModelConfig(client, "scout", {
      model: "openrouter:google/gemini-2.5-flash",
      effort: "low",
    });
    expect(changed).toMatchObject({ model: "openrouter:google/gemini-2.5-flash", effort: "low" });
    expect(calls.some((call) => call.path.startsWith("/api/model/set?profile=scout"))).toBe(true);

    expect(await writeBotModelConfig(client, "scout", { model: null, effort: null })).toMatchObject({
      model: null,
      effort: null,
    });
  });

  it("uses the dashboard origin and the established token header", async () => {
    let observed: { url: string; token: string | null } | undefined;
    const client = createHermesClient({
      url: "ws://hermes.test:9119/api/ws",
      auth: { mode: "token", token: "secret-token" },
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        observed = { url: String(input), token: headers.get("x-hermes-session-token") };
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(await client.dashboardJson("/api/config?profile=scout")).toEqual({ ok: true });
    expect(observed).toEqual({
      url: "http://hermes.test:9119/api/config?profile=scout",
      token: "secret-token",
    });
  });
});

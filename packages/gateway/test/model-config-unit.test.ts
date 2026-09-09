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
  let subagentModel = "google/gemini-2.5-flash";
  let subagentProvider = "openrouter";
  let delegationBaseUrl = "";
  let delegationEffort = "medium";
  let delegationLimit = 12;
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const client = {
    dashboardJson: async (path: string, init: { method?: "GET" | "POST" | "PUT"; body?: unknown } = {}) => {
      const method = init.method ?? "GET";
      calls.push({ path, method, body: init.body });
      if (path.startsWith("/api/config?")) {
        if (method === "PUT") {
          const patch = (init.body as {
            config: {
              model?: unknown;
              agent?: { reasoning_effort?: unknown };
              delegation?: { model?: unknown; provider?: unknown; base_url?: unknown };
            };
          }).config;
          if (patch.model === "") {
            model = "";
            provider = "";
          }
          if (typeof patch.agent?.reasoning_effort === "string") effort = patch.agent.reasoning_effort;
          if (patch.delegation !== undefined) {
            if (typeof patch.delegation.model === "string") subagentModel = patch.delegation.model;
            if (typeof patch.delegation.provider === "string") subagentProvider = patch.delegation.provider;
            if (typeof patch.delegation.base_url === "string") delegationBaseUrl = patch.delegation.base_url;
          }
          return { ok: true };
        }
        return {
          model,
          agent: { reasoning_effort: effort },
          delegation: {
            model: subagentModel,
            provider: subagentProvider,
            base_url: delegationBaseUrl,
            reasoning_effort: delegationEffort,
            max_iterations: delegationLimit,
          },
        };
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
  return {
    client,
    calls,
    delegation: () => ({ model: subagentModel, provider: subagentProvider, baseUrl: delegationBaseUrl, effort: delegationEffort, limit: delegationLimit }),
  };
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
    const { client, calls, delegation } = modelClient();
    expect(await readBotModelConfig(client, "scout")).toMatchObject({
      model: "openrouter:anthropic/claude-sonnet-4",
      subagentModel: "openrouter:google/gemini-2.5-flash",
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

    await expect(writeBotModelConfig(client, "scout", { subagentModel: "missing:model" })).rejects.toBeInstanceOf(
      ModelConfigInvalid,
    );
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);

    const changed = await writeBotModelConfig(client, "scout", {
      model: "openrouter:google/gemini-2.5-flash",
      effort: "low",
    });
    expect(changed).toMatchObject({ model: "openrouter:google/gemini-2.5-flash", effort: "low" });
    expect(calls.some((call) => call.path.startsWith("/api/model/set?profile=scout"))).toBe(true);

    const childChanged = await writeBotModelConfig(client, "scout", {
      subagentModel: "openrouter:anthropic/claude-sonnet-4",
    });
    expect(childChanged.subagentModel).toBe("openrouter:anthropic/claude-sonnet-4");
    expect(delegation()).toEqual({
      model: "anthropic/claude-sonnet-4", provider: "openrouter", baseUrl: "", effort: "medium", limit: 12,
    });

    expect(await writeBotModelConfig(client, "scout", { model: null, effort: null, subagentModel: null })).toMatchObject({
      model: null,
      subagentModel: null,
      effort: null,
    });
    expect(delegation()).toEqual({ model: "", provider: "", baseUrl: "", effort: "medium", limit: 12 });
  });

  it("qualifies a provider-inheriting delegation model with the primary provider", async () => {
    const client = {
      dashboardJson: async (path: string) => path.startsWith("/api/config?")
        ? {
            model: "anthropic/claude-sonnet-4",
            delegation: { model: "google/gemini-2.5-flash", provider: "" },
          }
        : {
            model: "anthropic/claude-sonnet-4",
            provider: "openrouter",
            providers: [{
              slug: "openrouter", name: "OpenRouter", authenticated: true,
              models: ["anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
            }],
          },
    } as HermesClient;
    // An older Hermes profile may pin only delegation.model. It still overrides inheritance;
    // Hermes takes the parent provider, which the gateway exposes as a qualified id.
    expect((await readBotModelConfig(client, "scout")).subagentModel).toBe("openrouter:google/gemini-2.5-flash");
  });

  it("omits unrepresentable delegation overrides without blocking primary reads or writes", async () => {
    const clientFor = (delegation: Record<string, unknown>) => ({
      dashboardJson: async (path: string) => path.startsWith("/api/config?")
        ? { model: "anthropic/claude-sonnet-4", delegation }
        : {
            model: "anthropic/claude-sonnet-4",
            provider: "openrouter",
            providers: [{
              slug: "openrouter", name: "OpenRouter", authenticated: true,
              models: ["anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
            }],
          },
    }) as HermesClient;

    // A provider-only pin uses that provider's runtime default model. It is not inheritance, but
    // /api/model/options does not report that selection, so this additive field stays absent.
    const providerOnly = await readBotModelConfig(clientFor({ provider: "openrouter", model: "" }), "scout");
    expect(providerOnly.model).toBe("openrouter:anthropic/claude-sonnet-4");
    expect(providerOnly.subagentModel).toBeUndefined();
    // A non-native base_url takes precedence over provider/model and is routed by URL heuristics;
    // its credential is also active, so projecting null would be a dangerous lie.
    const direct = await readBotModelConfig(
      clientFor({ base_url: "https://example.test/v1", model: "google/gemini-2.5-flash" }), "scout",
    );
    expect(direct.model).toBe("openrouter:anthropic/claude-sonnet-4");
    expect(direct.subagentModel).toBeUndefined();

    let primary = "anthropic/claude-sonnet-4";
    let configWrites = 0;
    const directClient = {
      dashboardJson: async (path: string, init: { method?: string } = {}) => {
        if (path.startsWith("/api/config?")) {
          if (init.method === "PUT") configWrites += 1;
          return { model: primary, delegation: { base_url: "https://example.test/v1", model: "google/gemini-2.5-flash" } };
        }
        if (path.startsWith("/api/model/options?")) {
          return {
            model: primary, provider: "openrouter",
            providers: [{
              slug: "openrouter", name: "OpenRouter", authenticated: true,
              models: ["anthropic/claude-sonnet-4", "google/gemini-2.5-flash"],
            }],
          };
        }
        if (path.startsWith("/api/model/set?")) {
          primary = "google/gemini-2.5-flash";
          return { ok: true };
        }
        throw new Error(`unexpected dashboard path ${path}`);
      },
    } as HermesClient;
    const updated = await writeBotModelConfig(directClient, "scout", {
      model: "openrouter:google/gemini-2.5-flash",
    });
    expect(updated.model).toBe("openrouter:google/gemini-2.5-flash");
    expect(updated.subagentModel).toBeUndefined();
    // Editing the primary must not erase an unsupported direct delegation override.
    expect(configWrites).toBe(0);
  });

  it("keeps every configured provider visible: unauthenticated rows stay marked, empty rows stay summarized", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const client = {
      dashboardJson: async (path: string) => path.startsWith("/api/config?")
        ? { model: "claude-sonnet-4", agent: {} }
        : {
            model: "claude-sonnet-4",
            provider: "anthropic",
            providers: [
              // authenticated is absent on purpose: absent means authenticated.
              { slug: "openrouter", name: "OpenRouter", models: ["google/gemini-2.5-flash"] },
              // Hermes' explicit_only payload re-appends the configured current provider when its
              // credential is lost, so the picker can show the saved selection and a re-auth
              // affordance. The gateway used to drop exactly this row.
              { slug: "anthropic", name: "Anthropic", authenticated: false, models: ["claude-sonnet-4"] },
              // No static models and no api_url: used to vanish from the app entirely.
              { slug: "mtplx", name: "MTPLX", authenticated: true, models: [] },
            ],
          },
    } as HermesClient;

    const read = await readBotModelConfig(client, "scout");
    // Healthy entries are byte-identical to before: no marker key at all.
    expect(read.catalog[0]).toEqual({
      id: "openrouter:google/gemini-2.5-flash",
      displayName: "OpenRouter: google/gemini-2.5-flash",
    });
    expect(read.catalog[1]).toEqual({
      id: "anthropic:claude-sonnet-4",
      displayName: "Anthropic: claude-sonnet-4",
      unauthenticated: true,
    });
    // The saved selection still resolves instead of appearing to jump providers.
    expect(read.model).toBe("anthropic:claude-sonnet-4");
    expect(read.providers).toEqual([
      { slug: "openrouter", name: "OpenRouter", authenticated: true, modelCount: 1 },
      { slug: "anthropic", name: "Anthropic", authenticated: false, modelCount: 1 },
      { slug: "mtplx", name: "MTPLX", authenticated: true, modelCount: 0 },
    ]);
    expect(writes.join("")).toContain("model-config: provider anthropic unauthenticated, kept visible");
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

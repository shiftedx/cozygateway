import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConnectionCatalog, ModelProviderConnectionInput } from "cozygateway-contract";
import { GatewayProviderConnections } from "../src/provider-connections.ts";
import { providerConnectionRoutes } from "../src/provider-connection-routes.ts";
import { CozyAgentsHarnessModelSettingsAdapter } from "../src/harness-settings.ts";

function setup() {
  const catalog: ModelProviderConnectionCatalog = { connections: [] };
  let received: ModelProviderConnectionInput | undefined;
  const list = vi.fn(async () => catalog);
  const save = vi.fn(async (bot: string, handoffId: string) => {
    const wrong = await app.request(`/attach/v1/provider-handoffs/${handoffId}`, { headers: { authorization: "Bearer other" } });
    expect(wrong.status).toBe(404);
    const response = await app.request(`/attach/v1/provider-handoffs/${handoffId}`, { headers: { authorization: `Bearer ${bot}` } });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    received = await response.json() as ModelProviderConnectionInput;
    const replay = await app.request(`/attach/v1/provider-handoffs/${handoffId}`, { headers: { authorization: `Bearer ${bot}` } });
    expect(replay.status).toBe(404);
    return catalog;
  });
  const service = new GatewayProviderConnections({
    knownBot: (bot) => bot === "sage",
    resolveScope: (harness, scope) => harness === "cozyagents" && scope === "sage" ? "sage" : undefined,
    control: { list, save, test: async () => catalog, remove: async () => catalog },
  });
  const app = providerConnectionRoutes({
    service,
    requireDevice: async (c, next) => c.req.header("authorization") === "Bearer phone" ? next() : c.json({ error: "unauthorized" }, 401),
    attachIdentity: (authorization) => authorization === "Bearer sage" ? "sage" : authorization === "Bearer other" ? "other" : undefined,
  });
  const request = (path: string, body: string, method = "POST") => app.request(path, {
    method, headers: { authorization: "Bearer phone", "content-type": "application/json" }, body,
  });
  return { app, service, list, save, request, received: () => received };
}

describe("provider connection routes", () => {
  it("keeps credentials in the authenticated one-time handoff for both navigation paths", async () => {
    const test = setup();
    const input = { name: "Studio", baseUrl: "http://localhost:1234/v1", apiKey: "private-example", manualModels: ["local-model"] };
    for (const path of ["/bots/sage/provider-connections", "/gateway/harnesses/cozyagents/scopes/sage/provider-connections"]) {
      const response = await test.request(path, JSON.stringify(input));
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(input.apiKey);
      expect(test.received()).toEqual(input);
    }
    expect(test.save).toHaveBeenCalledTimes(2);
    expect(test.save.mock.calls[0]?.[1]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires device credentials on management and attach credentials on handoffs", async () => {
    const { app, save } = setup();
    expect((await app.request("/bots/sage/provider-connections")).status).toBe(401);
    expect((await app.request("/bots/sage/provider-connections", { headers: { authorization: "Bearer sage" } })).status).toBe(401);
    expect((await app.request("/attach/v1/provider-handoffs/unknown", { headers: { authorization: "Bearer phone" } })).status).toBe(401);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses malformed, excessive and mismatched updates before dispatch", async () => {
    const { request, save } = setup();
    const path = "/bots/sage/provider-connections";
    expect((await request(path, "{")).status).toBe(400);
    expect((await request(path, "x".repeat(33_000))).status).toBe(413);
    expect((await request(path, JSON.stringify({ name: "x", baseUrl: "http://localhost", extra: true }))).status).toBe(400);
    expect((await request(`${path}/invalid`, JSON.stringify({ name: "x", baseUrl: "http://localhost" }), "PUT")).status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not stage credentials for an unavailable peer", async () => {
    const { request, list, save } = setup();
    list.mockRejectedValueOnce(new Error("offline"));
    expect((await request("/bots/sage/provider-connections", JSON.stringify({ name: "Local", baseUrl: "http://localhost:1234" }))).status).toBe(503);
    expect(save).not.toHaveBeenCalled();
  });
});

it("projects only the harness catalog and follows runtime scopes added after startup", async () => {
  const scopes = [{ id: "sage", name: "Sage" }];
  const adapter = new CozyAgentsHarnessModelSettingsAdapter(() => scopes, async () => ({
    model: null, effort: null, efforts: [], catalog: [
      { id: "openai:gpt-example", displayName: "Example" },
      { id: "custom-test:local", displayName: "Local" },
    ],
  }));
  expect((await adapter.modelProviders("sage")).providers).toEqual([
    { slug: "openai", name: "openai", authenticated: true, models: ["gpt-example"], modelCount: 1, methods: [] },
  ]);
  scopes.push({ id: "luna", name: "Luna" });
  expect(adapter.descriptor().scopes).toHaveLength(2);
  await expect(adapter.modelProviders("unknown")).rejects.toThrow("unknown");
});

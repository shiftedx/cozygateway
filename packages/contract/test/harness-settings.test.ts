import { describe, expect, it } from "vitest";

import {
  GatewayHarnessCatalogSchema,
  HARNESS_SETTINGS_CAPABILITY_ID,
  HARNESS_SETTINGS_CAPABILITY_VERSION,
  ModelProviderFieldUpdateSchema,
  ModelProviderSetupCatalogSchema,
  check,
} from "../src/index.ts";

describe("harness settings contract", () => {
  it("keeps harness identity and configuration scope separate from bots", () => {
    expect(check(GatewayHarnessCatalogSchema, {
      harnesses: [{
        id: "home-hermes",
        label: "Home server",
        vendor: { id: "hermes-agent", name: "Hermes Agent", logoAsset: "hermes-agent" },
        scopes: [{ id: "scout", name: "Scout" }],
      }],
      updatedAt: 1_800_000_000_000,
    })).toBe(true);
    expect(check(ModelProviderSetupCatalogSchema, {
      providers: [{
        slug: "openrouter", name: "OpenRouter", authenticated: true,
        modelCount: 1, methods: [],
      }],
      updatedAt: 1,
    })).toBe(false);
    expect(check(GatewayHarnessCatalogSchema, {
      harnesses: [{ id: "bad", vendor: { id: "x" }, scopes: [] }], updatedAt: 1,
    })).toBe(false);
    expect(HARNESS_SETTINGS_CAPABILITY_ID).toBe("com.cozylabs.harness-settings");
    expect(HARNESS_SETTINGS_CAPABILITY_VERSION).toBe(1);
  });

  it("models provider state without a credential value", () => {
    expect(check(ModelProviderSetupCatalogSchema, {
      providers: [{
        slug: "openrouter", name: "OpenRouter", authenticated: true,
        models: ["openai/gpt-5"], modelCount: 1, methods: [],
      }],
      updatedAt: 1,
    })).toBe(true);
    expect(check(ModelProviderFieldUpdateSchema, { value: "secret" })).toBe(true);
    expect(check(ModelProviderFieldUpdateSchema, { value: "" })).toBe(false);
  });
});

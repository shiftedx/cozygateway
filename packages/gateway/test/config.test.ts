import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ContractViolation } from "cozygateway-contract";

import { loadConfig } from "../src/config.ts";

function writeConfig(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cozygateway-config-"));
  const path = join(dir, "cozygateway.config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("loadConfig", () => {
  it("loads a valid config and applies defaults", () => {
    const path = writeConfig({
      name: "test-gateway",
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
    });
    const config = loadConfig(path);
    expect(config.port).toBe(8787);
    expect(config.dbPath).toBe("cozygateway.db");
    expect(config.agents[0]?.backend).toBe("mock");
  });

  it("rejects a config with no agents", () => {
    const path = writeConfig({ name: "g", agents: [] });
    expect(() => loadConfig(path)).toThrow(ContractViolation);
  });

  it("rejects duplicate agent ids", () => {
    const path = writeConfig({
      name: "g",
      agents: [
        { id: "a", name: "A", backend: "mock" },
        { id: "a", name: "B", backend: "mock" },
      ],
    });
    expect(() => loadConfig(path)).toThrow(/duplicate agent id/i);
  });

  // Issue #16: capabilities is an optional gateway-level config field, surfaced as
  // GatewayInfo.capabilities.
  it("loads a config with no capabilities field (older-shape config keeps working)", () => {
    const path = writeConfig({
      name: "test-gateway",
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
    });
    expect(loadConfig(path).capabilities).toBeUndefined();
  });

  it("loads a populated capabilities map, preserving vendor ids verbatim", () => {
    const path = writeConfig({
      name: "test-gateway",
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
      capabilities: { "com.cozylabs.test": 1 },
    });
    expect(loadConfig(path).capabilities).toEqual({ "com.cozylabs.test": 1 });
  });

  it("rejects a non-integer capability version", () => {
    const path = writeConfig({
      name: "g",
      agents: [{ id: "a", name: "A", backend: "mock" }],
      capabilities: { "com.cozylabs.test": "one" },
    });
    expect(() => loadConfig(path)).toThrow(ContractViolation);
  });
});

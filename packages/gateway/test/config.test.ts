import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ContractViolation } from "cozygateway-contract";

import { applyEnvOverrides, loadConfig, type GatewayConfig } from "../src/config.ts";

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

const base: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: "cozygateway.db",
  agents: [{ id: "echo", name: "Echo", backend: "mock" }],
};

describe("applyEnvOverrides", () => {
  it("overrides host, port, and dbPath from the environment", () => {
    const next = applyEnvOverrides(base, {
      COZYGATEWAY_HOST: "0.0.0.0",
      COZYGATEWAY_PORT: "9000",
      COZYGATEWAY_DB_PATH: "/data/cozygateway.db",
    });
    expect(next.host).toBe("0.0.0.0");
    expect(next.port).toBe(9000);
    expect(next.dbPath).toBe("/data/cozygateway.db");
    // The original is not mutated.
    expect(base.host).toBeUndefined();
    expect(base.port).toBe(8787);
  });

  it("leaves the config unchanged when the env vars are unset or empty", () => {
    expect(applyEnvOverrides(base, {})).toEqual(base);
    expect(applyEnvOverrides(base, { COZYGATEWAY_HOST: "", COZYGATEWAY_PORT: "" })).toEqual(base);
  });

  it("throws on a non-integer or out-of-range COZYGATEWAY_PORT", () => {
    expect(() => applyEnvOverrides(base, { COZYGATEWAY_PORT: "not-a-port" })).toThrow(/COZYGATEWAY_PORT/);
    expect(() => applyEnvOverrides(base, { COZYGATEWAY_PORT: "70000" })).toThrow(/COZYGATEWAY_PORT/);
  });
});

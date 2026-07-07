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
});

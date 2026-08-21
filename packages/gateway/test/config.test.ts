import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ContractViolation } from "cozygateway-contract";

import { applyEnvOverrides, loadConfig, type GatewayConfig } from "../src/config.ts";
import { parseHermesOptions } from "../src/hermes-bridge/config.ts";

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

  it("rejects a config that serves nothing at all, naming both surfaces", () => {
    const empty = writeConfig({ name: "g", agents: [] });
    expect(() => loadConfig(empty)).toThrow(ContractViolation);
    expect(() => loadConfig(empty)).toThrow(/at least one entry in "agents", or a "hermes" bridge block/);
    // An omitted `agents` reads the same as an empty one, rather than as a schema error about a
    // missing key.
    expect(() => loadConfig(writeConfig({ name: "g" }))).toThrow(/at least one entry in "agents"/);
  });

  // A pure-bots gateway serves the hermes bridge and nothing else. A non-empty `agents` used to be
  // required, which forced a placeholder attach agent into the config of a box that serves no
  // attach agents at all.
  it("accepts a gateway with no agents when a hermes bridge is configured", () => {
    const path = writeConfig({
      name: "bots-only",
      agents: [],
      hermes: { url: "ws://homelab:8790/api/ws", tokenEnv: "HERMES_TOKEN" },
    });
    const config = loadConfig(path);
    expect(config.agents).toEqual([]);
    expect(config.hermes?.url).toBe("ws://homelab:8790/api/ws");

    const omitted = loadConfig(
      writeConfig({ name: "bots-only", hermes: { url: "ws://homelab:8790/api/ws", tokenEnv: "HERMES_TOKEN" } }),
    );
    expect(omitted.agents).toEqual([]);
  });

  it("carries the bridge's optional roster hide list through", () => {
    const path = writeConfig({
      name: "bots-only",
      hermes: { url: "ws://homelab:8790/api/ws", tokenEnv: "HERMES_TOKEN", hiddenProfiles: ["ops-runner"] },
    });
    expect(loadConfig(path).hermes?.hiddenProfiles).toEqual(["ops-runner"]);
  });

  it("accepts per-bot attach-v1 native and shadow migration gates", () => {
    const path = writeConfig({
      name: "native-bots",
      hermes: {
        url: "ws://homelab:8790/api/ws",
        tokenEnv: "HERMES_TOKEN",
        nativeDataPlane: {
          sage: { tokenEnv: "SAGE_ATTACH_TOKEN", mode: "native", features: { media: false, tools: true, interactions: false, clarify: true, scheduled: false } },
          pixel: { tokenEnv: "PIXEL_ATTACH_TOKEN", mode: "shadow" },
        },
      },
    });
    expect(loadConfig(path).hermes?.nativeDataPlane).toEqual({
      sage: { tokenEnv: "SAGE_ATTACH_TOKEN", mode: "native", features: { media: false, tools: true, interactions: false, clarify: true, scheduled: false } },
      pixel: { tokenEnv: "PIXEL_ATTACH_TOKEN", mode: "shadow" },
    });
  });

  it("normalizes the bridge's own profile name, which DELETE then refuses", () => {
    const path = writeConfig({
      name: "bots-only",
      hermes: { url: "ws://homelab:8790/api/ws", tokenEnv: "HERMES_TOKEN", profile: "  Ops-Host  " },
    });
    const parsed = parseHermesOptions(loadConfig(path).hermes!, { HERMES_TOKEN: "t" });
    expect(parsed.bridgeProfile).toBe("ops-host");
    // Absent by default: the guard is opt-in because the profile cannot be detected.
    const bare = writeConfig({
      name: "bots-only",
      hermes: { url: "ws://homelab:8790/api/ws", tokenEnv: "HERMES_TOKEN" },
    });
    expect(parseHermesOptions(loadConfig(bare).hermes!, { HERMES_TOKEN: "t" }).bridgeProfile).toBeUndefined();
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

  it("loads the private push relay target", () => {
    const path = writeConfig({
      name: "test-gateway",
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
      pushRelayUrl: "http://relay:8788",
    });
    expect(loadConfig(path).pushRelayUrl).toBe("http://relay:8788");
  });

  it("rejects a non-integer capability version", () => {
    const path = writeConfig({
      name: "g",
      agents: [{ id: "a", name: "A", backend: "mock" }],
      capabilities: { "com.cozylabs.test": "one" },
    });
    expect(() => loadConfig(path)).toThrow(ContractViolation);
  });

  // Issue #1460: turnTimeoutSeconds is a gateway-level wall-clock bound on a single agent turn,
  // defaulting to 600 via the same schema-default-plus-pre-validation-spread mechanism as port.
  it("defaults turnTimeoutSeconds to 600 when absent", () => {
    const path = writeConfig({
      name: "test-gateway",
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
    });
    expect(loadConfig(path).turnTimeoutSeconds).toBe(600);
  });

  it("accepts an explicit turnTimeoutSeconds from the config file", () => {
    const path = writeConfig({
      name: "test-gateway",
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
      turnTimeoutSeconds: 120,
    });
    expect(loadConfig(path).turnTimeoutSeconds).toBe(120);
  });

  it("accepts turnTimeoutSeconds of 0 (disables the bound)", () => {
    const path = writeConfig({
      name: "test-gateway",
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
      turnTimeoutSeconds: 0,
    });
    expect(loadConfig(path).turnTimeoutSeconds).toBe(0);
  });

  it("rejects a negative turnTimeoutSeconds", () => {
    const path = writeConfig({
      name: "g",
      agents: [{ id: "a", name: "A", backend: "mock" }],
      turnTimeoutSeconds: -1,
    });
    expect(() => loadConfig(path)).toThrow(ContractViolation);
  });
});

describe("reference deployment", () => {
  it("defaults push to the hosted CozyLabs relay", () => {
    const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
    expect(compose).toContain(
      'COZYGATEWAY_PUSH_RELAY_URL: "${COZYGATEWAY_PUSH_RELAY_URL:-https://push.cozylabs.ai}"',
    );
  });
});

const base: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: "cozygateway.db",
  turnTimeoutSeconds: 600,
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

  it("overrides the private push relay target", () => {
    const next = applyEnvOverrides(base, {
      COZYGATEWAY_PUSH_RELAY_URL: "http://relay:8788",
    });
    expect(next.pushRelayUrl).toBe("http://relay:8788");
    expect(base.pushRelayUrl).toBeUndefined();
  });
});

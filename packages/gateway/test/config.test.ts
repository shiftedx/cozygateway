import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ContractViolation } from "cozygateway-contract";

import { applyEnvOverrides, hermesEndpoints, loadConfig, publicProfileId,
  type GatewayConfig, type HermesBridgeConfig } from "../src/config.ts";
import { parseHermesOptions } from "../src/hermes-bridge/config.ts";

function writeConfig(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cozygateway-config-"));
  const path = join(dir, "cozygateway.config.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const hermes = {
  url: "ws://homelab:8790/api/ws",
  tokenEnv: "HERMES_TOKEN",
  profiles: { sage: { tokenEnv: "SAGE_ATTACH_TOKEN", name: "Sage" } },
};
const oneEndpoint = (config: HermesBridgeConfig = hermes) => [{ id: "default", ...config }];

describe("loadConfig", () => {
  it("loads a valid config and applies defaults", () => {
    const path = writeConfig({
      name: "test-gateway",
      hermesEndpoints: oneEndpoint(),
    });
    const config = loadConfig(path);
    expect(config.port).toBe(8787);
    expect(config.dbPath).toBe("cozygateway.db");
    expect(config.hermesEndpoints[0]?.profiles.sage?.tokenEnv).toBe("SAGE_ATTACH_TOKEN");
  });

  it("requires Hermes and at least one attach profile", () => {
    expect(() => loadConfig(writeConfig({ name: "g" }))).toThrow(ContractViolation);
    expect(() => loadConfig(writeConfig({ name: "g", hermesEndpoints: oneEndpoint({ url: hermes.url, profiles: {} }) }))).toThrow(
      ContractViolation,
    );

    const path = writeConfig({
      name: "bots-only",
      hermesEndpoints: oneEndpoint(),
    });
    const config = loadConfig(path);
    expect(config.hermesEndpoints[0]?.url).toBe(hermes.url);
  });

  it("carries the bridge's optional roster hide list through", () => {
    const path = writeConfig({
      name: "bots-only",
      hermesEndpoints: oneEndpoint({ ...hermes, hiddenProfiles: ["ops-runner"] }),
    });
    expect(loadConfig(path).hermesEndpoints[0]?.hiddenProfiles).toEqual(["ops-runner"]);
  });

  it("accepts one direct attach identity per Hermes profile", () => {
    const path = writeConfig({
      name: "native-bots",
      hermesEndpoints: oneEndpoint({
        url: "ws://homelab:8790/api/ws",
        tokenEnv: "HERMES_TOKEN",
        profiles: {
          sage: { tokenEnv: "SAGE_ATTACH_TOKEN", name: "Sage" },
          pixel: { tokenEnv: "PIXEL_ATTACH_TOKEN", avatar: "pixel.png" },
        },
      }),
    });
    expect(loadConfig(path).hermesEndpoints[0]?.profiles).toEqual({
      sage: { tokenEnv: "SAGE_ATTACH_TOKEN", name: "Sage" },
      pixel: { tokenEnv: "PIXEL_ATTACH_TOKEN", avatar: "pixel.png" },
    });
  });

  it("normalizes the bridge's own profile name, which DELETE then refuses", () => {
    const path = writeConfig({
      name: "bots-only",
      hermesEndpoints: oneEndpoint({ ...hermes, profile: "  Ops-Host  " }),
    });
    const parsed = parseHermesOptions(loadConfig(path).hermesEndpoints[0]!, { HERMES_TOKEN: "t" });
    expect(parsed.bridgeProfile).toBe("ops-host");
    // Absent by default: the guard is opt-in because the profile cannot be detected.
    const bare = writeConfig({
      name: "bots-only",
      hermesEndpoints: oneEndpoint(),
    });
    expect(parseHermesOptions(loadConfig(bare).hermesEndpoints[0]!, { HERMES_TOKEN: "t" }).bridgeProfile).toBeUndefined();
  });

  it("rejects duplicate normalized profile ids", () => {
    const path = writeConfig({
      name: "g",
      hermesEndpoints: oneEndpoint({ ...hermes, profiles: { Sage: { tokenEnv: "A" }, sage: { tokenEnv: "B" } } }),
    });
    expect(() => loadConfig(path)).toThrow(/duplicate Hermes profile id/i);
  });

  it("loads multiple endpoints and gives every profile a stable endpoint namespace", () => {
    const config = loadConfig(writeConfig({
      name: "federated",
      hermesEndpoints: [
        { id: "home", label: "Home Mac", ...hermes },
        { id: "studio", label: "Studio", ...hermes },
      ],
    }));
    expect(hermesEndpoints(config).map((endpoint) =>
      publicProfileId(endpoint, "sage"))).toEqual(["home:sage", "studio:sage"]);
  });

  it("rejects duplicate endpoint ids and the removed single-endpoint shape", () => {
    expect(() => loadConfig(writeConfig({
      name: "duplicate",
      hermesEndpoints: [
        { id: "home", ...hermes },
        { id: "home", ...hermes },
      ],
    }))).toThrow(/duplicate Hermes endpoint id/i);
    expect(() => loadConfig(writeConfig({ name: "removed", hermes }))).toThrow(ContractViolation);
  });

  // Issue #16: capabilities is an optional gateway-level config field, surfaced as
  // GatewayInfo.capabilities.
  it("loads a config with no capabilities field", () => {
    const path = writeConfig({
      name: "test-gateway",
      hermesEndpoints: oneEndpoint(),
    });
    expect(loadConfig(path).capabilities).toBeUndefined();
  });

  it("loads a populated capabilities map, preserving vendor ids verbatim", () => {
    const path = writeConfig({
      name: "test-gateway",
      hermesEndpoints: oneEndpoint(),
      capabilities: { "com.cozylabs.test": 1 },
    });
    expect(loadConfig(path).capabilities).toEqual({ "com.cozylabs.test": 1 });
  });

  it("loads the private push relay target", () => {
    const path = writeConfig({
      name: "test-gateway",
      hermesEndpoints: oneEndpoint(),
      pushRelayUrl: "http://relay:8788",
    });
    expect(loadConfig(path).pushRelayUrl).toBe("http://relay:8788");
  });

  it("canonicalizes a public HTTPS origin on a loopback listener", () => {
    const path = writeConfig({
      name: "public-gateway",
      host: "127.0.0.1",
      publicUrl: "HTTPS://Gateway.Example:443/",
      hermesEndpoints: oneEndpoint(),
    });
    expect(loadConfig(path).publicUrl).toBe("https://gateway.example");
  });

  it.each([
    "http://gateway.example",
    "https://user@gateway.example",
    "https://user:secret@gateway.example",
    "https://gateway.example/path",
    "https://gateway.example/path/..",
    "https://gateway.example?mode=public",
    "https://gateway.example#pair",
    " https://gateway.example ",
    "https://gateway.example\t",
    "https://gateway.example\r",
    "https://gateway.example\n",
    "https://gateway.example\0",
    "not a URL",
  ])("rejects a publicUrl that is not a strict HTTPS origin: %s", (publicUrl) => {
    expect(() => loadConfig(writeConfig({
      name: "public-gateway",
      host: "127.0.0.1",
      publicUrl,
      hermesEndpoints: oneEndpoint(),
    }))).toThrow(/publicUrl.*HTTPS origin/i);
  });

  it.each(["0.0.0.0", "192.168.1.20", "gateway.local"])(
    "rejects publicUrl on the non-loopback listener %s",
    (host) => {
      expect(() => loadConfig(writeConfig({
        name: "public-gateway",
        host,
        publicUrl: "https://gateway.example",
        hermesEndpoints: oneEndpoint(),
      }))).toThrow(/publicUrl.*loopback/i);
    },
  );

  it("rejects a non-integer capability version", () => {
    const path = writeConfig({
      name: "g",
      hermesEndpoints: oneEndpoint(),
      capabilities: { "com.cozylabs.test": "one" },
    });
    expect(() => loadConfig(path)).toThrow(ContractViolation);
  });

  // An active agent turn has no safe wall-clock ceiling: long tool runs and context compaction can
  // legitimately exceed ten minutes. Only an explicit operator policy may interrupt one.
  it("does not impose a turn timeout when turnTimeoutSeconds is absent", () => {
    const path = writeConfig({
      name: "test-gateway",
      hermesEndpoints: oneEndpoint(),
    });
    expect(loadConfig(path).turnTimeoutSeconds).toBe(0);
  });

  it("accepts an explicit turnTimeoutSeconds from the config file", () => {
    const path = writeConfig({
      name: "test-gateway",
      hermesEndpoints: oneEndpoint(),
      turnTimeoutSeconds: 120,
    });
    expect(loadConfig(path).turnTimeoutSeconds).toBe(120);
  });

  it("accepts turnTimeoutSeconds of 0 (disables the bound)", () => {
    const path = writeConfig({
      name: "test-gateway",
      hermesEndpoints: oneEndpoint(),
      turnTimeoutSeconds: 0,
    });
    expect(loadConfig(path).turnTimeoutSeconds).toBe(0);
  });

  it("rejects a negative turnTimeoutSeconds", () => {
    const path = writeConfig({
      name: "g",
      hermesEndpoints: oneEndpoint(),
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
    expect(compose).toContain("COZYGATEWAY_CONFIG_PATH");
    expect(compose).toContain("COZYGATEWAY_SECRETS_FILE");
    expect(compose).not.toContain("COZYGATEWAY_ATTACH_TOKEN");
    expect(compose).not.toContain("agents:");
  });
});

const base: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: "cozygateway.db",
  turnTimeoutSeconds: 600,
  hermesEndpoints: oneEndpoint(),
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

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IGNORED_BOTS_BLOCK_WARNING, loadConfig } from "../src/config.ts";

function writeConfig(body: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "cozygateway-config-"));
  const path = join(dir, "cozygateway.config.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const hermes = {
  id: "default",
  url: "ws://127.0.0.1:9119/api/ws",
  authMode: "token",
  tokenEnv: "T",
  profiles: { cleo: { tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_CLEO" } },
};

/** cozygateway connects Hermes bots. A CozyAgents runtime bot row used to validate and then be
 *  read by nothing, so its peer was refused `1008` forever while `/health` said `configured: 0`.
 *  `cozyagents init` printed that row through v0.2.17, so an upgraded config may still carry it:
 *  the gateway must start, drop it, and say so. */
describe("a config `bots` block", () => {
  it("is dropped at load and named, so an upgraded gateway still starts", () => {
    // The exact row `cozyagents init` prints.
    const path = writeConfig({
      name: "g",
      hermesEndpoints: [hermes],
      bots: [{ id: "mira", tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_MIRA", runtime: "cozyagents" }],
    });
    const warnings: string[] = [];
    const config = loadConfig(path, (message) => warnings.push(message));
    expect(config).not.toHaveProperty("bots");
    expect(config.hermesEndpoints).toHaveLength(1);
    expect(warnings).toEqual([IGNORED_BOTS_BLOCK_WARNING]);
    expect(IGNORED_BOTS_BLOCK_WARNING).toMatch(/`bots`.*cozygateway connects Hermes bots.*CozyAgents' bundled gateway/s);
  });

  it("is dropped on a gateway with no Hermes endpoint and when empty", () => {
    for (const bots of [[{ id: "sage", tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_SAGE", runtime: "cozyagents" }], []]) {
      const warnings: string[] = [];
      expect(loadConfig(writeConfig({ name: "g", bots }), (message) => warnings.push(message))).not.toHaveProperty("bots");
      expect(warnings).toHaveLength(1);
    }
  });

  it("leaves a Hermes config without one loading, with nothing to say", () => {
    const warnings: string[] = [];
    expect(loadConfig(writeConfig({ name: "g", hermesEndpoints: [hermes] }), (message) => warnings.push(message)).hermesEndpoints).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});

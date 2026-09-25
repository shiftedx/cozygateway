import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";

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
 *  read by nothing, so its peer was refused `1008` forever while `/health` said `configured: 0`. */
describe("a config `bots` block", () => {
  const refusal = /`bots`.*cozygateway connects Hermes bots.*CozyAgents' bundled gateway/s;

  it("is refused at load by name, naming where CozyAgents bots attach", () => {
    // The exact row `cozyagents init` prints.
    const path = writeConfig({
      name: "g",
      hermesEndpoints: [hermes],
      bots: [{ id: "mira", tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_MIRA", runtime: "cozyagents" }],
    });
    expect(() => loadConfig(path)).toThrow(refusal);
  });

  it("is refused on a gateway with no Hermes endpoint and when empty", () => {
    expect(() => loadConfig(writeConfig({
      name: "g",
      bots: [{ id: "sage", tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_SAGE", runtime: "cozyagents" }],
    }))).toThrow(refusal);
    expect(() => loadConfig(writeConfig({ name: "g", hermesEndpoints: [hermes], bots: [] }))).toThrow(refusal);
  });

  it("leaves a Hermes config without one loading", () => {
    expect(loadConfig(writeConfig({ name: "g", hermesEndpoints: [hermes] })).hermesEndpoints).toHaveLength(1);
  });
});

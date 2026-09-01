import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, nativeBots } from "../src/config.ts";

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

describe("native runtime bots config", () => {
  it("parses a bots entry", () => {
    const config = loadConfig(writeConfig({
      name: "g",
      hermesEndpoints: [hermes],
      bots: [{ id: "sage", name: "Sage", tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_SAGE", runtime: "cozyagents" }],
    }));
    expect(nativeBots(config)).toEqual([
      { id: "sage", name: "Sage", tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_SAGE", runtime: "cozyagents" },
    ]);
  });

  it("defaults to no native bots", () => {
    expect(nativeBots(loadConfig(writeConfig({ name: "g", hermesEndpoints: [hermes] })))).toEqual([]);
  });

  it("rejects a bot id that collides with a Hermes profile", () => {
    expect(() =>
      loadConfig(writeConfig({ name: "g", hermesEndpoints: [hermes], bots: [{ id: "cleo", tokenEnv: "X", runtime: "cozyagents" }] })),
    ).toThrow(/duplicate/);
  });

  it("rejects an unknown runtime", () => {
    expect(() =>
      loadConfig(writeConfig({ name: "g", hermesEndpoints: [hermes], bots: [{ id: "sage", tokenEnv: "X", runtime: "other" }] })),
    ).toThrow();
  });
});

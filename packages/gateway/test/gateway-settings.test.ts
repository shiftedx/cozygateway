import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { fileGatewaySettings } from "../src/gateway-settings.ts";

function fixture(): string {
  const path = join(mkdtempSync(join(tmpdir(), "cozygateway-settings-")), "config.json");
  writeFileSync(path, JSON.stringify({
    name: "Old name",
    port: 8787,
    dbPath: "cozy.db",
    turnTimeoutSeconds: 0,
    hermes: {
      url: "ws://home:8790/api/ws",
      tokenEnv: "HERMES_SESSION",
      profiles: { sage: { tokenEnv: "SAGE_ATTACH" } },
    },
  }), { mode: 0o640 });
  return path;
}

describe("fileGatewaySettings", () => {
  it("migrates legacy config, persists atomically, preserves permissions, and survives reload", () => {
    const path = fixture();
    const manager = fileGatewaySettings(path);
    expect(manager.read()).toEqual({
      name: "Old name",
      hermesEndpoints: [{
        id: "default", label: "Hermes", url: "ws://home:8790/api/ws",
        tokenEnv: "HERMES_SESSION", profiles: { sage: { tokenEnv: "SAGE_ATTACH" } },
      }],
    });

    const response = manager.update({
      name: "Living Room",
      hermesEndpoints: [
        { id: "home", label: "Home Mac", url: "ws://home:8790/api/ws", tokenEnv: "HOME_SESSION", profiles: { sage: { tokenEnv: "SAGE_ATTACH" } } },
        { id: "studio", label: "Studio", url: "wss://studio.example/api/ws", passwordEnv: "STUDIO_PASSWORD", authMode: "password", username: "kim", profiles: { sage: { tokenEnv: "STUDIO_SAGE_ATTACH" } } },
      ],
    });
    expect(response.restartRequired).toBe(true);
    expect(fileGatewaySettings(path).read().hermesEndpoints.map((e) => e.id)).toEqual(["home", "studio"]);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    const disk = readFileSync(path, "utf8");
    expect(disk).not.toContain("Old name");
    expect(disk).not.toContain("actual-secret");
  });

  it("rejects credential values and duplicate endpoint ids without changing disk", () => {
    const path = fixture();
    const before = readFileSync(path, "utf8");
    const manager = fileGatewaySettings(path);
    expect(() => manager.update({
      name: "Nope",
      hermesEndpoints: [{
        id: "home", url: "ws://home:8790/api/ws", token: "actual-secret",
        profiles: { sage: { tokenEnv: "SAGE_ATTACH" } },
      }],
    })).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);

    expect(() => manager.update({
      name: "Nope",
      hermesEndpoints: [
        { id: "home", url: "ws://one", tokenEnv: "ONE", profiles: { sage: { tokenEnv: "A" } } },
        { id: "home", url: "ws://two", tokenEnv: "TWO", profiles: { pixel: { tokenEnv: "B" } } },
      ],
    })).toThrow(/duplicate/i);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

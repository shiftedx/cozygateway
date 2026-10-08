import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const validator = join(import.meta.dirname, "../dist/cli.js");
const installer = readFileSync(join(import.meta.dirname, "../../../scripts/agent-install.sh"), "utf8");
// Execute the writer shipped in the installer; this does not register services or touch Hermes.
const writer = installer.match(/write_gateway_config\(\)[\s\S]*?<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)?.[1];
const scopeRepair = installer.match(/hydrate_profile_scope\(\)[\s\S]*?<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)?.[1];

function repairConfig(existing: unknown, check: (path: string, result: ReturnType<typeof spawnSync>, repeat: () => ReturnType<typeof spawnSync>) => void): void {
  const root = mkdtempSync(join(tmpdir(), "gateway-config-repair-"));
  try {
    const configPath = join(root, "gateway.json");
    const mapPath = join(root, "profiles.json");
    if (existing !== undefined) writeFileSync(configPath, JSON.stringify(existing));
    writeFileSync(mapPath, JSON.stringify({ default: { tokenEnv: "NEW_DEFAULT_TOKEN" }, added: { tokenEnv: "NEW_ADDED_TOKEN" } }));
    expect(writer).toBeDefined();
    expect(() => readFileSync(validator)).not.toThrow();
    const run = () => spawnSync(process.execPath, ["-", mapPath, configPath, "127.0.0.1", "8787", join(root, "managed.db"), "9119", "", "https://relay.example.com", validator], { input: writer, encoding: "utf8" });
    check(configPath, run(), run);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("installer configuration repair", () => {
  it.each([
    { scope: "single managed endpoint", independentPresent: false, managedId: "default", duplicate: false, allowed: true },
    { scope: "managed endpoint beside independent endpoint", independentPresent: true, managedId: "default", duplicate: false, allowed: true },
    { scope: "single independent endpoint", independentPresent: false, managedId: "custom", duplicate: false, allowed: false },
    { scope: "duplicate managed endpoints", independentPresent: true, managedId: "default", duplicate: true, allowed: false },
  ])("repairs absent recorded local profiles only for an unambiguous managed endpoint: $scope", ({ independentPresent, managedId, duplicate, allowed }) => {
    const root = mkdtempSync(join(tmpdir(), "gateway-profile-repair-"));
    try {
      const hermesRoot = join(root, "hermes");
      mkdirSync(hermesRoot);
      writeFileSync(join(hermesRoot, "config.yaml"), "model: fixture\n");
      const statePath = join(root, "install-state");
      const configPath = join(root, "gateway.json");
      const envPath = join(root, "gateway.env");
      const mapPath = join(root, "profiles.json");
      writeFileSync(statePath, `hermes_root=${hermesRoot}\nprofiles=default,absent-profile\nprofile_scope=narrow\n`);
      writeFileSync(envPath, "COZYGATEWAY_ATTACH_TOKEN_ABSENT_PROFILE=" + "x".repeat(32) + "\n");
      const managed = { id: managedId, url: "ws://127.0.0.1:9119/api/ws", profiles: { default: { tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_DEFAULT", name: "Friendly bot" }, "absent-profile": { tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_ABSENT_PROFILE" } } };
      const remote = { id: "remote", url: "wss://remote.example.com/api/ws", profiles: { unrelated: { tokenEnv: "REMOTE_TOKEN" } } };
      const endpoints = independentPresent ? [remote, managed] : [managed];
      if (duplicate) endpoints.push(managed);
      writeFileSync(configPath, JSON.stringify({ name: "gateway", dbPath: "operator.db", hermesEndpoints: endpoints }));
      const before = readFileSync(configPath, "utf8");
      expect(scopeRepair).toBeDefined();
      const result = spawnSync(process.execPath, ["-", statePath, configPath, envPath, hermesRoot, "default,absent-profile"], { input: scopeRepair, encoding: "utf8" });
      expect(readFileSync(configPath, "utf8")).toBe(before);
      if (!allowed) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("ownership is ambiguous");
        return;
      }
      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.stdout).toBe("default");
      writeFileSync(mapPath, JSON.stringify(Object.fromEntries(String(result.stdout).split(",").map(id => [id, { tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_" + id.toUpperCase() }]))));
      const written = spawnSync(process.execPath, ["-", mapPath, configPath, "127.0.0.1", "8787", join(root, "managed.db"), "9119", "", "https://relay.example.com", validator], { input: writer, encoding: "utf8" });
      expect(written.status, String(written.stderr)).toBe(0);
      const config = loadConfig(configPath);
      expect(config.hermesEndpoints?.find(endpoint => endpoint.id === "default")?.profiles).toEqual({ default: { tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_DEFAULT", name: "Friendly bot" } });
      if (independentPresent) expect(config.hermesEndpoints?.find(endpoint => endpoint.id === "remote")).toEqual(remote);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves operator settings while refreshing managed connection and selected profiles", () => {
    const existing = {
      name: "Operator gateway", host: "127.0.0.1", port: 8787, dbPath: "operator.db",
      observability: { enabled: true, retentionDays: 7 }, pushRelayUrl: "https://custom-relay.example.com",
      hermesEndpoints: [{
        id: "default", label: "Operator Hermes", url: "wss://old.example.com/api/ws",
        authMode: "password", authParam: "ticket", username: "old-user", passwordEnv: "OLD_PASSWORD", provider: "old-provider", baseUrl: "https://old.example.com",
        hiddenProfiles: ["ops"], seedBlankSlateBots: false, blankSlateSkillsOn: ["example-skill"], chatSuggestion: "",
        profiles: { default: { tokenEnv: "OLD_TOKEN", name: "Friendly bot", avatar: "bot.png" }, removed: { tokenEnv: "OLD_REMOVED_TOKEN" } },
      }],
    };
    repairConfig(existing, (path, result) => {
      expect(result.status, String(result.stderr)).toBe(0);
      const config = loadConfig(path);
      expect(config).toMatchObject({ name: existing.name, dbPath: existing.dbPath, observability: existing.observability, pushRelayUrl: existing.pushRelayUrl });
      expect(config.hermesEndpoints).toEqual([{
        id: "default", label: "Operator Hermes", url: "ws://127.0.0.1:9119/api/ws", authMode: "token",
        tokenEnv: "COZYGATEWAY_HERMES_TOKEN", profile: "default",
        hiddenProfiles: ["ops"], seedBlankSlateBots: false, blankSlateSkillsOn: ["example-skill"], chatSuggestion: "",
        profiles: { default: { tokenEnv: "NEW_DEFAULT_TOKEN", name: "Friendly bot", avatar: "bot.png" }, added: { tokenEnv: "NEW_ADDED_TOKEN" } },
      }]);
    });
  });

  it("uses managed defaults on a fresh install", () => {
    repairConfig(undefined, (path, result) => {
      expect(result.status, String(result.stderr)).toBe(0);
      expect(loadConfig(path)).toMatchObject({
        name: "cozygateway", dbPath: join(path, "..", "managed.db"), pushRelayUrl: "https://relay.example.com",
        hermesEndpoints: [{ id: "default", url: "ws://127.0.0.1:9119/api/ws", profiles: { default: { tokenEnv: "NEW_DEFAULT_TOKEN" }, added: { tokenEnv: "NEW_ADDED_TOKEN" } } }],
      });
    });
  });

  it.each([true, false])("preserves independent endpoints when managed endpoint exists: %s", (managedPresent) => {
    const remote = { id: "remote", url: "wss://remote.example.com/api/ws", authMode: "token", tokenEnv: "REMOTE_TOKEN", profiles: { default: { tokenEnv: "REMOTE_PROFILE_TOKEN", name: "Remote bot" } } };
    const managed = { id: "default", url: "ws://127.0.0.1:9000/api/ws", profiles: { default: { tokenEnv: "OLD_TOKEN" } } };
    repairConfig({ name: "gateway", dbPath: "operator.db", hermesEndpoints: managedPresent ? [remote, managed] : [remote] }, (path, result, repeat) => {
      expect(result.status, String(result.stderr)).toBe(0);
      const config = loadConfig(path);
      expect(config.hermesEndpoints?.find(endpoint => endpoint.id === "remote")).toEqual(remote);
      expect(config.hermesEndpoints?.find(endpoint => endpoint.id === "default")).toMatchObject({ url: "ws://127.0.0.1:9119/api/ws", profiles: { default: { tokenEnv: "NEW_DEFAULT_TOKEN" } } });
      const before = readFileSync(path, "utf8");
      // Repeat the identical writer invocation against its output, as an unattended repair does.
      const repeated = repeat();
      expect(repeated.status, String(repeated.stderr)).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  });

  it.each([
    { name: "", dbPath: "operator.db" },
    { name: "gateway", dbPath: 42 },
    { name: "gateway", observability: { enabled: "yes" } },
    { name: "gateway", hermesEndpoints: [{ id: "default", url: "ws://127.0.0.1:9119/api/ws", label: 1 }] },
    { name: "gateway", hermesEndpoints: [{ id: "remote", url: "wss://remote.example.com/api/ws", profiles: { default: { name: 1 } } }] },
    { name: "gateway", hermesEndpoints: [{ id: "remote", url: "wss://remote.example.com/api/ws" }, { id: "remote", url: "wss://other.example.com/api/ws" }] },
  ].map(existing => ({ existing })))("refuses invalid retained settings before replacing saved bytes: $existing", ({ existing }) => {
    repairConfig(existing, (path, result) => {
      expect(result.status).not.toBe(0);
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify(existing));
      expect(readdirSync(join(path, "..")).filter(name => name.startsWith("gateway.json.new-"))).toEqual([]);
    });
  });

  it.each([null, [], "invalid", { name: "gateway", hermesEndpoints: "invalid" }].map(existing => ({ existing })))("refuses invalid saved configuration without replacing it: $existing", ({ existing }) => {
    repairConfig(existing, (path, result) => {
      expect(result.status).not.toBe(0);
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify(existing));
      expect(readdirSync(join(path, "..")).filter(name => name.startsWith("gateway.json.new-"))).toEqual([]);
    });
  });
});

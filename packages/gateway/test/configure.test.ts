import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compareAndSwapManagedListener,
  parseListenerPort,
  readManagedListenerSnapshot,
  listenerOrigin,
  SqliteOnboardingAuthority,
  syncManagedListenerTargets,
  updateListenerConfig,
  validateListenerHost,
} from "../src/configure.ts";
import { loadConfig } from "../src/config.ts";
import { openStorage } from "../src/storage.ts";

function configFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cozygateway-configure-"));
  const path = join(dir, "cozygateway.config.json");
  writeFileSync(
    path,
    JSON.stringify({
      name: "managed",
      host: "0.0.0.0",
      port: 8787,
      dbPath: join(dir, "gateway.db"),
      capabilities: { "com.cozylabs.test": 7 },
      hermes: {
        url: "ws://127.0.0.1:9119/api/ws",
        profiles: { default: { tokenEnv: "COZYGATEWAY_TOKEN" } },
      },
    }),
  );
  return path;
}

describe("listener configuration", () => {
  it("reads onboarding authority and runtime context from the same SQLite storage", async () => {
    const storage = openStorage(":memory:");
    const authority = new SqliteOnboardingAuthority(storage);
    expect(await authority.status()).toEqual({ state: "none" });
    storage.beginGatewayBoot({
      bootGeneration: "boot-1",
      verificationEpoch: "epoch-1",
      canonicalOrigin: "https://cozy.example.ts.net",
      durableFingerprint: "posture-1",
      startedAt: 10,
    });
    expect(authority.runtimeContext()).toEqual({ verificationEpoch: "epoch-1", bootGeneration: "boot-1" });
    storage.beginSetupSession({
      sessionId: "session-1",
      mode: "tailscale",
      canonicalOrigin: "https://cozy.example.ts.net",
      durableFingerprint: "posture-1",
      verificationEpoch: "epoch-1",
      bootGeneration: "boot-1",
      createdAt: 11,
    });
    expect(await authority.status()).toEqual({
      state: "active",
      mode: "tailscale",
      canonicalOrigin: "https://cozy.example.ts.net",
      durableFingerprint: "posture-1",
    });
    storage.close();
  });

  it("accepts bind addresses and ports supported by the gateway", () => {
    expect(validateListenerHost("0.0.0.0")).toBe("0.0.0.0");
    expect(validateListenerHost("::")).toBe("::");
    expect(validateListenerHost("gateway.lan")).toBe("gateway.lan");
    expect(parseListenerPort("1")).toBe(1);
    expect(parseListenerPort("65535")).toBe(65535);
  });

  it("rejects URLs, whitespace, and invalid ports", () => {
    expect(() => validateListenerHost("http://0.0.0.0")).toThrow(/address/i);
    expect(() => validateListenerHost("gateway lan")).toThrow(/address/i);
    expect(() => validateListenerHost("example.com:9000")).toThrow(/address/i);
    expect(() => validateListenerHost("[::1]")).toThrow(/address/i);
    expect(() => validateListenerHost("http:localhost")).toThrow(/address/i);
    expect(() => validateListenerHost("-bad.example")).toThrow(/address/i);
    expect(() => validateListenerHost(" ")).toThrow(/address/i);
    expect(() => parseListenerPort("0")).toThrow(/1.*65535/);
    expect(() => parseListenerPort("12.5")).toThrow(/1.*65535/);
    expect(() => parseListenerPort("65536")).toThrow(/1.*65535/);
  });

  it("builds reachable local origins for wildcard, specific, IPv6, and TLS listeners", () => {
    expect(listenerOrigin("0.0.0.0", 8787, "http")).toBe("http://127.0.0.1:8787");
    expect(listenerOrigin("192.168.1.20", 9000, "http")).toBe("http://192.168.1.20:9000");
    expect(listenerOrigin("::", 9443, "https")).toBe("https://[::1]:9443");
  });

  it("atomically changes only host and port", () => {
    const path = configFile();
    updateListenerConfig(path, "127.0.0.1", 9000);

    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(raw.host).toBe("127.0.0.1");
    expect(raw.port).toBe(9000);
    expect(raw.capabilities).toEqual({ "com.cozylabs.test": 7 });
    expect(loadConfig(path).hermes.profiles.default?.tokenEnv).toBe("COZYGATEWAY_TOKEN");
  });

  it("does not modify the file when the requested listener is invalid", () => {
    const path = configFile();
    const before = readFileSync(path, "utf8");
    expect(() => updateListenerConfig(path, "bad host", 8787)).toThrow(/address/i);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("does not move a configured public origin off loopback", () => {
    const path = configFile();
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    config.host = "127.0.0.1";
    config.publicUrl = "https://gateway.example";
    writeFileSync(path, JSON.stringify(config));
    const before = readFileSync(path, "utf8");

    expect(() => updateListenerConfig(path, "0.0.0.0", 8787)).toThrow(/publicUrl.*loopback/i);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("lets an explicitly selected managed route retire an old advanced public origin", () => {
    const path = configFile();
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    config.host = "127.0.0.1";
    config.publicUrl = "https://gateway.example";
    writeFileSync(path, JSON.stringify(config));

    updateListenerConfig(path, "0.0.0.0", 8787, { clearPublicUrl: true });

    expect(loadConfig(path).host).toBe("0.0.0.0");
    expect(loadConfig(path).publicUrl).toBeUndefined();
  });

  it("updates every installer-managed Hermes profile target without exposing or changing tokens", () => {
    const path = configFile();
    const localDir = dirname(path);
    const hermesRoot = join(localDir, "hermes");
    const defaultEnv = join(hermesRoot, ".env");
    const opsEnv = join(hermesRoot, "profiles", "ops", ".env");
    mkdirSync(dirname(defaultEnv), { recursive: true });
    mkdirSync(dirname(opsEnv), { recursive: true });
    writeFileSync(join(localDir, "install-state"), `profiles=default,ops\nhermes_root=${hermesRoot}\nhermes_bin=${join(hermesRoot, "bin", "hermes")}\n`);
    writeFileSync(defaultEnv, "COZYGATEWAY_URL=http://127.0.0.1:8787\nCOZYGATEWAY_TOKEN=default-secret\n");
    writeFileSync(opsEnv, "COZYGATEWAY_TOKEN=ops-secret\nCOZYGATEWAY_URL=http://127.0.0.1:8787\n");

    updateListenerConfig(path, "0.0.0.0", 9000);
    const managed = syncManagedListenerTargets(path);

    expect(managed.map((entry) => entry.profile)).toEqual(["default", "ops"]);
    expect(readFileSync(defaultEnv, "utf8")).toBe(
      "COZYGATEWAY_URL=http://127.0.0.1:9000\nCOZYGATEWAY_TOKEN=default-secret\n",
    );
    expect(readFileSync(opsEnv, "utf8")).toBe(
      "COZYGATEWAY_TOKEN=ops-secret\nCOZYGATEWAY_URL=http://127.0.0.1:9000\n",
    );
  });

  it("CAS compares complete config and actual Hermes files before changing a managed listener", () => {
    const path = configFile();
    const localDir = dirname(path);
    const hermesRoot = join(localDir, "hermes-cas");
    mkdirSync(hermesRoot, { recursive: true });
    writeFileSync(join(localDir, "install-state"), `profiles=default\nhermes_root=${hermesRoot}\nhermes_bin=${join(hermesRoot, "hermes")}\n`);
    const envPath = join(hermesRoot, ".env");
    writeFileSync(envPath, "COZYGATEWAY_URL=http://127.0.0.1:8787\nCOZYGATEWAY_TOKEN=secret\n");
    const expected = readManagedListenerSnapshot(path);

    const concurrent = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    concurrent.publicUrl = "https://gateway.example";
    concurrent.tls = { certFile: "cert.pem", keyFile: "key.pem" };
    concurrent.futureSetting = { preserved: true };
    writeFileSync(path, JSON.stringify(concurrent));
    expect(compareAndSwapManagedListener(path, expected, "0.0.0.0", 9000, { clearPublicUrl: true })).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(concurrent);

    writeFileSync(path, expected.configText);
    writeFileSync(envPath, "COZYGATEWAY_URL=http://127.0.0.1:9999\nCOZYGATEWAY_TOKEN=secret\n");
    expect(compareAndSwapManagedListener(path, expected, "0.0.0.0", 9000, { clearPublicUrl: true })).toBe(false);
    expect(readFileSync(envPath, "utf8")).toContain("127.0.0.1:9999");
  });

  it("serializes concurrent managed writers and rollback never deletes a later edit", () => {
    const path = configFile();
    const initial = readManagedListenerSnapshot(path);
    expect(compareAndSwapManagedListener(path, initial, "0.0.0.0", 9000, { clearPublicUrl: true })).toBe(true);
    expect(compareAndSwapManagedListener(path, initial, "127.0.0.1", 9443, { clearPublicUrl: true })).toBe(false);
    const prepared = readManagedListenerSnapshot(path);
    updateListenerConfig(path, "192.168.1.50", 9555, { clearPublicUrl: true });
    expect(compareAndSwapManagedListener(path, prepared, "127.0.0.1", 8787, { clearPublicUrl: true })).toBe(false);
    expect(loadConfig(path)).toMatchObject({ host: "192.168.1.50", port: 9555 });
  });

  it("reports a real live listener writer lock as a typed resumable listener change", () => {
    const path = configFile();
    const lockPath = `${path}.listener.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      version: 1, pid: process.pid, nonce: "a".repeat(32),
    })}\n`);

    expect(() => readManagedListenerSnapshot(path)).toThrow(expect.objectContaining({
      retryable: true, reason: "listener_changed",
    }));
    expect(readFileSync(join(lockPath, "owner.json"), "utf8")).toContain(`"pid":${process.pid}`);
  });

  it("quarantines one exactly verified dead owner and recovers the stale writer lock", () => {
    const path = configFile();
    const expected = readManagedListenerSnapshot(path);
    const lockPath = `${path}.listener.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      version: 1, pid: 2_147_483_647, nonce: "c".repeat(32),
    })}\n`);

    expect(compareAndSwapManagedListener(path, expected, "127.0.0.1", 9000)).toBe(true);
    expect(loadConfig(path)).toMatchObject({ host: "127.0.0.1", port: 9000 });
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(dirname(path)).filter((name) => name.includes(".listener.lock.stale."))).toEqual([]);
  });

  it("fails closed without changing a malformed lock owner", () => {
    const path = configFile();
    const original = readFileSync(path, "utf8");
    const lockPath = `${path}.listener.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), "not bounded owner json\n");

    expect(() => updateListenerConfig(path, "127.0.0.1", 9000)).toThrow(expect.objectContaining({
      retryable: true, reason: "listener_changed",
    }));
    expect(readFileSync(join(lockPath, "owner.json"), "utf8")).toBe("not bounded owner json\n");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("never broadly deletes an unrecognized entry while checking a dead stale lock", () => {
    const path = configFile();
    const lockPath = `${path}.listener.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      version: 1, pid: 2_147_483_647, nonce: "d".repeat(32),
    })}\n`);
    writeFileSync(join(lockPath, "preserve-me"), "owned by another writer\n");

    expect(() => readManagedListenerSnapshot(path)).toThrow(expect.objectContaining({
      retryable: true, reason: "listener_changed",
    }));
    expect(readFileSync(join(lockPath, "preserve-me"), "utf8")).toBe("owned by another writer\n");
    expect(readdirSync(dirname(path)).filter((name) => name.includes(".listener.lock.stale."))).toEqual([]);
  });

  it("uses https for managed Hermes targets when gateway-native TLS is configured", () => {
    const path = configFile();
    const localDir = dirname(path);
    const hermesRoot = join(localDir, "hermes-tls");
    mkdirSync(hermesRoot, { recursive: true });
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    config.tls = { certFile: "cert.pem", keyFile: "key.pem" };
    config.port = 9443;
    writeFileSync(path, JSON.stringify(config));
    writeFileSync(join(localDir, "install-state"), `profiles=default\nhermes_root=${hermesRoot}\nhermes_bin=${join(hermesRoot, "hermes")}\n`);
    writeFileSync(join(hermesRoot, ".env"), "COZYGATEWAY_URL=https://gateway.lan:8787\nCOZYGATEWAY_TOKEN=secret\n");

    syncManagedListenerTargets(path);

    expect(readFileSync(join(hermesRoot, ".env"), "utf8")).toContain("COZYGATEWAY_URL=https://gateway.lan:9443");
  });

  it("refuses to invent a certificate hostname for a managed TLS target", () => {
    const path = configFile();
    const localDir = dirname(path);
    const hermesRoot = join(localDir, "hermes-tls-missing-name");
    mkdirSync(hermesRoot, { recursive: true });
    const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    config.tls = { certFile: "cert.pem", keyFile: "key.pem" };
    writeFileSync(path, JSON.stringify(config));
    writeFileSync(join(localDir, "install-state"), `profiles=default\nhermes_root=${hermesRoot}\nhermes_bin=${join(hermesRoot, "hermes")}\n`);
    writeFileSync(join(hermesRoot, ".env"), "COZYGATEWAY_URL=http://127.0.0.1:8787\nCOZYGATEWAY_TOKEN=secret\n");

    expect(() => syncManagedListenerTargets(path)).toThrow(/existing https.*certificate hostname/i);
  });
});

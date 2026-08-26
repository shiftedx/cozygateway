import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseListenerPort,
  listenerOrigin,
  syncManagedListenerTargets,
  updateListenerConfig,
  validateListenerHost,
} from "../src/configure.ts";
import { loadConfig } from "../src/config.ts";

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
    writeFileSync(join(hermesRoot, ".env"), "COZYGATEWAY_URL=http://127.0.0.1:8787\nCOZYGATEWAY_TOKEN=secret\n");

    syncManagedListenerTargets(path);

    expect(readFileSync(join(hermesRoot, ".env"), "utf8")).toContain("COZYGATEWAY_URL=https://127.0.0.1:9443");
  });
});

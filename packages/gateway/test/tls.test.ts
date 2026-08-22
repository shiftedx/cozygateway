import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { testHermes } from "./support/test-config.ts";
import { applyEnvOverrides, type GatewayConfig } from "../src/config.ts";
import { resolveTlsMaterial, gatewayScheme } from "../src/tls.ts";
import { generateSelfSigned, writeGarbage } from "./helpers/self-signed.ts";

const baseConfig: GatewayConfig = {
  name: "gw",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermes: testHermes(),
};

describe("resolveTlsMaterial", () => {
  it("returns undefined when no TLS is configured, so the plain-HTTP path is untouched", () => {
    expect(resolveTlsMaterial(undefined)).toBeUndefined();
  });

  it("loads a valid pair", () => {
    const pair = generateSelfSigned();
    const material = resolveTlsMaterial({ certFile: pair.certFile, keyFile: pair.keyFile });
    expect(material).toBeDefined();
    expect(material?.cert.toString("utf8")).toContain("BEGIN CERTIFICATE");
    expect(material?.key.toString("utf8")).toContain("PRIVATE KEY");
  });

  it("fails loudly when the cert file is missing", () => {
    const pair = generateSelfSigned();
    expect(() =>
      resolveTlsMaterial({ certFile: join(pair.dir, "nope.pem"), keyFile: pair.keyFile }),
    ).toThrow(/nope\.pem/);
  });

  it("fails loudly when the key file is missing", () => {
    const pair = generateSelfSigned();
    expect(() =>
      resolveTlsMaterial({ certFile: pair.certFile, keyFile: join(pair.dir, "nokey.pem") }),
    ).toThrow(/nokey\.pem/);
  });

  it("fails loudly when the cert is garbage rather than a PEM", () => {
    const pair = generateSelfSigned();
    const garbage = writeGarbage(pair.dir, "garbage-cert.pem");
    expect(() => resolveTlsMaterial({ certFile: garbage, keyFile: pair.keyFile })).toThrow(
      /garbage-cert\.pem/,
    );
  });

  it("fails loudly when the key is garbage rather than a PEM", () => {
    const pair = generateSelfSigned();
    const garbage = writeGarbage(pair.dir, "garbage-key.pem");
    expect(() => resolveTlsMaterial({ certFile: pair.certFile, keyFile: garbage })).toThrow(
      /garbage-key\.pem/,
    );
  });

  it("fails loudly when the cert and key are each valid but do not match", () => {
    const first = generateSelfSigned();
    const second = generateSelfSigned();
    expect(() => resolveTlsMaterial({ certFile: first.certFile, keyFile: second.keyFile })).toThrow(
      /TLS/i,
    );
  });
});

describe("gatewayScheme", () => {
  it("is http without TLS and https with it", () => {
    expect(gatewayScheme(baseConfig)).toBe("http");
    expect(gatewayScheme({ ...baseConfig, tls: { certFile: "c", keyFile: "k" } })).toBe("https");
  });
});

describe("applyEnvOverrides TLS", () => {
  it("leaves TLS unset when the env carries neither variable (plain-HTTP default is pinned)", () => {
    expect(applyEnvOverrides(baseConfig, {}).tls).toBeUndefined();
    expect(applyEnvOverrides(baseConfig, { COZY_TLS_CERT_FILE: "", COZY_TLS_KEY_FILE: "" }).tls).toBeUndefined();
  });

  it("turns TLS on from the environment", () => {
    const next = applyEnvOverrides(baseConfig, {
      COZY_TLS_CERT_FILE: "/certs/cert.pem",
      COZY_TLS_KEY_FILE: "/certs/key.pem",
    });
    expect(next.tls).toEqual({ certFile: "/certs/cert.pem", keyFile: "/certs/key.pem" });
    expect(baseConfig.tls).toBeUndefined();
  });

  it("refuses a half-configured pair from the environment, naming both variables", () => {
    expect(() => applyEnvOverrides(baseConfig, { COZY_TLS_CERT_FILE: "/certs/cert.pem" })).toThrow(
      /COZY_TLS_KEY_FILE/,
    );
    expect(() => applyEnvOverrides(baseConfig, { COZY_TLS_KEY_FILE: "/certs/key.pem" })).toThrow(
      /COZY_TLS_CERT_FILE/,
    );
  });

  it("lets one env variable complete a config-file half", () => {
    const config = { ...baseConfig, tls: { certFile: "/from-config/cert.pem", keyFile: "/from-config/key.pem" } };
    const next = applyEnvOverrides(config, { COZY_TLS_CERT_FILE: "/env/cert.pem" });
    expect(next.tls).toEqual({ certFile: "/env/cert.pem", keyFile: "/from-config/key.pem" });
  });
});

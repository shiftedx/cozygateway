import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.ts";
import { openStorage } from "../src/storage.ts";

function tempConfig(extra: Record<string, unknown> = {}): { configPath: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cozygateway-cli-"));
  const dbPath = join(dir, "gw.db");
  const configPath = join(dir, "cozygateway.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "cli-gw",
      port: 18787,
      dbPath,
      hermes: {
        url: "ws://127.0.0.1:1/api/ws",
        tokenEnv: "TEST_HERMES_CONTROL_TOKEN",
        profiles: { sage: { tokenEnv: "TEST_ATTACH_TOKEN", name: "Sage" } },
      },
      ...extra,
    }),
  );
  return { configPath, dbPath };
}

async function pairPayload(configPath: string): Promise<{ gatewayUrl: string; setupCode: string }> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  const exitCode = await runCli(["pair", "--config", configPath]);
  vi.restoreAllMocks();
  expect(exitCode).toBe(0);
  const payloadLine = lines.find((l) => l.startsWith("{"));
  expect(payloadLine).toBeDefined();
  return JSON.parse(payloadLine ?? "{}") as { gatewayUrl: string; setupCode: string };
}

describe("cozygateway pair", () => {
  it("prints a QR payload and persists the code", async () => {
    const { configPath, dbPath } = tempConfig();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const exitCode = await runCli(["pair", "--config", configPath]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(0);

    const payloadLine = lines.find((l) => l.startsWith("{"));
    expect(payloadLine).toBeDefined();
    const payload = JSON.parse(payloadLine ?? "{}") as { gatewayUrl: string; setupCode: string };
    expect(payload.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const storage = openStorage(dbPath);
    expect(storage.consumeSetupCode(payload.setupCode, Date.now())).toBe("ok");
    storage.close();
  });

  it("honors --ttl for the App Review audience and keeps the code alive for days", async () => {
    const { configPath, dbPath } = tempConfig();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const exitCode = await runCli(["pair", "--config", configPath, "--ttl", "20160"]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(0);
    const payload = JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}") as { setupCode: string };
    const storage = openStorage(dbPath);
    // Thirteen days out the code still pairs; the default ten-minute code would be long dead.
    expect(storage.consumeSetupCode(payload.setupCode, Date.now() + 13 * 24 * 60 * 60 * 1000)).toBe("ok");
    storage.close();
    expect(lines.some((l) => l.includes("valid for 14 days"))).toBe(true);
  });

  it("refuses a --ttl outside the bounded window", async () => {
    const { configPath } = tempConfig();
    await expect(runCli(["pair", "--config", configPath, "--ttl", "0"])).rejects.toThrow(/--ttl/);
    await expect(runCli(["pair", "--config", configPath, "--ttl", "999999"])).rejects.toThrow(/--ttl/);
  });

  it("advertises an http gatewayUrl when no TLS is configured", async () => {
    const { configPath } = tempConfig();
    expect((await pairPayload(configPath)).gatewayUrl).toMatch(/^http:\/\//);
  });

  it("advertises an https gatewayUrl when the gateway serves TLS", async () => {
    // The pairing payload is what the phone dials. If the gateway terminates TLS and the payload
    // still says http, every scan pairs against a port that is not speaking plaintext.
    const { configPath } = tempConfig({ tls: { certFile: "/certs/cert.pem", keyFile: "/certs/key.pem" } });
    expect((await pairPayload(configPath)).gatewayUrl).toMatch(/^https:\/\//);
  });

  it("uses an explicit externally reachable URL verbatim", async () => {
    const { configPath } = tempConfig();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => lines.push(String(line)));
    expect(await runCli(["pair", "--config", configPath, "--url", "https://gateway.example.com"])).toBe(0);
    vi.restoreAllMocks();
    const payload = JSON.parse(lines.find((line) => line.startsWith("{")) ?? "{}") as { gatewayUrl: string };
    expect(payload.gatewayUrl).toBe("https://gateway.example.com");
  });

  it("fails with a usage message on an unknown command", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const exitCode = await runCli(["dance"]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("usage");
  });
});

describe("cozygateway pair finale", () => {
  async function pairLines(configPath: string, extraArgs: string[] = []): Promise<string[]> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => lines.push(String(line)));
    const exitCode = await runCli(["pair", "--config", configPath, ...extraArgs]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(0);
    return lines;
  }

  it("prints the QR block, the exact payload JSON, and the labeled URL and code", async () => {
    const { configPath } = tempConfig();
    const lines = await pairLines(configPath);
    const payloadLine = lines.find((l) => l.startsWith("{"));
    expect(payloadLine).toBeDefined();
    const payload = JSON.parse(payloadLine ?? "{}") as { gatewayUrl: string; setupCode: string };
    // Byte-shaped like the contract example: gatewayUrl first, setupCode second, nothing else.
    expect(payloadLine).toBe(`{"gatewayUrl":"${payload.gatewayUrl}","setupCode":"${payload.setupCode}"}`);
    const qrBlock = lines.find((l) => l.includes("█"));
    expect(qrBlock).toBeDefined();
    expect((qrBlock ?? "").split("\n").length).toBeGreaterThan(10);
    expect(lines).toContain(`Gateway URL: ${payload.gatewayUrl}`);
    expect(lines).toContain(`Setup code:  ${payload.setupCode}`);
    expect(lines.some((l) => l.includes("Mint a fresh one with: cozygateway pair"))).toBe(true);
  });

  it("advertises an explicitly configured loopback host verbatim and says it is loopback", async () => {
    const { configPath } = tempConfig({ host: "127.0.0.1" });
    const lines = await pairLines(configPath);
    const payload = JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}") as { gatewayUrl: string };
    expect(payload.gatewayUrl).toBe("http://127.0.0.1:18787");
    expect(lines.some((l) => l.includes("only this machine can reach it"))).toBe(true);
  });

  it("prefers the machine's LAN address over loopback for a wildcard bind", async () => {
    const { primaryLanAddress } = await import("../src/lan.ts");
    const expectedHost = primaryLanAddress() ?? "127.0.0.1";
    const { configPath } = tempConfig({ host: "0.0.0.0" });
    const lines = await pairLines(configPath);
    const payload = JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}") as { gatewayUrl: string };
    expect(payload.gatewayUrl).toBe(`http://${expectedHost}:18787`);
  });

  it("keeps the loopback note off an externally reachable URL", async () => {
    const { configPath } = tempConfig();
    const lines = await pairLines(configPath, ["--url", "https://gateway.example.com"]);
    const payload = JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}") as { gatewayUrl: string };
    expect(payload.gatewayUrl).toBe("https://gateway.example.com");
    expect(lines.some((l) => l.includes("only this machine can reach it"))).toBe(false);
  });
});

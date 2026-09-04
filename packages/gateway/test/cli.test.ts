import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { isExpectedCertificate, isGatewayReady, runCli } from "../src/cli.ts";
import { startGateway } from "../src/server.ts";
import { openStorage } from "../src/storage.ts";
import { generateSelfSigned } from "./helpers/self-signed.ts";

function scriptedIo(answers: string[]) {
  return {
    interactive: true,
    question: async (_prompt: string): Promise<string> => answers.shift() ?? "",
    close: (): void => undefined,
  };
}

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
      hermesEndpoints: [{ id: "default",
        url: "ws://127.0.0.1:1/api/ws",
        tokenEnv: "TEST_HERMES_CONTROL_TOKEN",
        profiles: { sage: { tokenEnv: "TEST_ATTACH_TOKEN", name: "Sage" } },
      }],
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

async function statusLines(configPath: string): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown = "") => lines.push(String(line)));
  try {
    expect(await runCli(["status", "--config", configPath])).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
  return lines;
}

async function statusLinesForHealth(health: unknown): Promise<string[]> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(health));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("health test server has no port");
  const { configPath } = tempConfig({ host: "127.0.0.1", port: address.port });
  try {
    return await statusLines(configPath);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
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

  it("mints a runner-kind code with --kind runner, which no device pair can spend", async () => {
    const { configPath, dbPath } = tempConfig();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const exitCode = await runCli(["pair", "--config", configPath, "--kind", "runner"]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(0);

    const payload = JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}") as {
      setupCode: string;
      kind?: string;
    };
    // The payload names the kind, so a scan cannot be answered by the wrong client.
    expect(payload.kind).toBe("runner");
    const storage = openStorage(dbPath);
    expect(storage.consumeSetupCode(payload.setupCode, Date.now())).toBe("invalid");
    expect(storage.consumeSetupCode(payload.setupCode, Date.now(), "runner")).toBe("ok");
    storage.close();
  });

  it("keeps a device pair's payload byte-shaped as it always was", async () => {
    const { configPath } = tempConfig();
    const payload = await pairPayload(configPath);
    expect(Object.keys(payload).sort()).toEqual(["gatewayUrl", "setupCode"]);
  });

  it("refuses a kind it does not know rather than minting the wrong credential", async () => {
    const { configPath, dbPath } = tempConfig();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitCode = await runCli(["pair", "--config", configPath, "--kind", "phone"]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(1);
    const storage = openStorage(dbPath);
    expect(storage.listDevices()).toEqual([]);
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

  it("brackets an IPv6 listener in the pairing URL", async () => {
    const { configPath } = tempConfig({ host: "::1" });
    expect((await pairPayload(configPath)).gatewayUrl).toBe("http://[::1]:18787");
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

  it("advertises the persisted publicUrl and rejects a different --url", async () => {
    const { configPath } = tempConfig({
      host: "127.0.0.1",
      publicUrl: "HTTPS://Gateway.Example:443/",
    });
    expect((await pairPayload(configPath)).gatewayUrl).toBe("https://gateway.example");

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => lines.push(String(line)));
    expect(await runCli([
      "pair", "--config", configPath, "--url", "https://gateway.example/",
    ])).toBe(0);
    vi.restoreAllMocks();
    expect(JSON.parse(lines.find((line) => line.startsWith("{")) ?? "{}").gatewayUrl)
      .toBe("https://gateway.example");

    await expect(runCli([
      "pair", "--config", configPath, "--url", "https://other.example",
    ])).rejects.toThrow(/--url.*publicUrl/i);
  });

  it("rejects a mismatched --url before creating storage or a setup code", async () => {
    const { configPath, dbPath } = tempConfig({
      host: "127.0.0.1",
      publicUrl: "https://gateway.example",
    });

    await expect(runCli([
      "pair", "--config", configPath, "--url", "https://other.example",
    ])).rejects.toThrow(/--url.*publicUrl/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects a non-loopback environment override before creating storage or a setup code", async () => {
    const { configPath, dbPath } = tempConfig({
      host: "127.0.0.1",
      publicUrl: "https://gateway.example",
    });
    vi.stubEnv("COZYGATEWAY_HOST", "0.0.0.0");
    try {
      await expect(runCli(["pair", "--config", configPath])).rejects.toThrow(/publicUrl.*loopback/i);
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
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

describe("cozygateway terminal menu", () => {
  it("requires zero dead letters before a managed listener is ready", () => {
    expect(isGatewayReady({ attach: { configured: 1, online: 1, deadLetters: 1 } })).toBe(false);
    expect(isGatewayReady({ attach: { configured: 1, online: 1, deadLetters: 0 } })).toBe(true);
  });

  it("pins local TLS health to the configured leaf certificate", () => {
    const configured = generateSelfSigned();
    const other = generateSelfSigned();
    expect(isExpectedCertificate(readFileSync(configured.certFile), readFileSync(configured.certFile))).toBe(true);
    expect(isExpectedCertificate(readFileSync(configured.certFile), readFileSync(other.certFile))).toBe(false);
  });

  it("reports a local self-signed TLS gateway online", async () => {
    const pair = generateSelfSigned();
    const { configPath, dbPath } = tempConfig();
    process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret";
    process.env.TEST_ATTACH_TOKEN = "attach-secret";
    const gateway = await startGateway({
      name: "tls-status",
      host: "127.0.0.1",
      port: 0,
      dbPath,
      turnTimeoutSeconds: 30,
      hermesEndpoints: [{ id: "default",
        url: "ws://127.0.0.1:1/api/ws",
        tokenEnv: "TEST_HERMES_CONTROL_TOKEN",
        profiles: { sage: { tokenEnv: "TEST_ATTACH_TOKEN" } },
      }],
      tls: { certFile: pair.certFile, keyFile: pair.keyFile },
    });
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.port = Number(new URL(gateway.url).port);
    config.host = "127.0.0.1";
    config.tls = { certFile: pair.certFile, keyFile: pair.keyFile };
    writeFileSync(configPath, JSON.stringify(config));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown = "") => lines.push(String(line)));
    try {
      expect(await runCli(["status", "--config", configPath])).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await gateway.close();
      delete process.env.TEST_HERMES_CONTROL_TOKEN;
      delete process.env.TEST_ATTACH_TOKEN;
    }
    expect(lines.join("\n")).toContain("Gateway:  v0.7.1");
    expect(lines.join("\n")).toContain("Hermes attach needs attention: 0/1 Hermes profiles online");
    expect(lines.join("\n")).toContain("Run cozygateway repair");
  });

  it("opens the basic menu when no command is supplied", async () => {
    const { configPath } = tempConfig({ host: "0.0.0.0", port: 18787 });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown = "") => lines.push(String(line)));

    expect(await runCli(["--config", configPath], scriptedIo(["4"]))).toBe(0);

    vi.restoreAllMocks();
    expect(lines.join("\n")).toContain("CozyGateway");
    expect(lines.join("\n")).toContain("0.0.0.0:18787");
    expect(lines.join("\n")).toContain("Pair a device");
    expect(lines.join("\n")).toContain("Configure listener");
  });

  it("configures the listener while preserving all other settings", async () => {
    const { configPath } = tempConfig({ host: "0.0.0.0", capabilities: { "com.cozylabs.keep": 4 } });
    const localDir = dirname(configPath);
    const hermesRoot = mkdtempSync(join(tmpdir(), "cozygateway-hermes-"));
    writeFileSync(join(hermesRoot, ".env"), "COZYGATEWAY_URL=http://127.0.0.1:18787\nCOZYGATEWAY_TOKEN=secret\n");
    writeFileSync(
      join(localDir, "install-state"),
      `profiles=default\nhermes_root=${hermesRoot}\nhermes_bin=${join(hermesRoot, "hermes")}\n`,
    );
    const restarted: string[] = [];
    let waited = false;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      await runCli(["configure", "--config", configPath], scriptedIo(["127.0.0.1", "9000"]), {
        restartHermesProfile: async (_executable, profile) => {
          restarted.push(profile);
        },
        waitForGatewayReady: async () => {
          waited = true;
        },
      }),
    ).toBe(0);

    vi.restoreAllMocks();
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(9000);
    expect(config.capabilities).toEqual({ "com.cozylabs.keep": 4 });
    expect(readFileSync(join(hermesRoot, ".env"), "utf8")).toContain("COZYGATEWAY_URL=http://127.0.0.1:9000");
    expect(restarted).toEqual(["default"]);
    expect(waited).toBe(true);
  });

  it("keeps the current listener when both configuration answers are empty", async () => {
    const { configPath } = tempConfig({ host: "0.0.0.0", port: 18787 });
    const before = readFileSync(configPath, "utf8");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runCli(["configure", "--config", configPath], scriptedIo(["", ""]))).toBe(0);

    vi.restoreAllMocks();
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("attempts every managed Hermes restart before reporting failures", async () => {
    const { configPath } = tempConfig({ host: "0.0.0.0" });
    const localDir = dirname(configPath);
    const hermesRoot = mkdtempSync(join(tmpdir(), "cozygateway-hermes-"));
    mkdirSync(join(hermesRoot, "profiles", "ops"), { recursive: true });
    for (const envPath of [join(hermesRoot, ".env"), join(hermesRoot, "profiles", "ops", ".env")]) {
      writeFileSync(envPath, "COZYGATEWAY_URL=http://127.0.0.1:18787\nCOZYGATEWAY_TOKEN=secret\n");
    }
    writeFileSync(
      join(localDir, "install-state"),
      `profiles=default,ops\nhermes_root=${hermesRoot}\nhermes_bin=${join(hermesRoot, "hermes")}\n`,
    );
    const restarted: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["configure", "--config", configPath], scriptedIo(["127.0.0.1", "9001"]), {
        restartHermesProfile: async (_executable, profile) => {
          restarted.push(profile);
          if (profile === "default") throw new Error("restart failed");
        },
        waitForGatewayReady: async () => undefined,
      }),
    ).rejects.toThrow(/default/);

    vi.restoreAllMocks();
    expect(restarted).toEqual(["default", "ops", "default", "ops"]);
  });

  it("restores the previous managed listener when the replacement never becomes ready", async () => {
    const { configPath } = tempConfig({ host: "0.0.0.0", port: 18787 });
    const localDir = dirname(configPath);
    const hermesRoot = mkdtempSync(join(tmpdir(), "cozygateway-hermes-"));
    writeFileSync(join(hermesRoot, ".env"), "COZYGATEWAY_URL=http://127.0.0.1:18787\nCOZYGATEWAY_TOKEN=secret\n");
    writeFileSync(
      join(localDir, "install-state"),
      `profiles=default\nhermes_root=${hermesRoot}\nhermes_bin=${join(hermesRoot, "hermes")}\n`,
    );
    const restarted: string[] = [];
    let readinessChecks = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      runCli(["configure", "--config", configPath], scriptedIo(["127.0.0.1", "9002"]), {
        restartHermesProfile: async (_executable, profile) => {
          restarted.push(profile);
        },
        waitForGatewayReady: async () => {
          readinessChecks += 1;
          if (readinessChecks === 1) throw new Error("replacement unavailable");
        },
      }),
    ).rejects.toThrow(/restored.*0\.0\.0\.0:18787/i);

    vi.restoreAllMocks();
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { host: string; port: number };
    expect(config).toMatchObject({ host: "0.0.0.0", port: 18787 });
    expect(readFileSync(join(hermesRoot, ".env"), "utf8")).toContain("COZYGATEWAY_URL=http://127.0.0.1:18787");
    expect(restarted).toEqual(["default", "default"]);
    expect(readinessChecks).toBe(2);
  });

  it("runs pairing from the menu and returns to it", async () => {
    const { configPath, dbPath } = tempConfig();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown = "") => lines.push(String(line)));

    expect(await runCli(["--config", configPath], scriptedIo(["1", "4"]))).toBe(0);

    vi.restoreAllMocks();
    const payload = JSON.parse(lines.find((line) => line.startsWith("{")) ?? "{}") as { setupCode: string };
    const storage = openStorage(dbPath);
    expect(storage.consumeSetupCode(payload.setupCode, Date.now())).toBe("ok");
    storage.close();
  });

  it("reports an unreachable gateway without exposing the connection failure", async () => {
    const { configPath } = tempConfig({ host: "127.0.0.1", port: 18787 });
    const lines = await statusLines(configPath);
    expect(lines.join("\n")).toContain("127.0.0.1:18787");
    expect(lines.join("\n")).toContain("Gateway process unreachable");
    expect(lines.join("\n")).toContain("Run cozygateway repair");
    expect(lines.join("\n")).not.toMatch(/ECONNREFUSED|fetch failed|token|secret/i);
  });

  it("reports each reachable Hermes attach state with a safe repair action", async () => {
    const cases = [
      [{ version: "0.5.5", attach: { configured: 0, online: 0, deadLetters: 0 } }, "no Hermes profiles configured"],
      [{ version: "0.5.5", attach: { configured: 2, online: 1, deadLetters: 0 } }, "1/2 Hermes profiles online"],
      [{ version: "0.5.5", attach: { configured: 1, online: 1, deadLetters: 1 } }, "1 dead letter"],
    ] as const;
    for (const [health, expected] of cases) {
      const lines = await statusLinesForHealth({ ...health, internalError: "secret-token-not-for-output" });
      const output = lines.join("\n");
      expect(output).toContain("Gateway:  v0.5.5");
      expect(output).toContain(expected);
      expect(output).toContain("Run cozygateway repair");
      expect(output).not.toContain("secret-token-not-for-output");
    }
  });

  it("reports a reachable, fully ready gateway without a repair prompt", async () => {
    const lines = await statusLinesForHealth({
      version: "0.5.5",
      attach: { configured: 2, online: 2, deadLetters: 0 },
    });
    const output = lines.join("\n");
    expect(output).toContain("Gateway:  v0.5.5");
    expect(output).toContain("Status:   Ready");
    expect(output).not.toContain("cozygateway repair");
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  isExpectedCertificate,
  isGatewayReady,
  legacyPairingLanAddress,
  publishOnboardingPairing,
  runCli,
  type CliOnboardingController,
  type OnboardingPairingDependencies,
} from "../src/cli.ts";
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

function onboardingController(
  overrides: Partial<CliOnboardingController> = {},
): CliOnboardingController {
  return {
    status: vi.fn(async () => ({
      stage: "pending_choice" as const,
      authority: "none" as const,
      healthy: false,
      expiresAt: 600_000,
    })),
    run: vi.fn(async () => ({ outcome: "deferred" as const })),
    resume: vi.fn(async () => ({ outcome: "deferred" as const })),
    close: vi.fn(),
    ...overrides,
  };
}

function appendLoggedLines(lines: string[], line: unknown): void {
  lines.push(...String(line).split("\n"));
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
    appendLoggedLines(lines, line);
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
      appendLoggedLines(lines, line);
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
      appendLoggedLines(lines, line);
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
    vi.spyOn(console, "log").mockImplementation((line: unknown) => appendLoggedLines(lines, line));
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
    vi.spyOn(console, "log").mockImplementation((line: unknown) => appendLoggedLines(lines, line));
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
    vi.spyOn(console, "log").mockImplementation((line: unknown) => appendLoggedLines(lines, line));
    const exitCode = await runCli(["pair", "--config", configPath, ...extraArgs]);
    vi.restoreAllMocks();
    expect(exitCode).toBe(0);
    return lines;
  }

  it("publishes the legacy finale as one buffered output", async () => {
    const { configPath } = tempConfig();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(await runCli(["pair", "--config", configPath])).toBe(0);

    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain("Gateway URL:");
    vi.restoreAllMocks();
  });

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
    expect(lines.filter((line) => line.includes("█")).length).toBeGreaterThan(10);
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
    const expectedHost = legacyPairingLanAddress() ?? "127.0.0.1";
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

describe("verified onboarding pairing publication", () => {
  const request = {
    phoneConfirmed: true,
    desktopAnswer: undefined,
    gatewayUrl: "https://cozy.example.ts.net",
    color: false,
    finalizeContext: {
      sessionId: "session-1",
      challengeId: "challenge-1",
      canonicalOrigin: "https://cozy.example.ts.net",
      durableFingerprint: "posture-a",
      verificationEpoch: "epoch-1",
      bootGeneration: "boot-1",
      now: 200,
    },
  };

  function publicationDeps() {
    return {
      createSetupCode: vi.fn<OnboardingPairingDependencies["createSetupCode"]>(() => "COZY-1234"),
      render: vi.fn<OnboardingPairingDependencies["render"]>(() => ({
        setupCode: "COZY-1234",
        payloadJson: "payload",
        terminalOutput: "complete output\n",
      })),
      finalize: vi.fn<OnboardingPairingDependencies["finalize"]>(
        () => ({ outcome: "published", setupCode: "COZY-1234" }),
      ),
      write: vi.fn<OnboardingPairingDependencies["write"]>(async () => undefined),
      activate: vi.fn<OnboardingPairingDependencies["activate"]>(
        () => ({ outcome: "advanced", state: "active" }),
      ),
      revoke: vi.fn<OnboardingPairingDependencies["revoke"]>(
        () => ({ outcome: "advanced", state: "revoked" }),
      ),
    };
  }

  it("does nothing when automatic phone proof arrives before a desktop answer", async () => {
    const deps = publicationDeps();

    await expect(publishOnboardingPairing(request, deps)).resolves.toBe("not_published");

    for (const dependency of Object.values(deps)) expect(dependency).not.toHaveBeenCalled();
  });

  it.each(["", "n", "no", " Y ", "YES", " yes "])(
    "does nothing for the nonaffirmative answer %j",
    async (desktopAnswer) => {
      const deps = publicationDeps();

      await expect(publishOnboardingPairing({ ...request, desktopAnswer }, deps))
        .resolves.toBe("not_published");

      for (const dependency of Object.values(deps)) expect(dependency).not.toHaveBeenCalled();
    },
  );

  it("does nothing when desktop confirmation is premature", async () => {
    const deps = publicationDeps();

    await expect(publishOnboardingPairing({
      ...request,
      phoneConfirmed: false,
      desktopAnswer: "y",
    }, deps)).resolves.toBe("not_published");

    for (const dependency of Object.values(deps)) expect(dependency).not.toHaveBeenCalled();
  });

  it("creates and strictly renders one confirmed code before database finalization", async () => {
    const deps = publicationDeps();
    const calls: string[] = [];
    deps.createSetupCode.mockImplementation(() => (calls.push("create"), "COZY-1234"));
    deps.render.mockImplementation((input) => {
      calls.push("render");
      expect(input).toEqual({
        gatewayUrl: "https://cozy.example.ts.net",
        setupCode: "COZY-1234",
        ttlMs: 10 * 60_000,
        color: false,
        strictQr: true,
      });
      return { setupCode: "COZY-1234", payloadJson: "payload", terminalOutput: "complete output\n" };
    });
    deps.finalize.mockImplementation((input) => {
      calls.push("finalize");
      expect(input).toEqual({
        ...request.finalizeContext,
        setupCode: "COZY-1234",
        setupCodeExpiresAt: 600_200,
      });
      return { outcome: "invalid_state" };
    });

    await expect(publishOnboardingPairing({ ...request, desktopAnswer: "y" }, deps))
      .resolves.toBe("not_published");

    expect(calls).toEqual(["create", "render", "finalize"]);
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("permits an asynchronous live-posture check after rendering and immediately before finalization", async () => {
    const deps = publicationDeps();
    const calls: string[] = [];
    deps.render.mockImplementation((input) => {
      calls.push("render");
      return { setupCode: input.setupCode, payloadJson: "payload", terminalOutput: "complete output\n" };
    });
    const withPostureCheck: OnboardingPairingDependencies = {
      ...deps,
      beforeFinalize: vi.fn(async () => {
        calls.push("inspect");
      }),
      finalize: vi.fn(() => {
        calls.push("finalize");
        return { outcome: "invalid_state" as const };
      }),
    };

    await expect(publishOnboardingPairing({ ...request, desktopAnswer: "y" }, withPostureCheck))
      .resolves.toBe("not_published");

    expect(calls).toEqual(["render", "inspect", "finalize"]);
  });

  it("captures authoritative now after asynchronous posture inspection", async () => {
    const deps = publicationDeps();
    let clock = 200;
    const withPostureCheck: OnboardingPairingDependencies = {
      ...deps,
      beforeFinalize: vi.fn(async () => {
        clock = 601;
      }),
      finalizationNow: vi.fn(() => clock),
      finalize: vi.fn((input) => {
        expect(input.now).toBe(601);
        expect(input.setupCodeExpiresAt).toBe(600_601);
        return { outcome: "expired" as const };
      }),
    };

    await expect(publishOnboardingPairing({ ...request, desktopAnswer: "y" }, withPostureCheck))
      .resolves.toBe("not_published");

    expect(withPostureCheck.finalizationNow).toHaveBeenCalledOnce();
    expect(withPostureCheck.finalize).toHaveBeenCalledOnce();
  });

  it("revokes the pending code when the buffered write fails", async () => {
    const deps = publicationDeps();
    const writeError = new Error("terminal closed");
    deps.write.mockRejectedValue(writeError);

    await expect(publishOnboardingPairing({ ...request, desktopAnswer: "yes" }, deps))
      .rejects.toBe(writeError);

    expect(deps.write).toHaveBeenCalledOnce();
    expect(deps.write).toHaveBeenCalledWith("complete output\n");
    expect(deps.revoke).toHaveBeenCalledWith({
      challengeId: "challenge-1",
      setupCode: "COZY-1234",
      now: 200,
    });
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("combines the write error with an unsuccessful revocation result", async () => {
    const deps = publicationDeps();
    const writeError = new Error("terminal closed");
    deps.write.mockRejectedValue(writeError);
    deps.revoke.mockReturnValue({ outcome: "invalid_state", state: "active" });

    const error = await publishOnboardingPairing({ ...request, desktopAnswer: "yes" }, deps)
      .then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(writeError);
    expect((error as AggregateError).errors[1]).toMatchObject({
      message: expect.stringMatching(/revocation.*invalid_state.*active/i),
    });
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("combines the write error with a thrown revocation failure", async () => {
    const deps = publicationDeps();
    const writeError = new Error("terminal closed");
    const revocationError = new Error("database unavailable");
    deps.write.mockRejectedValue(writeError);
    deps.revoke.mockImplementation(() => {
      throw revocationError;
    });

    const error = await publishOnboardingPairing({ ...request, desktopAnswer: "yes" }, deps)
      .then(() => undefined, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([writeError, revocationError]);
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("writes one complete buffer and activates only after successful output", async () => {
    const deps = publicationDeps();
    const calls: string[] = [];
    deps.write.mockImplementation(async (output) => {
      calls.push(`write:${output}`);
    });
    deps.activate.mockImplementation((input) => {
      calls.push(`activate:${input.setupCode}`);
      return { outcome: "advanced", state: "active" };
    });

    await expect(publishOnboardingPairing({ ...request, desktopAnswer: "y" }, deps))
      .resolves.toBe("published");

    expect(calls).toEqual(["write:complete output\n", "activate:COZY-1234"]);
    expect(deps.write).toHaveBeenCalledOnce();
    expect(deps.activate).toHaveBeenCalledWith({
      challengeId: "challenge-1",
      setupCode: "COZY-1234",
      now: 200,
    });
    expect(deps.revoke).not.toHaveBeenCalled();
  });
});

describe("cozygateway terminal menu", () => {
  it.each([
    ["1", "tailscale"],
    ["2", "lan"],
    ["3", "later"],
    ["4", "advanced"],
  ] as const)("setup offers outcome-focused network choice %s", async (answer, expected) => {
    const { configPath } = tempConfig();
    let selected: string | undefined;
    const controller = onboardingController({
      resume: vi.fn(async (io) => {
        selected = await io.chooseNetworkMode();
        return selected === "later" ? { outcome: "deferred" as const } : { outcome: "cancelled" as const };
      }),
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown = "") => appendLoggedLines(lines, line));

    expect(await runCli(["setup", "--config", configPath], scriptedIo([answer]), undefined, controller)).toBe(0);

    vi.restoreAllMocks();
    expect(selected).toBe(expected);
    expect(lines.join("\n")).toContain("Remote via personal Tailscale");
    expect(lines.join("\n")).toContain("Same Wi-Fi");
    expect(lines.join("\n")).toContain("Set up later");
    expect(lines.join("\n")).toContain("Advanced settings");
  });

  it("noninteractive setup emits no QR/code and prints exactly one resume command", async () => {
    const { configPath } = tempConfig();
    const controller = onboardingController();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown = "") => appendLoggedLines(lines, line));
    const io = { ...scriptedIo([]), interactive: false };

    expect(await runCli(["setup", "--config", configPath], io, undefined, controller)).toBe(0);

    vi.restoreAllMocks();
    expect(controller.run).not.toHaveBeenCalled();
    expect(controller.resume).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toMatch(/setupCode|Setup code|█/);
    expect(lines.filter((line) => line.includes("cozygateway setup"))).toEqual([
      `Resume phone access setup with: cozygateway setup --config "${configPath}"`,
    ]);
  });

  it.each([
    ["install_cancelled", "Tailscale installation was cancelled in Windows"],
    ["install_reboot_required", "Restart Windows, then resume"],
    ["login_pending", "Finish signing in to Tailscale"],
    ["machine_auth_required", "Ask the tailnet administrator to approve this machine"],
    ["managed_policy", "Tailscale policy blocked the requested setting"],
    ["no_up_physical_private_ipv4", "Connect this PC to trusted Wi-Fi or Ethernet"],
    ["multiple_up_physical_private_ipv4", "More than one physical network is active"],
    ["mapping_conflict", "Tailscale port 443 is already in use"],
  ] as const)("prints actionable resumable copy for %s", async (reason, copy) => {
    const { configPath } = tempConfig();
    const controller = onboardingController({
      resume: vi.fn(async () => ({ outcome: "paused" as const, mode: "tailscale" as const, reason })),
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown = "") => appendLoggedLines(lines, line));

    expect(await runCli(["setup", "--config", configPath], scriptedIo([]), undefined, controller)).toBe(0);

    vi.restoreAllMocks();
    expect(lines.join("\n")).toContain(copy);
    expect(lines.join("\n")).toContain("cozygateway setup");
    expect(lines.join("\n")).not.toMatch(/diagnostic dump|authUrl|token/i);
  });

  it("blocks fresh/changed pairing, allows matching complete pairing, and preserves legacy pairing", async () => {
    const pending = tempConfig();
    const pendingController = onboardingController();
    await expect(runCli(["pair", "--config", pending.configPath], undefined, undefined, pendingController))
      .rejects.toThrow(/cozygateway setup/);
    expect(existsSync(pending.dbPath)).toBe(false);

    const complete = tempConfig();
    const completeController = onboardingController({
      status: vi.fn(async () => ({
        stage: "complete" as const, authority: "complete" as const, mode: "lan" as const, healthy: true,
        endpoint: {
          mode: "lan" as const, canonicalOrigin: "http://192.168.1.20:18787", bindHost: "0.0.0.0",
          port: 18787, durableFingerprint: "posture", ready: true,
        },
      })),
    });
    expect(await runCli(["pair", "--config", complete.configPath], undefined, undefined, completeController)).toBe(0);

    const legacy = tempConfig();
    expect(await runCli(["pair", "--config", legacy.configPath])).toBe(0);

    const reviewedLegacy = tempConfig();
    const reviewedLegacyController = onboardingController({
      status: vi.fn(async () => ({
        stage: "legacy_unreviewed" as const, authority: "none" as const,
        mode: "advanced" as const, healthy: false,
      })),
    });
    expect(await runCli(["pair", "--config", reviewedLegacy.configPath], undefined, undefined, reviewedLegacyController)).toBe(0);
  });
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
      hermes: {
        url: "ws://127.0.0.1:1/api/ws",
        tokenEnv: "TEST_HERMES_CONTROL_TOKEN",
        profiles: { sage: { tokenEnv: "TEST_ATTACH_TOKEN" } },
      },
      tls: { certFile: pair.certFile, keyFile: pair.keyFile },
    });
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    config.port = Number(new URL(gateway.url).port);
    config.host = "127.0.0.1";
    config.tls = { certFile: pair.certFile, keyFile: pair.keyFile };
    writeFileSync(configPath, JSON.stringify(config));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown = "") => appendLoggedLines(lines, line));
    try {
      expect(await runCli(["status", "--config", configPath])).toBe(0);
    } finally {
      vi.restoreAllMocks();
      await gateway.close();
      delete process.env.TEST_HERMES_CONTROL_TOKEN;
      delete process.env.TEST_ATTACH_TOKEN;
    }
    expect(lines.join("\n")).toMatch(/Status:\s+online/);
  });

  it("opens the basic menu when no command is supplied", async () => {
    const { configPath } = tempConfig({ host: "0.0.0.0", port: 18787 });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown = "") => appendLoggedLines(lines, line));

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
    vi.spyOn(console, "log").mockImplementation((line: unknown = "") => appendLoggedLines(lines, line));

    expect(await runCli(["--config", configPath], scriptedIo(["1", "4"]))).toBe(0);

    vi.restoreAllMocks();
    const payload = JSON.parse(lines.find((line) => line.startsWith("{")) ?? "{}") as { setupCode: string };
    const storage = openStorage(dbPath);
    expect(storage.consumeSetupCode(payload.setupCode, Date.now())).toBe("ok");
    storage.close();
  });

  it("prints listener and offline health through the status command", async () => {
    const { configPath } = tempConfig({ host: "127.0.0.1", port: 18787 });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown = "") => appendLoggedLines(lines, line));

    expect(await runCli(["status", "--config", configPath])).toBe(0);

    vi.restoreAllMocks();
    expect(lines.join("\n")).toContain("127.0.0.1:18787");
    expect(lines.join("\n")).toMatch(/offline/i);
  });
});

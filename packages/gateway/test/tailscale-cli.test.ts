import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  TailscaleCli,
  TailscaleCliError,
  WindowsTailscaleLocalApi,
  runTailscaleCliProcess,
  type TailscaleCliRunner,
} from "../src/tailscale-cli.ts";

const executable = "C:\\Program Files\\Tailscale\\tailscale.exe";
const fixture = (name: string) => readFileSync(
  fileURLToPath(new URL(`./fixtures/tailscale/${name}`, import.meta.url)),
  "utf8",
);

describe("TailscaleCli", () => {
  it("aborts a real hanging child and settles only after the process closes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cozy-tailscale-child-"));
    const script = join(directory, "hang.js");
    const pidFile = join(directory, "pid");
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    try {
      const run = runTailscaleCliProcess(process.execPath, [script], {
        shell: false, windowsHide: true, timeoutMs: 1_000,
        maxObjectBytes: 1024, maxTotalBytes: 1024, signal: controller.signal,
      });
      while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      await expect(run).rejects.toThrow();
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the trusted absolute executable with literal argv and bounded no-shell execution", async () => {
    const runner = vi.fn<TailscaleCliRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: '{"majorMinorPatch":"1.102.1","short":"1.102.1","long":"1.102.1-tfixture"}',
      stderr: "",
    });
    const cli = new TailscaleCli({ executable, runner });

    await expect(cli.version()).resolves.toEqual({ major: 1, minor: 102, patch: 1, display: "1.102.1" });
    expect(runner).toHaveBeenCalledWith(
      executable,
      ["version", "--json"],
      expect.objectContaining({ shell: false, windowsHide: true, maxObjectBytes: 65_536, maxTotalBytes: 262_144 }),
    );
  });

  it("rejects relative executables and bounds an uncooperative hanging runner", async () => {
    expect(() => new TailscaleCli({ executable: "tailscale.exe" })).toThrow(/fully qualified/i);
    const cli = new TailscaleCli({
      executable,
      timeoutMs: 10,
      runner: () => new Promise(() => undefined),
    });
    await expect(cli.version()).rejects.toMatchObject({ reason: "timeout" } satisfies Partial<TailscaleCliError>);
  });

  it("does not invoke the runner when its signal is already aborted", async () => {
    const runner = vi.fn<TailscaleCliRunner>();
    const controller = new AbortController();
    controller.abort();
    const cli = new TailscaleCli({ executable, runner });

    await expect(cli.version(controller.signal)).rejects.toMatchObject({ reason: "cancelled" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("honors cancellation and rejects invalid UTF-8 or combined output beyond the total bound", async () => {
    const controller = new AbortController();
    const cancelled = new TailscaleCli({
      executable,
      runner: (_file, _argv, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }),
    });
    const pending = cancelled.version(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" } satisfies Partial<TailscaleCliError>);

    const invalidUtf8 = new TailscaleCli({
      executable,
      runner: async () => ({ exitCode: 0, stdout: new Uint8Array([0xc3, 0x28]), stderr: "" }),
    });
    await expect(invalidUtf8.version()).rejects.toMatchObject({ reason: "invalid_utf8" });

    const tooLarge = new TailscaleCli({
      executable,
      runner: async () => ({
        exitCode: 0,
        stdout: "x".repeat(192 * 1024),
        stderr: "x".repeat(65 * 1024),
      }),
    });
    await expect(tooLarge.version()).rejects.toMatchObject({ reason: "output_too_large" });
  });

  it("requires Tailscale 1.102.1 or newer and strictly validates a running personal-account status", async () => {
    const outputs = [fixture("version-supported.json"), fixture("status-running.json")];
    const cli = new TailscaleCli({
      executable,
      runner: async () => ({ exitCode: 0, stdout: outputs.shift()!, stderr: "" }),
    });

    await expect(cli.requireSupportedVersion()).resolves.toMatchObject({ display: "1.102.1" });
    await expect(cli.status()).resolves.toMatchObject({
      state: "running",
      dnsName: "cozy.fixture-tailnet.ts.net",
      magicDnsSuffix: "fixture-tailnet.ts.net",
      accountLabel: "fixture@example.com",
      tailnetName: "fixture@example.com",
    });

    const old = new TailscaleCli({
      executable,
      runner: async () => ({ exitCode: 0, stdout: fixture("version-old.json"), stderr: "" }),
    });
    await expect(old.requireSupportedVersion()).rejects.toMatchObject({
      reason: "unsupported_version",
    } satisfies Partial<TailscaleCliError>);
  });

  it("classifies resumable status and rejects certificate, custom suffix, Unicode, and suffix-boundary ambiguity", async () => {
    for (const [name, state] of [
      ["status-needs-login.json", "needs_login"],
      ["status-machine-auth.json", "needs_machine_auth"],
    ] as const) {
      const cli = new TailscaleCli({ executable, runner: async () => ({ exitCode: 0, stdout: fixture(name), stderr: "" }) });
      await expect(cli.status()).resolves.toMatchObject({ state });
    }
    for (const name of ["status-cert-mismatch.json", "status-unverifiable.json"]) {
      const cli = new TailscaleCli({ executable, runner: async () => ({ exitCode: 0, stdout: fixture(name), stderr: "" }) });
      await expect(cli.status()).rejects.toMatchObject({ reason: "invalid_status" } satisfies Partial<TailscaleCliError>);
    }
    for (const hostile of [
      fixture("status-running.json").replaceAll("fixture-tailnet.ts.net", "fixture-tailnet.ts.net.evil"),
      fixture("status-running.json").replaceAll("cozy.fixture", "coz\u00ff.fixture"),
      fixture("status-running.json").replace('"cozy.fixture-tailnet.ts.net"]', '"cozy.fixture-tailnet.ts.net."]'),
    ]) {
      const cli = new TailscaleCli({ executable, runner: async () => ({ exitCode: 0, stdout: hostile, stderr: "" }) });
      await expect(cli.status()).rejects.toMatchObject({ reason: "invalid_status" } satisfies Partial<TailscaleCliError>);
    }
    const customaryDot = new TailscaleCli({
      executable,
      runner: async () => ({ exitCode: 0, stdout: fixture("status-running.json")
        .replace('"DNSName":"cozy.fixture-tailnet.ts.net"', '"DNSName":"cozy.fixture-tailnet.ts.net."'), stderr: "" }),
    });
    await expect(customaryDot.status()).resolves.toMatchObject({ dnsName: "cozy.fixture-tailnet.ts.net" });
    for (const hostile of [
      fixture("status-running.json").replace("1.102.1-tfixture", "1.100.0-tfixture"),
      fixture("status-running.json").replace('"Health": []', '"Health":["control connection unhealthy"]'),
    ]) {
      const cli = new TailscaleCli({ executable, runner: async () => ({ exitCode: 0, stdout: hostile, stderr: "" }) });
      await expect(cli.status()).rejects.toMatchObject({ reason: "invalid_status" } satisfies Partial<TailscaleCliError>);
    }
  });

  it("reads only targeted boolean preferences across documented object and scalar JSON shapes", async () => {
    const runner = vi.fn<TailscaleCliRunner>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"unattended":true}', stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "false", stderr: "" });
    const cli = new TailscaleCli({ executable, runner });

    await expect(cli.preference("unattended")).resolves.toBe(true);
    await expect(cli.preference("shields-up")).resolves.toBe(false);
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      ["get", "--json", "unattended"],
      ["get", "--json", "shields-up"],
    ]);
  });

  it("accepts only the official control server from bounded debug prefs and fails closed", async () => {
    const runner = vi.fn<TailscaleCliRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ ControlURL: "https://controlplane.tailscale.com", WantRunning: true }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ ControlURL: "https://login.tailscale.com" }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ ControlURL: "https://headscale.example.test" }),
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ WantRunning: true }), stderr: "" });
    const cli = new TailscaleCli({ executable, runner });

    await expect(cli.requireOfficialControlServer()).resolves.toBeUndefined();
    await expect(cli.requireOfficialControlServer()).resolves.toBeUndefined();
    await expect(cli.requireOfficialControlServer()).rejects.toMatchObject({ reason: "custom_control_server" });
    await expect(cli.requireOfficialControlServer()).rejects.toMatchObject({ reason: "invalid_preferences" });
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      ["debug", "prefs"],
      ["debug", "prefs"],
      ["debug", "prefs"],
      ["debug", "prefs"],
    ]);
  });

  it("incrementally parses bounded login objects, validates the exact login host, and redacts failures", async () => {
    const login = fixture("login-incremental.txt");
    const runner = vi.fn<TailscaleCliRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: [login.slice(0, 7), Buffer.from(login.slice(7, 83)), login.slice(83)],
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '{"AuthURL":"https://login.tailscale.com/a/resume-opaque","BackendState":"NeedsLogin"}',
        stderr: "",
      });
    const cli = new TailscaleCli({ executable, runner });

    await expect(cli.beginLogin()).resolves.toEqual({ outcome: "running" });
    await expect(cli.beginLogin()).resolves.toEqual({
      outcome: "auth_required",
      authUrl: "https://login.tailscale.com/a/resume-opaque",
    });
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      ["up", "--json", "--timeout=5s"],
      ["up", "--json", "--timeout=5s"],
    ]);

    for (const output of [
      fixture("login-malformed.txt"),
      JSON.stringify({ Error: "x".repeat(JSON.parse(fixture("login-oversized.json")).utf8Bytes) }),
      '{"AuthURL":"https://login.tailscale.com.evil/a/secret","BackendState":"NeedsLogin"}',
    ]) {
      const hostile = new TailscaleCli({
        executable,
        runner: async () => ({ exitCode: 1, stdout: output, stderr: "https://login.tailscale.com/a/do-not-log" }),
      });
      const error = await hostile.beginLogin().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TailscaleCliError);
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain("do-not-log");
    }
  });

  it("stops a still-running login stream as soon as one JSON object exceeds 64 KiB", async () => {
    const cli = new TailscaleCli({
      executable,
      runner: async (_file, _argv, options) => {
        options.onStdoutChunk?.(Buffer.from(`{"Error":"${"x".repeat(65_536)}`));
        return new Promise(() => undefined);
      },
    });

    await expect(cli.beginLogin()).rejects.toMatchObject({ reason: "output_too_large" });
  });

  it("inspects complete Serve and Funnel JSON and exposes only the exact creation mutation", async () => {
    const runner = vi.fn<TailscaleCliRunner>()
      .mockResolvedValueOnce({ exitCode: 0, stdout: fixture("serve-empty.json"), stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: fixture("funnel-empty.json"), stderr: "" })
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const cli = new TailscaleCli({ executable, runner });

    await expect(cli.serveState()).resolves.toMatchObject({ TCP: {}, Web: {} });
    await expect(cli.funnelState()).resolves.toMatchObject({ AllowFunnel: {} });
    expect(runner.mock.calls.map((call) => call[1])).toEqual([
      ["serve", "status", "--json"],
      ["funnel", "status", "--json"],
    ]);
  });

  it("uses a foreground HTTPS text command only to capture a validated consent URL", async () => {
    const runner = vi.fn<TailscaleCliRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: "Enable HTTPS here:\nhttps://console.tailscale.com/admin/feature/fixture\n",
      stderr: "",
    });
    const cli = new TailscaleCli({ executable, runner });
    await expect(cli.beginHttpsConsent(8_443)).resolves.toBe(
      "https://console.tailscale.com/admin/feature/fixture",
    );
    expect(runner.mock.calls[0]?.[1]).toEqual([
      "serve", "--https=8443", "text:CozyGateway HTTPS consent",
    ]);
    expect(runner.mock.calls[0]?.[2]).toMatchObject({ shell: false, windowsHide: true });
  });

  it("bounds HTTPS consent with fatal incremental UTF-8, combined output limits, redacted errors, and awaited termination", async () => {
    const invalidUtf8 = new TailscaleCli({
      executable,
      runner: async (_file, _argv, options) => {
        options.onStdoutChunk?.(new Uint8Array([0xc3, 0x28]));
        return { exitCode: 0, stdout: new Uint8Array([0xc3, 0x28]), stderr: "" };
      },
    });
    await expect(invalidUtf8.beginHttpsConsent(8_443)).rejects.toMatchObject({ reason: "invalid_utf8" });

    const combinedOverflow = new TailscaleCli({
      executable,
      runner: async () => ({
        exitCode: 0,
        stdout: "https://console.tailscale.com/admin/feature/fixture\n" + "x".repeat(192 * 1024),
        stderr: "x".repeat(65 * 1024),
      }),
    });
    await expect(combinedOverflow.beginHttpsConsent(8_443)).rejects.toMatchObject({ reason: "output_too_large" });

    const overflowAfterUrl = new TailscaleCli({
      executable,
      runner: async (_file, _argv, options) => {
        options.onStdoutChunk?.(Buffer.from("https://console.tailscale.com/admin/feature/fixture\n"));
        options.onStdoutChunk?.(Buffer.alloc(256 * 1024));
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    await expect(overflowAfterUrl.beginHttpsConsent(8_443)).rejects.toMatchObject({ reason: "output_too_large" });

    const truncatedAfterUrl = new TailscaleCli({
      executable,
      runner: async (_file, _argv, options) => {
        options.onStdoutChunk?.(Buffer.from("https://console.tailscale.com/admin/feature/fixture\n"));
        options.onStdoutChunk?.(new Uint8Array([0xc3]));
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    await expect(truncatedAfterUrl.beginHttpsConsent(8_443)).rejects.toMatchObject({ reason: "invalid_utf8" });

    const rawFailure = new TailscaleCli({
      executable,
      runner: async () => { throw new Error("https://console.tailscale.com/admin/feature/secret"); },
    });
    const error = await rawFailure.beginHttpsConsent(8_443).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "command_failed" });
    expect(String(error)).not.toContain("secret");

    let terminated = false;
    const foreground = new TailscaleCli({
      executable,
      runner: async (_file, _argv, options) => new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          setTimeout(() => {
            terminated = true;
            resolve({ exitCode: 1, stdout: "", stderr: "" });
          }, 5);
        }, { once: true });
        options.onStdoutChunk?.(Buffer.from("https://console.tailscale.com/admin/feature/fixture\n"));
      }),
    });
    await expect(foreground.beginHttpsConsent(8_443)).resolves.toContain("console.tailscale.com");
    expect(terminated).toBe(true);
  });

  it("rejects duplicate JSON keys, including Unicode-escaped aliases, before interpretation", async () => {
    for (const output of [
      '{"majorMinorPatch":"1.100.0","majorMinorPatch":"1.102.1","short":"1.102.1","long":"fixture"}',
      '{"majorMinorPatch":"1.100.0","majorMinor\u0050atch":"1.102.1","short":"1.102.1","long":"fixture"}',
    ]) {
      const cli = new TailscaleCli({
        executable,
        runner: async () => ({ exitCode: 0, stdout: output, stderr: "" }),
      });
      await expect(cli.version()).rejects.toMatchObject({ reason: "malformed_json" });
    }
  });
});

describe("WindowsTailscaleLocalApi", () => {
  const socketPath = () => process.platform === "win32"
    ? `\\\\.\\pipe\\cozy-tailscale-localapi-${randomUUID()}`
    : join(tmpdir(), `cozy-tailscale-localapi-${randomUUID()}.sock`);

  it("creates only the exact mapping in an empty ServeConfig with If-Match", async () => {
    const pipe = socketPath();
    const etag = "c".repeat(64);
    let config: Record<string, unknown> = {
      TCP: { "8443": { TCPForward: "127.0.0.1:9000" } },
      Web: {}, Services: {}, Foreground: {}, AllowFunnel: { "other.fixture.ts.net:443": true },
    };
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.setHeader("ETag", etag);
        response.end(JSON.stringify(config));
        return;
      }
      expect(request.headers["if-match"]).toBe(etag);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        config = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.statusCode = 200;
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => server.listen(pipe, resolve).once("error", reject));
    try {
      const client = new WindowsTailscaleLocalApi({ socketPath: pipe, timeoutMs: 1_000 });
      await expect(client.createExactTlsTerminatedMapping({
        dnsName: "cozy.fixture-tailnet.ts.net", target: "127.0.0.1:18787",
      })).resolves.toBe("created");
      expect(config).toEqual({
        TCP: {
          "443": { TCPForward: "127.0.0.1:18787", TerminateTLS: "cozy.fixture-tailnet.ts.net" },
          "8443": { TCPForward: "127.0.0.1:9000" },
        },
        Web: {}, Services: {}, Foreground: {}, AllowFunnel: { "other.fixture.ts.net:443": true },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") rmSync(pipe, { force: true });
    }
  });

  it("leaves a concurrent user mapping untouched when creation If-Match fails", async () => {
    const pipe = socketPath();
    const etag = "d".repeat(64);
    const replacement = {
      TCP: { "443": { TCPForward: "127.0.0.1:9999", TerminateTLS: "user.fixture.ts.net" } },
      Web: {}, Services: {}, Foreground: {}, AllowFunnel: {},
    };
    let config: Record<string, unknown> = { TCP: {}, Web: {}, Services: {}, Foreground: {}, AllowFunnel: {} };
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.setHeader("ETag", etag);
        response.end(JSON.stringify(config));
        config = replacement;
        return;
      }
      expect(request.headers["if-match"]).toBe(etag);
      response.statusCode = 412;
      response.end();
    });
    await new Promise<void>((resolve, reject) => server.listen(pipe, resolve).once("error", reject));
    try {
      const client = new WindowsTailscaleLocalApi({ socketPath: pipe, timeoutMs: 1_000 });
      await expect(client.createExactTlsTerminatedMapping({
        dnsName: "cozy.fixture-tailnet.ts.net", target: "127.0.0.1:18787",
      })).resolves.toBe("concurrent");
      expect(config).toEqual(replacement);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") rmSync(pipe, { force: true });
    }
  });

  it("removes only the exact owned entry from the full ServeConfig with If-Match", async () => {
    const pipe = socketPath();
    const etag = "a".repeat(64);
    let config: Record<string, unknown> = {
      TCP: {
        "443": { TCPForward: "127.0.0.1:18787", TerminateTLS: "cozy.fixture-tailnet.ts.net" },
        "8443": { TCPForward: "127.0.0.1:9000" },
      },
      Web: {}, Services: {}, Foreground: {},
      AllowFunnel: { "other.fixture.ts.net:443": true },
    };
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.setHeader("ETag", etag);
        response.end(JSON.stringify(config));
        return;
      }
      expect(request.headers["if-match"]).toBe(etag);
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        config = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.statusCode = 200;
        response.end();
      });
    });
    await new Promise<void>((resolve, reject) => server.listen(pipe, resolve).once("error", reject));
    try {
      const client = new WindowsTailscaleLocalApi({ socketPath: pipe, timeoutMs: 1_000 });
      await expect(client.removeExactTlsTerminatedMapping({
        dnsName: "cozy.fixture-tailnet.ts.net", target: "127.0.0.1:18787",
      })).resolves.toBe("removed");
      expect(config).toEqual({
        TCP: { "8443": { TCPForward: "127.0.0.1:9000" } },
        Web: {}, Services: {}, Foreground: {},
        AllowFunnel: { "other.fixture.ts.net:443": true },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") rmSync(pipe, { force: true });
    }
  });

  it("retains a concurrently swapped unowned mapping when If-Match fails", async () => {
    const pipe = socketPath();
    const firstEtag = "a".repeat(64);
    const replacement = {
      TCP: { "443": { TCPForward: "127.0.0.1:9999", TerminateTLS: "cozy.fixture-tailnet.ts.net" } },
      Web: {}, Services: {}, Foreground: {}, AllowFunnel: {},
    };
    let config: Record<string, unknown> = {
      TCP: { "443": { TCPForward: "127.0.0.1:18787", TerminateTLS: "cozy.fixture-tailnet.ts.net" } },
      Web: {}, Services: {}, Foreground: {}, AllowFunnel: {},
    };
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.setHeader("ETag", firstEtag);
        response.end(JSON.stringify(config));
        config = replacement;
        return;
      }
      expect(request.headers["if-match"]).toBe(firstEtag);
      response.statusCode = 412;
      response.end("etag mismatch");
    });
    await new Promise<void>((resolve, reject) => server.listen(pipe, resolve).once("error", reject));
    try {
      const client = new WindowsTailscaleLocalApi({ socketPath: pipe, timeoutMs: 1_000 });
      await expect(client.removeExactTlsTerminatedMapping({
        dnsName: "cozy.fixture-tailnet.ts.net", target: "127.0.0.1:18787",
      })).resolves.toBe("concurrent");
      expect(config).toEqual(replacement);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") rmSync(pipe, { force: true });
    }
  });
});

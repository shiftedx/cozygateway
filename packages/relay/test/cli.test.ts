import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCliConfig } from "../src/cli.ts";

const CLI_SOURCE = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SPAWN_TIMEOUT_MS = 8_000;

/** Reads `child`'s stdout until `predicate` matches a line, then resolves with that line.
 *  Rejects on timeout or if the process exits first (so a crash fails fast, not by hanging). */
function waitForStdoutLine(
  child: ChildProcessByStdio<null, Readable, Readable>,
  predicate: (line: string) => boolean,
  timeoutMs = SPAWN_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`cli exited before matching line (code=${String(code)}, signal=${String(signal)})`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for a matching stdout line; saw: ${JSON.stringify(buffer)}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n")) {
        if (predicate(line)) {
          cleanup();
          resolve(line);
          return;
        }
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs = SPAWN_TIMEOUT_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for cli to exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Spawns the relay CLI directly against its `.ts` source (Node 24+'s built-in type-stripping
 *  runs it with no build step, keeping this hermetic and independent of `dist/`), binds an
 *  ephemeral port, and kills it unconditionally in a `finally` so a failing assertion never
 *  leaks a listening process. */
async function withSpawnedRelay(
  extraArgs: string[],
  fn: (child: ChildProcessByStdio<null, Readable, Readable>, url: string) => Promise<void>,
): Promise<void> {
  const child = spawn(
    process.execPath,
    [CLI_SOURCE, "--port", "0", "--host", "127.0.0.1", "--db", ":memory:", ...extraArgs],
    { stdio: ["ignore", "pipe", "pipe"] },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  try {
    const line = await waitForStdoutLine(child, (l) => l.includes("listening on"));
    const match = /listening on (http:\/\/\S+)/.exec(line);
    expect(match).not.toBeNull();
    const url = match?.[1] ?? "";
    await fn(child, url);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

describe("parseCliConfig", () => {
  it("applies defaults (loopback bind: restrictEgress off)", () => {
    expect(parseCliConfig([])).toEqual({
      port: 8788,
      host: "127.0.0.1",
      dbPath: "relay.db",
      dailyCap: 500,
      maxRegistrations: 10000,
      restrictEgress: false,
    });
  });

  it("parses overrides (non-loopback bind: restrictEgress defaults on)", () => {
    expect(
      parseCliConfig([
        "--port",
        "0",
        "--host",
        "0.0.0.0",
        "--db",
        ":memory:",
        "--daily-cap",
        "5",
        "--max-registrations",
        "10",
      ]),
    ).toEqual({
      port: 0,
      host: "0.0.0.0",
      dbPath: ":memory:",
      dailyCap: 5,
      maxRegistrations: 10,
      restrictEgress: true,
    });
  });

  it("rejects a non-numeric port, a zero daily cap, and a zero registration cap", () => {
    expect(() => parseCliConfig(["--port", "abc"])).toThrow("invalid --port");
    expect(() => parseCliConfig(["--daily-cap", "0"])).toThrow("invalid --daily-cap");
    expect(() => parseCliConfig(["--max-registrations", "0"])).toThrow("invalid --max-registrations");
  });

  it("--restrict-egress forces restriction on even on a loopback bind", () => {
    expect(parseCliConfig(["--restrict-egress"])).toEqual({
      port: 8788,
      host: "127.0.0.1",
      dbPath: "relay.db",
      dailyCap: 500,
      maxRegistrations: 10000,
      restrictEgress: true,
    });
  });

  it("--no-restrict-egress forces restriction off even on a non-loopback bind", () => {
    expect(parseCliConfig(["--host", "0.0.0.0", "--no-restrict-egress"])).toEqual({
      port: 8788,
      host: "0.0.0.0",
      dbPath: "relay.db",
      dailyCap: 500,
      maxRegistrations: 10000,
      restrictEgress: false,
    });
  });

  it("rejects passing both --restrict-egress and --no-restrict-egress", () => {
    expect(() => parseCliConfig(["--restrict-egress", "--no-restrict-egress"])).toThrow("mutually exclusive");
  });

  it("localhost bind host also defaults restrictEgress off", () => {
    expect(parseCliConfig(["--host", "localhost"]).restrictEgress).toBe(false);
  });
});

// runCli spawns the relay as a real child process rather than calling the function in-process,
// so a SIGINT/SIGTERM sent to it can never be mistaken for a signal aimed at the test runner
// itself, and so the CLI-driven bind is proven over a real socket end to end.
describe("runCli", () => {
  it(
    "binds on the CLI-driven host/port and exits 0 after SIGTERM closes it cleanly",
    async () => {
      await withSpawnedRelay([], async (child, url) => {
        const health = await fetch(`${url}/health`);
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ name: "cozygateway-relay" });

        const exited = waitForExit(child);
        child.kill("SIGTERM");
        const { code, signal } = await exited;
        // runCli awaits relay.close() then resolves 0, and the wrapper calls process.exit(0):
        // a clean exit is code 0 with no delivered signal, not a signal-terminated process.
        expect(code).toBe(0);
        expect(signal).toBeNull();
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "exits 0 after SIGINT closes it cleanly",
    async () => {
      await withSpawnedRelay([], async (child, url) => {
        expect((await fetch(`${url}/health`)).status).toBe(200);
        const exited = waitForExit(child);
        child.kill("SIGINT");
        const { code, signal } = await exited;
        expect(code).toBe(0);
        expect(signal).toBeNull();
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "rejects invalid CLI config before ever binding, exiting 1 with a usage message",
    async () => {
      const child = spawn(process.execPath, [CLI_SOURCE, "--port", "not-a-port"], {
        stdio: ["ignore", "pipe", "pipe"],
      }) as ChildProcessByStdio<null, Readable, Readable>;
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      try {
        const { code, signal } = await waitForExit(child);
        expect(code).toBe(1);
        expect(signal).toBeNull();
        expect(stderr).toContain("invalid --port");
        expect(stderr).toContain("usage:");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

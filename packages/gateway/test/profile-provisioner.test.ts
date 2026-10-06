import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInstallerProvisioner,
  type ProvisionerSpawn,
} from "../src/hermes-bridge/profile-provisioner.ts";

/** The provisioner is the piece that turns "the installer adds them to gateway config, and the
 *  ensuing restart constructs the native plane" from a comment into a thing that happens. It runs
 *  the shipped installer (local, already-verified assets, unattended) as a detached process that
 *  outlives the gateway restart the installer performs. Everything here is asserted against a fake
 *  spawn: no real installer ever runs from a unit test. */

const tmps: string[] = [];
afterEach(() => {
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeChild extends EventEmitter {
  unref(): void;
  unrefCalls: number;
  pid: number;
}

interface Spawned {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
  child: FakeChild;
}

function fakeSpawn(): { spawn: ProvisionerSpawn; calls: Spawned[] } {
  const calls: Spawned[] = [];
  const spawn: ProvisionerSpawn = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      unrefCalls: 0,
      pid: 4_000 + calls.length,
      unref() { this.unrefCalls += 1; },
    }) as FakeChild;
    calls.push({ command, args, options: options as Record<string, unknown>, child });
    return child as unknown as ReturnType<ProvisionerSpawn>;
  };
  return { spawn, calls };
}

function install(state: Record<string, string | undefined> = {}): {
  gatewayDir: string;
  configPath: string;
  bundle: string;
  archive: string;
  installer: string;
} {
  const gatewayDir = mkdtempSync(join(tmpdir(), "cozygateway-provisioner-"));
  tmps.push(gatewayDir);
  mkdirSync(join(gatewayDir, "bin"));
  mkdirSync(join(gatewayDir, "local"));
  const bundle = join(gatewayDir, "bin", "cozygateway.mjs");
  const archive = join(gatewayDir, "bin", "cozygateway-hermes-attach-plugin.tar.gz");
  const installer = join(gatewayDir, "bin", "agent-install.sh");
  const configPath = join(gatewayDir, "local", "cozygateway.config.json");
  writeFileSync(bundle, "");
  writeFileSync(archive, "");
  writeFileSync(installer, "#!/usr/bin/env bash\n");
  writeFileSync(configPath, "{}\n");
  const lines: Record<string, string | undefined> = {
    profile_scope: "all",
    hermes_root: "/home/u/.hermes",
    hermes_bin: "/home/u/.local/bin/hermes",
    harness: "hermes",
    bundle_path: bundle,
    ...state,
  };
  writeFileSync(
    join(gatewayDir, "local", "install-state"),
    Object.entries(lines).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}\n`).join(""),
  );
  return { gatewayDir, configPath, bundle, archive, installer };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createInstallerProvisioner", () => {
  it("runs the shipped installer unattended from local assets, detached, logging to provision.log", async () => {
    const { gatewayDir, configPath, bundle, archive, installer } = install();
    const { spawn, calls } = fakeSpawn();
    const logs: string[] = [];
    const provisioner = createInstallerProvisioner({
      configPath, log: (line) => logs.push(line), platform: "darwin", spawn,
      env: { HOME: "/home/u", PATH: "/usr/bin", COZYGATEWAY_ATTACH_TOKEN_DEFAULT: "secret-token-value" },
      debounceMs: 5,
    });
    expect(provisioner).toBeDefined();

    provisioner!.provision({ profile: "night-owl", change: "created" });
    expect(calls).toHaveLength(0);
    await tick(40);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("bash");
    expect(calls[0]!.args).toEqual([
      installer, "--gateway-dir", gatewayDir, "--bundle", bundle, "--plugin-archive", archive, "--no-qr",
    ]);
    const options = calls[0]!.options;
    expect(options["detached"]).toBe(true);
    expect((options["env"] as Record<string, string>)["COZYGATEWAY_HERMES_BIN"]).toBe("/home/u/.local/bin/hermes");
    expect((options["env"] as Record<string, string>)["HOME"]).toBe("/home/u");
    const stdio = options["stdio"] as unknown[];
    expect(stdio[0]).toBe("ignore");
    expect(typeof stdio[1]).toBe("number");
    expect(stdio[2]).toBe(stdio[1]);
    expect(calls[0]!.child.unrefCalls).toBe(1);
    expect(readFileSync(join(gatewayDir, "local", "provision.log"), "utf8")).toContain("night-owl");

    calls[0]!.child.emit("exit", 0, null);
    expect(logs.some((line) => /started/.test(line) && line.includes("night-owl"))).toBe(true);
    expect(logs.some((line) => /finished/.test(line) && line.includes("0"))).toBe(true);
    expect(logs.join("\n")).not.toContain("secret-token-value");
  });

  it("coalesces a burst into one run and reruns once more when triggered mid-run", async () => {
    const { configPath } = install();
    const { spawn, calls } = fakeSpawn();
    const provisioner = createInstallerProvisioner({
      configPath, log: () => {}, platform: "darwin", spawn, env: {}, debounceMs: 5,
    })!;

    provisioner.provision({ profile: "a", change: "created" });
    provisioner.provision({ profile: "b", change: "created" });
    provisioner.provision({ profile: "c", change: "deleted" });
    await tick(40);
    expect(calls).toHaveLength(1);

    // Mid-run triggers, however many, are one pending rerun.
    provisioner.provision({ profile: "d", change: "created" });
    provisioner.provision({ profile: "e", change: "created" });
    await tick(40);
    expect(calls).toHaveLength(1);

    calls[0]!.child.emit("exit", 0, null);
    await tick(40);
    expect(calls).toHaveLength(2);

    calls[1]!.child.emit("exit", 1, null);
    await tick(40);
    expect(calls).toHaveLength(2);
  });

  it("a spawn failure is logged and releases the single-flight slot", async () => {
    const { configPath } = install();
    const { spawn, calls } = fakeSpawn();
    const logs: string[] = [];
    const provisioner = createInstallerProvisioner({
      configPath, log: (line) => logs.push(line), platform: "darwin", spawn, env: {}, debounceMs: 5,
    })!;
    provisioner.provision({ profile: "a", change: "created" });
    await tick(40);
    calls[0]!.child.emit("error", new Error("ENOENT bash"));
    expect(logs.some((line) => line.includes("ENOENT bash"))).toBe(true);

    provisioner.provision({ profile: "b", change: "created" });
    await tick(40);
    expect(calls).toHaveLength(2);
  });

  it("on Linux with systemd-run the run lives in its own transient user unit", async () => {
    const { gatewayDir, configPath, bundle, archive, installer } = install();
    const { spawn, calls } = fakeSpawn();
    const provisioner = createInstallerProvisioner({
      configPath, log: () => {}, platform: "linux", spawn,
      env: { HOME: "/home/u", PATH: "/usr/bin:/bin" }, hasSystemdRun: () => true, debounceMs: 5,
    })!;
    provisioner.provision({ profile: "a", change: "created" });
    await tick(40);

    expect(calls[0]!.command).toBe("systemd-run");
    const args = [...calls[0]!.args];
    expect(args.slice(0, 4)).toEqual(["--user", "--collect", "--quiet", "--unit"]);
    expect(args[4]).toMatch(/^cozygateway-provision-\d+$/);
    expect(args).toContain("--setenv=HOME=/home/u");
    expect(args).toContain("--setenv=PATH=/usr/bin:/bin");
    expect(args).toContain("--setenv=COZYGATEWAY_HERMES_BIN=/home/u/.local/bin/hermes");
    expect(args.slice(-9)).toEqual([
      "bash", installer, "--gateway-dir", gatewayDir, "--bundle", bundle, "--plugin-archive", archive, "--no-qr",
    ]);
  });

  it("on Linux without systemd-run it still spawns bash detached and says so", async () => {
    const { configPath } = install();
    const { spawn, calls } = fakeSpawn();
    const logs: string[] = [];
    const provisioner = createInstallerProvisioner({
      configPath, log: (line) => logs.push(line), platform: "linux", spawn, env: {},
      hasSystemdRun: () => false, debounceMs: 5,
    })!;
    provisioner.provision({ profile: "a", change: "created" });
    await tick(40);
    expect(calls[0]!.command).toBe("bash");
    expect(calls[0]!.options["detached"]).toBe(true);
    expect(logs.some((line) => /systemd-run/.test(line))).toBe(true);
  });

  describe("stays out of the way when the install is not one it may reprovision", () => {
    const cases: Array<[string, Record<string, string | undefined>, NodeJS.Platform]> = [
      ["a narrowed profile scope", { profile_scope: "default,ops" }, "darwin"],
      ["a runtime-only repair mode", { repair_mode: "runtime-only" }, "darwin"],
      ["a CozyAgents harness", { harness: "cozyagents" }, "darwin"],
      ["no recorded bundle", { bundle_path: undefined }, "darwin"],
      ["Windows", {}, "win32"],
    ];
    for (const [label, state, platform] of cases) {
      it(label, () => {
        const { configPath } = install(state);
        const { spawn, calls } = fakeSpawn();
        const logs: string[] = [];
        const provisioner = createInstallerProvisioner({
          configPath, log: (line) => logs.push(line), platform, spawn, env: {}, debounceMs: 5,
        });
        expect(provisioner).toBeUndefined();
        expect(calls).toHaveLength(0);
        expect(logs).toHaveLength(1);
      });
    }

    it("no install-state at all (a programmatic or docker gateway)", () => {
      const dir = mkdtempSync(join(tmpdir(), "cozygateway-provisioner-"));
      tmps.push(dir);
      const configPath = join(dir, "cozygateway.config.json");
      writeFileSync(configPath, "{}\n");
      const { spawn } = fakeSpawn();
      const logs: string[] = [];
      expect(createInstallerProvisioner({ configPath, log: (line) => logs.push(line), platform: "darwin", spawn, env: {} })).toBeUndefined();
      expect(logs).toHaveLength(1);
    });

    it("a missing installer or plugin archive", () => {
      const { gatewayDir, configPath } = install();
      rmSync(join(gatewayDir, "bin", "agent-install.sh"));
      const { spawn } = fakeSpawn();
      const logs: string[] = [];
      expect(createInstallerProvisioner({ configPath, log: (line) => logs.push(line), platform: "darwin", spawn, env: {} })).toBeUndefined();
      expect(logs).toHaveLength(1);
    });
  });
});

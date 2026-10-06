import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** One profile lifecycle change the bridge observed. `created` is a Hermes profile `POST /bots`
 *  just made; `deleted` is one `DELETE /bots/:name` just removed. */
export interface ProfileChangeEvent {
  profile: string;
  change: "created" | "deleted";
}

/** Turns a phone-created Hermes profile from a `setup_required` roster row into a chattable bot.
 *
 *  A profile that `POST /bots` creates is NOT in the gateway's configured attach map: it has no
 *  attach identity, no synced plugin, no token in its own `.env`, and no Hermes gateway service of
 *  its own. On a native install every one of those is written by the shipped installer, whose
 *  default `all` profile scope discovers the new profile on a rerun. This is what starts that
 *  rerun without anyone at a terminal. */
export interface ProfileProvisioner {
  /** Fire-and-forget. Never throws; never blocks the request that called it. */
  provision(event: ProfileChangeEvent): void;
}

/** The `child_process.spawn` shape this module needs, narrowed so a test can hand in a fake. */
export type ProvisionerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Pick<ChildProcess, "on" | "once" | "unref" | "pid">;

export interface InstallerProvisionerOptions {
  /** The gateway's source JSON config path. The installer's `install-state` lives beside it. */
  configPath: string;
  /** Diagnostic sink. Lines never carry a token value: only paths, profile names, and exit codes. */
  log: (line: string) => void;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Test seam. Defaults to `child_process.spawn`. */
  spawn?: ProvisionerSpawn;
  /** Environment the installer inherits. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Whether `systemd-run` is on PATH (Linux only). Defaults to a PATH scan of `env.PATH`. */
  hasSystemdRun?: () => boolean;
  /** Burst window before a run starts, so several creates in a row cost one installer run. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 1_000;

/** The installer's `write_state` writes `key=value` lines; values are paths and short words. */
function readInstallState(path: string): Record<string, string> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const state: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    state[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return state;
}

function systemdRunOnPath(env: NodeJS.ProcessEnv): boolean {
  return (env["PATH"] ?? "").split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, "systemd-run")));
}

/** Builds a provisioner for the install recorded beside `configPath`, or `undefined` (with one
 *  logged reason) when this is not an install the gateway may reprovision on its own:
 *
 *  - no `install-state`: a programmatic, docker, or hand-written config; someone else owns it;
 *  - `harness` is not `hermes`: a CozyAgents gateway has no Hermes profiles to provision;
 *  - `profile_scope` is not `all`: the operator chose isolation with `--profiles`, and a run here
 *    would still honour that narrowed scope, so it would provision nothing;
 *  - `repair_mode=runtime-only`: the recorded repair refreshes the runtime only;
 *  - Windows: phone-created bot provisioning is not part of the Windows installer
 *    (`docs/agent-install.md`), and its supervisor would restart the gateway with stale tokens;
 *  - the installer or the plugin archive is missing from `<gateway dir>/bin`. */
export function createInstallerProvisioner(opts: InstallerProvisionerOptions): ProfileProvisioner | undefined {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const spawn = opts.spawn ?? (nodeSpawn as unknown as ProvisionerSpawn);
  const localDir = dirname(opts.configPath);
  const statePath = join(localDir, "install-state");
  const log = opts.log;
  const off = (reason: string): undefined => {
    log(`phone-created bot provisioning is off: ${reason}`);
    return undefined;
  };

  const state = readInstallState(statePath);
  if (state === undefined) return off(`no installer state at ${statePath}`);
  if (platform === "win32") return off("not part of the Windows installer");
  if ((state["harness"] ?? "hermes") !== "hermes") return off(`harness is ${state["harness"]}, not hermes`);
  if ((state["profile_scope"] ?? "") !== "all") return off("the installer's profile scope was narrowed with --profiles");
  if (state["repair_mode"] === "runtime-only") return off("the recorded repair mode is runtime-only");
  const bundle = state["bundle_path"];
  if (bundle === undefined || bundle.length === 0) return off("installer state records no bundle path");
  const hermesBin = state["hermes_bin"];
  if (hermesBin === undefined || hermesBin.length === 0) return off("installer state records no hermes binary");
  const gatewayDir = dirname(dirname(bundle));
  const installer = join(gatewayDir, "bin", "agent-install.sh");
  const archive = join(gatewayDir, "bin", "cozygateway-hermes-attach-plugin.tar.gz");
  for (const required of [bundle, installer, archive]) {
    if (!existsSync(required)) return off(`${required} is missing`);
  }
  const logPath = join(localDir, "provision.log");
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const hasSystemdRun = opts.hasSystemdRun ?? (() => systemdRunOnPath(env));

  const installerArgs = [installer, "--gateway-dir", gatewayDir, "--bundle", bundle, "--plugin-archive", archive, "--no-qr"];
  const childEnv: NodeJS.ProcessEnv = { ...env, COZYGATEWAY_HERMES_BIN: hermesBin };

  /** The command for one run. On Linux the gateway is a systemd user service and
   *  `systemctl --user restart` (which the installer performs) kills the whole service cgroup, a
   *  detached grandchild included; a transient unit of its own is the only place the run survives.
   *  On macOS `launchctl bootout` reaps the job's process group, and a detached child has its own. */
  function command(): { command: string; args: string[]; note?: string } {
    if (platform === "linux") {
      if (hasSystemdRun()) {
        const setenv = ["HOME", "PATH", "COZYGATEWAY_HERMES_BIN"]
          .filter((key) => childEnv[key] !== undefined)
          .map((key) => `--setenv=${key}=${childEnv[key]}`);
        return {
          command: "systemd-run",
          args: ["--user", "--collect", "--quiet", "--unit", `cozygateway-provision-${Date.now()}`, ...setenv, "bash", ...installerArgs],
        };
      }
      return { command: "bash", args: installerArgs, note: "systemd-run is not on PATH; the run may not survive the gateway service restart" };
    }
    return { command: "bash", args: installerArgs };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  /** Names collected while waiting, so the log line says which changes one run is answering. */
  let reasons: string[] = [];

  function start(): void {
    const batch = reasons;
    reasons = [];
    const run = command();
    let fd: number;
    try {
      fd = openSync(logPath, "a", 0o600);
      writeSync(fd, `\n=== ${new Date().toISOString()} provisioning run for ${batch.join(", ")} ===\n`);
    } catch (error) {
      log(`provisioning run for ${batch.join(", ")} could not open ${logPath}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    running = true;
    let child: ReturnType<ProvisionerSpawn>;
    try {
      child = spawn(run.command, run.args, { detached: true, stdio: ["ignore", fd, fd], env: childEnv, cwd: gatewayDir });
    } catch (error) {
      closeSync(fd);
      running = false;
      log(`provisioning run for ${batch.join(", ")} could not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (run.note !== undefined) log(run.note);
    log(`provisioning run started for ${batch.join(", ")}; log: ${logPath}`);
    let settled = false;
    const finish = (outcome: string) => {
      if (settled) return;
      settled = true;
      try { closeSync(fd); } catch { /* already closed */ }
      running = false;
      log(`provisioning run finished (${outcome}); log: ${logPath}`);
      if (pending) {
        pending = false;
        schedule();
      }
    };
    child.once("error", (error) => finish(`could not run: ${error instanceof Error ? error.message : String(error)}`));
    child.once("exit", (code, signal) => finish(code === null ? `signal ${String(signal)}` : `exit code ${code}`));
    child.unref();
  }

  function schedule(): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (running) {
        pending = true;
        return;
      }
      start();
    }, debounceMs);
  }

  return {
    provision(event) {
      try {
        reasons.push(`${event.profile} (${event.change})`);
        if (running) {
          pending = true;
          return;
        }
        schedule();
      } catch (error) {
        log(`provisioning could not be scheduled: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

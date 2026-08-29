import { spawn } from "node:child_process";
import type { WindowsLanAdapter, WindowsLanInventory } from "./lan.ts";

export const WINDOWS_HELPER_SCHEMA_VERSION = 1 as const;
export const WINDOWS_HELPER_MAX_BYTES = 64 * 1024;

export type WindowsHelperCommand =
  | "discover-tailscale"
  | "install-tailscale"
  | "set-preference"
  | "set-preference-cleanup"
  | "open-browser"
  | "initialize-pending"
  | "protect-path"
  | "inspect-network-safety"
  | "adapter-inventory";

export type WindowsHelperReason =
  | "invalid_request"
  | "request_too_large"
  | "path_rejected"
  | "path_reparse_point"
  | "acl_failed"
  | "network_inspection_failed"
  | "tailscale_not_installed"
  | "tailscale_legacy_unsupported"
  | "tailscale_service_mismatch"
  | "tailscale_signature_invalid"
  | "tailscale_publisher_invalid"
  | "tailscale_prerequisite_disabled"
  | "download_failed"
  | "download_redirect_rejected"
  | "download_too_large"
  | "installer_signature_invalid"
  | "installer_cancelled"
  | "installer_reboot_required"
  | "installer_failed"
  | "preference_failed"
  | "preference_cancelled"
  | "preference_verification_failed"
  | "preference_elevation_required"
  | "browser_url_rejected"
  | "browser_open_failed"
  | "inventory_failed"
  | "internal_error";

export interface WindowsHelperRunOptions {
  stdin: string;
  shell: false;
  windowsHide: true;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface WindowsHelperRunResult {
  exitCode: number;
  stdout: string | Uint8Array;
  stderr: string | Uint8Array;
}

export interface WindowsNetworkSafety {
  networkCategory: "private" | "public" | "domain" | "unknown";
  firewallEnabled: boolean;
  defaultInboundAction: "allow" | "block" | "not_configured" | "unknown";
}

export type WindowsHelperRunner = (
  executable: string,
  args: string[],
  options: WindowsHelperRunOptions,
) => Promise<WindowsHelperRunResult>;

export interface WindowsHelperClientOptions {
  helperPath: string;
  powershellPath?: string;
  runner?: WindowsHelperRunner;
  timeoutMs?: number;
}

export type TailscaleDiscovery =
  | { state: "ready"; cliPath: string; daemonPath: string }
  | { state: "paused"; reason: WindowsHelperReason };

export class WindowsHelperProtocolError extends Error {
  constructor(message = "invalid Windows helper response") {
    super(message);
    this.name = "WindowsHelperProtocolError";
  }
}

export class WindowsHelperError extends Error {
  readonly reason: WindowsHelperReason;

  constructor(reason: WindowsHelperReason) {
    super(reason);
    this.name = "WindowsHelperError";
    this.reason = reason;
  }
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: string | Uint8Array, maxBytes: number): string {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (bytes.byteLength > maxBytes) throw new WindowsHelperProtocolError("Windows helper response exceeded its bound");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WindowsHelperProtocolError("Windows helper response was not UTF-8");
  }
}

function validReason(value: unknown): value is WindowsHelperReason {
  return typeof value === "string" && new Set<WindowsHelperReason>([
    "invalid_request", "request_too_large", "path_rejected", "path_reparse_point", "acl_failed",
    "tailscale_not_installed", "tailscale_legacy_unsupported", "tailscale_service_mismatch",
    "tailscale_signature_invalid", "tailscale_publisher_invalid", "tailscale_prerequisite_disabled",
    "download_failed", "download_redirect_rejected", "download_too_large", "installer_signature_invalid",
    "installer_cancelled", "installer_reboot_required", "installer_failed", "preference_failed", "preference_cancelled", "preference_verification_failed", "preference_elevation_required",
    "browser_url_rejected", "browser_open_failed", "inventory_failed", "internal_error",
    "network_inspection_failed",
  ]).has(value as WindowsHelperReason);
}

const COMMON_FAILURE_REASONS = ["invalid_request", "request_too_large", "internal_error"] as const;
const COMMAND_FAILURE_REASONS: Record<WindowsHelperCommand, ReadonlySet<WindowsHelperReason>> = {
  "discover-tailscale": new Set(COMMON_FAILURE_REASONS),
  "install-tailscale": new Set([
    ...COMMON_FAILURE_REASONS, "download_failed", "download_redirect_rejected", "download_too_large",
    "installer_signature_invalid", "installer_cancelled", "installer_reboot_required", "installer_failed",
  ]),
  "set-preference": new Set([
    ...COMMON_FAILURE_REASONS, "tailscale_not_installed", "tailscale_legacy_unsupported",
    "tailscale_service_mismatch", "tailscale_signature_invalid", "tailscale_publisher_invalid",
    "tailscale_prerequisite_disabled", "preference_failed", "preference_cancelled",
    "preference_verification_failed",
  ]),
  "set-preference-cleanup": new Set([
    ...COMMON_FAILURE_REASONS, "tailscale_not_installed", "tailscale_legacy_unsupported",
    "tailscale_service_mismatch", "tailscale_signature_invalid", "tailscale_publisher_invalid",
    "tailscale_prerequisite_disabled", "preference_failed", "preference_elevation_required",
    "preference_verification_failed",
  ]),
  "open-browser": new Set([...COMMON_FAILURE_REASONS, "browser_url_rejected", "browser_open_failed"]),
  "initialize-pending": new Set([...COMMON_FAILURE_REASONS, "path_rejected", "path_reparse_point", "acl_failed"]),
  "protect-path": new Set([...COMMON_FAILURE_REASONS, "path_rejected", "path_reparse_point", "acl_failed"]),
  "inspect-network-safety": new Set([...COMMON_FAILURE_REASONS, "network_inspection_failed"]),
  "adapter-inventory": new Set([...COMMON_FAILURE_REASONS, "inventory_failed"]),
};

const DISCOVERY_PAUSE_REASONS = new Set<WindowsHelperReason>([
  "tailscale_not_installed", "tailscale_legacy_unsupported", "tailscale_service_mismatch",
  "tailscale_signature_invalid", "tailscale_publisher_invalid", "tailscale_prerequisite_disabled",
]);

function adapter(value: unknown): value is WindowsLanAdapter {
  if (!record(value) || !exactKeys(value, ["id", "displayName", "kind", "hardwareInterface", "status", "ipv4Addresses"])) return false;
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128
    && typeof value.displayName === "string" && value.displayName.length <= 256
    && (value.kind === "ethernet" || value.kind === "wifi" || value.kind === "other")
    && typeof value.hardwareInterface === "boolean"
    && (value.status === "up" || value.status === "down" || value.status === "disabled" || value.status === "unknown")
    && Array.isArray(value.ipv4Addresses) && value.ipv4Addresses.length <= 64
    && value.ipv4Addresses.every((address) => typeof address === "string" && address.length <= 15);
}

function inventory(value: unknown): value is WindowsLanInventory {
  return record(value) && exactKeys(value, ["schemaVersion", "adapters"])
    && value.schemaVersion === 1 && Array.isArray(value.adapters) && value.adapters.length <= 256
    && value.adapters.every(adapter);
}

function networkSafety(value: unknown): value is WindowsNetworkSafety {
  return record(value) && exactKeys(value, ["networkCategory", "firewallEnabled", "defaultInboundAction"])
    && (value.networkCategory === "private" || value.networkCategory === "public"
      || value.networkCategory === "domain" || value.networkCategory === "unknown")
    && typeof value.firewallEnabled === "boolean"
    && (value.defaultInboundAction === "allow" || value.defaultInboundAction === "block"
      || value.defaultInboundAction === "not_configured" || value.defaultInboundAction === "unknown");
}

function discovery(value: unknown): value is TailscaleDiscovery {
  if (!record(value)) return false;
  if (value.state === "ready") {
    return exactKeys(value, ["state", "cliPath", "daemonPath"])
      && typeof value.cliPath === "string" && isFullyQualifiedWindowsPath(value.cliPath)
      && typeof value.daemonPath === "string" && isFullyQualifiedWindowsPath(value.daemonPath);
  }
  return value.state === "paused" && exactKeys(value, ["state", "reason"])
    && validReason(value.reason) && DISCOVERY_PAUSE_REASONS.has(value.reason);
}

function applied(value: unknown): value is { applied: boolean } {
  return record(value) && exactKeys(value, ["applied"]) && value.applied === true;
}

export const runWindowsHelperProcess: WindowsHelperRunner = (executable, args, options) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, {
    shell: options.shell,
    windowsHide: options.windowsHide,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let pendingError: Error | undefined;
  const rejectNow = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  };
  const terminate = (error: Error) => {
    if (settled || pendingError !== undefined) return;
    pendingError = error;
    clearTimeout(timer);
    if (child.pid === undefined) rejectNow(error);
    else if (process.platform === "win32" && process.env.SystemRoot !== undefined) {
      const killer = spawn(`${process.env.SystemRoot}\\System32\\taskkill.exe`, ["/pid", String(child.pid), "/t", "/f"], {
        shell: false, windowsHide: true, stdio: "ignore",
      });
      killer.once("error", () => child.kill());
      killer.once("close", () => child.kill());
    } else child.kill();
  };
  const timer = setTimeout(() => terminate(new WindowsHelperProtocolError("Windows helper timed out")), options.timeoutMs);
  child.on("error", (error) => {
    if (child.pid === undefined) rejectNow(error);
    else terminate(error);
  });
  child.stdin.on("error", terminate);
  const abort = () => terminate(new WindowsHelperProtocolError("Windows helper aborted"));
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > options.maxOutputBytes) return terminate(new WindowsHelperProtocolError("Windows helper response exceeded its bound"));
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 8 * 1024) stderr.push(chunk);
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (pendingError !== undefined) reject(pendingError);
    else resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
  });
  child.stdin.end(options.stdin, "utf8");
  if (options.signal?.aborted) abort();
});

export class WindowsHelperClient {
  readonly #helperPath: string;
  readonly #powershellPath: string;
  readonly #runner: WindowsHelperRunner;
  readonly #timeoutMs: number;

  constructor(options: WindowsHelperClientOptions) {
    if (!isFullyQualifiedWindowsPath(options.helperPath)) throw new Error("a fully qualified helper path is required");
    const defaultPowerShell = process.env.SystemRoot === undefined
      ? ""
      : `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const powershellPath = options.powershellPath ?? defaultPowerShell;
    if (!isFullyQualifiedWindowsPath(powershellPath)) throw new Error("a fully qualified PowerShell path is required");
    this.#helperPath = options.helperPath;
    this.#powershellPath = powershellPath;
    this.#runner = options.runner ?? runWindowsHelperProcess;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async #invoke(command: WindowsHelperCommand, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const stdin = JSON.stringify(input);
    if (Buffer.byteLength(stdin, "utf8") > WINDOWS_HELPER_MAX_BYTES) throw new Error("Windows helper request exceeded its bound");
    const run = await this.#runner(
      this.#powershellPath,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.#helperPath, command],
      { stdin, shell: false, windowsHide: true, timeoutMs: this.#timeoutMs, maxOutputBytes: WINDOWS_HELPER_MAX_BYTES, signal },
    );
    const raw = text(run.stdout, WINDOWS_HELPER_MAX_BYTES).trim();
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { throw new WindowsHelperProtocolError(); }
    if (!record(envelope) || envelope.schemaVersion !== WINDOWS_HELPER_SCHEMA_VERSION || envelope.command !== command || typeof envelope.ok !== "boolean")
      throw new WindowsHelperProtocolError();
    if (envelope.ok) {
      if (run.exitCode !== 0 || !exactKeys(envelope, ["schemaVersion", "ok", "command", "result"])) throw new WindowsHelperProtocolError();
      return envelope.result;
    }
    if (run.exitCode === 0 || !exactKeys(envelope, ["schemaVersion", "ok", "command", "reason"])
      || !validReason(envelope.reason) || !COMMAND_FAILURE_REASONS[command].has(envelope.reason))
      throw new WindowsHelperProtocolError();
    throw new WindowsHelperError(envelope.reason);
  }

  async discoverTailscale(signal?: AbortSignal): Promise<TailscaleDiscovery> {
    const result = await this.#invoke("discover-tailscale", {}, signal);
    if (!discovery(result)) throw new WindowsHelperProtocolError();
    return result;
  }

  async installTailscale(signal?: AbortSignal): Promise<void> {
    if (!applied(await this.#invoke("install-tailscale", {}, signal))) throw new WindowsHelperProtocolError();
  }

  async setPreference(preference: "unattended" | "shields-up", enabled: boolean, signal?: AbortSignal): Promise<void> {
    if (!applied(await this.#invoke("set-preference", { preference, enabled }, signal))) throw new WindowsHelperProtocolError();
  }

  async setPreferenceForCleanup(preference: "unattended" | "shields-up", enabled: boolean, signal?: AbortSignal): Promise<void> {
    if (!applied(await this.#invoke("set-preference-cleanup", { preference, enabled }, signal))) throw new WindowsHelperProtocolError();
  }

  async openBrowser(purpose: "login" | "https-consent", url: string, signal?: AbortSignal): Promise<void> {
    if (!applied(await this.#invoke("open-browser", { purpose, url }, signal))) throw new WindowsHelperProtocolError();
  }

  async initializePending(root: string, signal?: AbortSignal): Promise<void> {
    if (!applied(await this.#invoke("initialize-pending", { root }, signal))) throw new WindowsHelperProtocolError();
  }

  async protectPath(root: string, path: string, signal?: AbortSignal): Promise<void> {
    if (!applied(await this.#invoke("protect-path", { root, path }, signal))) throw new WindowsHelperProtocolError();
  }

  async inspectNetworkSafety(adapterId: string, signal?: AbortSignal): Promise<WindowsNetworkSafety> {
    const result = await this.#invoke("inspect-network-safety", { adapterId }, signal);
    if (!networkSafety(result)) throw new WindowsHelperProtocolError();
    return result;
  }

  async adapterInventory(signal?: AbortSignal): Promise<WindowsLanInventory> {
    const result = await this.#invoke("adapter-inventory", {}, signal);
    if (!inventory(result)) throw new WindowsHelperProtocolError();
    return result;
  }
}

import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";

export const TAILSCALE_CLI_MAX_OBJECT_BYTES = 64 * 1024;
export const TAILSCALE_CLI_MAX_TOTAL_BYTES = 256 * 1024;
export const TAILSCALE_LOCALAPI_PIPE = "\\\\.\\pipe\\ProtectedPrefix\\Administrators\\Tailscale\\tailscaled";

export type TailscaleCliErrorReason =
  | "invalid_executable"
  | "timeout"
  | "cancelled"
  | "output_too_large"
  | "invalid_utf8"
  | "malformed_json"
  | "unexpected_output"
  | "command_failed"
  | "unsupported_version"
  | "custom_control_server"
  | "invalid_preferences"
  | "invalid_status"
  | "invalid_auth_url";

export class TailscaleCliError extends Error {
  readonly reason: TailscaleCliErrorReason;

  constructor(reason: TailscaleCliErrorReason) {
    super(`Tailscale operation paused: ${reason}`);
    this.name = "TailscaleCliError";
    this.reason = reason;
  }
}

export interface TailscaleCliRunOptions {
  shell: false;
  windowsHide: true;
  timeoutMs: number;
  maxObjectBytes: number;
  maxTotalBytes: number;
  signal: AbortSignal;
  onStdoutChunk?: (chunk: Uint8Array) => void;
}

export type TailscaleCliOutput = string | Uint8Array | readonly (string | Uint8Array)[];

export interface TailscaleCliRunResult {
  exitCode: number;
  stdout: TailscaleCliOutput;
  stderr: TailscaleCliOutput;
}

export type TailscaleCliRunner = (
  executable: string,
  argv: readonly string[],
  options: TailscaleCliRunOptions,
) => Promise<TailscaleCliRunResult>;

export interface TailscaleCliOptions {
  executable: string;
  runner?: TailscaleCliRunner;
  timeoutMs?: number;
}

export interface TailscaleVersion {
  major: number;
  minor: number;
  patch: number;
  display: string;
}

export type TailscaleStatus =
  | { state: "needs_login"; authUrl?: string }
  | { state: "needs_machine_auth" }
  | { state: "stopped" | "starting" }
  | {
      state: "running";
      dnsName: string;
      magicDnsSuffix: string;
      accountLabel: string;
      accountId: string;
      tailnetName: string;
      certificateReady: boolean;
    };

export type TailscaleLoginResult =
  | { outcome: "running" }
  | { outcome: "machine_auth_required" }
  | { outcome: "auth_required"; authUrl: string };

function isFullyQualifiedWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/.test(value);
}

function chunks(value: TailscaleCliOutput): readonly (string | Uint8Array)[] {
  return Array.isArray(value) ? value : [value as string | Uint8Array];
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function decodeBounded(value: TailscaleCliOutput, maxBytes: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let total = 0;
  try {
    const values = chunks(value);
    for (let index = 0; index < values.length; index += 1) {
      const part = bytes(values[index]!);
      total += part.byteLength;
      if (total > maxBytes) throw new TailscaleCliError("output_too_large");
      parts.push(decoder.decode(part, { stream: index + 1 < values.length }));
    }
  } catch (error) {
    if (error instanceof TailscaleCliError) throw error;
    throw new TailscaleCliError("invalid_utf8");
  }
  return parts.join("");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.parse is last-key-wins. CLI security state must instead reject duplicate keys, including
 * escaped spellings of the same key, at every nesting level. Syntax remains JSON.parse's job. */
function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;
  const whitespace = () => {
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
  };
  const stringToken = (): string => {
    if (text[index] !== '"') throw new Error("expected JSON string");
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index++]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    throw new Error("unterminated JSON string");
  };
  const value = (depth: number): void => {
    if (depth > 128) throw new Error("JSON nesting exceeded its bound");
    whitespace();
    if (text[index] === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") { index += 1; return; }
      while (index < text.length) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) throw new Error("duplicate JSON key");
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") throw new Error("missing JSON colon");
        value(depth + 1);
        whitespace();
        const separator = text[index++];
        if (separator === "}") return;
        if (separator !== ",") throw new Error("invalid JSON object separator");
      }
      throw new Error("unterminated JSON object");
    }
    if (text[index] === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") { index += 1; return; }
      while (index < text.length) {
        value(depth + 1);
        whitespace();
        const separator = text[index++];
        if (separator === "]") return;
        if (separator !== ",") throw new Error("invalid JSON array separator");
      }
      throw new Error("unterminated JSON array");
    }
    if (text[index] === '"') {
      stringToken();
      return;
    }
    const start = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index]!)) index += 1;
    if (start === index) throw new Error("missing JSON value");
  };
  value(0);
  whitespace();
  if (index !== text.length) throw new Error("trailing JSON data");
}

function dnsName(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value !== value.toLowerCase() || !/^[\x00-\x7f]+$/.test(value))
    return false;
  if (!value.endsWith(".ts.net") || value === "ts.net") return false;
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function supportedVersionText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(value);
  if (match === null) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major > 1 || (major === 1 && (minor > 102 || (minor === 102 && patch >= 1)));
}

function exactHttpsUrl(value: unknown, hosts: readonly string[]): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return undefined; }
  if (
    parsed.protocol !== "https:" || parsed.port !== "" || parsed.username !== "" || parsed.password !== ""
    || parsed.hash !== "" || !hosts.includes(parsed.hostname) || parsed.hostname !== parsed.hostname.toLowerCase()
  ) return undefined;
  return parsed.href;
}

function consentUrl(text: string, complete: boolean): string | undefined {
  const pattern = complete
    ? /https:\/\/[^\s<>"']+/g
    : /https:\/\/[^\s<>"']+(?=\s)/g;
  for (const candidate of text.match(pattern) ?? []) {
    const parsed = exactHttpsUrl(candidate.replace(/[),.;]+$/, ""), [
      "login.tailscale.com",
      "console.tailscale.com",
    ]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseSingleValue(output: TailscaleCliOutput): unknown {
  const text = decodeBounded(output, TAILSCALE_CLI_MAX_TOTAL_BYTES).trim();
  if (Buffer.byteLength(text, "utf8") > TAILSCALE_CLI_MAX_OBJECT_BYTES)
    throw new TailscaleCliError("output_too_large");
  try {
    assertNoDuplicateJsonKeys(text);
    return JSON.parse(text) as unknown;
  } catch {
    throw new TailscaleCliError("malformed_json");
  }
}

function parseSingleObject(output: TailscaleCliOutput): Record<string, unknown> {
  const value = parseSingleValue(output);
  if (!record(value)) throw new TailscaleCliError("unexpected_output");
  return value;
}

function parseObjectSequence(output: TailscaleCliOutput): Record<string, unknown>[] {
  const text = decodeBounded(output, TAILSCALE_CLI_MAX_TOTAL_BYTES);
  const values: Record<string, unknown>[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (start < 0) {
      if (/\s/.test(character)) continue;
      if (character !== "{") throw new TailscaleCliError("malformed_json");
      start = index;
      depth = 1;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth < 0) throw new TailscaleCliError("malformed_json");
      if (depth === 0) {
        const objectText = text.slice(start, index + 1);
        if (Buffer.byteLength(objectText, "utf8") > TAILSCALE_CLI_MAX_OBJECT_BYTES)
          throw new TailscaleCliError("output_too_large");
        let value: unknown;
        try {
          assertNoDuplicateJsonKeys(objectText);
          value = JSON.parse(objectText);
        } catch { throw new TailscaleCliError("malformed_json"); }
        if (!record(value)) throw new TailscaleCliError("unexpected_output");
        values.push(value);
        start = -1;
      }
    }
  }
  if (start >= 0 || quoted || values.length === 0) throw new TailscaleCliError("malformed_json");
  return values;
}

class IncrementalJsonObjectBound {
  #started = false;
  #depth = 0;
  #quoted = false;
  #escaped = false;
  #bytes = 0;

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (!this.#started) {
        if (byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x20) continue;
        if (byte !== 0x7b) throw new TailscaleCliError("malformed_json");
        this.#started = true;
        this.#depth = 1;
        this.#bytes = 1;
        continue;
      }
      this.#bytes += 1;
      if (this.#bytes > TAILSCALE_CLI_MAX_OBJECT_BYTES)
        throw new TailscaleCliError("output_too_large");
      if (this.#quoted) {
        if (this.#escaped) this.#escaped = false;
        else if (byte === 0x5c) this.#escaped = true;
        else if (byte === 0x22) this.#quoted = false;
        continue;
      }
      if (byte === 0x22) this.#quoted = true;
      else if (byte === 0x7b) this.#depth += 1;
      else if (byte === 0x7d) {
        this.#depth -= 1;
        if (this.#depth === 0) {
          this.#started = false;
          this.#bytes = 0;
        }
      }
    }
  }
}

export const runTailscaleCliProcess: TailscaleCliRunner = (executable, argv, options) => new Promise((resolve, reject) => {
  const child = spawn(executable, [...argv], {
    shell: options.shell,
    windowsHide: options.windowsHide,
    stdio: ["ignore", "pipe", "pipe"],
    signal: options.signal,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let total = 0;
  let settled = false;
  let pendingError: Error | undefined;
  const rejectNow = (error: Error) => {
    if (settled) return;
    settled = true;
    reject(error);
  };
  const finishError = (error: Error) => {
    if (settled || pendingError !== undefined) return;
    pendingError = error;
    if (child.pid === undefined) rejectNow(error);
    else child.kill();
  };
  const collect = (destination: Buffer[], observe?: (chunk: Uint8Array) => void) => (chunk: Buffer) => {
    total += chunk.byteLength;
    if (total > options.maxTotalBytes) {
      finishError(new TailscaleCliError("output_too_large"));
      return;
    }
    destination.push(chunk);
    try {
      observe?.(chunk);
    } catch (error) {
      finishError(error instanceof TailscaleCliError ? error : new TailscaleCliError("unexpected_output"));
    }
  };
  child.on("error", finishError);
  child.stdout.on("data", collect(stdout, options.onStdoutChunk));
  child.stderr.on("data", collect(stderr));
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    if (pendingError !== undefined) reject(pendingError);
    else resolve({ exitCode: code ?? 1, stdout, stderr });
  });
});

export type TailscaleServeConfigMutationResult = "removed" | "absent" | "concurrent" | "conflict";

export interface TailscaleServeConfigClient {
  removeExactTlsTerminatedMapping(
    input: { dnsName: string; target: string },
    signal?: AbortSignal,
  ): Promise<TailscaleServeConfigMutationResult>;
}

export type TailscaleLocalApiErrorReason =
  | "timeout"
  | "cancelled"
  | "unavailable"
  | "invalid_response";

export class TailscaleLocalApiError extends Error {
  readonly reason: TailscaleLocalApiErrorReason;

  constructor(reason: TailscaleLocalApiErrorReason) {
    super(`Tailscale LocalAPI operation paused: ${reason}`);
    this.name = "TailscaleLocalApiError";
    this.reason = reason;
  }
}

type LocalApiResponse = { statusCode: number; etag?: string; body: Buffer };

function validateServeConfig(value: Record<string, unknown>): void {
  const allowed = new Set(["TCP", "Web", "Services", "AllowFunnel", "Foreground"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new TailscaleLocalApiError("invalid_response");
  for (const name of allowed) {
    const member = value[name];
    if (member !== undefined && !record(member)) throw new TailscaleLocalApiError("invalid_response");
  }
  let nodes = 0;
  const visit = (member: unknown, depth: number): void => {
    if (++nodes > 2_048 || depth > 8) throw new TailscaleLocalApiError("invalid_response");
    if (Array.isArray(member)) {
      for (const item of member) visit(item, depth + 1);
      return;
    }
    if (!record(member)) return;
    for (const [key, item] of Object.entries(member)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor")
        throw new TailscaleLocalApiError("invalid_response");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

export class WindowsTailscaleLocalApi implements TailscaleServeConfigClient {
  readonly #socketPath: string;
  readonly #timeoutMs: number;

  constructor(options: { socketPath?: string; timeoutMs?: number } = {}) {
    this.#socketPath = options.socketPath ?? TAILSCALE_LOCALAPI_PIPE;
    this.#timeoutMs = Math.min(30_000, Math.max(1, options.timeoutMs ?? 15_000));
  }

  async #request(
    method: "GET" | "POST",
    body: Buffer | undefined,
    etag: string | undefined,
    signal?: AbortSignal,
  ): Promise<LocalApiResponse> {
    if (signal?.aborted) throw new TailscaleLocalApiError("cancelled");
    return await new Promise<LocalApiResponse>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const finish = (error?: Error, response?: LocalApiResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve(response!);
      };
      const request = httpRequest({
        method,
        path: "/localapi/v0/serve-config",
        socketPath: this.#socketPath,
        headers: {
          Host: "local-tailscaled.sock",
          Accept: "application/json",
          Connection: "close",
          ...(body === undefined ? {} : {
            "Content-Type": "application/json",
            "Content-Length": String(body.byteLength),
          }),
          ...(etag === undefined ? {} : { "If-Match": etag }),
        },
      }, (incoming) => {
        const chunks: Buffer[] = [];
        let total = 0;
        incoming.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > TAILSCALE_CLI_MAX_TOTAL_BYTES) {
            request.destroy(new TailscaleLocalApiError("invalid_response"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => finish(undefined, {
          statusCode: incoming.statusCode ?? 0,
          ...(incoming.headers.etag === undefined ? {} : { etag: incoming.headers.etag }),
          body: Buffer.concat(chunks),
        }));
      });
      const abort = () => request.destroy(new TailscaleLocalApiError("cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        request.destroy(new TailscaleLocalApiError("timeout"));
      }, this.#timeoutMs);
      request.on("error", (error) => finish(
        error instanceof TailscaleLocalApiError
          ? error
          : new TailscaleLocalApiError(timedOut ? "timeout" : "unavailable"),
      ));
      if (signal?.aborted) abort();
      if (body !== undefined) request.end(body);
      else request.end();
    });
  }

  async removeExactTlsTerminatedMapping(
    input: { dnsName: string; target: string },
    signal?: AbortSignal,
  ): Promise<TailscaleServeConfigMutationResult> {
    const snapshot = await this.#request("GET", undefined, undefined, signal);
    if (snapshot.statusCode !== 200 || snapshot.etag === undefined
      || !/^[a-f0-9]{64}$/i.test(snapshot.etag)) throw new TailscaleLocalApiError("invalid_response");
    let config: Record<string, unknown>;
    try { config = parseSingleObject(snapshot.body); }
    catch { throw new TailscaleLocalApiError("invalid_response"); }
    validateServeConfig(config);
    const tcp = config.TCP as Record<string, unknown> | undefined;
    const handler = tcp?.["443"];
    if (handler === undefined) return "absent";
    if (!record(handler) || Object.keys(handler).length !== 2
      || !Object.hasOwn(handler, "TCPForward") || !Object.hasOwn(handler, "TerminateTLS")
      || handler.TCPForward !== input.target || handler.TerminateTLS !== input.dnsName)
      return "conflict";
    const allowFunnel = config.AllowFunnel as Record<string, unknown> | undefined;
    if (allowFunnel?.[`${input.dnsName}:443`] === true) return "conflict";
    const web = config.Web as Record<string, unknown> | undefined;
    if (web?.[`${input.dnsName}:443`] !== undefined) return "conflict";
    const replacement = structuredClone(config);
    delete (replacement.TCP as Record<string, unknown>)["443"];
    const encoded = Buffer.from(JSON.stringify(replacement), "utf8");
    if (encoded.byteLength > TAILSCALE_CLI_MAX_TOTAL_BYTES)
      throw new TailscaleLocalApiError("invalid_response");
    const result = await this.#request("POST", encoded, snapshot.etag, signal);
    if (result.statusCode === 412) return "concurrent";
    if (result.statusCode !== 200) throw new TailscaleLocalApiError("unavailable");
    return "removed";
  }
}

export class TailscaleCli {
  readonly #executable: string;
  readonly #runner: TailscaleCliRunner;
  readonly #timeoutMs: number;

  constructor(options: TailscaleCliOptions) {
    if (!isFullyQualifiedWindowsPath(options.executable))
      throw new Error("a fully qualified trusted Tailscale executable path is required");
    this.#executable = options.executable;
    this.#runner = options.runner ?? runTailscaleCliProcess;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async #run(
    argv: readonly string[],
    signal?: AbortSignal,
    onStdoutChunk?: (chunk: Uint8Array) => void,
    stopAfterStdout?: () => boolean,
  ): Promise<TailscaleCliRunResult> {
    if (signal?.aborted) throw new TailscaleCliError("cancelled");
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    let stopRequested = false;
    let rejectCancelled!: (error: TailscaleCliError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const onAbort = () => {
      cancelled = true;
      controller.abort(signal?.reason);
      rejectCancelled(new TailscaleCliError("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let rejectDeadline!: (error: TailscaleCliError) => void;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectDeadline(new TailscaleCliError("timeout"));
    }, this.#timeoutMs);
    const run = Promise.resolve().then(() => this.#runner(this.#executable, [...argv], {
      shell: false,
      windowsHide: true,
      timeoutMs: this.#timeoutMs,
      maxObjectBytes: TAILSCALE_CLI_MAX_OBJECT_BYTES,
      maxTotalBytes: TAILSCALE_CLI_MAX_TOTAL_BYTES,
      signal: controller.signal,
      onStdoutChunk: onStdoutChunk === undefined ? undefined : (chunk) => {
        onStdoutChunk(chunk);
        if (stopAfterStdout?.() === true && !stopRequested) {
          stopRequested = true;
          controller.abort();
        }
      },
    }));
    try {
      const result = await Promise.race([run, deadline, cancellation]);
      const total = chunks(result.stdout).reduce((sum, part) => sum + bytes(part).byteLength, 0)
        + chunks(result.stderr).reduce((sum, part) => sum + bytes(part).byteLength, 0);
      if (total > TAILSCALE_CLI_MAX_TOTAL_BYTES) throw new TailscaleCliError("output_too_large");
      return result;
    } catch (error) {
      // The production runner rejects only from ChildProcess `close`, so awaiting it here
      // prevents cleanup from closing SQLite while tailscale.exe is still terminating.
      if ((timedOut || cancelled) && this.#runner === runTailscaleCliProcess) {
        try { await run; } catch { /* Preserve the stable timeout/cancellation reason below. */ }
      }
      if (stopRequested && !timedOut && !cancelled && !(error instanceof TailscaleCliError))
        return { exitCode: 0, stdout: "", stderr: "" };
      if (error instanceof TailscaleCliError) throw error;
      if (timedOut) throw new TailscaleCliError("timeout");
      if (cancelled) throw new TailscaleCliError("cancelled");
      throw new TailscaleCliError("command_failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #json(argv: readonly string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.#run(argv, signal);
    if (result.exitCode !== 0) throw new TailscaleCliError("command_failed");
    return parseSingleObject(result.stdout);
  }

  async #jsonValue(argv: readonly string[], signal?: AbortSignal): Promise<unknown> {
    const result = await this.#run(argv, signal);
    if (result.exitCode !== 0) throw new TailscaleCliError("command_failed");
    return parseSingleValue(result.stdout);
  }

  async #command(argv: readonly string[], signal?: AbortSignal): Promise<void> {
    const result = await this.#run(argv, signal);
    if (result.exitCode !== 0) throw new TailscaleCliError("command_failed");
  }

  async version(signal?: AbortSignal): Promise<TailscaleVersion> {
    const value = await this.#json(["version", "--json"], signal);
    if (typeof value.majorMinorPatch !== "string") throw new TailscaleCliError("unexpected_output");
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.majorMinorPatch);
    if (match === null) throw new TailscaleCliError("unexpected_output");
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      display: value.majorMinorPatch,
    };
  }

  async requireSupportedVersion(signal?: AbortSignal): Promise<TailscaleVersion> {
    const version = await this.version(signal);
    const supported = version.major > 1
      || (version.major === 1 && (version.minor > 102 || (version.minor === 102 && version.patch >= 1)));
    if (!supported) throw new TailscaleCliError("unsupported_version");
    return version;
  }

  async status(signal?: AbortSignal): Promise<TailscaleStatus> {
    const value = await this.#json(["status", "--json"], signal);
    if (!supportedVersionText(value.Version) || !Array.isArray(value.Health)
      || !value.Health.every((entry) => typeof entry === "string" && entry.length <= 1_024))
      throw new TailscaleCliError("invalid_status");
    switch (value.BackendState) {
      case "NeedsLogin": {
        if (value.AuthURL === undefined || value.AuthURL === "") return { state: "needs_login" };
        const authUrl = exactHttpsUrl(value.AuthURL, ["login.tailscale.com"]);
        if (authUrl === undefined) throw new TailscaleCliError("invalid_auth_url");
        return { state: "needs_login", authUrl };
      }
      case "NeedsMachineAuth":
        return { state: "needs_machine_auth" };
      case "Stopped":
      case "NoState":
        return { state: "stopped" };
      case "Starting":
        return { state: "starting" };
      case "Running":
        break;
      default:
        throw new TailscaleCliError("invalid_status");
    }
    if (value.Health.length !== 0) throw new TailscaleCliError("invalid_status");
    if (!record(value.Self) || value.Self.Online !== true) throw new TailscaleCliError("invalid_status");
    if (Array.isArray(value.Self.Tags) && value.Self.Tags.length > 0) throw new TailscaleCliError("invalid_status");
    if (value.Self.Tags !== undefined && value.Self.Tags !== null && !Array.isArray(value.Self.Tags))
      throw new TailscaleCliError("invalid_status");
    if (typeof value.Self.DNSName !== "string" || value.Self.DNSName.trim() !== value.Self.DNSName)
      throw new TailscaleCliError("invalid_status");
    const canonicalDns = value.Self.DNSName.endsWith(".")
      ? value.Self.DNSName.slice(0, -1)
      : value.Self.DNSName;
    if (!dnsName(canonicalDns)) throw new TailscaleCliError("invalid_status");
    if (!record(value.CurrentTailnet) || typeof value.CurrentTailnet.Name !== "string"
      || value.CurrentTailnet.Name.trim().length === 0 || value.CurrentTailnet.Name.length > 255
      || typeof value.CurrentTailnet.MagicDNSSuffix !== "string"
      || !dnsName(`host.${value.CurrentTailnet.MagicDNSSuffix}`)
      || !canonicalDns.endsWith(`.${value.CurrentTailnet.MagicDNSSuffix}`))
      throw new TailscaleCliError("invalid_status");
    if (!Array.isArray(value.CertDomains)
      || !value.CertDomains.every((domain) => typeof domain === "string" && dnsName(domain))
      || (value.CertDomains.length > 0 && !value.CertDomains.includes(canonicalDns)))
      throw new TailscaleCliError("invalid_status");
    const userId = typeof value.Self.UserID === "string" || typeof value.Self.UserID === "number"
      ? String(value.Self.UserID)
      : undefined;
    if (userId === undefined || !record(value.User) || !record(value.User[userId]))
      throw new TailscaleCliError("invalid_status");
    const profile = value.User[userId];
    if (typeof profile.LoginName !== "string" || profile.LoginName.trim().length === 0 || profile.LoginName.length > 320)
      throw new TailscaleCliError("invalid_status");
    return {
      state: "running",
      dnsName: canonicalDns,
      magicDnsSuffix: value.CurrentTailnet.MagicDNSSuffix,
      accountLabel: profile.LoginName,
      accountId: userId,
      tailnetName: value.CurrentTailnet.Name,
      certificateReady: value.CertDomains.includes(canonicalDns),
    };
  }

  async preference(name: "unattended" | "shields-up", signal?: AbortSignal): Promise<boolean> {
    const value = await this.#jsonValue(["get", "--json", name], signal);
    if (typeof value === "boolean") return value;
    if (!record(value) || Object.keys(value).length !== 1 || typeof value[name] !== "boolean")
      throw new TailscaleCliError("unexpected_output");
    return value[name];
  }

  /** `debug prefs` is an official machine-readable, but explicitly unstable, boundary that
   * exposes the effective login server even when it was configured outside this process.
   * Missing or non-official values fail closed before CozyGateway mutates preferences or Serve. */
  async requireOfficialControlServer(signal?: AbortSignal): Promise<void> {
    const value = await this.#json(["debug", "prefs"], signal);
    if (typeof value.ControlURL !== "string") throw new TailscaleCliError("invalid_preferences");
    if (value.ControlURL !== "https://controlplane.tailscale.com"
      && value.ControlURL !== "https://login.tailscale.com")
      throw new TailscaleCliError("custom_control_server");
  }

  async beginLogin(signal?: AbortSignal): Promise<TailscaleLoginResult> {
    const objectBound = new IncrementalJsonObjectBound();
    const result = await this.#run(
      ["up", "--json", "--timeout=5s"],
      signal,
      (chunk) => objectBound.push(chunk),
    );
    const values = parseObjectSequence(result.stdout);
    let authUrl: string | undefined;
    let state: string | undefined;
    for (const value of values) {
      if (value.Error !== undefined && (typeof value.Error !== "string" || value.Error.length > 0))
        throw new TailscaleCliError("command_failed");
      if (value.BackendState !== undefined && typeof value.BackendState !== "string")
        throw new TailscaleCliError("unexpected_output");
      if (typeof value.BackendState === "string") state = value.BackendState;
      if (value.AuthURL !== undefined) {
        const parsed = exactHttpsUrl(value.AuthURL, ["login.tailscale.com"]);
        if (parsed === undefined || !/^\/a\/[A-Za-z0-9_-]+$/.test(new URL(parsed).pathname))
          throw new TailscaleCliError("invalid_auth_url");
        authUrl = parsed;
      }
    }
    if (state === "Running") return { outcome: "running" };
    if (state === "NeedsMachineAuth") return { outcome: "machine_auth_required" };
    if (authUrl !== undefined) return { outcome: "auth_required", authUrl };
    if (result.exitCode !== 0) throw new TailscaleCliError("command_failed");
    throw new TailscaleCliError("unexpected_output");
  }

  serveState(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.#json(["serve", "status", "--json"], signal);
  }

  funnelState(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.#json(["funnel", "status", "--json"], signal);
  }

  async createTlsTerminatedMapping(gatewayPort: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535)
      throw new Error("invalid loopback Gateway port");
    await this.#command([
      "serve",
      "--bg",
      "--tls-terminated-tcp=443",
      `tcp://127.0.0.1:${gatewayPort}`,
    ], signal);
  }

  async beginHttpsConsent(port: number, signal?: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535 || port === 443)
      throw new Error("invalid HTTPS consent port");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let observedBytes = 0;
    let observedText = "";
    let observedUrl: string | undefined;
    const argv = ["serve", `--https=${port}`, "text:CozyGateway HTTPS consent"] as const;
    try {
      const result = await this.#run(argv, signal, (chunk) => {
        observedBytes += chunk.byteLength;
        if (observedBytes > TAILSCALE_CLI_MAX_TOTAL_BYTES)
          throw new TailscaleCliError("output_too_large");
        try {
          observedText += decoder.decode(chunk, { stream: true });
        } catch {
          throw new TailscaleCliError("invalid_utf8");
        }
        observedUrl = consentUrl(observedText, false);
      }, () => observedUrl !== undefined);
      try {
        observedText += decoder.decode();
      } catch {
        throw new TailscaleCliError("invalid_utf8");
      }
      if (observedUrl !== undefined) return observedUrl;
      if (result.exitCode !== 0) throw new TailscaleCliError("command_failed");
      const url = consentUrl(decodeBounded(result.stdout, TAILSCALE_CLI_MAX_TOTAL_BYTES), true);
      if (url === undefined) throw new TailscaleCliError("unexpected_output");
      return url;
    } catch (error) {
      if (error instanceof TailscaleCliError) throw error;
      throw new TailscaleCliError("command_failed");
    }
  }
}

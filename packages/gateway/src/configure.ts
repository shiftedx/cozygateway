import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

import { loadConfig } from "./config.ts";

const LISTENER_PORT_ERROR = "listener port must be a whole number from 1 through 65535";
const LISTENER_HOST_ERROR = "bind address must be a hostname or IP address, not a URL or whitespace";

export function validateListenerHost(raw: string): string {
  const host = raw.trim();
  if (host.length === 0 || /\s/.test(host) || /[:\[\]/?#]/.test(host) && isIP(host) === 0) {
    throw new Error(LISTENER_HOST_ERROR);
  }
  if (isIP(host) !== 0) return host;
  if (host.length > 253) throw new Error(LISTENER_HOST_ERROR);
  const labels = host.split(".");
  if (labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
    throw new Error(LISTENER_HOST_ERROR);
  }
  return host;
}

export function parseListenerPort(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) throw new Error(LISTENER_PORT_ERROR);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(LISTENER_PORT_ERROR);
  return port;
}

function writeAtomic(path: string, content: string, validate?: (temporary: string) => void): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const mode = statSync(path).mode;
    writeFileSync(temporary, content, { encoding: "utf8", mode });
    chmodSync(temporary, mode);
    validate?.(temporary);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error;
  }
}

export function updateListenerConfig(path: string, requestedHost: string, requestedPort: number): void {
  const host = validateListenerHost(requestedHost);
  const port = parseListenerPort(String(requestedPort));
  const existing: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new Error("gateway configuration must be a JSON object");
  }

  writeAtomic(path, `${JSON.stringify({ ...existing, host, port }, null, 2)}\n`, loadConfig);
}

export interface ManagedHermesProfile {
  profile: string;
  executable: string;
}

function nativeManagedPath(path: string): string {
  if (process.platform !== "win32") return path;
  const match = /^\/([A-Za-z])\/(.*)$/.exec(path);
  return match === null ? path : `${match[1]!.toUpperCase()}:\\${match[2]!.replaceAll("/", "\\")}`;
}

export function listenerOrigin(host: string, port: number, scheme: "http" | "https"): string {
  const localHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const urlHost = localHost.includes(":") && !localHost.startsWith("[") ? `[${localHost}]` : localHost;
  return `${scheme}://${urlHost}:${port}`;
}

export function syncManagedListenerTargets(configPath: string): ManagedHermesProfile[] {
  const config = loadConfig(configPath);
  const host = validateListenerHost(config.host ?? "0.0.0.0");
  const port = parseListenerPort(String(config.port));
  const statePath = join(dirname(configPath), "install-state");
  if (!existsSync(statePath)) return [];

  const state = new Map<string, string>();
  for (const line of readFileSync(statePath, "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) state.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const profiles = (state.get("profiles") ?? "").split(",").filter(Boolean);
  const rawRoot = state.get("hermes_root") ?? "";
  const rawExecutable = state.get("hermes_bin") ?? "";
  if (profiles.length === 0 || rawRoot.length === 0 || rawExecutable.length === 0) {
    throw new Error("managed install state is incomplete; rerun the CozyGateway installer");
  }
  if (profiles.some((profile) => !/^[A-Za-z0-9._-]+$/.test(profile))) {
    throw new Error("managed install state contains an invalid Hermes profile name");
  }

  const hermesRoot = nativeManagedPath(rawRoot);
  const executable = nativeManagedPath(rawExecutable);
  const updates = profiles.map((profile) => {
    const envPath = profile === "default" ? join(hermesRoot, ".env") : join(hermesRoot, "profiles", profile, ".env");
    const before = readFileSync(envPath, "utf8");
    const current = /^COZYGATEWAY_URL=(.*)$/m.exec(before)?.[1];
    if (current === undefined) {
      throw new Error(`Hermes profile ${profile} is missing its installer-managed CozyGateway URL`);
    }
    let target = listenerOrigin(host, port, "http");
    if (config.tls !== undefined) {
      const url = new URL(current);
      if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
        throw new Error(`Hermes profile ${profile} needs an existing https CozyGateway origin with its certificate hostname before TLS listener changes`);
      }
      url.port = String(port);
      target = url.origin;
    }
    return { profile, envPath, content: before.replace(/^COZYGATEWAY_URL=.*$/m, `COZYGATEWAY_URL=${target}`) };
  });
  for (const update of updates) writeAtomic(update.envPath, update.content);
  return updates.map(({ profile }) => ({ profile, executable }));
}

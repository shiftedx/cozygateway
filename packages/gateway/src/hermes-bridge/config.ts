import type { HermesBridgeConfig } from "../config.ts";
import type { HermesAuth } from "./client.ts";

export interface ParsedHermesOptions {
  url: string;
  auth: HermesAuth;
  hideBotChats: boolean;
}

/** The gated dashboard mounts the JSON-RPC gateway here. Used when the configured URL names only
 *  an origin, so `url: "ws://homelab:9119"` and `url: "ws://homelab:9119/api/ws"` behave alike. */
const GATEWAY_WS_PATH = "/api/ws";

/** Derives the dashboard's HTTP origin from the gateway WebSocket URL: ws -> http, wss -> https,
 *  path dropped. The login and ws-ticket endpoints are absolute paths off that origin. */
function httpOriginOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`hermes bridge: "${url}" is not a valid URL`);
  }
  const protocol = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
  return `${protocol}//${parsed.host}`;
}

/** Normalizes the WS URL so gated mode always lands on the JSON-RPC gateway path. A URL that
 *  already carries a path is left exactly as configured. */
function gatewayWsUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`hermes bridge: "${url}" is not a valid URL`);
  }
  if (parsed.pathname === "" || parsed.pathname === "/") {
    parsed.pathname = GATEWAY_WS_PATH;
    return parsed.toString().replace(/\/$/, "");
  }
  return url;
}

/** Resolves the bridge's credential from the environment, failing closed BEFORE any socket is
 *  dialed or the port is bound, mirroring `parseOpenClawOptions`.
 *
 *  Two auth modes, matching the two shapes Hermes actually serves:
 *  - "token" (default): the loopback bind, where the credential rides `?token=` (or `?ticket=`
 *    for a pre-minted one) straight on the upgrade URL.
 *  - "password": a gated bind behind dashboard auth, where the client logs in over HTTP and mints
 *    a fresh single-use ws ticket per connect.
 *
 *  No secret value ever appears in a thrown message here; only the env var NAME may. */
export function parseHermesOptions(
  config: HermesBridgeConfig,
  env: Record<string, string | undefined>,
): ParsedHermesOptions {
  const hideBotChats = config.hideBotChats ?? true;
  const mode = config.authMode ?? "token";

  if (mode === "password") {
    const username = config.username;
    if (username === undefined || username.length === 0) {
      throw new Error('hermes bridge: authMode "password" requires "username" in the config file');
    }
    const passwordEnv = config.passwordEnv;
    if (passwordEnv === undefined || passwordEnv.length === 0) {
      throw new Error(
        'hermes bridge: authMode "password" requires "passwordEnv", the NAME of the env var holding the dashboard password',
      );
    }
    const password = env[passwordEnv];
    if (password === undefined || password.length === 0) {
      throw new Error(
        `hermes bridge: environment variable "${passwordEnv}" is not set; the dashboard password rides the environment, never the config file`,
      );
    }
    return {
      url: gatewayWsUrl(config.url),
      auth: {
        mode: "password",
        baseUrl: config.baseUrl ?? httpOriginOf(config.url),
        username,
        password,
      },
      hideBotChats,
    };
  }

  const tokenEnv = config.tokenEnv;
  if (tokenEnv === undefined || tokenEnv.length === 0) {
    throw new Error('hermes bridge: authMode "token" requires "tokenEnv", the NAME of the env var holding it');
  }
  const token = env[tokenEnv];
  if (token === undefined || token.length === 0) {
    throw new Error(
      `hermes bridge: environment variable "${tokenEnv}" is not set; the gateway credential rides the environment, never the config file`,
    );
  }
  return {
    url: config.url,
    auth: { mode: "token", token, param: config.authParam ?? "token" },
    hideBotChats,
  };
}

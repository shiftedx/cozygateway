import type { HermesBridgeConfig } from "../config.ts";
import { DEFAULT_AUTH_PROVIDER, type HermesAuth } from "./client.ts";
import { normalizeNames } from "./profile.ts";

const DEFAULT_CHAT_SUGGESTION = "Hey, tell me about yourself!";

export interface ParsedHermesOptions {
  url: string;
  auth: HermesAuth;
  /** Profile names kept off this gateway's roster, already normalized to the lowercase form
   *  Hermes stores them in. Empty when the operator hid nothing. */
  hiddenProfiles: string[];
  /** The profile the bridge's own Hermes link runs on, normalized, or undefined when unset. */
  bridgeProfile: string | undefined;
  /** Whether `POST /bots` seeds a newly created profile as a blank slate. Always a boolean, already
   *  defaulted to true: an operator has to say `false` in the config file to get the old broad
   *  Hermes defaults back. */
  seedBlankSlateBots: boolean;
  /** Skill names a blank-slate bot keeps ON. Always an array, already trimmed and deduped; empty
   *  when the operator named none, which is the default and means a bot starts with no playbooks
   *  at all. */
  blankSlateSkillsOn: string[];
  /** The opener an empty bot chat offers (capability 11). Always a string, already defaulted: the
   *  empty string is the operator's "offer nothing", and the bridge reads it as such. */
  chatSuggestion: string;
}

/** Normalizes the operator's hide list: trimmed, lowercased (Hermes stores profile ids lowercase,
 *  so a `Scout` written in the config file must still hide `scout`), blanks dropped, duplicates
 *  collapsed. Order carries no meaning. */
function parseHiddenProfiles(names: string[] | undefined): string[] {
  if (names === undefined) return [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (name.length > 0) seen.add(name);
  }
  return [...seen];
}

/** The gated dashboard mounts the JSON-RPC gateway here. Used when the configured URL names only
 *  an origin, so `url: "ws://homelab:9119"` and `url: "ws://homelab:9119/api/ws"` behave alike. */
const GATEWAY_WS_PATH = "/api/ws";

/** Parses the configured URL, or throws a message an operator can act on. Both auth modes go
 *  through this: an unparseable or non-WebSocket URL must fail HERE, at startup, rather than
 *  inside the client's connect path, where `new WebSocket()` throws synchronously with no
 *  reconnect behind it and leaves the bots capability advertised over a dead bridge.
 *
 *  The scheme check is the load-bearing half: `new URL("homelab:8790/api/ws")` parses happily
 *  (protocol "homelab:"), so a dropped `ws://` is caught only by demanding ws or wss. */
function parseWsUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`hermes bridge: "${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(
      `hermes bridge: "${url}" must be a ws:// or wss:// URL, not "${parsed.protocol}" (the gateway is a WebSocket)`,
    );
  }
  return parsed;
}

/** Derives the dashboard's HTTP origin from the gateway WebSocket URL: ws -> http, wss -> https,
 *  path dropped. The login and ws-ticket endpoints are absolute paths off that origin. */
function httpOriginOf(url: string): string {
  const parsed = parseWsUrl(url);
  const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${parsed.host}`;
}

/** Normalizes the WS URL so gated mode always lands on the JSON-RPC gateway path. A URL that
 *  already carries a path is left exactly as configured. */
function gatewayWsUrl(url: string): string {
  const parsed = parseWsUrl(url);
  if (parsed.pathname === "" || parsed.pathname === "/") {
    parsed.pathname = GATEWAY_WS_PATH;
    return parsed.toString().replace(/\/$/, "");
  }
  return url;
}

/** Resolves the bridge's credential from the environment, failing closed BEFORE any socket is
 *  dialed or the port is bound.
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
  const hiddenProfiles = parseHiddenProfiles(config.hiddenProfiles);
  const trimmedProfile = config.profile?.trim().toLowerCase();
  const bridgeProfile = trimmedProfile === undefined || trimmedProfile.length === 0 ? undefined : trimmedProfile;
  const mode = config.authMode ?? "token";
  // `??`, not `||`: an operator who wrote "" meant it, and collapsing that onto the default would
  // make the one setting that turns the suggestion off silently do nothing.
  const chatSuggestion = config.chatSuggestion ?? DEFAULT_CHAT_SUGGESTION;
  const seedBlankSlateBots = config.seedBlankSlateBots ?? true;
  // `normalizeNames`, not `parseHiddenProfiles`: skill names are matched against the skills
  // directory VERBATIM and case-sensitively (`agent.skill_utils._normalize_string_set` only
  // strips), so folding case the way the hide list does would turn a real name into one that keeps
  // its skill switched off. Trimming still matters: a stray space must not become a name that
  // matches nothing and silently leaves that skill in the OFF-list.
  const blankSlateSkillsOn = normalizeNames(config.blankSlateSkillsOn ?? []);

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
        provider: config.provider ?? DEFAULT_AUTH_PROVIDER,
      },
      hiddenProfiles,
      bridgeProfile,
      seedBlankSlateBots,
      blankSlateSkillsOn,
      chatSuggestion,
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
  // Validated even though the value is used verbatim: token mode is the one path that never
  // reparses the URL later, so this is the only place a typo can be caught before the dial.
  parseWsUrl(config.url);
  return {
    url: config.url,
    auth: { mode: "token", token, param: config.authParam ?? "token" },
    hiddenProfiles,
    bridgeProfile,
    seedBlankSlateBots,
    blankSlateSkillsOn,
    chatSuggestion,
  };
}

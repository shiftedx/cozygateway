import type { HermesBridgeConfig } from "../config.ts";

export interface ParsedHermesOptions {
  url: string;
  token: string;
  authParam: "token" | "ticket";
  hideBotChats: boolean;
}

/** Resolves the bridge's credential from the environment, failing closed BEFORE any socket is
 *  dialed or the port is bound, mirroring `parseOpenClawOptions`. The token value never appears
 *  in a thrown message here; only the env var NAME may. */
export function parseHermesOptions(
  config: HermesBridgeConfig,
  env: Record<string, string | undefined>,
): ParsedHermesOptions {
  const token = env[config.tokenEnv];
  if (token === undefined || token.length === 0) {
    throw new Error(
      `hermes bridge: environment variable "${config.tokenEnv}" is not set; the gateway credential rides the environment, never the config file`,
    );
  }
  return {
    url: config.url,
    token,
    authParam: config.authParam ?? "token",
    hideBotChats: config.hideBotChats ?? true,
  };
}

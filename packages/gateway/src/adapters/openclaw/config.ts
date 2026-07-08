import type { AgentConfig } from "../../config.ts";
import { DEFAULT_TURN_TIMEOUT_SECONDS } from "./adapter.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

export interface ParsedOpenClawOptions {
  url: string;
  token: string;
  turnTimeoutMs: number;
  protocolVersion: number;
}

/** Parse and validate an openclaw agent's options. The config file carries the NAME of the
 *  environment variable holding the operator token, never the token itself; startup fails
 *  closed when the variable is missing or empty, mirroring the attach backend's own stance (see
 *  `parseAttachOptions`). The token value never appears in any thrown message here; only the
 *  env var NAME (`tokenEnv`) may. */
export function parseOpenClawOptions(
  agent: AgentConfig,
  env: Record<string, string | undefined>,
): ParsedOpenClawOptions {
  const options = agent.options ?? {};

  const url = options["url"];
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      `agent "${agent.id}": the openclaw backend requires options.url, the OpenClaw Gateway's WebSocket URL`,
    );
  }

  const tokenEnv = options["tokenEnv"];
  if (typeof tokenEnv !== "string" || tokenEnv.length === 0) {
    throw new Error(
      `agent "${agent.id}": the openclaw backend requires options.tokenEnv, the NAME of an environment variable holding the operator token`,
    );
  }
  const token = env[tokenEnv];
  if (token === undefined || token.length === 0) {
    throw new Error(
      `agent "${agent.id}": environment variable "${tokenEnv}" is not set; the operator token rides the environment, never the config file`,
    );
  }

  const rawTimeout = options["turnTimeoutSeconds"];
  let turnTimeoutMs = DEFAULT_TURN_TIMEOUT_SECONDS * 1000;
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      throw new Error(`agent "${agent.id}": options.turnTimeoutSeconds must be a positive number`);
    }
    turnTimeoutMs = rawTimeout * 1000;
  }

  const rawProtocolVersion = options["protocolVersion"];
  const protocolVersion = typeof rawProtocolVersion === "number" ? rawProtocolVersion : PROTOCOL_VERSION;

  return { url, token, turnTimeoutMs, protocolVersion };
}

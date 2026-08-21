#!/usr/bin/env node

import { startAgent, type AgentConfig } from "./agent.ts";

export function parseAgentConfig(env: Record<string, string | undefined>): AgentConfig {
  const frontdoorUrl = env.FRONTDOOR_URL;
  if (!frontdoorUrl) throw new Error("FRONTDOOR_URL is required");
  const credential = env.FRONTDOOR_CREDENTIAL;
  if (!credential) throw new Error("FRONTDOOR_CREDENTIAL is required");
  return {
    frontdoorUrl,
    credential,
    targetHost: env.TARGET_HOST ?? "127.0.0.1",
    targetPort: Number(env.TARGET_PORT ?? 8099),
  };
}

const invokedDirectly = process.argv[1]?.endsWith("cli.js") ?? false;
if (invokedDirectly) {
  const agent = startAgent(parseAgentConfig(process.env));
  agent.connectedOnce.then(() => console.log("agent connected"));
  const close = () => {
    agent.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

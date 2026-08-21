#!/usr/bin/env node

import { startAgent, type AgentConfig } from "./agent.ts";

function usage(): string {
  return "Usage: cozy-frontdoor-agent --frontdoor-url URL --credential TOKEN --target-host HOST --target-port PORT";
}

function parseArgs(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const value = args[i + 1];
    if (value !== undefined && !value.startsWith("--")) {
      values.set(arg.slice(2), value);
      i += 1;
    }
  }
  return values;
}

function required(values: Map<string, string>, name: string, envName: string): string | undefined {
  return values.get(name) ?? process.env[envName];
}

export function parseCliConfig(args: string[] = process.argv.slice(2)): AgentConfig {
  const values = parseArgs(args);
  const frontdoorUrl = required(values, "frontdoor-url", "COZY_FRONTDOOR_URL");
  const credential = required(values, "credential", "COZY_FRONTDOOR_CREDENTIAL");
  const targetHost = required(values, "target-host", "COZY_TARGET_HOST");
  const targetPortText = required(values, "target-port", "COZY_TARGET_PORT");
  const targetPort = targetPortText === undefined ? NaN : Number(targetPortText);
  if (frontdoorUrl === undefined || credential === undefined || targetHost === undefined || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error(usage());
  }
  return { frontdoorUrl, credential, targetHost, targetPort };
}

if (process.argv[1]?.endsWith("cli.js") === true || process.argv[1]?.endsWith("cli.ts") === true) {
  try {
    const agent = startAgent(parseCliConfig());
    const close = () => {
      agent.close();
      process.exit(0);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

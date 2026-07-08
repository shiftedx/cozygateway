#!/usr/bin/env node
import { parseArgs } from "node:util";

import { isLoopbackBindHost } from "./egress.ts";
import { DEFAULT_DAILY_CAP, DEFAULT_MAX_REGISTRATIONS, RELAY_VERSION, startRelay, type RelayConfig } from "./server.ts";

const USAGE =
  "usage: cozy-push-relay [--port 8788] [--host 127.0.0.1] [--db relay.db] [--daily-cap 500] " +
  `[--max-registrations ${DEFAULT_MAX_REGISTRATIONS}] [--restrict-egress | --no-restrict-egress]`;

export function parseCliConfig(argv: string[]): RelayConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", default: "8788" },
      host: { type: "string", default: "127.0.0.1" },
      db: { type: "string", default: "relay.db" },
      "daily-cap": { type: "string", default: String(DEFAULT_DAILY_CAP) },
      "max-registrations": { type: "string", default: String(DEFAULT_MAX_REGISTRATIONS) },
      "restrict-egress": { type: "boolean", default: false },
      "no-restrict-egress": { type: "boolean", default: false },
    },
  });
  const port = Number(values.port);
  const dailyCap = Number(values["daily-cap"]);
  const maxRegistrations = Number(values["max-registrations"]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port "${values.port}"`);
  if (!Number.isInteger(dailyCap) || dailyCap < 1) throw new Error(`invalid --daily-cap "${values["daily-cap"]}"`);
  if (!Number.isInteger(maxRegistrations) || maxRegistrations < 1) {
    throw new Error(`invalid --max-registrations "${values["max-registrations"]}"`);
  }
  if (values["restrict-egress"] === true && values["no-restrict-egress"] === true) {
    throw new Error("--restrict-egress and --no-restrict-egress are mutually exclusive");
  }
  // Default: restriction on for a non-loopback bind (a hosted relay), off for loopback
  // (the self-host dev default), design decision, issue #8. Either flag overrides it.
  const restrictEgress =
    values["restrict-egress"] === true
      ? true
      : values["no-restrict-egress"] === true
        ? false
        : !isLoopbackBindHost(values.host);
  return { port, host: values.host, dbPath: values.db, dailyCap, maxRegistrations, restrictEgress };
}

export async function runCli(argv: string[]): Promise<number> {
  let config: RelayConfig;
  try {
    config = parseCliConfig(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return 1;
  }
  const relay = await startRelay(config);
  console.log(`cozygateway-relay ${RELAY_VERSION} listening on ${relay.url}`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await relay.close();
  return 0;
}

const invokedDirectly = process.argv[1]?.endsWith("cli.js") === true || process.argv[1]?.endsWith("cli.ts") === true;
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}

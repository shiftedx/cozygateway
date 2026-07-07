#!/usr/bin/env node
import { parseArgs } from "node:util";

import { loadConfig } from "./config.ts";
import { openStorage } from "./storage.ts";
import { startGateway, GATEWAY_VERSION } from "./server.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";

const USAGE = `usage: cozygateway <serve|pair> --config <path>`;

export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { config: { type: "string", default: "cozygateway.config.json" } },
  });
  const configPath = values.config;

  if (command === "serve") {
    const config = loadConfig(configPath);
    const gateway = await startGateway(config);
    console.log(`cozygateway ${GATEWAY_VERSION} listening on ${gateway.url}`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await gateway.close();
    return 0;
  }

  if (command === "pair") {
    const config = loadConfig(configPath);
    const storage = openStorage(config.dbPath);
    const code = newSetupCode();
    storage.createSetupCode(code, Date.now() + SETUP_CODE_TTL_MS);
    storage.close();
    const payload = { gatewayUrl: `http://127.0.0.1:${config.port}`, setupCode: code };
    console.log(JSON.stringify(payload));
    console.log(`Setup code ${code} is valid for 10 minutes. Scan or type it in the app.`);
    return 0;
  }

  console.error(USAGE);
  return 1;
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

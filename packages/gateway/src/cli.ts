#!/usr/bin/env node
import { parseArgs } from "node:util";

import { applyEnvOverrides, loadConfig } from "./config.ts";
import { openStorage } from "./storage.ts";
import { startGateway, GATEWAY_VERSION } from "./server.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";
import { gatewayScheme } from "./tls.ts";

const USAGE = `usage: cozygateway <serve|pair> --config <path> [--url <http(s)://host[:port]>]`;

function pairingUrl(config: ReturnType<typeof loadConfig>, advertised: string | undefined): string {
  if (advertised === undefined) return `${gatewayScheme(config)}://127.0.0.1:${config.port}`;
  const url = new URL(advertised);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new Error("--url must be an http(s) gateway origin without credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("--url must be a gateway origin without a path, query, or fragment");
  }
  return url.origin;
}

export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: "string", default: "cozygateway.config.json" },
      url: { type: "string" },
    },
  });
  const configPath = values.config;

  if (command === "serve") {
    const config = applyEnvOverrides(loadConfig(configPath), process.env);
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
    const config = applyEnvOverrides(loadConfig(configPath), process.env);
    const storage = openStorage(config.dbPath);
    const code = newSetupCode();
    storage.createSetupCode(code, Date.now() + SETUP_CODE_TTL_MS);
    storage.close();
    // The scheme comes from the config, not a literal: the payload is what the phone dials, so an
    // https gateway advertising `http://` would send every scan at a port that is not speaking
    // plaintext. Derived without opening the cert files, since `pair` binds no listener; a broken
    // pair is `serve`'s to shout about.
    const payload = { gatewayUrl: pairingUrl(config, values.url), setupCode: code };
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

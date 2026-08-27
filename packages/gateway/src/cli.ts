#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { rootCertificates } from "node:tls";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import { applyEnvOverrides, loadConfig, validatePublicDeployment } from "./config.ts";
import { openStorage } from "./storage.ts";
import { startGateway, GATEWAY_VERSION } from "./server.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";
import { primaryLanAddress } from "./lan.ts";
import { QrCapacityError, encodeQr, renderQrHalfBlocks } from "./qr.ts";
import { gatewayScheme } from "./tls.ts";
import {
  listenerOrigin,
  parseListenerPort,
  syncManagedListenerTargets,
  updateListenerConfig,
  validateListenerHost,
} from "./configure.ts";

const USAGE = `usage: cozygateway [status|configure|serve|pair] --config <path> [--url <http(s)://host[:port]>] [--ttl <minutes>]`;

export interface CliIo {
  interactive: boolean;
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface CliRuntime {
  restartHermesProfile(executable: string, profile: string): Promise<void>;
  waitForGatewayReady(configPath: string): Promise<void>;
}

function healthOrigin(config: ReturnType<typeof loadConfig>): string {
  return listenerOrigin(config.host ?? "0.0.0.0", config.port, gatewayScheme(config));
}

type GatewayHealth = { attach?: { configured?: number; online?: number; deadLetters?: number } };

export function isExpectedCertificate(configured: Buffer, peer: Buffer): boolean {
  return new X509Certificate(configured).fingerprint256 === new X509Certificate(peer).fingerprint256;
}

async function fetchHealth(configPath: string, timeoutMs: number): Promise<GatewayHealth> {
  const config = loadConfig(configPath);
  const url = `${healthOrigin(config)}/health`;
  if (config.tls === undefined) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`gateway health returned HTTP ${response.status}`);
    return response.json() as Promise<GatewayHealth>;
  }
  const configuredCertificate = readFileSync(config.tls.certFile);
  const ca = [...rootCertificates, configuredCertificate];
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        ca,
        checkServerIdentity: (_hostname, certificate) =>
          isExpectedCertificate(configuredCertificate, certificate.raw) ? undefined : new Error("gateway health certificate does not match the configured certificate"),
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(new Error(`gateway health returned HTTP ${response.statusCode ?? 0}`));
          try {
            resolve(JSON.parse(body) as GatewayHealth);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("gateway health timed out")));
    request.on("error", reject);
    request.end();
  });
}

export function isGatewayReady(health: { attach?: { configured?: number; online?: number; deadLetters?: number } }): boolean {
  const configured = health.attach?.configured ?? 0;
  return configured > 0 && health.attach?.online === configured && health.attach?.deadLetters === 0;
}

const defaultRuntime: CliRuntime = {
  restartHermesProfile: async (executable, profile) => {
    await promisify(execFileCallback)(executable, ["-p", profile, "gateway", "restart"]);
  },
  waitForGatewayReady: async (configPath) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const health = await fetchHealth(configPath, 1_000);
        if (isGatewayReady(health)) return;
      } catch {
        // The managed supervisor and Hermes profiles may still be restarting.
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("CozyGateway did not become ready within 30 seconds");
  },
};

function terminalIo(): CliIo {
  const readline = createInterface({ input: stdin, output: stdout });
  return {
    interactive: stdin.isTTY === true && stdout.isTTY === true,
    question: (prompt) => readline.question(prompt),
    close: () => readline.close(),
  };
}

/** The host a phone should dial. An explicit configured host (loopback included) is advertised
 *  verbatim: it is where the gateway actually answers. A wildcard or absent host listens on
 *  every interface, so the payload prefers the machine's LAN address; `127.0.0.1` would send
 *  every scan at the phone itself. Loopback remains the honest fallback on a machine with no
 *  external interface at all. */
function pairingHost(config: ReturnType<typeof loadConfig>): string {
  const host = config.host;
  if (host !== undefined && host !== "0.0.0.0" && host !== "::") return host;
  return primaryLanAddress() ?? "127.0.0.1";
}

function isLoopbackUrl(url: string): boolean {
  const hostname = new URL(url).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function pairingUrl(config: ReturnType<typeof loadConfig>, advertised: string | undefined): string {
  if (config.publicUrl !== undefined) {
    if (advertised === undefined) return config.publicUrl;
    let override: string;
    try {
      override = validatePublicDeployment({ ...config, publicUrl: advertised }).publicUrl!;
    } catch {
      throw new Error("--url must match the configured publicUrl HTTPS origin");
    }
    if (override !== config.publicUrl) {
      throw new Error("--url must match the configured publicUrl HTTPS origin");
    }
    return config.publicUrl;
  }
  if (advertised === undefined) return listenerOrigin(pairingHost(config), config.port, gatewayScheme(config));
  const url = new URL(advertised);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new Error("--url must be an http(s) gateway origin without credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("--url must be a gateway origin without a path, query, or fragment");
  }
  return url.origin;
}

const TTL_MAX_MINUTES = 14 * 24 * 60;

function parsedTtlMs(raw: string): number {
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > TTL_MAX_MINUTES) {
    throw new Error(`--ttl must be a whole number of minutes between 1 and ${TTL_MAX_MINUTES} (14 days)`);
  }
  return minutes * 60 * 1000;
}

function describeTtl(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % (24 * 60) === 0) { const d = minutes / (24 * 60); return d === 1 ? "1 day" : `${d} days`; }
  if (minutes % 60 === 0) { const h = minutes / 60; return h === 1 ? "1 hour" : `${h} hours`; }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

async function printStatus(configPath: string): Promise<void> {
  const config = loadConfig(configPath);
  const host = config.host ?? "0.0.0.0";
  let status = "offline";
  try {
    const attach = (await fetchHealth(configPath, 1_000)).attach;
    status = attach === undefined ? "online" : `online; Hermes attach ${attach.online ?? 0}/${attach.configured ?? 0}`;
  } catch {
    // An offline gateway is a status result, not a CLI failure.
  }
  console.log(`Listener: ${host}:${config.port}`);
  console.log(`Status:   ${status}`);
}

async function configureListener(configPath: string, io: CliIo, runtime: CliRuntime): Promise<void> {
  const current = loadConfig(configPath);
  const currentHost = current.host ?? "0.0.0.0";
  let host: string;
  for (;;) {
    const answer = await io.question(`Bind address [${currentHost}]: `);
    try {
      host = validateListenerHost(answer.trim() === "" ? currentHost : answer);
      break;
    } catch (error) {
      console.log(`Invalid address: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let port: number;
  for (;;) {
    const answer = await io.question(`Port [${current.port}]: `);
    try {
      port = parseListenerPort(answer.trim() === "" ? String(current.port) : answer);
      break;
    } catch (error) {
      console.log(`Invalid port: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (host === currentHost && port === current.port) {
    console.log("No listener changes made.");
    return;
  }
  updateListenerConfig(configPath, host, port);
  const activate = async (): Promise<number> => {
    const managed = syncManagedListenerTargets(configPath);
    const results = await Promise.allSettled(
      managed.map((profile) => runtime.restartHermesProfile(profile.executable, profile.profile)),
    );
    const failed = managed.filter((_profile, index) => results[index]?.status === "rejected");
    if (failed.length > 0) throw new Error(`failed to restart Hermes profile(s): ${failed.map(({ profile }) => profile).join(", ")}`);
    if (managed.length > 0) await runtime.waitForGatewayReady(configPath);
    return managed.length;
  };
  let managedCount: number;
  try {
    managedCount = await activate();
  } catch (error) {
    updateListenerConfig(configPath, currentHost, current.port);
    try {
      await activate();
    } catch (rollbackError) {
      throw new Error(`listener change failed (${String(error)}); restoring ${currentHost}:${current.port} also failed (${String(rollbackError)})`);
    }
    throw new Error(`listener change failed (${String(error)}); restored ${currentHost}:${current.port}`);
  }
  console.log(
    managedCount === 0
      ? `Saved listener ${host}:${port}. Restart CozyGateway to apply it.`
      : `Saved listener ${host}:${port}. CozyGateway and ${managedCount} Hermes profile(s) are ready.`,
  );
}

async function runPair(configPath: string, advertised: string | undefined, ttl: string | undefined): Promise<void> {
  const config = validatePublicDeployment(applyEnvOverrides(loadConfig(configPath), process.env));
  const gatewayUrl = pairingUrl(config, advertised);
  const ttlMs = ttl === undefined ? SETUP_CODE_TTL_MS : parsedTtlMs(ttl);
  const storage = openStorage(config.dbPath);
  const code = newSetupCode();
  storage.createSetupCode(code, Date.now() + ttlMs);
  storage.close();
  const payload = { gatewayUrl, setupCode: code };
  const payloadJson = JSON.stringify(payload);
  try {
    console.log(renderQrHalfBlocks(encodeQr(payloadJson), { color: process.stdout.isTTY === true }));
  } catch (err) {
    if (!(err instanceof QrCapacityError)) throw err;
    console.log("QR omitted: the pairing payload is too large to encode. Use the URL and code below.");
  }
  console.log(payloadJson);
  console.log(`Gateway URL: ${payload.gatewayUrl}`);
  console.log(`Setup code:  ${code}`);
  console.log("Scan the QR code with CozyChat, or type the gateway URL and setup code in the app.");
  console.log(`Setup code ${code} is valid for ${describeTtl(ttlMs)}. Mint a fresh one with: cozygateway pair`);
  if (isLoopbackUrl(payload.gatewayUrl)) {
    console.log(
      "This URL is loopback, so only this machine can reach it. Remote access (Tailscale and friends) is documented at https://cozylabs.ai/docs/access/.",
    );
  }
}

async function runMenu(configPath: string, io: CliIo, runtime: CliRuntime): Promise<number> {
  console.log("CozyGateway");
  await printStatus(configPath);
  for (;;) {
    console.log("");
    console.log("1. Pair a device");
    console.log("2. Configure listener");
    console.log("3. Refresh status");
    console.log("4. Exit");
    const choice = (await io.question("Choice [1-4]: ")).trim().toLowerCase();
    if (choice === "1") await runPair(configPath, undefined, undefined);
    else if (choice === "2") {
      await configureListener(configPath, io, runtime);
      await printStatus(configPath);
    } else if (choice === "3") await printStatus(configPath);
    else if (choice === "4" || choice === "q" || choice === "quit" || choice === "exit") return 0;
    else console.log("Choose 1, 2, 3, or 4.");
  }
}

export async function runCli(argv: string[], suppliedIo?: CliIo, runtime: CliRuntime = defaultRuntime): Promise<number> {
  const command = argv[0] !== undefined && !argv[0].startsWith("-") ? argv[0] : undefined;
  const optionArgs = command === undefined ? argv : argv.slice(1);
  const { values } = parseArgs({
    args: optionArgs,
    options: {
      config: { type: "string", default: "cozygateway.config.json" },
      url: { type: "string" },
      ttl: { type: "string" },
    },
  });
  const configPath = values.config;

  if (command === undefined || command === "configure") {
    const io = suppliedIo ?? terminalIo();
    try {
      if (!io.interactive) {
        console.error(USAGE);
        return 1;
      }
      return command === "configure"
        ? (await configureListener(configPath, io, runtime), 0)
        : await runMenu(configPath, io, runtime);
    } finally {
      io.close();
    }
  }

  if (command === "status") {
    await printStatus(configPath);
    return 0;
  }

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
    await runPair(configPath, values.url, values.ttl);
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

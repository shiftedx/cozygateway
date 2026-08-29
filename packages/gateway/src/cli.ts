#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { networkInterfaces } from "node:os";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { rootCertificates } from "node:tls";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import { applyEnvOverrides, loadConfig, validatePublicDeployment } from "./config.ts";
import {
  openStorage,
  type FinalizeInput,
  type FinalizeResult,
  type PublishedCode,
  type TransitionResult,
  type SetupCodeOutputState,
} from "./storage.ts";
import { startGateway, GATEWAY_VERSION } from "./server.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "./auth.ts";
import { encodeQr, renderQrHalfBlocks } from "./qr.ts";
import type {
  NetworkOnboardingStatus,
  OnboardingIo,
  OnboardingOutcome,
  PreparedEndpoint,
} from "./network-onboarding.ts";
import {
  preparePairingOutput,
  type PairingOutputInput,
  type PreparedPairingOutput,
} from "./pairing-output.ts";
import { gatewayScheme } from "./tls.ts";
import {
  compareAndSwapManagedListener,
  compareAndSwapManagedListenerSnapshot,
  listenerOrigin,
  parseListenerPort,
  readManagedListenerSnapshot,
  validateListenerHost,
} from "./configure.ts";
import {
  createWindowsOnboardingController,
  reconcileWindowsOwnedNetworkState,
} from "./windows-onboarding.ts";

const USAGE = `usage: cozygateway [status|setup|configure|serve|pair] --config <path> [--url <http(s)://host[:port]>] [--ttl <minutes>]`;

export interface CliIo {
  interactive: boolean;
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface CliRuntime {
  restartHermesProfile(executable: string, profile: string): Promise<void>;
  waitForGatewayReady(configPath: string): Promise<void>;
}

export interface CliInternalDependencies {
  platform?: NodeJS.Platform;
  reconcileOwnedNetworkState?: typeof reconcileWindowsOwnedNetworkState;
}

export interface CliOnboardingController {
  status(signal?: AbortSignal): Promise<NetworkOnboardingStatus & { expiresAt?: number }>;
  run(io: OnboardingIo, signal?: AbortSignal): Promise<OnboardingOutcome>;
  resume(io: OnboardingIo, signal?: AbortSignal): Promise<OnboardingOutcome>;
  close(): void;
}

export interface OnboardingPairingRequest {
  phoneConfirmed: boolean;
  desktopAnswer: string | undefined;
  gatewayUrl: string;
  color: boolean;
  finalizeContext: Omit<FinalizeInput, "setupCode" | "setupCodeExpiresAt">;
}

export interface OnboardingPairingDependencies {
  createSetupCode(): string;
  render(input: PairingOutputInput): PreparedPairingOutput;
  /** Optional live-posture gate used by network onboarding. It runs after the complete output has
   * rendered successfully and immediately before the authoritative SQLite transaction. */
  beforeFinalize?(): void | Promise<void>;
  /** Supplies authoritative wall time after `beforeFinalize` completes. Legacy callers omit it
   * and retain the request's already-captured time. */
  finalizationNow?(): number;
  finalize(input: FinalizeInput): FinalizeResult;
  write(output: string): void | Promise<void>;
  activate(input: PublishedCode): TransitionResult<SetupCodeOutputState>;
  revoke(input: PublishedCode): TransitionResult<SetupCodeOutputState>;
}

export async function publishOnboardingPairing(
  request: OnboardingPairingRequest,
  dependencies: OnboardingPairingDependencies,
): Promise<"published" | "not_published"> {
  const answer = request.desktopAnswer;
  if (answer !== "y" && answer !== "yes") return "not_published";
  if (!request.phoneConfirmed) return "not_published";
  const setupCode = dependencies.createSetupCode();
  const prepared = dependencies.render({
    gatewayUrl: request.gatewayUrl,
    setupCode,
    ttlMs: SETUP_CODE_TTL_MS,
    color: request.color,
    strictQr: true,
  });
  await dependencies.beforeFinalize?.();
  const finalizationNow = dependencies.finalizationNow?.() ?? request.finalizeContext.now;
  const finalized = dependencies.finalize({
    ...request.finalizeContext,
    now: finalizationNow,
    setupCode,
    setupCodeExpiresAt: finalizationNow + SETUP_CODE_TTL_MS,
  });
  if (finalized.outcome !== "published") return "not_published";
  const publishedCode = {
    challengeId: request.finalizeContext.challengeId,
    setupCode,
    now: finalizationNow,
  };
  try {
    await dependencies.write(prepared.terminalOutput);
  } catch (writeError) {
    let revocationFailed = false;
    let revocationError: unknown;
    try {
      const revoked = dependencies.revoke(publishedCode);
      if (
        (revoked.outcome !== "advanced" && revoked.outcome !== "already")
        || revoked.state !== "revoked"
      ) {
        revocationFailed = true;
        revocationError = new Error(`setup-code revocation failed: ${JSON.stringify(revoked)}`);
      }
    } catch (error) {
      revocationFailed = true;
      revocationError = error;
    }
    if (revocationFailed) {
      throw new AggregateError(
        [writeError, revocationError],
        "pairing output write failed and pending setup-code revocation also failed",
      );
    }
    throw writeError;
  }
  const activated = dependencies.activate(publishedCode);
  if (
    (activated.outcome === "advanced" || activated.outcome === "already")
    && activated.state === "active"
  ) return "published";
  throw new Error(`failed to activate published setup code: ${activated.outcome}`);
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
export function legacyPairingLanAddress(interfaces = networkInterfaces()): string | undefined {
  // Compatibility only: new Windows LAN onboarding uses helper-proven physical inventory. Older
  // POSIX/explicit wildcard pairing keeps its established best-effort address advertisement.
  const candidates = Object.values(interfaces).flat()
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .filter((entry) => entry.family === "IPv4"
      && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => entry.address);
  const privateAddress = candidates.find((address) => {
    if (address.startsWith("10.") || address.startsWith("192.168.")) return true;
    const parts = address.split(".");
    return parts[0] === "172" && Number(parts[1]) >= 16 && Number(parts[1]) <= 31;
  });
  return privateAddress ?? candidates[0];
}

function pairingHost(config: ReturnType<typeof loadConfig>): string {
  const host = config.host;
  if (host !== undefined && host !== "0.0.0.0" && host !== "::") return host;
  return legacyPairingLanAddress() ?? "127.0.0.1";
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

async function printStatus(configPath: string, onboarding?: CliOnboardingController): Promise<void> {
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
  if (onboarding !== undefined) {
    const network = await onboarding.status();
    console.log(`Phone access mode: ${network.mode ?? "not selected"}`);
    console.log(`Phone access:      ${network.healthy ? "ready" : network.stage}`);
    if (network.issue !== undefined) printNetworkIssue(network.issue);
    if (network.expiresAt !== undefined) console.log(`Connection check expires: ${new Date(network.expiresAt).toISOString()}`);
    if (!network.healthy) console.log(`Resume: cozygateway setup --config "${configPath}"`);
  }
}

async function configureListener(configPath: string, io: CliIo, runtime: CliRuntime): Promise<void> {
  const before = readManagedListenerSnapshot(configPath);
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
  if (!compareAndSwapManagedListener(configPath, before, host, port))
    throw new Error("listener configuration changed in another window; review it and retry");
  const after = readManagedListenerSnapshot(configPath);
  const activate = async (): Promise<number> => {
    const managed = readManagedListenerSnapshot(configPath).profiles;
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
    if (!compareAndSwapManagedListenerSnapshot(configPath, after, before))
      throw new Error(`listener change failed (${String(error)}); a concurrent edit was preserved`);
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
  const code = newSetupCode();
  const prepared = preparePairingOutput({
    gatewayUrl,
    setupCode: code,
    ttlMs,
    color: process.stdout.isTTY === true,
    strictQr: false,
  });
  const storage = openStorage(config.dbPath);
  storage.createSetupCode(code, Date.now() + ttlMs);
  storage.close();
  console.log(prepared.terminalOutput.slice(0, -1));
}

async function runMenu(
  configPath: string,
  io: CliIo,
  runtime: CliRuntime,
  onboarding?: CliOnboardingController,
): Promise<number> {
  console.log("CozyGateway");
  await printStatus(configPath, onboarding);
  for (;;) {
    console.log("");
    console.log("1. Pair a device");
    console.log("2. Configure listener");
    console.log("3. Refresh status");
    console.log("4. Exit");
    const choice = (await io.question("Choice [1-4]: ")).trim().toLowerCase();
    if (choice === "1") {
      if (onboarding !== undefined) {
        const status = await onboarding.status();
        const legacyExplicitPair = status.stage === "legacy_unreviewed" && status.authority === "none";
        if ((status.stage !== "complete" || !status.healthy) && !legacyExplicitPair) {
          await runSetup(configPath, io, onboarding);
          continue;
        }
      }
      await runPair(configPath, undefined, undefined);
    }
    else if (choice === "2") {
      await configureListener(configPath, io, runtime);
      await printStatus(configPath, onboarding);
    } else if (choice === "3") await printStatus(configPath, onboarding);
    else if (choice === "4" || choice === "q" || choice === "quit" || choice === "exit") return 0;
    else console.log("Choose 1, 2, 3, or 4.");
  }
}

function resumeSetupCommand(configPath: string): string {
  return `cozygateway setup --config "${configPath}"`;
}

function setupIo(io: CliIo): OnboardingIo {
  return {
    chooseNetworkMode: async () => {
      for (;;) {
        console.log("1. Remote via personal Tailscale (recommended)");
        console.log("2. Same Wi-Fi");
        console.log("3. Set up later");
        console.log("4. Advanced settings");
        const choice = (await io.question("Phone access [1-4]: ")).trim().toLowerCase();
        if (choice === "1") return "tailscale";
        if (choice === "2") return "lan";
        if (choice === "3") return "later";
        if (choice === "4") {
          for (;;) {
            console.log("1. Configure the basic bind address and port");
            console.log("2. Choose a specific Same Wi-Fi adapter");
            const advanced = (await io.question("Advanced setting [1-2]: ")).trim().toLowerCase();
            if (advanced === "1") return "advanced";
            if (advanced === "2") return "lan";
            if (advanced === "q" || advanced === "cancel") return "cancel";
            console.log("Choose 1 or 2.");
          }
        }
        if (choice === "q" || choice === "cancel") return "cancel";
        console.log("Choose 1, 2, 3, or 4.");
      }
    },
    showNetworkDisclosure: (mode) => {
      if (mode === "tailscale") {
        console.log("Personal Tailscale security and privacy notice");
        console.log("- Tailscale must be active on this PC and the phone, signed in to the intended tailnet.");
        console.log("- Authorized or shared tailnet peers may reach CozyGateway when tailnet policy permits it.");
        console.log("- Tailnet administrators can observe and manage this device and its connectivity policy.");
        console.log("- Windows UAC and browser sign-in or HTTPS consent may appear before the phone check.");
        console.log("- Enabling Tailscale HTTPS publishes the machine and tailnet DNS name in Certificate Transparency.");
        console.log("- Keep this PC awake while using remote access; Windows sleep interrupts remote reachability.");
      } else if (mode === "lan") {
        console.log("Same Wi-Fi security notice");
        console.log("- LAN mode uses plaintext HTTP. Use it only on a trusted private network.");
        console.log("- A 0.0.0.0 wildcard bind listens on all interfaces: every active Wi-Fi, Ethernet, VPN, and virtual interface, not only the selected adapter.");
        console.log("- Phone verification proves reachability but cannot prevent passive same-LAN interception of later pairing traffic.");
      } else {
        console.log("Advanced network security notice");
        console.log("- Review the final bind address, transport security, and exposed interfaces before continuing.");
        console.log("- A non-loopback plaintext listener must be limited to a trusted private network.");
      }
    },
    showPreparedEndpointDisclosure: (endpoint) => {
      if (endpoint.mode !== "lan") return;
      const exposure = (endpoint as PreparedEndpoint & {
        wildcardExposure?: { message?: unknown };
      }).wildcardExposure;
      if (typeof exposure?.message !== "string" || exposure.message.length === 0 || exposure.message.length > 512)
        return;
      console.log(exposure.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));
    },
    showPhoneConnectionCheck: (verificationUrl) => {
      console.log("Phone connection check");
      console.log("This short-lived check is one-time. Browser history may retain its private URL, so do not share it.");
      console.log(renderQrHalfBlocks(encodeQr(verificationUrl), { color: process.stdout.isTTY === true }));
      console.log("Scan this check with the phone that will use CozyChat. No setup code has been created yet.");
    },
    showAuthoritativePhrase: (phrase) => {
      console.log(`Your phone shows: ${phrase}`);
    },
    confirmPhone: (phrase) => io.question(`Is this your phone (${phrase})? [y/N] `),
  };
}

const PAUSE_COPY: Readonly<Record<string, string>> = {
  not_installed: "Install the official Tailscale app, then resume setup.",
  install_cancelled: "Tailscale installation was cancelled in Windows. Nothing was paired.",
  install_reboot_required: "Restart Windows, then resume this setup.",
  install_verification_failed: "The Tailscale installer signature could not be verified. Download the current official installer, then resume.",
  install_failed: "Tailscale installation did not complete. Finish the official installer, then resume.",
  unsupported_install: "Remove the unsupported copy and install a supported official Tailscale installation, then resume.",
  unsupported_version: "Update Tailscale to a supported version, then resume.",
  status_unavailable: "Start the Tailscale service and confirm the app is responsive, then resume.",
  login_pending: "Finish signing in to Tailscale in the browser, then resume.",
  login_failed: "Tailscale sign-in did not finish. Check the Tailscale app, then resume.",
  login_browser_failed: "The Tailscale sign-in page could not be opened. Open the Tailscale app, finish signing in, then resume.",
  not_running: "Start Tailscale and wait until it is connected, then resume.",
  account_not_confirmed: "Review the signed-in account in the Tailscale app, then explicitly approve it during setup.",
  unattended_consent_required: "Approve Tailscale background connectivity; the PC and Gateway must stay awake and the Windows user session must remain running, then resume.",
  incoming_consent_required: "Approve incoming Tailscale connections, then resume.",
  machine_auth_required: "Ask the tailnet administrator to approve this machine, then resume.",
  preference_policy: "Tailscale policy blocked the requested setting. Ask the tailnet administrator, then resume.",
  managed_policy: "Tailscale policy blocked the requested setting. Ask the tailnet administrator, then resume.",
  https_consent_required: "Approve Tailscale HTTPS and its Certificate Transparency disclosure, then resume.",
  https_consent_failed: "Tailscale HTTPS approval did not complete. Review the Tailscale app, then resume.",
  https_consent_browser_failed: "The Tailscale HTTPS approval page could not be opened. Open the Tailscale admin page, approve HTTPS, then resume.",
  no_safe_consent_port: "No unused local port is available for safe Tailscale HTTPS approval. Close the conflicting service, then resume.",
  mapping_inspection_failed: "Setup could not safely inspect Tailscale Serve. Wait for Tailscale to become responsive, then resume.",
  mapping_mutation_failed: "Setup could not safely update Tailscale Serve. Review the existing port 443 mapping, then resume.",
  preference_cancelled: "The Tailscale preference change was cancelled. Nothing was paired; resume when ready.",
  preference_verification_failed: "Tailscale did not confirm the requested preference. Review it in the Tailscale app, then resume.",
  preference_change_denied: "Tailscale policy blocked the requested setting. Ask the tailnet administrator, then resume.",
  no_up_physical_private_ipv4: "Connect this PC to trusted Wi-Fi or Ethernet, then resume.",
  multiple_up_physical_private_ipv4: "More than one physical network is active. Disconnect one or choose the intended adapter explicitly in Advanced settings, then resume.",
  adapter_changed: "The previously selected network adapter is unavailable. Confirm the replacement adapter, then resume.",
  listener_changed: "The listener changed while setup was running. Review the intended adapter in Advanced settings, then resume.",
  mapping_conflict: "Tailscale port 443 is already in use. Keep that mapping and choose Same Wi-Fi, Later, or Advanced settings.",
  gateway_restarting: "Gateway is restarting. Wait for it to become ready, then resume; the prepared network route was preserved.",
  operator_busy: "Another setup window has an active phone check. Finish or cancel it there, then resume this window.",
  advanced_input_required: "Run setup in an interactive PowerShell window to enter the advanced bind address and port.",
};

const INSPECTION_COPY: Readonly<Record<Extract<NonNullable<NetworkOnboardingStatus["issue"]>, { type: "inspection" }>["reason"], string>> = {
  adapter_unavailable: "The saved phone access mode is unavailable in this installation. Choose another route in setup.",
  inspection_failed: "CozyGateway could not inspect the saved network route. Check the network service, then resume setup.",
  authoritative_posture_changed: "The verified network origin or deployment fingerprint changed. Review and verify the current route again.",
  projection_posture_changed: "The saved setup projection no longer matches the live network route. Review the current route again.",
  endpoint_not_ready: "The selected network endpoint is not ready. Restore network connectivity or choose another route.",
};

type ReadinessIssue = Extract<NonNullable<NetworkOnboardingStatus["issue"]>, { type: "readiness" }>;
type ReadinessKey = ReadinessIssue extends infer Issue
  ? Issue extends ReadinessIssue
    ? `${Issue["mode"]}:${Issue["reason"]}`
    : never
  : never;

const READINESS_COPY: Readonly<Record<ReadinessKey, string>> = {
  "tailscale:status": "Open Tailscale, start its service, confirm the intended account is connected, and restore the required preferences before resuming setup.",
  "tailscale:loopback": "Restart CozyGateway and confirm its local health and WebSocket endpoints work on loopback before resuming setup.",
  "tailscale:mapping": "Review the saved Tailscale Serve mapping on port 443, remove any conflicting mapping, then resume setup.",
  "tailscale:tls": "Confirm the Tailscale DNS name opens with a system-trusted HTTPS certificate, then resume setup.",
  "tailscale:certificate": "Confirm the Tailscale HTTPS certificate covers this device's exact tailnet DNS name, then resume setup.",
  "tailscale:redirect": "Remove the redirect from the Tailscale HTTPS origin so CozyGateway answers directly, then resume setup.",
  "tailscale:health": "Restore a direct HTTP 200 health response through Tailscale Serve, then resume setup.",
  "tailscale:alpn": "Configure the Tailscale HTTPS route to negotiate HTTP/1.1 for CozyGateway, then resume setup.",
  "tailscale:websocket": "Allow CozyGateway WebSocket traffic through Tailscale Serve and tailnet policy, then resume setup.",
  "tailscale:ownership": "Keep the CozyGateway database in place and resume setup so the saved Tailscale ownership record can be reconciled safely.",
  "lan:health": "Restart CozyGateway and verify its health endpoint on the selected private LAN address, then resume setup.",
  "lan:websocket": "Allow CozyGateway WebSocket traffic through Windows Firewall on the trusted private network, then resume setup.",
  "lan:attach": "Restore the configured attachment services and wait until Gateway readiness is healthy, then resume setup.",
  "lan:posture": "Reconnect the intended private adapter, restore its expected DHCP address, or explicitly choose the replacement adapter in Advanced settings.",
};

function printNetworkIssue(issue: NonNullable<NetworkOnboardingStatus["issue"]>): void {
  if (issue.type === "pause") {
    console.log(`Phone access reason: ${issue.reason}${issue.detail === undefined ? "" : ` (${issue.detail})`}`);
    console.log(`Repair: ${PAUSE_COPY[issue.reason] ?? "Resolve the paused network step, then resume setup."}`);
    return;
  }
  if (issue.type === "readiness") {
    const key = `${issue.mode}:${issue.reason}` as ReadinessKey;
    console.log(`Phone access reason: ${key}`);
    console.log(`Repair: ${READINESS_COPY[key]}`);
    return;
  }
  console.log(`Phone access reason: ${issue.reason}`);
  console.log(`Repair: ${INSPECTION_COPY[issue.reason]}`);
}

async function runSetup(
  configPath: string,
  io: CliIo,
  onboarding: CliOnboardingController,
): Promise<number> {
  if (!io.interactive) {
    console.log(`Resume phone access setup with: ${resumeSetupCommand(configPath)}`);
    return 0;
  }
  const outcome = await onboarding.resume(setupIo(io));
  if (outcome.outcome === "paused") {
    console.log(PAUSE_COPY[outcome.reason] ?? "Phone access setup paused before pairing. Resolve the requested external step, then resume.");
    console.log(`Resume: ${resumeSetupCommand(configPath)}`);
  } else if (outcome.outcome === "deferred" || outcome.outcome === "cancelled") {
    console.log("Phone access was left on loopback. No pairing material was created.");
    console.log(`Resume: ${resumeSetupCommand(configPath)}`);
  } else if (outcome.outcome === "not_confirmed") {
    console.log("The phone connection check was not confirmed. No pairing material was created.");
    console.log(`Resume: ${resumeSetupCommand(configPath)}`);
  } else if (outcome.outcome === "invalidated") {
    console.log("The network changed during verification. Run setup again for the current route.");
    console.log(`Resume: ${resumeSetupCommand(configPath)}`);
  } else if (outcome.outcome === "failed") {
    console.log(outcome.reason === "rollback_failed"
      ? "Setup could not safely restore the prior network state. Review the listener or Tailscale mapping, then resume."
      : "Phone access is not ready. Resolve the network step, then resume.");
    console.log(`Resume: ${resumeSetupCommand(configPath)}`);
  } else if (outcome.outcome === "lost_race") {
    console.log("Another setup window completed this step first. Run status to review it.");
  } else if (outcome.outcome === "already_complete") {
    console.log("Phone access is already verified for the current network posture.");
  }
  return 0;
}

export async function runCli(
  argv: string[],
  suppliedIo?: CliIo,
  suppliedRuntime?: CliRuntime,
  onboarding?: CliOnboardingController,
  internal: CliInternalDependencies = {},
): Promise<number> {
  const runtime = suppliedRuntime ?? defaultRuntime;
  const platform = internal.platform ?? process.platform;
  const command = argv[0] !== undefined && !argv[0].startsWith("-") ? argv[0] : undefined;
  const optionArgs = command === undefined ? argv : argv.slice(1);
  const parseOptions = () => parseArgs({
    args: optionArgs,
    options: {
      config: { type: "string", default: "cozygateway.config.json" },
      url: { type: "string" },
      ttl: { type: "string" },
    },
  });
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions();
  } catch (error) {
    if (command !== "cleanup-owned-network") throw error;
    console.error("Owned network cleanup failed.");
    suppliedIo?.close();
    onboarding?.close();
    return 1;
  }
  const { values } = parsed;
  const configPath = values.config;
  let ownedOnboarding: CliOnboardingController | undefined;
  const resolvedOnboarding = (activeIo?: CliIo): CliOnboardingController | undefined => {
    if (onboarding !== undefined) return onboarding;
    if (platform !== "win32") return undefined;
    ownedOnboarding ??= createWindowsOnboardingController(configPath, activeIo ?? suppliedIo, runtime);
    return ownedOnboarding;
  };

  if (command === "cleanup-owned-network") {
    try {
      if (platform !== "win32") {
        console.error("Owned network cleanup is Windows only.");
        return 1;
      }
      if (!optionArgs.some((argument) => argument === "--config" || argument.startsWith("--config="))) {
        console.error("Owned network cleanup requires an explicit --config path.");
        return 1;
      }
      try {
        await (internal.reconcileOwnedNetworkState ?? reconcileWindowsOwnedNetworkState)(
          configPath,
          runtime,
          undefined,
        );
        return 0;
      } catch {
        console.error("Owned network cleanup failed.");
        return 1;
      }
    } finally {
      suppliedIo?.close();
      (ownedOnboarding ?? onboarding)?.close();
    }
  }

  if (command === undefined || command === "configure") {
    const io = suppliedIo ?? terminalIo();
    try {
      if (!io.interactive) {
        console.error(USAGE);
        return 1;
      }
      return command === "configure"
        ? (await configureListener(configPath, io, runtime), 0)
        : await runMenu(configPath, io, runtime, resolvedOnboarding(io));
    } finally {
      io.close();
      ownedOnboarding?.close();
    }
  }

  if (command === "status") {
    try {
      await printStatus(configPath, resolvedOnboarding());
      return 0;
    } finally {
      ownedOnboarding?.close();
    }
  }

  if (command === "setup") {
    const io = suppliedIo ?? terminalIo();
    try {
      const controller = resolvedOnboarding(io);
      if (controller === undefined) throw new Error("phone access setup is not initialized; rerun the Windows installer");
      return await runSetup(configPath, io, controller);
    } finally {
      io.close();
      (ownedOnboarding ?? onboarding)?.close();
    }
  }

  if (command === "serve") {
    const config = applyEnvOverrides(loadConfig(configPath), process.env);
    const gateway = await startGateway(config, { configPath });
    console.log(`cozygateway ${GATEWAY_VERSION} listening on ${gateway.url}`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await gateway.close();
    return 0;
  }

  if (command === "pair") {
    const controller = resolvedOnboarding();
    try {
      if (controller !== undefined) {
        const status = await controller.status();
        const legacyExplicitPair = status.stage === "legacy_unreviewed" && status.authority === "none";
        if ((status.authority !== "complete" || status.stage !== "complete" || !status.healthy) && !legacyExplicitPair)
          throw new Error(`phone access is not verified for the current network; run ${resumeSetupCommand(configPath)}`);
      }
      await runPair(configPath, values.url, values.ttl);
      return 0;
    } finally {
      ownedOnboarding?.close();
    }
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

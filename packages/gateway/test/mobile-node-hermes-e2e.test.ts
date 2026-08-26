import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ReadyFrame, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const PLUGIN_ROOT = fileURLToPath(new URL("../../../integrations/attach-plugin", import.meta.url));
const HARNESS = join(PLUGIN_ROOT, "tests/live_mobile_node_harness.py");
const PINNED_HERMES = pinnedHermes();

it.runIf(PINNED_HERMES !== undefined)("runs the real Hermes status tool through the live origin-bound mobile-node path (requires HERMES_AGENT_ROOT)", async () => {
  await runMobileToolE2E("status");
}, 30_000);

it.runIf(PINNED_HERMES !== undefined)("runs the real Hermes location tool through the live origin-bound mobile-node path (requires HERMES_AGENT_ROOT)", async () => {
  await runMobileToolE2E("location");
}, 30_000);

async function runMobileToolE2E(tool: "status" | "location"): Promise<void> {
  process.env["MOBILE_HERMES_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["MOBILE_HERMES_SAGE_TOKEN"] = "attach-secret";
  let gateway: RunningGateway | undefined;
  let hermes: FakeHermesServer | undefined;
  const sockets: WebSocket[] = [];
  let harness: Harness | undefined;
  try {
    hermes = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({ profiles: [{ name: "sage", description: "native", has_avatar: false, ui_meta: { "hermes-bots": { title: "Sage" } } }], bot_mode_protocol: true }),
      },
    });
    gateway = await startGateway({
      name: "mobile-node-hermes-e2e", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
      hermes: {
        url: hermes.url, tokenEnv: "MOBILE_HERMES_DASHBOARD_TOKEN",
        profiles: { sage: { tokenEnv: "MOBILE_HERMES_SAGE_TOKEN", name: "Sage" } },
      },
    });
    const tokenA = await pair(gateway);
    const tokenB = await pair(gateway);
    const appA = await appSocket(gateway.url, tokenA, sockets);
    const appB = await appSocket(gateway.url, tokenB, sockets);
    expect(appA.ready.deviceId).not.toBe(appB.ready.deviceId);
    appA.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status", "location.current"], foreground: tool === "location" }));
    appB.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status", "location.current"], foreground: true }));
    await pause();

    harness = startHarness(gateway.url, PINNED_HERMES!, tool);
    await harness.until((event) => event.e2e === "ready");
    await until(() => gateway!.storage.botRoster().bots.some((bot) => bot.name === "sage"));
    const sent = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST", headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "check actual tool", clientId: "origin-a" }),
    });
    expect(sent.status).toBe(202);

    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request"));
    const request = appA.frames.find((frame) => frame.type === "mobile_node_request")!;
    expect(request).toMatchObject(tool === "location"
      ? { command: "location.current", purpose: "Find nearby coffee" }
      : { command: "device.status", purpose: "Report phone readiness" });
    expect(appB.frames.some((frame) => frame.type === "mobile_node_request")).toBe(false);
    appB.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: request.requestId, lease: request.lease, status: "denied" }));
    await pause();
    expect(harness.events.some((event) => event.e2e === "result")).toBe(false);
    const mobileResult = tool === "location"
      ? { latitude: 41.88, longitude: -87.63 }
      : {
          appState: "background", lowPowerMode: false,
          capabilities: [{ command: "device.status", permission: "not_required" }],
        };
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: request.requestId, lease: request.lease, status: "ok", result: mobileResult }));

    const result = await harness.until((event) => event.e2e === "result");
    expect(result).toMatchObject({
      threadId: request.threadId, turnId: request.turnId,
      result: tool === "location"
        ? { status: "ok", result: mobileResult }
        : { status: "ok", result: { ...mobileResult, authenticatedReachable: true, lastAuthenticatedPresenceAt: expect.any(Number) } },
    });
    await harness.exited();
  } finally {
    await harness?.close();
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    await hermes?.close();
    delete process.env["MOBILE_HERMES_DASHBOARD_TOKEN"];
    delete process.env["MOBILE_HERMES_SAGE_TOKEN"];
  }
}

function startHarness(gatewayUrl: string, hermes: HermesRuntime, tool: "status" | "location"): Harness {
  const home = mkdtempSync(join(tmpdir(), "cozy-mobile-hermes-"));
  const child = spawn(hermes.python, [HARNESS], {
    env: {
      PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C", TMPDIR: process.env.TMPDIR ?? tmpdir(),
      HERMES_AGENT_ROOT: hermes.root, HERMES_HOME: home,
      HERMES_PROFILE: "sage", COZYGATEWAY_URL: gatewayUrl,
      COZYGATEWAY_TOKEN: "attach-secret", COZY_MOBILE_TOOL: tool, PYTHONPATH: `${PLUGIN_ROOT}:${hermes.root}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Harness(child, home);
}

function pinnedHermes(): HermesRuntime | undefined {
  const root = process.env.HERMES_AGENT_ROOT?.trim();
  if (!root) return undefined;
  const python = process.env.HERMES_PYTHON?.trim() || join(root, ".venv", "bin", "python");
  return existsSync(root) && existsSync(python) ? { root, python } : undefined;
}

interface HermesRuntime {
  root: string;
  python: string;
}

class Harness {
  readonly events: Array<Record<string, unknown>> = [];
  readonly child: ChildProcess;
  readonly home: string;
  #stderr = "";
  #buffer = "";

  constructor(child: ChildProcess, home: string) {
    this.child = child;
    this.home = home;
    child.stdout!.on("data", (chunk: Buffer) => this.#read(String(chunk)));
    child.stderr!.on("data", (chunk: Buffer) => { this.#stderr += String(chunk); });
  }

  async until(predicate: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    await until(() => this.events.some(predicate));
    return this.events.find(predicate)!;
  }

  async exited(): Promise<void> {
    const [code] = await once(this.child, "exit") as [number | null];
    expect(code, this.#stderr).toBe(0);
  }

  async close(): Promise<void> {
    try {
      if (this.child.exitCode === null) {
        this.child.kill();
        await once(this.child, "exit");
      }
      if (this.#stderr && this.child.exitCode !== 0) throw new Error(this.#stderr);
    } finally {
      rmSync(this.home, { recursive: true, force: true });
    }
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (typeof event.e2e === "string") this.events.push(event);
      } catch {
        // Hermes may emit ordinary logs; only e2e JSON is control traffic.
      }
    }
  }
}

async function pair(gateway: RunningGateway): Promise<string> {
  const response = await fetch(`${gateway.url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }) });
  return ((await response.json()) as { deviceToken: string }).deviceToken;
}

async function appSocket(url: string, token: string, sockets: WebSocket[]): Promise<{ socket: WebSocket; frames: ServerFrame[]; ready: ReadyFrame }> {
  const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
  const frames: ServerFrame[] = [];
  sockets.push(socket);
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "auth", token }));
  await until(() => frames.some((frame) => frame.type === "ready"));
  return { socket, frames, ready: frames.find((frame): frame is ReadyFrame => frame.type === "ready")! };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await pause(5);
  }
}

async function pause(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

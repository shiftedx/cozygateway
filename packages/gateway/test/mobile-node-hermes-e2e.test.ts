import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ReadyFrame, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const HERMES_ROOT = "/Users/kmcdowell/.hermes/hermes-agent";
const HERMES_PYTHON = `${HERMES_ROOT}/.venv/bin/python`;
const PLUGIN_ROOT = fileURLToPath(new URL("../../../integrations/attach-plugin", import.meta.url));
const HARNESS = join(PLUGIN_ROOT, "tests/live_mobile_node_harness.py");

it("runs the real Hermes status tool through the live origin-bound mobile-node path", async () => {
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
    appA.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status"], foreground: true }));
    appB.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status"], foreground: true }));
    await pause();

    harness = startHarness(gateway.url);
    await harness.until((event) => event.e2e === "ready");
    await until(() => gateway!.storage.botRoster().bots.some((bot) => bot.name === "sage"));
    const sent = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST", headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "check actual tool", clientId: "origin-a" }),
    });
    expect(sent.status).toBe(202);

    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request"));
    const request = appA.frames.find((frame) => frame.type === "mobile_node_request")!;
    expect(appB.frames.some((frame) => frame.type === "mobile_node_request")).toBe(false);
    appB.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: request.requestId, status: "denied" }));
    await pause();
    expect(harness.events.some((event) => event.e2e === "result")).toBe(false);
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: request.requestId, status: "ok", result: { foreground: true } }));

    const result = await harness.until((event) => event.e2e === "result");
    expect(result).toMatchObject({ threadId: request.threadId, turnId: request.turnId, result: { status: "ok", result: { foreground: true } } });
    await harness.exited();
  } finally {
    await harness?.close();
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    await hermes?.close();
    delete process.env["MOBILE_HERMES_DASHBOARD_TOKEN"];
    delete process.env["MOBILE_HERMES_SAGE_TOKEN"];
  }
}, 30_000);

function startHarness(gatewayUrl: string): Harness {
  const home = mkdtempSync(join(tmpdir(), "cozy-mobile-hermes-"));
  const child = spawn(HERMES_PYTHON, [HARNESS], {
    env: {
      ...process.env, HERMES_AGENT_ROOT: HERMES_ROOT, HERMES_HOME: home,
      HERMES_PROFILE: "sage", COZYGATEWAY_URL: gatewayUrl,
      COZYGATEWAY_TOKEN: "attach-secret", PYTHONPATH: `${PLUGIN_ROOT}:${HERMES_ROOT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Harness(child);
}

class Harness {
  readonly events: Array<Record<string, unknown>> = [];
  readonly child: ChildProcess;
  #stderr = "";
  #buffer = "";

  constructor(child: ChildProcess) {
    this.child = child;
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
    if (this.child.exitCode !== null) return;
    this.child.kill();
    await once(this.child, "exit");
    if (this.#stderr) throw new Error(this.#stderr);
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

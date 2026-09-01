import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.ts";
import { hashToken } from "../src/auth.ts";
import { GatewayMaintenance, UnixSocketGatewayMaintenanceSupervisor } from "../src/gateway-maintenance.ts";
import { createApp } from "../src/http.ts";
import { openStorage } from "../src/storage.ts";

const supervisorScript = resolve(process.cwd(), "../../scripts/compose-maintenance-supervisor.py");
const maintenanceCompose = resolve(process.cwd(), "../../docker-compose.maintenance.yml");
const children: ChildProcess[] = [];
const dockerServers: Server[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    }
  }
  for (const server of dockerServers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
});

function request(socketPath: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = connect(socketPath);
    let text = "";
    socket.setEncoding("utf8");
    socket.once("error", rejectRequest);
    socket.on("data", (chunk: string) => {
      text += chunk;
      if (!text.includes("\n")) return;
      socket.destroy();
      resolveRequest(JSON.parse(text.slice(0, text.indexOf("\n"))) as Record<string, unknown>);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(body)}\n`));
  });
}

async function gatewayRestart(socketPath: string, requestId: string): Promise<Response> {
  const storage = openStorage(":memory:");
  const token = "paired-maintenance-test";
  storage.createDevice({ id: "device", name: "Phone", tokenHash: hashToken(token), createdAt: 1 });
  const supervisor = new UnixSocketGatewayMaintenanceSupervisor(socketPath);
  const maintenance = new GatewayMaintenance(storage, supervisor, await supervisor.status(), "0.6.4", () => Date.now());
  const config: GatewayConfig = {
    name: "test", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0,
    hermesEndpoints: [{ id: "default", url: "ws://127.0.0.1:1/api/ws", tokenEnv: "CONTROL", profiles: { cleo: { tokenEnv: "ATTACH" } } }],
  };
  const app = createApp({
    storage, config, gatewayInfo: { name: "test", version: "0.6.4", contract: "v1" }, maintenance,
    presenceOf: () => "online", submitUserMessage: () => ({ threadId: "t", seq: 1, role: "user", blocks: [], createdAt: 1 }),
    interruptThread: () => "idle", resolveApproval: () => Promise.resolve("unknown" as const), onDeviceRevoked: () => {}, now: () => Date.now(),
  });
  return app.request("/gateway/maintenance/restart", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId }),
  });
}

async function start(options: { latestVersion?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cozygateway-maintenance-"));
  const socketPath = join(directory, "control.sock");
  const composeFile = join(directory, "compose.yml");
  const overrideFile = join(directory, "compose.override.yml");
  const stateFile = join(directory, "operations.json");
  const log = join(directory, "docker.log");
  const docker = join(directory, "docker");
  writeFileSync(composeFile, "services: {}\n");
  writeFileSync(overrideFile, "services: {}\n");
  writeFileSync(docker, `#!/usr/bin/python3
import os
from pathlib import Path
Path(os.environ['DOCKER_LOG']).write_text(str(__import__('time').time_ns()))
`);
  chmodSync(docker, 0o700);
  const child = spawn("/usr/bin/python3", [supervisorScript], {
    env: {
      ...process.env,
      COZYGATEWAY_MAINTENANCE_SOCKET: socketPath,
      COZYGATEWAY_MAINTENANCE_COMPOSE_DIR: directory,
      // Regression: restart must retain both base and production override layers.
      COZYGATEWAY_MAINTENANCE_COMPOSE_FILES: `${composeFile},${overrideFile}`,
      COZYGATEWAY_MAINTENANCE_CURRENT_VERSION: "0.6.4",
      COZYGATEWAY_MAINTENANCE_STATE_FILE: stateFile,
      COZYGATEWAY_MAINTENANCE_ALLOWED_UID: String(process.getuid?.() ?? 0),
      ...(options.latestVersion === undefined ? {} : { COZYGATEWAY_MAINTENANCE_LATEST_VERSION: options.latestVersion }),
      COZYGATEWAY_DOCKER_BIN: docker,
      DOCKER_LOG: log,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  let errors = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { output += chunk; });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { errors += chunk; });
  const deadline = Date.now() + 3_000;
  while (!output.includes("listening")) {
    if (Date.now() > deadline) throw new Error(`maintenance supervisor did not start: ${errors}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return { socketPath, log, stateFile };
}

async function startFixedContainer(containerName = "cozygateway-gateway-1") {
  const directory = mkdtempSync(join(tmpdir(), "cozygateway-fixed-maintenance-"));
  const socketPath = join(directory, "control.sock");
  const dockerSocket = join(directory, "docker.sock");
  const stateFile = join(directory, "operations.json");
  const requests: string[] = [];
  const dockerServer = createServer((connection) => {
    let requestText = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      requestText += chunk;
      if (!requestText.includes("\r\n\r\n")) return;
      requests.push(requestText);
      connection.end("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
  });
  dockerServers.push(dockerServer);
  dockerServer.listen(dockerSocket);
  await once(dockerServer, "listening");
  const child = spawn("/usr/bin/python3", [supervisorScript], {
    env: {
      ...process.env,
      COZYGATEWAY_MAINTENANCE_SOCKET: socketPath,
      COZYGATEWAY_MAINTENANCE_CURRENT_VERSION: "0.6.4",
      COZYGATEWAY_MAINTENANCE_CONTAINER_NAME: containerName,
      COZYGATEWAY_MAINTENANCE_DOCKER_SOCKET: dockerSocket,
      COZYGATEWAY_MAINTENANCE_STATE_FILE: stateFile,
      COZYGATEWAY_MAINTENANCE_ALLOWED_UID: String(process.getuid?.() ?? 0),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  let errors = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { output += chunk; });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { errors += chunk; });
  const deadline = Date.now() + 3_000;
  while (!output.includes("listening")) {
    if (Date.now() > deadline) throw new Error(`fixed maintenance supervisor did not start: ${errors}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return { socketPath, requests };
}

describe("Compose maintenance supervisor", () => {
  it("reports unavailable/up-to-date safely and persists one delayed restart handoff", async () => {
    const unavailable = await start();
    expect((await request(unavailable.socketPath, { action: "status" })).status).toMatchObject({ update: { state: "unavailable" } });

    const upToDate = await start({ latestVersion: "0.6.4" });
    expect((await request(upToDate.socketPath, { action: "status" })).status).toMatchObject({ update: { state: "upToDate" } });
    const before = Date.now();
    // End-to-end ordering: CozyGateway has returned a paired HTTP 202 before the host action
    // begins; its receipt is therefore persisted before the fixed host handoff window starts.
    const receiptResponse = await gatewayRestart(upToDate.socketPath, "phone-request");
    expect(receiptResponse.status).toBe(202);
    const operationId = (await receiptResponse.json() as { operationId: string }).operationId;
    expect(existsSync(upToDate.log)).toBe(false);
    expect(JSON.parse(readFileSync(upToDate.stateFile, "utf8"))).toMatchObject({ operations: { [operationId]: { action: "restart", state: "scheduled" } } });
    // Crash/retry window: durable duplicate acknowledgement never starts a second Compose action.
    expect(await request(upToDate.socketPath, { action: "restart", operationId })).toEqual({ ok: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 6_500));
    expect(Number(readFileSync(upToDate.log, "utf8").trim()) / 1_000_000).toBeGreaterThanOrEqual(before + 4_500);
    expect(await request(upToDate.socketPath, { action: "restart", operationId: "not-an-operation" }))
      .toEqual({ ok: false, code: "invalid_request" });
  }, 12_000);

  it("uses only the configured Docker Engine restart endpoint after the gateway receipt", async () => {
    const fixed = await startFixedContainer();
    const receiptResponse = await gatewayRestart(fixed.socketPath, "fixed-container-request");
    expect(receiptResponse.status).toBe(202);
    const { operationId } = await receiptResponse.json() as { operationId: string };
    // The durable acknowledgement is delivered before the fixed handoff delay allows Docker I/O.
    expect(fixed.requests).toEqual([]);
    expect(await request(fixed.socketPath, { action: "restart", operationId, container: "other-container" }))
      .toEqual({ ok: false, code: "invalid_request" });
    expect(fixed.requests).toEqual([]);
    // A duplicate receipt cannot schedule another Docker call.
    expect(await request(fixed.socketPath, { action: "restart", operationId })).toEqual({ ok: true });
    await new Promise((resolveWait) => setTimeout(resolveWait, 6_000));
    expect(fixed.requests).toHaveLength(1);
    expect(fixed.requests[0]).toContain("POST /containers/cozygateway-gateway-1/restart HTTP/1.1\r\n");
    expect(fixed.requests[0]).toContain("Content-Length: 0\r\n");
    expect(fixed.requests[0]).not.toContain("other-container");
  }, 12_000);

  it("ships a locked-down sidecar while the gateway remains Docker-socket-free", () => {
    const compose = readFileSync(maintenanceCompose, "utf8");
    const gateway = compose.slice(compose.indexOf("  gateway:\n"));
    expect(compose).toContain("maintenance-supervisor:");
    expect(compose).toContain("python:3.13-alpine@sha256:62e80a1ff2a4af41c6fe72a629e5729463a4fd05ae89ecc9c812a6c1457f2cc7");
    expect(compose).toContain("/var/run/docker.sock:/var/run/docker.sock:rw");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain('cap_drop: ["ALL"]');
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("network_mode: none");
    expect(compose).toContain("restart: unless-stopped");
    expect(compose).toContain("condition: service_healthy");
    expect(gateway).not.toContain("/var/run/docker.sock:");
  });
});

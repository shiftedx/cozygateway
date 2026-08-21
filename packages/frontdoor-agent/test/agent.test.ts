import { createServer, request as httpRequest, type ClientRequest, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { startFrontdoor, type RunningFrontdoor } from "cozy-frontdoor";

import { startAgent, type RunningAgent } from "../src/agent.ts";

let dir: string;
let fd: RunningFrontdoor | undefined;
let agent: RunningAgent | undefined;
let local: Server | undefined;
let earlyTargetClosed: Promise<void> | undefined;
let resolveEarlyTargetClosed: (() => void) | undefined;

function openRequest(port: number, hostHeader: string, path: string, method = "GET"): { req: ClientRequest; response: Promise<{ status: number; text: string }> } {
  let req!: ClientRequest;
  const response = new Promise<{ status: number; text: string }>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { host: hostHeader },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", fail);
      res.on("aborted", () => fail(new Error("response aborted")));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() });
      });
    });
    req.on("error", fail);
  });
  return { req, response };
}

function request(port: number, hostHeader: string, path: string): Promise<{ status: number; text: string }> {
  const opened = openRequest(port, hostHeader, path);
  opened.req.end();
  return opened.response;
}

function waitFor(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(() => {
      clearTimeout(timer);
      resolve();
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

afterEach(async () => {
  agent?.close();
  agent = undefined;
  await new Promise<void>((r) => (local ? local.close(() => r()) : r()));
  local = undefined;
  await fd?.close();
  fd = undefined;
  earlyTargetClosed = undefined;
  resolveEarlyTargetClosed = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  dir = mkdtempSync(join(tmpdir(), "fd-agent-"));
  fd = await startFrontdoor({
    port: 0, host: "127.0.0.1", dbPath: join(dir, "db.sqlite"),
    pool: ["relay-01.cozylabs.ai"], maxHouseholds: 10, provisionsPerHourPerIp: 100, apiHostnames: [],
  });
  const grant = await (await fetch(`${fd.url}/provision`, { method: "POST", body: "{}" })).json();

  // stand-in for headscale: http endpoint + ws echo on one server
  earlyTargetClosed = new Promise<void>((resolve) => (resolveEarlyTargetClosed = resolve));
  local = createServer((req, res) => {
    if (req.url === "/early") {
      req.socket.once("close", () => resolveEarlyTargetClosed?.());
      res.writeHead(413);
      res.end();
    } else if (req.url === "/collect") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => { res.writeHead(200); res.end(Buffer.concat(chunks)); });
    } else if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"healthy":true}'); }
    else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ server: local, path: "/ts2021" });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send(m)));
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  const targetPort = (local.address() as { port: number }).port;

  agent = startAgent({ frontdoorUrl: fd.url, credential: grant.credential, targetHost: "127.0.0.1", targetPort, backoffMs: { initial: 200, max: 1000 } });
  await agent.connectedOnce;
  return { hostname: grant.hostname as string };
}

describe("frontdoor-agent", () => {
  it("makes the local http endpoint reachable via the pooled hostname", async () => {
    const { hostname } = await boot();
    const res = await request(fd!.port, hostname, "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ healthy: true });
  });

  it("does not abort a routine multi-chunk POST body", async () => {
    const { hostname } = await boot();
    const opened = openRequest(fd!.port, hostname, "/collect", "POST");
    const first = Buffer.alloc(64 * 1024, "a");
    const second = Buffer.alloc(64 * 1024, "b");
    opened.req.write(first);
    opened.req.write(second);
    opened.req.end();
    const res = await opened.response;
    expect(res.status).toBe(200);
    expect(Buffer.from(res.text)).toEqual(Buffer.concat([first, second]));
  });

  it("cleans up a target request after an early response", async () => {
    const { hostname } = await boot();
    const opened = openRequest(fd!.port, hostname, "/early", "POST");
    try {
      opened.req.write(Buffer.alloc(64 * 1024));
      const res = await opened.response;
      expect(res.status).toBe(413);
      opened.req.write(Buffer.from("still streaming"));
      await waitFor(earlyTargetClosed!, 1000);

      const health = await request(fd!.port, hostname, "/health");
      expect(health.status).toBe(200);
    } finally {
      opened.req.destroy();
    }
  });

  it("carries a websocket end to end (ts2021 shape)", async () => {
    const { hostname } = await boot();
    const { default: WebSocket } = await import("ws");
    const client = new WebSocket(`ws://127.0.0.1:${fd!.port}/ts2021`, { headers: { host: hostname } });
    await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });
    const echoed = new Promise<string>((resolve) => client.once("message", (m) => resolve(String(m))));
    client.send("noise-bytes");
    expect(await echoed).toBe("noise-bytes");
    client.close();
  });

  it("reconnects after the front door drops it", async () => {
    const { hostname } = await boot();
    fd!.registry.get(fd!.storage.householdIdForHostname(hostname)!)!.close();
    // wait for the reconnect (initial backoff 200ms for this test; poll up to 10s)
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await request(fd!.port, hostname, "/health");
      ok = res.status === 200;
    }
    expect(ok).toBe(true);
  });
});

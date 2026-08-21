import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { decodeFrame, encodeFrame, type Frame } from "../src/frames.ts";
import { startFrontdoor, type RunningFrontdoor } from "../src/server.ts";

let dir: string;
let fd: RunningFrontdoor | undefined;
let agent: WebSocket | undefined;

function request(
  port: number,
  hostHeader: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: opts.method ?? "GET",
      headers: { host: hostHeader, ...opts.headers },
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
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function abortOnResponseFrames(framesForSid: (sid: number) => Frame[]): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const frame = decodeFrame(String(raw));
      if (frame?.t === "open") {
        for (const response of framesForSid(frame.sid)) agent!.send(encodeFrame(response));
      } else if (frame?.t === "abort") {
        cleanup();
        resolve(frame);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      agent?.off("message", onMessage);
      agent?.off("error", onError);
    };
    agent!.on("message", onMessage);
    agent!.on("error", onError);
  });
}

afterEach(async () => {
  agent?.close();
  agent = undefined;
  await fd?.close();
  fd = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<{ fd: RunningFrontdoor; credential: string; hostname: string }> {
  dir = mkdtempSync(join(tmpdir(), "fd-srv-"));
  fd = await startFrontdoor({
    port: 0, host: "127.0.0.1", dbPath: join(dir, "db.sqlite"),
    pool: ["relay-01.cozylabs.ai"], maxHouseholds: 10, provisionsPerHourPerIp: 100,
    apiHostnames: [],
  });
  const res = await fetch(`${fd.url}/provision`, { method: "POST", body: "{}" });
  const grant = await res.json();
  return { fd, credential: grant.credential, hostname: grant.hostname };
}

function connectAgent(url: string, credential: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace("http", "ws") + "/agent", {
      headers: { authorization: `Bearer ${credential}` },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

describe("frontdoor server", () => {
  it("rejects agent connections with a bad credential", async () => {
    const { fd } = await boot();
    await expect(connectAgent(fd.url, "fdc_" + "0".repeat(48))).rejects.toThrow(/401/);
  });

  it("streams an http request to the attached agent and returns its response", async () => {
    const { fd, credential, hostname } = await boot();
    agent = await connectAgent(fd.url, credential);
    // fake box side: answer every open with a 200 body "pong"
    agent.on("message", (raw) => {
      const f = decodeFrame(String(raw));
      if (f?.t === "open") {
        agent!.send(encodeFrame({ t: "head", sid: f.sid, status: 200, headers: { "content-type": ["text/plain"] } }));
        agent!.send(encodeFrame({ t: "data", sid: f.sid, b64: Buffer.from("pong").toString("base64") }));
        agent!.send(encodeFrame({ t: "end", sid: f.sid }));
      }
    });
    const res = await request(fd.port, hostname, "/health");
    expect(res.status).toBe(200);
    expect(res.text).toBe("pong");
  });

  it("502 agent_offline when no agent is attached", async () => {
    const { fd, hostname } = await boot();
    const res = await request(fd.port, hostname, "/health");
    expect(res.status).toBe(502);
    expect(JSON.parse(res.text).error.code).toBe("agent_offline");
  });

  it("404 unknown_hostname for a pool hostname nobody holds", async () => {
    dir = mkdtempSync(join(tmpdir(), "fd-srv-"));
    fd = await startFrontdoor({
      port: 0, host: "127.0.0.1", dbPath: join(dir, "db.sqlite"),
      pool: ["relay-09.cozylabs.ai"], maxHouseholds: 10, provisionsPerHourPerIp: 100, apiHostnames: [],
    });
    const res = await request(fd.port, "relay-09.cozylabs.ai", "/x");
    expect(res.status).toBe(404);
  });

  it("request body reaches the agent", async () => {
    const { fd, credential, hostname } = await boot();
    agent = await connectAgent(fd.url, credential);
    const got: Buffer[] = [];
    agent.on("message", (raw) => {
      const f = decodeFrame(String(raw));
      if (f?.t === "data") got.push(Buffer.from(f.b64, "base64"));
      if (f?.t === "end") {
        agent!.send(encodeFrame({ t: "head", sid: f.sid, status: 200, headers: {} }));
        agent!.send(encodeFrame({ t: "data", sid: f.sid, b64: Buffer.concat(got).toString("base64") }));
        agent!.send(encodeFrame({ t: "end", sid: f.sid }));
      }
    });
    const res = await request(fd.port, hostname, "/echo", { method: "POST", body: "machine-key-blob" });
    expect(res.text).toBe("machine-key-blob");
  });

  it("aborts a stream when response data arrives before head", async () => {
    const { fd, credential, hostname } = await boot();
    agent = await connectAgent(fd.url, credential);
    const aborted = abortOnResponseFrames((sid) => [
      { t: "data", sid, b64: Buffer.from("bad").toString("base64") },
    ]);
    const pending = request(fd.port, hostname, "/invalid-data");
    await expect(pending).rejects.toThrow();
    await expect(aborted).resolves.toMatchObject({ t: "abort" });
  });

  it("aborts a stream when response end arrives before head", async () => {
    const { fd, credential, hostname } = await boot();
    agent = await connectAgent(fd.url, credential);
    const aborted = abortOnResponseFrames((sid) => [{ t: "end", sid }]);
    const pending = request(fd.port, hostname, "/invalid-end");
    await expect(pending).rejects.toThrow();
    await expect(aborted).resolves.toMatchObject({ t: "abort" });
  });

  it("aborts a stream when response head is duplicated", async () => {
    const { fd, credential, hostname } = await boot();
    agent = await connectAgent(fd.url, credential);
    const aborted = abortOnResponseFrames((sid) => [
      { t: "head", sid, status: 200, headers: {} },
      { t: "head", sid, status: 200, headers: {} },
    ]);
    const pending = request(fd.port, hostname, "/duplicate-head");
    await expect(pending).rejects.toThrow();
    await expect(aborted).resolves.toMatchObject({ t: "abort" });
  });

  it("treats a registry link without a server stream table as offline", async () => {
    const { fd, hostname } = await boot();
    const householdId = fd.storage.householdIdForHostname(hostname);
    if (householdId === undefined) throw new Error("expected provisioned household");
    fd.registry.attach(householdId, { send() {}, close() {} });
    const res = await request(fd.port, hostname, "/foreign-link");
    expect(res.status).toBe(502);
    expect(JSON.parse(res.text).error.code).toBe("agent_offline");
  });

  it("closes connected agents and aborts in-flight streams", async () => {
    const { fd, credential, hostname } = await boot();
    agent = await connectAgent(fd.url, credential);
    const agentClosed = new Promise<void>((resolve) => agent!.once("close", resolve));
    const opened = new Promise<Frame>((resolve) => {
      agent!.on("message", (raw) => {
        const frame = decodeFrame(String(raw));
        if (frame?.t === "open") resolve(frame);
      });
    });
    const pending = expect(request(fd.port, hostname, "/in-flight")).rejects.toThrow();
    await opened;
    await fd.close();
    await agentClosed;
    await pending;
    expect(agent.readyState).toBe(WebSocket.CLOSED);
  });
});

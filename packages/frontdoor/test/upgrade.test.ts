import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";

import { decodeFrame, encodeFrame } from "../src/frames.ts";
import { startFrontdoor, type RunningFrontdoor } from "../src/server.ts";

let dir: string;
let fd: RunningFrontdoor | undefined;
let agent: WebSocket | undefined;
let client: WebSocket | undefined;
let rawClient: Socket | undefined;

afterEach(async () => {
  client?.terminate();
  rawClient?.destroy();
  agent?.close();
  await fd?.close();
  fd = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const serverTextFrame = (text: string): Buffer => {
  const payload = Buffer.from(text);
  if (payload.length > 125) throw new Error("test frame is too large");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
};

const unmaskClientFrame = (frame: Buffer): string => {
  expect(frame[0]! & 0x0f).toBe(0x02);
  expect(frame[1]! & 0x80).toBe(0x80);
  const length = frame[1]! & 0x7f;
  const mask = frame.subarray(2, 6);
  const payload = frame.subarray(6, 6 + length);
  const unmasked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) unmasked[i] = payload[i]! ^ mask[i % 4]!;
  return unmasked.toString();
};

const rawUpgrade = (port: number): Promise<string> => new Promise((resolve, reject) => {
  const socket = connect({ host: "127.0.0.1", port }, () => {
    socket.write([
      "GET /ts2021 HTTP/1.1",
      "Host: relay-01.cozylabs.ai",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGVzdC1rZXk=",
      "",
      "",
    ].join("\r\n"));
  });
  rawClient = socket;
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("end", () => resolve(Buffer.concat(chunks).toString()));
  socket.on("error", reject);
});

it("passes a websocket upgrade through to the agent and shuttles bytes both ways", async () => {
  dir = mkdtempSync(join(tmpdir(), "fd-up-"));
  fd = await startFrontdoor({
    port: 0, host: "127.0.0.1", dbPath: join(dir, "db.sqlite"),
    pool: ["relay-01.cozylabs.ai"], maxHouseholds: 10, provisionsPerHourPerIp: 100, apiHostnames: [],
  });
  const grant = await (await fetch(`${fd.url}/provision`, { method: "POST", body: "{}" })).json() as { credential: string };

  agent = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(fd!.url.replace("http", "ws") + "/agent", {
      headers: { authorization: `Bearer ${grant.credential}` },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });

  let sawClientData = false;
  const clientBytes = new Promise<Buffer>((resolve, reject) => {
    agent!.on("error", reject);
    agent!.on("message", (raw) => {
      const frame = decodeFrame(String(raw));
      if (frame?.t === "open" && frame.upgrade) {
        const key = frame.headers["sec-websocket-key"]?.[0] ?? "";
        agent!.send(encodeFrame({
          t: "head", sid: frame.sid, status: 101,
          headers: { upgrade: ["websocket"], connection: ["Upgrade"], "sec-websocket-accept": [acceptKey(key)] },
        }));
      } else if (frame?.t === "data" && !sawClientData) {
        sawClientData = true;
        resolve(Buffer.from(frame.b64, "base64"));
        agent!.send(encodeFrame({ t: "data", sid: frame.sid, b64: serverTextFrame("from-agent").toString("base64") }));
      }
    });
  });

  client = new WebSocket(`ws://127.0.0.1:${fd.port}/ts2021`, { headers: { host: "relay-01.cozylabs.ai" } });
  await new Promise<void>((resolve, reject) => {
    client!.on("open", () => resolve());
    client!.on("error", reject);
  });
  const fromAgent = new Promise<Buffer>((resolve) => client!.once("message", (raw) => resolve(Buffer.from(raw as Buffer))));
  client.send(Buffer.from("from-client"));
  expect(unmaskClientFrame(await clientBytes)).toBe("from-client");
  expect((await fromAgent).toString()).toBe("from-agent");
});

it("ends a non-101 upgrade response without sending a second abort", async () => {
  dir = mkdtempSync(join(tmpdir(), "fd-up-error-"));
  fd = await startFrontdoor({
    port: 0, host: "127.0.0.1", dbPath: join(dir, "db.sqlite"),
    pool: ["relay-01.cozylabs.ai"], maxHouseholds: 10, provisionsPerHourPerIp: 100, apiHostnames: [],
  });
  const grant = await (await fetch(`${fd.url}/provision`, { method: "POST", body: "{}" })).json() as { credential: string };
  agent = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(fd!.url.replace("http", "ws") + "/agent", {
      headers: { authorization: `Bearer ${grant.credential}` },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });

  let sawAbort = false;
  agent.on("message", (raw) => {
    const frame = decodeFrame(String(raw));
    if (frame?.t === "abort") sawAbort = true;
    if (frame?.t === "open" && frame.upgrade) {
      agent!.send(encodeFrame({
        t: "head", sid: frame.sid, status: 403,
        headers: { "content-length": ["3"], "x-test": ["complete"] },
      }));
      agent!.send(encodeFrame({ t: "data", sid: frame.sid, b64: Buffer.from("err").toString("base64") }));
      agent!.send(encodeFrame({ t: "end", sid: frame.sid }));
    }
  });

  await expect(rawUpgrade(fd.port)).resolves.toBe(
    "HTTP/1.1 403 \r\ncontent-length: 3\r\nx-test: complete\r\n\r\nerr",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(sawAbort).toBe(false);
});

it("forwards a large non-101 upgrade body despite socket backpressure", async () => {
  dir = mkdtempSync(join(tmpdir(), "fd-up-large-error-"));
  fd = await startFrontdoor({
    port: 0, host: "127.0.0.1", dbPath: join(dir, "db.sqlite"),
    pool: ["relay-01.cozylabs.ai"], maxHouseholds: 10, provisionsPerHourPerIp: 100, apiHostnames: [],
  });
  const grant = await (await fetch(`${fd.url}/provision`, { method: "POST", body: "{}" })).json() as { credential: string };
  agent = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(fd!.url.replace("http", "ws") + "/agent", {
      headers: { authorization: `Bearer ${grant.credential}` },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });

  const body = "x".repeat(256 * 1024);
  agent.on("message", (raw) => {
    const frame = decodeFrame(String(raw));
    if (frame?.t === "open" && frame.upgrade) {
      agent!.send(encodeFrame({
        t: "head", sid: frame.sid, status: 413,
        headers: { "content-length": [String(body.length)] },
      }));
      agent!.send(encodeFrame({ t: "data", sid: frame.sid, b64: Buffer.from(body).toString("base64") }));
      agent!.send(encodeFrame({ t: "end", sid: frame.sid }));
    }
  });

  await expect(rawUpgrade(fd.port)).resolves.toBe(
    `HTTP/1.1 413 \r\ncontent-length: ${body.length}\r\n\r\n${body}`,
  );
});

it("aborts an upgraded stream when the agent sends an open frame", async () => {
  dir = mkdtempSync(join(tmpdir(), "fd-up-invalid-"));
  fd = await startFrontdoor({
    port: 0, host: "127.0.0.1", dbPath: join(dir, "db.sqlite"),
    pool: ["relay-01.cozylabs.ai"], maxHouseholds: 10, provisionsPerHourPerIp: 100, apiHostnames: [],
  });
  const grant = await (await fetch(`${fd.url}/provision`, { method: "POST", body: "{}" })).json() as { credential: string };
  agent = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(fd!.url.replace("http", "ws") + "/agent", {
      headers: { authorization: `Bearer ${grant.credential}` },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });

  const aborted = new Promise<void>((resolve, reject) => {
    agent!.on("message", (raw) => {
      const frame = decodeFrame(String(raw));
      if (frame?.t === "open" && frame.upgrade) {
        agent!.send(encodeFrame({
          t: "open", sid: frame.sid, method: "GET", path: "/wrong-direction", headers: {}, upgrade: true,
        }));
      } else if (frame?.t === "abort") {
        resolve();
      }
    });
    agent!.on("error", reject);
  });

  await expect(rawUpgrade(fd.port)).resolves.toBe("");
  await expect(aborted).resolves.toBeUndefined();
});

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptKey = (key: string) => createHash("sha1").update(key + WS_MAGIC).digest("base64");

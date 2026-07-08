import { createServer, type Server } from "node:http";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { startRelay, type RunningRelay } from "cozygateway-relay";
import { startGateway, type RunningGateway } from "../src/server.ts";

/** Independent decrypt per contract/push-v0.md. */
function decrypt(pushKey: string, wire: string): { threadId: string; agentName: string; preview: string } {
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(pushKey, "utf8"), Buffer.alloc(0), Buffer.from("cozygateway-push-v0", "utf8"), 32),
  );
  const raw = Buffer.from(wire, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as { threadId: string; agentName: string; preview: string };
}

const PUSH_KEY = "e2e-push-key";

let gateway: RunningGateway;
let relay: RunningRelay;
let receiver: Server;
let receiverUrl: string;
let received: string[];
let receivedResolvers: Array<(ciphertext: string) => void>;
const sockets: WebSocket[] = [];

function nextDelivery(): Promise<string> {
  return new Promise((resolve) => {
    if (received.length > 0) {
      resolve(received.shift() ?? "");
      return;
    }
    receivedResolvers.push(resolve);
  });
}

beforeEach(async () => {
  received = [];
  receivedResolvers = [];
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ciphertext: string };
      const resolver = receivedResolvers.shift();
      if (resolver !== undefined) resolver(body.ciphertext);
      else received.push(body.ciphertext);
      res.writeHead(200).end();
    });
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const addr = receiver.address();
  if (addr === null || typeof addr !== "object") throw new Error("no receiver address");
  receiverUrl = `http://127.0.0.1:${addr.port}/push`;

  relay = await startRelay({
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    dailyCap: 500,
    maxRegistrations: 10000,
    restrictEgress: false,
  });
  gateway = await startGateway({
    name: "push-e2e",
    port: 0,
    dbPath: ":memory:",
    agents: [{ id: "echo", name: "Echo", backend: "mock" }],
  });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
  await gateway.close();
  await relay.close();
  await new Promise<void>((resolve, reject) => receiver.close((err) => (err ? reject(err) : resolve())));
});

async function pairDevice(): Promise<string> {
  const code = gateway.issueSetupCode();
  const res = await fetch(`${gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "e2e phone" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { deviceToken: string };
  return body.deviceToken;
}

async function registerForPush(deviceToken: string): Promise<void> {
  const reg = await fetch(`${relay.url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "webhook", token: receiverUrl }),
  });
  expect(reg.status).toBe(201);
  const { pushId } = (await reg.json()) as { pushId: string };
  const res = await fetch(`${gateway.url}/push/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ pushId, relayUrl: relay.url, pushKey: PUSH_KEY }),
  });
  expect(res.status).toBe(200);
}

async function createThread(deviceToken: string): Promise<string> {
  const res = await fetch(`${gateway.url}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ agentId: "echo", title: "e2e" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function sendMessage(deviceToken: string, threadId: string, text: string): Promise<void> {
  const res = await fetch(`${gateway.url}/threads/${threadId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ blocks: [{ type: "paragraph", text }] }),
  });
  expect(res.status).toBe(200);
}

describe("push e2e: gateway -> relay -> webhook", () => {
  it("delivers a decryptable push when no client is connected", async () => {
    const deviceToken = await pairDevice();
    await registerForPush(deviceToken);
    const threadId = await createThread(deviceToken);
    const delivery = nextDelivery();
    await sendMessage(deviceToken, threadId, "ping from e2e");
    const ciphertext = await delivery;
    const payload = decrypt(PUSH_KEY, ciphertext);
    expect(payload.threadId).toBe(threadId);
    expect(payload.agentName).toBe("Echo");
    expect(payload.preview.length).toBeGreaterThan(0);
  });

  it("does not push while a client is connected", async () => {
    const deviceToken = await pairDevice();
    await registerForPush(deviceToken);
    const threadId = await createThread(deviceToken);

    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    sockets.push(ws);
    await once(ws, "open");
    const frames: ServerFrame[] = [];
    ws.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString()) as ServerFrame));
    ws.send(JSON.stringify({ type: "auth", token: deviceToken }));
    // The gateway only counts this socket as a connected client once the hub has
    // processed the auth frame and answered "ready" (see ws-hub.test.ts). The push
    // gate (turns.ts) checks hasClients() at commit time, so we must not send the
    // message until the hub has actually registered this client, or the check can
    // race the auth handshake and the test would pass for the wrong reason.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for ready")), 2_000);
      const check = (): void => {
        if (frames.some((f) => f.type === "ready")) {
          clearTimeout(timer);
          resolve();
        }
      };
      check();
      ws.on("message", check);
    });
    ws.send(JSON.stringify({ type: "sync", threads: {} }));
    // Wait for the agent turn to finish: collect frames until "done" for our thread.
    const doneSeen = new Promise<void>((resolve) => {
      ws.on("message", (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as { type: string; threadId?: string };
        if (frame.type === "done" && frame.threadId === threadId) resolve();
      });
    });
    await sendMessage(deviceToken, threadId, "ping while connected");
    await doneSeen;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toHaveLength(0);
  });
});

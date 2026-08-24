import { createDecipheriv, hkdfSync } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { startRelay, type RunningRelay } from "cozygateway-relay";
import { startGateway, type RunningGateway } from "../src/server.ts";

const PUSH_KEY = "e2e-push-key";
const ATTACH_TOKEN = "push-attach-secret";
let gateway: RunningGateway;
let relay: RunningRelay;
let receiver: Server;
let receiverUrl: string;
let plugin: WebSocket;
let received: string[];
let resolveDelivery: ((ciphertext: string) => void) | undefined;

function decrypt(wire: string): { threadId: string; agentName: string; preview: string } {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(PUSH_KEY), Buffer.alloc(0), Buffer.from("cozygateway-push-v0"), 32));
  const raw = Buffer.from(wire, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8")) as {
    threadId: string; agentName: string; preview: string;
  };
}

function nextDelivery(): Promise<string> {
  return new Promise((resolve) => {
    const next = received.shift();
    if (next !== undefined) resolve(next);
    else resolveDelivery = resolve;
  });
}

async function until(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  received = [];
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const { ciphertext } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ciphertext: string };
      const resolve = resolveDelivery;
      resolveDelivery = undefined;
      if (resolve !== undefined) resolve(ciphertext);
      else received.push(ciphertext);
      response.writeHead(200).end();
    });
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  const address = receiver.address();
  if (address === null || typeof address !== "object") throw new Error("receiver did not bind");
  receiverUrl = `http://127.0.0.1:${address.port}/push`;
  relay = await startRelay({ port: 0, host: "127.0.0.1", dbPath: ":memory:", dailyCap: 500, maxRegistrations: 10_000, restrictEgress: false });
  process.env.PUSH_E2E_CONTROL_TOKEN = "control-secret";
  process.env.PUSH_E2E_ATTACH_TOKEN = ATTACH_TOKEN;
  gateway = await startGateway({
    name: "push-e2e", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
    hermes: {
      url: "ws://127.0.0.1:1/api/ws", tokenEnv: "PUSH_E2E_CONTROL_TOKEN",
      profiles: { echo: { tokenEnv: "PUSH_E2E_ATTACH_TOKEN", name: "Echo" } },
    },
  });
  plugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: `Bearer ${ATTACH_TOKEN}` } });
  await once(plugin, "open");
  plugin.on("message", (data) => {
    const frame = JSON.parse(String(data)) as { kind: string; sequence?: number; commandId?: string; command?: { kind: string; threadId: string; turnId: string; messageId: string; text: string } };
    if (frame.kind !== "command" || frame.command?.kind !== "turn" || frame.sequence === undefined || frame.commandId === undefined) return;
    plugin.send(JSON.stringify({ kind: "ack", channel: "command", sequence: frame.sequence, id: frame.commandId }));
    plugin.send(JSON.stringify({ kind: "event", sequence: frame.sequence, eventId: `commit:${frame.command.turnId}`, event: {
      kind: "commit", threadId: frame.command.threadId, turnId: frame.command.turnId,
      messageId: `answer:${frame.command.messageId}`, blocks: [{ type: "paragraph", text: `Echo: ${frame.command.text}` }],
    } }));
  });
  plugin.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "push-e2e", capabilities: ["draft"], resume: { eventSequence: 0, commandSequence: 0 } }));
});

afterEach(async () => {
  if (plugin.readyState === WebSocket.OPEN || plugin.readyState === WebSocket.CONNECTING) plugin.close();
  await gateway.close();
  await relay.close();
  await new Promise<void>((resolve, reject) => receiver.close((error) => error ? reject(error) : resolve()));
  delete process.env.PUSH_E2E_CONTROL_TOKEN;
  delete process.env.PUSH_E2E_ATTACH_TOKEN;
});

async function pair(): Promise<string> {
  const response = await fetch(`${gateway.url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }) });
  return ((await response.json()) as { deviceToken: string }).deviceToken;
}

async function register(deviceToken: string): Promise<void> {
  const relayResponse = await fetch(`${relay.url}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform: "webhook", token: receiverUrl }) });
  const { pushId } = (await relayResponse.json()) as { pushId: string };
  const response = await fetch(`${gateway.url}/push/register`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` }, body: JSON.stringify({ pushId, relayUrl: relay.url, pushKey: PUSH_KEY }) });
  expect(response.status).toBe(200);
}

async function thread(deviceToken: string): Promise<string> {
  const response = await fetch(`${gateway.url}/threads`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` }, body: JSON.stringify({ agentId: "echo", title: "e2e" }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

async function send(deviceToken: string, threadId: string): Promise<void> {
  const response = await fetch(`${gateway.url}/threads/${threadId}/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` }, body: JSON.stringify({ blocks: [{ type: "paragraph", text: "ping" }] }) });
  expect(response.status).toBe(200);
}

describe("push e2e over attach-v1", () => {
  it("delivers a decryptable push when no app client is connected", async () => {
    const token = await pair();
    await register(token);
    const threadId = await thread(token);
    const delivery = nextDelivery();
    await send(token, threadId);
    const payload = decrypt(await delivery);
    expect(payload).toMatchObject({ threadId, agentName: "Echo", preview: "Echo: ping" });
  });

  it("does not push when the paired app client is connected", async () => {
    const token = await pair();
    await register(token);
    const threadId = await thread(token);
    const client = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    const frames: ServerFrame[] = [];
    client.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    await once(client, "open");
    client.send(JSON.stringify({ type: "auth", token }));
    await until(() => frames.some((frame) => frame.type === "ready"));
    await send(token, threadId);
    await until(() => frames.some((frame) => frame.type === "done" && frame.threadId === threadId));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toEqual([]);
    client.close();
  });
});

import { once } from "node:events";
import { createConnection } from "node:net";

import { WebSocket, type ClientOptions } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { PHONE_AUTH_TIMEOUT_MS, PHONE_SOCKET_LIFETIME_MS } from "../src/phone-verification.ts";
import { testHermes } from "./support/test-config.ts";

let gateway: RunningGateway;

beforeEach(async () => {
  process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret";
  process.env.TEST_ATTACH_TOKEN = "attach-secret";
  gateway = await startGateway({ name: "phone-ws", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() });
});
afterEach(async () => {
  await gateway.close();
  delete process.env.TEST_HERMES_CONTROL_TOKEN;
  delete process.env.TEST_ATTACH_TOKEN;
});

const rejection = (url: string, options?: ClientOptions) => new Promise<number>((resolve) => {
  const ws = new WebSocket(url, options);
  ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
  ws.once("error", () => resolve(0));
});

describe("phone verification WebSocket", () => {
  it("bounds incomplete upgrade headers from the moment Gateway accepts the connection", async () => {
    await gateway.close();
    gateway = await startGateway(
      { name: "phone-pre-upgrade", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() },
      { preUpgradeTimeoutMs: 35 },
    );
    const socket = createConnection({ host: "127.0.0.1", port: gateway.port });
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write("GET /cozy/onboarding/incomplete/probe HTTP/1.1\r\nHost: 127.0.0.1");

    await new Promise<void>((resolve) => socket.once("close", () => resolve()));

    expect(socket.destroyed).toBe(true);
  });

  it("enforces the five-second first-frame and sixty-second total-lifetime timers", async () => {
    expect(PHONE_AUTH_TIMEOUT_MS).toBe(5_000);
    expect(PHONE_SOCKET_LIFETIME_MS).toBe(60_000);
    await gateway.close();
    gateway = await startGateway(
      { name: "phone-timers", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() },
      { phoneVerification: { authTimeoutMs: 25, socketLifetimeMs: 70 } },
    );
    const first = gateway.beginPhoneVerification();
    const idle = new WebSocket(`${first.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
    await once(idle, "open");
    await once(idle, "close");

    await gateway.close();
    gateway = await startGateway(
      { name: "phone-lifetime", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() },
      { phoneVerification: { authTimeoutMs: 25, socketLifetimeMs: 70 } },
    );
    const second = gateway.beginPhoneVerification();
    const live = new WebSocket(`${second.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
    await once(live, "open");
    const received: string[] = [];
    live.on("message", (data) => received.push(String(data)));
    const closed = once(live, "close");
    live.send('{"type":"cozy_onboarding_probe"}');
    await closed;
    expect(received).toEqual(['{"type":"cozy_onboarding_probe"}']);
  });

  it("shares one cumulative deadline between slow upgrade headers and the first auth frame", async () => {
    await gateway.close();
    const budgetMs = 240;
    gateway = await startGateway(
      { name: "phone-cumulative-auth", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() },
      { preUpgradeTimeoutMs: budgetMs, phoneVerification: { authTimeoutMs: budgetMs } },
    );
    const challenge = gateway.beginPhoneVerification();
    const path = `${new URL(challenge.verificationUrl).pathname}/probe`;
    const authority = `127.0.0.1:${gateway.port}`;
    const socket = createConnection({ host: "127.0.0.1", port: gateway.port });
    socket.on("error", () => {});
    let response = "";
    socket.on("data", (chunk) => { response += String(chunk); });
    await once(socket, "connect");
    const startedAt = Date.now();
    socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: ${authority}`,
      `Origin: ${gateway.url}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "",
    ].join("\r\n"));
    await new Promise<void>((resolve) => setTimeout(resolve, 160));
    socket.write("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");

    await once(socket, "close");

    expect(response).toContain("101 Switching Protocols");
    expect(Date.now() - startedAt).toBeLessThan(330);
  });

  it("terminates a socket that sends an actual second client frame", async () => {
    const challenge = gateway.beginPhoneVerification();
    const ws = new WebSocket(`${challenge.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
    await once(ws, "open");
    const closed = once(ws, "close");
    ws.send('{"type":"cozy_onboarding_probe"}');
    ws.send('{"type":"cozy_onboarding_probe"}');
    await closed;
  });

  it("accepts only the canonical closed-schema frame and rejects a noncanonical 256-byte frame", async () => {
    const challenge = gateway.beginPhoneVerification();
    const base = JSON.stringify({ type: "cozy_onboarding_probe", padding: "" });
    const exact = JSON.stringify({ type: "cozy_onboarding_probe", padding: "x".repeat(256 - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(exact)).toBe(256);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${challenge.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
      ws.on("open", () => ws.send(exact));
      ws.on("message", () => reject(new Error("noncanonical frame was echoed")));
      ws.on("close", () => resolve());
      ws.on("error", reject);
      setTimeout(() => reject(new Error("noncanonical frame was not rejected")), 2_000).unref?.();
    });
  });

  it("requires exact same-origin authority and echoes one challenge before confirmation", async () => {
    const challenge = gateway.beginPhoneVerification();
    expect(await rejection(`${challenge.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: `${gateway.url}.evil` })).toBe(404);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${challenge.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
      const frame = '{"type":"cozy_onboarding_probe"}';
      ws.on("open", () => ws.send(frame));
      ws.on("message", (data) => {
        expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(256);
        expect(String(data)).toBe(frame);
        ws.close(); resolve();
      });
      ws.on("error", reject);
    });

    const confirmed = await fetch(`${challenge.verificationUrl}/confirm`, {
      method: "POST",
      headers: { origin: gateway.url, "content-type": "application/json" },
      body: '{"type":"confirm"}',
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ phrase: challenge.phrase });
    expect((await fetch(challenge.verificationUrl)).status).toBe(404);
  });

  it("rejects missing origin, oversized frames, a second frame, and a fifth global socket", async () => {
    const missing = gateway.beginPhoneVerification();
    expect(await rejection(`${missing.verificationUrl.replace(/^http/, "ws")}/probe`)).toBe(404);
    await gateway.close();
    gateway = await startGateway({ name: "phone-ws", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() });

    const challenge = gateway.beginPhoneVerification();
    await new Promise<void>((resolve, reject) => {
      const oversized = new WebSocket(`${challenge.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
      oversized.on("open", () => oversized.send("x".repeat(257)));
      oversized.on("close", () => resolve());
      oversized.on("error", () => {});
      setTimeout(() => reject(new Error("oversized probe was not closed")), 2_000).unref?.();
    });
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 4; index += 1) {
      const ws = new WebSocket(`${challenge.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
      await once(ws, "open");
      sockets.push(ws);
    }
    expect(await rejection(`${challenge.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url })).toBe(404);
    for (const ws of sockets) ws.close();
  });
});

import { once } from "node:events";

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

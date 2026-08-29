import { once } from "node:events";

import { WebSocket, type ClientOptions } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startGateway, type RunningGateway } from "../src/server.ts";
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
  it("requires exact same-origin authority and echoes one challenge before confirmation", async () => {
    const challenge = gateway.beginPhoneVerification();
    expect(await rejection(`${challenge.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: `${gateway.url}.evil` })).toBe(404);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${challenge.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
      const frame = '{"type":"cozy_onboarding_probe"}';
      ws.on("open", () => ws.send(frame));
      ws.on("message", (data) => {
        expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(256);
        expect(String(data)).toBe(frame); ws.close(); resolve();
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

    const challenges = Array.from({ length: 5 }, () => gateway.beginPhoneVerification());
    await new Promise<void>((resolve, reject) => {
      const oversized = new WebSocket(`${challenges[0]!.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
      oversized.on("open", () => oversized.send("x".repeat(257)));
      oversized.on("close", () => resolve());
      oversized.on("error", () => {});
      setTimeout(() => reject(new Error("oversized probe was not closed")), 2_000).unref?.();
    });
    const sockets: WebSocket[] = [];
    for (const challenge of challenges.slice(0, 4)) {
      const ws = new WebSocket(`${challenge.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
      await once(ws, "open");
      sockets.push(ws);
    }
    expect(await rejection(`${challenges[4]!.verificationUrl.replace(/^http/, "ws")}/probe`, { origin: gateway.url })).toBe(404);
    for (const ws of sockets) ws.close();
  });
});

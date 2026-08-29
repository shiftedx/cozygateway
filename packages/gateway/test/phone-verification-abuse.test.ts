import { request } from "node:http";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { testHermes } from "./support/test-config.ts";

let gateway: RunningGateway;
beforeEach(async () => {
  process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret";
  process.env.TEST_ATTACH_TOKEN = "attach-secret";
  gateway = await startGateway({ name: "phone-abuse", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() });
});
afterEach(async () => {
  await gateway.close();
  delete process.env.TEST_HERMES_CONTROL_TOKEN;
  delete process.env.TEST_ATTACH_TOKEN;
});

async function probe(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/probe`, { origin: gateway.url });
    const frame = '{"type":"cozy_onboarding_probe"}';
    ws.on("open", () => ws.send(frame));
    ws.on("message", (data) => {
      ws.close(); resolve();
    });
    ws.on("error", reject);
  });
}

function rawPost(path: string, body: string, contentLength?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: gateway.port, path, method: "POST", headers: {
      origin: gateway.url, "content-type": "application/json",
      ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
    } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject);
    req.end(body);
  });
}

describe("phone verification abuse bounds", () => {
  it("rejects declared and chunked 257-byte confirmation bodies without advancing", async () => {
    const declared = gateway.beginPhoneVerification();
    await probe(declared.verificationUrl);
    expect(await rawPost(new URL(`${declared.verificationUrl}/confirm`).pathname, "x".repeat(257), 257)).toBe(404);

    expect(await rawPost(new URL(`${declared.verificationUrl}/confirm`).pathname, "x".repeat(257))).toBe(404);
  });

  it("returns the same redacted 404 for malformed, unknown, replayed, and wrong-authority capabilities", async () => {
    const challenge = gateway.beginPhoneVerification();
    const malformed = `${gateway.url}/cozy/onboarding/not-a-capability`;
    const unknown = `${gateway.url}/cozy/onboarding/${"A".repeat(43)}`;
    for (const url of [malformed, unknown]) {
      const response = await fetch(url);
      expect({ status: response.status, body: await response.text() }).toEqual({ status: 404, body: "Not Found" });
    }
    expect(await rawPost(new URL(`${challenge.verificationUrl}/confirm`).pathname, '{"type":"confirm"}')).toBe(404);
  });

  it("admits at most five confirmation attempts per challenge per minute", async () => {
    const challenge = gateway.beginPhoneVerification();
    await probe(challenge.verificationUrl);
    const path = new URL(`${challenge.verificationUrl}/confirm`).pathname;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await rawPost(path, "{}"), `attempt ${attempt + 1}`).toBe(404);
    }
    expect(await rawPost(path, '{"type":"confirm"}')).toBe(404);
  });
});

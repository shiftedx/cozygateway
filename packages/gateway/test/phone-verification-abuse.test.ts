import { request } from "node:http";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
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

async function probe(url: string, origin = gateway.url): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/probe`, { origin });
    const frame = '{"type":"cozy_onboarding_probe"}';
    ws.on("open", () => ws.send(frame));
    ws.on("message", () => {
      ws.close(); resolve();
    });
    ws.on("error", reject);
  });
}

function rawPost(path: string, body: string, contentLength?: number, target = gateway): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: target.port, path, method: "POST", headers: {
      origin: target.url, "content-type": "application/json",
      ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
    } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject);
    req.end(body);
  });
}

function rawHttp(lines: string[], target = gateway): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(target.port, "127.0.0.1");
    let response = "";
    socket.on("connect", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`));
    socket.on("data", (chunk) => { response += String(chunk); });
    socket.on("end", () => resolve(Number(response.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0)));
    socket.on("error", reject);
  });
}

describe("phone verification abuse bounds", () => {
  it("does not key live challenge state by the raw capability", () => {
    const source = readFileSync(new URL("../src/phone-verification.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/#records\.set\(capability|#records\.get\(capability/);
  });
  it("rejects missing, duplicate, and trailing-dot Host and Origin authorities", async () => {
    const challenge = gateway.beginPhoneVerification();
    const path = new URL(challenge.verificationUrl).pathname;
    const authority = `127.0.0.1:${gateway.port}`;
    for (const hostLines of [
      ["Host:"],
      [`Host: ${authority}`, `Host: ${authority}`],
      [`Host: 127.0.0.1.:${gateway.port}`],
    ]) expect([400, 404]).toContain(await rawHttp([`GET ${path} HTTP/1.1`, ...hostLines, "Connection: close"]));

    await probe(challenge.verificationUrl);
    const confirm = `${path}/confirm`;
    const body = '{"type":"confirm"}';
    for (const originLines of [
      [] as string[],
      [`Origin: ${gateway.url}`, `Origin: ${gateway.url}`],
      [`Origin: http://127.0.0.1.:${gateway.port}`],
    ]) expect(await rawHttp([
      `POST ${confirm} HTTP/1.1`, `Host: ${authority}`, ...originLines,
      "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close", "", body,
    ])).toBe(404);
  });
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
    await probe(challenge.verificationUrl);
    const path = new URL(`${challenge.verificationUrl}/confirm`).pathname;
    expect(await rawPost(path, '{"type":"confirm"}')).toBe(200);
    expect(await rawPost(path, '{"type":"confirm"}')).toBe(404);
  });

  it("expires an old capability and atomically replaces it during the same boot", async () => {
    let wall = 10_000;
    let monotonic = 10_000;
    await gateway.close();
    gateway = await startGateway(
      { name: "phone-expiry", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() },
      { phoneVerification: { now: () => wall, monotonicNow: () => monotonic } },
    );
    const expired = gateway.beginPhoneVerification();
    // A monotonic deadline remains authoritative when wall time stalls or moves backward.
    wall -= 1;
    monotonic += 600_001;
    expect((await fetch(expired.verificationUrl)).status).toBe(404);
    const replacement = gateway.beginPhoneVerification();
    expect(replacement.sessionId).not.toBe(expired.sessionId);
    expect((await fetch(replacement.verificationUrl)).status).toBe(200);
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

  it("attributes the five-attempt bucket per challenge, not across challenges", async () => {
    const future = Date.now() + 120_000;
    await gateway.close();
    gateway = await startGateway({ name: "phone-abuse-a", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() }, { phoneVerification: { now: () => future } });
    const other = await startGateway({ name: "phone-abuse-b", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() }, { phoneVerification: { now: () => future } });
    try {
      const first = gateway.beginPhoneVerification();
      await probe(first.verificationUrl);
      const firstPath = new URL(`${first.verificationUrl}/confirm`).pathname;
      for (let attempt = 0; attempt < 5; attempt += 1) expect(await rawPost(firstPath, "{}"), `first ${attempt}`).toBe(404);
      const second = other.beginPhoneVerification();
      await probe(second.verificationUrl, other.url);
      expect(await rawPost(new URL(`${second.verificationUrl}/confirm`).pathname, '{"type":"confirm"}', undefined, other)).toBe(200);
    } finally { await other.close(); }
  });

  it("enforces the process-global sixty-attempt ceiling across gateway instances", async () => {
    const future = Date.now() + 240_000;
    await gateway.close();
    const gateways: RunningGateway[] = [];
    try {
      for (let index = 0; index < 13; index += 1) gateways.push(await startGateway(
        { name: `phone-global-${index}`, port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() },
        { phoneVerification: { now: () => future } },
      ));
      for (const target of gateways.slice(0, 12)) {
        const challenge = target.beginPhoneVerification();
        await probe(challenge.verificationUrl, target.url);
        const path = new URL(`${challenge.verificationUrl}/confirm`).pathname;
        for (let attempt = 0; attempt < 5; attempt += 1) expect(await rawPost(path, "{}", undefined, target)).toBe(404);
      }
      const final = gateways[12]!;
      const challenge = final.beginPhoneVerification();
      await probe(challenge.verificationUrl, final.url);
      expect(await rawPost(new URL(`${challenge.verificationUrl}/confirm`).pathname, '{"type":"confirm"}', undefined, final)).toBe(404);
    } finally {
      await Promise.all(gateways.map((target) => target.close()));
      gateway = await startGateway({ name: "phone-abuse", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes() });
    }
  });
});

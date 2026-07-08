import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DAILY_CAP, DEFAULT_MAX_REGISTRATIONS, RELAY_VERSION, startRelay, type RunningRelay } from "../src/server.ts";

let relay: RunningRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe("startRelay", () => {
  it("serves the app over real HTTP on an ephemeral port", async () => {
    relay = await startRelay({
      port: 0,
      host: "127.0.0.1",
      dbPath: ":memory:",
      dailyCap: DEFAULT_DAILY_CAP,
      maxRegistrations: DEFAULT_MAX_REGISTRATIONS,
      restrictEgress: false,
    });
    expect(relay.url).toBe(`http://127.0.0.1:${relay.port}`);
    const health = await fetch(`${relay.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ name: "cozygateway-relay", version: RELAY_VERSION });
    const res = await fetch(`${relay.url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "webhook", token: "https://x.example/hook" }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects a literal private-address webhook registration when restrictEgress is on", async () => {
    relay = await startRelay({
      port: 0,
      host: "0.0.0.0",
      dbPath: ":memory:",
      dailyCap: DEFAULT_DAILY_CAP,
      maxRegistrations: DEFAULT_MAX_REGISTRATIONS,
      restrictEgress: true,
    });
    const res = await fetch(`${relay.url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "webhook", token: "http://169.254.169.254/hook" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("refuses registration over the wired maxRegistrations cap", async () => {
    relay = await startRelay({
      port: 0,
      host: "127.0.0.1",
      dbPath: ":memory:",
      dailyCap: DEFAULT_DAILY_CAP,
      maxRegistrations: 1,
      restrictEgress: false,
    });
    const registerOnce = () =>
      fetch(`${relay?.url}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "webhook", token: "https://x.example/hook" }),
      });
    expect((await registerOnce()).status).toBe(201);
    const res = await registerOnce();
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("over_cap");
  });

  it("close() is idempotent and always releases storage", async () => {
    relay = await startRelay({
      port: 0,
      host: "127.0.0.1",
      dbPath: ":memory:",
      dailyCap: DEFAULT_DAILY_CAP,
      maxRegistrations: DEFAULT_MAX_REGISTRATIONS,
      restrictEgress: false,
    });
    await relay.close();
    await relay.close(); // second close: no-op, must not throw
    expect(() => relay?.storage.registrationByPushId("x")).toThrow(); // sqlite handle really closed
    relay = undefined;
  });
});

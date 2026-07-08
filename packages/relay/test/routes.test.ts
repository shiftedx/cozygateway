import { afterEach, describe, expect, it } from "vitest";

import { createRelayApp } from "../src/http.ts";
import { openRelayStorage, type RelayStorage } from "../src/storage.ts";
import type { Transport } from "../src/transports.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Delivery {
  token: string;
  ciphertext: string;
}

function harness(overrides?: {
  dailyCap?: number;
  failDelivery?: boolean;
  nowRef?: { value: number };
  restrictEgress?: boolean;
  maxRegistrations?: number;
}): { app: ReturnType<typeof createRelayApp>; storage: RelayStorage; deliveries: Delivery[] } {
  const storage = openRelayStorage(":memory:");
  cleanups.push(() => storage.close());
  const deliveries: Delivery[] = [];
  const transport: Transport = {
    deliver: async (token, ciphertext) => {
      if (overrides?.failDelivery === true) throw new Error("delivery boom");
      deliveries.push({ token, ciphertext });
    },
  };
  const nowRef = overrides?.nowRef ?? { value: Date.UTC(2026, 6, 7, 12, 0, 0) };
  const app = createRelayApp({
    storage,
    transports: { webhook: transport },
    dailyCap: overrides?.dailyCap ?? 500,
    maxRegistrations: overrides?.maxRegistrations ?? 10000,
    version: "test",
    now: () => nowRef.value,
    log: () => {},
    restrictEgress: overrides?.restrictEgress ?? false,
  });
  return { app, storage, deliveries };
}

async function register(app: ReturnType<typeof createRelayApp>, body: unknown): Promise<Response> {
  return app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function notify(app: ReturnType<typeof createRelayApp>, body: unknown): Promise<Response> {
  return app.request("/notify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function registeredPushId(app: ReturnType<typeof createRelayApp>): Promise<string> {
  const res = await register(app, { platform: "webhook", token: "https://x.example/hook" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { pushId: string };
  return body.pushId;
}

describe("POST /register", () => {
  it("registers a webhook and mints an unguessable push id", async () => {
    const { app } = harness();
    const first = await registeredPushId(app);
    const second = await registeredPushId(app);
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(21);
  });

  it("rejects a malformed body", async () => {
    const { app } = harness();
    const res = await register(app, { platform: "webhook" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects a webhook token that is not an http(s) URL", async () => {
    const { app } = harness();
    const res = await register(app, { platform: "webhook", token: "ftp://x.example/hook" });
    expect(res.status).toBe(400);
  });

  it("501s the recognized-but-unimplemented apns platform", async () => {
    const { app } = harness();
    const res = await register(app, { platform: "apns", token: "device-token" });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unsupported_platform");
  });

  describe("with restrictEgress on", () => {
    it("rejects a literal loopback webhook URL", async () => {
      const { app } = harness({ restrictEgress: true });
      const res = await register(app, { platform: "webhook", token: "http://127.0.0.1:9999/hook" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_request");
    });

    it("rejects a literal RFC1918 private webhook URL", async () => {
      const { app } = harness({ restrictEgress: true });
      const res = await register(app, { platform: "webhook", token: "http://10.1.2.3/hook" });
      expect(res.status).toBe(400);
    });

    it("rejects a literal link-local webhook URL", async () => {
      const { app } = harness({ restrictEgress: true });
      const res = await register(app, { platform: "webhook", token: "http://169.254.169.254/hook" });
      expect(res.status).toBe(400);
    });

    it("rejects a literal IPv6 loopback webhook URL", async () => {
      const { app } = harness({ restrictEgress: true });
      const res = await register(app, { platform: "webhook", token: "http://[::1]:9999/hook" });
      expect(res.status).toBe(400);
    });

    it("still accepts a public-looking webhook URL (a DNS name is vetted at delivery time)", async () => {
      const { app } = harness({ restrictEgress: true });
      const res = await register(app, { platform: "webhook", token: "https://x.example/hook" });
      expect(res.status).toBe(201);
    });
  });

  describe("with restrictEgress off (default)", () => {
    it("accepts a literal loopback webhook URL unchanged", async () => {
      const { app } = harness({ restrictEgress: false });
      const res = await register(app, { platform: "webhook", token: "http://127.0.0.1:9999/hook" });
      expect(res.status).toBe(201);
    });
  });

  describe("with a low maxRegistrations", () => {
    it("refuses a new registration beyond the cap with a typed 429 envelope", async () => {
      const { app } = harness({ maxRegistrations: 2 });
      expect((await registeredPushId(app)).length).toBeGreaterThan(0);
      expect((await registeredPushId(app)).length).toBeGreaterThan(0);
      const res = await register(app, { platform: "webhook", token: "https://x.example/hook" });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("over_cap");
    });

    it("does not consume the cap on a malformed or rejected request", async () => {
      const { app } = harness({ maxRegistrations: 1 });
      const bad = await register(app, { platform: "smoke-signal", token: "x" });
      expect(bad.status).toBe(400);
      // The cap of 1 is still fully available since the malformed request never got in.
      expect((await register(app, { platform: "webhook", token: "https://x.example/hook" })).status).toBe(201);
    });
  });
});

describe("POST /notify", () => {
  it("delivers ciphertext through the transport and 202s", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "CIPHER" });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries).toEqual([{ token: "https://x.example/hook", ciphertext: "CIPHER" }]);
  });

  it("404s an unknown push id", async () => {
    const { app } = harness();
    const res = await notify(app, { pushId: "nope", ciphertext: "C" });
    expect(res.status).toBe(404);
  });

  it("still 202s and counts when delivery fails", async () => {
    const { app, storage, deliveries } = harness({ failDelivery: true });
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "C" });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries).toHaveLength(0);
    expect(storage.notifyCount(pushId, "2026-07-07")).toBe(1);
  });

  it("enforces the daily cap, which rolls over at midnight UTC", async () => {
    const nowRef = { value: Date.UTC(2026, 6, 7, 12, 0, 0) };
    const { app } = harness({ dailyCap: 2, nowRef });
    const pushId = await registeredPushId(app);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(202);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(202);
    const capped = await notify(app, { pushId, ciphertext: "C" });
    expect(capped.status).toBe(429);
    const cappedBody = (await capped.json()) as { error: { code: string } };
    expect(cappedBody.error.code).toBe("over_cap");
    nowRef.value = Date.UTC(2026, 6, 8, 0, 0, 1);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(202);
  });

  it("rejects oversized ciphertext", async () => {
    const { app } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "x".repeat(8193) });
    expect(res.status).toBe(400);
  });

  it("lazily sweeps notify_counts rows older than the retention window on notify", async () => {
    const nowRef = { value: Date.UTC(2026, 6, 1, 12, 0, 0) };
    const { app, storage } = harness({ nowRef });
    const pushId = await registeredPushId(app);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(202);
    const oldDay = "2026-07-01";
    expect(storage.notifyCount(pushId, oldDay)).toBe(1);

    // Jump forward well past the retention window and notify again; the sweep runs inline.
    nowRef.value = Date.UTC(2026, 6, 20, 0, 0, 0);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(202);
    expect(storage.notifyCount(pushId, oldDay)).toBe(0);
  });
});

describe("DELETE /register/:pushId", () => {
  it("deletes and is idempotent", async () => {
    const { app } = harness();
    const pushId = await registeredPushId(app);
    expect((await app.request(`/register/${pushId}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/register/${pushId}`, { method: "DELETE" })).status).toBe(204);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(404);
  });
});

describe("envelope faults", () => {
  it("404s unknown routes with the error envelope", async () => {
    const { app } = harness();
    const res = await app.request("/bogus");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("serves /health", async () => {
    const { app } = harness();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "cozygateway-relay", version: "test" });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRelayApp } from "../src/http.ts";
import { openRelayStorage, type RelayStorage } from "../src/storage.ts";
import type { PushDeliveryOptions, Transport } from "../src/transports.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Delivery {
  token: string;
  ciphertext: string;
  options?: PushDeliveryOptions;
  transport?: string;
}

function harness(overrides?: {
  dailyCap?: number;
  failDelivery?: boolean;
  nowRef?: { value: number };
  restrictEgress?: boolean;
  maxRegistrations?: number;
  registrationTtlDays?: number;
  trustForwarded?: boolean;
  registerRateLimitPerMinute?: number;
  notifyRateLimitPerMinute?: number;
  sourceIp?: string;
  apnsEnvironments?: boolean;
}): { app: ReturnType<typeof createRelayApp>; storage: RelayStorage; deliveries: Delivery[] } {
  const storage = openRelayStorage(":memory:");
  cleanups.push(() => storage.close());
  const deliveries: Delivery[] = [];
  const transport: Transport = {
    deliver: async (token, ciphertext, options) => {
      if (overrides?.failDelivery === true) throw new Error("delivery boom");
      deliveries.push(options === undefined ? { token, ciphertext } : { token, ciphertext, options });
    },
  };
  const nowRef = overrides?.nowRef ?? { value: Date.UTC(2026, 6, 7, 12, 0, 0) };
  const transports: Record<string, Transport> = { webhook: transport };
  if (overrides?.apnsEnvironments === true) {
    for (const environment of ["development", "production"] as const) {
      transports[`apns:${environment}`] = {
        deliver: async (token, ciphertext, options) => {
          deliveries.push({
            token,
            ciphertext,
            ...(options === undefined ? {} : { options }),
            transport: environment,
          });
        },
      };
    }
  }
  const app = createRelayApp({
    storage,
    transports,
    dailyCap: overrides?.dailyCap ?? 500,
    maxRegistrations: overrides?.maxRegistrations ?? 10000,
    version: "test",
    now: () => nowRef.value,
    log: () => {},
    restrictEgress: overrides?.restrictEgress ?? false,
    registrationTtlDays: overrides?.registrationTtlDays,
    trustForwarded: overrides?.trustForwarded,
    registerRateLimitPerMinute: overrides?.registerRateLimitPerMinute,
    notifyRateLimitPerMinute: overrides?.notifyRateLimitPerMinute,
    sourceIp: () => overrides?.sourceIp ?? "socket-ip",
  });
  return { app, storage, deliveries };
}

async function register(
  app: ReturnType<typeof createRelayApp>,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function notify(
  app: ReturnType<typeof createRelayApp>,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request("/notify", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
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

  it("routes APNs registrations to the environment that issued the token", async () => {
    const { app, storage, deliveries } = harness({ apnsEnvironments: true });
    const registered = await register(app, {
      platform: "apns",
      token: "sandbox-device-token",
      environment: "development",
    });
    expect(registered.status).toBe(201);
    const { pushId } = (await registered.json()) as { pushId: string };
    expect(storage.registrationByPushId(pushId)).toEqual({
      pushId,
      platform: "apns:development",
      token: "sandbox-device-token",
    });

    expect((await notify(app, { pushId, ciphertext: "CIPHER" })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries).toEqual([
      { token: "sandbox-device-token", ciphertext: "CIPHER", transport: "development" },
    ]);
  });

  it("rejects APNs environment metadata on webhook registrations", async () => {
    const { app } = harness();
    const res = await register(app, {
      platform: "webhook",
      token: "https://x.example/hook",
      environment: "development",
    });
    expect(res.status).toBe(400);
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

  describe("per-source rate limiting", () => {
    it("returns 429 with retry-after after the default ten-register burst", async () => {
      const { app } = harness();
      for (let i = 0; i < 10; i += 1) expect((await register(app, {})).status).toBe(400);
      const limited = await register(app, {});
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("6");
    });

    it("uses only the rightmost forwarded hop when explicitly trusted", async () => {
      const { app } = harness({ trustForwarded: true, registerRateLimitPerMinute: 1 });
      const body = { platform: "webhook", token: "https://x.example/hook" };
      expect((await register(app, body, { "x-forwarded-for": "198.51.100.1, 203.0.113.9" })).status).toBe(201);
      expect((await register(app, body, { "x-forwarded-for": "198.51.100.2, 203.0.113.9" })).status).toBe(429);
      expect((await register(app, body, { "x-forwarded-for": "198.51.100.1, 203.0.113.10" })).status).toBe(201);
    });

    it("ignores forwarded values unless trust-forwarded is enabled", async () => {
      const { app } = harness({ registerRateLimitPerMinute: 1, sourceIp: "real-peer" });
      const body = { platform: "webhook", token: "https://x.example/hook" };
      expect((await register(app, body, { "x-forwarded-for": "198.51.100.1" })).status).toBe(201);
      expect((await register(app, body, { "x-forwarded-for": "198.51.100.2" })).status).toBe(429);
    });
  });
});

describe("POST /notify", () => {
  it("requires exactly one of ciphertext and Live Activity state", async () => {
    const { app } = harness();
    const pushId = await registeredPushId(app);
    expect((await notify(app, { pushId })).status).toBe(400);
    expect((await notify(app, { pushId, ciphertext: "C", liveActivity: {
      timestamp: 1, event: "update", priority: 5,
      contentState: { phase: "thinking", toolCallCount: 0, shortStatus: "Thinking", eventSequence: 1 },
    } })).status).toBe(400);
  });

  it("accepts a bounded terminal Live Activity alert and passes it to the transport", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const liveActivity = {
      timestamp: 10, event: "end", priority: 10, dismissalDate: 910,
      alert: { title: "CozyChat", body: "Your bot’s reply is ready", sound: "default" },
      contentState: { phase: "completed", toolCallCount: 1, shortStatus: "Finished", eventSequence: 2 },
    };
    expect((await notify(app, { pushId, liveActivity })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries).toEqual([{
      token: "https://x.example/hook", ciphertext: "", options: { liveActivity },
    }]);
  });

  it("carries the waiting-on-approval phase and its approval id to the transport", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const liveActivity = {
      timestamp: 10, event: "update", priority: 5, staleDate: 1810,
      contentState: {
        phase: "waitingOnApproval", toolCallCount: 1, shortStatus: "Waiting on your approval",
        eventSequence: 3, approvalID: "call-1",
      },
    };
    expect((await notify(app, { pushId, liveActivity })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries).toEqual([{
      token: "https://x.example/hook", ciphertext: "", options: { liveActivity },
    }]);

    // Producer input that lands verbatim in an APNs payload stays bounded.
    expect((await notify(app, { pushId, liveActivity: {
      ...liveActivity,
      contentState: { ...liveActivity.contentState, approvalID: "x".repeat(201) },
    } })).status).toBe(400);
  });

  it("delivers ciphertext through the transport and 202s", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "CIPHER" });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries).toEqual([{ token: "https://x.example/hook", ciphertext: "CIPHER" }]);
  });

  it("returns 202 before a genuinely slow transport's delivery has actually completed", async () => {
    // Unlike the harness's default transport (whose `deliver` resolves synchronously in the
    // same microtask), this transport has a real internal delay via a timer, so a 202 that
    // beats it proves the response is truly detached from delivery, not just from an
    // artificially-async-but-instant stub.
    const DELAY_MS = 40;
    const deliveries: Delivery[] = [];
    const slowStorage = openRelayStorage(":memory:");
    cleanups.push(() => slowStorage.close());
    const slowApp = createRelayApp({
      storage: slowStorage,
      transports: {
        webhook: {
          deliver: (token, ciphertext) =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                deliveries.push({ token, ciphertext });
                resolve();
              }, DELAY_MS);
            }),
        },
      },
      dailyCap: 500,
      maxRegistrations: 10000,
      version: "test",
      now: () => Date.now(),
      log: () => {},
      restrictEgress: false,
    });
    const pushId = await registeredPushId(slowApp);
    const start = Date.now();
    const res = await notify(slowApp, { pushId, ciphertext: "SLOW" });
    expect(res.status).toBe(202);
    // The 202 landed comfortably before the transport's own delay could have elapsed.
    expect(Date.now() - start).toBeLessThan(DELAY_MS);
    expect(deliveries).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS + 40));
    expect(deliveries).toEqual([{ token: "https://x.example/hook", ciphertext: "SLOW" }]);
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
    expect(storage.registrationByPushId(pushId)).toBeDefined();
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

  it("has a separate default sixty-per-minute source bucket", async () => {
    const { app } = harness();
    const pushId = await registeredPushId(app);
    for (let i = 0; i < 60; i += 1) {
      expect((await notify(app, { pushId: "unknown", ciphertext: "C" })).status).toBe(404);
    }
    const limited = await notify(app, { pushId, ciphertext: "C" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
  });
});

describe("GET /health", () => {
  it("reports aggregate registrations and today's notifies without identifiers", async () => {
    const { app } = harness();
    const pushId = await registeredPushId(app);
    expect((await notify(app, { pushId, ciphertext: "C" })).status).toBe(202);
    const res = await app.request("/health");
    expect(await res.json()).toEqual({
      name: "cozygateway-relay",
      version: "test",
      registrations: 1,
      todaysNotifies: 1,
    });
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

describe("registration TTL (issue #28)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("an expired registration 404s on notify", async () => {
    const nowRef = { value: Date.UTC(2026, 6, 7, 12, 0, 0) };
    const { app } = harness({ nowRef });
    const reg = await register(app, { platform: "webhook", token: "https://push.example/hook" });
    expect(reg.status).toBe(201);
    const { pushId } = (await reg.json()) as { pushId: string };
    nowRef.value += 31 * DAY;
    const res = await notify(app, { pushId, ciphertext: "abc" });
    expect(res.status).toBe(404);
  });

  it("a registration inside the TTL still notifies", async () => {
    const nowRef = { value: Date.UTC(2026, 6, 7, 12, 0, 0) };
    const { app } = harness({ nowRef });
    const reg = await register(app, { platform: "webhook", token: "https://push.example/hook" });
    const { pushId } = (await reg.json()) as { pushId: string };
    nowRef.value += 29 * DAY;
    const res = await notify(app, { pushId, ciphertext: "abc" });
    expect(res.status).toBe(202);
  });

  it("expired rows free cap headroom for a new register", async () => {
    const nowRef = { value: Date.UTC(2026, 6, 7, 12, 0, 0) };
    const { app } = harness({ nowRef, maxRegistrations: 1 });
    expect(
      (await register(app, { platform: "webhook", token: "https://push.example/hook" })).status,
    ).toBe(201);
    expect(
      (await register(app, { platform: "webhook", token: "https://push.example/hook" })).status,
    ).toBe(429);
    nowRef.value += 31 * DAY;
    expect(
      (await register(app, { platform: "webhook", token: "https://push.example/hook" })).status,
    ).toBe(201);
  });
});

describe("POST /notify, push categories", () => {
  async function errorCode(res: Response): Promise<string> {
    const body = (await res.json()) as { error: { code: string } };
    return body.error.code;
  }

  it("passes an approval.pending category and its collapse id through to the transport", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, {
      pushId,
      ciphertext: "CIPHER",
      category: "approval.pending",
      collapseId: "toolu_01",
    });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries).toEqual([
      {
        token: "https://x.example/hook",
        ciphertext: "CIPHER",
        options: { category: "approval.pending", collapseId: "toolu_01" },
      },
    ]);
  });

  it("passes the message category and bot-chat collapse id through to the transport", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, {
      pushId,
      ciphertext: "CIPHER",
      category: "message",
      collapseId: "botmsg.abc123",
    });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries[0]?.options).toEqual({ category: "message", collapseId: "botmsg.abc123" });
  });

  it("passes a mobile status wake and its required collapse id through without extra detail", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, {
      pushId,
      ciphertext: "CIPHER",
      category: "mobile.status.wake",
      collapseId: "mobile.status",
    });
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries[0]?.options).toEqual({
      category: "mobile.status.wake",
      collapseId: "mobile.status",
    });
  });

  it("carries approval.resolved on the same collapse id, so a resolve replaces its own pending push", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    await notify(app, { pushId, ciphertext: "P", category: "approval.pending", collapseId: "tc_9" });
    await notify(app, { pushId, ciphertext: "R", category: "approval.resolved", collapseId: "tc_9" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries.map((d) => d.options?.collapseId)).toEqual(["tc_9", "tc_9"]);
    expect(deliveries.map((d) => d.options?.category)).toEqual(["approval.pending", "approval.resolved"]);
  });

  it("still accepts a plain notify with no category (the message push, unchanged)", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    expect((await notify(app, { pushId, ciphertext: "CIPHER" })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deliveries[0]?.options).toBeUndefined();
  });

  it("rejects an unregistered category rather than forwarding it", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "C", category: "approval.granted", collapseId: "t1" });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
    expect(deliveries).toEqual([]);
  });

  it("rejects a category without a collapse id (an uncoalescable approval can never be retracted)", async () => {
    const { app } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "C", category: "approval.pending" });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
  });

  it("rejects a mobile status wake without its collapse id", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "C", category: "mobile.status.wake" });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
    expect(deliveries).toEqual([]);
  });

  it("rejects a collapse id without a category (nothing for the app to coalesce it against)", async () => {
    const { app } = harness();
    const pushId = await registeredPushId(app);
    const res = await notify(app, { pushId, ciphertext: "C", collapseId: "t1" });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
  });

  it("rejects a collapse id that is not an opaque id, so it cannot smuggle an argument value", async () => {
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    for (const collapseId of ["rm -rf /var", "a".repeat(65), 'x"y']) {
      const res = await notify(app, { pushId, ciphertext: "C", category: "approval.pending", collapseId });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_request");
    }
    expect(deliveries).toEqual([]);
  });

  it("REJECTS a notify carrying cleartext approval fields, so a buggy caller cannot leak a raw value", async () => {
    // The redaction rule (issue #19: argSummary is key names and type tags only) is enforced
    // at this boundary by refusing every cleartext payload field outright. Approval metadata
    // rides inside the ciphertext like every other payload field; nothing describing the tool
    // call is accepted in the clear, so there is no field a raw value could arrive in.
    const { app, deliveries } = harness();
    const pushId = await registeredPushId(app);
    const leaky = [
      { argSummary: { command: "rm -rf /" } },
      { name: "shell" },
      { turnId: "t1" },
      { toolCallId: "tc_1" },
      { agentId: "ag_1" },
      { preview: "the raw command" },
    ];
    for (const extra of leaky) {
      const res = await notify(app, {
        pushId,
        ciphertext: "C",
        category: "approval.pending",
        collapseId: "tc_1",
        ...extra,
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_request");
    }
    expect(deliveries).toEqual([]);
  });

  it("counts an approval push against the same per-pushId daily cap", async () => {
    const { app } = harness({ dailyCap: 1 });
    const pushId = await registeredPushId(app);
    expect(
      (await notify(app, { pushId, ciphertext: "C", category: "approval.pending", collapseId: "t1" })).status,
    ).toBe(202);
    const second = await notify(app, {
      pushId,
      ciphertext: "C",
      category: "approval.pending",
      collapseId: "t1",
    });
    expect(second.status).toBe(429);
    expect(await errorCode(second)).toBe("over_cap");
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
    expect(await res.json()).toEqual({
      name: "cozygateway-relay",
      version: "test",
      registrations: 0,
      todaysNotifies: 0,
    });
  });

  it("500s with the internal error envelope when a route handler throws unexpectedly", async () => {
    const { app, storage } = harness();
    const pushId = await registeredPushId(app);
    // Force the documented onError 500 path (contract/push-v0.md) via a storage seam that
    // throws, rather than weakening any production code to make this reachable.
    vi.spyOn(storage, "registrationByPushId").mockImplementation(() => {
      throw new Error("storage exploded");
    });
    const res = await notify(app, { pushId, ciphertext: "C" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal");
  });
});

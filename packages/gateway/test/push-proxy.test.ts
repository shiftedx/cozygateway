import { describe, expect, it } from "vitest";
import type { Message, RichBlock } from "cozygateway-contract";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testHermes } from "./support/test-config.ts";
import { SETUP_CODE_TTL_MS, hashToken, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { gatewayInfoForConfig } from "../src/server.ts";
import { openStorage } from "../src/storage.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface RelayCall {
  method: string;
  url: string;
  body: string;
  authorization: string | null;
}

async function setup(liveActivityPushIds: readonly string[] = ["relay-push-id"]) {
  const calls: RelayCall[] = [];
  let liveActivityRegistration = 0;
  const relayFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      method: request.method,
      url: request.url,
      body: await request.text(),
      authorization: request.headers.get("authorization"),
    });
    return request.method === "DELETE"
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({
          pushId: liveActivityPushIds[liveActivityRegistration++] ?? "relay-push-id",
        }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
  };
  const config: GatewayConfig = {
    name: "push-proxy-test",
    port: 8787,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    hermes: testHermes(),
    pushRelayUrl: "http://relay.internal:8788/",
  };
  const storage = openStorage(":memory:");
  const app = createApp({
    storage,
    config,
    pushRelayFetch: relayFetch,
    gatewayInfo: gatewayInfoForConfig(config),
    presenceOf: () => "online",
    submitUserMessage: (_threadId: string, _blocks: RichBlock[]): Message => {
      throw new Error("not used");
    },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const setupCode = newSetupCode();
  storage.createSetupCode(setupCode, 1_000 + SETUP_CODE_TTL_MS);
  const pairResponse = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode, deviceName: "proxy test phone" }),
  });
  const deviceToken = ((await pairResponse.json()) as { deviceToken: string }).deviceToken;
  const authed = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
    });
  return { app, authed, calls, storage };
}

describe("authenticated push relay proxy", () => {
  it("round-trips relay registration bodies and statuses", async () => {
    const { authed, calls } = await setup();
    const body = '{"platform":"apns","token":"device-token","environment":"development"}';

    const response = await authed("/push/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"pushId":"relay-push-id"}');
    expect(calls).toEqual([
      {
        method: "POST",
        url: "http://relay.internal:8788/register",
        body,
        authorization: null,
      },
    ]);
  });

  it("rejects a missing device token before the relay is touched", async () => {
    const { app, calls } = await setup();

    const response = await app.request("/push/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"platform":"apns","token":"device-token"}',
    });

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("passes relay registration deletion through unchanged", async () => {
    const { authed, calls } = await setup();

    const response = await authed("/push/register/relay-push-id", { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(calls).toEqual([
      {
        method: "DELETE",
        url: "http://relay.internal:8788/register/relay-push-id",
        body: "",
        authorization: null,
      },
    ]);
  });

  it("never proxies notify", async () => {
    const { authed, calls } = await setup();

    const response = await authed("/push/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"pushId":"p1","ciphertext":"opaque"}',
    });

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("registers and removes a device-scoped Live Activity token through the relay", async () => {
    const { authed, calls } = await setup();
    const response = await authed("/push/live-activities/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityId: "activity-1", runId: "run-1",
        conversationId: "gateway-1", bot: "sage", token: "aa".repeat(32), environment: "development" }),
    });
    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://relay.internal:8788/register" });
    expect(JSON.parse(calls[0]!.body)).toEqual({
      platform: "apns-liveactivity", token: "aa".repeat(32), environment: "development",
    });

    expect((await authed("/push/live-activities/activity-1", { method: "DELETE" })).status).toBe(204);
    expect(calls[1]).toMatchObject({
      method: "DELETE", url: "http://relay.internal:8788/register/relay-push-id",
    });
  });

  it("retires a superseded Live Activity registration for the same device conversation", async () => {
    const { authed, calls, storage } = await setup(["stale-push-id", "current-push-id"]);
    const register = (activityId: string, runId: string) => authed("/push/live-activities/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityId, runId, conversationId: "gateway-1", bot: "sage",
        token: "aa".repeat(32), environment: "development" }),
    });

    expect((await register("stale-activity", "run-1")).status).toBe(200);
    expect((await register("current-activity", "run-2")).status).toBe(200);

    expect.soft(storage.liveActivityRegistrations("sage")).toMatchObject([
      { activityId: "current-activity", pushId: "current-push-id" },
    ]);
    expect.soft(calls.filter((call) => call.method === "DELETE")).toMatchObject([
      { url: "http://relay.internal:8788/register/stale-push-id" },
    ]);
  });

  it("keeps a failed relay deletion durable across reopen and retries it at app construction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-live-activity-outbox-"));
    const path = join(directory, "gateway.sqlite");
    const storage = openStorage(path);
    storage.createDevice({ id: "device", name: "phone", tokenHash: "hash", createdAt: 1 });
    storage.saveLiveActivityRegistration({ deviceId: "device", activityId: "stale", runId: "run-1",
      conversationId: "gateway-1", bot: "sage", pushId: "stale-push-id", createdAt: 1 });
    storage.saveLiveActivityRegistration({ deviceId: "device", activityId: "current", runId: "run-2",
      conversationId: "gateway-1", bot: "sage", pushId: "current-push-id", createdAt: 2 });
    storage.createDevice({ id: "device-2", name: "tablet", tokenHash: "hash-2", createdAt: 1 });
    storage.saveLiveActivityRegistration({ deviceId: "device-2", activityId: "stale-2", runId: "run-1",
      conversationId: "gateway-2", bot: "sage", pushId: "stale-push-id-2", createdAt: 3 });
    storage.saveLiveActivityRegistration({ deviceId: "device-2", activityId: "current-2", runId: "run-2",
      conversationId: "gateway-2", bot: "sage", pushId: "current-push-id-2", createdAt: 4 });
    const failedCalls: RelayCall[] = [];
    const logs: string[] = [];
    const config: GatewayConfig = { name: "retry", port: 8787, dbPath: path, turnTimeoutSeconds: 0,
      hermes: testHermes(), pushRelayUrl: "http://relay.internal:8788/" };
    createApp({
      storage, config, gatewayInfo: gatewayInfoForConfig(config),
      pushRelayFetch: async (input, init) => {
        const request = new Request(input, init);
        failedCalls.push({ method: request.method, url: request.url, body: await request.text(),
          authorization: request.headers.get("authorization") });
        if (failedCalls.length === 1) throw new Error("offline");
        return new Response(null, { status: 503 });
      },
      pushRelayLog: (line) => logs.push(line),
      presenceOf: () => "online", submitUserMessage: () => { throw new Error("not used"); },
      interruptThread: () => "idle", resolveApproval: () => Promise.resolve("unknown" as const),
      onDeviceRevoked: () => {}, now: () => 1_000,
    });
    await tick();
    expect(failedCalls).toHaveLength(2);
    expect(logs).toEqual([
      "live activity relay cleanup: DELETE failed with a network error",
      "live activity relay cleanup: DELETE returned HTTP 503",
    ]);
    expect(storage.liveActivityRelayDeletions(10)).toEqual([
      "stale-push-id", "stale-push-id-2",
    ]);
    storage.close();

    const reopened = openStorage(path);
    const successfulCalls: string[] = [];
    createApp({
      storage: reopened, config, gatewayInfo: gatewayInfoForConfig(config),
      pushRelayFetch: async (input, init) => {
        successfulCalls.push(new Request(input, init).url);
        return new Response(null, { status: 204 });
      },
      presenceOf: () => "online", submitUserMessage: () => { throw new Error("not used"); },
      interruptThread: () => "idle", resolveApproval: () => Promise.resolve("unknown" as const),
      onDeviceRevoked: () => {}, now: () => 1_000,
    });
    await tick();
    expect(successfulCalls).toEqual([
      "http://relay.internal:8788/register/stale-push-id",
      "http://relay.internal:8788/register/stale-push-id-2",
    ]);
    expect(reopened.liveActivityRelayDeletions(10)).toEqual([]);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("times out a stuck deletion and honors a trigger that arrived while draining", async () => {
    const storage = openStorage(":memory:");
    storage.createDevice({
      id: "device", name: "phone", tokenHash: hashToken("device-token"), createdAt: 1,
    });
    storage.saveLiveActivityRegistration({ deviceId: "device", activityId: "stale", runId: "run-1",
      conversationId: "gateway-1", bot: "sage", pushId: "stale-push-id", createdAt: 1 });
    storage.saveLiveActivityRegistration({ deviceId: "device", activityId: "current", runId: "run-2",
      conversationId: "gateway-1", bot: "sage", pushId: "current-push-id", createdAt: 2 });
    const logs: string[] = [];
    let deleteCalls = 0;
    let firstAborted = false;
    let outboxAtRetry: string[] = [];
    const relayFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST") {
        return new Response('{"pushId":"registration-push-id"}', {
          status: 201, headers: { "content-type": "application/json" },
        });
      }
      deleteCalls += 1;
      if (deleteCalls === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) {
            reject(new Error("missing abort signal"));
            return;
          }
          const abort = () => {
            firstAborted = true;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      outboxAtRetry = storage.liveActivityRelayDeletions(10);
      return new Response(null, { status: 204 });
    };
    const config: GatewayConfig = { name: "timeout", port: 8787, dbPath: ":memory:",
      turnTimeoutSeconds: 0, hermes: testHermes(), pushRelayUrl: "http://relay.internal:8788/" };
    const app = createApp({
      storage, config, pushRelayFetch: relayFetch,
      pushRelayDeleteTimeoutMs: 50, pushRelayLog: (line) => logs.push(line),
      gatewayInfo: gatewayInfoForConfig(config), presenceOf: () => "online",
      submitUserMessage: () => { throw new Error("not used"); }, interruptThread: () => "idle",
      resolveApproval: () => Promise.resolve("unknown" as const), onDeviceRevoked: () => {},
      now: () => 1_000,
    });
    expect(deleteCalls).toBe(1);

    const registered = await app.request("/push/live-activities/register", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer device-token" },
      body: JSON.stringify({ activityId: "other", runId: "other", conversationId: "other",
        bot: "sage", token: "aa".repeat(32), environment: "development" }),
    });
    expect(registered.status).toBe(200);
    expect(deleteCalls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(deleteCalls).toBe(2);
    expect(firstAborted).toBe(true);
    expect(logs).toEqual([
      "live activity relay cleanup: DELETE failed with a network error",
    ]);
    expect(outboxAtRetry).toEqual(["stale-push-id"]);
    expect(storage.liveActivityRelayDeletions(10)).toEqual([]);
    storage.close();
  });

  it("walks a fixed outbox snapshot once despite failed head rows", async () => {
    const config: GatewayConfig = { name: "pages", port: 8787, dbPath: ":memory:",
      turnTimeoutSeconds: 0, hermes: testHermes(), pushRelayUrl: "http://relay.internal:8788/" };
    const seed = (storage: ReturnType<typeof openStorage>, count = 51) => {
      for (let index = 0; index < count; index += 1) {
        const deviceId = `device-${index}`;
        storage.createDevice({ id: deviceId, name: deviceId,
          tokenHash: `hash-${index}`, createdAt: index });
        storage.saveLiveActivityRegistration({ deviceId, activityId: "old", runId: "old",
          conversationId: "session", bot: "sage", pushId: `old-push-${index}`, createdAt: index });
        storage.saveLiveActivityRegistration({ deviceId, activityId: "new", runId: "new",
          conversationId: "session", bot: "sage", pushId: `new-push-${index}`, createdAt: index });
      }
    };
    const appDeps = (storage: ReturnType<typeof openStorage>, relayFetch: typeof fetch) => ({
      storage, config, pushRelayFetch: relayFetch, pushRelayLog: () => {},
      gatewayInfo: gatewayInfoForConfig(config), presenceOf: () => "online" as const,
      submitUserMessage: () => { throw new Error("not used"); }, interruptThread: () => "idle" as const,
      resolveApproval: () => Promise.resolve("unknown" as const), onDeviceRevoked: () => {},
      now: () => 1_000,
    });

    const successful = openStorage(":memory:");
    seed(successful);
    let successfulDeletes = 0;
    createApp(appDeps(successful, async () => {
      successfulDeletes += 1;
      return new Response(null, { status: 204 });
    }));
    await tick();
    expect(successfulDeletes).toBe(51);
    expect(successful.liveActivityRelayDeletions(100)).toEqual([]);
    successful.close();

    const mixed = openStorage(":memory:");
    seed(mixed, 52);
    const attempts = new Map<string, number>();
    createApp(appDeps(mixed, async (input) => {
      const pushId = decodeURIComponent(new URL(new Request(input).url).pathname.split("/").at(-1)!);
      attempts.set(pushId, (attempts.get(pushId) ?? 0) + 1);
      const index = Number(pushId.slice("old-push-".length));
      return new Response(null, { status: index < 50 ? 503 : 204 });
    }));
    await tick();
    expect(attempts.size).toBe(52);
    expect([...attempts.values()]).toEqual(Array.from({ length: 52 }, () => 1));
    expect(mixed.liveActivityRelayDeletions(100)).toEqual(
      Array.from({ length: 50 }, (_, index) => `old-push-${index}`),
    );
    mixed.close();
  });

  it("advertises the push proxy capability in health", async () => {
    const { app } = await setup();

    const health = (await (await app.request("/health")).json()) as {
      capabilities?: Record<string, number>;
    };

    expect(health.capabilities?.["com.cozylabs.push-proxy"]).toBe(1);
  });
});

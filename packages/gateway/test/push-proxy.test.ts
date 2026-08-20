import { describe, expect, it } from "vitest";
import type { Message, RichBlock } from "cozygateway-contract";

import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { gatewayInfoForConfig } from "../src/server.ts";
import { openStorage } from "../src/storage.ts";

interface RelayCall {
  method: string;
  url: string;
  body: string;
  authorization: string | null;
}

async function setup() {
  const calls: RelayCall[] = [];
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
      : new Response('{"pushId":"relay-push-id"}', {
          status: 201,
          headers: { "content-type": "application/json" },
        });
  };
  const config: GatewayConfig = {
    name: "push-proxy-test",
    port: 8787,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    agents: [{ id: "mock", name: "Mock", backend: "mock" }],
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
  return { app, authed, calls };
}

describe("authenticated push relay proxy", () => {
  it("round-trips relay registration bodies and statuses", async () => {
    const { authed, calls } = await setup();
    const body = '{"platform":"apns","token":"device-token"}';

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

  it("advertises the push proxy capability in health", async () => {
    const { app } = await setup();

    const health = (await (await app.request("/health")).json()) as {
      capabilities?: Record<string, number>;
    };

    expect(health.capabilities?.["com.cozylabs.push-proxy"]).toBe(1);
  });
});

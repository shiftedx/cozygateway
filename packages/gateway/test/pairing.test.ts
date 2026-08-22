import { describe, expect, it } from "vitest";

import { testHermes } from "./support/test-config.ts";
import { openStorage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";

const config: GatewayConfig = {
  name: "test-gateway",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermes: testHermes(),
};

function makeApp(now = () => 1_000, attachHealth?: () => {
  configured: number; online: number; degraded: number; absent: number;
  lastHeartbeatAt: number | null; lastEventAt: number | null; lastTerminalAt: number | null;
  queueDepth: number; deadLetters: number;
}) {
  const storage = openStorage(":memory:");
  const revoked: string[] = [];
  const app = createApp({
    storage,
    config,
    gatewayInfo: { name: "test-gateway", version: "0.1.0", contract: "v1" },
    ...(attachHealth === undefined ? {} : { attachHealth }),
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("not under test");
    },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: (id) => revoked.push(id),
    now,
  });
  return { app, storage, revoked };
}

async function pair(app: ReturnType<typeof makeApp>["app"], storage: ReturnType<typeof openStorage>, now = 1_000) {
  const code = newSetupCode();
  storage.createSetupCode(code, now + SETUP_CODE_TTL_MS);
  const res = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "Test phone" }),
  });
  return res;
}

describe("GET /health", () => {
  it("is unauthenticated and reports contract v1", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { contract: string };
    expect(body.contract).toBe("v1");
  });

  // Issue #16: http.ts just echoes deps.gatewayInfo verbatim in both /health and /pair, so
  // whatever capabilities shape the caller supplied (absent, or a populated vendor map) must
  // survive the round trip unchanged.
  it("echoes an absent capabilities field verbatim (a pre-#16 gatewayInfo shape)", async () => {
    const { app } = makeApp();
    const body = (await (await app.request("/health")).json()) as { capabilities?: unknown };
    expect(body.capabilities).toBeUndefined();
  });

  it("echoes a populated com.cozylabs.* capabilities map verbatim in /health and /pair", async () => {
    const storage = openStorage(":memory:");
    const app = createApp({
      storage,
      config,
      gatewayInfo: {
        name: "test-gateway",
        version: "0.1.0",
        contract: "v1",
        capabilities: { "com.cozylabs.test": 1 },
      },
      presenceOf: () => "online",
      submitUserMessage: () => {
        throw new Error("not under test");
      },
      interruptThread: () => "idle",
      resolveApproval: () => Promise.resolve("unknown" as const),
      onDeviceRevoked: () => {},
      now: () => 1_000,
    });
    const health = (await (await app.request("/health")).json()) as { capabilities?: unknown };
    expect(health.capabilities).toEqual({ "com.cozylabs.test": 1 });

    const pairRes = await pair(app, storage);
    const paired = (await pairRes.json()) as { gateway: { capabilities?: unknown } };
    expect(paired.gateway.capabilities).toEqual({ "com.cozylabs.test": 1 });
  });

  it("exposes the same aggregate non-secret attach summary on health and ready", async () => {
    const attach = {
      configured: 6, online: 4, degraded: 1, absent: 1,
      lastHeartbeatAt: 1, lastEventAt: 2, lastTerminalAt: 3,
      queueDepth: 5, deadLetters: 1,
    };
    const { app } = makeApp(() => 1_000, () => attach);
    expect((await (await app.request("/health")).json()).attach).toEqual(attach);
    expect((await (await app.request("/ready")).json()).attach).toEqual(attach);
  });
});

describe("POST /pair", () => {
  it("issues a device token for a live setup code", async () => {
    const { app, storage } = makeApp();
    const res = await pair(app, storage);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceToken: string; device: { name: string } };
    expect(body.deviceToken.length).toBeGreaterThan(20);
    expect(body.device.name).toBe("Test phone");
  });

  it("rejects an unknown or reused code with setup_code_invalid", async () => {
    const { app, storage } = makeApp();
    const first = await pair(app, storage);
    expect(first.status).toBe(200);
    const res = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: "NOPE-0000", deviceName: "x" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("setup_code_invalid");
  });

  it("rejects a malformed body with invalid_request", async () => {
    const { app } = makeApp();
    const res = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceName: "no code" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("bearer auth + device management", () => {
  it("rejects missing/garbage tokens and accepts a paired one", async () => {
    const { app, storage } = makeApp();
    expect((await app.request("/devices")).status).toBe(401);
    expect(
      (await app.request("/devices", { headers: { authorization: "Bearer garbage" } })).status,
    ).toBe(401);

    const pairRes = await pair(app, storage);
    const { deviceToken } = (await pairRes.json()) as { deviceToken: string };
    const res = await app.request("/devices", { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(res.status).toBe(200);
    const devices = (await res.json()) as Array<{ id: string }>;
    expect(devices).toHaveLength(1);
  });

  it("revokes a device and fires the revocation hook", async () => {
    const { app, storage, revoked } = makeApp();
    const pairRes = await pair(app, storage);
    const { deviceToken, device } = (await pairRes.json()) as {
      deviceToken: string;
      device: { id: string };
    };
    const del = await app.request(`/devices/${device.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(del.status).toBe(200);
    expect(revoked).toEqual([device.id]);
    expect(
      (await app.request("/devices", { headers: { authorization: `Bearer ${deviceToken}` } })).status,
    ).toBe(401);
  });
});

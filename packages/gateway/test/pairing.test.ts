import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";

const config: GatewayConfig = {
  name: "test-gateway",
  port: 8787,
  dbPath: ":memory:",
  agents: [{ id: "mock", name: "Mock", backend: "mock" }],
};

function makeApp(now = () => 1_000) {
  const storage = openStorage(":memory:");
  const revoked: string[] = [];
  const app = createApp({
    storage,
    config,
    gatewayInfo: { name: "test-gateway", version: "0.1.0", contract: "v1" },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("not under test");
    },
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

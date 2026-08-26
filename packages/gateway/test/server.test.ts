import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MOBILE_NODE_CAPABILITY_VERSION, type GatewayInfo, type ServerFrame } from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { startGateway, type RunningGateway } from "../src/server.ts";

let gateway: RunningGateway;

beforeEach(async () => {
  process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret";
  process.env.TEST_ATTACH_TOKEN = "attach-secret";
  gateway = await startGateway({
    name: "e2e",
    port: 0,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    hermes: testHermes(),
  });
});

afterEach(async () => {
  await gateway.close();
  delete process.env.TEST_HERMES_CONTROL_TOKEN;
  delete process.env.TEST_ATTACH_TOKEN;
});

describe("startGateway end to end", () => {
  it("pairs and authenticates a client over WebSocket", async () => {
    const code = gateway.issueSetupCode();
    const pairRes = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "e2e phone" }),
    });
    expect(pairRes.status).toBe(200);
    const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

    const seen: ServerFrame[] = [];
    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: deviceToken }));

    const start = Date.now();
    while (!seen.some((f) => f.type === "ready")) {
      if (Date.now() - start > 5_000) throw new Error(`timeout; saw ${JSON.stringify(seen)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen.some((f) => f.type === "ready")).toBe(true);
    ws.close();
  });
});

// Issue #16: GatewayInfo.capabilities travels through GET /health, the pair response, and the
// ready frame -- one shared object, so wiring it once in startGateway covers all three.
describe("GatewayInfo.capabilities wiring", () => {
  // Issue #19 moved the floor: the approval surface is a CORE capability this gateway always
  // implements, so the baseline map is no longer empty. Everything else about the wiring (one
  // shared object across all three positions, config-supplied ids passed through untouched) is
  // unchanged, which is what these two cases actually pin.
  it("carries the always-on core capabilities when the config sets none of its own", async () => {
    const gw = await startGateway({
      name: "no-caps",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermes: testHermes(),
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities).toMatchObject({ approvals: 1, "com.cozylabs.bots": expect.any(Number) });
    } finally {
      await gw.close();
    }
  });

  it("surfaces a configured com.cozylabs.* vendor capability identically in health, pair, and ready", async () => {
    const gw = await startGateway({
      name: "with-caps",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermes: testHermes(),
      capabilities: { "com.cozylabs.test": 1, "com.cozylabs.some-unrecognized-thing": 7 },
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities).toEqual({
        "com.cozylabs.test": 1,
        "com.cozylabs.some-unrecognized-thing": 7,
        approvals: 1,
        "com.cozylabs.bots": expect.any(Number),
        "com.cozylabs.mobile-node": MOBILE_NODE_CAPABILITY_VERSION,
      });

      const code = gw.issueSetupCode();
      const pairRes = await fetch(`${gw.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupCode: code, deviceName: "caps phone" }),
      });
      const paired = (await pairRes.json()) as { deviceToken: string; gateway: GatewayInfo };
      expect(paired.gateway.capabilities).toEqual(health.capabilities);

      const frames: ServerFrame[] = [];
      const ws = new WebSocket(`${gw.url.replace("http", "ws")}/ws`);
      ws.on("message", (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", token: paired.deviceToken }));
      const start = Date.now();
      while (!frames.some((f) => f.type === "ready")) {
        if (Date.now() - start > 5_000) throw new Error(`timeout; saw ${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      ws.close();
      const ready = frames.find((f) => f.type === "ready");
      expect(ready?.type === "ready" ? ready.gateway.capabilities : undefined).toEqual(health.capabilities);
    } finally {
      await gw.close();
    }
  });
});

import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HARNESS_UPDATE_CAPABILITY_VERSION,
  MOBILE_NODE_CAPABILITY_VERSION,
  type GatewayInfo,
  type ServerFrame,
} from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { startFakeHermesServer } from "./support/fake-hermes-server.ts";
import { startGateway, type RunningGateway } from "../src/server.ts";
import { openStorage } from "../src/storage.ts";
import { PHOTO_SWEEP_MS } from "../src/hermes-bridge/photos.ts";

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
  it("prunes explicitly expired attachment bytes at startup while preserving NULL-expiry plugin media", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cozygateway-attachment-prune-")), "gateway.sqlite");
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const descriptor = (mediaId: string, expiresAt?: number) => ({
      mediaId, mimeType: "image/png", byteCount: bytes.byteLength, sha256, filename: `${mediaId}.png`, family: "image" as const,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    const beforeStart = openStorage(dbPath);
    beforeStart.saveAttachMedia("sage", descriptor("expired", 0), bytes, 0);
    beforeStart.saveAttachMedia("sage", descriptor("plugin"), bytes, 0);
    beforeStart.close();

    const gw = await startGateway({
      name: "attachment-prune", port: 0, dbPath, turnTimeoutSeconds: 0, hermes: testHermes(),
    });
    try {
      expect(gw.storage.saveAttachMedia("sage", { ...descriptor("expired"), filename: "replacement.png" }, bytes, Date.now())).toBe(true);
      expect(gw.storage.attachMediaInfo("sage", "plugin", Date.now())?.size).toBe(4);
    } finally {
      await gw.close();
    }
  });

  it("unrefs the attachment sweep and clears it before its storage closes", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    let gw: RunningGateway | undefined;
    try {
      gw = await startGateway({
        name: "attachment-sweep", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0, hermes: testHermes(),
      });
      const index = setIntervalSpy.mock.calls.findIndex(([, interval]) => interval === PHOTO_SWEEP_MS);
      expect(index).toBeGreaterThanOrEqual(0);
      const timer = setIntervalSpy.mock.results[index]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);

      await gw.close();
      gw = undefined;
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    } finally {
      await gw?.close();
      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });

  it("keeps settings authenticated but non-editable without a source config path", async () => {
    expect((await fetch(`${gateway.url}/gateway/settings`)).status).toBe(401);
    const pair = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "settings phone" }),
    });
    const token = ((await pair.json()) as { deviceToken: string }).deviceToken;
    const response = await fetch(`${gateway.url}/gateway/settings`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

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

describe("public deployment startup posture", () => {
  it("rejects an invalid public posture before creating the SQLite database", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cozygateway-public-start-")), "gateway.sqlite");
    await expect(startGateway({
      name: "unsafe-public",
      host: "0.0.0.0",
      publicUrl: "https://gateway.example",
      port: 0,
      dbPath,
      turnTimeoutSeconds: 0,
      hermes: testHermes(),
    })).rejects.toThrow(/publicUrl.*loopback/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("starts a loopback origin with a valid advertised HTTPS origin", async () => {
    const gw = await startGateway({
      name: "safe-public",
      host: "127.0.0.1",
      publicUrl: "https://gateway.example",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermes: testHermes(),
    });
    try {
      expect(gw.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect((await fetch(`${gw.url}/health`)).status).toBe(200);
    } finally {
      await gw.close();
    }
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
      capabilities: {
        "com.cozylabs.test": 1,
        "com.cozylabs.some-unrecognized-thing": 7,
        // Built-in evidence-gated capabilities cannot be forced on through free-form config.
        "com.cozylabs.harness-update": 99,
      },
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities).toEqual({
        "com.cozylabs.test": 1,
        "com.cozylabs.some-unrecognized-thing": 7,
        approvals: 1,
        "com.cozylabs.bots": expect.any(Number),
        "com.cozylabs.hermes-desktop-sessions": 2,
        "com.cozylabs.harness-settings": 1,
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

  it("advertises harness update only after the pinned Hermes read APIs pass discovery", async () => {
    const upstream = await startFakeHermesServer({
      dashboard: ({ method, path }) => {
        if (path === "/api/hermes/update/check") return { body: {
          install_method: "git",
          current_version: "0.20.3",
          behind: 1,
          update_available: true,
          can_apply: true,
          update_command: "hermes update",
          message: null,
        } };
        if (path === "/api/actions/hermes-update/status") return { body: {
          name: "hermes-update", running: false, exit_code: null, pid: null, lines: [],
        } };
        if (path === "/api/hermes/update/receipt") return {
          status: 404,
          body: { detail: "No update receipt found (no `hermes update` run recorded)." },
        };
        if (path === "/api/hermes/update" && method === "OPTIONS") return {
          status: 405,
          body: { detail: "Method Not Allowed" },
        };
        return { status: 404, body: { detail: "Not Found" } };
      },
    });
    const gw = await startGateway({
      name: "update-capability",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermes: testHermes(upstream.url),
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities?.["com.cozylabs.harness-update"])
        .toBe(HARNESS_UPDATE_CAPABILITY_VERSION);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });
});

import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { WsHub } from "../src/ws-hub.ts";
import { SETUP_CODE_TTL_MS, mintDeviceToken, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";

const config: GatewayConfig = {
  name: "test-gateway",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
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
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: (id) => revoked.push(id),
    now,
  });
  return { app, storage, revoked };
}

async function pairObserver(
  app: ReturnType<typeof makeApp>["app"],
  storage: Storage,
  now = 1_000,
): Promise<Response> {
  const code = newSetupCode();
  storage.createSetupCode(code, now + SETUP_CODE_TTL_MS, "observer");
  return await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "Dashboard", kind: "observer" }),
  });
}

async function pairDevice(
  app: ReturnType<typeof makeApp>["app"],
  storage: Storage,
  now = 1_000,
): Promise<Response> {
  const code = newSetupCode();
  storage.createSetupCode(code, now + SETUP_CODE_TTL_MS);
  return await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "Test phone" }),
  });
}

describe("observer pairing", () => {
  it("pairing with kind observer mints a read scoped token", async () => {
    const { app, storage } = makeApp();
    const res = await pairObserver(app, storage);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceToken: string; device: { id: string } };
    expect(typeof body.deviceToken).toBe("string");
    const { hashToken } = await import("../src/auth.ts");
    const row = storage.deviceByTokenHash(hashToken(body.deviceToken));
    expect(row?.scope).toBe("read");
    expect(row?.kind).toBe("observer");
  });

  it("a plain device pair still mints a write scoped device", async () => {
    const { app, storage } = makeApp();
    const res = await pairDevice(app, storage);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceToken: string };
    const { hashToken } = await import("../src/auth.ts");
    const row = storage.deviceByTokenHash(hashToken(body.deviceToken));
    expect(row?.scope).toBe("write");
    expect(row?.kind).toBe("device");
  });

  it("an observer setup code cannot pair as a plain device or as a runner", async () => {
    const { app, storage } = makeApp();
    const code = newSetupCode();
    storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS, "observer");
    const asDevice = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "Test phone" }),
    });
    expect(asDevice.status).toBe(401);
    expect(((await asDevice.json()) as { error: { code: string } }).error.code).toBe(
      "setup_code_invalid",
    );
  });

  it("a device setup code cannot pair as an observer", async () => {
    const { app, storage } = makeApp();
    const code = newSetupCode();
    storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
    const res = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "Dashboard", kind: "observer" }),
    });
    expect(res.status).toBe(401);
  });

  it("an observer pair still requires a deviceName", async () => {
    const { app, storage } = makeApp();
    const code = newSetupCode();
    storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS, "observer");
    const res = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, kind: "observer" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /devices", () => {
  it("lists an observer with its kind and scope beside a plain device", async () => {
    const { app, storage } = makeApp();
    await pairObserver(app, storage);
    const paired = (await (await pairDevice(app, storage)).json()) as { deviceToken: string };
    const res = await app.request("/devices", {
      headers: { authorization: `Bearer ${paired.deviceToken}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ name: string; kind: string; scope: string }>;
    const observer = rows.find((row) => row.name === "Dashboard");
    expect(observer).toBeDefined();
    expect(observer?.kind).toBe("observer");
    expect(observer?.scope).toBe("read");
    const phone = rows.find((row) => row.name === "Test phone");
    expect(phone?.kind).toBe("device");
    expect(phone?.scope).toBe("write");
  });

  it("accepts a read scoped token, because it is a pure read route", async () => {
    const { app, storage } = makeApp();
    const observer = (await (await pairObserver(app, storage)).json()) as { deviceToken: string };
    const res = await app.request("/devices", {
      headers: { authorization: `Bearer ${observer.deviceToken}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("the read scope is refused by every write route", () => {
  /** Walks the router itself rather than a hand written list, so a write route added after this
   *  packet cannot quietly escape the refusal. */
  it("refuses 403 scope_read_only on every registered POST, PUT, PATCH and DELETE", async () => {
    const { app, storage } = makeApp();
    const observer = (await (await pairObserver(app, storage)).json()) as { deviceToken: string };
    const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    const paths = new Set(
      app.routes
        .filter((route) => writeMethods.has(route.method.toUpperCase()))
        .map((route) => `${route.method.toUpperCase()} ${route.path}`),
    );
    expect(paths.size).toBeGreaterThan(20);
    const failures: string[] = [];
    for (const entry of paths) {
      const [method, path] = entry.split(" ", 2) as [string, string];
      const concrete = path
        .replace(/:[A-Za-z0-9_]+\{[^}]*\}/g, "x")
        .replace(/:[A-Za-z0-9_]+/g, "x")
        .replace(/\*/g, "x");
      const res = await app.request(concrete, {
        method,
        headers: {
          authorization: `Bearer ${observer.deviceToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      if (res.status !== 403 || body.error?.code !== "scope_read_only") {
        failures.push(`${method} ${path} answered ${res.status} ${body.error?.code ?? "(no code)"}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("leaves a write scoped token's behavior unchanged on the same routes", async () => {
    const { app, storage } = makeApp();
    const paired = (await (await pairDevice(app, storage)).json()) as { deviceToken: string };
    const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    const paths = new Set(
      app.routes
        .filter((route) => writeMethods.has(route.method.toUpperCase()))
        .map((route) => `${route.method.toUpperCase()} ${route.path}`),
    );
    const leaked: string[] = [];
    for (const entry of paths) {
      const [method, path] = entry.split(" ", 2) as [string, string];
      // The device delete route would revoke the very token under test, so skip it here; its own
      // behavior is covered below.
      if (path.startsWith("/devices/")) continue;
      const concrete = path
        .replace(/:[A-Za-z0-9_]+\{[^}]*\}/g, "x")
        .replace(/:[A-Za-z0-9_]+/g, "x")
        .replace(/\*/g, "x");
      const res = await app.request(concrete, {
        method,
        headers: {
          authorization: `Bearer ${paired.deviceToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      if (body.error?.code === "scope_read_only") leaked.push(`${method} ${path}`);
    }
    expect(leaked).toEqual([]);
  });

  it("refuses an unauthenticated write route nothing new, so pairing still works", async () => {
    const { app, storage } = makeApp();
    const res = await pairDevice(app, storage);
    expect(res.status).toBe(200);
  });
});

describe("POST /observers/pair-code", () => {
  it("mints an observer code a device pair cannot spend, and an observer cannot mint one", async () => {
    const { app, storage } = makeApp();
    const paired = (await (await pairDevice(app, storage)).json()) as { deviceToken: string };
    const res = await app.request("/observers/pair-code", {
      method: "POST",
      headers: { authorization: `Bearer ${paired.deviceToken}` },
    });
    expect(res.status).toBe(200);
    const minted = (await res.json()) as { setupCode: string; expiresAt: number };
    expect(minted.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const wrongKind = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: minted.setupCode, deviceName: "Test phone" }),
    });
    expect(wrongKind.status).toBe(401);

    const paired2 = (await (await pairDevice(app, storage)).json()) as { deviceToken: string };
    const second = await app.request("/observers/pair-code", {
      method: "POST",
      headers: { authorization: `Bearer ${paired2.deviceToken}` },
    });
    const code = ((await second.json()) as { setupCode: string }).setupCode;
    const observer = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "Dashboard", kind: "observer" }),
    });
    expect(observer.status).toBe(200);
    const token = ((await observer.json()) as { deviceToken: string }).deviceToken;
    const refused = await app.request("/observers/pair-code", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      "scope_read_only",
    );
  });
});

describe("DELETE /devices/:id", () => {
  it("deletes an observer and closes its socket like any device", async () => {
    const { app, storage, revoked } = makeApp();
    const observer = (await (await pairObserver(app, storage)).json()) as {
      device: { id: string };
    };
    const paired = (await (await pairDevice(app, storage)).json()) as { deviceToken: string };
    const res = await app.request(`/devices/${observer.device.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${paired.deviceToken}` },
    });
    expect(res.status).toBe(200);
    expect(revoked).toContain(observer.device.id);
  });
});

describe("storage migration", () => {
  it("reads a device row written before the scope column existed as a write scoped device", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cozygateway-observer-")), "gateway.db");
    const minted = mintDeviceToken();
    // A database that predates this packet: the devices table exactly as it was, with a row in it.
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    ) STRICT;`);
    legacy
      .prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run("legacy", "Old phone", minted.tokenHash, 1);
    legacy.close();

    const storage = openStorage(path);
    try {
      const row = storage.deviceByTokenHash(minted.tokenHash);
      expect(row?.scope).toBe("write");
      expect(row?.kind).toBe("device");
      expect(storage.listDevices().find((device) => device.id === "legacy")?.scope).toBe("write");
    } finally {
      storage.close();
    }
  });
});

describe("the app websocket holds a read token to the same rule", () => {
  it("refuses every command frame and still answers a sync frame", async () => {
    const storage = openStorage(":memory:");
    const observer = mintDeviceToken();
    const phone = mintDeviceToken();
    storage.createDevice({
      id: "obs",
      name: "Dashboard",
      tokenHash: observer.tokenHash,
      createdAt: 1,
      kind: "observer",
      scope: "read",
    });
    storage.createDevice({ id: "d1", name: "phone", tokenHash: phone.tokenHash, createdAt: 1 });
    const hub = new WsHub({
      storage,
      gatewayInfo: { name: "g", version: "0.1.0", contract: "v1" },
      now: () => 1_000,
      authTimeoutMs: 500,
      heartbeatMs: 10_000,
    });
    const server = createServer();
    server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
    server.listen(0);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      const frames: ServerFrame[] = [];
      ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", token: observer.token }));
      await waitFor(() => frames.some((f) => f.type === "ready"));

      const lease = "a".repeat(43);
      const commandFrames = [
        { type: "mobile_node_advertise", foreground: true, commands: ["device.status"] },
        { type: "mobile_node_result", requestId: "r1", lease, status: "denied" },
        { type: "mobile_node_progress", requestId: "r1", lease, stage: "executing" },
      ];
      for (const frame of commandFrames) {
        const before = frames.length;
        ws.send(JSON.stringify(frame));
        await waitFor(() => frames.length > before);
        const answer = frames[frames.length - 1] as { type: string; code?: string };
        expect(answer.type, JSON.stringify(frame)).toBe("error");
        expect(answer.code, JSON.stringify(frame)).toBe("scope_read_only");
      }

      // A read frame still works: the dashboard is allowed to observe.
      const before = frames.length;
      ws.send(JSON.stringify({ type: "sync", threads: {} }));
      await waitFor(() => frames.slice(before).some((f) => f.type === "synced"));
      ws.close();
    } finally {
      hub.close();
      server.close();
      await once(server, "close");
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting");
}

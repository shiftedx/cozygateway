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
import { createApp, type AppDeps } from "../src/http.ts";
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

/** Every optional dependency of `createApp` gates a whole family of routes behind
 *  `if (deps.x !== undefined)`, so an app built without them registers well under half the write
 *  routes a real gateway serves. The read-scope refusal happens before any handler runs, so the
 *  surface behind these stubs is never reached: a throwing proxy is enough to make the router
 *  complete, and it fails loudly rather than quietly if anything ever does reach it. */
function unreachable<T>(name: string): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => () => {
        throw new Error(`${name}.${String(property)} is not under test`);
      },
    },
  ) as T;
}

function makeApp(now = () => 1_000, wired = true) {
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
    ...(wired
      ? {
          bots: unreachable<NonNullable<AppDeps["bots"]>>("bots"),
          runners: unreachable<NonNullable<AppDeps["runners"]>>("runners"),
          runnerPresence: unreachable<NonNullable<AppDeps["runnerPresence"]>>("runnerPresence"),
          providerConnections:
            unreachable<NonNullable<AppDeps["providerConnections"]>>("providerConnections"),
          maintenance: unreachable<NonNullable<AppDeps["maintenance"]>>("maintenance"),
          hermesGlobalSkills:
            unreachable<NonNullable<AppDeps["hermesGlobalSkills"]>>("hermesGlobalSkills"),
          memory: unreachable<NonNullable<AppDeps["memory"]>>("memory"),
          history: unreachable<NonNullable<AppDeps["history"]>>("history"),
          chatConfiguration:
            unreachable<NonNullable<AppDeps["chatConfiguration"]>>("chatConfiguration"),
          harnessUpdates: unreachable<NonNullable<AppDeps["harnessUpdates"]>>("harnessUpdates"),
          harnessWorkspace:
            unreachable<NonNullable<AppDeps["harnessWorkspace"]>>("harnessWorkspace"),
          hermesSessions: unreachable<NonNullable<AppDeps["hermesSessions"]>>("hermesSessions"),
          gatewaySettings: unreachable<NonNullable<AppDeps["gatewaySettings"]>>("gatewaySettings"),
          attachTokens: new Map<string, string>(),
        }
      : {}),
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
    // The floor is the real count at the time this packet landed, not a token "more than a few".
    // If a whole route family stops being registered, because a dependency name drifted or the
    // stub above stopped satisfying an `if (deps.x !== undefined)` guard, this fails loudly
    // instead of quietly walking a fraction of the router and passing.
    expect(paths.size).toBeGreaterThanOrEqual(97);
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

  // Guards the guard: the walk above is only worth anything if the app it walks is the wired one.
  it("walks a fully wired router, not the handful of routes a bare app registers", async () => {
    const writeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
    const count = (app: ReturnType<typeof makeApp>["app"]) =>
      new Set(
        app.routes
          .filter((route) => writeMethods.has(route.method.toUpperCase()))
          .map((route) => `${route.method.toUpperCase()} ${route.path}`),
      ).size;
    const bare = count(makeApp(() => 1_000, false).app);
    const wired = count(makeApp().app);
    // Every conditionally registered family (bots, runners, provider connections, maintenance,
    // global skills) is absent from a bare app, so the wired router is more than twice the size.
    expect(wired).toBeGreaterThan(bare * 2);
  });

  it("refuses a read token on POST /pair, so an observer cannot pair anything", async () => {
    const { app, storage } = makeApp();
    const observer = (await (await pairObserver(app, storage)).json()) as { deviceToken: string };
    const code = newSetupCode();
    storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
    const res = await app.request("/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${observer.deviceToken}`,
      },
      body: JSON.stringify({ setupCode: code, deviceName: "Test phone" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("scope_read_only");
    // The code was not spent, so a client that clears its stale token can still pair with it.
    expect(storage.consumeSetupCode(code, 1_000)).toBe("ok");
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

describe("the devices schema", () => {
  it("is identical on a fresh database and on one migrated in place", () => {
    const fresh = join(mkdtempSync(join(tmpdir(), "cozygateway-fresh-")), "gateway.db");
    const migrated = join(mkdtempSync(join(tmpdir(), "cozygateway-migrated-")), "gateway.db");

    const legacy = new DatabaseSync(migrated);
    legacy.exec(`CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    ) STRICT;`);
    legacy.close();

    const columns = (path: string) => {
      const storage = openStorage(path);
      try {
        return storage.devicesTableInfoForTesting();
      } finally {
        storage.close();
      }
    };
    // Not just the column names: the type, the NOT NULL flag and the default too, so a migration
    // that adds a weaker column than the one a fresh database gets fails here.
    expect(columns(migrated)).toEqual(columns(fresh));
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

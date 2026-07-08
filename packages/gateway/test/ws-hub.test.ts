import { createServer } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { WsHub } from "../src/ws-hub.ts";
import { mintDeviceToken } from "../src/auth.ts";

let hub: WsHub;
let storage: Storage;
let server: ReturnType<typeof createServer>;
let port: number;
let token: string;

beforeEach(async () => {
  storage = openStorage(":memory:");
  const minted = mintDeviceToken();
  token = minted.token;
  storage.createDevice({ id: "d1", name: "phone", tokenHash: minted.tokenHash, createdAt: 1 });
  storage.upsertAgent({ id: "a1", name: "A", avatar: null, backend: "mock" });
  storage.createThread({ id: "t1", agentId: "a1", title: "T", createdAt: 1 });
  hub = new WsHub({
    storage,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1" },
    now: () => 1_000,
    authTimeoutMs: 200,
  });
  server = createServer();
  server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  port = address.port;
});

afterEach(async () => {
  hub.close();
  server.close();
  await once(server, "close");
});

function connect(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`);
}

function frames(ws: WebSocket): ServerFrame[] {
  const seen: ServerFrame[] = [];
  ws.on("message", (data) => seen.push(JSON.parse(String(data)) as ServerFrame));
  return seen;
}

async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("auth", () => {
  it("ready on a good token", async () => {
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((f) => f.type === "ready"));
    expect(hub.isDeviceConnected("d1")).toBe(true);
    ws.close();
  });

  it("closes 1008 on a bad token", async () => {
    const ws = connect();
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: "bad" }));
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(1008);
  });

  it("closes 1008 when auth never arrives (timeout)", async () => {
    const ws = connect();
    await once(ws, "open");
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(1008);
  });
});

describe("sync replay", () => {
  it("replays committed above the high-water mark then synced", async () => {
    for (let i = 0; i < 4; i++) {
      storage.appendMessage("t1", { role: "user", blocks: [{ type: "paragraph", text: String(i) }] }, i);
    }
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((f) => f.type === "ready"));
    ws.send(JSON.stringify({ type: "sync", threads: { t1: 2, ghost: 0 } }));
    await until(() => seen.some((f) => f.type === "synced"));
    const committed = seen.filter((f) => f.type === "committed");
    expect(committed.map((f) => f.seq)).toEqual([3, 4]);
    ws.close();
  });
});

describe("frame discipline", () => {
  it("answers an unknown frame after auth with error and keeps the connection open", async () => {
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((f) => f.type === "ready"));

    ws.send(JSON.stringify({ type: "bogus" }));
    await until(() => seen.some((f) => f.type === "error" && f.code === "invalid_request"));

    ws.send(JSON.stringify({ type: "sync", threads: { t1: 0 } }));
    await until(() => seen.some((f) => f.type === "synced"));
    expect(hub.isDeviceConnected("d1")).toBe(true);
    ws.close();
  });

  it("closes 1008 when a valid non-auth frame arrives before auth", async () => {
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "sync", threads: { t1: 0 } }));
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(1008);
    expect(seen.some((f) => f.type === "error" && f.code === "unauthorized")).toBe(true);
  });

  it("answers a second auth frame with error and keeps the connection open", async () => {
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((f) => f.type === "ready"));

    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() =>
      seen.some(
        (f) => f.type === "error" && f.code === "invalid_request" && f.message === "already authenticated",
      ),
    );

    ws.send(JSON.stringify({ type: "sync", threads: { t1: 0 } }));
    await until(() => seen.some((f) => f.type === "synced"));
    expect(hub.isDeviceConnected("d1")).toBe(true);
    ws.close();
  });
});

describe("broadcast + revocation", () => {
  it("delivers broadcasts to authed clients and closes revoked devices", async () => {
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((f) => f.type === "ready"));

    hub.broadcast({ type: "presence", agentId: "a1", state: "absent" });
    await until(() => seen.some((f) => f.type === "presence"));

    hub.closeDevice("d1");
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(1008);
    // The server-side close event can land a tick after the client-side one.
    await until(() => !hub.isDeviceConnected("d1"));
  });
});

describe("per-device presence", () => {
  it("reports connectedDeviceIds/isDeviceConnected once auth completes, and clears them on close", async () => {
    expect(hub.connectedDeviceIds().has("d1")).toBe(false);
    expect(hub.isDeviceConnected("d1")).toBe(false);

    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((f) => f.type === "ready"));

    expect(hub.connectedDeviceIds()).toEqual(new Set(["d1"]));
    expect(hub.isDeviceConnected("d1")).toBe(true);

    ws.close();
    await until(() => !hub.isDeviceConnected("d1"));
    expect(hub.connectedDeviceIds().has("d1")).toBe(false);
  });

  it("connectedDeviceIds returns a fresh snapshot: mutating the hub afterward doesn't change it", async () => {
    const before = hub.connectedDeviceIds();
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((f) => f.type === "ready"));

    expect(before.has("d1")).toBe(false); // the earlier snapshot is untouched
    expect(hub.connectedDeviceIds().has("d1")).toBe(true); // a fresh call sees the new state
    ws.close();
  });

  it("keeps a device connected while any of its sockets remain open (counts, not a boolean flip)", async () => {
    const wsA = connect();
    const seenA = frames(wsA);
    await once(wsA, "open");
    wsA.send(JSON.stringify({ type: "auth", token }));
    await until(() => seenA.some((f) => f.type === "ready"));

    const wsB = connect();
    const seenB = frames(wsB);
    await once(wsB, "open");
    wsB.send(JSON.stringify({ type: "auth", token }));
    await until(() => seenB.some((f) => f.type === "ready"));

    expect(hub.isDeviceConnected("d1")).toBe(true);

    wsA.close();
    // Give the server-side close event for wsA a chance to land; the device must still read
    // as connected because wsB (the second socket for the same device) is still open.
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.isDeviceConnected("d1")).toBe(true);
    expect(hub.connectedDeviceIds()).toEqual(new Set(["d1"]));

    wsB.close();
    await until(() => !hub.isDeviceConnected("d1"));
  });

  it("releases the device on an abnormal close (socket error) and on revocation via closeDevice", async () => {
    const wsErr = connect();
    const seenErr = frames(wsErr);
    await once(wsErr, "open");
    wsErr.send(JSON.stringify({ type: "auth", token }));
    await until(() => seenErr.some((f) => f.type === "ready"));
    expect(hub.isDeviceConnected("d1")).toBe(true);
    wsErr.terminate(); // abnormal close, not a clean 1000/1008 handshake
    await until(() => !hub.isDeviceConnected("d1"));

    const wsRevoked = connect();
    const seenRevoked = frames(wsRevoked);
    await once(wsRevoked, "open");
    wsRevoked.send(JSON.stringify({ type: "auth", token }));
    await until(() => seenRevoked.some((f) => f.type === "ready"));
    expect(hub.isDeviceConnected("d1")).toBe(true);
    hub.closeDevice("d1");
    await until(() => !hub.isDeviceConnected("d1"));
  });
});

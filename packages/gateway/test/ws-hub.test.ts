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
let traces: string[];
let mobileDisconnects: string[];
let mobileResults: string[];

beforeEach(async () => {
  storage = openStorage(":memory:");
  traces = [];
  mobileDisconnects = [];
  mobileResults = [];
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
    heartbeatMs: 25,
    trace: (line) => traces.push(line),
    onDeviceDisconnect: (deviceId) => mobileDisconnects.push(deviceId),
    onMobileResult: (_deviceId, frame) => mobileResults.push(frame.requestId),
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
  it("traces connection lifecycle without raw device IDs or tokens", async () => {
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((frame) => frame.type === "ready"));
    ws.send(JSON.stringify({ type: "sync", threads: { t1: 0 } }));
    await until(() => seen.some((frame) => frame.type === "synced"));
    ws.close();
    await once(ws, "close");
    await until(() => traces.some((line) => JSON.parse(line).event === "app_ws_close"));

    const records = traces.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record.event)).toEqual(["app_ws_open", "app_ws_auth", "app_ws_sync", "app_ws_close"]);
    expect(records.at(-1)?.code).toBe(1005);
    expect(traces.join("\n")).not.toContain(token);
    expect(traces.join("\n")).not.toContain('"d1"');
    expect(String(records[1]?.device)).toMatch(/^[0-9a-f]{16}$/);
  });

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

  it("expires an authenticated socket that stops answering heartbeat pings", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: false } as never);
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((frame) => frame.type === "ready"));
    expect(hub.isDeviceConnected("d1")).toBe(true);

    await until(() => !hub.isDeviceConnected("d1"), 500);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe("mobile node selection", () => {
  it("keeps a live foreground node selected when a delayed silent wake adds a background advertiser", async () => {
    const foreground = connect();
    const foregroundFrames = frames(foreground);
    await once(foreground, "open");
    foreground.send(JSON.stringify({ type: "auth", token }));
    await until(() => foregroundFrames.some((frame) => frame.type === "ready"));
    foreground.send(JSON.stringify({
      type: "mobile_node_advertise", commands: ["device.status", "location.current"], foreground: true,
    }));
    await until(() => hub.mobileNodeRoute("d1", "location.current").status === "available");

    const delayedWake = connect();
    const delayedWakeFrames = frames(delayedWake);
    await once(delayedWake, "open");
    delayedWake.send(JSON.stringify({ type: "auth", token }));
    await until(() => delayedWakeFrames.some((frame) => frame.type === "ready"));
    delayedWake.send(JSON.stringify({
      type: "mobile_node_advertise", commands: ["device.status"], foreground: false,
    }));
    delayedWake.send(JSON.stringify({ type: "sync", threads: {} }));
    await until(() => delayedWakeFrames.some((frame) => frame.type === "synced"));

    expect(hub.mobileNodeRoute("d1", "location.current")).toMatchObject({
      status: "available", foreground: true,
    });
    expect(hub.sendMobileNodeFrame("d1", {
      type: "mobile_node_request", requestId: "foreground-wins",
      lease: "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678", command: "device.status", bot: "sage",
      threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose: "Report phone readiness",
    })).toBe("sent");
    await until(() => foregroundFrames.some((frame) => frame.type === "mobile_node_request"));
    expect(delayedWakeFrames.some((frame) => frame.type === "mobile_node_request")).toBe(false);

    foreground.close();
    delayedWake.close();
  });

  it("replaces a selected background node when a foreground advertiser arrives", async () => {
    const background = connect();
    const backgroundFrames = frames(background);
    await once(background, "open");
    background.send(JSON.stringify({ type: "auth", token }));
    await until(() => backgroundFrames.some((frame) => frame.type === "ready"));
    background.send(JSON.stringify({
      type: "mobile_node_advertise", commands: ["device.status"], foreground: false,
    }));
    await until(() => hub.mobileNodeRoute("d1").foreground === false);

    const foreground = connect();
    const foregroundFrames = frames(foreground);
    await once(foreground, "open");
    foreground.send(JSON.stringify({ type: "auth", token }));
    await until(() => foregroundFrames.some((frame) => frame.type === "ready"));
    foreground.send(JSON.stringify({
      type: "mobile_node_advertise", commands: ["device.status", "location.current"], foreground: true,
    }));
    await until(() => hub.mobileNodeRoute("d1", "location.current").status === "available");

    expect(hub.sendMobileNodeFrame("d1", {
      type: "mobile_node_request", requestId: "foreground-replaces-background",
      lease: "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678", command: "device.status", bot: "sage",
      threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose: "Report phone readiness",
    })).toBe("sent");
    await until(() => foregroundFrames.some((frame) => frame.type === "mobile_node_request"));
    expect(backgroundFrames.some((frame) => frame.type === "mobile_node_request")).toBe(false);

    background.close();
    foreground.close();
  });

  it.each([false, true])("selects the newer %s advertiser during a same-priority reconnect", async (foreground) => {
    const oldSocket = connect();
    const oldFrames = frames(oldSocket);
    await once(oldSocket, "open");
    oldSocket.send(JSON.stringify({ type: "auth", token }));
    await until(() => oldFrames.some((frame) => frame.type === "ready"));
    oldSocket.send(JSON.stringify({
      type: "mobile_node_advertise", commands: ["device.status"], foreground,
    }));
    await until(() => hub.mobileNodeRoute("d1").status === "available");

    const newSocket = connect();
    const newFrames = frames(newSocket);
    await once(newSocket, "open");
    newSocket.send(JSON.stringify({ type: "auth", token }));
    await until(() => newFrames.some((frame) => frame.type === "ready"));
    newSocket.send(JSON.stringify({
      type: "mobile_node_advertise", commands: ["device.status"], foreground,
    }));
    newSocket.send(JSON.stringify({ type: "sync", threads: {} }));
    await until(() => newFrames.some((frame) => frame.type === "synced"));

    expect(hub.sendMobileNodeFrame("d1", {
      type: "mobile_node_request", requestId: `new-${foreground}`,
      lease: "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678", command: "device.status", bot: "sage",
      threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose: "Report phone readiness",
    })).toBe("sent");
    await until(() => newFrames.some((frame) => frame.type === "mobile_node_request"));
    expect(oldFrames.some((frame) => frame.type === "mobile_node_request")).toBe(false);

    oldSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(hub.mobileNodeRoute("d1").status).toBe("available");
    newSocket.close();
  });

  it("distinguishes an unadvertised command from an unavailable selected socket", async () => {
    expect(hub.mobileNodeRoute("d1", "device.status")).toMatchObject({
      status: "selected_socket_unavailable", selectedSocketPresent: false,
      selectedSocketOpen: false, commandAdvertised: false, connectedSocketCount: 0,
    });

    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((frame) => frame.type === "ready"));

    expect(hub.mobileNodeRoute("d1", "device.status")).toMatchObject({
      status: "command_not_advertised", selectedSocketPresent: false,
      selectedSocketOpen: false, commandAdvertised: false, connectedSocketCount: 1,
    });
    ws.send(JSON.stringify({
      type: "mobile_node_advertise", commands: ["device.status"], foreground: true,
    }));
    await until(() => hub.mobileNodeRoute("d1", "device.status").status === "available");
    expect(hub.mobileNodeRoute("d1", "location.current")).toMatchObject({
      status: "command_not_advertised", selectedSocketPresent: true,
      selectedSocketOpen: true, commandAdvertised: false, connectedSocketCount: 1,
    });
    ws.close();
    await once(ws, "close");
    await until(() => !hub.isDeviceConnected("d1"));
  });

  it("logs an unparseable selected-phone payload without logging its bytes", async () => {
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((frame) => frame.type === "ready"));
    ws.send(JSON.stringify({
      type: "mobile_node_advertise", commands: ["device.status"], foreground: true,
    }));
    await until(() => hub.mobileNodeRoute("d1", "device.status").status === "available");

    ws.send("unparseable-phone-secret");

    await until(() => traces.some((line) => JSON.parse(line).reason === "invalid_phone_payload"));
    const payload = traces.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.reason === "invalid_phone_payload");
    expect(payload).toMatchObject({
      event: "mobile_node_failure", reason: "invalid_phone_payload", command: "unknown",
      selectedDevicePresent: true, selectedSocketPresent: true, selectedSocketOpen: true,
      commandAdvertised: true, connectedSocketCount: 1,
      payloadParseable: false, payloadSchemaValid: false,
    });
    expect(traces.join("\n")).not.toContain("unparseable-phone-secret");
    expect(traces.join("\n")).not.toContain(token);
    ws.close();
    await once(ws, "close");
    await until(() => !hub.isDeviceConnected("d1"));
  });

  it("sends cancel frames over the selected socket without command gating", async () => {
    const ws = connect();
    const seen = frames(ws);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.some((frame) => frame.type === "ready"));
    ws.send(JSON.stringify({
      type: "mobile_node_advertise", commands: ["location.current"], foreground: true,
    }));
    await until(() => hub.mobileNodeRoute("d1", "location.current").status === "available");

    expect(hub.sendToDevice("d1", {
      type: "mobile_node_cancel", requestId: "cancel-location", lease: "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678", status: "cancelled",
    })).toBe(true);
    await until(() => seen.some((frame) => frame.type === "mobile_node_cancel"));

    ws.close();
    await once(ws, "close");
    await until(() => !hub.isDeviceConnected("d1"));
  });

  it("targets only the advertised socket and ignores a sibling socket closing", async () => {
    const wsA = connect();
    const seenA = frames(wsA);
    await once(wsA, "open");
    wsA.send(JSON.stringify({ type: "auth", token }));
    await until(() => seenA.some((frame) => frame.type === "ready"));
    const wsB = connect();
    const seenB = frames(wsB);
    await once(wsB, "open");
    wsB.send(JSON.stringify({ type: "auth", token }));
    await until(() => seenB.some((frame) => frame.type === "ready"));
    wsB.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status", "location.current"], foreground: false }));
    await until(() => hub.isMobileNodeAvailable("d1"));
    expect(hub.isMobileNodeAvailable("d1", "device.status")).toBe(true);
    expect(hub.isMobileNodeAvailable("d1", "location.current")).toBe(false);

    expect(hub.sendToDevice("d1", { type: "mobile_node_request", requestId: "request-1", lease: "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678", command: "device.status", bot: "sage", threadId: "thread-1", turnId: "turn-1", expiresAt: 2_000, purpose: "Report phone readiness" })).toBe(true);
    await until(() => seenB.some((frame) => frame.type === "mobile_node_request"));
    expect(seenA.some((frame) => frame.type === "mobile_node_request")).toBe(false);

    wsA.send(JSON.stringify({ type: "mobile_node_result", requestId: "forged", lease: "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678", status: "cancelled" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mobileResults).toEqual([]);
    wsB.send(JSON.stringify({ type: "mobile_node_result", requestId: "selected", lease: "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678", status: "cancelled" }));
    await until(() => mobileResults.includes("selected"));

    wsA.close();
    await once(wsA, "close");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mobileDisconnects).toEqual([]);
    expect(hub.isMobileNodeAvailable("d1")).toBe(true);
    wsB.close();
  });
});

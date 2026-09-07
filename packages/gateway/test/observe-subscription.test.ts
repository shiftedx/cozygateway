/** Dashboard packet D3 (capability 75): the observer's websocket subscription.
 *
 *  One subscribe frame, series points and events as they are written, a bounded queue per
 *  subscriber with a counted gap marker, no message text at any scope, and every command frame
 *  still refused for a read token. */
import { createServer } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { WsHub } from "../src/ws-hub.ts";
import { ObservationRing } from "../src/observe/ring.ts";
import { mintDeviceToken } from "../src/auth.ts";

let hub: WsHub;
let storage: Storage;
let observe: ObservationRing;
let server: ReturnType<typeof createServer>;
let port: number;
let writeToken: string;
let readToken: string;

beforeEach(async () => {
  storage = openStorage(":memory:");
  const phone = mintDeviceToken();
  writeToken = phone.token;
  storage.createDevice({ id: "d1", name: "phone", tokenHash: phone.tokenHash, createdAt: 1 });
  const dashboard = mintDeviceToken();
  readToken = dashboard.token;
  storage.createDevice({
    id: "d2", name: "Dashboard", tokenHash: dashboard.tokenHash, createdAt: 1,
    kind: "observer", scope: "read",
  });
  observe = new ObservationRing({
    store: storage.observe, options: { enabled: true, retentionDays: 7 }, now: () => 1_700_000_000_000,
  });
  hub = new WsHub({
    storage,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1" },
    now: () => 1_000,
    authTimeoutMs: 500,
    heartbeatMs: 10_000,
    observe,
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
  storage.close();
});

interface Session {
  socket: WebSocket;
  frames: ServerFrame[];
  waitFor: (type: string, timeoutMs?: number) => Promise<ServerFrame>;
  close: () => void;
}

async function connect(token: string, subscribe?: readonly string[]): Promise<Session> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: ServerFrame[] = [];
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "auth", token }));
  const session: Session = {
    socket,
    frames,
    waitFor: async (type, timeoutMs = 1_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find((frame) => frame.type === type);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`no ${type} frame; saw ${frames.map((f) => f.type).join(", ")}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    close: () => socket.close(),
  };
  await session.waitFor("ready");
  if (subscribe !== undefined) {
    socket.send(JSON.stringify({ type: "observe_subscribe", kinds: subscribe }));
    // The hub answers a subscribe with nothing, so settle the frame before the test writes.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return session;
}

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the observe_sample frame", () => {
  it("is emitted on a ring write and carries the series, bot, at and value and nothing else", async () => {
    const session = await connect(readToken, ["observe_sample"]);
    observe.sample("ttft_ms", "cleo", 330);
    const frame = await session.waitFor("observe_sample");
    expect(Object.keys(frame).sort()).toEqual(["at", "bot", "series", "type", "value"]);
    expect(frame).toMatchObject({ type: "observe_sample", series: "ttft_ms", value: 330 });
    expect((frame as { bot: string }).bot).toBe(observe.identify("cleo"));
    session.close();
  });

  it("streams an event marker to a subscriber that asked for one", async () => {
    const session = await connect(readToken, ["observe_event"]);
    observe.event("tunnel_flap", null, null, { reason: "recovered", outage_ms: 12, consecutive: 1 });
    const frame = await session.waitFor("observe_event");
    expect(frame).toMatchObject({ type: "observe_event", kind: "tunnel_flap" });
    session.close();
  });

  it("reaches no observer that did not subscribe, and no write scoped client at all", async () => {
    const unsubscribed = await connect(readToken);
    const phone = await connect(writeToken, undefined);
    observe.sample("ttft_ms", "cleo", 330);
    await settle();
    expect(unsubscribed.frames.some((frame) => frame.type === "observe_sample")).toBe(false);
    expect(phone.frames.some((frame) => frame.type === "observe_sample")).toBe(false);
    unsubscribed.close();
    phone.close();
  });

  it("stops on unsubscribe", async () => {
    const session = await connect(readToken, ["observe_sample"]);
    observe.sample("ttft_ms", "cleo", 1);
    await session.waitFor("observe_sample");
    session.socket.send(JSON.stringify({ type: "observe_unsubscribe" }));
    await settle();
    const before = session.frames.length;
    observe.sample("ttft_ms", "cleo", 2);
    await settle();
    expect(session.frames.length).toBe(before);
    session.close();
  });
});

describe("bot_chat_delta is count only for a read scoped subscriber", () => {
  it("sends an observer the length and never the text, and leaves a phone's frame untouched", async () => {
    const observer = await connect(readToken, ["observe_chat_delta"]);
    const phone = await connect(writeToken);
    hub.broadcast({
      type: "bot_chat_delta", bot: "cleo", sessionId: "s1", turnId: "t1",
      text: "a secret sentence", seq: 3, updatedAt: 42,
    });
    const projected = await observer.waitFor("observe_chat_delta");
    expect(projected).toMatchObject({ bot: "cleo", turnId: "t1", seq: 3, textLength: 17 });
    expect(JSON.stringify(observer.frames)).not.toContain("a secret sentence");
    expect(observer.frames.some((frame) => frame.type === "bot_chat_delta")).toBe(false);
    const delta = await phone.waitFor("bot_chat_delta");
    expect(delta).toMatchObject({ text: "a secret sentence", sessionId: "s1" });
    observer.close();
    phone.close();
  });

  it("sends an unsubscribed observer no chat frame of either kind", async () => {
    const observer = await connect(readToken, ["observe_sample"]);
    hub.broadcast({
      type: "bot_chat_delta", bot: "cleo", sessionId: "s1", turnId: "t1",
      text: "quiet", seq: 1, updatedAt: 1,
    });
    await settle();
    expect(observer.frames.some((frame) => frame.type.endsWith("chat_delta"))).toBe(false);
    observer.close();
  });
});

describe("a read scoped socket is refused every non subscribe frame", () => {
  const commands = [
    { type: "mobile_node_advertise", foreground: true, commands: ["device.status"] },
    { type: "mobile_node_result", requestId: "r1", lease: "0".repeat(32), status: "ok" },
    { type: "mobile_node_progress", requestId: "r1", lease: "0".repeat(32), stage: "approved" },
  ];

  it("answers scope_read_only to each of them and keeps the socket open", async () => {
    const session = await connect(readToken);
    for (const command of commands) {
      session.socket.send(JSON.stringify(command));
      await settle(40);
      const errors = session.frames.filter((frame) => frame.type === "error");
      expect(errors.at(-1)).toMatchObject({ code: "scope_read_only" });
    }
    expect(session.socket.readyState).toBe(WebSocket.OPEN);
    session.close();
  });

  it("accepts subscribe, unsubscribe and sync from the same socket", async () => {
    const session = await connect(readToken);
    session.socket.send(JSON.stringify({ type: "observe_subscribe", kinds: ["observe_sample"] }));
    session.socket.send(JSON.stringify({ type: "observe_unsubscribe" }));
    session.socket.send(JSON.stringify({ type: "sync", threads: {} }));
    await session.waitFor("synced");
    expect(session.frames.filter((frame) => frame.type === "error")).toEqual([]);
    session.close();
  });

  it("refuses a subscribe frame naming a kind that is not on the closed list", async () => {
    const session = await connect(readToken);
    session.socket.send(JSON.stringify({ type: "observe_subscribe", kinds: ["everything"] }));
    const error = await session.waitFor("error");
    expect(error).toMatchObject({ code: "invalid_request" });
    session.close();
  });
});

describe("a subscriber that falls behind", () => {
  it("is bounded and told how many frames it missed rather than buffered without limit", async () => {
    const session = await connect(readToken, ["observe_sample"]);
    // Stall the socket by pausing the client's reads, then write far more than the per subscriber
    // bound, so the hub has to drop and count instead of growing.
    session.socket.pause();
    for (let index = 0; index < 4_000; index += 1) observe.sample("ttft_ms", "cleo", index);
    await settle(50);
    session.socket.resume();
    const gap = await session.waitFor("observe_gap", 3_000);
    expect((gap as { dropped: number }).dropped).toBeGreaterThan(0);
    session.close();
  });
});

import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachIngress, type AttachEvents } from "../src/adapters/attach/ingress.ts";
import type { AttachUpdate } from "../src/adapters/attach/protocol.ts";

interface Recorded {
  updates: Array<{ agentId: string; threadId: string; update: AttachUpdate }>;
  disconnects: string[];
  presence: Array<{ agentId: string; state: "online" | "absent" }>;
}

let server: Server;
let ingress: AttachIngress;
let recorded: Recorded;
let url: string;
const sockets: WebSocket[] = [];

function recorder(): AttachEvents {
  return {
    onUpdate: (agentId, threadId, update) => recorded.updates.push({ agentId, threadId, update }),
    onDisconnect: (agentId) => recorded.disconnects.push(agentId),
    onPresence: (agentId, state) => recorded.presence.push({ agentId, state }),
  };
}

function dial(token?: string): WebSocket {
  const socket = new WebSocket(`${url}/attach`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  sockets.push(socket);
  return socket;
}

async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2_000) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  recorded = { updates: [], disconnects: [], presence: [] };
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  url = `ws://127.0.0.1:${port}`;
  ingress = new AttachIngress({ tokens: new Map([["tok-a", "a1"]]), events: recorder() });
  ingress.attach(server);
});

afterEach(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  sockets.length = 0;
  ingress.close();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("AttachIngress", () => {
  it("rejects a connection with no bearer token (close 1008)", async () => {
    const socket = dial();
    const [code] = (await once(socket, "close")) as [number];
    expect(code).toBe(1008);
    expect(recorded.presence).toHaveLength(0);
  });

  it("rejects a connection with a wrong token (close 1008)", async () => {
    const socket = dial("wrong");
    const [code] = (await once(socket, "close")) as [number];
    expect(code).toBe(1008);
    expect(ingress.isAttached("a1")).toBe(false);
  });

  it("accepts a valid token, reports presence online, and isAttached", async () => {
    const socket = dial("tok-a");
    await once(socket, "open");
    await until(() => recorded.presence.length === 1);
    expect(recorded.presence[0]).toEqual({ agentId: "a1", state: "online" });
    expect(ingress.isAttached("a1")).toBe(true);
  });

  it("routes valid frames to onUpdate and drops malformed ones silently", async () => {
    const socket = dial("tok-a");
    await once(socket, "open");
    socket.send("not json");
    socket.send(JSON.stringify({ threadId: "t1", update: { kind: "working" } }));
    socket.send(JSON.stringify({ threadId: "t1", update: { kind: "done", turnId: "x" } }));
    await until(() => recorded.updates.length === 1);
    expect(recorded.updates[0]).toEqual({
      agentId: "a1",
      threadId: "t1",
      update: { kind: "done", turnId: "x" },
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("delivers turn frames to the attached socket and reports false when absent", async () => {
    expect(ingress.sendTurn("a1", { kind: "turn", threadId: "t1", turnId: "u1", text: "hi" })).toBe(false);
    const socket = dial("tok-a");
    await once(socket, "open");
    await until(() => ingress.isAttached("a1"));
    const received: unknown[] = [];
    socket.on("message", (data) => received.push(JSON.parse(String(data))));
    expect(ingress.sendTurn("a1", { kind: "turn", threadId: "t1", turnId: "u1", text: "hi" })).toBe(true);
    await until(() => received.length === 1);
    expect(received[0]).toEqual({ kind: "turn", threadId: "t1", turnId: "u1", text: "hi" });
  });

  it("reports absent and onDisconnect when the connection closes", async () => {
    const socket = dial("tok-a");
    await once(socket, "open");
    await until(() => ingress.isAttached("a1"));
    socket.close();
    await until(() => recorded.disconnects.length === 1);
    expect(recorded.presence).toEqual([
      { agentId: "a1", state: "online" },
      { agentId: "a1", state: "absent" },
    ]);
    expect(ingress.isAttached("a1")).toBe(false);
  });

  it("supersedes an existing connection: old socket closes 4000, turns fail, presence stays online", async () => {
    const first = dial("tok-a");
    await once(first, "open");
    await until(() => ingress.isAttached("a1"));
    const second = dial("tok-a");
    // Register the listener before awaiting first's close: second's open (a single-hop upgrade
    // response already in flight) reliably resolves before first's close (a full close-frame
    // round trip), so `once(second, "open")` called AFTER the close await would miss an event
    // that already fired.
    const secondOpen = once(second, "open");
    const [code] = (await once(first, "close")) as [number];
    expect(code).toBe(4000);
    await secondOpen;
    // The supersede fired onDisconnect exactly once (for the old connection's turns) and never
    // reported the agent absent.
    await until(() => recorded.disconnects.length === 1);
    expect(recorded.presence.filter((p) => p.state === "absent")).toHaveLength(0);
    expect(ingress.isAttached("a1")).toBe(true);
    const received: unknown[] = [];
    second.on("message", (data) => received.push(JSON.parse(String(data))));
    ingress.sendTurn("a1", { kind: "turn", threadId: "t1", turnId: "u2", text: "again" });
    await until(() => received.length === 1);
  });

  it("close() shuts every connection down with 1001", async () => {
    const socket = dial("tok-a");
    await once(socket, "open");
    ingress.close();
    const [code] = (await once(socket, "close")) as [number];
    expect(code).toBe(1001);
  });
});

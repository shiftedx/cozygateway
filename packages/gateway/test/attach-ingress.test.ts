import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachIngress, type AttachEvents } from "../src/adapters/attach/ingress.ts";
import type { AttachUpdate } from "../src/adapters/attach/protocol.ts";

/** A counter that resolves a promise the instant it reaches a target count, driven directly by
 *  the same synchronous callback that appends to the recorded array it tracks. Lets tests await
 *  an exact event count with zero polling and zero added latency: `bump()` and any waiter it
 *  satisfies run in the same tick as the production code that reports the event. */
interface EventCounter {
  bump(): void;
  waitFor(count: number): Promise<void>;
}

function makeCounter(): EventCounter {
  let length = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    bump(): void {
      length += 1;
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i];
        if (waiter !== undefined && length >= waiter.count) {
          waiters.splice(i, 1);
          waiter.resolve();
        }
      }
    },
    waitFor(count: number): Promise<void> {
      if (length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
  };
}

interface Recorded {
  updates: Array<{ agentId: string; threadId: string; update: AttachUpdate }>;
  disconnects: string[];
  presence: Array<{ agentId: string; state: "online" | "absent" }>;
  disconnectCount: EventCounter;
  presenceCount: EventCounter;
}

let server: Server;
let ingress: AttachIngress;
let recorded: Recorded;
let url: string;
const sockets: WebSocket[] = [];

function recorder(): AttachEvents {
  return {
    onUpdate: (agentId, threadId, update) => recorded.updates.push({ agentId, threadId, update }),
    onDisconnect: (agentId) => {
      recorded.disconnects.push(agentId);
      recorded.disconnectCount.bump();
    },
    onPresence: (agentId, state) => {
      recorded.presence.push({ agentId, state });
      recorded.presenceCount.bump();
    },
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
  recorded = {
    updates: [],
    disconnects: [],
    presence: [],
    disconnectCount: makeCounter(),
    presenceCount: makeCounter(),
  };
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  url = `ws://127.0.0.1:${port}`;
  ingress = new AttachIngress({ tokens: new Map([["tok-a", "a1"]]), events: recorder() });
  server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
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
    // Deterministic wait for the initial attach (no polling): the counter resolves the instant
    // onPresence fires, in the same tick as the production callback.
    await recorded.presenceCount.waitFor(1);
    expect(ingress.isAttached("a1")).toBe(true);

    // Register every listener the assertions below depend on BEFORE dialing the superseding
    // connection, so no event this test awaits can fire and be missed before the await starts.
    const firstClose = once(first, "close");
    const disconnectedOnce = recorded.disconnectCount.waitFor(1);
    const second = dial("tok-a");
    const secondOpen = once(second, "open");

    // Ordering proof, each step awaited on the actual production event, no sleeps or polling:
    // 1. ws writes the new connection's 101 upgrade response to the socket before invoking the
    //    'connection' callback, so by the time that callback runs the ingress's supersede (and
    //    the old connection's disconnect) happens after the new socket's upgrade bytes are
    //    already on the wire -- the client just hasn't parsed them into an 'open' event yet.
    //    disconnectedOnce is still the earliest event this test can observe, and it is
    //    guaranteed to resolve before both awaits below.
    await disconnectedOnce;
    // 2. The old socket actually receives the supersede close, and with the frozen code.
    const [code] = (await firstClose) as [number];
    expect(code).toBe(4000);
    // 3. The new connection is accepted at the WebSocket level.
    await secondOpen;

    // The ordered handover produced exactly one onDisconnect (the superseded connection) and
    // never flipped presence: the agent's only presence transition, ever, is the original
    // online attach. This fails if a future regression re-flips presence to absent anywhere
    // in the handover, and fails if the close code changes.
    expect(recorded.disconnects).toEqual(["a1"]);
    expect(recorded.presence).toEqual([{ agentId: "a1", state: "online" }]);
    expect(ingress.isAttached("a1")).toBe(true);

    // Prove the handover is live end-to-end. The load-bearing assertions already ran above;
    // this extra round trip on the surviving connection is best-effort, not a barrier -- it
    // just gives a late, incorrect presence flip a bit more room to surface before the final
    // invariant check below.
    const received: unknown[] = [];
    second.on("message", (data) => received.push(JSON.parse(String(data))));
    expect(
      ingress.sendTurn("a1", { kind: "turn", threadId: "t1", turnId: "u2", text: "again" }),
    ).toBe(true);
    await once(second, "message");
    expect(received).toEqual([{ kind: "turn", threadId: "t1", turnId: "u2", text: "again" }]);

    // Final invariant: across the whole handover, presence never reported the agent absent.
    expect(recorded.presence.filter((p) => p.state === "absent")).toHaveLength(0);
  });

  it("close() shuts every connection down with 1001", async () => {
    const socket = dial("tok-a");
    await once(socket, "open");
    ingress.close();
    const [code] = (await once(socket, "close")) as [number];
    expect(code).toBe(1001);
  });
});

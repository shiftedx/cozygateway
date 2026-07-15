import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage } from "../src/storage.ts";
import { TurnRunner, nullNotifier, type Notifier } from "../src/turns.ts";
import { createMockAdapter } from "../src/adapters/mock.ts";
import type { BackendAdapter, BackendSession } from "../src/adapters/types.ts";
import { BackendUnavailable } from "../src/errors.ts";

/** An adapter whose turn stalls on `gate`: it drafts immediately (so a test can observe the
 *  turn is in flight), then waits for the gate before committing. */
function gatedAdapter(gate: Promise<void>): BackendAdapter {
  const session: BackendSession = {
    async send(blocks, handlers) {
      handlers.onDraft({ blocks, toolCalls: [] });
      await gate;
      handlers.onCommit({ blocks });
      handlers.onDone();
    },
    async close() {},
  };
  return {
    backend: "gated",
    midTurnDelivery: "queue",
    async startSession() {
      return session;
    },
    presence: () => "online",
  };
}

/** Mirrors WsHub.connectedDeviceIds(): a fresh snapshot, not a live boolean. `opts.clients`
 *  chooses whether the stub hub reports device "d1" as connected. */
function setup(opts?: { clients?: boolean; notifier?: Notifier }) {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "a1", name: "Mock", avatar: null, backend: "mock" });
  storage.createThread({ id: "t1", agentId: "a1", title: "T", createdAt: 1 });
  const frames: ServerFrame[] = [];
  const runner = new TurnRunner({
    storage,
    hub: {
      broadcast: (f) => frames.push(f),
      connectedDeviceIds: () => (opts?.clients ?? true ? new Set(["d1"]) : new Set()),
    },
    adapters: new Map([["a1", createMockAdapter()]]),
    notifier: opts?.notifier ?? nullNotifier,
    now: () => 42,
  });
  return { storage, frames, runner };
}

async function untilFrames(frames: ServerFrame[], predicate: (fs: ServerFrame[]) => boolean) {
  const start = Date.now();
  while (!predicate(frames)) {
    if (Date.now() - start > 2_000) throw new Error(`timeout; saw ${JSON.stringify(frames)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("TurnRunner", () => {
  it("persists the user message, streams drafts, commits the echo, and signals done", async () => {
    const { storage, frames, runner } = setup();
    const user = runner.submitUserMessage("t1", [{ type: "paragraph", text: "hi" }]);
    expect(user.seq).toBe(1);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "done"));

    const types = frames.map((f) => f.type);
    expect(types[0]).toBe("committed"); // the user's own message
    expect(types.filter((t) => t === "draft")).toHaveLength(2);
    const committedAgent = frames.find((f) => f.type === "committed" && f.message.role === "agent");
    expect(committedAgent !== undefined && committedAgent.type === "committed").toBe(true);
    if (committedAgent !== undefined && committedAgent.type === "committed") {
      expect(committedAgent.message.blocks).toEqual([{ type: "paragraph", text: "Echo: hi" }]);
      expect(committedAgent.seq).toBe(2);
    }
    expect(types.indexOf("done")).toBeGreaterThan(types.lastIndexOf("draft"));
    expect(storage.messagesSince("t1", 0)).toHaveLength(2);
  });

  it("writes a turn.failed marker and an error frame when the adapter rejects", async () => {
    const { storage, frames, runner } = setup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "please [[fail]]" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "error"));

    const marker = storage.messagesSince("t1", 0).find((m) => m.marker === "turn.failed");
    expect(marker?.role).toBe("system");
    const errorFrame = frames.find((f) => f.type === "error");
    expect(errorFrame !== undefined && errorFrame.type === "error" && errorFrame.code === "turn_failed").toBe(true);
    expect(frames.some((f) => f.type === "done")).toBe(false);
  });

  it("always notifies at commit, passing the hub's connected-device snapshot through unchanged", async () => {
    // Per-device targeting (issue #11) moved the "who gets pushed" decision out of the turn
    // runner and into the notifier, which filters against this same snapshot. The runner's
    // only job is to call notify every time and hand over whatever the hub reports right now.
    const calls: Array<{ preview: string; connectedDeviceIds: ReadonlySet<string> }> = [];
    const notifier: Notifier = {
      notify: (e, connectedDeviceIds) => calls.push({ preview: e.preview, connectedDeviceIds }),
    };

    const connected = setup({ clients: true, notifier });
    connected.runner.submitUserMessage("t1", [{ type: "paragraph", text: "a" }]);
    await untilFrames(connected.frames, (fs) => fs.some((f) => f.type === "done"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.preview).toBe("Echo: a");
    expect(calls[0]?.connectedDeviceIds).toEqual(new Set(["d1"]));

    const empty = setup({ clients: false, notifier });
    empty.runner.submitUserMessage("t1", [{ type: "paragraph", text: "b" }]);
    await untilFrames(empty.frames, (fs) => fs.some((f) => f.type === "done"));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.preview).toBe("Echo: b");
    expect(calls[1]?.connectedDeviceIds).toEqual(new Set());
  });

  it("fires notify synchronously inside onCommit, after the committed broadcast and before done", async () => {
    const order: string[] = [];
    const notifier: Notifier = { notify: () => order.push("notify") };
    const storage = openStorage(":memory:");
    storage.upsertAgent({ id: "a1", name: "Mock", avatar: null, backend: "mock" });
    storage.createThread({ id: "t1", agentId: "a1", title: "T", createdAt: 1 });
    const runner = new TurnRunner({
      storage,
      hub: {
        broadcast: (f) => order.push(f.type === "committed" && f.message.role === "agent" ? "committed-agent" : f.type),
        connectedDeviceIds: () => new Set(),
      },
      adapters: new Map([["a1", createMockAdapter()]]),
      notifier,
      now: () => 42,
    });
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "hi" }]);
    const start = Date.now();
    while (!order.includes("done")) {
      if (Date.now() - start > 2_000) throw new Error(`timeout; saw ${JSON.stringify(order)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(order.indexOf("notify")).toBeGreaterThan(order.indexOf("committed-agent"));
    expect(order.indexOf("notify")).toBeLessThan(order.indexOf("done"));
  });

  it("throws BackendUnavailable for an agent with no adapter", () => {
    const { storage } = setup();
    storage.upsertAgent({ id: "ghost", name: "G", avatar: null, backend: "mock" });
    storage.createThread({ id: "t2", agentId: "ghost", title: "T2", createdAt: 1 });
    const runner = new TurnRunner({
      storage,
      hub: { broadcast: () => {}, connectedDeviceIds: () => new Set() },
      adapters: new Map(),
      notifier: nullNotifier,
      now: () => 42,
    });
    expect(() => runner.submitUserMessage("t2", [{ type: "paragraph", text: "x" }])).toThrow(
      BackendUnavailable,
    );
  });

  it("serializes two rapid sends on one thread (no interleaved turns)", async () => {
    const { frames, runner } = setup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "two" }]);
    await untilFrames(frames, (fs) => fs.filter((f) => f.type === "done").length === 2);
    const agentCommits = frames.filter((f) => f.type === "committed" && f.message.role === "agent");
    expect(
      agentCommits.map((f) => (f.type === "committed" ? f.message.blocks[0] : undefined)),
    ).toEqual([
      { type: "paragraph", text: "Echo: one" },
      { type: "paragraph", text: "Echo: two" },
    ]);
  });

  it("runs turns on different threads concurrently", async () => {
    const storage = openStorage(":memory:");
    storage.upsertAgent({ id: "slow", name: "Slow", avatar: null, backend: "gated" });
    storage.upsertAgent({ id: "fast", name: "Fast", avatar: null, backend: "mock" });
    storage.createThread({ id: "ta", agentId: "slow", title: "A", createdAt: 1 });
    storage.createThread({ id: "tb", agentId: "fast", title: "B", createdAt: 1 });
    let releaseA = () => {};
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const frames: ServerFrame[] = [];
    const runner = new TurnRunner({
      storage,
      hub: { broadcast: (f) => frames.push(f), connectedDeviceIds: () => new Set() },
      adapters: new Map<string, BackendAdapter>([
        ["slow", gatedAdapter(gateA)],
        ["fast", createMockAdapter()],
      ]),
      notifier: nullNotifier,
      now: () => 42,
    });

    runner.submitUserMessage("ta", [{ type: "paragraph", text: "a" }]);
    runner.submitUserMessage("tb", [{ type: "paragraph", text: "b" }]);

    // Thread B finishes while thread A's turn is still gated mid-flight.
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "done" && f.threadId === "tb"));
    expect(frames.some((f) => f.type === "draft" && f.threadId === "ta")).toBe(true);
    expect(frames.some((f) => f.type === "done" && f.threadId === "ta")).toBe(false);

    releaseA();
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "done" && f.threadId === "ta"));
  });

  it("continues the chain: a failed turn is followed by a successful one on the same thread", async () => {
    const { storage, frames, runner } = setup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "boom [[fail]]" }]);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "after" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "done"));

    const types = frames.map((f) => f.type);
    expect(types.indexOf("error")).toBeGreaterThan(-1);
    const echoAfter = frames.findIndex(
      (f) =>
        f.type === "committed" &&
        f.message.role === "agent" &&
        f.message.blocks[0]?.type === "paragraph" &&
        f.message.blocks[0].text === "Echo: after",
    );
    expect(echoAfter).toBeGreaterThan(types.indexOf("error"));
    const messages = storage.messagesSince("t1", 0);
    expect(messages.some((m) => m.marker === "turn.failed")).toBe(true);
    expect(messages.some((m) => m.role === "agent")).toBe(true);
  });

  it("closeAll drains in-flight turns before closing sessions", async () => {
    const storage = openStorage(":memory:");
    storage.upsertAgent({ id: "slow", name: "Slow", avatar: null, backend: "gated" });
    storage.createThread({ id: "ta", agentId: "slow", title: "A", createdAt: 1 });
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const frames: ServerFrame[] = [];
    const runner = new TurnRunner({
      storage,
      hub: { broadcast: (f) => frames.push(f), connectedDeviceIds: () => new Set() },
      adapters: new Map<string, BackendAdapter>([["slow", gatedAdapter(gate)]]),
      notifier: nullNotifier,
      now: () => 42,
    });

    runner.submitUserMessage("ta", [{ type: "paragraph", text: "a" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));

    let closed = false;
    const closing = runner.closeAll().then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(closed).toBe(false); // still waiting on the gated in-flight turn

    release();
    await closing;
    expect(frames.some((f) => f.type === "committed" && f.message.role === "agent")).toBe(true);
  });
});

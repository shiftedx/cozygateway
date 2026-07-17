import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage } from "../src/storage.ts";
import { TurnRunner, nullNotifier, type Notifier } from "../src/turns.ts";
import { createMockAdapter, createSteerMockAdapter } from "../src/adapters/mock.ts";
import type { BackendAdapter, BackendSession, TurnHandlers } from "../src/adapters/types.ts";
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

function steerSetup() {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "s1", name: "Steer", avatar: null, backend: "mock-steer" });
  storage.createThread({ id: "t1", agentId: "s1", title: "T", createdAt: 1 });
  const frames: ServerFrame[] = [];
  const runner = new TurnRunner({
    storage,
    hub: { broadcast: (f) => frames.push(f), connectedDeviceIds: () => new Set() },
    adapters: new Map<string, BackendAdapter>([["s1", createSteerMockAdapter()]]),
    notifier: nullNotifier,
    now: () => 42,
  });
  return { storage, frames, runner };
}

const draftTurnIds = (fs: ServerFrame[]): string[] =>
  fs.filter((f): f is Extract<ServerFrame, { type: "draft" }> => f.type === "draft").map((d) => d.turnId);

describe("TurnRunner mid-turn delivery", () => {
  it("steers a mid-turn send into the in-flight turn under the same turnId, delivery steer", async () => {
    const { storage, frames, runner } = steerSetup();
    const first = runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    expect(first.delivery).toBeUndefined();
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));

    const steered = runner.submitUserMessage("t1", [{ type: "paragraph", text: "two" }]);
    expect(steered.delivery).toBe("steer");
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "done"));

    expect(new Set(draftTurnIds(frames)).size).toBe(1); // no new turnId minted for the steer
    const agentCommit = frames.find((f) => f.type === "committed" && f.message.role === "agent");
    expect(agentCommit?.type === "committed" ? agentCommit.message.blocks : undefined).toEqual([
      { type: "paragraph", text: "Working: one + two" },
    ]);
    // The steer user message persisted with delivery "steer"; the first with none.
    const users = storage.messagesSince("t1", 0).filter((m) => m.role === "user");
    expect(users.map((m) => m.delivery)).toEqual([undefined, "steer"]);
  });

  it("interrupt on a steer-capable in-flight turn commits turn.interrupted then done, no error frame", async () => {
    const { storage, frames, runner } = steerSetup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));

    expect(runner.interrupt("t1")).toBe("interrupting");
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "done"));

    const sys = storage.messagesSince("t1", 0).find((m) => m.marker === "turn.interrupted");
    expect(sys?.role).toBe("system");
    expect(frames.some((f) => f.type === "error")).toBe(false);
    const types = frames.map((f) => f.type);
    const sysIdx = frames.findIndex((f) => f.type === "committed" && f.message.role === "system");
    expect(types.lastIndexOf("done")).toBeGreaterThan(sysIdx);
  });

  it("interrupt on an idle thread returns idle and broadcasts nothing new", () => {
    const { frames, runner } = steerSetup();
    expect(runner.interrupt("t1")).toBe("idle");
    expect(frames).toHaveLength(0);
  });

  it("a mid-turn send that loses the race (turn already done) queues normally with delivery absent", async () => {
    // The mock echo (queue backend) finishes its turn synchronously-ish; a second send after the
    // first turn's done sees no in-flight record and queues, committing with delivery absent.
    const { frames, runner } = setup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    await untilFrames(frames, (fs) => fs.filter((f) => f.type === "done").length === 1);
    const second = runner.submitUserMessage("t1", [{ type: "paragraph", text: "two" }]);
    expect(second.delivery).toBeUndefined();
  });

  it("interrupt on a queue-only in-flight turn returns unsupported and emits interrupt_unsupported", async () => {
    const storage = openStorage(":memory:");
    storage.upsertAgent({ id: "slow", name: "Slow", avatar: null, backend: "gated" });
    storage.createThread({ id: "t1", agentId: "slow", title: "T", createdAt: 1 });
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
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));

    expect(runner.interrupt("t1")).toBe("unsupported");
    const err = frames.find((f) => f.type === "error");
    expect(err?.type === "error" ? err.code : undefined).toBe("interrupt_unsupported");
    expect(err?.type === "error" ? err.message : undefined).toBe("interrupt unsupported");
    // The turn is NOT interrupted: it still completes normally when released.
    release();
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "committed" && f.message.role === "agent"));
    expect(storage.messagesSince("t1", 0).some((m) => m.marker === "turn.interrupted")).toBe(false);
  });
});

describe("TurnRunner stop-phrase send path", () => {
  it("a whole-message stop interrupts the in-flight steer turn AND queues a normal next turn", async () => {
    const { storage, frames, runner } = steerSetup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "long task" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));

    // "stop" commits as a normal user message (delivery absent) and interrupts the in-flight turn.
    const stop = runner.submitUserMessage("t1", [{ type: "paragraph", text: "stop" }]);
    expect(stop.delivery).toBeUndefined();

    await untilFrames(frames, (fs) =>
      fs.some((f) => f.type === "committed" && f.message.marker === "turn.interrupted"),
    );
    // The stop message itself becomes the next queued turn (mock-steer draws "Working: stop").
    await untilFrames(frames, (fs) =>
      fs.some((f) => f.type === "draft" && f.blocks.some((b) => b.type === "paragraph" && b.text === "Working: stop")),
    );
    const users = storage.messagesSince("t1", 0).filter((m) => m.role === "user");
    expect(users.map((m) => m.delivery)).toEqual([undefined, undefined]);
  });

  it("a message that merely contains 'stop' steers instead of interrupting", async () => {
    const { frames, runner } = steerSetup();
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "one" }]);
    await untilFrames(frames, (fs) => fs.some((f) => f.type === "draft"));
    const sent = runner.submitUserMessage("t1", [
      { type: "paragraph", text: "stop adding comments to every file" },
    ]);
    expect(sent.delivery).toBe("steer");
  });
});

/** A steer-capable, interruptible session whose send() never settles on its own. The test drives
 *  settlement explicitly: rejectSend() mirrors the attach adapter failing the in-flight send when
 *  it is interrupted; finishSend() mirrors a clean completion (commit + done, then resolve).
 *  interrupt is a spy so a test can assert exactly how many times the runner called it. */
function controllableSteerAdapter() {
  let rejectSend: (err: Error) => void = () => {};
  let resolveSend: () => void = () => {};
  let handlers: TurnHandlers | undefined;
  const interrupt = vi.fn(async () => {});
  const session: BackendSession = {
    send(blocks, h) {
      handlers = h;
      h.onDraft({ blocks, toolCalls: [] });
      return new Promise<void>((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
      });
    },
    async steer() {},
    interrupt,
    async close() {},
  };
  const adapter: BackendAdapter = {
    backend: "controllable-steer",
    midTurnDelivery: "steer",
    async startSession() {
      return session;
    },
    presence: () => "online",
  };
  return {
    adapter,
    interrupt,
    rejectSend: (err: Error) => rejectSend(err),
    finishSend: () => {
      handlers?.onCommit({ blocks: [{ type: "paragraph", text: "done" }] });
      handlers?.onDone();
      resolveSend();
    },
  };
}

/** A queue-only session (no steer, no interrupt) whose send() never settles on its own. Proves the
 *  wall-clock timer is never armed for a backend that cannot be interrupted, so expiry emits no
 *  interrupt_unsupported frame. */
function controllableQueueAdapter() {
  const session: BackendSession = {
    send(blocks, h) {
      h.onDraft({ blocks, toolCalls: [] });
      return new Promise<void>(() => {
        // never settles on its own
      });
    },
    async close() {},
  };
  const adapter: BackendAdapter = {
    backend: "controllable-queue",
    midTurnDelivery: "queue",
    async startSession() {
      return session;
    },
    presence: () => "online",
  };
  return { adapter };
}

function wallClockSetup(adapter: BackendAdapter, turnTimeoutMs: number) {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "a1", name: "A", avatar: null, backend: adapter.backend });
  storage.createThread({ id: "t1", agentId: "a1", title: "T", createdAt: 1 });
  const frames: ServerFrame[] = [];
  const runner = new TurnRunner({
    storage,
    hub: { broadcast: (f) => frames.push(f), connectedDeviceIds: () => new Set() },
    adapters: new Map<string, BackendAdapter>([["a1", adapter]]),
    notifier: nullNotifier,
    now: () => 42,
    turnTimeoutMs,
  });
  return { storage, frames, runner };
}

/** Flush the microtask queue so the runner's async turn reaches its in-flight state (session
 *  started, timer armed, send() awaited). Promises are not faked by vi.useFakeTimers(). */
async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("TurnRunner wall-clock bound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("interrupts a steer-capable turn that outruns the bound, committing the time-limit marker and a done frame", async () => {
    const fake = controllableSteerAdapter();
    const { storage, frames, runner } = wallClockSetup(fake.adapter, 600_000);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await flushMicrotasks();

    // Not yet expired: the timer has not fired.
    expect(fake.interrupt).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.interrupt).toHaveBeenCalledTimes(1);

    // The attach adapter's interrupt() fails the in-flight send; mirror that failure here.
    fake.rejectSend(new Error("interrupted"));
    await flushMicrotasks();

    const marker = storage.messagesSince("t1", 0).find((m) => m.marker === "turn.interrupted");
    expect(marker?.role).toBe("system");
    expect(marker?.blocks[0]).toEqual({
      type: "paragraph",
      text: "The turn exceeded the time limit and was interrupted.",
    });
    expect(frames.some((f) => f.type === "committed" && f.message.marker === "turn.interrupted")).toBe(true);
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(frames.some((f) => f.type === "error")).toBe(false);
  });

  it("does not interrupt or emit extra frames when the turn completes before the bound", async () => {
    const fake = controllableSteerAdapter();
    const { frames, runner } = wallClockSetup(fake.adapter, 600_000);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await flushMicrotasks();

    fake.finishSend();
    await flushMicrotasks();
    expect(frames.some((f) => f.type === "done")).toBe(true);
    const frameCountAfterDone = frames.length;

    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(fake.interrupt).not.toHaveBeenCalled();
    expect(frames).toHaveLength(frameCountAfterDone);
  });

  it("never arms the timer when turnTimeoutMs is 0 (disabled)", async () => {
    const fake = controllableSteerAdapter();
    const { frames, runner } = wallClockSetup(fake.adapter, 0);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(fake.interrupt).not.toHaveBeenCalled();
    expect(frames.some((f) => f.type === "done")).toBe(false);
    expect(frames.some((f) => f.type === "committed" && f.message.marker === "turn.interrupted")).toBe(false);
  });

  it("never arms the timer for a queue-only backend, so expiry emits no interrupt_unsupported frame", async () => {
    const fake = controllableQueueAdapter();
    const { frames, runner } = wallClockSetup(fake.adapter, 600_000);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(frames.some((f) => f.type === "error" && f.code === "interrupt_unsupported")).toBe(false);
    expect(frames.some((f) => f.type === "done")).toBe(false);
  });

  it("uses the plain interrupted text for a manual interrupt and does not double-fire the timer afterward", async () => {
    const fake = controllableSteerAdapter();
    const { storage, frames, runner } = wallClockSetup(fake.adapter, 600_000);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await flushMicrotasks();

    expect(runner.interrupt("t1")).toBe("interrupting");
    // The attach adapter's interrupt() fails the in-flight send; mirror that failure here.
    fake.rejectSend(new Error("interrupted by user"));
    await flushMicrotasks();

    const marker = storage.messagesSince("t1", 0).find((m) => m.marker === "turn.interrupted");
    expect(marker?.blocks[0]).toEqual({ type: "paragraph", text: "The turn was interrupted." });
    expect(fake.interrupt).toHaveBeenCalledTimes(1);

    // The bound must not fire a second interrupt on the already-finished turn.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.interrupt).toHaveBeenCalledTimes(1);
    expect(frames.filter((f) => f.type === "done")).toHaveLength(1);
  });
});

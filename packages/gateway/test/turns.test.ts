import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage } from "../src/storage.ts";
import { TurnRunner, nullNotifier, type Notifier } from "../src/turns.ts";
import { createMockAdapter } from "../src/adapters/mock.ts";
import { BackendUnavailable } from "../src/errors.ts";

function setup(opts?: { clients?: boolean; notifier?: Notifier }) {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "a1", name: "Mock", avatar: null, backend: "mock" });
  storage.createThread({ id: "t1", agentId: "a1", title: "T", createdAt: 1 });
  const frames: ServerFrame[] = [];
  const runner = new TurnRunner({
    storage,
    hub: { broadcast: (f) => frames.push(f), hasClients: () => opts?.clients ?? true },
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

  it("notifies when no client is connected, not when one is", async () => {
    const notified: string[] = [];
    const notifier: Notifier = { notify: (e) => notified.push(e.preview) };

    const connected = setup({ clients: true, notifier });
    connected.runner.submitUserMessage("t1", [{ type: "paragraph", text: "a" }]);
    await untilFrames(connected.frames, (fs) => fs.some((f) => f.type === "done"));
    expect(notified).toHaveLength(0);

    const empty = setup({ clients: false, notifier });
    empty.runner.submitUserMessage("t1", [{ type: "paragraph", text: "b" }]);
    await untilFrames(empty.frames, (fs) => fs.some((f) => f.type === "done"));
    expect(notified).toEqual(["Echo: b"]);
  });

  it("throws BackendUnavailable for an agent with no adapter", () => {
    const { storage } = setup();
    storage.upsertAgent({ id: "ghost", name: "G", avatar: null, backend: "mock" });
    storage.createThread({ id: "t2", agentId: "ghost", title: "T2", createdAt: 1 });
    const runner = new TurnRunner({
      storage,
      hub: { broadcast: () => {}, hasClients: () => true },
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
});

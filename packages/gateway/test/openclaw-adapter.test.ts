import { describe, expect, it, vi } from "vitest";
import type { RichBlock } from "cozygateway-contract";

import { createOpenClawAdapter, DEFAULT_TURN_TIMEOUT_SECONDS } from "../src/adapters/openclaw/adapter.ts";
import type { TurnHandlers } from "../src/adapters/types.ts";
import type {
  ClientState,
  OpenClawClient,
  SessionHandlers,
  SessionToolCall,
} from "../src/adapters/openclaw/client.ts";
import type { ServerFrame } from "../src/adapters/openclaw/protocol.ts";

/** A plain-object fake implementing the full `OpenClawClient` interface, with test-only helper
 *  methods to drive the delta/end/drop callbacks a real client would deliver through
 *  `subscribeSession`. No socket, no server: adapter tests exercise only the adapter's own
 *  bookkeeping against this fake's recorded calls and callback surface. */
class FakeOpenClawClient implements OpenClawClient {
  private currentState: ClientState = "online";
  private sessionCounter = 0;
  private readonly subscriptions = new Map<string, SessionHandlers>();
  private chatSendRejects = false;

  readonly requests: Array<{ method: string; params: unknown }> = [];
  /** sessionKey returned by each successive `sessions.create` call, in call order. */
  readonly sessionKeys: string[] = [];

  state(): ClientState {
    return this.currentState;
  }

  setState(next: ClientState): void {
    this.currentState = next;
  }

  setChatSendRejects(rejects: boolean): void {
    this.chatSendRejects = rejects;
  }

  request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "sessions.create") {
      this.sessionCounter += 1;
      const sessionKey = `session-${this.sessionCounter}`;
      this.sessionKeys.push(sessionKey);
      return Promise.resolve({ sessionKey });
    }
    if (method === "chat.send") {
      if (this.chatSendRejects) return Promise.reject(new Error("boom"));
      return Promise.resolve({});
    }
    return Promise.resolve({});
  }

  onEvent(_handler: (frame: ServerFrame) => void): void {}

  subscribeSession(sessionKey: string, handlers: SessionHandlers): () => void {
    this.subscriptions.set(sessionKey, handlers);
    return () => {
      if (this.subscriptions.get(sessionKey) === handlers) this.subscriptions.delete(sessionKey);
    };
  }

  onStateChange(_handler: (state: ClientState) => void): void {}

  start(): void {}

  async close(): Promise<void> {}

  // --- test-only event drivers, mirroring what the real client's subscribeSession delivers ---

  emitDelta(sessionKey: string, snapshot: string): void {
    this.subscriptions.get(sessionKey)?.onDelta(snapshot);
  }

  emitDone(sessionKey: string): void {
    this.subscriptions.get(sessionKey)?.onDone();
  }

  emitError(sessionKey: string, message: string): void {
    this.subscriptions.get(sessionKey)?.onError(message);
  }

  emitToolCalls(sessionKey: string, toolCalls: SessionToolCall[]): void {
    this.subscriptions.get(sessionKey)?.onToolCalls(toolCalls);
  }

  isSubscribed(sessionKey: string): boolean {
    return this.subscriptions.has(sessionKey);
  }
}

interface Observed {
  drafts: Array<{ blocks: RichBlock[]; toolCalls: unknown[] }>;
  commits: RichBlock[][];
  done: number;
}

function observer(): { handlers: TurnHandlers; observed: Observed } {
  const observed: Observed = { drafts: [], commits: [], done: 0 };
  return {
    observed,
    handlers: {
      onDraft: (update) => observed.drafts.push(update),
      onCommit: (final) => observed.commits.push(final.blocks),
      onDone: () => {
        observed.done += 1;
      },
    },
  };
}

describe("createOpenClawAdapter", () => {
  it("presence() maps client state: online -> online, anything else -> absent", () => {
    const client = new FakeOpenClawClient();
    const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 1_000 });
    client.setState("online");
    expect(adapter.presence()).toBe("online");
    client.setState("connecting");
    expect(adapter.presence()).toBe("absent");
    client.setState("absent");
    expect(adapter.presence()).toBe("absent");
  });

  // (a) a full turn yields throttled rich drafts then one commit+done; drafts carry the current
  // chip snapshot, empty here because no tools ran.
  it("streams throttled drafts then commits, with drafts carrying the current chip snapshot (empty when no tools ran), flushing the pending draft before commit", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeOpenClawClient();
      const adapter = createOpenClawAdapter({
        agentId: "a1",
        client,
        turnTimeoutMs: 5_000,
        draftFlushMs: 100,
      });
      const session = await adapter.startSession("t1");
      const sessionKey = client.sessionKeys[0]!;
      const { handlers, observed } = observer();

      const turn = session.send([{ type: "paragraph", text: "hi" }], handlers);
      expect(client.requests.some((r) => r.method === "chat.send")).toBe(true);

      // Burst of deltas inside one throttle window: only the last-scheduled flush should fire.
      client.emitDelta(sessionKey, "Hel");
      client.emitDelta(sessionKey, "Hello");
      await vi.advanceTimersByTimeAsync(100);

      // A further delta starts a new throttle window, but the reply ends before that window's
      // timer fires: the pending draft must still flush (not be dropped) before commit.
      client.emitDelta(sessionKey, "Hello there");
      client.emitDone(sessionKey);

      await turn;

      expect(observed.drafts).toEqual([
        { blocks: [{ type: "paragraph", text: "Hello" }], toolCalls: [] },
        { blocks: [{ type: "paragraph", text: "Hello there" }], toolCalls: [] },
      ]);
      expect(observed.commits).toEqual([[{ type: "paragraph", text: "Hello there" }]]);
      expect(observed.done).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // (b) send while absent rejects /not attached/ and issues no chat.send.
  it("rejects immediately when the client is not online, without sending chat.send", async () => {
    const client = new FakeOpenClawClient();
    const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 1_000 });
    const session = await adapter.startSession("t1"); // sessions.create happens while online
    client.setState("absent");
    const { handlers } = observer();

    await expect(session.send([{ type: "paragraph", text: "hi" }], handlers)).rejects.toThrow(
      /agent "a1" is not attached/,
    );
    expect(client.requests.some((r) => r.method === "chat.send")).toBe(false);
  });

  // (c) client drop mid-turn rejects /dropped mid-turn/ and leaves no pending timer.
  it("rejects on a mid-turn drop and leaves no pending timer", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeOpenClawClient();
      const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 5_000 });
      const session = await adapter.startSession("t1");
      const sessionKey = client.sessionKeys[0]!;
      const { handlers } = observer();

      const turn = session.send([{ type: "paragraph", text: "hi" }], handlers);
      client.emitError(sessionKey, "openclaw connection dropped before the reply ended");

      await expect(turn).rejects.toThrow(/dropped mid-turn/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // (d) an empty final reply rejects with /without any reply content/.
  it("rejects a turn whose reply ends with no content, without ever drafting or committing", async () => {
    const client = new FakeOpenClawClient();
    const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 1_000 });
    const session = await adapter.startSession("t1");
    const sessionKey = client.sessionKeys[0]!;
    const { handlers, observed } = observer();

    const turn = session.send([{ type: "paragraph", text: "hi" }], handlers);
    client.emitDone(sessionKey);

    await expect(turn).rejects.toThrow(/without any reply content/);
    expect(observed.drafts).toHaveLength(0);
    expect(observed.commits).toHaveLength(0);
    expect(observed.done).toBe(0);
  });

  // (e) two threads get two distinct sessions.create calls and their deltas do not cross.
  it("creates one session per thread and keeps each thread's deltas from crossing", async () => {
    const client = new FakeOpenClawClient();
    const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 1_000 });

    const sessionA = await adapter.startSession("ta");
    const sessionB = await adapter.startSession("tb");
    expect(client.requests.filter((r) => r.method === "sessions.create")).toHaveLength(2);
    const [keyA, keyB] = client.sessionKeys;
    expect(keyA).not.toBe(keyB);

    const a = observer();
    const b = observer();
    const turnA = sessionA.send([{ type: "paragraph", text: "a" }], a.handlers);
    const turnB = sessionB.send([{ type: "paragraph", text: "b" }], b.handlers);

    client.emitDelta(keyA!, "from A");
    client.emitDelta(keyB!, "from B");
    client.emitDone(keyA!);
    client.emitDone(keyB!);

    await turnA;
    await turnB;

    expect(a.observed.commits).toEqual([[{ type: "paragraph", text: "from A" }]]);
    expect(b.observed.commits).toEqual([[{ type: "paragraph", text: "from B" }]]);
    expect(a.observed.done).toBe(1);
    expect(b.observed.done).toBe(1);
  });

  it("reuses the cached session for a second turn on the same thread (no second sessions.create)", async () => {
    const client = new FakeOpenClawClient();
    const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 1_000 });
    await adapter.startSession("t1");
    await adapter.startSession("t1");
    expect(client.requests.filter((r) => r.method === "sessions.create")).toHaveLength(1);
  });

  // (f) turn timeout fires with fake timers.
  it("times out a turn that never completes, using the exact seconds figure in its message", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeOpenClawClient();
      const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 1_000 });
      const session = await adapter.startSession("t1");
      const { handlers } = observer();

      const turn = session.send([{ type: "paragraph", text: "hi" }], handlers);
      // Attach the rejection expectation before advancing the fake clock: advanceTimersByTimeAsync
      // yields to the microtask queue, and a rejection with no handler attached yet at that point
      // surfaces as a spurious unhandled-rejection warning (Node has no way to know a handler is
      // coming later in the same test).
      const rejection = expect(turn).rejects.toThrow(/turn timed out after 1s/);
      await vi.advanceTimersByTimeAsync(1_000);

      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsubscribes from the session once a turn settles (commit, empty-reply failure, drop, or timeout)", async () => {
    const client = new FakeOpenClawClient();
    const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 1_000 });
    const session = await adapter.startSession("t1");
    const sessionKey = client.sessionKeys[0]!;
    const { handlers } = observer();

    const turn = session.send([{ type: "paragraph", text: "hi" }], handlers);
    expect(client.isSubscribed(sessionKey)).toBe(true);
    client.emitDelta(sessionKey, "done text");
    client.emitDone(sessionKey);
    await turn;
    expect(client.isSubscribed(sessionKey)).toBe(false);
  });

  it("uses DEFAULT_TURN_TIMEOUT_SECONDS as 600", () => {
    expect(DEFAULT_TURN_TIMEOUT_SECONDS).toBe(600);
  });
});

describe("tool chips on drafts", () => {
  it("drafts carry the latest chip snapshot, a chip-only transition still flushes, and the commit carries none", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeOpenClawClient();
      const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 60_000 });
      const session = await adapter.startSession("thread-1");
      const { handlers, observed } = observer();

      const turn = session.send([{ type: "paragraph", text: "go" }], handlers);
      const sessionKey = client.sessionKeys[0]!;

      client.emitDelta(sessionKey, "working");
      client.emitToolCalls(sessionKey, [{ id: "t1", name: "read", status: "running" }]);
      await vi.advanceTimersByTimeAsync(150);
      expect(observed.drafts).toHaveLength(1);
      expect(observed.drafts[0]!.toolCalls).toEqual([{ id: "t1", name: "read", status: "running" }]);

      // Chip-only transition, no new text: must still produce a fresh draft.
      client.emitToolCalls(sessionKey, [{ id: "t1", name: "read", status: "ok" }]);
      await vi.advanceTimersByTimeAsync(150);
      expect(observed.drafts).toHaveLength(2);
      expect(observed.drafts[1]!.toolCalls).toEqual([{ id: "t1", name: "read", status: "ok" }]);

      // Text-only repeat of the same chips: dedupe still applies to unchanged text+chips.
      await vi.advanceTimersByTimeAsync(300);
      expect(observed.drafts).toHaveLength(2);

      client.emitDelta(sessionKey, "working done");
      client.emitDone(sessionKey);
      await turn;
      // The pre-commit flush carries the final text and the final chip states.
      const last = observed.drafts[observed.drafts.length - 1]!;
      expect(last.toolCalls).toEqual([{ id: "t1", name: "read", status: "ok" }]);
      // Commit is blocks-only (contract: chips are draft-scoped and die at commit).
      expect(observed.commits).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores tool snapshots after the turn settled", async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeOpenClawClient();
      const adapter = createOpenClawAdapter({ agentId: "a1", client, turnTimeoutMs: 60_000 });
      const session = await adapter.startSession("thread-1");
      const { handlers, observed } = observer();

      const turn = session.send([{ type: "paragraph", text: "go" }], handlers);
      const sessionKey = client.sessionKeys[0]!;
      client.emitDelta(sessionKey, "hi");
      client.emitDone(sessionKey);
      await turn;

      const draftsAfterCommit = observed.drafts.length;
      client.emitToolCalls(sessionKey, [{ id: "late", name: "read", status: "running" }]);
      await vi.advanceTimersByTimeAsync(300);
      expect(observed.drafts).toHaveLength(draftsAfterCommit);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("openclaw mid-turn delivery capability", () => {
  it("declares queue and exposes no steer/interrupt on its session", async () => {
    const client = new FakeOpenClawClient();
    const adapter = createOpenClawAdapter({
      agentId: "oc1",
      client,
      turnTimeoutMs: DEFAULT_TURN_TIMEOUT_SECONDS * 1000,
    });
    expect(adapter.midTurnDelivery).toBe("queue");
    const session = await adapter.startSession("t1");
    expect(session.steer).toBeUndefined();
    expect(session.interrupt).toBeUndefined();
  });
});

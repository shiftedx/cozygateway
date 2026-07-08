import { describe, expect, it, vi } from "vitest";
import type { RichBlock } from "cozygateway-contract";

import {
  AttachRouter,
  DEFAULT_TURN_TIMEOUT_SECONDS,
  collectAttachTokens,
  createAttachAdapter,
  parseAttachOptions,
  type AttachAdapter,
  type TurnEndpoint,
} from "../src/adapters/attach/adapter.ts";
import type { AttachTurnFrame } from "../src/adapters/attach/protocol.ts";
import type { TurnHandlers } from "../src/adapters/types.ts";

const agent = (id: string, options?: Record<string, unknown>) => ({
  id,
  name: id,
  backend: "attach",
  ...(options === undefined ? {} : { options }),
});

describe("parseAttachOptions", () => {
  it("requires options.tokenEnv", () => {
    expect(() => parseAttachOptions(agent("a1"), {})).toThrow(/options\.tokenEnv/);
    expect(() => parseAttachOptions(agent("a1", { tokenEnv: "" }), {})).toThrow(/options\.tokenEnv/);
  });

  it("requires the named environment variable to be set and non-empty", () => {
    expect(() => parseAttachOptions(agent("a1", { tokenEnv: "A1_TOKEN" }), {})).toThrow(/A1_TOKEN/);
    expect(() => parseAttachOptions(agent("a1", { tokenEnv: "A1_TOKEN" }), { A1_TOKEN: "" })).toThrow(
      /A1_TOKEN/,
    );
  });

  it("parses the token and defaults the turn timeout", () => {
    const parsed = parseAttachOptions(agent("a1", { tokenEnv: "A1_TOKEN" }), { A1_TOKEN: "secret" });
    expect(parsed).toEqual({
      tokenEnv: "A1_TOKEN",
      token: "secret",
      turnTimeoutMs: DEFAULT_TURN_TIMEOUT_SECONDS * 1000,
    });
  });

  it("accepts a positive turnTimeoutSeconds and rejects anything else", () => {
    const parsed = parseAttachOptions(
      agent("a1", { tokenEnv: "A1_TOKEN", turnTimeoutSeconds: 5 }),
      { A1_TOKEN: "secret" },
    );
    expect(parsed.turnTimeoutMs).toBe(5_000);
    for (const bad of [0, -1, "5", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        parseAttachOptions(agent("a1", { tokenEnv: "A1_TOKEN", turnTimeoutSeconds: bad }), {
          A1_TOKEN: "secret",
        }),
      ).toThrow(/turnTimeoutSeconds/);
    }
  });
});

describe("collectAttachTokens", () => {
  it("collects one entry per attach agent and ignores other backends", () => {
    const tokens = collectAttachTokens(
      [
        agent("a1", { tokenEnv: "A1_TOKEN" }),
        { id: "m1", name: "m1", backend: "mock" },
        agent("a2", { tokenEnv: "A2_TOKEN" }),
      ],
      { A1_TOKEN: "one", A2_TOKEN: "two" },
    );
    expect(tokens).toEqual(
      new Map([
        ["one", "a1"],
        ["two", "a2"],
      ]),
    );
  });

  it("rejects two agents sharing a token (the token identifies the agent)", () => {
    expect(() =>
      collectAttachTokens(
        [agent("a1", { tokenEnv: "A1_TOKEN" }), agent("a2", { tokenEnv: "A2_TOKEN" })],
        { A1_TOKEN: "same", A2_TOKEN: "same" },
      ),
    ).toThrow(/token/);
  });
});

interface FakeEndpoint extends TurnEndpoint {
  attached: boolean;
  frames: AttachTurnFrame[];
}

function fakeEndpoint(): FakeEndpoint {
  const endpoint: FakeEndpoint = {
    attached: true,
    frames: [],
    isAttached: () => endpoint.attached,
    sendTurn: (agentId, frame) => {
      if (!endpoint.attached) return false;
      endpoint.frames.push(frame);
      return true;
    },
  };
  return endpoint;
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

async function startTurn(adapter: AttachAdapter, endpoint: FakeEndpoint, threadId: string) {
  const session = await adapter.startSession(threadId);
  const { handlers, observed } = observer();
  const before = endpoint.frames.length;
  const turn = session.send([{ type: "paragraph", text: "hi" }], handlers);
  // send() writes the turn frame synchronously; belt and braces for slower paths.
  if (endpoint.frames.length === before) throw new Error("turn frame was not sent");
  const frame = endpoint.frames[endpoint.frames.length - 1]!;
  return { session, turn, observed, frame };
}

describe("createAttachAdapter", () => {
  it("rejects a send while no connection is attached", async () => {
    const endpoint = fakeEndpoint();
    endpoint.attached = false;
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const session = await adapter.startSession("t1");
    const { handlers } = observer();
    await expect(session.send([{ type: "paragraph", text: "x" }], handlers)).rejects.toThrow(
      /not attached/,
    );
    expect(adapter.presence()).toBe("absent");
  });

  it("fails a turn immediately when sendTurn throws, with no pending entry left behind", async () => {
    vi.useFakeTimers();
    try {
      const endpoint = fakeEndpoint();
      let capturedFrame: AttachTurnFrame | undefined;
      endpoint.sendTurn = (_agentId, frame) => {
        capturedFrame = frame;
        throw new Error("socket write exploded");
      };
      const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
      const session = await adapter.startSession("t1");
      const { handlers, observed } = observer();

      const turn = session.send([{ type: "paragraph", text: "hi" }], handlers);
      // The rejection must arrive on the microtask queue, never by advancing the fake clock:
      // proof this is not the 600s (here 1s) per-turn timeout firing.
      await expect(turn).rejects.toThrow(/not attached/);
      expect(capturedFrame).toBeDefined();

      // The timer started for this turn must already be cleared: no leaked pending timer.
      expect(vi.getTimerCount()).toBe(0);

      // No pending entry survives: a late update for the same turnId is dropped, not processed.
      adapter.handleUpdate("t1", { kind: "done", turnId: capturedFrame!.turnId });
      expect(observed.done).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a rendered turn frame and completes on draft/done", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const { turn, observed, frame } = await startTurn(adapter, endpoint, "t1");
    expect(frame.kind).toBe("turn");
    expect(frame.threadId).toBe("t1");
    expect(frame.text).toBe("hi");

    adapter.handleUpdate("t1", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "th" }],
      toolCalls: [{ id: "search#1", name: "search", status: "running" }],
    });
    adapter.handleUpdate("t1", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "the answer" }],
    });
    adapter.handleUpdate("t1", { kind: "done", turnId: frame.turnId });
    await turn;

    expect(observed.drafts).toEqual([
      {
        blocks: [{ type: "paragraph", text: "th" }],
        toolCalls: [{ id: "search#1", name: "search", status: "running" }],
      },
      { blocks: [{ type: "paragraph", text: "the answer" }], toolCalls: [] },
    ]);
    expect(observed.commits).toEqual([[{ type: "paragraph", text: "the answer" }]]);
    expect(observed.done).toBe(1);
    expect(adapter.presence()).toBe("online");
  });

  it("fails a turn that ends with no draft content", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const { turn, observed, frame } = await startTurn(adapter, endpoint, "t1");
    adapter.handleUpdate("t1", { kind: "done", turnId: frame.turnId });
    await expect(turn).rejects.toThrow(/without any reply content/);
    expect(observed.commits).toHaveLength(0);
    expect(observed.done).toBe(0);
  });

  it("fails a turn on an explicit failed frame, with the plugin's message", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const { turn, frame } = await startTurn(adapter, endpoint, "t1");
    adapter.handleUpdate("t1", { kind: "failed", turnId: frame.turnId, message: "model unreachable" });
    await expect(turn).rejects.toThrow(/model unreachable/);
  });

  it("fails all in-flight turns when the connection drops", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const first = await startTurn(adapter, endpoint, "t1");
    const second = await startTurn(adapter, endpoint, "t2");
    adapter.handleDisconnect();
    await expect(first.turn).rejects.toThrow(/dropped mid-turn/);
    await expect(second.turn).rejects.toThrow(/dropped mid-turn/);
  });

  it("times out a turn that never completes", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 20 });
    const { turn } = await startTurn(adapter, endpoint, "t1");
    await expect(turn).rejects.toThrow(/timed out/);
  });

  it("drops frames for an unknown turn, a foreign thread, and a settled turn", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    adapter.handleUpdate("t1", { kind: "done", turnId: "never-started" }); // no throw

    const { turn, observed, frame } = await startTurn(adapter, endpoint, "t1");
    adapter.handleUpdate("OTHER-THREAD", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "spoof" }],
    });
    expect(observed.drafts).toHaveLength(0);

    adapter.handleUpdate("t1", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "real" }],
    });
    adapter.handleUpdate("t1", { kind: "done", turnId: frame.turnId });
    await turn;

    adapter.handleUpdate("t1", { kind: "failed", turnId: frame.turnId, message: "late" }); // no effect
    expect(observed.commits).toEqual([[{ type: "paragraph", text: "real" }]]);
    expect(observed.done).toBe(1);
  });

  it("runs concurrent turns on different threads independently", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const a = await startTurn(adapter, endpoint, "ta");
    const b = await startTurn(adapter, endpoint, "tb");
    expect(a.frame.turnId).not.toBe(b.frame.turnId);

    adapter.handleUpdate("tb", {
      kind: "draft",
      turnId: b.frame.turnId,
      blocks: [{ type: "paragraph", text: "b done" }],
    });
    adapter.handleUpdate("tb", { kind: "done", turnId: b.frame.turnId });
    await b.turn;
    expect(a.observed.done).toBe(0);

    adapter.handleUpdate("ta", {
      kind: "draft",
      turnId: a.frame.turnId,
      blocks: [{ type: "paragraph", text: "a done" }],
    });
    adapter.handleUpdate("ta", { kind: "done", turnId: a.frame.turnId });
    await a.turn;
    expect(a.observed.commits).toEqual([[{ type: "paragraph", text: "a done" }]]);
  });
});

describe("AttachRouter", () => {
  it("routes updates and disconnects to the registered adapter and ignores unknown agents", async () => {
    const endpoint = fakeEndpoint();
    const adapter = createAttachAdapter({ agentId: "a1", endpoint, turnTimeoutMs: 1_000 });
    const router = new AttachRouter();
    router.register("a1", adapter);
    router.onUpdate("ghost", "t1", { kind: "done", turnId: "x" }); // no throw
    router.onDisconnect("ghost"); // no throw

    const { turn, frame } = await startTurn(adapter, endpoint, "t1");
    router.onUpdate("a1", "t1", {
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: "via router" }],
    });
    router.onUpdate("a1", "t1", { kind: "done", turnId: frame.turnId });
    await turn;
  });
});

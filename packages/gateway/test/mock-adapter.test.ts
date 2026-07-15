import { describe, expect, it } from "vitest";
import type { RichBlock, ToolCall } from "cozygateway-contract";

import { createMockAdapter, createSteerMockAdapter } from "../src/adapters/mock.ts";
import { buildAdapters } from "../src/adapters/registry.ts";

function record() {
  const events: string[] = [];
  const drafts: RichBlock[][] = [];
  return {
    events,
    drafts,
    handlers: {
      onDraft: (u: { blocks: RichBlock[]; toolCalls: ToolCall[] }) => {
        events.push("draft");
        drafts.push(u.blocks);
      },
      onCommit: (f: { blocks: RichBlock[] }) => {
        events.push(`commit:${JSON.stringify(f.blocks)}`);
      },
      onDone: () => events.push("done"),
    },
  };
}

describe("mock adapter echo semantics", () => {
  it("emits two drafts, a commit, and done", async () => {
    const adapter = createMockAdapter();
    const session = await adapter.startSession("t1");
    const rec = record();
    await session.send([{ type: "paragraph", text: "hi" }], rec.handlers);
    expect(rec.events).toEqual([
      "draft",
      "draft",
      `commit:${JSON.stringify([{ type: "paragraph", text: "Echo: hi" }])}`,
      "done",
    ]);
    expect(rec.drafts[0]).toEqual([{ type: "paragraph", text: "Echo: " }]);
    expect(rec.drafts[1]).toEqual([{ type: "paragraph", text: "Echo: hi" }]);
  });

  it("rejects on [[fail]] after one draft, with no commit or done", async () => {
    const adapter = createMockAdapter();
    const session = await adapter.startSession("t1");
    const rec = record();
    await expect(session.send([{ type: "paragraph", text: "boom [[fail]]" }], rec.handlers)).rejects.toThrow(
      "scripted failure",
    );
    expect(rec.events).toEqual(["draft"]);
  });

  it("reports online presence", () => {
    expect(createMockAdapter().presence()).toBe("online");
  });
});

describe("registry", () => {
  it("builds mock adapters and rejects unknown backends", () => {
    const adapters = buildAdapters([{ id: "m", name: "M", backend: "mock" }]);
    expect(adapters.get("m")?.backend).toBe("mock");
    expect(() => buildAdapters([{ id: "x", name: "X", backend: "warp" }])).toThrow(/unknown backend/);
  });
});

describe("createMockAdapter capability", () => {
  it("declares queue mid-turn delivery and exposes no steer/interrupt", async () => {
    const adapter = createMockAdapter();
    expect(adapter.midTurnDelivery).toBe("queue");
    const session = await adapter.startSession("t1");
    expect(session.steer).toBeUndefined();
    expect(session.interrupt).toBeUndefined();
  });
});

describe("createSteerMockAdapter", () => {
  it("declares steer, stays in flight after send, then a steer folds text and commits", async () => {
    const adapter = createSteerMockAdapter();
    expect(adapter.midTurnDelivery).toBe("steer");
    const session = await adapter.startSession("t1");
    const rec = record();
    let settled = false;
    const turn = session.send([{ type: "paragraph", text: "one" }], rec.handlers).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false); // stays in flight, only the initial draft so far
    expect(rec.events).toEqual(["draft"]);
    expect(rec.drafts[0]).toEqual([{ type: "paragraph", text: "Working: one" }]);

    await session.steer?.([{ type: "paragraph", text: "two" }]);
    await turn;
    expect(rec.events).toEqual([
      "draft",
      "draft",
      `commit:${JSON.stringify([{ type: "paragraph", text: "Working: one + two" }])}`,
      "done",
    ]);
  });

  it("rejects the in-flight send when interrupt is called, with no commit or done", async () => {
    const adapter = createSteerMockAdapter();
    const session = await adapter.startSession("t1");
    const rec = record();
    const turn = session.send([{ type: "paragraph", text: "one" }], rec.handlers);
    await new Promise((r) => setTimeout(r, 5));
    await session.interrupt?.();
    await expect(turn).rejects.toThrow(/interrupted/);
    expect(rec.events).toEqual(["draft"]);
  });
});

import { describe, expect, it } from "vitest";
import type { RichBlock, ToolCall } from "cozygateway-contract";

import { createMockAdapter } from "../src/adapters/mock.ts";
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

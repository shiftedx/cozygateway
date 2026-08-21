import { describe, expect, it, vi } from "vitest";

import {
  createAttachAdapter,
  type AttachTurnFrame,
  type TurnEndpoint,
} from "../src/adapters/attach/adapter.ts";

function endpoint(frames: AttachTurnFrame[]): TurnEndpoint {
  return {
    isAttached: () => true,
    canQueue: () => true,
    sendTurn: (_agentId, frame) => { frames.push(frame); return true; },
    sendSteer: () => true,
    sendInterrupt: () => true,
    sendApprovalResolution: () => true,
  };
}

describe("attach-v1 backend adapter", () => {
  it("streams and commits one durable v1 turn", async () => {
    const frames: AttachTurnFrame[] = [];
    const adapter = createAttachAdapter({ agentId: "sage", endpoint: endpoint(frames), turnTimeoutMs: 1_000 });
    const session = await adapter.startSession("thread-1");
    const onDraft = vi.fn();
    const onCommit = vi.fn();
    const onDone = vi.fn();
    const pending = session.send([{ type: "paragraph", text: "hello" }], { onDraft, onCommit, onDone });
    const sent = frames[0]!;

    expect(adapter.handleV1Event({
      kind: "event", sequence: 1, eventId: "draft-1",
      event: { kind: "draft", threadId: sent.threadId, turnId: sent.turnId, blocks: [{ type: "paragraph", text: "working" }] },
    })).toBe(true);
    expect(adapter.handleV1Event({
      kind: "event", sequence: 2, eventId: "commit-1",
      event: { kind: "commit", threadId: sent.threadId, turnId: sent.turnId, messageId: "answer-1", blocks: [{ type: "paragraph", text: "done" }] },
    })).toBe(true);
    await pending;

    expect(onDraft).toHaveBeenLastCalledWith({ blocks: [{ type: "paragraph", text: "done" }], toolCalls: [] });
    expect(onCommit).toHaveBeenCalledWith({ blocks: [{ type: "paragraph", text: "done" }] });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("fails an in-flight turn on a terminal failure or disconnect", async () => {
    const frames: AttachTurnFrame[] = [];
    const adapter = createAttachAdapter({ agentId: "sage", endpoint: endpoint(frames), turnTimeoutMs: 1_000 });
    const first = (await adapter.startSession("thread-1")).send(
      [{ type: "paragraph", text: "hello" }],
      { onDraft: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() },
    );
    const sent = frames[0]!;
    adapter.handleV1Event({
      kind: "event", sequence: 1, eventId: "failed-1",
      event: { kind: "failed", threadId: sent.threadId, turnId: sent.turnId, messageId: "failure-1", message: "model unavailable" },
    });
    await expect(first).rejects.toThrow("model unavailable");

    const second = (await adapter.startSession("thread-2")).send(
      [{ type: "paragraph", text: "again" }],
      { onDraft: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() },
    );
    adapter.handleDisconnect();
    await expect(second).rejects.toThrow("dropped mid-turn");
  });

  it("queues while temporarily absent because v1 delivery is durable", async () => {
    const frames: AttachTurnFrame[] = [];
    const durable = endpoint(frames);
    durable.isAttached = () => false;
    const adapter = createAttachAdapter({ agentId: "sage", endpoint: durable, turnTimeoutMs: 10 });
    const pending = (await adapter.startSession("thread-1")).send(
      [{ type: "paragraph", text: "queued" }],
      { onDraft: vi.fn(), onCommit: vi.fn(), onDone: vi.fn() },
    );
    expect(frames).toHaveLength(1);
    adapter.handleDisconnect();
    await expect(pending).rejects.toThrow("dropped mid-turn");
  });
});

/** TurnRunner's approval surface (issue #19, core lane): an adapter surfaces a pending approval
 *  through the turn handlers, the runner fans it out on the live channel, and a resolve routed
 *  back through the runner reaches the session and produces exactly one terminal frame. */
import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage } from "../src/storage.ts";
import { TurnRunner, nullNotifier } from "../src/turns.ts";
import type { ApprovalDecision, BackendAdapter, BackendSession } from "../src/adapters/types.ts";

interface Harness {
  frames: ServerFrame[];
  runner: TurnRunner;
  audit: string[];
}

/** An adapter that raises ONE approval per turn and parks until it is resolved. The test drives
 *  the resolution through the runner, exactly as the REST route does. */
function approvalAdapter(options?: {
  argSummary?: Record<string, string>;
  /** Omit the session's resolver entirely: a backend that raises approvals it cannot resolve. */
  noResolver?: boolean;
  /** Resolve the session's resolveApproval with false (the backend already moved on). */
  refuse?: boolean;
}): BackendAdapter & { expire: () => void; finish: () => void } {
  let pendingId: string | undefined;
  let onResolved: ((r: { toolCallId: string; outcome: "approved" | "denied" | "expired" }) => void) | undefined;
  let finishTurn: (() => void) | undefined;

  const session: BackendSession = {
    send(blocks, handlers) {
      return new Promise<void>((resolve) => {
        pendingId = "call_1";
        onResolved = (r) => handlers.onApprovalResolved?.(r);
        finishTurn = () => {
          handlers.onCommit({ blocks: [{ type: "paragraph", text: "done" }] });
          handlers.onDone();
          resolve();
        };
        handlers.onDraft({ blocks: [{ type: "paragraph", text: "working" }], toolCalls: [] });
        handlers.onApprovalPending?.({
          toolCallId: "call_1",
          name: "run_shell",
          ...(options?.argSummary === undefined
            ? { argSummary: { command: "string" } }
            : { argSummary: options.argSummary }),
        } as never);
      });
    },
    ...(options?.noResolver === true
      ? {}
      : {
          async resolveApproval(toolCallId: string, _decision: ApprovalDecision): Promise<boolean> {
            if (options?.refuse === true) return false;
            return toolCallId === pendingId;
          },
        }),
    async close() {},
  };

  return {
    backend: "approval-test",
    midTurnDelivery: "queue",
    presence: () => "online",
    async startSession() {
      return session;
    },
    expire: () => onResolved?.({ toolCallId: "call_1", outcome: "expired" }),
    finish: () => finishTurn?.(),
  };
}

function setup(adapter: BackendAdapter): Harness {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "a1", name: "A", avatar: null, backend: adapter.backend });
  storage.createThread({ id: "t1", agentId: "a1", title: "T", createdAt: 1 });
  const frames: ServerFrame[] = [];
  const audit: string[] = [];
  const runner = new TurnRunner({
    storage,
    hub: { broadcast: (f) => frames.push(f), connectedDeviceIds: () => new Set(["d1"]) },
    adapters: new Map([["a1", adapter]]),
    notifier: nullNotifier,
    now: () => 42,
    approvalLog: (line) => audit.push(line),
  });
  return { frames, runner, audit };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2_000) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function pendingFrames(frames: ServerFrame[]) {
  return frames.filter((f) => f.type === "approval_pending");
}
function resolvedFrames(frames: ServerFrame[]) {
  return frames.filter((f) => f.type === "approval_resolved");
}

describe("TurnRunner approvals", () => {
  it("fans a pending approval out on the live channel, carrying the turn's own turnId", async () => {
    const adapter = approvalAdapter();
    const { frames, runner } = setup(adapter);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "rm things" }]);
    await until(() => pendingFrames(frames).length === 1, "approval_pending");

    const draft = frames.find((f) => f.type === "draft");
    const pending = pendingFrames(frames)[0];
    expect(pending).toMatchObject({
      type: "approval_pending",
      threadId: "t1",
      toolCallId: "call_1",
      name: "run_shell",
      argSummary: { command: "string" },
    });
    expect(draft?.type === "draft" && pending?.type === "approval_pending").toBe(true);
    if (draft?.type === "draft" && pending?.type === "approval_pending") {
      expect(pending.turnId).toBe(draft.turnId);
    }
    // Nothing durable: an approval is live-channel only.
    expect(frames.filter((f) => f.type === "committed").filter((f) => f.type === "committed" && f.message.role !== "user")).toHaveLength(0);
  });

  it("approve reaches the session and emits exactly one approval_resolved(approved)", async () => {
    const adapter = approvalAdapter();
    const { frames, runner, audit } = setup(adapter);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await until(() => pendingFrames(frames).length === 1, "approval_pending");

    expect(await runner.resolveApproval("t1", "call_1", "approve", "dev_1")).toBe("approved");
    const resolved = resolvedFrames(frames);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ type: "approval_resolved", threadId: "t1", toolCallId: "call_1", outcome: "approved" });
    expect(audit).toEqual([
      expect.stringContaining("toolCall=call_1") as unknown as string,
    ]);
    expect(audit[0]).toContain("device=dev_1");
    expect(audit[0]).toContain("approved");
    adapter.finish();
  });

  it("deny is a distinct terminal outcome", async () => {
    const adapter = approvalAdapter();
    const { frames, runner } = setup(adapter);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await until(() => pendingFrames(frames).length === 1, "approval_pending");

    expect(await runner.resolveApproval("t1", "call_1", "deny", "dev_1")).toBe("denied");
    expect(resolvedFrames(frames)[0]).toMatchObject({ outcome: "denied" });
    adapter.finish();
  });

  it("reports an unknown toolCallId without touching the backend", async () => {
    const adapter = approvalAdapter();
    const { runner } = setup(adapter);
    expect(await runner.resolveApproval("t1", "nope", "approve", "dev_1")).toBe("unknown");
  });

  it("reports an already-resolved approval as not_pending and emits no second frame", async () => {
    const adapter = approvalAdapter();
    const { frames, runner } = setup(adapter);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await until(() => pendingFrames(frames).length === 1, "approval_pending");

    expect(await runner.resolveApproval("t1", "call_1", "approve", "dev_1")).toBe("approved");
    expect(await runner.resolveApproval("t1", "call_1", "deny", "dev_1")).toBe("not_pending");
    expect(resolvedFrames(frames)).toHaveLength(1);
    adapter.finish();
  });

  it("keeps expired distinguishable from denied, end to end", async () => {
    const adapter = approvalAdapter();
    const { frames, runner } = setup(adapter);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await until(() => pendingFrames(frames).length === 1, "approval_pending");

    adapter.expire();
    await until(() => resolvedFrames(frames).length === 1, "approval_resolved(expired)");
    expect(resolvedFrames(frames)[0]).toMatchObject({ outcome: "expired" });
    // And a decision arriving after the lapse says EXPIRED, not "already denied".
    expect(await runner.resolveApproval("t1", "call_1", "approve", "dev_1")).toBe("expired");
    adapter.finish();
  });

  it("expires any approval still pending when its turn ends, so none outlives its turn", async () => {
    const adapter = approvalAdapter();
    const { frames, runner } = setup(adapter);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await until(() => pendingFrames(frames).length === 1, "approval_pending");

    adapter.finish();
    await until(() => resolvedFrames(frames).length === 1, "approval_resolved on turn end");
    expect(resolvedFrames(frames)[0]).toMatchObject({ outcome: "expired" });
    expect(await runner.resolveApproval("t1", "call_1", "approve", "dev_1")).toBe("expired");
  });

  it("answers not_pending when the backend refuses the resolution (it already moved on)", async () => {
    const adapter = approvalAdapter({ refuse: true });
    const { frames, runner } = setup(adapter);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await until(() => pendingFrames(frames).length === 1, "approval_pending");

    expect(await runner.resolveApproval("t1", "call_1", "approve", "dev_1")).toBe("not_pending");
    expect(resolvedFrames(frames)).toHaveLength(0);
    adapter.finish();
  });

  it("answers unsupported when the session cannot resolve approvals at all", async () => {
    const adapter = approvalAdapter({ noResolver: true });
    const { frames, runner } = setup(adapter);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await until(() => pendingFrames(frames).length === 1, "approval_pending");

    expect(await runner.resolveApproval("t1", "call_1", "approve", "dev_1")).toBe("unsupported");
    adapter.finish();
  });

  it("REFUSES to fan out an approval whose argSummary carries a raw argument value", async () => {
    // The schema is the guard, and the runner is where it is applied: a misbehaving adapter must
    // not be able to leak `rm -rf /` onto every paired device.
    const adapter = approvalAdapter({ argSummary: { command: "rm -rf /" } });
    const { frames, runner } = setup(adapter);
    runner.submitUserMessage("t1", [{ type: "paragraph", text: "go" }]);
    await until(() => frames.some((f) => f.type === "error"), "error frame");

    expect(pendingFrames(frames)).toHaveLength(0);
    const err = frames.find((f) => f.type === "error");
    expect(err).toMatchObject({ type: "error", code: "invalid_request", threadId: "t1" });
    expect(JSON.stringify(frames)).not.toContain("rm -rf /");
    // ...and the approval was never recorded, so a resolve for it is unknown.
    expect(await runner.resolveApproval("t1", "call_1", "approve", "dev_1")).toBe("unknown");
    adapter.finish();
  });
});

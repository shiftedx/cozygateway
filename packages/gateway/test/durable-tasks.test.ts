import { describe, expect, it, vi } from "vitest";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { openStorage } from "../src/storage.ts";

describe("durable Tasks on actual attach storage admission", () => {
  it("creates the Task with a direct turn, starts on ack and completes once on its final proof", () => {
    const storage = openStorage(":memory:");
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "Check the build" }, 2);
    const task = storage.tasks.list({ bot: "sage" })[0]!;
    expect(task).toMatchObject({ bot: "sage", state: "queued", goal: "Check the build", currentRun: { runId: "run" } });
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    expect(storage.tasks.read(task.taskId)?.view.state).toBe("running");
    const final = { kind: "event" as const, sequence: 1, eventId: "final", event: { kind: "commit" as const, threadId: sessionId, turnId: "run", messageId: "reply", blocks: [{ type: "paragraph" as const, text: "Verified" }] } };
    storage.acceptAttachEvent("sage", final, 4);
    storage.acceptAttachEvent("sage", final, 5);
    expect(storage.tasks.read(task.taskId)).toMatchObject({ view: { state: "completed", notification: { taskId: task.taskId, createdAt: 4 } }, events: [{ reason: "task_created" }, { reason: "run_started" }, { reason: "run_completed" }] });
    storage.close();
  });
  it("projects only the current run's source-bound approval and returns to verification", () => {
    const storage = openStorage(":memory:");
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "Check" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    storage.recordNativeInteraction({ bot: "sage", kind: "approval", interactionId: "approval", sessionId, turnId: "run", status: "pending", expiresAt: 100, payload: { name: "write" }, updatedAt: 4 });
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "waiting_for_approval", waitingOn: { kind: "approval", id: "approval", expiresAt: 100 } });
    storage.resolveNativeInteraction("sage", "approval", "approval", "denied", 20);
    expect(storage.tasks.read(taskId)?.view.state).toBe("running");
    expect(storage.tasks.read(taskId)?.events.map((event) => event.reason)).toEqual(["task_created", "run_started", "approval_requested", "approval_denied"]);
    storage.close();
  });

  it("suspends the real native timeout while an approval owns the clock", async () => {
    vi.useFakeTimers();
    let now = 0;
    const storage = openStorage(":memory:");
    const plane = new NativeBotDataPlane({ control: {} as BotsSurface, storage, nativeBots: ["sage"], chatSuggestion: "", now: () => now, broadcast: () => {}, turnTimeoutMs: 50,
      ingress: { sendNativeTurn: (bot: string, input: Record<string, unknown>) => { const command = storage.enqueueAttachCommand(bot, "command", { kind: "turn", ...input } as never, now); storage.ackAttachCommand(bot, command.sequence, command.commandId, now); return true; }, sendNativeInterrupt: () => true } as unknown as AttachV1Ingress });
    try {
      const sent = await plane.surface().sendChatMessage("sage", "work");
      const turnId = storage.nativeBotChat("sage", now).activeTurnId!;
      now = 10; await vi.advanceTimersByTimeAsync(10);
      plane.handle("sage", { kind: "event", sequence: 1, eventId: "approval", event: { kind: "approval", threadId: sent.sessionId, turnId, approvalId: "approval", callId: "call", name: "write", status: "pending", expiresAt: 100 } });
      now = 60; await vi.advanceTimersByTimeAsync(50);
      expect(storage.nativeBotTurnTerminal("sage", sent.sessionId, turnId)).toBeUndefined();
      now = 100; await vi.advanceTimersByTimeAsync(40);
      expect(storage.tasks.list({ bot: "sage" })[0]?.state).toBe("running");
      now = 139; await vi.advanceTimersByTimeAsync(39);
      expect(storage.nativeBotTurnTerminal("sage", sent.sessionId, turnId)).toBeUndefined();
      now = 140; await vi.advanceTimersByTimeAsync(1);
      expect(storage.nativeBotTurnTerminal("sage", sent.sessionId, turnId)?.status).toBe("timed_out");
    } finally { plane.close(); storage.close(); vi.useRealTimers(); }
  });

});

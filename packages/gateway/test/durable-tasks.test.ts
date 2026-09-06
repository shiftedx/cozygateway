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

  it("assigns a missing legacy wait expiry once and never renews it on duplicate admission", () => {
    const storage = openStorage(":memory:");
    const input = { bot: "sage", kind: "approval" as const, interactionId: "legacy", sessionId: "session", turnId: "run", status: "pending", payload: {}, updatedAt: 10 };
    storage.recordNativeInteraction(input);
    expect(storage.nativeInteraction("sage", "approval", "legacy")?.expiresAt).toBe(600010);
    storage.recordNativeInteraction({ ...input, updatedAt: 5000 });
    expect(storage.nativeInteraction("sage", "approval", "legacy")?.expiresAt).toBe(600010);
    storage.close();
  });

  it("uses a fresh durable absence episode for a second owner loss on the same Run", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    storage.tasks.presence("sage", true, 3);
    storage.tasks.presence("sage", false, 10);
    storage.tasks.reconcile(120009);
    expect(storage.tasks.list({ bot: "sage" })[0]?.state).toBe("running");
    storage.tasks.reconcile(120010);
    expect(storage.tasks.list({ bot: "sage" })[0]?.state).toBe("blocked");
    storage.tasks.presence("sage", true, 120011);
    expect(storage.tasks.list({ bot: "sage" })[0]?.state).toBe("running");
    storage.tasks.presence("sage", false, 120020);
    storage.tasks.reconcile(240020);
    const view = storage.tasks.list({ bot: "sage" })[0]!;
    expect(view.state).toBe("blocked");
    expect(storage.tasks.read(view.taskId)?.events.filter((event) => event.reason === "owner_unreachable")).toHaveLength(2);
    storage.close();
  });

  it("persists pause intent on a spooled unacked turn, then interrupts on ack and lands paused only on its terminal", () => {
    const storage = openStorage(":memory:");
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    expect(storage.tasks.command(taskId, "pause", { idempotencyKey: "pause" }, 3)).toMatchObject({ outcome: "accepted", view: { state: "queued", pendingIntent: { command: "pause" } } });
    expect(storage.pendingAttachCommands("sage", 0, 10)).toHaveLength(1);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 4);
    storage.tasks.dispatch((peer, id, body) => { storage.enqueueAttachCommand(peer, id, body, 4); return true; });
    expect(storage.pendingAttachCommands("sage", 0, 10).map((row) => row.command.kind)).toEqual(["interrupt"]);
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "stopped", event: { kind: "interrupted", threadId: sessionId, turnId: "run", messageId: "stopped" } }, 5);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "waiting_for_user_input" });
    expect(storage.tasks.command(taskId, "scope", { idempotencyKey: "scope", goal: "different" }, 6).outcome).toBe("accepted");
    expect(storage.tasks.command(taskId, "scope", { idempotencyKey: "scope", goal: "changed again" }, 7).outcome).toBe("conflict");
    storage.close();
  });

  it("holds final proof for a child still in flight and reports its later failure once", () => {
    const storage = openStorage(":memory:");
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    const child = { kind: "delegation" as const, threadId: sessionId, turnId: "run", batchId: "batch", childId: "child", index: 0, count: 1, status: "running" as const };
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "child", event: child }, 4);
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 2, eventId: "final", event: { kind: "commit", threadId: sessionId, turnId: "run", messageId: "reply", blocks: [] } }, 5);
    expect(storage.tasks.read(taskId)?.view.state).toBe("verifying");
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 3, eventId: "child-failed", event: { ...child, status: "failed" } }, 6);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "blocked", lastEvent: { reason: "child_failed", ref: { kind: "child", id: "batch/child" } } });
    expect(storage.tasks.read(taskId)?.view.notification).toBeUndefined();
    storage.close();
  });

});

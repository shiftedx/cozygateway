import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { MobileNodeBroker } from "../src/mobile-node.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { openStorage } from "../src/storage.ts";

describe("durable Tasks on actual attach storage admission", () => {
  it("creates the Task with a direct turn, starts on ack and completes once on its final proof", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
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
  it("starts a queued Task once when hello reconciles the persisted command cursor", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
    storage.tasks.clock(() => 0);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "Check" }, 2);
    expect(storage.reconcileAttachResume("sage", 0, command.sequence, 3)).toBe(true);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    expect(storage.tasks.read(taskId)?.view.state).toBe("running");
    expect(storage.reconcileAttachResume("sage", 0, command.sequence, 4)).toBe(true);
    expect(storage.tasks.read(taskId)?.events.filter((event) => event.reason === "run_started")).toHaveLength(1);
    storage.close();
  });
  it("projects only the current run's source-bound approval and returns to running", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
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
    storage.tasks.clock(() => 0);
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

  it("expires a due clarification on read and never extends its suspended clock through delayed settlement", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
    let now = 0;
    storage.tasks.clock(() => now);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    storage.recordNativeInteraction({ bot: "sage", kind: "clarify", interactionId: "question", sessionId, turnId: "run", status: "pending", expiresAt: 100, payload: {}, updatedAt: 10 });
    now = 120;
    expect(storage.tasks.read(taskId)?.view.state).toBe("running");
    expect(storage.nativeInteraction("sage", "clarify", "question")?.status).toBe("expired");
    expect(storage.tasks.suspended("sage", "run", 0, now)).toBe(90);
    expect(storage.tasks.read(taskId)?.events.filter((event) => event.reason === "clarification_expired")).toHaveLength(1);
    storage.close();
  });

  it("keeps waiting until overlapping approvals settle and suspends their union once", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    for (const [id, at] of [["first", 10], ["second", 20]] as const) storage.recordNativeInteraction({ bot: "sage", kind: "approval", interactionId: id, sessionId, turnId: "run", status: "pending", expiresAt: 100, payload: {}, updatedAt: at });
    storage.resolveNativeInteraction("sage", "approval", "first", "denied", 30);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "waiting_for_approval", waitingOn: { id: "second" } });
    storage.resolveNativeInteraction("sage", "approval", "second", "approved", 40);
    expect(storage.tasks.read(taskId)?.view.state).toBe("running");
    expect(storage.tasks.suspended("sage", "run", 0, 50)).toBe(30);
    expect(storage.tasks.read(taskId)?.events.filter((event) => event.reason === "approval_requested")).toHaveLength(2);
    storage.close();
  });

  it("settles the real mobile broker's due wait before a Task read, once", () => {
    const storage = openStorage(":memory:");
    let now = 0; storage.tasks.clock(() => now);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    const result = vi.fn();
    const broker = new MobileNodeBroker({
      route: () => ({ status: "available", selectedSocketPresent: true, selectedSocketOpen: true, commandAdvertised: true, connectedSocketCount: 1, foreground: true }),
      send: () => true, result, receipt: () => true, now: () => now, taskWait: (wait) => storage.tasks.device(wait, now),
    });
    storage.tasks.expireDevices((peer, run, id, at) => broker.expireRequest(peer, run, id, at));
    try {
      now = 10;
      broker.invoke({ requestId: "device", agentId: "sage", bot: "sage", threadId: sessionId, turnId: "run", deviceId: "phone", command: "device.status", purpose: "Check readiness", expiresAt: 100 });
      expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "waiting_for_device", waitingOn: { id: "device" } });
      now = 120;
      expect(storage.tasks.read(taskId)?.view.state).toBe("running");
      expect(result).toHaveBeenCalledTimes(1);
      expect(result).toHaveBeenCalledWith("sage", expect.objectContaining({ requestId: "device", status: "expired" }));
      storage.tasks.read(taskId);
      expect(result).toHaveBeenCalledTimes(1);
      expect(storage.tasks.suspended("sage", "run", 0, now)).toBe(90);
    } finally { broker.close(); storage.close(); }
  });

  it("assigns a missing legacy wait expiry once and never renews it on duplicate admission", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
    const input = { bot: "sage", kind: "approval" as const, interactionId: "legacy", sessionId: "session", turnId: "run", status: "pending", payload: {}, updatedAt: 10 };
    storage.recordNativeInteraction(input);
    expect(storage.nativeInteraction("sage", "approval", "legacy")?.expiresAt).toBe(600010);
    storage.recordNativeInteraction({ ...input, updatedAt: 5000 });
    expect(storage.nativeInteraction("sage", "approval", "legacy")?.expiresAt).toBe(600010);
    storage.close();
  });

  it("backfills legacy expiry from its owner's first seen event across restart, excluding foreign opaque-ID collisions", () => {
    const root = join(process.cwd(), "../../benchmark-runs/2b-durable-task");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "expiry-restart-"));
    const path = join(directory, "gateway.sqlite");
    let storage = openStorage(path);
    try {
      const event = { kind: "event" as const, sequence: 1, eventId: "approval", event: { kind: "approval" as const, threadId: "session", turnId: "run", approvalId: "same", callId: "call", name: "write", status: "pending" as const } };
      storage.acceptAttachEvent("foreign", event, 10);
      storage.acceptAttachEvent("sage", event, 100);
      storage.recordNativeInteraction({ bot: "sage", kind: "approval", interactionId: "same", sessionId: "session", turnId: "run", status: "pending", payload: {}, updatedAt: 500 });
      storage.close();
      const legacy = new DatabaseSync(path);
      legacy.prepare("UPDATE bot_native_interactions SET expires_at = NULL WHERE bot = 'sage'").run();
      legacy.close();
      storage = openStorage(path);
      expect(storage.nativeInteraction("sage", "approval", "same")?.expiresAt).toBe(600100);
      storage.close();
      storage = openStorage(path);
      expect(storage.nativeInteraction("sage", "approval", "same")?.expiresAt).toBe(600100);
    } finally { storage.close(); rmSync(directory, { recursive: true }); }
  });

  it("uses a fresh durable absence episode for a second owner loss on the same Run", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
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

  it("starts the provisional owner lease at gateway boot without duplicating an absence episode", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const root = join(process.cwd(), "../../benchmark-runs/2b-durable-task");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "lease-restart-"));
    const path = join(directory, "gateway.sqlite");
    let storage = openStorage(path);
    try {
      const sessionId = storage.nativeBotChat("sage", 1).sessionId;
      const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
      storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
      storage.tasks.presence("sage", false, 10);
      const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
      storage.close(); vi.setSystemTime(200000);
      storage = openStorage(path);
      expect(storage.tasks.read(taskId)?.view.state).toBe("running");
      vi.setSystemTime(320000);
      expect(storage.tasks.read(taskId)?.view.state).toBe("blocked");
      storage.close(); vi.setSystemTime(500000);
      storage = openStorage(path);
      expect(storage.tasks.read(taskId)?.events.filter((event) => event.reason === "owner_unreachable")).toHaveLength(1);
      storage.tasks.hello("sage", 500000);
      expect(storage.tasks.read(taskId)?.view.state).toBe("running");
    } finally { storage.close(); rmSync(directory, { recursive: true }); vi.useRealTimers(); }
  });

  it("persists pause intent on a spooled unacked turn, then interrupts on ack and lands paused only on its terminal", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
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

  it("keeps cancellation pending while a reserved retry still has a live predecessor", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
    storage.tasks.clock(() => 0);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    storage.tasks.presence("sage", true, 3);
    storage.tasks.presence("sage", false, 4);
    storage.tasks.reconcile(120004);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    const retry = storage.tasks.command(taskId, "retry", { idempotencyKey: "retry" }, 120005);
    expect(retry.outcome).toBe("accepted");
    const nextRun = retry.view!.currentRun.runId;
    const cancel = storage.tasks.command(taskId, "cancel", { idempotencyKey: "cancel" }, 120006);
    expect(cancel.view).toMatchObject({ state: "queued", pendingIntent: { command: "cancel" } });
    const sent: string[] = [];
    storage.tasks.dispatch((_peer, _id, command) => { sent.push(command.kind); return true; });
    expect(sent).toEqual(["interrupt"]);
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "stopped", event: { kind: "interrupted", threadId: sessionId, turnId: "run", messageId: "stopped" } }, 120007);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "cancelled", currentRun: { runId: nextRun } });
    storage.tasks.dispatch((_peer, _id, command) => { sent.push(command.kind); return true; });
    expect(sent).toEqual(["interrupt"]);
    storage.close();
  });

  it("projects a room member turn timeout and fences its retry until the actual attach seal", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
    storage.createBotGroup({ key: "room", name: "Room", members: ["sage"], createdAt: 1 });
    const threadId = storage.ensureBotGroupThread("room", "sage");
    storage.beginBotGroupTurn({ key: "room", turnId: "run", member: "sage", agentId: "sage", threadId, messageId: "user", epoch: 0, watermark: 0, createdAt: 2 });
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    const taskId = storage.tasks.list({ room: "room" })[0]!.taskId;
    storage.timeoutBotGroupTurn("room", "run", "deadline", 100);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "blocked", room: "room", lastEvent: { reason: "run_timed_out" } });
    const retry = storage.tasks.command(taskId, "retry", { idempotencyKey: "retry" }, 101);
    const sent: string[] = [];
    storage.tasks.dispatch((peer, id, frame) => { sent.push(frame.kind); return storage.enqueueTaskCommand(peer, id, frame, 102); });
    expect(sent).toEqual(["interrupt"]);
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "stop", event: { kind: "interrupted", threadId, turnId: "run", messageId: "stop" } }, 103);
    storage.tasks.dispatch((peer, id, frame) => { sent.push(frame.kind); return storage.enqueueTaskCommand(peer, id, frame, 104); });
    expect(sent).toEqual(["interrupt", "turn"]);
    expect(storage.botGroupTurn("room", retry.view!.currentRun.runId)).toMatchObject({ state: "pending", member: "sage", threadId });
    expect(storage.tasks.list({ room: "room" })).toHaveLength(1);
    storage.close();
  });

  it.each(["stopped", "needs_attention"])("holds a reserved retry across repeated runtime %s episodes until readiness", (parked) => {
    const storage = openStorage(":memory:"); storage.tasks.clock(() => 0);
    let stage = "ready"; storage.tasks.runtime(() => stage);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "failed", event: { kind: "failed", threadId: sessionId, turnId: "run", messageId: "failure" } }, 4);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    storage.tasks.command(taskId, "retry", { idempotencyKey: "retry" }, 5);
    const sent: string[] = [];
    for (let episode = 0; episode < 2; episode++) {
      stage = parked;
      expect(storage.tasks.read(taskId)?.view.state).toBe(parked === "stopped" ? "waiting_for_user_input" : "blocked");
      storage.tasks.dispatch((peer, id, frame) => { sent.push(frame.kind); return storage.enqueueTaskCommand(peer, id, frame, 6); });
      expect(sent).toEqual([]);
      stage = "ready";
      expect(storage.tasks.read(taskId)?.view.state).toBe("queued");
    }
    storage.tasks.dispatch((peer, id, frame) => { sent.push(frame.kind); return storage.enqueueTaskCommand(peer, id, frame, 7); });
    expect(sent).toEqual(["turn"]);
    storage.close();
  });

  it("accepts no recovery remaining only from a trusted source-bound decision after execution seals", () => {
    const storage = openStorage(":memory:"); storage.tasks.clock(() => 0);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    storage.recordNativeBotTerminal({ bot: "sage", sessionId, turnId: "run", status: "timed_out", completedAt: 4 });
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    expect(storage.tasks.read(taskId)?.view.state).toBe("blocked");
    storage.tasks.recoveryDecisions(() => ({ taskId, runId: "run", issuer: "trusted-policy", decisionId: "decision", reason: "Operator closed permitted recovery" }));
    expect(storage.tasks.read(taskId)?.view.state).toBe("blocked");
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "failed", event: { kind: "failed", threadId: sessionId, turnId: "run", messageId: "failure" } }, 5);
    storage.tasks.recoveryDecisions(() => ({ taskId: "foreign", runId: "run", issuer: "trusted-policy", decisionId: "decision", reason: "Other Task decision" }));
    expect(storage.tasks.read(taskId)?.view.state).toBe("blocked");
    storage.tasks.recoveryDecisions(() => ({ taskId, runId: "run", issuer: "trusted-policy", decisionId: "decision", reason: "Operator closed permitted recovery" }));
    expect(storage.tasks.read(taskId)?.view.state).toBe("failed");
    expect(storage.tasks.read(taskId)?.events.filter((event) => event.reason === "no_recovery_remaining")).toHaveLength(1);
    storage.close();
  });

  it("excludes only catalog-declared slash commands at actual turn admission", () => {
    const storage = openStorage(":memory:"); storage.tasks.clock(() => 0);
    const threadId = storage.nativeBotChat("sage", 1).sessionId;
    storage.tasks.declareSlashCommands("sage", ["help"]);
    for (const [turnId, text] of [["slash", "/help details"], ["work", "/helpful work"], ["unknown", "/unknown work"]]) storage.enqueueAttachCommand("sage", turnId!, { kind: "turn", threadId, turnId: turnId!, messageId: turnId!, text: text! }, 2);
    expect(storage.tasks.list({ bot: "sage" }).map((view) => view.originatingTurnId).sort()).toEqual(["unknown", "work"]);
    storage.close();
  });

  it("retries exactly one discarded unacknowledged command and never retries an acknowledged turn automatically", () => {
    const storage = openStorage(":memory:"); storage.tasks.clock(() => 0);
    const threadId = storage.nativeBotChat("sage", 1).sessionId;
    const first = storage.enqueueAttachCommand("sage", "first", { kind: "turn", threadId, turnId: "run", messageId: "user", text: "work" }, 2);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    storage.cancelAttachCommand("sage", first.sequence, first.commandId, "unacknowledged deadline", 3);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "queued", automaticRetryCount: 1 });
    storage.tasks.dispatch((peer, id, frame) => storage.enqueueTaskCommand(peer, id, frame, 4));
    const next = storage.pendingAttachCommands("sage", first.sequence, 10).find((frame) => frame.command.kind === "turn")!;
    storage.cancelAttachCommand("sage", next.sequence, next.commandId, "unacknowledged deadline", 5);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "blocked", automaticRetryCount: 1 });
    const acked = storage.enqueueAttachCommand("sage", "acked", { kind: "turn", threadId, turnId: "acked-run", messageId: "other", text: "other work" }, 6);
    storage.ackAttachCommand("sage", acked.sequence, acked.commandId, 7);
    storage.cancelAttachCommand("sage", acked.sequence, acked.commandId, "deadline", 8);
    expect(storage.tasks.list({ bot: "sage" }).find((view) => view.currentRun.runId === "acked-run")).toMatchObject({ state: "running", automaticRetryCount: 0 });
    storage.close();
  });

  it("uses source-bound unknown tool roles as possible effects and preserves the current Run", () => {
    const storage = openStorage(":memory:"); storage.tasks.clock(() => 0);
    const threadId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    const tool = (sequence: number, role: "investigation" | "verification" | undefined, status: "running" | "error" = "running", callId = String(sequence)) => ({ kind: "event" as const, sequence, eventId: String(sequence), event: { kind: "tool" as const, threadId, turnId: "run", callId, name: "tool", status, ...(role === undefined ? {} : { role }) } });
    storage.acceptAttachEvent("sage", tool(1, "investigation"), 4);
    storage.acceptAttachEvent("sage", tool(2, "verification"), 5);
    expect(storage.tasks.read(taskId)?.view.state).toBe("running");
    storage.acceptAttachEvent("sage", tool(3, undefined), 6);
    storage.acceptAttachEvent("sage", tool(4, "verification"), 7);
    expect(storage.tasks.read(taskId)?.view.state).toBe("verifying");
    storage.acceptAttachEvent("sage", tool(5, "verification", "error", "4"), 8);
    expect(storage.tasks.read(taskId)?.view.state).toBe("running");
    storage.tasks.ownerDeleted("foreign", 9);
    expect(storage.tasks.read(taskId)?.view.state).toBe("running");
    storage.tasks.ownerDeleted("sage", 10);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "cancelled", lastEvent: { reason: "owner_deleted" } });
    storage.close();
  });

  it("rebuilds accepted pause intent and payload-bound command replay after physical restart", () => {
    const root = join(process.cwd(), "../../benchmark-runs/2b-durable-task"); mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "intent-restart-")); const path = join(directory, "gateway.sqlite");
    let storage = openStorage(path); storage.tasks.clock(() => 0);
    try {
      const threadId = storage.nativeBotChat("sage", 1).sessionId;
      const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId, turnId: "run", messageId: "user", text: "work" }, 2);
      const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
      storage.tasks.command(taskId, "scope", { idempotencyKey: "scope", goal: "revised" }, 3);
      const accepted = storage.tasks.command(taskId, "pause", { idempotencyKey: "pause" }, 4);
      storage.close(); storage = openStorage(path); storage.tasks.clock(() => 0);
      expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "queued", goal: "revised", intentRevision: 2, pendingIntent: { command: "pause" } });
      expect(storage.tasks.command(taskId, "pause", { idempotencyKey: "pause" }, 5)).toEqual(accepted);
      expect(storage.tasks.command(taskId, "cancel", { idempotencyKey: "pause" }, 5).outcome).toBe("conflict");
      storage.ackAttachCommand("sage", command.sequence, command.commandId, 6);
      const effects: string[] = []; storage.tasks.dispatch((_peer, _id, frame) => { effects.push(frame.kind); return true; });
      expect(effects).toContain("interrupt");
      expect(storage.tasks.read(taskId)?.events.filter((event) => event.reason === "pause_requested")).toHaveLength(1);
    } finally { storage.close(); rmSync(directory, { recursive: true }); }
  });

  it("joins explicitly declared Artifact references through the future commitment reader seam", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    const reader = vi.fn(() => [{ artifactId: "declared", status: "pending" as const }]);
    storage.tasks.artifactReferences(reader);
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "final", event: { kind: "commit", threadId: sessionId, turnId: "run", messageId: "reply", blocks: [] } }, 4);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "verifying", artifacts: [{ artifactId: "declared" }] });
    expect(reader).toHaveBeenCalledWith({ taskId, bot: "sage", peer: "sage", sessionId, runId: "run" });
    storage.tasks.artifactReferences(() => []);
    expect(storage.tasks.read(taskId)?.view.state).toBe("verifying");
    storage.tasks.artifactReferences(() => [{ artifactId: "declared", status: "committed" }]);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "completed", notification: { taskId } });
    storage.tasks.artifactReferences(() => [{ artifactId: "declared", status: "failed" }]);
    expect(storage.tasks.read(taskId)?.view.state).toBe("completed");
    storage.close();
  });

  it("holds final proof for a child still in flight and reports its later failure once", () => {
    const storage = openStorage(":memory:");
    storage.tasks.clock(() => 0);
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 2);
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    const child = { kind: "delegation" as const, threadId: sessionId, turnId: "run", batchId: "batch", childId: "child", index: 0, count: 1, lastActiveAt: 4, status: "running" as const };
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "child", event: child }, 4);
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 2, eventId: "final", event: { kind: "commit", threadId: sessionId, turnId: "run", messageId: "reply", blocks: [] } }, 5);
    expect(storage.tasks.read(taskId)?.view.state).toBe("verifying");
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 3, eventId: "child-failed", event: { ...child, status: "failed" } }, 6);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "blocked", lastEvent: { reason: "child_failed", ref: { kind: "child", id: "batch/child" } } });
    expect(storage.tasks.read(taskId)?.view.notification).toBeUndefined();
    storage.close();
  });

});

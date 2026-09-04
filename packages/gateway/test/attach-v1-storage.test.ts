import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

describe("attach-v1 durable transport storage", () => {
  it("commits a direct-session deletion and its one replay-safe tombstone together", () => {
    const storage = openStorage(":memory:");
    const stale = storage.nativeBotChat("sage", 1).sessionId;
    storage.appendNativeBotMessage({ bot: "sage", sessionId: stale, messageId: "private", role: "user", text: "never crosses the tombstone", at: 2 });
    storage.resetNativeBotChat("sage", 3);
    const deleted = storage.deleteNativeBotSession({ bot: "sage", sessionId: stale, deletedAt: 4, enqueue: true });
    expect(deleted).toMatchObject({ outcome: "deleted", sessionSha: createHash("sha256").update(stale).digest("hex") });
    expect(storage.nativeBotMessages("sage", stale)).toEqual([]);
    expect(storage.pendingAttachCommands("sage", 0, 10)).toMatchObject([{
      commandId: `session-deleted:sage:${createHash("sha256").update(stale).digest("hex")}`,
      command: { kind: "session_deleted", deletion: { revision: 1, at: 4 } },
    }]);
    expect(storage.deleteNativeBotSession({ bot: "sage", sessionId: stale, deletedAt: 5, enqueue: true })).toEqual({ outcome: "not_found" });
    storage.close();
  });

  it("reconciles only an issued contiguous plugin resume cursor", () => {
    const storage = openStorage(":memory:");
    storage.enqueueAttachCommand("sage", "c1", { kind: "interrupt", threadId: "t", turnId: "u" }, 1);
    storage.enqueueAttachCommand("sage", "c2", { kind: "interrupt", threadId: "t", turnId: "u" }, 2);
    expect(storage.reconcileAttachResume("sage", 0, 3, 3)).toBe(false);
    expect(storage.pendingAttachCommands("sage", 0, 10)).toHaveLength(2);
    expect(storage.reconcileAttachResume("sage", 0, 2, 4)).toBe(true);
    expect(storage.attachCommandCursor("sage")).toBe(2);
    expect(storage.pendingAttachCommands("sage", 0, 10)).toEqual([]);
    storage.close();
  });

  it("adopts an authenticated plugin's durable cursors when the gateway has no stream", () => {
    const storage = openStorage(":memory:");
    expect(storage.reconcileAttachResume("sage", 118_129, 460, 1)).toBe(true);
    expect(storage.attachEventCursor("sage")).toBe(118_129);
    expect(storage.attachCommandCursor("sage")).toBe(460);
    expect(storage.reconcileAttachResume("sage", 118_129, 460, 2)).toBe(true);
    expect(storage.enqueueAttachCommand("sage", "c461", { kind: "interrupt", threadId: "t", turnId: "u" }, 2).sequence).toBe(461);
    expect(storage.reconcileAttachResume("sage", 118_129, 462, 3)).toBe(false);
    storage.close();
  });

  it("persists command sequence and unacked replay across a gateway restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "attach-v1-")), "gateway.sqlite");
    let storage = openStorage(path);
    expect(storage.enqueueAttachCommand("sage", "c1", { kind: "turn", threadId: "t", turnId: "u", messageId: "m", text: "hi" }, 1).sequence).toBe(1);
    expect(storage.enqueueAttachCommand("sage", "c2", { kind: "interrupt", threadId: "t", turnId: "u" }, 2).sequence).toBe(2);
    expect(storage.ackAttachCommand("sage", 2, "c2", 2)).toBe(true);
    expect(storage.attachCommandCursor("sage")).toBe(0);
    expect(storage.ackAttachCommand("sage", 1, "c1", 3)).toBe(true);
    expect(storage.attachCommandCursor("sage")).toBe(2);
    expect(storage.enqueueAttachCommand("sage", "c3", { kind: "interrupt", threadId: "t", turnId: "u" }, 4).sequence).toBe(3);
    storage.close();

    storage = openStorage(path);
    expect(storage.pendingAttachCommands("sage", 0, 10).map((frame) => frame.commandId)).toEqual(["c3"]);
    expect(storage.enqueueAttachCommand("sage", "c4", { kind: "interrupt", threadId: "t", turnId: "u" }, 5).sequence).toBe(4);
    storage.close();
  });

  it("atomically records one requested native resolution with its replayable stable command", () => {
    const storage = openStorage(":memory:");
    storage.recordNativeInteraction({
      bot: "sage", kind: "approval", interactionId: "approval-1", sessionId: "native:sage:one",
      turnId: "turn-1", payload: { name: "workspace.write" }, status: "pending", updatedAt: 1,
    });
    const request = {
      bot: "sage", kind: "approval" as const, interactionId: "approval-1", decision: "approve",
      commandId: "approval:sage:approval-1",
      command: { kind: "resolve_approval" as const, threadId: "native:sage:one", turnId: "turn-1", approvalId: "approval-1", decision: "approve" as const },
      requestedAt: 2,
    };
    expect(storage.requestNativeInteractionResolution(request)).toMatchObject({ outcome: "requested", fresh: true });
    expect(storage.nativeInteraction("sage", "approval", "approval-1")).toMatchObject({
      status: "pending", resolutionCommandId: request.commandId, resolutionRequestedAt: 2,
      requestedDecision: "approve", requestedOptionId: null,
    });
    expect(storage.pendingAttachCommands("sage", 0, 10)).toMatchObject([{
      commandId: request.commandId, command: request.command,
    }]);
    expect(storage.requestNativeInteractionResolution(request)).toMatchObject({ outcome: "already_requested", fresh: false });
    expect(storage.requestNativeInteractionResolution({
      ...request,
      decision: "deny",
      command: { ...request.command, decision: "deny" },
    })).toMatchObject({ outcome: "resolution_pending", fresh: false });
    expect(storage.pendingAttachCommands("sage", 0, 10)).toHaveLength(1);
    storage.close();
  });

  it("lets a clarification deadline win after a resolution was requested", () => {
    const storage = openStorage(":memory:");
    storage.recordNativeInteraction({
      bot: "sage", kind: "clarify", interactionId: "clarify-1", sessionId: "native:sage:one",
      turnId: "turn-1", payload: { options: [{ id: "a" }] }, status: "pending", expiresAt: 10, updatedAt: 1,
    });
    expect(storage.requestNativeInteractionResolution({
      bot: "sage", kind: "clarify", interactionId: "clarify-1", decision: "select", optionId: "a",
      commandId: "clarify:sage:clarify-1",
      command: { kind: "resolve_clarify", threadId: "native:sage:one", turnId: "turn-1", clarifyId: "clarify-1", optionId: "a" },
      requestedAt: 9,
    })).toMatchObject({ outcome: "requested" });
    expect(storage.expireNativeInteractionIfDue("sage", "clarify", "clarify-1", 10)).toEqual({
      sessionId: "native:sage:one", turnId: "turn-1",
    });
    expect(storage.nativeInteraction("sage", "clarify", "clarify-1")?.status).toBe("expired");
    storage.close();
  });

  it("keeps a bounded durable recovery snapshot distinct from pending approval and clarification actions", () => {
    const storage = openStorage(":memory:");
    storage.recordNativeInteraction({
      bot: "sage", kind: "approval", interactionId: "approval-1", sessionId: "session-1",
      turnId: "turn-1", payload: { name: "workspace.write" }, status: "pending", updatedAt: 1,
    });
    storage.recordNativeInteraction({
      bot: "sage", kind: "clarify", interactionId: "clarify-1", sessionId: "session-1",
      turnId: "turn-1", payload: { prompt: "Pick one", options: [{ id: "a", label: "A" }] },
      status: "pending", expiresAt: 10, updatedAt: 2,
    });
    storage.recordNativeInteraction({
      bot: "sage", kind: "approval", interactionId: "approval-2", sessionId: "session-2",
      turnId: "turn-2", payload: { name: "private args stay private" }, status: "approved", updatedAt: 3,
    });
    storage.recordNativeInteraction({
      bot: "sage", kind: "clarify", interactionId: "clarify-2", sessionId: "session-2",
      turnId: "turn-2", payload: { prompt: "private prompt", options: [] }, status: "selected",
      selectedOptionId: "b", updatedAt: 4,
    });

    expect(storage.pendingNativeApprovals(["sage"], 100)).toEqual([{
      bot: "sage", sessionId: "session-1", turnId: "turn-1", toolCallId: "approval-1",
      ruleName: "workspace.write", createdAt: 1,
    }]);
    expect(storage.pendingNativeClarifications(["sage"], 100)).toEqual([{
      bot: "sage", sessionId: "session-1", turnId: "turn-1", clarifyId: "clarify-1",
      prompt: "Pick one", options: [{ id: "a", label: "A" }], expiresAt: 10,
    }]);
    expect(storage.terminalNativeSettlements(["sage"])).toEqual([
      {
        bot: "sage", kind: "clarify", interactionId: "clarify-2", sessionId: "session-2",
        turnId: "turn-2", outcome: "selected", selectedOptionId: "b", settledAt: 4,
      },
      {
        bot: "sage", kind: "approval", interactionId: "approval-2", sessionId: "session-2",
        turnId: "turn-2", outcome: "approved", settledAt: 3,
      },
    ]);
    storage.close();
  });

  it("retains only the newest bounded terminal settlement receipts per bot", () => {
    const storage = openStorage(":memory:");
    for (let index = 0; index <= 100; index += 1) {
      storage.recordNativeInteraction({
        bot: "sage", kind: "approval", interactionId: `approval-${index}`,
        sessionId: "session", turnId: "turn", payload: { name: "tool" },
        status: "approved", updatedAt: index,
      });
    }
    const settlements = storage.terminalNativeSettlements(["sage"]);
    expect(settlements).toHaveLength(100);
    expect(settlements[0]).toMatchObject({ interactionId: "approval-100", settledAt: 100 });
    expect(settlements.at(-1)).toMatchObject({ interactionId: "approval-1", settledAt: 1 });
    expect(storage.nativeInteraction("sage", "approval", "approval-0")).toBeUndefined();
    storage.close();
  });

  it("returns each bot's retained receipts without a second global cap", () => {
    const storage = openStorage(":memory:");
    for (const bot of ["sage", "cleo"]) {
      for (let index = 0; index < 100; index += 1) {
        storage.recordNativeInteraction({
          bot, kind: "approval", interactionId: `${bot}-${index}`,
          sessionId: `${bot}-session`, turnId: "turn", payload: { name: "tool" },
          status: "approved", updatedAt: index,
        });
      }
    }

    const settlements = storage.terminalNativeSettlements(["sage", "cleo"]);
    expect(settlements).toHaveLength(200);
    expect(new Set(settlements.map((receipt) => receipt.bot))).toEqual(new Set(["sage", "cleo"]));
    storage.close();
  });

  it("deduplicates ack loss, rejects gaps, and seals terminal turns", () => {
    const storage = openStorage(":memory:");
    const commit = { kind: "event" as const, sequence: 1, eventId: "e1", event: { kind: "commit" as const, threadId: "t", turnId: "u", messageId: "m", blocks: [{ type: "paragraph" as const, text: "done" }] } };
    expect(storage.acceptAttachEvent("sage", commit, 1)).toEqual({ status: "accepted", acknowledgedSequence: 1 });
    expect(storage.acceptAttachEvent("sage", commit, 2)).toEqual({ status: "duplicate", acknowledgedSequence: 1 });
    expect(storage.acceptAttachEvent("sage", { kind: "event", sequence: 3, eventId: "e3", event: { kind: "draft", threadId: "t", turnId: "u", blocks: [] } }, 3)).toEqual({ status: "gap", expectedSequence: 2, receivedSequence: 3 });
    expect(storage.acceptAttachEvent("sage", { kind: "event", sequence: 2, eventId: "e2", event: { kind: "draft", threadId: "t", turnId: "u", blocks: [{ type: "paragraph", text: "late" }] } }, 4)).toEqual({ status: "ignored_terminal", acknowledgedSequence: 2 });
    expect(storage.attachEventCursor("sage")).toBe(2);
    storage.close();
  });

  it("keeps later projection blocked by a dead letter across restart until explicit ordered release", () => {
    const path = join(mkdtempSync(join(tmpdir(), "attach-v1-dead-letter-")), "gateway.sqlite");
    let storage = openStorage(path);
    const first = { kind: "event" as const, sequence: 1, eventId: "blocked", event: { kind: "scheduled" as const, threadId: "home", deliveryId: "d1", messageId: "m1", blocks: [{ type: "paragraph" as const, text: "first" }] } };
    const second = { kind: "event" as const, sequence: 2, eventId: "later", event: { kind: "scheduled" as const, threadId: "home", deliveryId: "d2", messageId: "m2", blocks: [{ type: "paragraph" as const, text: "second" }] } };
    expect(storage.acceptAttachEvent("sage", first, 1).status).toBe("accepted");
    expect(storage.acceptAttachEvent("sage", second, 2).status).toBe("accepted");
    expect(storage.recordAttachProjectionFailure("sage", "blocked", "permanent", 3, 1)).toEqual({ attempts: 1, deadLettered: true });
    storage.close();

    storage = openStorage(path);
    expect(storage.unappliedAttachEvents("sage")).toEqual([]);
    expect(storage.releaseAttachProjectionDeadLetter("sage", "later")).toBe(false);
    expect(storage.releaseAttachProjectionDeadLetter("sage", "blocked")).toBe(true);
    expect(storage.unappliedAttachEvents("sage").map((frame) => frame.eventId)).toEqual(["blocked", "later"]);
    storage.close();
  });

  it("prunes only explicitly expired media bytes while preserving live and plugin-supplied rows", () => {
    const storage = openStorage(":memory:");
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const descriptor = (mediaId: string, expiresAt?: number) => ({
      mediaId, mimeType: "image/png", byteCount: bytes.length, sha256, filename: `${mediaId}.png`, family: "image" as const,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    storage.saveAttachMedia("sage", descriptor("expired", 100), bytes, 1);
    storage.saveAttachMedia("sage", descriptor("live", 101), bytes, 1);
    storage.saveAttachMedia("sage", descriptor("plugin"), bytes, 1);
    expect(storage.pruneExpiredAttachMedia(100)).toBe(1);
    // A different descriptor can reuse this id only if the expired row's bytes were actually deleted.
    expect(storage.saveAttachMedia("sage", { ...descriptor("expired"), filename: "replacement.png" }, bytes, 101)).toBe(true);
    expect(storage.attachMediaInfo("sage", "live", 100)?.size).toBe(4);
    expect(storage.attachMediaSlice("sage", "live", 1, 2, 100)).toEqual(new Uint8Array([80, 78]));
    expect(storage.attachMediaInfo("sage", "plugin", 100)?.size).toBe(4);
    expect(storage.pruneExpiredAttachMedia(100)).toBe(0);
    storage.close();
  });

  it("deduplicates scheduled delivery IDs while preserving their stable thread and message", () => {
    const storage = openStorage(":memory:");
    const first = { kind: "event" as const, sequence: 1, eventId: "event-1", event: { kind: "scheduled" as const, threadId: "home", deliveryId: "cron:daily:2026-08-21", messageId: "daily:2026-08-21", blocks: [{ type: "paragraph" as const, text: "daily" }] } };
    expect(storage.acceptAttachEvent("sage", first, 1)).toEqual({ status: "accepted", acknowledgedSequence: 1 });
    expect(storage.acceptAttachEvent("sage", { ...first, sequence: 2, eventId: "event-2" }, 2)).toEqual({ status: "ignored_delivery", acknowledgedSequence: 2 });
    expect(storage.acceptAttachEvent("sage", { ...first, sequence: 3, eventId: "event-3", event: { ...first.event, threadId: "wrong" } }, 3)).toEqual({ status: "conflict", acknowledgedSequence: 2 });
    expect(storage.attachScheduledDelivery("sage", first.event.deliveryId)).toMatchObject({ threadId: "home", messageId: "daily:2026-08-21", projectedAt: null });
    storage.markAttachEventApplied("sage", first.eventId, 4);
    expect(storage.attachScheduledDelivery("sage", first.event.deliveryId)?.projectedAt).toBe(4);
    storage.close();
  });

  it("quarantines an explicit scheduled target that is no longer selected and advances the spool", () => {
    const storage = openStorage(":memory:");
    const historicalSessionId = storage.nativeBotChat("sage", 1).sessionId;
    const selectedSessionId = storage.resetNativeBotChat("sage", 2);
    const frame = {
      kind: "event" as const, sequence: 1, eventId: "stale-explicit-target",
      event: {
        kind: "scheduled" as const, threadId: historicalSessionId,
        deliveryId: "stale-explicit-delivery", messageId: "stale-explicit-message",
        blocks: [{ type: "paragraph" as const, text: "must not reach the retired session" }],
      },
    };
    expect(selectedSessionId).not.toBe(historicalSessionId);
    // This is the admission-time precondition, deliberately not a timing/sleep test. The selected
    // session changed after an earlier authorization check but before this durable transaction.
    expect(storage.acceptAttachEvent("sage", frame, 3)).toEqual({
      status: "discarded", acknowledgedSequence: 1, reason: "unauthorized_target",
    });
    expect(storage.attachEventCursor("sage")).toBe(1);
    expect(storage.attachProjectionFailure("sage", frame.eventId)).toEqual({
      attempts: 0, error: "unauthorized_target", deadLetteredAt: 3,
    });
    expect(storage.releaseAttachProjectionDeadLetter("sage", frame.eventId)).toBe(false);
    expect(storage.attachScheduledDelivery("sage", frame.event.deliveryId)).toBeUndefined();
    storage.close();
  });

  it("durably quarantines a permanently invalid next event without weakening sequence checks", () => {
    const storage = openStorage(":memory:");
    const frame = {
      kind: "event" as const, sequence: 1, eventId: "unsupported-approval",
      event: {
        kind: "approval" as const, threadId: "thread", turnId: "turn",
        approvalId: "approval", callId: "call", name: "shell", status: "pending" as const,
      },
    };
    expect(storage.acceptAttachEvent("sage", frame, 10, "capability_not_negotiated")).toEqual({
      status: "discarded", acknowledgedSequence: 1, reason: "capability_not_negotiated",
    });
    expect(storage.acceptAttachEvent("sage", frame, 11, "capability_not_negotiated")).toEqual({
      status: "duplicate", acknowledgedSequence: 1,
    });
    expect(storage.acceptAttachEvent("sage", { ...frame, sequence: 3, eventId: "gap" }, 12)).toEqual({
      status: "gap", expectedSequence: 2, receivedSequence: 3,
    });
    // Quarantine is complete recovery, not an actionable projection dead letter.
    expect(storage.attachHealth().deadLetters).toBe(0);
    storage.close();
  });

  it("keeps an explicit core-thread scheduled delivery valid while Bot Mode has another selected session", () => {
    const storage = openStorage(":memory:");
    storage.nativeBotChat("sage", 1);
    const frame = {
      kind: "event" as const, sequence: 1, eventId: "core-scheduled-event",
      event: {
        kind: "scheduled" as const, threadId: "core-thread",
        deliveryId: "core-scheduled-delivery", messageId: "core-scheduled-message",
        blocks: [{ type: "paragraph" as const, text: "core report" }],
      },
    };
    expect(storage.acceptAttachEvent("sage", frame, 2)).toEqual({ status: "accepted", acknowledgedSequence: 1 });
    expect(storage.attachScheduledDelivery("sage", frame.event.deliveryId)).toMatchObject({ threadId: "core-thread" });
    storage.close();
  });

  it("derives honest scheduled-delivery receipt stages from the durable inbox", () => {
    const storage = openStorage(":memory:");
    const frame = { kind: "event" as const, sequence: 1, eventId: "receipt-event", event: { kind: "scheduled" as const, threadId: "home", deliveryId: "receipt-daily", messageId: "receipt-message", blocks: [{ type: "paragraph" as const, text: "daily" }] } };
    storage.acceptAttachEvent("sage", frame, 10);
    expect(storage.attachScheduledDeliveryReceipt("sage", "receipt-daily")).toEqual({
      deliveryId: "receipt-daily", messageId: "receipt-message",
      target: { kind: "thread", threadId: "home" }, state: "admitted", admittedAt: 10,
    });
    expect(storage.recordAttachProjectionFailure("sage", frame.eventId, "declined", 11, 1)).toEqual({ attempts: 1, deadLettered: true });
    expect(storage.attachScheduledDeliveryReceipt("sage", "receipt-daily")).toEqual({
      deliveryId: "receipt-daily", messageId: "receipt-message",
      target: { kind: "thread", threadId: "home" }, state: "blocked", admittedAt: 10,
      attempts: 1, deadLetteredAt: 11,
      // Capability 31: `state` stays the pipeline position, `terminal` says the occurrence is dead.
      terminal: { state: "failed", stage: "projection", reason: "declined", at: 11 },
    });
    expect(storage.releaseAttachProjectionDeadLetter("sage", frame.eventId)).toBe(true);
    storage.markAttachEventApplied("sage", frame.eventId, 12);
    expect(storage.attachScheduledDeliveryReceipt("sage", "receipt-daily")).toEqual({
      deliveryId: "receipt-daily", messageId: "receipt-message",
      target: { kind: "thread", threadId: "home" }, state: "projected", admittedAt: 10, projectedAt: 12,
    });
    storage.close();
  });

  it("binds canonical_home at admission and never follows a later selected session", () => {
    const storage = openStorage(":memory:");
    const sessionA = storage.nativeBotChat("sage", 1).sessionId;
    const sessionB = storage.resetNativeBotChat("sage", 2);
    const first = {
      kind: "event" as const, sequence: 1, eventId: "canonical-first",
      event: {
        kind: "scheduled" as const, target: { kind: "canonical_home" as const },
        deliveryId: "canonical-daily", messageId: "canonical-message",
        blocks: [{ type: "paragraph" as const, text: "daily" }],
      },
    };
    expect(storage.acceptAttachEvent("sage", first, 3)).toEqual({ status: "accepted", acknowledgedSequence: 1 });
    expect(storage.attachScheduledDelivery("sage", "canonical-daily")).toMatchObject({ threadId: sessionB, messageId: "canonical-message" });
    expect(storage.attachScheduledDeliveryReceipt("sage", "canonical-daily")).toMatchObject({
      target: { kind: "canonical_home", sessionId: sessionB }, state: "admitted",
    });

    const sessionC = storage.resetNativeBotChat("sage", 4);
    expect(sessionA).not.toBe(sessionB);
    expect(sessionC).not.toBe(sessionB);
    const retry = { ...first, sequence: 2, eventId: "canonical-retry" };
    expect(storage.acceptAttachEvent("sage", retry, 5)).toEqual({ status: "ignored_delivery", acknowledgedSequence: 2 });
    expect(storage.attachScheduledDelivery("sage", "canonical-daily")?.threadId).toBe(sessionB);
    storage.close();
  });

  it("summarizes durable attach backlog, event, terminal, and dead-letter state without frames", () => {
    const storage = openStorage(":memory:");
    storage.enqueueAttachCommand("sage", "queued", { kind: "interrupt", threadId: "t", turnId: "u" }, 1);
    const draft = { kind: "event" as const, sequence: 1, eventId: "draft", event: { kind: "draft" as const, threadId: "t", turnId: "u", blocks: [] } };
    const commit = { kind: "event" as const, sequence: 2, eventId: "commit", event: { kind: "commit" as const, threadId: "t", turnId: "u", messageId: "m", blocks: [] } };
    storage.acceptAttachEvent("sage", draft, 10);
    storage.acceptAttachEvent("sage", commit, 20);
    storage.recordAttachProjectionFailure("sage", "draft", "projection failed", 30, 1);
    storage.recordNativeBotTerminal({ bot: "sage", sessionId: "t", turnId: "queued-timeout", status: "timed_out", completedAt: 40 });
    expect(storage.attachHealth()).toEqual({
      lastEventAt: 20, lastTerminalAt: 40, queueDepth: 1, deadLetters: 1,
      pluginOutboxDepth: 0, pluginOldestEventAgeMs: 0,
      pluginLastAckProgressAt: null, pluginCommandInboxDepth: 0,
    });
    storage.close();
  });

  it("closes orphaned running tools on restart without touching the active turn", () => {
    const path = join(mkdtempSync(join(tmpdir(), "attach-v1-orphaned-tools-")), "gateway.sqlite");
    let storage = openStorage(path);
    const oldSessionId = storage.resetNativeBotChat("sage", 1);
    storage.setNativeBotTurn("sage", oldSessionId, "orphaned-turn", 2);
    const sessionId = storage.resetNativeBotChat("sage", 1);
    storage.setNativeBotTurn("sage", sessionId, "active-turn", 2);
    for (const [turnId, toolSessionId] of [["orphaned-turn", oldSessionId], ["active-turn", sessionId]] as const) {
      storage.upsertBotChatToolStep({
        bot: "sage", sessionId: toolSessionId, turnId, stepId: `${turnId}-step`, seq: 1,
        name: "terminal", status: "running", startedAt: 3, endedAt: undefined,
      });
    }
    storage.close();

    storage = openStorage(path);
    const steps = [...storage.botChatToolSteps(oldSessionId, 0), ...storage.botChatToolSteps(sessionId, 0)];
    expect(steps.find((step) => step.turnId === "orphaned-turn")).toMatchObject({ status: "interrupted" });
    expect(steps.find((step) => step.turnId === "orphaned-turn")?.endedAt).not.toBeNull();
    expect(steps.find((step) => step.turnId === "active-turn")).toMatchObject({ status: "running", endedAt: null });
    storage.close();
  });
});

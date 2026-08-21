import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

describe("attach-v1 durable transport storage", () => {
  it("reconciles only an issued contiguous plugin resume cursor", () => {
    const storage = openStorage(":memory:");
    storage.enqueueAttachCommand("sage", "c1", { kind: "interrupt", threadId: "t", turnId: "u" }, 1);
    storage.enqueueAttachCommand("sage", "c2", { kind: "interrupt", threadId: "t", turnId: "u" }, 2);
    expect(storage.reconcileAttachCommandResume("sage", 3, 3)).toBe(false);
    expect(storage.pendingAttachCommands("sage", 0, 10)).toHaveLength(2);
    expect(storage.reconcileAttachCommandResume("sage", 2, 4)).toBe(true);
    expect(storage.attachCommandCursor("sage")).toBe(2);
    expect(storage.pendingAttachCommands("sage", 0, 10)).toEqual([]);
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

  it("stores immutable media bytes scoped by agent and expires them", () => {
    const storage = openStorage(":memory:");
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    storage.saveAttachMedia("sage", { mediaId: "media", mimeType: "image/png", byteCount: bytes.length, sha256, filename: "x.png", family: "image", expiresAt: 100 }, bytes, 1);
    expect(storage.attachMediaInfo("sage", "media", 99)?.size).toBe(4);
    expect(storage.attachMediaSlice("sage", "media", 1, 2, 99)).toEqual(new Uint8Array([80, 78]));
    expect(storage.attachMediaInfo("other", "media", 99)).toBeUndefined();
    expect(storage.attachMediaInfo("sage", "media", 100)).toBeUndefined();
    expect(() => storage.saveAttachMedia("sage", { mediaId: "media", mimeType: "image/png", byteCount: bytes.length, sha256, filename: "different.png", family: "image" }, bytes, 2)).toThrow();
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
});

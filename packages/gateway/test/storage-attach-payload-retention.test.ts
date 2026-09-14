import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { AttachV1Event } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage } from "../src/storage.ts";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = 20 * DAY;
const RETENTION = 14 * DAY;
const OLD = NOW - RETENTION - 1;

describe("attach payload compaction", () => {
  it("removes expired copies while preserving cursor, durable facts, and raw-reader proofs", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-attach-retention-"));
    const path = join(directory, "gateway.sqlite");
    const storage = openStorage(path);
    try {
      const sessionId = storage.nativeBotChat("sage", 1).sessionId;
      storage.appendNativeBotMessage({
        bot: "sage", sessionId, messageId: "durable-message", role: "assistant", text: "durable answer", at: 2,
      });
      const media = Uint8Array.from([1, 2, 3]);
      storage.saveAttachMedia("sage", {
        mediaId: "scheduled-media", mimeType: "image/png", byteCount: media.byteLength,
        sha256: createHash("sha256").update(media).digest("hex"), filename: "scheduled.png", family: "image",
      }, media, 2);

      let sequence = 1;
      const apply = (eventId: string, event: AttachV1Event, appliedAt = OLD) => {
        const frame = { kind: "event" as const, sequence, eventId, event };
        expect(storage.acceptAttachEvent("sage", frame, OLD).status).toBe("accepted");
        storage.markAttachEventApplied("sage", eventId, appliedAt);
        sequence += 1;
        return frame;
      };

      const tool = apply("tool", {
        kind: "tool", threadId: sessionId, turnId: "sealed", callId: "call", name: "search", status: "ok", role: "verification", detail: "diagnostic detail",
      });
      apply("draft", {
        kind: "draft", threadId: sessionId, turnId: "sealed", blocks: [{ type: "paragraph", text: "raw draft" }], replace: true,
      });
      apply("thinking", {
        kind: "thinking", threadId: sessionId, turnId: "sealed", text: "private preview", seq: 7, lastActiveAt: OLD,
      });
      apply("interim", {
        kind: "commit", threadId: sessionId, turnId: "sealed", messageId: "interim-message",
        blocks: [{ type: "paragraph", text: "interim raw copy" }], mediaIds: ["scheduled-media"], mediaPositions: [0], continues: true,
      });
      apply("delegation", {
        kind: "delegation", threadId: sessionId, turnId: "sealed", batchId: "batch", childId: "child", index: 4, count: 2,
        label: "child label", status: "succeeded", currentTool: "exec", apiCalls: 4, toolCount: 3, costUsd: 1.25,
        costStatus: "reported", schemaValidation: { valid: true, retries: 1 }, durationMs: 90, lastActiveAt: OLD, aliasId: "deleg-id",
      });
      apply("boundary", {
        kind: "draft", threadId: sessionId, turnId: "sealed", blocks: [{ type: "paragraph", text: "at cutoff" }],
      }, NOW - RETENTION);
      apply("scheduled", {
        kind: "scheduled", threadId: sessionId, deliveryId: "delivery", messageId: "scheduled-message",
        blocks: [{ type: "paragraph", text: "scheduled raw copy" }], mediaIds: ["scheduled-media"], mediaPositions: [0],
      });
      apply("approval", {
        kind: "approval", threadId: sessionId, turnId: "sealed", approvalId: "approval", callId: "call", name: "dangerous",
        status: "approved", detail: "must remain in its durable interaction record", repair: { too: "raw" }, scope: { too: "raw" },
      });
      const pending = { kind: "event" as const, sequence, eventId: "pending", event: {
        kind: "draft" as const, threadId: sessionId, turnId: "sealed", blocks: [{ type: "paragraph" as const, text: "not projected" }],
      } };
      expect(storage.acceptAttachEvent("sage", pending, OLD).status).toBe("accepted");
      sequence += 1;
      apply("final", {
        kind: "commit", threadId: sessionId, turnId: "sealed", messageId: "final-message",
        blocks: [{ type: "paragraph", text: "final raw copy" }], mediaIds: ["scheduled-media"], mediaPositions: [0],
      });

      // An applied terminal record can coexist with a stale active pointer after a crash; the
      // pointer wins and leaves that turn's raw transport payload alone.
      apply("active-draft", {
        kind: "draft", threadId: sessionId, turnId: "active", blocks: [{ type: "paragraph", text: "active" }],
      });
      apply("active-final", {
        kind: "commit", threadId: sessionId, turnId: "active", messageId: "active-message", blocks: [{ type: "paragraph", text: "active final" }],
      });
      storage.setNativeBotTurn("sage", sessionId, "active", NOW);

      const deadLetter = { kind: "event" as const, sequence, eventId: "dead-letter", event: {
        kind: "draft" as const, threadId: sessionId, turnId: "unsealed", blocks: [{ type: "paragraph" as const, text: "dead letter" }],
      } };
      expect(storage.acceptAttachEvent("sage", deadLetter, OLD).status).toBe("accepted");
      storage.recordAttachProjectionFailure("sage", "dead-letter", "declined", OLD, 1);

      expect(compactionPlan(path)).toMatch(/SEARCH attach_event_inbox USING INDEX attach_event_inbox_payload_compaction/);
      expect(storage.compactAttachPayloads(NOW)).toBe(7);
      expect(storage.compactAttachPayloads(NOW)).toBe(0);

      const compactedTool = rawEvent(path, "tool");
      expect(compactedTool).toEqual({ kind: "event", sequence: tool.sequence, eventId: "tool", event: { kind: "tool", threadId: sessionId, turnId: "sealed" } });
      expect(rawEvent(path, "interim").event).toMatchObject({ kind: "commit", threadId: sessionId, turnId: "sealed", continues: true, mediaIds: ["scheduled-media"] });
      expect(rawEvent(path, "interim").event).not.toHaveProperty("blocks");
      expect(rawEvent(path, "delegation").event).toEqual({ kind: "delegation", threadId: sessionId, turnId: "sealed", batchId: "batch", childId: "child", count: 2, status: "succeeded" });
      expect(rawEvent(path, "scheduled").event).toMatchObject({ kind: "scheduled", threadId: sessionId, deliveryId: "delivery", messageId: "scheduled-message", mediaIds: ["scheduled-media"] });
      expect(rawEvent(path, "scheduled").event).not.toHaveProperty("blocks");
      expect(rawEvent(path, "approval").event).toMatchObject({ detail: "must remain in its durable interaction record", repair: { too: "raw" }, scope: { too: "raw" } });
      expect(rawEvent(path, "boundary").event).toHaveProperty("blocks");
      expect(rawEvent(path, "active-draft").event).toHaveProperty("blocks");
      expect(rawEvent(path, "pending").event).toHaveProperty("blocks");
      expect(rawEvent(path, "dead-letter").event).toHaveProperty("blocks");

      expect(storage.attachTurnSealEvidence("sage", "sealed", "interim")).toEqual({ kind: "commit", continues: true, disposition: "accepted" });
      expect(storage.attachScheduledDeliveryReceipt("sage", "delivery")).toMatchObject({
        state: "projected", target: { kind: "thread", threadId: sessionId }, expectedMediaIds: ["scheduled-media"],
      });
      expect(storage.deleteUnreferencedAttachMedia("sage", "scheduled-media")).toBe("referenced");
      expect(storage.nativeBotMessage("sage", "durable-message")).toMatchObject({ text: "durable answer" });

      expect(storage.acceptAttachEvent("sage", tool, NOW).status).toBe("duplicate");
      expect(storage.acceptAttachEvent("sage", { ...tool, sequence: 999 }, NOW).status).toBe("conflict");
      expect(storage.compactAttachPayloads(NOW + 1)).toBe(1);
      expect(rawEvent(path, "boundary").event).not.toHaveProperty("blocks");
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("limits each pass to 256 candidates and becomes idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-attach-retention-batch-"));
    const path = join(directory, "gateway.sqlite");
    const storage = openStorage(path);
    try {
      const sessionId = storage.nativeBotChat("sage", 1).sessionId;
      for (let sequence = 1; sequence <= 257; sequence += 1) {
        const eventId = `draft-${sequence}`;
        expect(storage.acceptAttachEvent("sage", {
          kind: "event", sequence, eventId,
          event: { kind: "draft", threadId: sessionId, turnId: "sealed", blocks: [{ type: "paragraph", text: `draft-${sequence}` }] },
        }, OLD).status).toBe("accepted");
        storage.markAttachEventApplied("sage", eventId, OLD);
      }
      expect(storage.acceptAttachEvent("sage", {
        kind: "event", sequence: 258, eventId: "terminal",
        event: { kind: "commit", threadId: sessionId, turnId: "sealed", messageId: "terminal", blocks: [{ type: "paragraph", text: "terminal" }] },
      }, OLD).status).toBe("accepted");
      storage.markAttachEventApplied("sage", "terminal", OLD);

      expect(storage.compactAttachPayloads(NOW)).toBe(256);
      expect(storage.compactAttachPayloads(NOW)).toBe(2);
      expect(storage.compactAttachPayloads(NOW)).toBe(0);
      expect(rawEvent(path, "draft-1").event).not.toHaveProperty("blocks");
      expect(rawEvent(path, "draft-257").event).not.toHaveProperty("blocks");
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses UTF-8 bytes for the 4 MiB pass budget", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-attach-retention-bytes-"));
    const path = join(directory, "gateway.sqlite");
    const storage = openStorage(path);
    try {
      const sessionId = storage.nativeBotChat("sage", 1).sessionId;
      // Each source JSON is about 2.4 MiB in UTF-8 but only 800k SQLite characters. Counting
      // characters would incorrectly compact both in one 4 MiB maintenance pass.
      const text = "€".repeat(800_000);
      for (let sequence = 1; sequence <= 2; sequence += 1) {
        const eventId = `unicode-${sequence}`;
        expect(storage.acceptAttachEvent("sage", {
          kind: "event", sequence, eventId,
          event: { kind: "draft", threadId: sessionId, turnId: "sealed", blocks: [{ type: "paragraph", text }] },
        }, OLD).status).toBe("accepted");
        storage.markAttachEventApplied("sage", eventId, OLD);
      }
      expect(storage.acceptAttachEvent("sage", {
        kind: "event", sequence: 3, eventId: "unicode-terminal",
        event: { kind: "commit", threadId: sessionId, turnId: "sealed", messageId: "terminal", blocks: [{ type: "paragraph", text: "done" }] },
      }, OLD).status).toBe("accepted");
      storage.markAttachEventApplied("sage", "unicode-terminal", OLD);

      expect(storage.compactAttachPayloads(NOW)).toBe(1);
      expect(rawEvent(path, "unicode-1").event).not.toHaveProperty("blocks");
      expect(rawEvent(path, "unicode-2").event).toHaveProperty("blocks");
      expect(storage.compactAttachPayloads(NOW)).toBe(2);
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resumes beyond a retained-scale protected prefix", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-attach-retention-protected-"));
    const path = join(directory, "gateway.sqlite");
    const protectedRows = 127_757;
    let storage: ReturnType<typeof openStorage> | undefined = openStorage(path);
    storage.close();
    storage = undefined;
    try {
      const db = new DatabaseSync(path);
      const insert = db.prepare(`INSERT INTO attach_event_inbox
        (agent_id, sequence, event_id, frame_json, received_at, disposition, applied_at)
        VALUES ('sage', ?, ?, ?, ?, 'accepted', ?)`);
      db.exec("BEGIN");
      try {
        for (let sequence = 1; sequence <= 256; sequence += 1) {
          const eventId = `orphan-${sequence}`;
          insert.run(sequence, eventId, JSON.stringify({
            kind: "event", sequence, eventId,
            event: { kind: "draft", threadId: "session", turnId: "orphan-head", blocks: [{ type: "paragraph", text: "retained raw" }] },
          }), OLD, OLD);
        }
        const sequence = 257;
        insert.run(sequence, "settled", JSON.stringify({
          kind: "event", sequence, eventId: "settled",
          event: { kind: "draft", threadId: "session", turnId: "settled", blocks: [{ type: "paragraph", text: "compact me" }] },
        }), OLD, OLD);
        db.prepare(`INSERT INTO attach_turn_terminals
          (agent_id, turn_id, event_id, terminal_kind, message_id, sequence, received_at)
          VALUES ('sage', 'settled', 'terminal', 'commit', 'message', ?, ?)`).run(sequence, OLD);
        for (let tail = sequence + 1; tail <= protectedRows; tail += 1) {
          const eventId = `orphan-${tail}`;
          insert.run(tail, eventId, JSON.stringify({
            kind: "event", sequence: tail, eventId,
            event: { kind: "draft", threadId: "session", turnId: "orphan-tail", blocks: [{ type: "paragraph", text: "retained raw" }] },
          }), OLD, OLD);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      expect(compactionPlan(path)).toMatch(/USING INDEX attach_event_inbox_payload_compaction/);
      db.close();

      storage = openStorage(path);
      const started = performance.now();
      expect(storage.compactAttachPayloads(NOW)).toBe(0);
      const protectedPrefixMs = performance.now() - started;
      const resumedStarted = performance.now();
      expect(storage.compactAttachPayloads(NOW)).toBe(1);
      const resumedMs = performance.now() - resumedStarted;
      expect(rawEvent(path, "settled").event).not.toHaveProperty("blocks");
      console.info(`gateway-attach-payload-retention-audit ${JSON.stringify({
        protectedRows, protectedPrefixMs, resumedMs,
      })}`);
    } finally {
      storage?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

function rawEvent(path: string, eventId: string): { kind: string; sequence: number; eventId: string; event: Record<string, unknown> } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT frame_json AS frameJson FROM attach_event_inbox WHERE event_id = ?").get(eventId) as { frameJson: string } | undefined;
    if (row === undefined) throw new Error(`missing event ${eventId}`);
    return JSON.parse(row.frameJson) as { kind: string; sequence: number; eventId: string; event: Record<string, unknown> };
  } finally {
    db.close();
  }
}

function compactionPlan(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'attach_event_inbox_payload_compaction'")
      .get() as { sql: string } | undefined;
    if (index === undefined) throw new Error("missing compaction index");
    const predicate = index.sql.slice(index.sql.indexOf("WHERE") + "WHERE".length).trim().replace(/;$/, "");
    const rows = db.prepare(
       `EXPLAIN QUERY PLAN
       SELECT agent_id FROM attach_event_inbox INDEXED BY attach_event_inbox_payload_compaction
        WHERE ${predicate} AND applied_at < ${NOW}`,
    ).all() as Array<{ detail: string }>;
    return rows.map((row) => row.detail).join("\n");
  } finally {
    db.close();
  }
}

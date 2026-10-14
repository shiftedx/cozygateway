import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openStorage } from "../src/storage.ts";

describe("Task child inbox index", () => {
  it("upgrades an existing inbox and reads only ordered accepted children through the partial index", () => {
    const directory = mkdtempSync(join(tmpdir(), "task-children-index-"));
    const path = join(directory, "gateway.sqlite");
    let storage = openStorage(path);
    try {
      const sessionId = storage.nativeBotChat("sage", 1).sessionId;
      const command = storage.enqueueAttachCommand("sage", "command", {
        kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "delegate",
      }, 2);
      storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
      const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
      const delegation = (sequence: number, eventId: string, threadId: string, turnId: string, childId: string, status: "running" | "succeeded") => ({
        kind: "event" as const, sequence, eventId,
        event: {
          kind: "delegation" as const, threadId, turnId, batchId: "batch", childId,
          index: 0, count: 2, status, lastActiveAt: sequence,
        },
      });

      // These are durable pre-upgrade rows. Only the two exact, accepted rows belong to this Run.
      expect(storage.acceptAttachEvent("sage", delegation(1, "wrong-thread", "other-thread", "run", "wrong-thread", "running"), 4).status).toBe("accepted");
      expect(storage.acceptAttachEvent("sage", delegation(2, "first", sessionId, "run", "first", "succeeded"), 5).status).toBe("accepted");
      expect(storage.acceptAttachEvent("sage", delegation(3, "wrong-run", sessionId, "other-run", "wrong-run", "running"), 6).status).toBe("accepted");
      expect(storage.acceptAttachEvent("sage", delegation(4, "second", sessionId, "run", "second", "running"), 7).status).toBe("accepted");
      expect(storage.acceptAttachEvent("sage", delegation(5, "discarded", sessionId, "run", "discarded", "running"), 8, "capability_not_negotiated").status).toBe("discarded");
      expect(storage.acceptAttachEvent("other", delegation(1, "wrong-peer", sessionId, "run", "wrong-peer", "running"), 9).status).toBe("accepted");
      storage.close();

      // Simulate a database created before this index existed. Reopening must repair it before
      // Task reads, without relying on ANALYZE statistics.
      const prior = new DatabaseSync(path);
      prior.exec("DROP INDEX attach_event_inbox_task_children");
      expect(prior.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'attach_event_inbox_task_children'").get()).toBeUndefined();
      prior.close();

      storage = openStorage(path);
      expect(storage.tasks.read(taskId)?.view.children).toEqual([
        { batchId: "batch", childId: "first", status: "succeeded" },
        { batchId: "batch", childId: "second", status: "running" },
      ]);

      const db = new DatabaseSync(path);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'attach_event_inbox_task_children'").get()).toEqual({ 1: 1 });
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get()).toBeUndefined();
      const plan = db.prepare(`EXPLAIN QUERY PLAN
        SELECT frame_json AS json FROM attach_event_inbox INDEXED BY attach_event_inbox_task_children
        WHERE agent_id = ? AND disposition = 'accepted'
        AND json_extract(frame_json, '$.event.kind') = 'delegation'
        AND json_extract(frame_json, '$.event.threadId') = ?
        AND json_extract(frame_json, '$.event.turnId') = ?
        ORDER BY sequence`).all("sage", sessionId, "run") as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join("\n")).toContain("USING INDEX attach_event_inbox_task_children");
      db.close();
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

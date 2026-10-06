import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

describe("indexed attach turn-command lookup", () => {
  it("selects the newest matching non-cancelled turn without crossing peers or command kinds", () => {
    const directory = mkdtempSync(join(tmpdir(), "attach-turn-command-lookup-"));
    const path = join(directory, "gateway.sqlite");
    let storage: ReturnType<typeof openStorage> | undefined = openStorage(path);
    try {
      const older = storage.enqueueAttachCommand("sage", "turn-older", {
        kind: "turn", threadId: "sage-thread", turnId: "target", messageId: "older-message", text: "older",
      }, 1);
      storage.enqueueAttachCommand("sage", "same-turn-steer", {
        kind: "steer", threadId: "sage-thread", turnId: "target", messageId: "steer-message", text: "steer",
      }, 2);
      const newer = storage.enqueueAttachCommand("sage", "turn-newer", {
        kind: "turn", threadId: "sage-thread", turnId: "target", messageId: "newer-message", text: "newer",
      }, 3);
      storage.enqueueAttachCommand("other", "other-turn", {
        kind: "turn", threadId: "other-thread", turnId: "target", messageId: "other-message", text: "other",
      }, 4);

      expect(storage.attachTurnCommand("sage", "target")).toEqual({
        threadId: "sage-thread", messageId: "newer-message",
      });
      expect(storage.attachTurnCommand("other", "target")).toEqual({
        threadId: "other-thread", messageId: "other-message",
      });
      expect(storage.attachTurnCommand("sage", "missing")).toBeUndefined();

      storage.cancelAttachCommand("sage", newer.sequence, newer.commandId, "test cancellation", 5);
      expect(storage.attachTurnCommand("sage", "target")).toEqual({
        threadId: "sage-thread", messageId: "older-message",
      });
      expect(older.sequence).toBeLessThan(newer.sequence);
      storage.close();
      storage = undefined;

      // command_json is produced by JSON.stringify in every production writer, but the column is
      // historical TEXT rather than JSON-constrained. A manually damaged row stays out of the
      // partial index and cannot prevent a valid lookup or an index migration from opening.
      const raw = new DatabaseSync(path);
      raw.prepare(
        `INSERT INTO attach_command_outbox
           (agent_id, sequence, command_id, command_json, created_at, acked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run("sage", 100, "malformed-legacy-row", "not-json", 6);
      const plan = raw.prepare(`EXPLAIN QUERY PLAN
        SELECT command_json AS commandJson FROM attach_command_outbox
        INDEXED BY attach_command_outbox_turn_lookup
        WHERE agent_id = ? AND cancelled_at IS NULL AND json_valid(command_json)
          AND json_extract(command_json, '$.kind') = 'turn'
          AND json_extract(command_json, '$.turnId') = ?
        ORDER BY sequence DESC LIMIT 1`).all("sage", "target") as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join("\n")).toContain("USING INDEX attach_command_outbox_turn_lookup");
      // Existing attach databases run SCHEMA again at startup. Dropping the index simulates a
      // pre-index database and proves that migration can build it even with the malformed row.
      raw.exec("DROP INDEX attach_command_outbox_turn_lookup");
      raw.close();

      const reopenedStorage = openStorage(path);
      storage = reopenedStorage;
      expect(reopenedStorage.attachTurnCommand("sage", "target")).toEqual({
        threadId: "sage-thread", messageId: "older-message",
      });
    } finally {
      storage?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

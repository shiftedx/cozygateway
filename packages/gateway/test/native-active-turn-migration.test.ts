import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

// Issue #191. bot_native_sessions.active_turn_id is the only copy of a native turn; the selected
// chat's turn is derived by joining the bot_native_chats pointer to its session row.
describe("native active turn single source of truth", () => {
  it("migrates a database that still carries the bot_native_chats copy", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-active-turn-"));
    const path = join(directory, "gateway.sqlite");
    let storage: ReturnType<typeof openStorage> | undefined;
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE bot_native_chats (
        bot TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        active_turn_id TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE bot_native_sessions (
        bot TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        active_turn_id TEXT,
        PRIMARY KEY (bot, session_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE bot_chat_tool_steps (
        bot TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        detail TEXT,
        error_text TEXT,
        PRIMARY KEY (bot, turn_id, step_id)
      ) STRICT, WITHOUT ROWID;`);
      const chat = legacy.prepare("INSERT INTO bot_native_chats VALUES (?, ?, ?, ?)");
      const session = legacy.prepare("INSERT INTO bot_native_sessions VALUES (?, ?, ?, ?, ?)");
      // Both copies agree, as every writer kept them.
      chat.run("luna", "s-luna", "t-luna", 10);
      session.run("luna", "s-luna", 5, 10, "t-luna");
      // A pointer whose companion session row is missing: its copy is the only record of the turn.
      chat.run("sage", "s-sage", "t-sage", 20);
      // A reselected session whose live turn the old pointer copy had nulled: the session wins.
      chat.run("pixel", "s-pixel", null, 30);
      session.run("pixel", "s-pixel", 25, 30, "t-pixel");
      const step = legacy.prepare("INSERT INTO bot_chat_tool_steps VALUES (?, ?, ?, ?, 0, 'shell', 'running', 1, NULL, NULL, NULL)");
      step.run("luna", "s-luna", "t-luna", "live");
      step.run("luna", "s-luna", "t-old", "stale");
      step.run("sage", "s-sage", "t-sage", "healed");
      step.run("pixel", "s-pixel", "t-pixel", "reselected");
      legacy.close();

      storage = openStorage(path);
      const db = new DatabaseSync(path);
      const chatColumns = (db.prepare("PRAGMA table_info(bot_native_chats)").all() as Array<{ name: string }>)
        .map(column => column.name);
      expect(chatColumns).toEqual(["bot", "session_id", "updated_at"]);
      const steps = Object.fromEntries(
        (db.prepare("SELECT step_id AS stepId, status FROM bot_chat_tool_steps").all() as Array<{ stepId: string; status: string }>)
          .map(row => [row.stepId, row.status]),
      );
      db.close();
      // The restart sweep runs after the migration, so the healed turn keeps its running step.
      expect(steps).toEqual({ live: "running", stale: "interrupted", healed: "running", reselected: "running" });

      expect(storage.nativeBotChat("luna", 40)).toEqual({ sessionId: "s-luna", created: false, activeTurnId: "t-luna" });
      expect(storage.nativeBotChat("sage", 40)).toEqual({ sessionId: "s-sage", created: false, activeTurnId: "t-sage" });
      expect(storage.nativeBotActiveTurns("sage")).toEqual([{ sessionId: "s-sage", turnId: "t-sage" }]);
      expect(storage.nativeBotActiveTurn("pixel")).toEqual({ sessionId: "s-pixel", turnId: "t-pixel" });

      // One write and one clear now move the only copy.
      expect(storage.clearNativeBotTurn("luna", "s-luna", "t-luna", 50)).toBe(true);
      expect(storage.nativeBotActiveTurn("luna")).toBeUndefined();
      storage.setNativeBotTurn("luna", "s-luna", "t-next", 60);
      expect(storage.nativeBotChat("luna", 60).activeTurnId).toBe("t-next");

      // Reopening an already-migrated database is harmless.
      storage.close();
      storage = openStorage(path);
      expect(storage.nativeBotActiveTurn("luna")).toEqual({ sessionId: "s-luna", turnId: "t-next" });
    } finally {
      storage?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives the selected chat's turn from its session across reset and reselection", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-active-turn-"));
    const storage = openStorage(join(directory, "gateway.sqlite"));
    try {
      const first = storage.nativeBotChat("luna", 1).sessionId;
      storage.setNativeBotTurn("luna", first, "t-1", 2);
      expect(storage.nativeBotActiveTurn("luna")).toEqual({ sessionId: first, turnId: "t-1" });

      const second = storage.resetNativeBotChat("luna", 3);
      expect(storage.nativeBotActiveTurn("luna")).toBeUndefined();
      expect(storage.nativeBotChat("luna", 4)).toEqual({ sessionId: second, created: false });

      // The first session's turn never stopped running; reselecting it must show that.
      expect(storage.selectNativeBotSession("luna", first, 5)).toBe(true);
      expect(storage.nativeBotActiveTurn("luna")).toEqual({ sessionId: first, turnId: "t-1" });
      expect(storage.nativeBotChat("luna", 6).activeTurnId).toBe("t-1");
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

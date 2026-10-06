import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

// Issue #191. bot_native_sessions.active_turn_id is the only copy of a native turn; the selected
// chat's turn is derived by joining the bot_native_chats pointer to its session row.
describe("native active turn single source of truth", () => {
  it("migrates a v0.8.6 database that still carries the bot_native_chats copy", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-active-turn-"));
    const path = join(directory, "gateway.sqlite");
    let storage: ReturnType<typeof openStorage> | undefined;
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(V086_TABLES);
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
      const delegation = legacy.prepare(
        `INSERT INTO bot_chat_delegations (bot, session_id, turn_id, batch_id, child_id, child_index, batch_count,
           status, last_active_at, started_at) VALUES (?, ?, ?, 'b', ?, 0, 1, 'running', 1, 1)`,
      );
      delegation.run("luna", "s-luna", "t-luna", "live");
      delegation.run("luna", "s-luna", "t-old", "stale");
      delegation.run("sage", "s-sage", "t-sage", "healed");
      delegation.run("pixel", "s-pixel", "t-pixel", "reselected");
      legacy.close();

      storage = openStorage(path);
      const db = new DatabaseSync(path);
      // The copy is cleared, not dropped, so a rolled-back release can still name it.
      expect(db.prepare("SELECT bot, active_turn_id AS turnId FROM bot_native_chats ORDER BY bot").all())
        .toEqual([{ bot: "luna", turnId: null }, { bot: "pixel", turnId: null }, { bot: "sage", turnId: null }]);
      const statuses = (table: string, id: string) => Object.fromEntries(
        (db.prepare(`SELECT ${id} AS id, status FROM ${table}`).all() as Array<{ id: string; status: string }>)
          .map(row => [row.id, row.status]),
      );
      // The restart sweeps run after the migration, so the healed turn keeps its live work.
      expect(statuses("bot_chat_tool_steps", "step_id"))
        .toEqual({ live: "running", stale: "interrupted", healed: "running", reselected: "running" });
      expect(statuses("bot_chat_delegations", "child_id"))
        .toEqual({ live: "running", stale: "unknown", healed: "running", reselected: "running" });
      db.close();

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

  it("leaves a migrated database readable by a rolled-back v0.8.6 gateway", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-active-turn-"));
    const path = join(directory, "gateway.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(V086_TABLES);
      legacy.prepare("INSERT INTO bot_native_chats VALUES ('luna', 's-luna', 't-luna', 1)").run();
      legacy.prepare("INSERT INTO bot_native_sessions VALUES ('luna', 's-luna', 1, 1, 't-luna')").run();
      legacy.close();
      openStorage(path).close();

      // Every v0.8.6 statement that names bot_native_chats.active_turn_id, verbatim, must still run.
      const rolledBack = new DatabaseSync(path);
      try {
        for (const [sql, ...params] of V086_CHAT_TURN_STATEMENTS)
          expect(() => rolledBack.prepare(sql).all(...params), sql).not.toThrow();
        // The rolled-back writer re-fills the copy; the next upgrade clears it again.
        expect(rolledBack.prepare("SELECT active_turn_id AS turnId FROM bot_native_chats WHERE bot = 'luna'").get())
          .toEqual({ turnId: "t-2" });
      } finally {
        rolledBack.close();
      }
      const upgraded = openStorage(path);
      try {
        const db = new DatabaseSync(path);
        expect(db.prepare("SELECT active_turn_id AS turnId FROM bot_native_chats").get()).toEqual({ turnId: null });
        db.close();
      } finally {
        upgraded.close();
      }
    } finally {
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

// The four tables this migration touches, verbatim from v0.8.6 packages/gateway/src/storage.ts.
const V086_TABLES = `
CREATE TABLE IF NOT EXISTS bot_chat_tool_steps (
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
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bot_chat_delegations (
  bot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  child_index INTEGER NOT NULL,
  batch_count INTEGER NOT NULL,
  alias_id TEXT,
  label TEXT,
  status TEXT NOT NULL,
  current_tool TEXT,
  api_calls INTEGER,
  tool_count INTEGER,
  cost_usd REAL CHECK (cost_usd IS NULL OR (cost_usd >= 0 AND cost_usd <= 1000000)),
  cost_status TEXT CHECK (cost_status IN ('estimated', 'reported', 'unknown')),
  schema_valid INTEGER CHECK (schema_valid IN (0, 1)),
  schema_retries INTEGER CHECK (schema_retries BETWEEN 0 AND 1),
  duration_ms INTEGER CHECK (duration_ms BETWEEN 0 AND 2147483647),
  last_active_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (bot, turn_id, batch_id, child_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bot_native_chats (
  bot TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  active_turn_id TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS bot_native_sessions (
  bot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  active_turn_id TEXT,
  PRIMARY KEY (bot, session_id)
) STRICT, WITHOUT ROWID;
`;

// v0.8.6's statements over bot_native_chats.active_turn_id, verbatim, with sample parameters.
// The final write re-fills the copy, as a rolled-back gateway would on its next turn.
const V086_CHAT_TURN_STATEMENTS: ReadonlyArray<readonly [string, ...Array<string | number>]> = [
  ["SELECT session_id AS sessionId, active_turn_id AS activeTurnId, updated_at AS updatedAt FROM bot_native_chats WHERE bot = ?", "luna"],
  ["SELECT session_id AS sessionId, active_turn_id AS turnId FROM bot_native_chats WHERE bot = ?", "luna"],
  [`UPDATE bot_chat_tool_steps
    SET status = 'interrupted', ended_at = ?
    WHERE ended_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM bot_native_chats AS chat
      WHERE chat.bot = bot_chat_tool_steps.bot
        AND chat.session_id = bot_chat_tool_steps.session_id
        AND chat.active_turn_id = bot_chat_tool_steps.turn_id
    )`, 1],
  [`UPDATE bot_chat_delegations
    SET status = 'unknown', ended_at = ?
    WHERE status IN ('queued', 'starting', 'running', 'stalling') AND NOT EXISTS (
      SELECT 1 FROM bot_native_chats AS chat
      WHERE chat.bot = bot_chat_delegations.bot
        AND chat.session_id = bot_chat_delegations.session_id
        AND chat.active_turn_id = bot_chat_delegations.turn_id
    )`, 1],
  ["UPDATE bot_native_chats SET session_id = ?, active_turn_id = NULL, updated_at = ? WHERE bot = ?", "s-luna", 2, "luna"],
  [`INSERT INTO bot_native_chats (bot, session_id, active_turn_id, updated_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT(bot) DO UPDATE SET session_id = excluded.session_id, active_turn_id = NULL, updated_at = excluded.updated_at`, "luna", "s-luna", 3],
  ["UPDATE bot_native_chats SET active_turn_id = NULL, updated_at = ? WHERE bot = ? AND session_id = ? AND active_turn_id = ?", 4, "luna", "s-luna", "t-1"],
  ["UPDATE bot_native_chats SET active_turn_id = ?, updated_at = ? WHERE bot = ? AND session_id = ?", "t-2", 5, "luna", "s-luna"],
];

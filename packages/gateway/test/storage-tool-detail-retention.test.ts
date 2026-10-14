import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import {
  BOT_CHAT_TOOL_DETAIL_RETENTION_MS,
  BOT_CHAT_TOOL_SUMMARY_RETENTION_MS,
  openStorage,
} from "../src/storage.ts";

const NOW = 10 * BOT_CHAT_TOOL_DETAIL_RETENTION_MS;

describe("tool-detail compaction", () => {
  it("upgrades the original tool table before building the diagnostic index", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-tool-retention-upgrade-"));
    const path = join(directory, "gateway.db");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE bot_chat_tool_steps (
        bot TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, step_id TEXT NOT NULL,
        seq INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER, PRIMARY KEY (bot, turn_id, step_id)
      ) STRICT, WITHOUT ROWID`);
      legacy.close();
      const storage = openStorage(path);
      try {
        const { sessionId } = storage.nativeBotChat("sage", NOW);
        const old = NOW - BOT_CHAT_TOOL_DETAIL_RETENTION_MS - 1;
        step(storage, sessionId, "settled", "step", old, { detail: "legacy upgraded" });
        terminal(storage, sessionId, "settled", old);
        expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 1, deleted: 0 });
        expect(storage.botChatToolSteps(sessionId, 0)[0]).toMatchObject({ name: "search", detail: null });
      } finally {
        storage.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps deterministic summaries while clearing only old settled-turn diagnostics", () => {
    const storage = openStorage(":memory:");
    const { sessionId } = storage.nativeBotChat("sage", NOW);
    const old = NOW - BOT_CHAT_TOOL_DETAIL_RETENTION_MS - 1;
    const boundary = NOW - BOT_CHAT_TOOL_DETAIL_RETENTION_MS;
    const expired = NOW - BOT_CHAT_TOOL_SUMMARY_RETENTION_MS - 1;
    const deletionBoundary = NOW - BOT_CHAT_TOOL_SUMMARY_RETENTION_MS;
    try {
      step(storage, sessionId, "settled", "settled-step", old, { detail: "verbose detail", errorText: "verbose error" });
      terminal(storage, sessionId, "settled", old);

      // Exactly seven days is retained. The compaction predicate is strictly older than the cutoff.
      step(storage, sessionId, "boundary", "boundary-step", old, { detail: "keep at boundary" });
      terminal(storage, sessionId, "boundary", boundary);

      // A structurally impossible-but-defensive state proves a current active turn wins over an old
      // terminal receipt. A real active turn normally has no terminal receipt at all.
      step(storage, sessionId, "active", "active-step", old, { detail: "active detail" });
      terminal(storage, sessionId, "active", old);
      storage.setNativeBotTurn("sage", sessionId, "active", NOW);

      step(storage, sessionId, "unresolved", "unresolved-step", old, { detail: "unresolved detail" });
      storage.upsertBotChatToolStep({
        bot: "sage", sessionId, turnId: "running", stepId: "running-step", seq: 1,
        name: "search", status: "running", startedAt: old, endedAt: undefined, detail: "running detail",
      });

      step(storage, sessionId, "expired", "expired-step", expired, { detail: "expired detail" });
      terminal(storage, sessionId, "expired", expired);
      // A row compacted on an earlier pass has no diagnostics left, but must still age out at 14 days.
      step(storage, sessionId, "expired-summary", "expired-summary-step", expired, {});
      terminal(storage, sessionId, "expired-summary", expired);
      // At the 14-day boundary it becomes a summary, rather than being deleted one millisecond early.
      step(storage, sessionId, "deletion-boundary", "deletion-boundary-step", old, { detail: "keep summary" });
      terminal(storage, sessionId, "deletion-boundary", deletionBoundary);

      expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 2, deleted: 2 });
      const byTurn = new Map(storage.botChatToolSteps(sessionId, 0).map((row) => [row.turnId, row]));
      expect(byTurn.get("settled")).toMatchObject({
        stepId: "settled-step", seq: 7, name: "search", status: "error", startedAt: old,
        endedAt: old, detail: null, errorText: null,
      });
      expect(byTurn.get("boundary")).toMatchObject({ detail: "keep at boundary", errorText: null });
      expect(byTurn.get("active")).toMatchObject({ detail: "active detail" });
      expect(byTurn.get("unresolved")).toMatchObject({ detail: "unresolved detail" });
      expect(byTurn.get("running")).toMatchObject({ detail: "running detail", endedAt: null });
      expect(byTurn.get("deletion-boundary")).toMatchObject({ detail: null, errorText: null });
      expect(byTurn.has("expired")).toBe(false);
      expect(byTurn.has("expired-summary")).toBe(false);
      expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 0, deleted: 0 });
    } finally {
      storage.close();
    }
  });

  it("limits each invocation to 256 detailed rows and is idempotent after the backlog", () => {
    const storage = openStorage(":memory:");
    const { sessionId } = storage.nativeBotChat("sage", NOW);
    const old = NOW - BOT_CHAT_TOOL_DETAIL_RETENTION_MS - 1;
    try {
      for (let index = 0; index < 257; index += 1)
        step(storage, sessionId, "many", `step-${index}`, old, { detail: `detail-${index}` });
      terminal(storage, sessionId, "many", old);

      expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 256, deleted: 0 });
      expect(storage.botChatToolSteps(sessionId, 0).filter((row) => row.detail !== null)).toHaveLength(1);
      expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 1, deleted: 0 });
      expect(storage.botChatToolSteps(sessionId, 0).every((row) => row.detail === null && row.errorText === null)).toBe(true);
      expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 0, deleted: 0 });
    } finally {
      storage.close();
    }
  });
});

describe("tool-summary deletion", () => {
  it("ages late tool results from their own end time and preserves stale running rows", () => {
    const storage = openStorage(":memory:");
    const { sessionId } = storage.nativeBotChat("sage", NOW);
    const day = 86_400_000;
    try {
      step(storage, sessionId, "late", "late-step", NOW - 8 * day, { detail: "late detail" });
      terminal(storage, sessionId, "late", NOW - 20 * day);
      storage.upsertBotChatToolStep({
        bot: "sage", sessionId, turnId: "stale-running", stepId: "running-step", seq: 1,
        name: "search", status: "running", startedAt: NOW - 20 * day,
        endedAt: NOW - 20 * day, detail: "keep until settled",
      });
      terminal(storage, sessionId, "stale-running", NOW - 20 * day);
      expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 1, deleted: 0 });
      expect(storage.botChatToolSteps(sessionId, 0)).toEqual(expect.arrayContaining([
        expect.objectContaining({ turnId: "late", detail: null }),
        expect.objectContaining({ turnId: "stale-running", detail: "keep until settled" }),
      ]));
      expect(storage.compactBotChatToolDetails(NOW + 7 * day)).toEqual({ compacted: 0, deleted: 1 });
      expect(storage.botChatToolSteps(sessionId, 0)).toHaveLength(1);
    } finally {
      storage.close();
    }
  });

  it("prioritizes 14-day hard deletion within the same 256-row batch", () => {
    const storage = openStorage(":memory:");
    const { sessionId } = storage.nativeBotChat("sage", NOW);
    const expired = NOW - BOT_CHAT_TOOL_SUMMARY_RETENTION_MS - 1;
    const summary = NOW - BOT_CHAT_TOOL_DETAIL_RETENTION_MS - 1;
    try {
      for (let index = 0; index < 256; index += 1)
        step(storage, sessionId, "expired", `expired-${index}`, expired, { detail: `detail-${index}` });
      terminal(storage, sessionId, "expired", expired);
      step(storage, sessionId, "summary", "summary-step", summary, { detail: "summary detail" });
      terminal(storage, sessionId, "summary", summary);

      expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 0, deleted: 256 });
      expect(storage.botChatToolSteps(sessionId, 0)).toEqual([
        expect.objectContaining({ turnId: "summary", detail: "summary detail" }),
      ]);
      expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 1, deleted: 0 });
    } finally {
      storage.close();
    }
  });
});

describe("tool retention bounded scan", () => {
  it("moves past a retained-scale orphan prefix without revisiting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-tool-retention-audit-"));
    const path = join(directory, "gateway.sqlite");
    const orphanRows = 127_757;
    let storage: ReturnType<typeof openStorage> | undefined = openStorage(path);
    storage.close();
    storage = undefined;
    try {
      const db = new DatabaseSync(path);
      const old = NOW - BOT_CHAT_TOOL_DETAIL_RETENTION_MS - 1;
      const insert = db.prepare(`INSERT INTO bot_chat_tool_steps
        (bot, session_id, turn_id, step_id, seq, name, status, started_at, ended_at, detail, error_text)
        VALUES ('sage', 'session', ?, 'step', 1, 'search', 'ok', ?, ?, 'verbose', NULL)`);
      db.exec("BEGIN");
      try {
        // 256 old orphaned rows precede the settled row. The remaining retained-scale tail makes
        // this the same kind of never-terminal history that formerly kept every sweep at its head.
        for (let index = 0; index < orphanRows; index += 1) {
          const turn = index < 256 ? `a-orphan-${String(index).padStart(6, "0")}` : `z-orphan-${String(index).padStart(6, "0")}`;
          insert.run(turn, old, old);
        }
        insert.run("b-settled", old, old);
        db.prepare(`INSERT INTO bot_native_turn_terminals
          (bot, session_id, turn_id, status, cause, completed_at)
          VALUES ('sage', 'session', 'b-settled', 'completed', NULL, ?)`).run(old);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const plan = (db.prepare(`EXPLAIN QUERY PLAN
        SELECT ended_at, bot, turn_id, step_id FROM bot_chat_tool_steps
        INDEXED BY bot_chat_tool_steps_detail_compaction
        WHERE ended_at < ? AND (detail IS NOT NULL OR error_text IS NOT NULL)
        ORDER BY ended_at, bot, turn_id, step_id LIMIT 256`).all(NOW) as Array<{ detail: string }>)
        .map((row) => row.detail).join("\n");
      expect(plan).toContain("USING INDEX bot_chat_tool_steps_detail_compaction");
      const resumePlan = (db.prepare(`EXPLAIN QUERY PLAN
        SELECT ended_at, bot, turn_id, step_id FROM bot_chat_tool_steps
        INDEXED BY bot_chat_tool_steps_detail_compaction
        WHERE ended_at < ? AND (detail IS NOT NULL OR error_text IS NOT NULL)
          AND (ended_at, bot, turn_id, step_id) > (?, ?, ?, ?)
        ORDER BY ended_at, bot, turn_id, step_id LIMIT 256`).all(
        NOW, old, "sage", "a-orphan-000255", "step",
      ) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
      expect(resumePlan).toContain("USING INDEX bot_chat_tool_steps_detail_compaction");
      db.close();

      storage = openStorage(path);
      const started = performance.now();
      expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 0, deleted: 0 });
      const orphanPrefixMs = performance.now() - started;
      const resumedStarted = performance.now();
      expect(storage.compactBotChatToolDetails(NOW)).toEqual({ compacted: 1, deleted: 0 });
      const resumedMs = performance.now() - resumedStarted;
      expect(storage.botChatToolSteps("session", 0).find((row) => row.turnId === "b-settled"))
        .toMatchObject({ detail: null, errorText: null });
      console.info(`gateway-tool-retention-audit ${JSON.stringify({ orphanRows, orphanPrefixMs, resumedMs })}`);
    } finally {
      storage?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

function step(
  storage: ReturnType<typeof openStorage>,
  sessionId: string,
  turnId: string,
  stepId: string,
  at: number,
  detail: { detail?: string; errorText?: string },
): void {
  storage.upsertBotChatToolStep({
    bot: "sage", sessionId, turnId, stepId, seq: 7, name: "search", status: "error",
    startedAt: at, endedAt: at, ...detail,
  });
}

function terminal(storage: ReturnType<typeof openStorage>, sessionId: string, turnId: string, completedAt: number): void {
  storage.recordNativeBotTerminal({
    bot: "sage", sessionId, turnId, status: "completed", completedAt,
  });
}

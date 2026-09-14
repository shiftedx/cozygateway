import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage } from "../src/storage.ts";

/**
 * A bounded, reproducible baseline for the attach -> SQLite -> native projection path.
 * It intentionally has no performance pass/fail threshold: the numbers depend on the host and
 * SQLite filesystem, while the row/frame assertions keep it on the real production path.
 *
 * Run with:
 * cd packages/gateway && PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec vitest run test/gateway-storage-audit.test.ts
 */
describe("gateway storage audit", () => {
  it("measures 40 tool calls with transcript and command-history variation", async () => {
    const results: AuditRow[] = [];
    for (const historyTools of [0, 400, 2_000]) {
      results.push(await runToolBurst({ historyTools, trailingCommands: 0 }));
    }
    for (const trailingCommands of [0, 512]) {
      results.push(await runToolBurst({ historyTools: 400, trailingCommands }));
    }

    // The stdout line is deliberately machine-readable so repeats can be diffed or retained in an
    // incident report without changing this test into a machine-specific performance gate.
    console.info(`gateway-storage-audit ${JSON.stringify(results)}`);

    expect(results).toHaveLength(5);
    expect(results.every((row) => row.toolSteps === 40 && row.appliedEvents === 80)).toBe(true);
    expect(results.every((row) => row.burstMs >= 0 && row.eventLoopDelayMs >= 0 && row.historyMs >= 0)).toBe(true);
  }, 15_000);

  it("measures the unapplied-event query at Cleo's retained-inbox scale", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-inbox-audit-"));
    const path = join(directory, "gateway.sqlite");
    const historyRows = 127_757;
    let storage: ReturnType<typeof openStorage> | undefined = openStorage(path);
    storage.close();
    storage = undefined;
    try {
      const db = new DatabaseSync(path);
      db.exec("DROP INDEX attach_event_inbox_unapplied; DROP INDEX attach_event_inbox_dead_letter_barrier;");
      const historyFrame = JSON.stringify({
        kind: "event", sequence: 0, eventId: "history", event: {
          kind: "tool", threadId: "session", turnId: "turn", callId: "call", name: "tool", status: "ok",
        },
      });
      const currentFrame = JSON.stringify({
        kind: "event", sequence: historyRows + 1, eventId: "current", event: {
          kind: "tool", threadId: "session", turnId: "turn", callId: "current", name: "tool", status: "running",
        },
      });
      const insert = db.prepare(
        `INSERT INTO attach_event_inbox
           (agent_id, sequence, event_id, frame_json, received_at, disposition, applied_at)
         VALUES (?, ?, ?, ?, ?, 'accepted', ?)`,
      );
      db.exec("BEGIN");
      try {
        for (let sequence = 1; sequence <= historyRows; sequence += 1) {
          insert.run("cleo", sequence, `history-${sequence}`, historyFrame, sequence, sequence);
        }
        insert.run("cleo", historyRows + 1, "current", currentFrame, historyRows + 1, null);
        // Keep a real blocker after the pending event. This leaves `current` eligible while making
        // the correlated barrier lookup choose and exercise its own partial index.
        db.prepare(
          `INSERT INTO attach_event_inbox
             (agent_id, sequence, event_id, frame_json, received_at, disposition, dead_lettered_at)
           VALUES (?, ?, ?, ?, ?, 'accepted', ?)`,
        ).run("cleo", historyRows + 2, "later-dead-letter", historyFrame, historyRows + 2, historyRows + 2);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const unindexedSql = `SELECT frame_json AS frameJson FROM attach_event_inbox
        WHERE agent_id = ? AND disposition = 'accepted' AND applied_at IS NULL
          AND dead_lettered_at IS NULL
          AND sequence < COALESCE(
            (SELECT MIN(blocked.sequence) FROM attach_event_inbox AS blocked
             WHERE blocked.agent_id = ? AND blocked.disposition = 'accepted'
               AND blocked.dead_lettered_at IS NOT NULL),
            9223372036854775807
          )
        ORDER BY sequence LIMIT ?`;
      const baselineMs = medianMs(() => db.prepare(unindexedSql).all("cleo", "cleo", 256));
      const peerHealthUnindexedSql = `SELECT COUNT(*) AS deadLetters FROM attach_event_inbox
        WHERE agent_id = ? AND disposition = 'accepted' AND dead_lettered_at IS NOT NULL`;
      const releaseUnindexedSql = `SELECT event_id AS eventId FROM attach_event_inbox
        WHERE agent_id = ? AND disposition = 'accepted' AND dead_lettered_at IS NOT NULL
        ORDER BY sequence LIMIT 1`;
      const peerHealthBaselineMs = medianMs(() => db.prepare(peerHealthUnindexedSql).get("cleo"));
      const releaseBaselineMs = medianMs(() => db.prepare(releaseUnindexedSql).get("cleo"));

      db.exec(`CREATE INDEX attach_event_inbox_unapplied
        ON attach_event_inbox (agent_id, sequence)
        WHERE disposition = 'accepted' AND applied_at IS NULL AND dead_lettered_at IS NULL;
        CREATE INDEX attach_event_inbox_dead_letter_barrier
        ON attach_event_inbox (agent_id, sequence)
        WHERE disposition = 'accepted' AND dead_lettered_at IS NOT NULL;`);
      const indexedSql = `SELECT frame_json AS frameJson FROM attach_event_inbox
        INDEXED BY attach_event_inbox_unapplied
        WHERE agent_id = ? AND disposition = 'accepted' AND applied_at IS NULL
          AND dead_lettered_at IS NULL
          AND sequence < COALESCE(
            (SELECT MIN(blocked.sequence) FROM attach_event_inbox AS blocked
             INDEXED BY attach_event_inbox_dead_letter_barrier
             WHERE blocked.agent_id = ? AND blocked.disposition = 'accepted'
               AND blocked.dead_lettered_at IS NOT NULL),
            9223372036854775807
          )
        ORDER BY sequence LIMIT ?`;
      const indexedMs = medianMs(() => db.prepare(indexedSql).all("cleo", "cleo", 256));
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${indexedSql}`).all("cleo", "cleo", 256) as Array<{ detail: string }>;
      const planText = plan.map((row) => row.detail).join("\n");
      expect(planText).toContain("USING INDEX attach_event_inbox_unapplied");
      expect(planText).toContain("USING INDEX attach_event_inbox_dead_letter_barrier");
      const peerHealthIndexedSql = `SELECT COUNT(*) AS deadLetters FROM attach_event_inbox
        INDEXED BY attach_event_inbox_dead_letter_barrier
        WHERE agent_id = ? AND disposition = 'accepted' AND dead_lettered_at IS NOT NULL`;
      const releaseIndexedSql = `SELECT event_id AS eventId FROM attach_event_inbox
        INDEXED BY attach_event_inbox_dead_letter_barrier
        WHERE agent_id = ? AND disposition = 'accepted' AND dead_lettered_at IS NOT NULL
        ORDER BY sequence LIMIT 1`;
      const peerHealthIndexedMs = medianMs(() => db.prepare(peerHealthIndexedSql).get("cleo"));
      const releaseIndexedMs = medianMs(() => db.prepare(releaseIndexedSql).get("cleo"));
      for (const sql of [peerHealthIndexedSql, releaseIndexedSql]) {
        const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("cleo") as Array<{ detail: string }>)
          .map((row) => row.detail).join("\n");
        expect(detail).toContain("USING INDEX attach_event_inbox_dead_letter_barrier");
      }
      // This is the same predicate embedded in global attachHealth. It needs no forced hint:
      // without an agent filter, SQLite correctly scans the much smaller partial index.
      const globalDeadLetterPlan = db.prepare(`EXPLAIN QUERY PLAN
        SELECT COUNT(*) FROM attach_event_inbox
        WHERE disposition = 'accepted' AND dead_lettered_at IS NOT NULL`).all() as Array<{ detail: string }>;
      expect(globalDeadLetterPlan.map((row) => row.detail).join("\n"))
        .toContain("USING INDEX attach_event_inbox_dead_letter_barrier");
      const deadLetterReaderPlan = db.prepare(`EXPLAIN QUERY PLAN
        SELECT agent_id, sequence, event_id, json_extract(frame_json, '$.event.kind') AS kind,
               projection_attempts, projection_error, dead_lettered_at, received_at
        FROM attach_event_inbox
        WHERE disposition = 'accepted' AND dead_lettered_at IS NOT NULL AND applied_at IS NULL
        ORDER BY agent_id, sequence`).all() as Array<{ detail: string }>;
      expect(deadLetterReaderPlan.map((row) => row.detail).join("\n"))
        .toContain("USING INDEX attach_event_inbox_dead_letter_barrier");
      db.close();

      const reopenedStorage = openStorage(path);
      storage = reopenedStorage;
      const storageMs = medianMs(() => reopenedStorage.unappliedAttachEvents("cleo"));
      expect(reopenedStorage.unappliedAttachEvents("cleo").map((frame) => frame.eventId)).toEqual(["current"]);
      console.info(`gateway-storage-inbox-audit ${JSON.stringify({
        historyRows, baselineMs, indexedMs, storageMs,
        peerHealthBaselineMs, peerHealthIndexedMs, releaseBaselineMs, releaseIndexedMs,
      })}`);
      expect(indexedMs).toBeLessThan(baselineMs);
      expect(peerHealthIndexedMs).toBeLessThan(peerHealthBaselineMs);
      expect(releaseIndexedMs).toBeLessThan(releaseBaselineMs);
    } finally {
      storage?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("measures health timestamp endpoints at retained inbox and terminal scale", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-health-audit-"));
    const path = join(directory, "gateway.sqlite");
    const historyRows = 127_757;
    const terminalRows = 24_000;
    let storage: ReturnType<typeof openStorage> | undefined = openStorage(path);
    storage.close();
    storage = undefined;
    try {
      const db = new DatabaseSync(path);
      db.exec(`DROP INDEX IF EXISTS attach_event_inbox_received_at_desc;
        DROP INDEX IF EXISTS attach_turn_terminals_received_at_desc;
        DROP INDEX IF EXISTS bot_native_turn_terminals_completed_at_desc;`);
      const event = db.prepare(`INSERT INTO attach_event_inbox
        (agent_id, sequence, event_id, frame_json, received_at, disposition, applied_at)
        VALUES ('cleo', ?, ?, '{}', ?, 'accepted', ?)`);
      const terminal = db.prepare(`INSERT INTO attach_turn_terminals
        (agent_id, turn_id, event_id, terminal_kind, message_id, sequence, received_at)
        VALUES ('cleo', ?, ?, 'commit', ?, ?, ?)`);
      const nativeTerminal = db.prepare(`INSERT INTO bot_native_turn_terminals
        (bot, session_id, turn_id, status, cause, completed_at)
        VALUES ('native', 'session', ?, 'completed', NULL, ?)`);
      db.exec("BEGIN");
      try {
        for (let sequence = 1; sequence <= historyRows; sequence += 1)
          event.run(sequence, `event-${sequence}`, sequence, sequence);
        for (let sequence = 1; sequence <= terminalRows; sequence += 1) {
          const at = sequence * 5;
          terminal.run(`turn-${sequence}`, `event-${at}`, `message-${sequence}`, at, at);
          nativeTerminal.run(`native-turn-${sequence}`, at - 1);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const oldEventMs = medianMs(() => db.prepare(
        "SELECT MAX(received_at) FROM attach_event_inbox",
      ).get());
      const oldTerminalMs = medianMs(() => db.prepare(`SELECT MAX(at) FROM (
        SELECT inbox.received_at AS at FROM attach_turn_terminals AS terminal
        JOIN attach_event_inbox AS inbox
          ON inbox.agent_id = terminal.agent_id AND inbox.event_id = terminal.event_id
        UNION ALL SELECT completed_at AS at FROM bot_native_turn_terminals
      )`).get());

      db.exec(`CREATE INDEX attach_event_inbox_received_at_desc
          ON attach_event_inbox (received_at DESC);
        CREATE INDEX attach_turn_terminals_received_at_desc
          ON attach_turn_terminals (received_at DESC);
        CREATE INDEX bot_native_turn_terminals_completed_at_desc
          ON bot_native_turn_terminals (completed_at DESC);`);
      const eventEndpoint = `SELECT received_at FROM attach_event_inbox
        INDEXED BY attach_event_inbox_received_at_desc
        ORDER BY received_at DESC LIMIT 1`;
      const terminalEndpoint = `SELECT MAX(at) FROM (
        SELECT received_at AS at FROM (
          SELECT received_at FROM attach_turn_terminals
          INDEXED BY attach_turn_terminals_received_at_desc
          WHERE received_at IS NOT NULL ORDER BY received_at DESC LIMIT 1
        ) UNION ALL SELECT completed_at AS at FROM (
          SELECT completed_at FROM bot_native_turn_terminals
          INDEXED BY bot_native_turn_terminals_completed_at_desc
          ORDER BY completed_at DESC LIMIT 1
        )
      )`;
      const endpointEventMs = medianMs(() => db.prepare(eventEndpoint).get());
      const endpointTerminalMs = medianMs(() => db.prepare(terminalEndpoint).get());
      for (const sql of [eventEndpoint, terminalEndpoint]) {
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
          .map((row) => row.detail).join("\n");
        expect(plan).toMatch(/USING (COVERING )?INDEX .*received_at_desc|USING (COVERING )?INDEX .*completed_at_desc/);
      }
      db.close();

      storage = openStorage(path);
      expect(storage.attachHealth().lastEventAt).toBe(historyRows);
      expect(storage.attachHealth().lastTerminalAt).toBe(terminalRows * 5);
      const storageHealthMs = medianMs(() => storage!.attachHealth());
      console.info(`gateway-storage-health-audit ${JSON.stringify({
        historyRows, terminalRows, oldEventMs, endpointEventMs, oldTerminalMs, endpointTerminalMs, storageHealthMs,
      })}`);
      expect(endpointEventMs).toBeLessThan(oldEventMs);
      expect(endpointTerminalMs).toBeLessThan(oldTerminalMs);
    } finally {
      storage?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("upgrades legacy terminal receipts before creating their health index", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-health-upgrade-"));
    const path = join(directory, "gateway.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE attach_event_inbox (
        agent_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL,
        frame_json TEXT NOT NULL, received_at INTEGER NOT NULL, disposition TEXT NOT NULL,
        applied_at INTEGER, projection_attempts INTEGER NOT NULL DEFAULT 0, projection_error TEXT,
        dead_lettered_at INTEGER, PRIMARY KEY (agent_id, sequence), UNIQUE (agent_id, event_id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE attach_turn_terminals (
        agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, event_id TEXT NOT NULL,
        terminal_kind TEXT NOT NULL, message_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        PRIMARY KEY (agent_id, turn_id)
      ) STRICT, WITHOUT ROWID;`);
      legacy.prepare(`INSERT INTO attach_event_inbox
        (agent_id, sequence, event_id, frame_json, received_at, disposition)
        VALUES ('cleo', 1, 'terminal-event', '{}', 42, 'accepted')`).run();
      legacy.prepare(`INSERT INTO attach_turn_terminals
        (agent_id, turn_id, event_id, terminal_kind, message_id, sequence)
        VALUES ('cleo', 'turn', 'terminal-event', 'commit', 'message', 1)`).run();
      legacy.close();

      const storage = openStorage(path);
      try {
        expect(storage.attachHealth().lastTerminalAt).toBe(42);
        const upgraded = new DatabaseSync(path);
        try {
          expect(upgraded.prepare("SELECT received_at FROM attach_turn_terminals").get())
            .toEqual({ received_at: 42 });
        } finally {
          upgraded.close();
        }
      } finally {
        storage.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

interface AuditRow {
  historyTools: number;
  trailingCommands: number;
  burstMs: number;
  eventLoopDelayMs: number;
  historyMs: number;
  toolSteps: number;
  appliedEvents: number;
  activityFrames: number;
  emittedStepObjects: number;
}

async function runToolBurst(input: { historyTools: number; trailingCommands: number }): Promise<AuditRow> {
  const directory = mkdtempSync(join(tmpdir(), "gateway-storage-audit-"));
  const storage = openStorage(join(directory, "gateway.sqlite"));
  const frames: ServerFrame[] = [];
  let now = 1_000_000;
  let sent: Record<string, unknown> | undefined;
  const ingress = {
    sendNativeTurn: (peer: string, turn: Record<string, unknown>) => {
      sent = turn;
      storage.enqueueAttachCommand(peer, `turn:${String(turn.turnId)}`, { kind: "turn", ...turn } as never, now);
      return true;
    },
  } as unknown as AttachV1Ingress;
  const plane = new NativeBotDataPlane({
    control: {} as BotsSurface,
    storage,
    ingress,
    nativeBots: ["sage"],
    chatSuggestion: "",
    broadcast: (frame) => frames.push(frame),
    now: () => now++,
    staleTurnSweepMs: 0,
  });

  try {
    const accepted = await plane.surface().sendChatMessage("sage", "audit tools", { clientId: "audit-user" });
    const sessionId = accepted.sessionId;
    const turnId = String(sent?.turnId);
    expect(turnId).not.toBe("");

    // These rows use the same storage API as prior completed turns. They vary the native history
    // reader without making the active 40-tool run artificial.
    for (let index = 0; index < input.historyTools; index += 1) {
      storage.upsertBotChatToolStep({
        bot: "sage", sessionId, turnId: `history-turn-${Math.floor(index / 40)}`,
        stepId: `history-step-${index}`, seq: (index % 40) + 1, name: "history-tool",
        status: "ok", startedAt: index + 1, endedAt: index + 2,
      });
    }
    // `attachTurnCommand` is intentionally exercised through `plane.handle`, not directly. These
    // commands are newer than the active turn, so this models a replay/late event lookup after a
    // command journal has accumulated history.
    for (let index = 0; index < input.trailingCommands; index += 1) {
      storage.enqueueAttachCommand("sage", `audit-filler-${index}`, {
        kind: "steer", threadId: sessionId, turnId: `filler-turn-${index}`,
        messageId: `filler-message-${index}`, text: "filler",
      }, now);
    }

    let sequence = 1;
    const apply = (call: number, status: "running" | "ok") => {
      const frame: AttachV1EventFrame = {
        kind: "event",
        sequence,
        eventId: `audit-${sequence}`,
        event: {
          kind: "tool", threadId: sessionId, turnId, callId: `call-${call}`,
          name: `tool-${call}`, status, role: "investigation",
        },
      };
      sequence += 1;
      expect(storage.acceptAttachEvent("sage", frame, now++).status).toBe("accepted");
      expect(plane.handle("sage", frame)).toBe(true);
      storage.markAttachEventApplied("sage", frame.eventId, now++);
    };

    // A setImmediate queued before the synchronous burst reports how long one gateway event-loop
    // turn is unavailable to sockets/timers while all admission and projection work runs.
    const lagStarted = performance.now();
    const eventLoopDelay = new Promise<number>((resolve) => setImmediate(() => resolve(performance.now() - lagStarted)));
    const burstStarted = performance.now();
    for (let call = 1; call <= 40; call += 1) {
      apply(call, "running");
      apply(call, "ok");
    }
    const burstMs = performance.now() - burstStarted;
    const eventLoopDelayMs = await eventLoopDelay;

    // Allow the real 100 ms native live-frame coalescer to flush, then read the same history route
    // a reconnecting client uses. The tool list must retain all 40 current-run steps.
    await delay(125);
    const historyStarted = performance.now();
    const history = await plane.surface().chatHistory("sage");
    const historyMs = performance.now() - historyStarted;
    const toolSteps = history.toolSteps?.find((turn) => turn.turnId === turnId)?.steps.length ?? 0;
    const inboxEvents = storage.unappliedAttachEvents("sage", 100).length;
    // All events were projected above. The public storage reader only exposes unapplied rows, so
    // this supplies a useful correctness check but is not a row-count metric.
    expect(inboxEvents).toBe(0);
    expect(toolSteps).toBe(40);

    const activityFrames = frames.filter((frame) => frame.type === "bot_tool_activity");
    const emittedStepObjects = activityFrames.reduce((total, frame) => total + frame.steps.length, 0);
    return {
      historyTools: input.historyTools,
      trailingCommands: input.trailingCommands,
      burstMs: round(burstMs),
      eventLoopDelayMs: round(eventLoopDelayMs),
      historyMs: round(historyMs),
      toolSteps,
      appliedEvents: sequence - 1,
      activityFrames: activityFrames.length,
      emittedStepObjects,
    };
  } finally {
    plane.close();
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function medianMs(run: () => unknown): number {
  const samples = Array.from({ length: 3 }, () => {
    const started = performance.now();
    run();
    return performance.now() - started;
  }).sort((left, right) => left - right);
  return round(samples[1]!);
}

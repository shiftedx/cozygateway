import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openStorage, type Storage } from "../src/storage.ts";
import { endpointStorage } from "../src/hermes-bridge/federation.ts";

const BOT = "disposable-delete";
const KEEP = "disposable-keep";
const directories: string[] = [];
const stores: Storage[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const storage of stores.splice(0)) storage.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gateway-delete-")); directories.push(directory);
  const path = join(directory, "db.sqlite");
  const storage = openStorage(path); stores.push(storage);
  const db = new DatabaseSync(path); databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  return { storage, db, path };
}
function count(db: DatabaseSync, table: string, where: string, id: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where} = ?`).get(id) as { n: number }).n;
}
const taskChildren = ["task_runs", "task_intent_revisions", "task_events", "task_completion_notifications",
  "task_reply_pushes", "task_waits", "task_absences", "task_recovery_decisions", "task_required_artifacts",
  "task_required_batches", "task_commands", "task_dispatches"];
function seedTask(db: DatabaseSync, id: string, bot: string, room: string | null) {
  db.prepare("INSERT INTO tasks VALUES (?, ?, 'session', ?, 'turn', 'message', 'private words')").run(id, bot, room);
  // Seed every schema-owned child, including those without a foreign key. A new required column
  // or child must be added to this fixture rather than silently slipping past the cleanup test.
  db.prepare("INSERT INTO task_runs VALUES (?, ?, ?, 'session', 1, NULL)").run(id, bot, id);
  db.prepare("INSERT INTO task_intent_revisions VALUES (?, 1, 'goal', 1)").run(id);
  db.prepare("INSERT INTO task_events VALUES (?, 1, 'source', '{}')").run(id);
  db.prepare("INSERT INTO task_completion_notifications VALUES (?, 1)").run(id);
  db.prepare("INSERT INTO task_reply_pushes VALUES (?, ?, 'device', 'scheduled', 1)").run(id, id);
  db.prepare("INSERT INTO task_waits VALUES (?, ?, 'device', 'request', 1, 2, NULL)").run(id, id);
  db.prepare("INSERT INTO task_absences VALUES (?, ?, ?, 'episode', 1, NULL)").run(id, id, bot);
  db.prepare("INSERT INTO task_recovery_decisions VALUES (?, 'issuer', 'decision', '{}')").run(id);
  db.prepare("INSERT INTO task_required_artifacts VALUES (?, ?, 'artifact')").run(id, id);
  db.prepare("INSERT INTO task_required_batches VALUES (?, ?, 'batch')").run(id, id);
  db.prepare("INSERT INTO task_commands VALUES (?, 'command', '{}', '{}')").run(id);
  db.prepare("INSERT INTO task_dispatches VALUES (?, ?, ?, '{}', NULL, 0)").run(id, id, bot);
  db.prepare("INSERT INTO task_tool_facts VALUES (?, ?, 'call', 'role')").run(bot, id);
}

describe("bot deletion owns its complete SQLite graph", () => {
  it("purges private Task children and migration/resume/catalog residue while preserving another bot and shared room Tasks", () => {
    const { storage, db } = fixture();
    db.exec("CREATE TABLE bot_native_history_migrations (bot TEXT PRIMARY KEY, migrated_at INTEGER NOT NULL) STRICT");
    for (const bot of [BOT, KEEP]) {
      storage.nativeBotChat(bot, 1);
      storage.stageNativeDesktopResume(bot, `desktop-${bot}`, 2);
      db.prepare("INSERT INTO bot_native_history_migrations VALUES (?, 1)").run(bot);
      db.prepare("INSERT INTO task_slash_catalogs VALUES (?, '[]')").run(bot);
      seedTask(db, bot, bot, null);
    }
    seedTask(db, "shared-task", BOT, "shared-room");
    const purged = storage.purgeBot(BOT);
    expect(purged).toMatchObject({ desktopResumeBindings: 1, nativeHistoryMigrations: 1, slashCatalogs: 1, tasks: 1 });
    for (const table of ["tasks", ...taskChildren]) {
      expect(count(db, table, "task_id", BOT), table).toBe(0);
      expect(count(db, table, "task_id", KEEP), table).toBe(1);
      expect(count(db, table, "task_id", "shared-task"), table).toBe(1);
    }
    expect(count(db, "task_tool_facts", "run_id", BOT)).toBe(0);
    expect(count(db, "task_tool_facts", "run_id", "shared-task")).toBe(1);
    for (const table of ["bot_desktop_resume_bindings", "bot_native_history_migrations", "bot_native_sessions"]) {
      expect(count(db, table, "bot", BOT), table).toBe(0);
      expect(count(db, table, "bot", KEEP), table).toBeGreaterThan(0);
    }
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(storage.purgeBot(BOT)).toEqual({});
  });

  it("keeps room Artifacts and their source bytes while removing private artifacts and deliveries", () => {
    const { storage, db } = fixture();
    const bytes = new TextEncoder().encode("fixture"), sha256 = createHash("sha256").update(bytes).digest("hex");
    for (const [id, room, bot] of [["private", undefined, BOT], ["shared", "room", BOT], ["keeper", undefined, KEEP]] as const) {
      storage.saveAttachMedia(bot, { mediaId: id, mimeType: "text/plain", byteCount: bytes.length, sha256, filename: "fixture.txt", family: "file" }, bytes, 1);
      storage.artifacts.declare({ artifactId: id, bot, sessionId: id, createdBy: bot, filename: "fixture.txt", mediaType: "text/plain", sizeBytes: bytes.length, sha256, ...(room ? { room } : {}) }, 1);
      expect(storage.artifacts.commit(bot, id, id, 2).outcome).toBe("committed");
    }
    expect(storage.purgeBot(BOT)).toMatchObject({ artifacts: 1, artifactDeliveries: 1, attachMedia: 1 });
    expect(count(db, "artifacts", "artifact_id", "private")).toBe(0);
    for (const id of ["shared", "keeper"]) {
      expect(count(db, "artifacts", "artifact_id", id)).toBe(1);
      expect(count(db, "artifact_deliveries", "artifact_id", id)).toBe(1);
      expect(count(db, "attach_media", "media_id", id)).toBe(1);
    }
    expect(storage.purgeBot(BOT)).toEqual({});
  });

  it("terminalizes retained room Tasks and settles their pending work before the private sweep", () => {
    const { storage, db } = fixture();
    storage.tasks.clock(() => 10);
    const sessionId = storage.nativeBotChat(BOT, 1).sessionId;
    storage.enqueueAttachCommand(BOT, "command", { kind: "turn", threadId: sessionId, turnId: "room-run", messageId: "user", text: "shared work" }, 2);
    const taskId = storage.tasks.list({ bot: BOT })[0]!.taskId;
    db.prepare("UPDATE tasks SET room = 'shared-room' WHERE task_id = ?").run(taskId);
    db.prepare("INSERT INTO task_dispatches VALUES ('pending', ?, ?, '{}', NULL, 0)").run(taskId, BOT);
    db.prepare("INSERT INTO task_waits VALUES (?, 'room-run', 'device', 'request', 1, 100, NULL)").run(taskId);
    storage.tasks.ownerDeleted(BOT, 10);
    storage.purgeBot(BOT);
    expect(storage.tasks.read(taskId)?.view).toMatchObject({ state: "cancelled", lastEvent: { reason: "owner_deleted" } });
    expect(db.prepare("SELECT dispatched FROM task_dispatches WHERE id = 'pending'").get()).toMatchObject({ dispatched: 2 });
    expect(db.prepare("SELECT settled_at FROM task_waits WHERE task_id = ?").get(taskId)).toMatchObject({ settled_at: 10 });
  });

  it("commits the deletion fence and runner cleanup atomically, rolling back a failed outbox write", () => {
    const { storage, db, path } = fixture();
    storage.nativeBotChat(BOT, 1);
    storage.insertRuntimeBot({ id: BOT, name: BOT, avatar: null, runtime: "cozyagents", token: "private", specGeneration: 1, createdAt: 1 });
    const operation = { operationId: "delete-1", bot: BOT, kind: "delete_runtime" as const, specGeneration: 1, payload: {}, at: 2 };
    db.exec("CREATE TRIGGER fail_delete BEFORE INSERT ON runner_operations BEGIN SELECT RAISE(ABORT, 'disk failure fixture'); END");
    expect(() => storage.purgeBot(BOT, operation)).toThrow("disk failure fixture");
    expect(storage.isBotDeleted(BOT)).toBe(false);
    expect(storage.runtimeBot(BOT)).toBeDefined();
    expect(count(db, "bot_native_sessions", "bot", BOT)).toBe(1);
    db.exec("DROP TRIGGER fail_delete");
    storage.purgeBot(BOT, operation);
    const reopened = openStorage(path); stores.push(reopened);
    expect(reopened.isBotDeleted(BOT)).toBe(true);
    expect(reopened.runtimeBot(BOT)).toBeUndefined();
    expect(reopened.unsentRunnerOperations().map((op) => op.operationId)).toEqual(["delete-1"]);
    reopened.upsertAgent({ id: BOT, name: BOT, avatar: null, backend: "attach" });
    expect(reopened.agentById(BOT)).toBeUndefined();
    expect(() => reopened.nativeBotChat(BOT, 3)).toThrow("was deleted");
    expect(count(db, "bot_native_sessions", "bot", BOT)).toBe(0);
  });

  it("retains cleanup receipts and newer create operations when an older delete completes or replays", () => {
    const { storage } = fixture();
    for (const [operationId, kind] of [["old-create", "create_runtime"], ["delete", "delete_runtime"], ["new-create", "create_runtime"]] as const) {
      storage.enqueueRunnerOperation({ operationId, bot: BOT, kind, specGeneration: 1, payload: { fixture: true }, at: 1 });
    }
    const receipt = { operationId: "delete", botId: BOT, specGeneration: 1, stage: "deleted", at: 2 };
    expect(storage.recordRunnerReceipt(receipt)).toBe("recorded");
    expect(storage.runnerOperation("old-create")).toBeUndefined();
    expect(storage.runnerOperation("new-create")).toBeDefined();
    expect(storage.runnerOperation("delete")?.stage).toBe("deleted");
    expect(storage.recordRunnerReceipt(receipt)).toBe("recorded");
    expect(storage.runnerOperation("new-create")).toBeDefined();
  });

  it("reconciles older completed runtime residue on reopen without discarding the delete replay fence", () => {
    const { storage, db, path } = fixture();
    storage.enqueueRunnerOperation({ operationId: "old", bot: BOT, kind: "create_runtime", specGeneration: 1, payload: {}, at: 1 });
    storage.enqueueRunnerOperation({ operationId: "cleanup", bot: BOT, kind: "delete_runtime", specGeneration: 1, payload: {}, at: 2 });
    // Simulate a database from a build that retained all historical creates after cleanup.
    db.prepare("UPDATE runner_operations SET stage = 'deleted' WHERE operation_id = 'cleanup'").run();
    const reopened = openStorage(path); stores.push(reopened);
    expect(reopened.runnerOperation("old")).toBeUndefined();
    expect(reopened.runnerOperation("cleanup")?.stage).toBe("deleted");
  });

  it("retains execution cleanup until acknowledgement and purges execution-owned attach data", () => {
    const { storage, db, path } = fixture();
    const sessionId = storage.nativeBotChat(BOT, 1).sessionId;
    storage.saveChatExecution({ executionId: "execution-fixture", bot: BOT, sessionId, runnerId: "runner", token: "execution-private", operationId: "operation", stage: "ready", createdAt: 1,
      workspace: { computerId: "computer", projectId: "project", mode: "direct" } });
    storage.enqueueAttachCommand("execution-fixture", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "message", text: "work" }, 2);
    db.prepare("INSERT INTO task_slash_catalogs VALUES ('execution-fixture', '[]')").run();
    storage.purgeBot(BOT);
    const reopened = openStorage(path); stores.push(reopened);
    expect(reopened.chatExecutionById("execution-fixture")?.stage).toBe("deleted");
    expect(count(db, "attach_command_outbox", "agent_id", "execution-fixture")).toBe(0);
    expect(count(db, "task_slash_catalogs", "peer", "execution-fixture")).toBe(0);
    reopened.completeChatExecutionDeletion("execution-fixture");
    expect(reopened.chatExecutionById("execution-fixture")).toBeUndefined();
  });

  it("scopes deletion and explicit restoration to the federated canonical name", () => {
    const { storage } = fixture();
    const home = endpointStorage(storage, "home"), studio = endpointStorage(storage, "studio");
    home.purgeBot(BOT);
    expect(home.isBotDeleted(BOT)).toBe(true);
    expect(studio.isBotDeleted(BOT)).toBe(false);
    studio.restoreBot(BOT);
    expect(home.isBotDeleted(BOT)).toBe(true);
    home.restoreBot(BOT);
    expect(home.isBotDeleted(BOT)).toBe(false);
  });
});

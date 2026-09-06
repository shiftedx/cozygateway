import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertValid, TaskEventSchema, type TaskEvent, type TaskReason, type TaskState, type TaskView, type TaskWaitingOn } from "cozygateway-contract";
import type { AttachV1Command, AttachV1EventFrame } from "./adapters/attach/protocol-v1.ts";

const TERMINAL = new Set<TaskState>(["completed", "failed", "cancelled"]);
const WAIT = new Set<TaskState>(["waiting_for_approval", "waiting_for_user_input", "waiting_for_device"]);
interface TaskRow { taskId: string; bot: string; sessionId: string; room: string | null; originatingTurnId: string; originatingMessageId: string; goal: string }
interface RunRow { taskId: string; peer: string; runId: string; sessionId: string; intentRevision: number; predecessorRunId: string | null }
const TASK_SELECT = "SELECT task_id AS taskId, bot, session_id AS sessionId, room, originating_turn_id AS originatingTurnId, originating_message_id AS originatingMessageId, goal FROM tasks";
const RUN_SELECT = "SELECT task_id AS taskId, peer, run_id AS runId, session_id AS sessionId, intent_revision AS intentRevision, predecessor_run_id AS predecessorRunId FROM task_runs";

/** The Task stream is authoritative. Execution remains the existing attach command/terminal
 * journal. These writes share Storage's SQLite transaction at each admission boundary. */
export class Tasks {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, bot TEXT NOT NULL, session_id TEXT NOT NULL, room TEXT, originating_turn_id TEXT NOT NULL, originating_message_id TEXT NOT NULL, goal TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS task_runs (task_id TEXT NOT NULL REFERENCES tasks(task_id), peer TEXT NOT NULL, run_id TEXT NOT NULL, session_id TEXT NOT NULL, intent_revision INTEGER NOT NULL, predecessor_run_id TEXT, PRIMARY KEY(peer,run_id)) STRICT;
      CREATE TABLE IF NOT EXISTS task_intent_revisions (task_id TEXT NOT NULL REFERENCES tasks(task_id), revision INTEGER NOT NULL, goal TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(task_id,revision)) STRICT;
      CREATE TABLE IF NOT EXISTS task_events (task_id TEXT NOT NULL REFERENCES tasks(task_id), seq INTEGER NOT NULL, source_id TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(task_id,seq), UNIQUE(task_id,source_id)) STRICT;
      CREATE TABLE IF NOT EXISTS task_completion_notifications (task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), created_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS task_tool_facts (peer TEXT NOT NULL, run_id TEXT NOT NULL, call_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(peer,run_id,call_id)) STRICT;
      CREATE TABLE IF NOT EXISTS task_waits (task_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, settled_at INTEGER, PRIMARY KEY(task_id,run_id,kind,record_id)) STRICT;
      CREATE TABLE IF NOT EXISTS task_slash_catalogs (peer TEXT PRIMARY KEY, commands_json TEXT NOT NULL) STRICT;
    `);
  }

  atomic<T>(body: () => T): T {
    this.#db.exec("SAVEPOINT task_projection");
    try { const result = body(); this.#db.exec("RELEASE task_projection"); return result; }
    catch (error) { this.#db.exec("ROLLBACK TO task_projection; RELEASE task_projection"); throw error; }
  }

  nativeTerminal(bot: string, sessionId: string, runId: string, status: string, at: number, cause?: string): void {
    const task = this.#db.prepare(`${TASK_SELECT} WHERE bot = ? AND session_id = ? AND task_id IN (SELECT task_id FROM task_runs WHERE run_id = ?)`).get(bot, sessionId, runId) as TaskRow | undefined;
    if (task === undefined) return;
    const view = this.read(task.taskId)?.view;
    if (view === undefined || view.currentRun.runId !== runId || TERMINAL.has(view.state)) return;
    // Harness terminal projection already appended the authoritative outcome at inbox admission.
    const outcome = this.events(task.taskId).find((event) => event.ref?.id === runId && ["run_completed", "run_failed", "run_interrupted", "approval_lost", "clarification_lost", "effects_uncertain", "run_timed_out", "user_cancelled"].includes(event.reason));
    if (outcome !== undefined) return;
    this.append(task.taskId, `native:${runId}`, cause === "cancelled" ? "cancelled" : status === "completed" ? "completed" : "blocked", cause === "cancelled" ? "user_cancelled" : status === "completed" ? "run_completed" : status === "timed_out" ? "run_timed_out" : status === "interrupted" ? "run_interrupted" : "run_failed", status === "timed_out" ? "gateway" : "harness", at, { kind: "run", id: runId });
  }

  declareSlashCommands(peer: string, commands: readonly string[]): void {
    this.#db.prepare("INSERT INTO task_slash_catalogs VALUES (?, ?) ON CONFLICT(peer) DO UPDATE SET commands_json = excluded.commands_json").run(peer, JSON.stringify(commands));
  }

  admit(peer: string, command: AttachV1Command, at: number): void {
    if (command.kind !== "turn") return;
    if (this.run(peer, command.turnId) !== undefined) return;
    const catalog = this.#db.prepare("SELECT commands_json AS json FROM task_slash_catalogs WHERE peer = ?").get(peer) as { json: string } | undefined;
    const token = command.text.trim().split(/\s+/)[0];
    if (catalog !== undefined && (JSON.parse(catalog.json) as string[]).some((name) => token === (name.startsWith("/") ? name : `/${name}`))) return;
    const group = this.#db.prepare("SELECT member AS bot, group_key AS room FROM bot_group_turns WHERE agent_id = ? AND thread_id = ? AND turn_id = ?").get(peer, command.threadId, command.turnId) as { bot: string; room: string } | undefined;
    const session = this.#db.prepare("SELECT bot FROM bot_native_sessions WHERE session_id = ?").get(command.threadId) as { bot: string } | undefined;
    const core = this.#db.prepare("SELECT agent_id AS bot FROM threads WHERE id = ? AND agent_id = ?").get(command.threadId, peer) as { bot: string } | undefined;
    const bot = group?.bot ?? session?.bot ?? core?.bot;
    if (bot === undefined) return;
    const taskId = randomUUID();
    this.#db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run(taskId, bot, command.threadId, group?.room ?? null, command.turnId, command.messageId, command.text || "Attached work");
    this.#db.prepare("INSERT INTO task_runs VALUES (?, ?, ?, ?, 1, NULL)").run(taskId, peer, command.turnId, command.threadId);
    this.#db.prepare("INSERT INTO task_intent_revisions VALUES (?, 1, ?, ?)").run(taskId, command.text || "Attached work", at);
    this.append(taskId, `turn:${peer}:${command.turnId}`, "queued", "task_created", "gateway", at, { kind: "turn", id: command.turnId });
  }

  run(peer: string, runId: string): RunRow | undefined {
    return this.#db.prepare(`${RUN_SELECT} WHERE peer = ? AND run_id = ?`).get(peer, runId) as RunRow | undefined;
  }

  acknowledged(peer: string, command: AttachV1Command, at: number): void {
    if (command.kind !== "turn") return;
    const run = this.run(peer, command.turnId);
    if (run === undefined) return;
    const view = this.read(run.taskId)?.view;
    if (view?.state === "queued" && view.currentRun.runId === run.runId)
      this.append(run.taskId, `ack:${peer}:${run.runId}`, "running", "run_started", "harness", at, { kind: "run", id: run.runId });
  }

  event(peer: string, frame: AttachV1EventFrame, at: number): void {
    const event = frame.event;
    if (!("turnId" in event) || !("threadId" in event)) return;
    const run = this.run(peer, event.turnId);
    if (run === undefined || run.sessionId !== event.threadId) return;
    const view = this.read(run.taskId)?.view;
    if (view === undefined || view.currentRun.runId !== run.runId || TERMINAL.has(view.state)) return;
    const priorOutcome = this.events(run.taskId).find((entry) => entry.ref?.id === run.runId && ["run_timed_out", "run_failed", "run_interrupted", "approval_lost", "clarification_lost", "effects_uncertain"].includes(entry.reason));
    if (priorOutcome !== undefined && event.kind !== "delegation") return;
    const source = `event:${peer}:${frame.eventId}`;
    if (event.kind === "tool") {
      // A call's role is source-bound and immutable. Conflicting later labels fail closed.
      const prior = this.#db.prepare("SELECT role FROM task_tool_facts WHERE peer = ? AND run_id = ? AND call_id = ?").get(peer, run.runId, event.callId) as { role: string } | undefined;
      const role = prior?.role ?? event.role ?? "unknown";
      this.#db.prepare("INSERT OR IGNORE INTO task_tool_facts VALUES (?, ?, ?, ?)").run(peer, run.runId, event.callId, role);
      const effect = this.#db.prepare("SELECT 1 FROM task_tool_facts WHERE peer = ? AND run_id = ? AND role IN ('mutation','unknown') LIMIT 1").get(peer, run.runId) !== undefined;
      if (role === "verification" && event.status === "running" && effect && view.state === "running") this.append(run.taskId, source, "verifying", "verification_started", "harness", at, { kind: "toolCall", id: event.callId });
      if (role === "verification" && event.status === "error" && view.state === "verifying") this.append(run.taskId, source, "running", "verification_failed", "harness", at, { kind: "toolCall", id: event.callId });
      return;
    }
    if (event.kind === "commit" && event.continues !== true) {
      this.append(run.taskId, source, "completed", "run_completed", "harness", at, { kind: "run", id: run.runId });
    } else if (event.kind === "failed" || event.kind === "interrupted" || event.kind === "cancelled") {
      const reason: TaskReason = event.kind === "cancelled" ? "user_cancelled" : event.kind === "interrupted" ? "run_interrupted" : event.message?.startsWith("approval_lost:") ? "approval_lost" : event.message?.startsWith("clarify_lost:") ? "clarification_lost" : event.message?.startsWith("effects_uncertain:") ? "effects_uncertain" : "run_failed";
      this.append(run.taskId, source, event.kind === "cancelled" ? "cancelled" : "blocked", reason, "harness", at, { kind: "run", id: run.runId });
    }
  }

  interaction(bot: string, kind: "approval" | "clarify", id: string): void {
    const record = this.#db.prepare("SELECT session_id AS sessionId, turn_id AS turnId, status, expires_at AS expiresAt, updated_at AS at FROM bot_native_interactions WHERE bot = ? AND kind = ? AND interaction_id = ?").get(bot, kind, id) as { sessionId: string; turnId: string; status: string; expiresAt: number | null; at: number } | undefined;
    if (record === undefined || record.expiresAt === null) return;
    const task = this.#db.prepare(`${TASK_SELECT} WHERE bot = ? AND session_id = ? AND task_id IN (SELECT task_id FROM task_runs WHERE run_id = ?)`).get(bot, record.sessionId, record.turnId) as TaskRow | undefined;
    if (task === undefined) return;
    this.wait(task.taskId, record.turnId, kind === "clarify" ? "clarification" : "approval", id, record.expiresAt, record.status, record.at);
  }

  wait(taskId: string, runId: string, kind: TaskWaitingOn["kind"], id: string, expiresAt: number, status: string, at: number): void {
    const view = this.read(taskId)?.view;
    if (view === undefined || view.currentRun.runId !== runId || TERMINAL.has(view.state)) return;
    const refKind = kind === "device" ? "deviceRequest" : kind;
    const requested: TaskReason = kind === "approval" ? "approval_requested" : kind === "clarification" ? "clarification_requested" : "device_requested";
    if (status === "pending") {
      this.#db.prepare("INSERT OR IGNORE INTO task_waits VALUES (?, ?, ?, ?, ?, ?, NULL)").run(taskId, runId, kind, id, at, expiresAt);
      if (["running", "verifying"].includes(view.state)) this.append(taskId, `wait:${runId}:${kind}:${id}:pending`, kind === "approval" ? "waiting_for_approval" : kind === "clarification" ? "waiting_for_user_input" : "waiting_for_device", requested, "harness", at, { kind: refKind, id });
      return;
    }
    const changed = this.#db.prepare("UPDATE task_waits SET settled_at = ? WHERE task_id = ? AND run_id = ? AND kind = ? AND record_id = ? AND settled_at IS NULL").run(at, taskId, runId, kind, id).changes === 1;
    if (!changed) return;
    const entry = [...this.events(taskId)].reverse().find((event) => event.reason === requested && event.ref?.id === id);
    if (entry === undefined || !WAIT.has(view.state)) return;
    const expired = status === "expired";
    const reason: TaskReason = kind === "approval" ? expired ? "approval_expired" : status === "approved" ? "approval_approved" : "approval_denied" : kind === "clarification" ? expired ? "clarification_expired" : "clarification_answered" : expired ? "device_request_expired" : status === "lost" ? "device_request_lost" : status === "ok" ? "device_answered" : "device_refused";
    this.append(taskId, `wait:${runId}:${kind}:${id}:settled`, entry.from ?? "running", reason, expired || status === "lost" ? "gateway" : kind === "device" ? "device" : "user", at, { kind: refKind, id });
  }

  waiting(peer: string, runId: string): TaskWaitingOn | undefined {
    const run = this.run(peer, runId);
    if (run === undefined) return undefined;
    const wait = this.#db.prepare("SELECT kind, record_id AS id, expires_at AS expiresAt FROM task_waits WHERE task_id = ? AND run_id = ? AND settled_at IS NULL ORDER BY requested_at LIMIT 1").get(run.taskId, runId) as TaskWaitingOn | undefined;
    return wait;
  }

  suspended(peer: string, runId: string, since: number, now: number): number {
    const run = this.run(peer, runId);
    if (run === undefined) return 0;
    const waits = this.#db.prepare("SELECT requested_at AS start, COALESCE(settled_at, MIN(expires_at, ?)) AS end FROM task_waits WHERE task_id = ? AND run_id = ? ORDER BY requested_at").all(now, run.taskId, runId) as unknown as { start: number; end: number }[];
    let end = since;
    let total = 0;
    for (const wait of waits) { const start = Math.max(end, since, wait.start); const until = Math.min(now, wait.end); if (until > start) { total += until - start; end = until; } }
    return total;
  }

  append(taskId: string, source: string, to: TaskState, reason: TaskReason, actor: TaskEvent["actor"], at: number, ref?: TaskEvent["ref"]): TaskEvent | undefined {
    const duplicate = this.#db.prepare("SELECT event_json AS json FROM task_events WHERE task_id = ? AND source_id = ?").get(taskId, source) as { json: string } | undefined;
    if (duplicate !== undefined) {
      const prior = JSON.parse(duplicate.json) as TaskEvent;
      if (prior.to !== to || prior.reason !== reason || prior.actor !== actor || JSON.stringify(prior.ref) !== JSON.stringify(ref)) throw new Error("task source conflict");
      return undefined;
    }
    const last = this.events(taskId).at(-1);
    if (last !== undefined && TERMINAL.has(last.to)) return undefined;
    const event: TaskEvent = { taskId, seq: (last?.seq ?? 0) + 1, at, from: last?.to ?? null, to, reason, actor, ...(ref === undefined ? {} : { ref }) };
    assertValid(TaskEventSchema, event);
    this.#db.prepare("INSERT INTO task_events VALUES (?, ?, ?, ?)").run(taskId, event.seq, source, JSON.stringify(event));
    if (to === "completed") this.#db.prepare("INSERT OR IGNORE INTO task_completion_notifications VALUES (?, ?)").run(taskId, at);
    return event;
  }

  events(taskId: string): TaskEvent[] {
    return (this.#db.prepare("SELECT event_json AS json FROM task_events WHERE task_id = ? ORDER BY seq").all(taskId) as unknown as { json: string }[]).map((row) => JSON.parse(row.json) as TaskEvent);
  }

  read(taskId: string, cursor = 0, limit = 100): { view: TaskView; events: TaskEvent[]; nextCursor?: number } | undefined {
    const task = this.#db.prepare(`${TASK_SELECT} WHERE task_id = ?`).get(taskId) as TaskRow | undefined;
    if (task === undefined) return undefined;
    const events = this.events(taskId);
    const lastEvent = events.at(-1);
    if (lastEvent === undefined) return undefined;
    const revision = this.#db.prepare("SELECT revision, goal FROM task_intent_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1").get(taskId) as { revision: number; goal: string };
    const runId = [...events].reverse().find((event) => ["task_created", "user_resumed", "retry_requested", "auto_retry"].includes(event.reason) && (event.ref?.kind === "run" || event.ref?.kind === "turn"))?.ref?.id ?? task.originatingTurnId;
    const run = this.#db.prepare(`${RUN_SELECT} WHERE task_id = ? AND run_id = ?`).get(taskId, runId) as RunRow;
    const notification = this.#db.prepare("SELECT task_id AS taskId, created_at AS createdAt FROM task_completion_notifications WHERE task_id = ?").get(taskId) as { taskId: string; createdAt: number } | undefined;
    const waitingOn = this.waiting(run.peer, runId);
    const view: TaskView = {
      taskId, bot: task.bot, sessionId: task.sessionId, ...(task.room === null ? {} : { room: task.room }), originatingTurnId: task.originatingTurnId, originatingMessageId: task.originatingMessageId,
      goal: revision.goal, intentRevision: revision.revision, state: lastEvent.to,
      at: [...events].reverse().find((event) => event.from !== event.to)?.at ?? lastEvent.at, lastEvent,
      canProceedAlone: ["queued", "running", "verifying"].includes(lastEvent.to),
      currentRun: { runId, intentRevision: run.intentRevision, ...(run.predecessorRunId === null ? {} : { predecessorRunId: run.predecessorRunId }) },
      ...(waitingOn === undefined ? {} : { waitingOn }),
      automaticRetryCount: events.filter((event) => event.reason === "auto_retry").length, automaticRetryBudget: 1, children: [], artifacts: [], ...(notification === undefined ? {} : { notification }),
    };
    const page = events.filter((event) => event.seq > cursor).slice(0, Math.max(1, Math.min(500, limit)));
    const tail = page.at(-1)?.seq;
    return { view, events: page, ...(tail !== undefined && tail < lastEvent.seq ? { nextCursor: tail } : {}) };
  }

  list(filter: { bot?: string; room?: string; state?: TaskState } = {}): TaskView[] {
    const tasks = this.#db.prepare(`${TASK_SELECT} ORDER BY rowid DESC`).all() as unknown as TaskRow[];
    return tasks.filter((task) => (filter.bot === undefined || filter.bot === task.bot) && (filter.room === undefined || filter.room === task.room)).map((task) => this.read(task.taskId)!.view).filter((view) => filter.state === undefined || filter.state === view.state);
  }
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertValid, TaskEventSchema, type TaskEvent, type TaskReason, type TaskState, type TaskView, type TaskWaitingOn, type ServerFrame } from "cozygateway-contract";
import type { AttachV1Command, AttachV1EventFrame } from "./adapters/attach/protocol-v1.ts";

const TERMINAL = new Set<TaskState>(["completed", "failed", "cancelled"]);
const LIVE_CHILD = new Set(["queued", "starting", "running", "stalling"]);
const WAIT = new Set<TaskState>(["waiting_for_approval", "waiting_for_user_input", "waiting_for_device"]);
export interface TaskArtifactReference { artifactId: string; status: "pending" | "committed" | "failed" }
/** Initiative 4 binds this to its canonical declaration/commitment reader. No attachment or
 * delivery record is evidence. Missing previously declared references remain unproven. */
export type TaskArtifactReader = (source: { taskId: string; bot: string; peer: string; sessionId: string; runId: string }) => readonly TaskArtifactReference[];
export interface TaskRecoveryDecision { taskId: string; runId: string; issuer: string; decisionId: string; reason: string }
/** Only a trusted canonical operator/policy producer may bind this reader. */
export type TaskRecoveryDecisionReader = (source: { taskId: string; bot: string; runId: string }) => TaskRecoveryDecision | undefined;
interface TaskRow { taskId: string; bot: string; sessionId: string; room: string | null; originatingTurnId: string; originatingMessageId: string; goal: string }
interface RunRow { taskId: string; peer: string; runId: string; sessionId: string; intentRevision: number; predecessorRunId: string | null }
const TASK_SELECT = "SELECT task_id AS taskId, bot, session_id AS sessionId, room, originating_turn_id AS originatingTurnId, originating_message_id AS originatingMessageId, goal FROM tasks";
const RUN_SELECT = "SELECT task_id AS taskId, peer, run_id AS runId, session_id AS sessionId, intent_revision AS intentRevision, predecessor_run_id AS predecessorRunId FROM task_runs";

/** The Task stream is authoritative. Execution remains the existing attach command/terminal
 * journal. These writes share Storage's SQLite transaction at each admission boundary. */
export class Tasks {
  readonly #db: DatabaseSync;
  readonly #live = new Set<string>();
  #clock: () => number = Date.now;
  #bootAt = Date.now();
  #reconciling = false;
  #observer: ((frame: ServerFrame) => void) | undefined;
  #expireInteraction: ((bot: string, kind: "approval" | "clarify", id: string, at: number) => void) | undefined;
  #expireDevice: ((peer: string, runId: string, id: string, at: number) => void) | undefined;
  #recoveryDecision: TaskRecoveryDecisionReader | undefined;
  #artifacts: TaskArtifactReader | undefined;
  #runtime: ((bot: string) => string | undefined) | undefined;
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
      CREATE TABLE IF NOT EXISTS task_absences (task_id TEXT NOT NULL, run_id TEXT NOT NULL, peer TEXT NOT NULL, episode TEXT NOT NULL, absent_at INTEGER NOT NULL, reattached_at INTEGER, PRIMARY KEY(task_id,run_id,episode)) STRICT;
      CREATE TABLE IF NOT EXISTS task_recovery_decisions (task_id TEXT NOT NULL, issuer TEXT NOT NULL, decision_id TEXT NOT NULL, decision_json TEXT NOT NULL, PRIMARY KEY(task_id,issuer,decision_id)) STRICT;
      CREATE TABLE IF NOT EXISTS task_required_artifacts (task_id TEXT NOT NULL, run_id TEXT NOT NULL, artifact_id TEXT NOT NULL, PRIMARY KEY(task_id,run_id,artifact_id)) STRICT;
      CREATE TABLE IF NOT EXISTS task_required_batches (task_id TEXT NOT NULL, run_id TEXT NOT NULL, batch_id TEXT NOT NULL, PRIMARY KEY(task_id,run_id,batch_id)) STRICT;
      CREATE TABLE IF NOT EXISTS task_commands (task_id TEXT NOT NULL, command_key TEXT NOT NULL, payload_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(task_id,command_key)) STRICT;
      CREATE TABLE IF NOT EXISTS task_dispatches (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, peer TEXT NOT NULL, command_json TEXT NOT NULL, predecessor_run_id TEXT, dispatched INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS task_slash_catalogs (peer TEXT PRIMARY KEY, commands_json TEXT NOT NULL) STRICT;
    `);
    // Legacy peers omitted deadlines. Preserve a first-seen bound across restart and replay.
    db.exec(`UPDATE bot_native_interactions SET expires_at = COALESCE((
      SELECT MIN(received_at) FROM attach_event_inbox WHERE disposition = 'accepted'
      AND (agent_id = bot_native_interactions.bot OR EXISTS (
        SELECT 1 FROM chat_executions WHERE execution_id = attach_event_inbox.agent_id
        AND bot = bot_native_interactions.bot AND session_id = bot_native_interactions.session_id
      ))
      AND json_extract(frame_json, '$.event.status') = 'pending'
      AND json_extract(frame_json, '$.event.kind') = bot_native_interactions.kind
      AND json_extract(frame_json, '$.event.threadId') = bot_native_interactions.session_id
      AND json_extract(frame_json, '$.event.turnId') = bot_native_interactions.turn_id
      AND COALESCE(json_extract(frame_json, '$.event.approvalId'), json_extract(frame_json, '$.event.clarifyId')) = bot_native_interactions.interaction_id
    ), updated_at) + 600000 WHERE expires_at IS NULL AND status = 'pending'`);
    // Presence absence time is unknowable across process loss. Preserve the episode identity,
    // but start its provisional lease at this boot unless its loss was already projected.
    for (const row of db.prepare("SELECT task_id AS taskId FROM tasks").all() as unknown as { taskId: string }[]) {
      const view = this.#read(row.taskId)?.view;
      if (view !== undefined && ["running", "verifying", ...WAIT].includes(view.state)) db.prepare("UPDATE task_absences SET absent_at = ? WHERE task_id = ? AND run_id = ? AND reattached_at IS NULL").run(this.#bootAt, row.taskId, view.currentRun.runId);
    }
  }

  expireInteractions(expire: (bot: string, kind: "approval" | "clarify", id: string, at: number) => void): void { this.#expireInteraction = expire; }

  expireDevices(expire: (peer: string, runId: string, id: string, at: number) => void): void { this.#expireDevice = expire; }

  recoveryDecisions(reader: TaskRecoveryDecisionReader): void { this.#recoveryDecision = reader; }

  artifactReferences(reader: TaskArtifactReader): void { this.#artifacts = reader; }

  /** Capability 65: the canonical Artifact producer says a declared reference moved. The Task is
   * still derived from its own append-only stream; this only re-runs the settlement that already
   * exists, so an Artifact never writes a Task state itself. */
  artifactsSettled(taskId: string, runId: string, at = this.#clock()): void {
    const run = this.#db.prepare(`${RUN_SELECT} WHERE task_id = ? AND run_id = ?`).get(taskId, runId) as RunRow | undefined;
    if (run === undefined) return;
    this.atomic(() => this.#settleRequirements(run, at));
  }

  runtime(reader: (bot: string) => string | undefined): void { this.#runtime = reader; }

  ownerDeleted(bot: string, at: number): void {
    this.atomic(() => { for (const view of this.list({ bot })) if (!TERMINAL.has(view.state)) this.append(view.taskId, `owner-deleted:${bot}`, "cancelled", "owner_deleted", "gateway", at, { kind: "run", id: view.currentRun.runId }); });
  }

  observe(observer: (frame: ServerFrame) => void, capabilityVersion = 64): void { this.#observer = capabilityVersion >= 64 ? observer : undefined; }

  clock(now: () => number): void { this.#clock = now; this.#bootAt = now(); }

  read(taskId: string, cursor = 0, limit = 100): { view: TaskView; events: TaskEvent[]; nextCursor?: number } | undefined {
    this.reconcile(this.#clock());
    return this.#read(taskId, cursor, limit);
  }

  hello(peer: string, at: number): void {
    this.presence(peer, true, at);
    for (const view of this.list()) {
      const run = this.#taskRun(view.taskId, view.currentRun.runId);
      if (run.peer === peer && view.state === "waiting_for_device" && view.waitingOn !== undefined) this.atomic(() => this.wait(view.taskId, run.runId, "device", view.waitingOn!.id, view.waitingOn!.expiresAt, "lost", at));
    }
  }

  presence(peer: string, live: boolean, at: number): void {
    if (live) this.#live.add(peer); else this.#live.delete(peer);
    // A peer's socket can close after the durable store was torn down (shutdown, or a test that
    // deliberately retains the closed handle). Presence is a projection of durable state, so a
    // closed store has nothing to project; crashing the process on the way down is not a fence.
    if (!this.#db.isOpen) return;
    // Mark absence only on a transition. A repeated absent callback cannot renew the lease.
    if (!live) {
      for (const row of this.#db.prepare("SELECT task_id AS taskId FROM tasks").all() as unknown as { taskId: string }[]) {
        const view = this.#read(row.taskId)!.view;
        const run = this.#taskRun(view.taskId, view.currentRun.runId);
        if (run.peer === peer && ["running", "verifying", ...WAIT].includes(view.state)) this.#absence(view.taskId, run.runId, peer, at);
      }
    }
    this.reconcile(at);
  }

  #absence(taskId: string, runId: string, peer: string, at: number): { episode: string; absentAt: number } {
    const prior = this.#db.prepare("SELECT episode, absent_at AS absentAt FROM task_absences WHERE task_id = ? AND run_id = ? AND reattached_at IS NULL ORDER BY absent_at DESC LIMIT 1").get(taskId, runId) as { episode: string; absentAt: number } | undefined;
    if (prior !== undefined) return prior;
    const episode = randomUUID();
    this.#db.prepare("INSERT INTO task_absences VALUES (?, ?, ?, ?, ?, NULL)").run(taskId, runId, peer, episode, at);
    return { episode, absentAt: at };
  }

  reconcile(at = this.#clock()): void {
    if (this.#reconciling) return;
    this.#reconciling = true;
    try {
      this.atomic(() => {
        const due = this.#db.prepare("SELECT bot, kind, interaction_id AS id FROM bot_native_interactions WHERE status = 'pending' AND expires_at <= ?").all(at) as unknown as { bot: string; kind: "approval" | "clarify"; id: string }[];
        for (const interaction of due) this.#expireInteraction?.(interaction.bot, interaction.kind, interaction.id, at);
        const devices = this.#db.prepare("SELECT task_id AS taskId, run_id AS runId, record_id AS id, expires_at AS expiresAt FROM task_waits WHERE kind = 'device' AND settled_at IS NULL AND expires_at <= ?").all(at) as unknown as { taskId: string; runId: string; id: string; expiresAt: number }[];
        for (const device of devices) {
          const run = this.#taskRun(device.taskId, device.runId);
          this.#expireDevice?.(run.peer, run.runId, device.id, at);
          this.wait(device.taskId, run.runId, "device", device.id, device.expiresAt, "expired", at);
        }
        for (const view of this.list()) {
          if (TERMINAL.has(view.state)) continue;
          const run = this.#taskRun(view.taskId, view.currentRun.runId);
          if (view.state === "blocked" && this.#executionEnded(run.peer, run.runId)) {
            const decision = this.#recoveryDecision?.({ taskId: view.taskId, bot: view.bot, runId: run.runId });
            if (decision !== undefined && decision.taskId === view.taskId && decision.runId === run.runId) {
              if ([decision.issuer, decision.decisionId, decision.reason].some((value) => value.trim().length === 0 || value.length > 65536)) throw new Error("Invalid recovery decision source");
              const encoded = JSON.stringify(decision);
              const prior = this.#db.prepare("SELECT decision_json AS json FROM task_recovery_decisions WHERE task_id = ? AND issuer = ? AND decision_id = ?").get(view.taskId, decision.issuer, decision.decisionId) as { json: string } | undefined;
              if (prior !== undefined && prior.json !== encoded) throw new Error("Conflicting recovery decision identity");
              this.#db.prepare("INSERT OR IGNORE INTO task_recovery_decisions VALUES (?, ?, ?, ?)").run(view.taskId, decision.issuer, decision.decisionId, encoded);
              this.append(view.taskId, `recovery:${decision.issuer}:${decision.decisionId}`, "failed", "no_recovery_remaining", "gateway", at, { kind: "run", id: run.runId });
              continue;
            }
          }
          const pending = view.pendingIntent;
          if (pending !== undefined && (pending.command === "cancel" || pending.command === "pause") && this.#executionEnded(run.peer, run.runId)) {
            this.append(view.taskId, `command:${pending.idempotencyKey}:landed`, pending.command === "cancel" ? "cancelled" : "waiting_for_user_input", pending.command === "cancel" ? "user_cancelled" : "user_paused", "user", at, { kind: "run", id: run.runId });
            continue;
          }
          const transition = [...this.events(view.taskId)].reverse().find((event) => event.from !== event.to);
          const stage = this.#runtime?.(view.bot);
          if (view.state === "queued" && (stage === "stopped" || stage === "needs_attention")) this.append(view.taskId, `runtime:${run.runId}:${stage}:${view.lastEvent.seq}`, stage === "stopped" ? "waiting_for_user_input" : "blocked", stage === "stopped" ? "runtime_stopped" : "runtime_needs_attention", "gateway", at, { kind: "run", id: run.runId });
          if (stage === "ready" && (transition?.reason === "runtime_stopped" || transition?.reason === "runtime_needs_attention")) this.append(view.taskId, `runtime:${run.runId}:ready:${transition.seq}`, "queued", "runtime_ready", "gateway", at, { kind: "run", id: run.runId });
          this.#settleRequirements(run, at);
          const live = this.#live.has(run.peer);
          if (live) {
            const absence = this.#db.prepare("SELECT episode FROM task_absences WHERE task_id = ? AND run_id = ? AND reattached_at IS NULL ORDER BY absent_at DESC LIMIT 1").get(view.taskId, run.runId) as { episode: string } | undefined;
            if (absence !== undefined) {
              if (view.state === "blocked" && transition?.reason === "owner_unreachable") {
                const wait = this.waiting(run.peer, run.runId);
                const prior = transition.from ?? "running";
                const restored = WAIT.has(prior) ? wait === undefined ? this.#waitBase(view.taskId, transition.seq) : this.#waitState(wait.kind) : prior;
                this.append(view.taskId, `owner:${run.runId}:${absence.episode}:reattached`, restored, "owner_reattached", "gateway", at, { kind: "run", id: run.runId });
              }
              this.#db.prepare("UPDATE task_absences SET reattached_at = ? WHERE task_id = ? AND run_id = ? AND episode = ? AND reattached_at IS NULL").run(at, view.taskId, run.runId, absence.episode);
            }
          } else if (!this.#executionEnded(run.peer, run.runId) && ["running", "verifying", ...WAIT].includes(view.state) && transition?.reason !== "user_paused" && transition?.reason !== "runtime_stopped") {
            const absence = this.#absence(view.taskId, run.runId, run.peer, this.#bootAt);
            if (at - absence.absentAt >= 120_000) this.append(view.taskId, `owner:${run.runId}:${absence.episode}:lost`, "blocked", "owner_unreachable", "gateway", at, { kind: "run", id: run.runId });
          }
        }
      });
    } finally { this.#reconciling = false; }
  }

  command(taskId: string, action: "cancel" | "pause" | "resume" | "retry" | "scope", payload: { idempotencyKey: string; goal?: string }, at = this.#clock()): { outcome: "accepted" | "conflict"; view?: TaskView } {
    this.reconcile(at);
    if (payload.idempotencyKey.length === 0 || payload.idempotencyKey.length > 256 || (action === "scope" && (payload.goal === undefined || payload.goal.trim().length === 0 || payload.goal.length > 65536))) return { outcome: "conflict" };
    const encoded = JSON.stringify({ action, goal: payload.goal ?? null });
    return this.atomic(() => {
      const prior = this.#db.prepare("SELECT payload_json AS payload, result_json AS result FROM task_commands WHERE task_id = ? AND command_key = ?").get(taskId, payload.idempotencyKey) as { payload: string; result: string } | undefined;
      if (prior !== undefined) return prior.payload === encoded ? JSON.parse(prior.result) as { outcome: "accepted"; view: TaskView } : { outcome: "conflict", view: this.#read(taskId)?.view };
      const view = this.#read(taskId)?.view;
      if (view === undefined) return { outcome: "conflict" };
      const transition = [...this.events(taskId)].reverse().find((event) => event.from !== event.to);
      const accepted = action === "cancel" ? !TERMINAL.has(view.state) || view.state === "cancelled" : action === "scope" ? !TERMINAL.has(view.state) : action === "pause" ? ["queued", "running", "verifying", "waiting_for_approval", "waiting_for_device"].includes(view.state) : action === "resume" ? view.state === "waiting_for_user_input" && transition?.reason === "user_paused" : view.state === "blocked";
      if (!accepted || (view.pendingIntent?.command === "cancel" && action !== "cancel" && action !== "scope")) return { outcome: "conflict", view };
      const run = this.#taskRun(taskId, view.currentRun.runId);
      const source = `command:${payload.idempotencyKey}`;
      if (action === "scope") {
        const revision = view.intentRevision + 1;
        this.#db.prepare("INSERT INTO task_intent_revisions VALUES (?, ?, ?, ?)").run(taskId, revision, payload.goal!, at);
        this.append(taskId, source, view.state, "scope_changed", "user", at, { kind: "intentRevision", id: String(revision) });
        if (!this.#executionEnded(run.peer, run.runId)) this.#queue(taskId, `${source}:steer`, run.peer, { kind: "steer", threadId: run.sessionId, turnId: run.runId, messageId: randomUUID(), text: payload.goal! });
      } else if (action === "resume" || action === "retry") {
        const next = randomUUID();
        this.#db.prepare("INSERT INTO task_runs VALUES (?, ?, ?, ?, ?, ?)").run(taskId, run.peer, next, run.sessionId, view.intentRevision, run.runId);
        this.append(taskId, source, "queued", action === "resume" ? "user_resumed" : "retry_requested", "user", at, { kind: "run", id: next });
        this.#queue(taskId, `${source}:turn`, run.peer, { kind: "turn", threadId: run.sessionId, turnId: next, messageId: `${next}:user`, text: view.goal }, run.runId);
        if (!this.#executionEnded(run.peer, run.runId)) this.#queue(taskId, `${source}:interrupt`, run.peer, { kind: "interrupt", threadId: run.sessionId, turnId: run.runId });
      } else if (view.state !== "cancelled") {
        this.append(taskId, source, view.state, action === "cancel" ? "cancel_requested" : "pause_requested", "user", at, { kind: "run", id: run.runId });
        if (this.#executionEnded(run.peer, run.runId)) this.append(taskId, `${source}:landed`, action === "cancel" ? "cancelled" : "waiting_for_user_input", action === "cancel" ? "user_cancelled" : "user_paused", "gateway", at, { kind: "run", id: run.runId });
        else {
          const outbox = this.#db.prepare("SELECT acked_at AS ackedAt FROM attach_command_outbox WHERE agent_id = ? AND json_extract(command_json, '$.kind') = 'turn' AND json_extract(command_json, '$.turnId') = ?").get(run.peer, run.runId) as { ackedAt: number | null } | undefined;
          if (outbox?.ackedAt != null) this.#queue(taskId, `${source}:interrupt`, run.peer, { kind: "interrupt", threadId: run.sessionId, turnId: run.runId });
        }
      }
      const result = { outcome: "accepted" as const, view: this.#read(taskId)!.view };
      this.#db.prepare("INSERT INTO task_commands VALUES (?, ?, ?, ?)").run(taskId, payload.idempotencyKey, encoded, JSON.stringify(result));
      return result;
    });
  }

  discarded(peer: string, command: AttachV1Command, at: number): void {
    if (command.kind !== "turn") return;
    const run = this.run(peer, command.turnId);
    const view = run === undefined ? undefined : this.#read(run.taskId)?.view;
    if (run === undefined || view === undefined || view.currentRun.runId !== command.turnId || view.state !== "queued") return;
    this.append(run.taskId, `discard:${run.runId}`, "blocked", "command_discarded", "gateway", at, { kind: "run", id: run.runId });
    const pending = view.pendingIntent?.command;
    if (pending === "cancel" || pending === "pause") {
      this.append(run.taskId, `discard:${run.runId}:intent`, pending === "cancel" ? "cancelled" : "waiting_for_user_input", pending === "cancel" ? "user_cancelled" : "user_paused", "gateway", at, { kind: "run", id: run.runId });
    } else if (view.automaticRetryCount < view.automaticRetryBudget) {
      const next = randomUUID();
      this.#db.prepare("INSERT INTO task_runs VALUES (?, ?, ?, ?, ?, ?)").run(run.taskId, peer, next, run.sessionId, view.intentRevision, run.runId);
      this.append(run.taskId, `discard:${run.runId}:retry`, "queued", "auto_retry", "gateway", at, { kind: "run", id: next });
      this.#queue(run.taskId, `auto:${next}`, peer, { ...command, turnId: next, messageId: `${next}:user`, text: view.goal }, run.runId);
    }
  }

  #executionEnded(peer: string, runId: string): boolean {
    if (this.#db.prepare("SELECT 1 FROM attach_turn_terminals WHERE agent_id = ? AND turn_id = ?").get(peer, runId) !== undefined) return true;
    const outbox = this.#db.prepare("SELECT cancelled_at AS cancelledAt FROM attach_command_outbox WHERE agent_id = ? AND json_extract(command_json, '$.kind') = 'turn' AND json_extract(command_json, '$.turnId') = ?").get(peer, runId) as { cancelledAt: number | null } | undefined;
    if (outbox !== undefined) return outbox.cancelledAt !== null;
    const reserved = this.run(peer, runId);
    return reserved?.predecessorRunId == null || this.#executionEnded(peer, reserved.predecessorRunId);
  }

  #queue(taskId: string, id: string, peer: string, command: AttachV1Command, predecessor?: string): void {
    this.#db.prepare("INSERT OR IGNORE INTO task_dispatches (id,task_id,peer,command_json,predecessor_run_id) VALUES (?, ?, ?, ?, ?)").run(`${taskId}:${id}`, taskId, peer, JSON.stringify(command), predecessor ?? null);
  }

  dispatch(send: (peer: string, id: string, command: AttachV1Command) => boolean): void {
    const rows = this.#db.prepare("SELECT id, task_id AS taskId, peer, command_json AS json, predecessor_run_id AS predecessor FROM task_dispatches WHERE dispatched = 0 ORDER BY rowid").all() as unknown as { id: string; taskId: string; peer: string; json: string; predecessor: string | null }[];
    for (const row of rows) {
      const command = JSON.parse(row.json) as AttachV1Command;
      const view = this.#read(row.taskId)?.view;
      if (command.kind !== "interrupt" && (view === undefined || TERMINAL.has(view.state) || (command.kind === "turn" && (view.pendingIntent?.command === "cancel" || view.pendingIntent?.command === "pause" || this.events(row.taskId).filter((event) => event.from !== event.to).at(-1)?.reason === "user_paused")))) { this.#db.prepare("UPDATE task_dispatches SET dispatched = 2 WHERE id = ?").run(row.id); continue; }
      if (command.kind === "turn" && view?.state !== "queued") continue;
      if (command.kind === "steer" && this.#db.prepare("SELECT 1 FROM attach_command_outbox WHERE agent_id = ? AND json_extract(command_json, '$.kind') = 'turn' AND json_extract(command_json, '$.turnId') = ?").get(row.peer, command.turnId) === undefined) continue;
      if (row.predecessor !== null && !this.#executionEnded(row.peer, row.predecessor)) continue;
      if (send(row.peer, row.id, command)) this.#db.prepare("UPDATE task_dispatches SET dispatched = 1 WHERE id = ?").run(row.id);
    }
  }

  atomic<T>(body: () => T): T {
    this.#db.exec("SAVEPOINT task_projection");
    try { const result = body(); this.#db.exec("RELEASE task_projection"); return result; }
    catch (error) { this.#db.exec("ROLLBACK TO task_projection; RELEASE task_projection"); throw error; }
  }

  nativeTerminal(bot: string, sessionId: string, runId: string, status: string, at: number, cause?: string): void {
    const task = this.#db.prepare(`${TASK_SELECT} WHERE bot = ? AND session_id = ? AND task_id IN (SELECT task_id FROM task_runs WHERE run_id = ?)`).get(bot, sessionId, runId) as TaskRow | undefined;
    if (task === undefined) return;
    const view = this.#read(task.taskId)?.view;
    if (view === undefined || view.currentRun.runId !== runId || TERMINAL.has(view.state)) return;
    // Harness terminal projection already appended the authoritative outcome at inbox admission.
    const outcome = this.events(task.taskId).find((event) => event.ref?.id === runId && ["run_completed", "awaiting_children", "awaiting_artifacts", "run_failed", "run_interrupted", "approval_lost", "clarification_lost", "effects_uncertain", "run_timed_out", "user_cancelled", "user_paused"].includes(event.reason));
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

  #taskRun(taskId: string, runId: string): RunRow {
    const row = this.#db.prepare(`${RUN_SELECT} WHERE task_id = ? AND run_id = ?`).get(taskId, runId) as RunRow | undefined;
    if (row === undefined) throw new Error("Task stream references a missing Run");
    return row;
  }

  run(peer: string, runId: string): RunRow | undefined {
    return this.#db.prepare(`${RUN_SELECT} WHERE peer = ? AND run_id = ?`).get(peer, runId) as RunRow | undefined;
  }

  acknowledged(peer: string, command: AttachV1Command, at: number): void {
    if (command.kind !== "turn") return;
    const run = this.run(peer, command.turnId);
    if (run === undefined) return;
    const view = this.#read(run.taskId)?.view;
    if (view?.state === "queued" && view.currentRun.runId === run.runId)
      this.append(run.taskId, `ack:${peer}:${run.runId}`, "running", "run_started", "harness", at, { kind: "run", id: run.runId });
    if (view?.pendingIntent?.command === "pause" || view?.pendingIntent?.command === "cancel") this.#queue(run.taskId, `command:${view.pendingIntent.idempotencyKey}:interrupt`, peer, { kind: "interrupt", threadId: run.sessionId, turnId: run.runId });
  }

  event(peer: string, frame: AttachV1EventFrame, at: number): void {
    const event = frame.event;
    if (!("turnId" in event) || !("threadId" in event)) return;
    const run = this.run(peer, event.turnId);
    if (run === undefined || run.sessionId !== event.threadId) return;
    const view = this.#read(run.taskId)?.view;
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
    if (event.kind === "delegation") {
      this.#settleRequirements(run, at);
      return;
    }
    if (event.kind === "commit" && event.continues !== true) {
      const children = this.#children(run);
      const batches = new Set(children.filter((child) => LIVE_CHILD.has(child.status) || children.filter((sibling) => sibling.batchId === child.batchId).length < child.count).map((child) => child.batchId));
      for (const batch of batches) this.#db.prepare("INSERT OR IGNORE INTO task_required_batches VALUES (?, ?, ?)").run(run.taskId, run.runId, batch);
      const artifacts = this.#artifactReferences(run);
      for (const artifact of artifacts) this.#db.prepare("INSERT OR IGNORE INTO task_required_artifacts VALUES (?, ?, ?)").run(run.taskId, run.runId, artifact.artifactId);
      if (batches.size > 0) { this.append(run.taskId, source, "verifying", "awaiting_children", "gateway", at, { kind: "run", id: run.runId }); return; }
      if (artifacts.some((artifact) => artifact.status !== "committed")) { this.append(run.taskId, source, "verifying", "awaiting_artifacts", "gateway", at, { kind: "run", id: run.runId }); this.#settleRequirements(run, at); return; }
      this.append(run.taskId, source, "completed", "run_completed", "harness", at, { kind: "run", id: run.runId });
    } else if (event.kind === "failed" || event.kind === "interrupted" || event.kind === "cancelled") {
      if ((event.kind === "interrupted" || event.kind === "cancelled") && view.pendingIntent !== undefined && view.pendingIntent.command !== "retry") {
        const cancel = view.pendingIntent.command === "cancel";
        this.append(run.taskId, source, cancel ? "cancelled" : "waiting_for_user_input", cancel ? "user_cancelled" : "user_paused", "gateway", at, { kind: "run", id: run.runId });
        return;
      }
      const reason: TaskReason = event.kind === "cancelled" ? "user_cancelled" : event.kind === "interrupted" ? "run_interrupted" : event.message?.startsWith("approval_lost:") ? "approval_lost" : event.message?.startsWith("clarify_lost:") ? "clarification_lost" : event.message?.startsWith("effects_uncertain:") ? "effects_uncertain" : "run_failed";
      this.append(run.taskId, source, event.kind === "cancelled" ? "cancelled" : "blocked", reason, "harness", at, { kind: "run", id: run.runId });
    }
  }

  #children(run: RunRow): Array<TaskView["children"][number] & { count: number }> {
    const rows = this.#db.prepare("SELECT frame_json AS json FROM attach_event_inbox WHERE agent_id = ? AND disposition = 'accepted' AND json_extract(frame_json, '$.event.kind') = 'delegation' AND json_extract(frame_json, '$.event.threadId') = ? AND json_extract(frame_json, '$.event.turnId') = ? ORDER BY sequence").all(run.peer, run.sessionId, run.runId) as unknown as { json: string }[];
    const children = new Map<string, TaskView["children"][number] & { count: number }>();
    for (const row of rows) {
      const event = (JSON.parse(row.json) as AttachV1EventFrame).event;
      if (event.kind !== "delegation") continue;
      const id = `${event.batchId}/${event.childId}`;
      const prior = children.get(id);
      if (prior !== undefined && !LIVE_CHILD.has(prior.status)) continue;
      children.set(id, { batchId: event.batchId, childId: event.childId, status: event.status, count: Math.max(event.count, prior?.count ?? 0) });
    }
    // Existing storage settles child uncertainty after process loss. Join that evidence instead
    // of inventing a second child outcome or leaving a known orphan live.
    const recovered = this.#db.prepare("SELECT batch_id AS batchId, child_id AS childId, status FROM bot_chat_delegations WHERE session_id = ? AND turn_id = ? AND status = 'unknown'").all(run.sessionId, run.runId) as unknown as { batchId: string; childId: string; status: "unknown" }[];
    for (const child of recovered) { const prior = children.get(`${child.batchId}/${child.childId}`); if (prior !== undefined && LIVE_CHILD.has(prior.status)) prior.status = "unknown"; }
    return [...children.values()];
  }

  #settleRequirements(run: RunRow, at: number): void {
    const required = this.#db.prepare("SELECT batch_id AS batchId FROM task_required_batches WHERE task_id = ? AND run_id = ?").all(run.taskId, run.runId) as unknown as { batchId: string }[];
    const artifacts = this.#artifactReferences(run);
    if (required.length === 0 && artifacts.length === 0) return;
    const proof = this.events(run.taskId).some((event) => event.ref?.id === run.runId && ["awaiting_children", "awaiting_artifacts"].includes(event.reason));
    if (!proof) return;
    const view = this.#read(run.taskId)?.view;
    if (view?.state !== "verifying" || view.currentRun.runId !== run.runId) return;
    const children = this.#children(run).filter((child) => required.some((batch) => batch.batchId === child.batchId));
    const failed = children.find((child) => ["failed", "interrupted", "stalled", "unknown"].includes(child.status));
    if (failed !== undefined) {
      this.append(run.taskId, `children:${run.runId}:failed`, "blocked", failed.status === "unknown" ? "child_unknown" : "child_failed", "gateway", at, { kind: "child", id: `${failed.batchId}/${failed.childId}` });
    } else if (artifacts.some((artifact) => artifact.status === "failed")) {
      this.append(run.taskId, `artifacts:${run.runId}:failed`, "blocked", "artifact_commit_failed", "gateway", at, { kind: "artifact", id: artifacts.find((artifact) => artifact.status === "failed")!.artifactId });
    } else if ((required.length === 0 || (children.length > 0 && children.every((child) => !LIVE_CHILD.has(child.status) && children.filter((sibling) => sibling.batchId === child.batchId).length >= child.count))) && artifacts.every((artifact) => artifact.status === "committed")) this.append(run.taskId, `children:${run.runId}:settled`, "completed", "terminal_proof_recorded", "gateway", at, { kind: "run", id: run.runId });
  }

  #artifactReferences(run: RunRow): TaskArtifactReference[] {
    const task = this.#db.prepare(`${TASK_SELECT} WHERE task_id = ?`).get(run.taskId) as TaskRow | undefined;
    if (task === undefined) throw new Error("Artifact reference source has no Task");
    const facts = this.#artifacts?.({ taskId: run.taskId, bot: task.bot, peer: run.peer, sessionId: run.sessionId, runId: run.runId }) ?? [];
    const required = this.#db.prepare("SELECT artifact_id AS artifactId FROM task_required_artifacts WHERE task_id = ? AND run_id = ?").all(run.taskId, run.runId) as unknown as { artifactId: string }[];
    const references = new Map(facts.map((fact) => [fact.artifactId, fact]));
    for (const { artifactId } of required) if (!references.has(artifactId)) references.set(artifactId, { artifactId, status: "pending" });
    return [...references.values()];
  }

  device(input: { agentId: string; threadId: string; turnId: string; requestId: string; expiresAt: number; status: string }, at = this.#clock()): void {
    const run = this.run(input.agentId, input.turnId);
    if (run === undefined || run.sessionId !== input.threadId) return;
    this.atomic(() => this.wait(run.taskId, run.runId, "device", input.requestId, input.expiresAt, input.status, at));
  }

  interaction(bot: string, kind: "approval" | "clarify", id: string): void {
    const record = this.#db.prepare("SELECT session_id AS sessionId, turn_id AS turnId, status, expires_at AS expiresAt, updated_at AS at FROM bot_native_interactions WHERE bot = ? AND kind = ? AND interaction_id = ?").get(bot, kind, id) as { sessionId: string; turnId: string; status: string; expiresAt: number | null; at: number } | undefined;
    if (record === undefined || record.expiresAt === null) return;
    const task = this.#db.prepare(`${TASK_SELECT} WHERE bot = ? AND session_id = ? AND task_id IN (SELECT task_id FROM task_runs WHERE run_id = ?)`).get(bot, record.sessionId, record.turnId) as TaskRow | undefined;
    if (task === undefined) return;
    this.wait(task.taskId, record.turnId, kind === "clarify" ? "clarification" : "approval", id, record.expiresAt, record.status, record.at);
  }

  wait(taskId: string, runId: string, kind: TaskWaitingOn["kind"], id: string, expiresAt: number, status: string, at: number): void {
    const view = this.#read(taskId)?.view;
    if (view === undefined || view.currentRun.runId !== runId || (TERMINAL.has(view.state) && status === "pending")) return;
    const refKind = kind === "device" ? "deviceRequest" : kind;
    const requested: TaskReason = kind === "approval" ? "approval_requested" : kind === "clarification" ? "clarification_requested" : "device_requested";
    if (status === "pending") {
      this.#db.prepare("INSERT OR IGNORE INTO task_waits VALUES (?, ?, ?, ?, ?, ?, NULL)").run(taskId, runId, kind, id, at, expiresAt);
      if (["running", "verifying", ...WAIT].includes(view.state)) this.append(taskId, `wait:${runId}:${kind}:${id}:pending`, WAIT.has(view.state) ? view.state : kind === "approval" ? "waiting_for_approval" : kind === "clarification" ? "waiting_for_user_input" : "waiting_for_device", requested, "harness", at, { kind: refKind, id });
      return;
    }
    const changed = this.#db.prepare("UPDATE task_waits SET settled_at = MIN(?, expires_at) WHERE task_id = ? AND run_id = ? AND kind = ? AND record_id = ? AND settled_at IS NULL").run(at, taskId, runId, kind, id).changes === 1;
    if (!changed || TERMINAL.has(view.state) || this.#executionEnded(this.#taskRun(taskId, runId).peer, runId)) return;
    const entry = [...this.events(taskId)].reverse().find((event) => event.reason === requested && event.ref?.id === id);
    if (entry === undefined || !WAIT.has(view.state)) return;
    const expired = status === "expired";
    const reason: TaskReason = kind === "approval" ? expired ? "approval_expired" : status === "approved" ? "approval_approved" : "approval_denied" : kind === "clarification" ? expired ? "clarification_expired" : "clarification_answered" : expired ? "device_request_expired" : status === "lost" ? "device_request_lost" : status === "ok" ? "device_answered" : "device_refused";
    const next = this.waiting(this.#taskRun(taskId, runId).peer, runId);
    const restored = next === undefined ? this.#waitBase(taskId, entry.seq) : this.#waitState(next.kind);
    this.append(taskId, `wait:${runId}:${kind}:${id}:settled`, restored, reason, expired || status === "lost" ? "gateway" : kind === "device" ? "device" : "user", at, { kind: refKind, id });
  }

  #waitBase(taskId: string, seq: number): TaskState {
    return [...this.events(taskId)].reverse().find((event) => event.seq <= seq && ["approval_requested", "clarification_requested", "device_requested"].includes(event.reason) && (event.from === "running" || event.from === "verifying"))?.from ?? "running";
  }

  #waitState(kind: TaskWaitingOn["kind"]): TaskState {
    return kind === "approval" ? "waiting_for_approval" : kind === "clarification" ? "waiting_for_user_input" : "waiting_for_device";
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
    if (this.#observer !== undefined) {
      const view = this.#read(taskId)!.view;
      queueMicrotask(() => {
        try {
          const stored = this.#db.prepare("SELECT event_json AS json FROM task_events WHERE task_id = ? AND seq = ?").get(taskId, event.seq) as { json: string } | undefined;
          if (stored?.json === JSON.stringify(event)) this.#observer?.({ type: "bot_task_updated", event, view });
        } catch { /* Socket emission is best effort; the committed stream is the reconnect source. */ }
      });
    }
    return event;
  }

  events(taskId: string): TaskEvent[] {
    return (this.#db.prepare("SELECT event_json AS json FROM task_events WHERE task_id = ? ORDER BY seq").all(taskId) as unknown as { json: string }[]).map((row) => JSON.parse(row.json) as TaskEvent);
  }

  #read(taskId: string, cursor = 0, limit = 100): { view: TaskView; events: TaskEvent[]; nextCursor?: number } | undefined {
    const task = this.#db.prepare(`${TASK_SELECT} WHERE task_id = ?`).get(taskId) as TaskRow | undefined;
    if (task === undefined) return undefined;
    const events = this.events(taskId);
    const lastEvent = events.at(-1);
    if (lastEvent === undefined) return undefined;
    const revision = this.#db.prepare("SELECT revision, goal FROM task_intent_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1").get(taskId) as { revision: number; goal: string };
    const runId = [...events].reverse().find((event) => ["task_created", "user_resumed", "retry_requested", "auto_retry"].includes(event.reason) && (event.ref?.kind === "run" || event.ref?.kind === "turn"))?.ref?.id ?? task.originatingTurnId;
    const run = this.#taskRun(taskId, runId);
    const notification = this.#db.prepare("SELECT task_id AS taskId, created_at AS createdAt FROM task_completion_notifications WHERE task_id = ?").get(taskId) as { taskId: string; createdAt: number } | undefined;
    const intentEvent = [...events].reverse().find((event) => ["cancel_requested", "pause_requested", "user_cancelled", "user_paused", "run_completed", "run_failed", "run_interrupted", "run_timed_out"].includes(event.reason));
    const pendingIntent = intentEvent?.reason === "cancel_requested" || intentEvent?.reason === "pause_requested" ? { command: intentEvent.reason === "cancel_requested" ? "cancel" as const : "pause" as const, idempotencyKey: (this.#db.prepare("SELECT source_id AS source FROM task_events WHERE task_id = ? AND seq = ?").get(taskId, intentEvent.seq) as { source: string }).source.slice("command:".length) } : undefined;
    const waitingOn = this.waiting(run.peer, runId);
    const view: TaskView = {
      taskId, bot: task.bot, sessionId: task.sessionId, ...(task.room === null ? {} : { room: task.room }), originatingTurnId: task.originatingTurnId, originatingMessageId: task.originatingMessageId,
      goal: revision.goal, intentRevision: revision.revision, state: lastEvent.to,
      at: [...events].reverse().find((event) => event.from !== event.to)?.at ?? lastEvent.at, lastEvent,
      canProceedAlone: ["queued", "running", "verifying"].includes(lastEvent.to),
      currentRun: { runId, intentRevision: run.intentRevision, ...(run.predecessorRunId === null ? {} : { predecessorRunId: run.predecessorRunId }) },
      ...(waitingOn === undefined || TERMINAL.has(lastEvent.to) ? {} : { waitingOn }),
      ...(pendingIntent === undefined || TERMINAL.has(lastEvent.to) ? {} : { pendingIntent }),
      automaticRetryCount: events.filter((event) => event.reason === "auto_retry").length, automaticRetryBudget: 1, children: this.#children(run).map(({ count: _count, ...child }) => child), artifacts: this.#artifactReferences(run).map(({ artifactId }) => ({ artifactId })), ...(notification === undefined ? {} : { notification }),
    };
    const page = events.filter((event) => event.seq > cursor).slice(0, Math.max(1, Math.min(500, limit)));
    const tail = page.at(-1)?.seq;
    return { view, events: page, ...(tail !== undefined && tail < lastEvent.seq ? { nextCursor: tail } : {}) };
  }

  list(filter: { bot?: string; room?: string; state?: TaskState } = {}): TaskView[] {
    this.reconcile(this.#clock());
    const tasks = this.#db.prepare(`${TASK_SELECT} ORDER BY rowid DESC`).all() as unknown as TaskRow[];
    return tasks.filter((task) => (filter.bot === undefined || filter.bot === task.bot) && (filter.room === undefined || filter.room === task.room)).map((task) => this.#read(task.taskId)!.view).filter((view) => filter.state === undefined || filter.state === view.state);
  }
}

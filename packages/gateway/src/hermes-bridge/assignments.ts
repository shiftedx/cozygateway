import { randomUUID } from "node:crypto";

import type {
  AssignmentCreateRequest, AssignmentRefusal, AssignmentResult, AssignmentView, BotGroupMessage,
  BotInboxThread, ServerFrame, TaskView,
} from "cozygateway-contract";

import { blocksToText } from "../adapters/attach/blocks-to-text.ts";
import type { AttachV1EventFrame } from "../adapters/attach/protocol-v1.ts";
import type { BotAssignmentRow, BotTeamRow, Storage } from "../storage.ts";
import {
  ASSIGNMENT_DEFAULT_DEADLINE_MS, ASSIGNMENT_MAX_OPEN_PER_LEADER, ASSIGNMENT_MAX_REPORTS, ASSIGNMENT_OPEN_STATES,
  ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS, buildAssignmentPrompt, deriveAssignmentState, parseResultBlock,
  refusalMessage,
} from "./assignment-protocol.ts";
import type { NativeGroupTurnEndpoint } from "./group-turn.ts";

/** A typed refusal: the route answers `409 assignment_refused` with this `reason`. */
export class AssignmentRefused extends Error {
  readonly reason: AssignmentRefusal;
  constructor(reason: AssignmentRefusal, message: string) { super(message); this.name = "AssignmentRefused"; this.reason = reason; }
}
export class AssignmentNotFound extends Error {
  constructor(taskId: string) { super(`no assignment wraps task ${taskId}`); this.name = "AssignmentNotFound"; }
}
/** The calling bot is not the party this action belongs to. */
export class AssignmentForbidden extends Error {
  constructor(message: string) { super(message); this.name = "AssignmentForbidden"; }
}
/** A team patch the gateway will not store (`400 invalid_request`). */
export class AssignmentInvalid extends Error {
  constructor(message: string) { super(message); this.name = "AssignmentInvalid"; }
}
/** An idempotency key already names a different assignment from this leader. */
export class AssignmentConflict extends Error {
  constructor(message: string) { super(message); this.name = "AssignmentConflict"; }
}

export type AssignmentCaller = string | { device: true };

export interface AssignmentRoomsOptions {
  storage: Storage;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  /** The name a person reads for this bot, for the prompt header and the inbox rows. */
  displayName: (bot: string) => string;
  /** Whether this name is a bot on this gateway that can be handed a turn (it has an attach
   * identity). Answers membership for `reports` and for an assignee that stopped being a bot. */
  knownBot: (bot: string) => boolean;
  isAttached: (bot: string) => boolean;
  formatDeadline?: (at: number) => string;
  /** Sends a Task command the gateway just queued, so a cancel's interrupt goes out now. */
  flushTaskCommands?: () => void;
  /** Deadline sweep period. The sweep only ends work; reads derive state without waiting on it. */
  sweepMs?: number;
}

const THREAD_PREFIX = "assignment:";
/** Bot names are case-insensitive and trimmed everywhere else (`normalizeProfileName`). */
const botName = (name: string): string => name.trim().toLowerCase();
/** The oldest an assignment can be and still be open: the longest deadline plus the verifying window. */
const OPEN_HORIZON_MS = 4 * 60 * 60_000 + ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS;

/** agent-inbox 1. A leader hands one bounded piece of work to a bot in its `reports`. The work is
 * an ordinary attach-v1 turn on a gateway-owned `assignment:<taskId>` thread, admitted as the
 * capability-64 Task whose id names the assignment everywhere; this class adds only what the Task
 * lacks (who asked, the brief, the deadline, the parsed `Result:` block, the leader's
 * acknowledgement) and derives the assignment's state from the Task on every read. Settlement is
 * event driven: the Task observer and the assignee's own attach events call in, and the sweep
 * exists only to end work at its deadline. */
export class AssignmentRooms {
  readonly #storage: Storage;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #displayName: (bot: string) => string;
  readonly #knownBot: (bot: string) => boolean;
  readonly #isAttached: (bot: string) => boolean;
  readonly #formatDeadline: (at: number) => string;
  readonly #flushTaskCommands: () => void;
  readonly #timer: ReturnType<typeof setInterval>;
  #endpoint: Pick<NativeGroupTurnEndpoint, "sendNativeTurn" | "sendInterrupt"> | undefined;

  constructor(opts: AssignmentRoomsOptions) {
    this.#storage = opts.storage;
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#displayName = opts.displayName;
    this.#knownBot = opts.knownBot;
    this.#isAttached = opts.isAttached;
    this.#formatDeadline = opts.formatDeadline ?? ((at) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" }));
    this.#flushTaskCommands = opts.flushTaskCommands ?? ((): void => {});
    this.#timer = setInterval(() => this.reconcile(), opts.sweepMs ?? 30_000);
    this.#timer.unref?.();
  }

  /** The ingress is assembled after this, exactly as it is for rooms. */
  setNativeTurns(endpoint: Pick<NativeGroupTurnEndpoint, "sendNativeTurn" | "sendInterrupt">): void {
    this.#endpoint = endpoint;
  }

  team(bot: string): Pick<BotTeamRow, "role" | "reports"> | undefined {
    const row = this.#storage.botTeam(bot);
    return row === undefined ? undefined : { role: row.role, reports: row.reports };
  }

  /** Throws `AssignmentInvalid` for a profile patch's `role` and `reports` the gateway will not store. */
  checkTeam(bot: string, patch: { role?: BotTeamRow["role"]; reports?: string[] }): void {
    this.#teamRow(bot, patch);
  }

  /** Stores a profile patch's `role` and `reports`. Demoting a leader cancels the work it led. */
  setTeam(bot: string, patch: { role?: BotTeamRow["role"]; reports?: string[] }): void {
    const stored = this.#storage.botTeam(bot);
    const row = this.#teamRow(bot, patch);
    this.#storage.setBotTeam(row);
    if (stored?.role === "leader" && row.role === "member") this.#cancelLed(bot);
  }

  #teamRow(bot: string, patch: { role?: BotTeamRow["role"]; reports?: string[] }): BotTeamRow {
    if (!this.#knownBot(bot)) throw new AssignmentInvalid(`${bot} is not a bot on this gateway`);
    const stored = this.#storage.botTeam(bot);
    const role = patch.role ?? stored?.role ?? "member";
    const asked = patch.reports === undefined ? undefined : [...new Set(patch.reports.map(botName))];
    if (asked !== undefined) {
      if (role !== "leader") throw new AssignmentInvalid("reports require role: leader");
      if (asked.length > ASSIGNMENT_MAX_REPORTS) throw new AssignmentInvalid(`a leader has at most ${ASSIGNMENT_MAX_REPORTS} reports`);
      if (asked.includes(bot)) throw new AssignmentInvalid("a bot cannot report to itself");
      const missing = asked.filter((name) => !this.#knownBot(name));
      if (missing.length > 0) throw new AssignmentInvalid(`not a bot on this gateway: ${missing.join(", ")}`);
    }
    // No nested delegation: a leader's reports are members, so no report can lead in turn.
    if (role === "leader") {
      const leads = this.#storage.botTeamLeadersOf(bot).filter((leader) => leader !== bot);
      if (leads.length > 0) throw new AssignmentInvalid(`${bot} reports to ${leads.join(", ")} and cannot lead`);
      const leaders = (asked ?? []).filter((name) => this.#storage.botTeam(name)?.role === "leader");
      if (leaders.length > 0) throw new AssignmentInvalid(`a leader cannot report to another leader: ${leaders.join(", ")}`);
    }
    const reports = role === "member" ? [] : asked ?? stored?.reports ?? [];
    return { bot, role, reports, updatedAt: this.#now() };
  }

  /** The bot's attach identity is gone. Work it led is cancelled. Work it held loses its Task with
   * the bot's other private Tasks, so its state is frozen now, while the Task can still say it:
   * open work reads `cancelled` with failure `assignee deleted`, and delivered work that was
   * waiting on the leader closes as an unacknowledged window would. */
  botDeleted(bot: string): void {
    this.#cancelLed(bot);
    const now = this.#now();
    for (const row of this.#storage.botAssignments({ assignee: bot, createdSince: now - OPEN_HORIZON_MS })) {
      if (row.acknowledgedOutcome !== undefined) continue;
      const state = this.#state(row);
      const frozen = state === "verifying" ? (this.#result(row)?.status === "blocked" ? "failed" : "completed")
        : ASSIGNMENT_OPEN_STATES.has(state) ? "cancelled" : state;
      this.#storage.updateBotAssignment(row.taskId, {
        frozenState: frozen, updatedAt: now,
        ...(frozen === "cancelled" && row.failure === undefined ? { failure: "assignee deleted" } : {}),
      });
      this.#emit(this.#storage.botAssignment(row.taskId)!);
    }
  }

  /** Which side of this assignment `bot` is, if it is still that party. A deleted party is no one,
   * so a later bot of the same name reaches nothing. */
  partyOf(taskId: string, bot: string): "leader" | "assignee" | undefined {
    const row = this.#storage.botAssignment(taskId);
    return row === undefined ? undefined : this.#party(row, bot);
  }

  #party(row: BotAssignmentRow, bot: string): "leader" | "assignee" | undefined {
    if (row.leader === bot && row.leaderDeletedAt === undefined) return "leader";
    if (row.assignee === bot && row.assigneeDeletedAt === undefined) return "assignee";
    return undefined;
  }

  assign(leader: string, request: AssignmentCreateRequest): AssignmentView {
    const to = botName(request.to);
    if (request.idempotencyKey !== undefined) {
      const prior = this.#storage.botAssignmentByKey(leader, request.idempotencyKey);
      if (prior !== undefined && prior.leaderDeletedAt === undefined) {
        if (prior.assignee !== to || prior.brief !== request.brief || prior.doneCriteria !== request.doneCriteria
          || prior.outputFormat !== request.outputFormat
          || prior.deadlineAt - prior.createdAt !== (request.deadlineMs ?? ASSIGNMENT_DEFAULT_DEADLINE_MS))
          throw new AssignmentConflict("idempotencyKey already names a different assignment");
        return this.#view(prior);
      }
    }
    const refuse = (reason: AssignmentRefusal): never => {
      throw new AssignmentRefused(reason, refusalMessage(reason, { leader, assignee: to }));
    };
    const team = this.#storage.botTeam(leader);
    if (team?.role !== "leader") refuse("not_leader");
    if (!team!.reports.includes(to) || !this.#knownBot(to)) refuse("not_a_report");
    const endpoint = this.#endpoint;
    if (endpoint === undefined || !this.#isAttached(to)) refuse("assignee_unavailable");
    if (this.#storage.botAssignments({ assignee: to, createdSince: this.#now() - OPEN_HORIZON_MS }).some((row) => this.#open(row))) refuse("assignee_busy");
    if (this.#storage.botAssignments({ leader, createdSince: this.#now() - OPEN_HORIZON_MS }).filter((row) => this.#open(row)).length >= ASSIGNMENT_MAX_OPEN_PER_LEADER) refuse("leader_task_cap");

    const now = this.#now();
    const taskId = randomUUID();
    const threadId = `${THREAD_PREFIX}${taskId}`;
    const turnId = randomUUID();
    const deadlineAt = now + (request.deadlineMs ?? ASSIGNMENT_DEFAULT_DEADLINE_MS);
    const outputFormat = request.outputFormat;
    const leaderName = this.#displayName(leader);
    // The prompt depends on nothing in `context`, so a peer that ignores the context reads the
    // same bytes (capability 47).
    const text = buildAssignmentPrompt({ leaderDisplayName: leaderName, brief: request.brief, doneCriteria: request.doneCriteria, deadlineAt, ...(outputFormat === undefined ? {} : { outputFormat }) }, this.#formatDeadline);
    // One transaction: the assignment row, the Task it names (admitted as the command is
    // enqueued), and the outbox record. A refused enqueue leaves nothing behind.
    this.#storage.tasks.atomic(() => {
      this.#storage.createBotAssignment({
        taskId, leader, assignee: to, threadId, brief: request.brief, doneCriteria: request.doneCriteria,
        deadlineAt, createdAt: now,
        ...(outputFormat === undefined ? {} : { outputFormat }),
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      });
      const sent = endpoint!.sendNativeTurn(to, {
        threadId, turnId, messageId: `${turnId}:assignment`, text,
        context: {
          actors: [leader, to].map((name) => ({ name, handle: name, displayName: this.#displayName(name), kind: "member" as const })),
          task: { id: taskId, assignedBy: leader, brief: request.brief, doneCriteria: request.doneCriteria, deadlineAt, ...(outputFormat === undefined ? {} : { outputFormat }) },
        },
      });
      // A refused enqueue wrote nothing, so the rollback is complete.
      if (!sent) refuse("assignee_unavailable");
    });
    const row = this.#storage.botAssignment(taskId)!;
    this.#emit(row);
    return this.#view(row);
  }

  view(taskId: string): AssignmentView | undefined {
    const row = this.#storage.botAssignment(taskId);
    return row === undefined ? undefined : this.#view(row);
  }

  list(filter: { leader?: string; assignee?: string; participant?: string }): AssignmentView[] {
    return this.#storage.botAssignments(filter).map((row) => this.#view(row));
  }

  /** Asks the Task to cancel and answers the resulting state; it reads `cancelled` only once the
   * assignee's turn has actually settled. A no-op on an assignment that is already over. */
  cancel(taskId: string, by: "leader" | "user"): AssignmentView {
    const row = this.#storage.botAssignment(taskId);
    if (row === undefined) throw new AssignmentNotFound(taskId);
    const state = this.#state(row);
    if (!ASSIGNMENT_OPEN_STATES.has(state) || state === "verifying" || row.cancelledBy !== undefined) return this.#view(row);
    this.#storage.updateBotAssignment(taskId, { cancelledBy: by, updatedAt: this.#now() });
    this.#cancelTask(taskId, "cancel");
    const updated = this.#storage.botAssignment(taskId)!;
    this.#emit(updated);
    return this.#view(updated);
  }

  /** Only the leader (by its attach identity) or a paired device, and only from `verifying`. */
  acknowledge(taskId: string, by: AssignmentCaller, outcome: "completed" | "failed"): AssignmentView {
    const row = this.#storage.botAssignment(taskId);
    if (row === undefined) throw new AssignmentNotFound(taskId);
    if (typeof by === "string" && this.#party(row, by) !== "leader") throw new AssignmentForbidden("only the leader may acknowledge this assignment");
    if (this.#state(row) !== "verifying")
      throw new AssignmentRefused("not_verifying", refusalMessage("not_verifying", { leader: row.leader, assignee: row.assignee }));
    const now = this.#now();
    this.#storage.updateBotAssignment(taskId, { acknowledgedAt: now, acknowledgedOutcome: outcome, updatedAt: now });
    const updated = this.#storage.botAssignment(taskId)!;
    this.#emit(updated);
    return this.#view(updated);
  }

  inboxThreads(bot: string): BotInboxThread[] {
    return this.#storage.botAssignments({ participant: bot }).map((row) => ({
      id: row.threadId,
      peers: [row.leader, row.assignee],
      startedAt: row.createdAt,
      lastActiveAt: row.updatedAt,
      preview: row.brief.slice(0, 280),
      messageCount: this.#messages(row).length,
    }));
  }

  /** `undefined` when the thread is not one of this bot's. */
  inboxMessages(bot: string, threadId: string): BotGroupMessage[] | undefined {
    const row = this.#storage.botAssignmentByThread(threadId);
    if (row === undefined || this.#party(row, bot) === undefined) return undefined;
    return this.#messages(row);
  }

  /** Every event of the assignee's own identity on an assignment thread belongs to this surface. */
  canAcceptAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean {
    const event = frame.event;
    if (!("threadId" in event) || !event.threadId.startsWith(THREAD_PREFIX)) return false;
    return this.#storage.botAssignmentByThread(event.threadId)?.assignee === agentId;
  }

  /** The Task already applied this event at inbox admission. What is left is the assignment's
   * reading of it: the reply and its `Result:` block, or the turn's own failure. Drafts, tool
   * steps, approvals and clarifications on this thread have no projection in v1 and are
   * acknowledged so the peer's ordered stream keeps moving. */
  handleAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean {
    if (!this.canAcceptAttachEvent(agentId, frame)) return false;
    const event = frame.event;
    if (event.kind !== "commit" && event.kind !== "failed") return true;
    const row = this.#storage.botAssignmentByThread(event.threadId)!;
    // Only the Task's current Run speaks for the assignment; a stale or foreign turn does not.
    if (this.#storage.tasks.run(agentId, event.turnId)?.taskId !== row.taskId) return true;
    const now = this.#now();
    // A reply past a recorded failure (a late answer after the deadline) does not reopen the work.
    if (row.failure !== undefined) return true;
    if (event.kind === "commit") {
      if (event.continues === true) return true;
      const text = blocksToText(event.blocks).trim().slice(0, 65536);
      const result: AssignmentResult | undefined = parseResultBlock(text);
      this.#storage.updateBotAssignment(row.taskId, {
        finalText: text, finalAt: now, finalTurnId: event.turnId, updatedAt: now,
        ...(result === undefined ? {} : { resultJson: JSON.stringify(result) }),
      });
    } else if (row.cancelledBy === undefined) {
      // The Task already recorded the harness's own `run_failed`; the assignment only notes why.
      this.#storage.updateBotAssignment(row.taskId, { failure: (event.message ?? "the assignee's turn failed").slice(0, 1024), updatedAt: now });
    }
    this.#emit(this.#storage.botAssignment(row.taskId)!);
    return true;
  }

  /** Called from the Task observer: a Task transition is an assignment transition. */
  onTaskUpdated(view: TaskView): void {
    const row = this.#storage.botAssignment(view.taskId);
    if (row === undefined) return;
    if (view.lastEvent.at > row.updatedAt) this.#storage.updateBotAssignment(row.taskId, { updatedAt: view.lastEvent.at });
    this.#emit(this.#storage.botAssignment(row.taskId)!);
  }

  /** Ends open work at its deadline and announces, once and across restarts, a verifying window
   * that lapsed (including one that lapsed while the gateway was down). */
  reconcile(now = this.#now()): void {
    for (const row of this.#storage.botAssignments({ createdSince: now - OPEN_HORIZON_MS })) {
      if (row.frozenState !== undefined) continue;
      const task = this.#storage.tasks.read(row.taskId)?.view;
      const live = task !== undefined && !["completed", "failed", "cancelled"].includes(task.state);
      if (live && now >= row.deadlineAt && row.failure === undefined && row.cancelledBy === undefined) {
        this.#storage.updateBotAssignment(row.taskId, { failure: "deadline", updatedAt: now });
        // The gateway's own timeout, exactly as a room member turn times out: the Task records
        // `run_timed_out` by the gateway, never a person's cancel, and the peer is interrupted.
        this.#storage.tasks.nativeTerminal(task.bot, task.sessionId, task.currentRun.runId, "timed_out", now);
        this.#endpoint?.sendInterrupt?.(task.bot, { threadId: task.sessionId, turnId: task.currentRun.runId });
        this.#emit(this.#storage.botAssignment(row.taskId)!);
      } else if (task?.state === "completed" && row.acknowledgedOutcome === undefined && row.lapseAnnouncedAt === undefined
        && now >= task.at + ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS) {
        this.#storage.updateBotAssignment(row.taskId, { lapseAnnouncedAt: now, updatedAt: now });
        this.#emit(this.#storage.botAssignment(row.taskId)!);
      }
    }
  }

  close(): void {
    clearInterval(this.#timer);
  }

  #cancelLed(leader: string): void {
    for (const row of this.#storage.botAssignments({ leader, createdSince: this.#now() - OPEN_HORIZON_MS }))
      if (this.#open(row)) this.cancel(row.taskId, "user");
  }

  #cancelTask(taskId: string, why: string): void {
    const outcome = this.#storage.tasks.command(taskId, "cancel", { idempotencyKey: `assignment:${taskId}:${why}` });
    if (outcome.outcome === "accepted") this.#flushTaskCommands();
  }

  #open(row: BotAssignmentRow): boolean {
    return ASSIGNMENT_OPEN_STATES.has(this.#state(row));
  }

  #result(row: BotAssignmentRow): AssignmentResult | undefined {
    return row.resultJson === undefined ? undefined : JSON.parse(row.resultJson) as AssignmentResult;
  }

  #state(row: BotAssignmentRow, task = this.#storage.tasks.read(row.taskId)?.view): AssignmentView["state"] {
    const resultStatus = this.#result(row)?.status;
    return deriveAssignmentState({
      deadlineAt: row.deadlineAt,
      ...(row.frozenState === undefined ? {} : { frozenState: row.frozenState }),
      ...(resultStatus === undefined ? {} : { resultStatus }),
      ...(row.acknowledgedOutcome === undefined ? {} : { acknowledgedOutcome: row.acknowledgedOutcome }),
      ...(row.cancelledBy === undefined ? {} : { cancelledBy: row.cancelledBy }),
      ...(row.failure === undefined ? {} : { failure: row.failure }),
      ...(task === undefined ? {} : { taskState: task.state, taskAt: task.at }),
    }, this.#now());
  }

  #view(row: BotAssignmentRow): AssignmentView {
    return {
      taskId: row.taskId, leader: row.leader, assignee: row.assignee, brief: row.brief, doneCriteria: row.doneCriteria,
      ...(row.outputFormat === undefined ? {} : { outputFormat: row.outputFormat }),
      deadlineAt: row.deadlineAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
      state: this.#state(row), threadId: row.threadId,
      ...(row.resultJson === undefined ? {} : { result: JSON.parse(row.resultJson) as AssignmentResult }),
      ...(row.finalText === undefined ? {} : { finalText: row.finalText }),
      ...(row.failure === undefined ? {} : { failure: row.failure }),
      ...(row.cancelledBy === undefined ? {} : { cancelledBy: row.cancelledBy }),
      ...(row.acknowledgedAt === undefined ? {} : { acknowledgedAt: row.acknowledgedAt }),
    };
  }

  /** The thread as the room message shape: the leader's brief, then the assignee's reply. */
  #messages(row: BotAssignmentRow): BotGroupMessage[] {
    const member = (name: string) => ({ kind: "member" as const, name, displayName: this.#displayName(name) });
    return [
      { seq: 1, from: member(row.leader), text: row.brief, at: row.createdAt, messageId: `${row.taskId}:brief` },
      ...(row.finalText === undefined ? [] : [{
        seq: 2, from: member(row.assignee), text: row.finalText, at: row.finalAt ?? row.updatedAt,
        messageId: `${row.taskId}:reply`, ...(row.finalTurnId === undefined ? {} : { turnId: row.finalTurnId }),
      }]),
    ];
  }

  #emit(row: BotAssignmentRow): void {
    const state = this.#state(row);
    const updatedAt = row.updatedAt;
    for (const bot of [row.leaderDeletedAt === undefined ? row.leader : undefined, row.assigneeDeletedAt === undefined ? row.assignee : undefined].filter((name) => name !== undefined))
      this.#broadcast({ type: "bot_inbox_activity", bot, threadId: row.threadId, updatedAt, taskId: row.taskId, state });
  }
}

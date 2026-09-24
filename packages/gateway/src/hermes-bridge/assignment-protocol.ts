import type { AssignmentRefusal, AssignmentResult, AssignmentState, TaskState } from "cozygateway-contract";

/** agent-inbox 1. The pure rules of a leader assignment: caps, the prompt the assignee reads, the
 * `Result:` block it answers with, and how the assignment's state is derived from its Task. No I/O
 * and no clock: `now` is always a parameter. */

export const ASSIGNMENT_MAX_OPEN_PER_LEADER = 8;
export const ASSIGNMENT_MAX_REPORTS = 16;
export const ASSIGNMENT_DEFAULT_DEADLINE_MS = 30 * 60_000;
export const ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS = 24 * 60 * 60_000;
export const ASSIGNMENT_OPEN_STATES: ReadonlySet<AssignmentState> = new Set<AssignmentState>([
  "queued", "running", "waiting_for_approval", "waiting_for_user_input", "blocked", "verifying",
]);

export interface AssignmentBrief {
  leaderDisplayName: string;
  brief: string;
  doneCriteria: string;
  outputFormat?: string;
  deadlineAt: number;
}

/** The whole turn text. It depends on nothing in the turn's typed `context`, which is what keeps
 * capability 47's byte-identical rule for a peer that ignores the context. */
export function buildAssignmentPrompt(input: AssignmentBrief, formatDeadline: (at: number) => string): string {
  return [
    `[Task from ${input.leaderDisplayName}] ${input.brief}`,
    `Done when: ${input.doneCriteria}`,
    `Reply format: ${input.outputFormat ?? "a short result followed by a `Result:` block"}`,
    `Deadline: ${formatDeadline(input.deadlineAt)}`,
    "End your reply with a `Result:` block listing status (done | partial | blocked), what changed, and any artifacts as paths or links.",
  ].join("\n");
}

const STATUSES = new Set(["done", "partial", "blocked"]);
/** `Result:`, also bolded (`**Result:**`, `**Result**:`) and with text after it on the same line. */
const RESULT_LINE = /^(?:\*\*|__)?Result(?::(?:\*\*|__)?|(?:\*\*|__):)(.*)$/;
const SUMMARY_KEY = /^(?:summary|changed|what changed)\s*:\s*(.*)$/i;

/** The last `Result:` block in the reply, or `undefined` when there is none or its status is not
 * one of the three words. A missing result is recorded as missing and never invented. */
export function parseResultBlock(text: string): AssignmentResult | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findLastIndex((line) => RESULT_LINE.test(line));
  if (start < 0) return undefined;
  let status: string | undefined;
  const summary: string[] = [];
  const artifacts: string[] = [];
  let listing = false;
  // `Result: done` names the status on the header line; other text there is summary.
  const inline = RESULT_LINE.exec(lines[start]!)![1]!.trim();
  const body = inline.length === 0 ? [] : [STATUSES.has(inline.toLowerCase().replace(/[.*_]/g, "")) ? `status: ${inline.replace(/[.*_]/g, "")}` : inline];
  for (const raw of [...body, ...lines.slice(start + 1)]) {
    // Markdown emphasis around a key (`**Status:** done`) is formatting, not content.
    const line = raw.replace(/\*\*|__/g, "").trim();
    if (line.length === 0) continue;
    const bullet = /^[-*]\s+/.test(line);
    const content = line.replace(/^[-*]\s+/, "");
    const statusMatch = /^status\s*:\s*(.*)$/i.exec(content);
    const artifactsMatch = /^artifacts\s*:\s*(.*)$/i.exec(content);
    const summaryMatch = SUMMARY_KEY.exec(content);
    if (statusMatch !== null) {
      status = statusMatch[1]!.trim().toLowerCase();
      listing = false;
    } else if (artifactsMatch !== null) {
      artifacts.push(...artifactsMatch[1]!.split(","));
      listing = true;
    } else if (bullet && listing) {
      artifacts.push(content);
    } else {
      summary.push(summaryMatch === null ? content : summaryMatch[1]!);
      listing = false;
    }
  }
  if (status === undefined || !STATUSES.has(status)) return undefined;
  const kept = [...new Set(artifacts.map((item) => item.trim()).filter((item) => item.length > 0 && item.length <= 1024))];
  return {
    status: status as AssignmentResult["status"],
    summary: summary.join(" ").trim().slice(0, 4096),
    artifacts: kept.slice(0, 32),
  };
}

export interface AssignmentFacts {
  deadlineAt: number;
  acknowledgedOutcome?: "completed" | "failed";
  cancelledBy?: "leader" | "user";
  failure?: string;
  /** The parsed `Result:` status, which decides how an unacknowledged window closes. */
  resultStatus?: AssignmentResult["status"];
  /** The state recorded when a party was deleted and its Task went with it. */
  frozenState?: AssignmentState;
  /** Absent only when the Task itself is gone. */
  taskState?: TaskState;
  /** When the Task last changed state; for a completed Task, when it completed. */
  taskAt?: number;
}

const TERMINAL_TASK = new Set<TaskState>(["completed", "failed", "cancelled"]);

/** First match wins. Cancellation is reported only once the Task has settled, so a read never
 * claims a cancel that the assignee has not yet honoured; a deadline, by contrast, is the
 * assignment's own promise, and a read never shows a live state past it. */
export function deriveAssignmentState(facts: AssignmentFacts, now: number): AssignmentState {
  if (facts.acknowledgedOutcome !== undefined) return facts.acknowledgedOutcome;
  if (facts.frozenState !== undefined) return facts.frozenState;
  const task = facts.taskState;
  // Work that was delivered stays deliverable: a cancel that lost the race to the reply is moot,
  // and the leader can still acknowledge it. A window that closes unacknowledged closes on what
  // the assignee said, so a `blocked` result is not quietly counted as done.
  if (task === "completed" && facts.failure === undefined) {
    if (now - (facts.taskAt ?? now) < ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS) return "verifying";
    return facts.resultStatus === "blocked" ? "failed" : "completed";
  }
  if (task === undefined || TERMINAL_TASK.has(task)) {
    if (facts.cancelledBy !== undefined) return "cancelled";
    if (facts.failure !== undefined) return "failed";
    if (task === "cancelled") return "cancelled";
    if (task === "failed") return "failed";
    return now >= facts.deadlineAt ? "failed" : "queued";
  }
  if (facts.failure !== undefined || now >= facts.deadlineAt) return "failed";
  // A Task that is still proving its own work (children, artifacts) has not handed anything back.
  if (task === "verifying") return "running";
  if (task === "waiting_for_device") return "blocked";
  return task;
}

export function refusalMessage(reason: AssignmentRefusal, detail: { leader: string; assignee: string }): string {
  switch (reason) {
    case "not_leader": return `${detail.leader} is not a leader`;
    case "not_a_report": return `${detail.assignee} is not on ${detail.leader}'s team`;
    case "assignee_busy": return `${detail.assignee} already has an open assignment`;
    case "assignee_unavailable": return `${detail.assignee} is not attached to this gateway`;
    case "leader_task_cap": return `${detail.leader} already has ${ASSIGNMENT_MAX_OPEN_PER_LEADER} open assignments`;
    case "not_verifying": return `the assignment for ${detail.assignee} is not waiting on ${detail.leader}'s acknowledgement`;
  }
}

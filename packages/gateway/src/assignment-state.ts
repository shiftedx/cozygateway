import type { AssignmentResult, AssignmentState, TaskState } from "cozygateway-contract";

/** agent-inbox 1. How an assignment's state is derived from its wrapped Task plus its own facts.
 * Pure, and next to Storage because Storage uses it to freeze a deleted assignee's rows; the
 * hermes-bridge orchestrator reads it through `assignment-protocol.ts`. `now` is a parameter. */

export const ASSIGNMENT_VERIFYING_AUTO_COMPLETE_MS = 24 * 60 * 60_000;
export const ASSIGNMENT_OPEN_STATES: ReadonlySet<AssignmentState> = new Set<AssignmentState>([
  "queued", "running", "waiting_for_approval", "waiting_for_user_input", "blocked", "verifying",
]);

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
    // Past the deadline is failed, always: a Task that completed only after it (before the sweep
    // could settle it) never turns a `failed` read back into `verifying`.
    if ((facts.taskAt ?? now) >= facts.deadlineAt) return "failed";
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

/** The state an assignment keeps once its deleted assignee's Task is gone: finished work keeps its
 * outcome, work still waiting on the leader closes as a lapsed window would, and open work is
 * cancelled. */
export function frozenOnDelete(state: AssignmentState, resultStatus: AssignmentResult["status"] | undefined): AssignmentState {
  if (state === "verifying") return resultStatus === "blocked" ? "failed" : "completed";
  return ASSIGNMENT_OPEN_STATES.has(state) ? "cancelled" : state;
}

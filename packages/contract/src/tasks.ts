import { type Static, Type } from "@sinclair/typebox";

const Id = Type.String({ minLength: 1, maxLength: 256 });
const At = Type.Integer({ minimum: 0 });
export const TASK_STATES = ["queued", "running", "verifying", "waiting_for_approval", "waiting_for_user_input", "waiting_for_device", "blocked", "completed", "failed", "cancelled"] as const;
export const TaskStateSchema = Type.Union(TASK_STATES.map((value) => Type.Literal(value)));
export type TaskState = Static<typeof TaskStateSchema>;
export const TASK_REASONS = [
  "task_created", "run_started", "runtime_stopped", "runtime_needs_attention", "runtime_ready", "command_discarded",
  "approval_requested", "approval_approved", "approval_denied", "approval_expired", "approval_lost",
  "clarification_requested", "clarification_answered", "clarification_expired", "clarification_lost",
  "device_requested", "device_answered", "device_refused", "device_request_expired", "device_request_lost",
  "verification_started", "verification_failed", "awaiting_children", "awaiting_artifacts", "run_completed", "terminal_proof_recorded",
  "run_failed", "run_interrupted", "run_timed_out", "effects_uncertain", "child_failed", "child_unknown", "artifact_commit_failed",
  "owner_unreachable", "owner_reattached", "auto_retry", "no_recovery_remaining", "owner_deleted",
  "cancel_requested", "pause_requested", "scope_changed", "user_paused", "user_resumed", "retry_requested", "user_cancelled",
] as const;
export const TaskReasonSchema = Type.Union(TASK_REASONS.map((value) => Type.Literal(value)));
export type TaskReason = Static<typeof TaskReasonSchema>;
export const TaskEventSchema = Type.Object({
  taskId: Id, seq: Type.Integer({ minimum: 1 }), at: At,
  from: Type.Union([Type.Null(), TaskStateSchema]), to: TaskStateSchema, reason: TaskReasonSchema,
  actor: Type.Union([Type.Literal("harness"), Type.Literal("user"), Type.Literal("gateway"), Type.Literal("device")]),
  ref: Type.Optional(Type.Object({
    kind: Type.Union(["run", "toolCall", "approval", "clarification", "deviceRequest", "artifact", "child", "intentRevision", "turn"].map((value) => Type.Literal(value))),
    id: Id,
  })),
});
export type TaskEvent = Static<typeof TaskEventSchema>;
export const TaskIntentRevisionSchema = Type.Object({
  revision: Type.Integer({ minimum: 1 }), goal: Type.String({ minLength: 1, maxLength: 65536 }), at: At,
});
export type TaskIntentRevision = Static<typeof TaskIntentRevisionSchema>;
export const TaskWaitingOnSchema = Type.Object({
  kind: Type.Union([Type.Literal("approval"), Type.Literal("clarification"), Type.Literal("device")]),
  id: Id, expiresAt: At,
});
export type TaskWaitingOn = Static<typeof TaskWaitingOnSchema>;
export const TaskRunSchema = Type.Object({
  runId: Id, intentRevision: Type.Integer({ minimum: 1 }), predecessorRunId: Type.Optional(Id),
  profileRevision: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type TaskRun = Static<typeof TaskRunSchema>;
export const TaskViewSchema = Type.Object({
  taskId: Id, bot: Id, sessionId: Id, room: Type.Optional(Id), originatingTurnId: Id, originatingMessageId: Id,
  goal: Type.String({ minLength: 1, maxLength: 65536 }), intentRevision: Type.Integer({ minimum: 1 }),
  state: TaskStateSchema, at: At, lastEvent: TaskEventSchema, canProceedAlone: Type.Boolean(),
  currentRun: TaskRunSchema,
  pendingIntent: Type.Optional(Type.Object({ command: Type.Union([Type.Literal("cancel"), Type.Literal("pause"), Type.Literal("retry")]), idempotencyKey: Id })),
  waitingOn: Type.Optional(TaskWaitingOnSchema),
  automaticRetryCount: Type.Integer({ minimum: 0 }), automaticRetryBudget: Type.Integer({ minimum: 0 }),
  children: Type.Array(Type.Object({ batchId: Id, childId: Id, status: Type.Union(["queued", "starting", "running", "stalling", "succeeded", "failed", "interrupted", "stalled", "unknown"].map((value) => Type.Literal(value))) })),
  artifacts: Type.Array(Type.Object({ artifactId: Id })),
  notification: Type.Optional(Type.Object({ taskId: Id, createdAt: At })),
});
export type TaskView = Static<typeof TaskViewSchema>;
export const TaskReadSchema = Type.Object({ view: TaskViewSchema, events: Type.Array(TaskEventSchema), nextCursor: Type.Optional(Type.Integer({ minimum: 1 })) });
export const TaskListSchema = Type.Object({ tasks: Type.Array(TaskViewSchema) });
export const TaskCommandSchema = Type.Object({ idempotencyKey: Id });
export const TaskScopeCommandSchema = Type.Object({ idempotencyKey: Id, goal: Type.String({ minLength: 1, maxLength: 65536 }) });
export const TaskUpdatedFrameSchema = Type.Object({ type: Type.Literal("bot_task_updated"), event: TaskEventSchema, view: TaskViewSchema });

export const TaskConflictSchema = Type.Object({
  error: Type.Object({ code: Type.Literal("conflict"), message: Type.String() }),
  state: TaskStateSchema, view: TaskViewSchema,
});

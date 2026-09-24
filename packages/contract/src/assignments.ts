import { type Static, Type } from "@sinclair/typebox";

import { BotGroupMessageSchema } from "./ext-bots.ts";

/** Capability `com.cozylabs.agent-inbox` 1: leader assignments. An assignment wraps one
 * capability-64 Task and is addressed by that Task's own id, so one `taskId` names the work in
 * every route, tool, frame and screen. Its `state` is derived from the Task plus the assignment's
 * own facts (deadline, failure, cancel, acknowledgement); it is never written. */

const Id = Type.String({ minLength: 1, maxLength: 256 });
const At = Type.Integer({ minimum: 0 });
const Name = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });

export const ASSIGNMENT_STATES = [
  "queued", "running", "waiting_for_approval", "waiting_for_user_input", "blocked", "verifying",
  "completed", "failed", "cancelled",
] as const;
export const AssignmentStateSchema = Type.Union(ASSIGNMENT_STATES.map((value) => Type.Literal(value)));
export type AssignmentState = Static<typeof AssignmentStateSchema>;

/** Closed. A refused assign or acknowledge answers `409` with one of these as `reason`. */
export const ASSIGNMENT_REFUSALS = [
  "not_leader", "not_a_report", "assignee_busy", "assignee_unavailable", "leader_task_cap", "not_verifying",
] as const;
export const AssignmentRefusalSchema = Type.Union(ASSIGNMENT_REFUSALS.map((value) => Type.Literal(value)));
export type AssignmentRefusal = Static<typeof AssignmentRefusalSchema>;

/** `POST /bots/:name/assignments`, authenticated by `:name`'s own attach bearer. `idempotencyKey`
 * is scoped to the leader: a repeated delivery with the same key answers the same Task. */
export const AssignmentCreateRequestSchema = Type.Object({
  to: Name,
  brief: Type.String({ minLength: 1, maxLength: 8192, pattern: "\\S" }),
  doneCriteria: Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" }),
  outputFormat: Type.Optional(Type.String({ maxLength: 2048 })),
  /** Default 30 minutes; 1 minute to 4 hours. It is the assignee turn's own timeout. */
  deadlineMs: Type.Optional(Type.Integer({ minimum: 60_000, maximum: 14_400_000 })),
  idempotencyKey: Type.Optional(Id),
}, { additionalProperties: false });
export type AssignmentCreateRequest = Static<typeof AssignmentCreateRequestSchema>;

/** The assignee's closing `Result:` block, parsed. Absent from a view when the reply had none:
 * the gateway records that absence and never invents a result. */
export const AssignmentResultSchema = Type.Object({
  status: Type.Union([Type.Literal("done"), Type.Literal("partial"), Type.Literal("blocked")]),
  summary: Type.String({ maxLength: 4096 }),
  artifacts: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 32 }),
});
export type AssignmentResult = Static<typeof AssignmentResultSchema>;

export const AssignmentViewSchema = Type.Object({
  /** The wrapped Task's id, readable at `GET /tasks/:taskId` too. */
  taskId: Id,
  leader: Name,
  assignee: Name,
  brief: Type.String({ minLength: 1, maxLength: 8192 }),
  doneCriteria: Type.String({ minLength: 1, maxLength: 4096 }),
  outputFormat: Type.Optional(Type.String({ maxLength: 2048 })),
  deadlineAt: At,
  createdAt: At,
  updatedAt: At,
  state: AssignmentStateSchema,
  /** The gateway-owned attach thread, `assignment:<taskId>`, and the inbox thread id. */
  threadId: Id,
  result: Type.Optional(AssignmentResultSchema),
  finalText: Type.Optional(Type.String({ maxLength: 65536 })),
  /** `deadline`, or the assignee turn's own failure text. */
  failure: Type.Optional(Type.String({ maxLength: 1024 })),
  /** Who asked for cancellation. `state` says `cancelled` only once the Task has settled. */
  cancelledBy: Type.Optional(Type.Union([Type.Literal("leader"), Type.Literal("user")])),
  acknowledgedAt: Type.Optional(At),
});
export type AssignmentView = Static<typeof AssignmentViewSchema>;

export const AssignmentListSchema = Type.Object({ assignments: Type.Array(AssignmentViewSchema) });
export type AssignmentList = Static<typeof AssignmentListSchema>;

export const AssignmentRefusalBodySchema = Type.Object({
  error: Type.Object({ code: Type.Literal("assignment_refused"), message: Type.String() }),
  reason: AssignmentRefusalSchema,
});
export type AssignmentRefusalBody = Static<typeof AssignmentRefusalBodySchema>;

/** `POST /assignments/:taskId/acknowledge`. Valid only from `verifying`. */
export const AssignmentAcknowledgeRequestSchema = Type.Object({
  outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
}, { additionalProperties: false });
export type AssignmentAcknowledgeRequest = Static<typeof AssignmentAcknowledgeRequestSchema>;

/** `POST /assignments/:taskId/cancel`. An empty body is allowed. */
export const AssignmentCancelRequestSchema = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 1024 })),
}, { additionalProperties: false });
export type AssignmentCancelRequest = Static<typeof AssignmentCancelRequestSchema>;

/** `GET /bots/:name/inbox`: one thread per assignment the bot leads or answers. The thread carries
 * no state of its own; a client joins it to `GET /bots/:name/assignments` by `threadId`. */
export const BotInboxThreadSchema = Type.Object({
  id: Id,
  peers: Type.Array(Name, { minItems: 2, maxItems: 2 }),
  startedAt: At,
  lastActiveAt: At,
  preview: Type.String({ maxLength: 280 }),
  messageCount: Type.Integer({ minimum: 0 }),
});
export type BotInboxThread = Static<typeof BotInboxThreadSchema>;
export const BotInboxResponseSchema = Type.Object({ threads: Type.Array(BotInboxThreadSchema) });
export type BotInboxResponse = Static<typeof BotInboxResponseSchema>;
export const BotInboxMessagesResponseSchema = Type.Object({ messages: Type.Array(BotGroupMessageSchema) });
export type BotInboxMessagesResponse = Static<typeof BotInboxMessagesResponseSchema>;

/** Sent once per participant whenever an assignment's derived state may have moved. `bot`,
 * `threadId` and `updatedAt` are the fields the dormant CozyChat decoder already requires. */
export const BotInboxActivityFrameSchema = Type.Object({
  type: Type.Literal("bot_inbox_activity"),
  bot: Name,
  threadId: Id,
  updatedAt: At,
  taskId: Id,
  state: AssignmentStateSchema,
});
export type BotInboxActivityFrame = Static<typeof BotInboxActivityFrameSchema>;

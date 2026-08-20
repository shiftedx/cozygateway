import { type Static, Type } from "@sinclair/typebox";

import { RichBlockSchema } from "./rich-blocks.ts";

/** Wire error codes. Frozen list: additions are a contract minor bump; clients treat unknown
 *  codes as a generic failure. */
export const ERROR_CODES = [
  "unauthorized",
  "not_found",
  "invalid_request",
  "setup_code_invalid",
  "thread_archived",
  "backend_unavailable",
  "turn_failed",
  "interrupt_unsupported",
  "approval_not_pending",
  "approval_expired",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorBodySchema = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});
export type ErrorBody = Static<typeof ErrorBodySchema>;

export const PresenceStateSchema = Type.Union([
  Type.Literal("online"),
  Type.Literal("absent"),
  Type.Literal("unknown"),
]);
export type PresenceState = Static<typeof PresenceStateSchema>;

export const ToolCallSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  status: Type.Union([Type.Literal("running"), Type.Literal("ok"), Type.Literal("error")]),
  detail: Type.Optional(Type.String()),
});
export type ToolCall = Static<typeof ToolCallSchema>;

/** The closed vocabulary an `argSummary` value may carry: a JSON TYPE TAG, never a value.
 *  Constraining it here (rather than to a free string, as `Record<string, string>` would allow)
 *  is what makes the scope guard mechanical instead of aspirational: a producer that tries to
 *  put `"rm -rf /"` where `"string"` belongs fails validation at the wire boundary, on both
 *  ends. The vocabulary is the six JSON types, so any argument shape has an honest tag. */
export const ApprovalArgTypeTagSchema = Type.Union([
  Type.Literal("string"),
  Type.Literal("number"),
  Type.Literal("boolean"),
  Type.Literal("object"),
  Type.Literal("array"),
  Type.Literal("null"),
]);
export type ApprovalArgTypeTag = Static<typeof ApprovalArgTypeTagSchema>;

/** Argument key NAMES mapped to their type tags, e.g. `{ "command": "string" }`. The argument
 *  VALUES never cross the wire. */
export const ApprovalArgSummarySchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 128 }),
  ApprovalArgTypeTagSchema,
);
export type ApprovalArgSummary = Static<typeof ApprovalArgSummarySchema>;

/** The three terminal states of one approval. `approved` is the native per-call `once` scope
 *  (the only scope a client can express); `denied` is an explicit refusal; `expired` is the
 *  backend's own approval timeout lapsing, which is deliberately distinct from `denied` so a
 *  client can tell "nobody answered" from "somebody said no". */
export const ApprovalOutcomeSchema = Type.Union([
  Type.Literal("approved"),
  Type.Literal("denied"),
  Type.Literal("expired"),
]);
export type ApprovalOutcome = Static<typeof ApprovalOutcomeSchema>;

/** Core (non-vendor) capability id for the approval surface of section 5a: a gateway that
 *  advertises it registers the approve/deny routes and can emit the approval frames. Unlike a
 *  `com.cozylabs.*` id, this one has no reverse-DNS prefix, because the surface it names is
 *  documented in contract/v1.md itself rather than in a vendor's own docs. */
export const APPROVALS_CAPABILITY_ID = "approvals";
export const APPROVALS_CAPABILITY_VERSION = 1;

export const DeviceSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  createdAt: Type.Integer(),
  lastSeenAt: Type.Union([Type.Integer(), Type.Null()]),
});
export type Device = Static<typeof DeviceSchema>;

/** Liveness of one backend bridge behind a `GatewayInfo.capabilities` entry (issue #63): a
 *  capability id says the gateway CAN speak a protocol, never whether the link behind it is up
 *  right now, so a client that wants a true "sends will actually deliver" signal reads this
 *  instead. `online` is the only field a caller needs for a red/green check; `since` (epoch ms)
 *  and `reconnectAttempt` are diagnostic, letting an operator see how long a bridge has been down
 *  and how hard it is trying to come back without a second request. */
export const BridgeLivenessSchema = Type.Object({
  online: Type.Boolean(),
  since: Type.Integer(),
  reconnectAttempt: Type.Integer({ minimum: 0 }),
});
export type BridgeLiveness = Static<typeof BridgeLivenessSchema>;

/** `capabilities` maps a capability id to its integer version. Optional: absent on gateways
 *  that predate this field, and a receiver must tolerate both that absence and ids it does not
 *  recognize. Ids under `com.cozylabs.*` are vendor extensions, documented and versioned
 *  independently of the frozen `contract: "v1"` value; see contract/v1.md section 5.
 *
 *  `bridges` is additive and optional for the same reason: it does not replace or gate any
 *  capability entry (a capability is a shape promise, `bridges` is a liveness reading of one
 *  backend that shape happens to be backed by), so a client that does not know the field yet sees
 *  exactly the payload it always saw. Keyed by bridge name (`"hermes"` today); absent when a
 *  gateway has no bridge to report on, e.g. no `com.cozylabs.bots` configured at all. */
export const GatewayInfoSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  contract: Type.Literal("v1"),
  capabilities: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 1 }))),
  bridges: Type.Optional(Type.Record(Type.String(), BridgeLivenessSchema)),
});
export type GatewayInfo = Static<typeof GatewayInfoSchema>;

export const AgentSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  avatar: Type.Optional(Type.String()),
  backend: Type.String(),
  presence: PresenceStateSchema,
});
export type Agent = Static<typeof AgentSchema>;

export const ThreadSchema = Type.Object({
  id: Type.String(),
  agentId: Type.String(),
  title: Type.String(),
  createdAt: Type.Integer(),
  lastMessageAt: Type.Union([Type.Integer(), Type.Null()]),
});
export type Thread = Static<typeof ThreadSchema>;

export const MessageRoleSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("agent"),
  Type.Literal("system"),
]);
export type MessageRole = Static<typeof MessageRoleSchema>;

/** A committed, durable message. `seq` is per-thread, gapless, starts at 1, allocated by the
 *  gateway in commit order; clients dedupe by per-thread high-water mark. `marker` flags
 *  synthetic system messages ("turn.failed" for a turn that did not finish, "turn.interrupted"
 *  for a turn a user deliberately stopped). `delivery` is only ever set on role "user"
 *  messages: absent (or "turn") means the message started or queued its own turn; "steer" means
 *  it was delivered mid-turn into an already in-flight turn (contract v1.x additive). */
export const MessageSchema = Type.Object({
  threadId: Type.String(),
  seq: Type.Integer({ minimum: 1 }),
  role: MessageRoleSchema,
  blocks: Type.Array(RichBlockSchema),
  turnId: Type.Optional(Type.String()),
  marker: Type.Optional(
    Type.Union([Type.Literal("turn.failed"), Type.Literal("turn.interrupted")]),
  ),
  delivery: Type.Optional(Type.Union([Type.Literal("turn"), Type.Literal("steer")])),
  createdAt: Type.Integer(),
});
export type Message = Static<typeof MessageSchema>;

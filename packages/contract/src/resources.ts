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

export const DeviceSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  createdAt: Type.Integer(),
  lastSeenAt: Type.Union([Type.Integer(), Type.Null()]),
});
export type Device = Static<typeof DeviceSchema>;

/** `capabilities` maps a capability id to its integer version. Optional: absent on gateways
 *  that predate this field, and a receiver must tolerate both that absence and ids it does not
 *  recognize. Ids under `com.cozylabs.*` are vendor extensions, documented and versioned
 *  independently of the frozen `contract: "v1"` value; see contract/v1.md section 5. */
export const GatewayInfoSchema = Type.Object({
  name: Type.String(),
  version: Type.String(),
  contract: Type.Literal("v1"),
  capabilities: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 1 }))),
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

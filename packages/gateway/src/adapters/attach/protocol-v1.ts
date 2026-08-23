import { type Static, Type } from "@sinclair/typebox";
import { RichBlockSchema } from "cozygateway-contract";

/** Stable attach-v1 data-plane contract. A peer dials /attach/v1 and completes hello negotiation
 * before either side accepts application frames. */
const Id = Type.String({ minLength: 1, maxLength: 256 });
const Sequence = Type.Integer({ minimum: 0 });

export const AttachV1CapabilitySchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("media"),
  Type.Literal("tools"),
  Type.Literal("approvals"),
  Type.Literal("clarify"),
  Type.Literal("scheduled"),
  Type.Literal("mobile_node"),
]);
export type AttachV1Capability = Static<typeof AttachV1CapabilitySchema>;

export const AttachV1LimitsSchema = Type.Object({
  maxInFlightEvents: Type.Integer({ minimum: 1, maximum: 1024 }),
  maxInFlightBytes: Type.Integer({ minimum: 1024, maximum: 64 * 1024 * 1024 }),
});

export const AttachV1HelloSchema = Type.Object({
  kind: Type.Literal("hello"),
  version: Type.Literal(1),
  instanceId: Id,
  capabilities: Type.Array(AttachV1CapabilitySchema, { uniqueItems: true }),
  resume: Type.Optional(Type.Object({ eventSequence: Sequence, commandSequence: Sequence })),
  limits: Type.Optional(AttachV1LimitsSchema),
});
export type AttachV1Hello = Static<typeof AttachV1HelloSchema>;

export const AttachV1MediaDescriptorSchema = Type.Object({
  mediaId: Id,
  mimeType: Type.String({ minLength: 1, maxLength: 128 }),
  byteCount: Type.Integer({ minimum: 1 }),
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  filename: Type.String({ minLength: 1, maxLength: 512 }),
  family: Type.Union([Type.Literal("image"), Type.Literal("audio"), Type.Literal("video"), Type.Literal("file")]),
  caption: Type.Optional(Type.String({ maxLength: 4096 })),
  altText: Type.Optional(Type.String({ maxLength: 4096 })),
  expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type AttachV1MediaDescriptor = Static<typeof AttachV1MediaDescriptorSchema>;

const TurnCommand = Type.Object({
  kind: Type.Literal("turn"), threadId: Id, turnId: Id, messageId: Id, text: Type.String(),
  mediaIds: Type.Optional(Type.Array(Id, { maxItems: 16 })),
});
const SteerCommand = Type.Object({
  kind: Type.Literal("steer"), threadId: Id, turnId: Id, messageId: Id, text: Type.String(),
});
const InterruptCommand = Type.Object({ kind: Type.Literal("interrupt"), threadId: Id, turnId: Id });
const ResolveApprovalCommand = Type.Object({
  kind: Type.Literal("resolve_approval"), threadId: Id, turnId: Id, approvalId: Id,
  decision: Type.Union([Type.Literal("approve"), Type.Literal("deny")]),
});
const ResolveClarifyCommand = Type.Object({
  kind: Type.Literal("resolve_clarify"), threadId: Id, turnId: Id, clarifyId: Id, optionId: Id,
});
/** Capability-free transport tombstone. It advances the durable command sequence without
 * invoking a Hermes action when a command queued while disconnected is no longer supported by
 * the plugin that reconnects. */
const DiscardCommand = Type.Object({
  kind: Type.Literal("discard"),
  originalKind: Type.Union([
    Type.Literal("turn"), Type.Literal("steer"), Type.Literal("interrupt"),
    Type.Literal("resolve_approval"), Type.Literal("resolve_clarify"),
  ]),
  reason: Type.String({ minLength: 1, maxLength: 512 }),
});

export const AttachV1CommandSchema = Type.Union([
  TurnCommand, SteerCommand, InterruptCommand, ResolveApprovalCommand, ResolveClarifyCommand,
  DiscardCommand,
]);
export type AttachV1Command = Static<typeof AttachV1CommandSchema>;

export const AttachV1CommandFrameSchema = Type.Object({
  kind: Type.Literal("command"), sequence: Type.Integer({ minimum: 1 }), commandId: Id,
  command: AttachV1CommandSchema,
});
export type AttachV1CommandFrame = Static<typeof AttachV1CommandFrameSchema>;

const DraftEvent = Type.Object({
  kind: Type.Literal("draft"), threadId: Id, turnId: Id, blocks: Type.Array(RichBlockSchema),
  replace: Type.Optional(Type.Boolean()),
});
const CommitEvent = Type.Object({
  kind: Type.Literal("commit"), threadId: Id, turnId: Id, messageId: Id,
  blocks: Type.Array(RichBlockSchema), mediaIds: Type.Optional(Type.Array(Id, { maxItems: 16 })),
});
const FailedEvent = Type.Object({
  kind: Type.Literal("failed"), threadId: Id, turnId: Id, messageId: Id,
  message: Type.Optional(Type.String({ maxLength: 4096 })),
});
const CancelledEvent = Type.Object({ kind: Type.Literal("cancelled"), threadId: Id, turnId: Id, messageId: Id });
const InterruptedEvent = Type.Object({ kind: Type.Literal("interrupted"), threadId: Id, turnId: Id, messageId: Id });
const ToolEvent = Type.Object({
  kind: Type.Literal("tool"), threadId: Id, turnId: Id, callId: Id, name: Type.String({ minLength: 1, maxLength: 128 }),
  status: Type.Union([Type.Literal("running"), Type.Literal("ok"), Type.Literal("error")]),
  detail: Type.Optional(Type.String({ maxLength: 1024 })),
});
const ApprovalEvent = Type.Object({
  kind: Type.Literal("approval"), threadId: Id, turnId: Id, approvalId: Id, callId: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("approved"), Type.Literal("denied"), Type.Literal("expired"), Type.Literal("cancelled")]),
  expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
});
const ClarifyOption = Type.Object({ id: Id, label: Type.String({ minLength: 1, maxLength: 512 }) });
const ClarifyEvent = Type.Object({
  kind: Type.Literal("clarify"), threadId: Id, turnId: Id, clarifyId: Id,
  prompt: Type.String({ minLength: 1, maxLength: 4096 }), options: Type.Array(ClarifyOption, { minItems: 1, maxItems: 20 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("resolved"), Type.Literal("expired"), Type.Literal("cancelled")]),
  expiresAt: Type.Optional(Type.Integer({ minimum: 0 })), selectedOptionId: Type.Optional(Id),
});
const ScheduledEvent = Type.Object({
  kind: Type.Literal("scheduled"), threadId: Id, deliveryId: Id, messageId: Id,
  blocks: Type.Array(RichBlockSchema), mediaIds: Type.Optional(Type.Array(Id, { maxItems: 16 })),
});
const MediaEvent = Type.Object({ kind: Type.Literal("media"), media: AttachV1MediaDescriptorSchema });
const PresenceEvent = Type.Object({
  kind: Type.Literal("presence"), state: Type.Union([Type.Literal("online"), Type.Literal("degraded"), Type.Literal("absent")]),
});
const AttachV1MobileStatusRequestSchema = Type.Object({
  kind: Type.Literal("mobile_request"), requestId: Id, command: Type.Literal("device.status"),
  threadId: Id, turnId: Id, expiresAt: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const AttachV1MobileLocationRequestSchema = Type.Object({
  kind: Type.Literal("mobile_request"), requestId: Id, command: Type.Literal("location.current"),
  threadId: Id, turnId: Id, expiresAt: Type.Integer({ minimum: 0 }), purpose: Type.String({ minLength: 1, maxLength: 160 }),
}, { additionalProperties: false });
export const AttachV1MobileRequestSchema = Type.Union([AttachV1MobileStatusRequestSchema, AttachV1MobileLocationRequestSchema]);
export type AttachV1MobileRequest = Static<typeof AttachV1MobileRequestSchema>;
export const AttachV1MobileCancelSchema = Type.Object({ kind: Type.Literal("mobile_cancel"), requestId: Id }, { additionalProperties: false });
export type AttachV1MobileCancel = Static<typeof AttachV1MobileCancelSchema>;
export const AttachV1MobileResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("mobile_result"), requestId: Id, status: Type.Literal("ok"), result: Type.Object({ foreground: Type.Literal(true) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("mobile_result"), requestId: Id, status: Type.Literal("ok"), result: Type.Object({ latitude: Type.Number({ minimum: -90, maximum: 90 }), longitude: Type.Number({ minimum: -180, maximum: 180 }) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("mobile_result"), requestId: Id, status: Type.Union([Type.Literal("denied"), Type.Literal("expired"), Type.Literal("cancelled"), Type.Literal("device_unavailable"), Type.Literal("foreground_required"), Type.Literal("policy_blocked")]) }, { additionalProperties: false }),
]);
export type AttachV1MobileResult = Static<typeof AttachV1MobileResultSchema>;
export type AttachV1MobileResultInput =
  | { requestId: string; status: "ok"; result: { foreground: true } }
  | { requestId: string; status: "ok"; result: { latitude: number; longitude: number } }
  | { requestId: string; status: "denied" | "expired" | "cancelled" | "device_unavailable" | "foreground_required" | "policy_blocked" };

/** Deliberately closed: no thinking/reasoning/chain-of-thought event exists. */
export const AttachV1EventSchema = Type.Union([
  DraftEvent, CommitEvent, FailedEvent, CancelledEvent, InterruptedEvent, ToolEvent,
  ApprovalEvent, ClarifyEvent, ScheduledEvent, MediaEvent, PresenceEvent,
]);
export type AttachV1Event = Static<typeof AttachV1EventSchema>;

export const AttachV1EventFrameSchema = Type.Object({
  kind: Type.Literal("event"), sequence: Type.Integer({ minimum: 1 }), eventId: Id,
  event: AttachV1EventSchema,
});
export type AttachV1EventFrame = Static<typeof AttachV1EventFrameSchema>;

export const AttachV1AckSchema = Type.Object({
  kind: Type.Literal("ack"), channel: Type.Union([Type.Literal("event"), Type.Literal("command")]),
  sequence: Type.Integer({ minimum: 1 }), id: Id, duplicate: Type.Optional(Type.Boolean()),
});
export type AttachV1Ack = Static<typeof AttachV1AckSchema>;

export const AttachV1HeartbeatSchema = Type.Object({ kind: Type.Literal("heartbeat"), sentAt: Type.Integer({ minimum: 0 }) });
export const AttachV1GapSchema = Type.Object({
  kind: Type.Literal("gap"), channel: Type.Union([Type.Literal("event"), Type.Literal("command")]),
  requestedAfter: Sequence, earliestAvailable: Type.Integer({ minimum: 1 }), latestAvailable: Sequence,
});

export const AttachV1HelloAckSchema = Type.Object({
  kind: Type.Literal("hello_ack"), version: Type.Literal(1), agentId: Id,
  capabilities: Type.Array(AttachV1CapabilitySchema),
  resume: Type.Object({ eventSequence: Sequence, commandSequence: Sequence }),
  limits: AttachV1LimitsSchema,
  heartbeatIntervalMs: Type.Integer({ minimum: 1000 }),
});

export const AttachV1ClientFrameSchema = Type.Union([
  AttachV1HelloSchema,
  AttachV1EventFrameSchema,
  AttachV1AckSchema,
  AttachV1GapSchema,
  AttachV1HeartbeatSchema,
  AttachV1MobileRequestSchema,
  AttachV1MobileCancelSchema,
]);
export type AttachV1ClientFrame = Static<typeof AttachV1ClientFrameSchema>;
export const AttachV1ServerFrameSchema = Type.Union([AttachV1HelloAckSchema, AttachV1CommandFrameSchema, AttachV1AckSchema, AttachV1GapSchema, AttachV1HeartbeatSchema, AttachV1MobileResultSchema]);
export type AttachV1ServerFrame = Static<typeof AttachV1ServerFrameSchema>;

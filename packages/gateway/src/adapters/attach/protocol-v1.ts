import { type Static, Type } from "@sinclair/typebox";
import {
  RichBlockSchema, BotMemoryGraphResponseSchema, BotMemoryItemSchema, BotMemoryKindSchema,
  BotMemoryItemsResponseSchema, BotMemoryOverviewResponseSchema, BotMemoryWriteResponseSchema,
  BotMemoryDeleteResponseSchema, MobileNodeGatewayStatusResultSchema, MobileNodePurposeSchema, MobileNodeMediaDescriptorSchema,
  type MobileNodeGatewayStatusResult,
} from "cozygateway-contract";

/** Stable attach-v1 data-plane contract. A peer dials /attach/v1 and completes hello negotiation
 * before either side accepts application frames. */
const Id = Type.String({ minLength: 1, maxLength: 256 });
const Sequence = Type.Integer({ minimum: 0 });

/** The one capability set. There is no reduced legacy subset: a peer either speaks the current
 * contract or it is refused at hello. */
export const AttachV1CapabilitySchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("media"),
  Type.Literal("tools"),
  Type.Literal("approvals"),
  Type.Literal("clarify"),
  Type.Literal("scheduled"),
  Type.Literal("mobile_node"),
  Type.Literal("mobile_location"),
  Type.Literal("mobile_media"),
  Type.Literal("mobile_notifications"),
  Type.Literal("memory_management"),
  Type.Literal("delivery_receipts"),
  Type.Literal("delegation"),
  Type.Literal("thinking"),
  Type.Literal("desktop_session_resume"),
  Type.Literal("desktop_session_sync"),
]);
export type AttachV1Capability = Static<typeof AttachV1CapabilitySchema>;

export const AttachV1LimitsSchema = Type.Object({
  maxInFlightEvents: Type.Integer({ minimum: 1, maximum: 1024 }),
  maxInFlightBytes: Type.Integer({ minimum: 1024, maximum: 64 * 1024 * 1024 }),
});

/** One profile-local command the attached Hermes process can execute on its messaging surface.
 * The leading slash is kept on the wire so clients never have to guess whether a catalog entry is
 * display text or an invocation. */
export const AttachV1SlashCommandSchema = Type.Object({
  name: Type.String({ pattern: "^/[A-Za-z0-9_-]+$", minLength: 2, maxLength: 129 }),
  description: Type.String({ minLength: 1, maxLength: 200 }),
  argsHint: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
});
export type AttachV1SlashCommand = Static<typeof AttachV1SlashCommandSchema>;

const AttachV1CommandCatalogSchema = Type.Array(AttachV1SlashCommandSchema, {
  maxItems: 512,
});

/** Bounded spool counters reported only on an authenticated control frame. They intentionally
 * contain no task, event, command, profile, or instance identifier. */
export const AttachV1TelemetrySchema = Type.Object({
  eventOutboxDepth: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
  // A fresh durable spool has no oldest event. `null` means unknown, never an unbounded
  // measurement. The gateway derives ACK progress from authenticated receipt time.
  oldestEventAgeMs: Type.Union([Type.Integer({ minimum: 0, maximum: 7 * 24 * 60 * 60 * 1_000 }), Type.Null()]),
  eventAckCursor: Sequence,
  commandInboxDepth: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
}, { additionalProperties: false });
export type AttachV1Telemetry = Static<typeof AttachV1TelemetrySchema>;

/** The one hello. `version` stays a literal on the wire so a peer built against an older shape is
 * rejected out loud at the handshake instead of negotiating a quietly reduced capability set. */
export const AttachV1HelloSchema = Type.Object({
  kind: Type.Literal("hello"),
  version: Type.Literal(2),
  instanceId: Id,
  capabilities: Type.Array(AttachV1CapabilitySchema, { uniqueItems: true }),
  resume: Type.Optional(Type.Object({ eventSequence: Sequence, commandSequence: Sequence })),
  limits: Type.Optional(AttachV1LimitsSchema),
  commands: Type.Optional(AttachV1CommandCatalogSchema),
  telemetry: Type.Optional(AttachV1TelemetrySchema),
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
/** A source-qualified handoff, not a turn. The gateway-owned thread id stays the attach lane;
 * the plugin verifies and switches the profile-local raw Hermes id before acknowledging it. */
const DesktopSessionResumeCommand = Type.Object({
  kind: Type.Literal("desktop_session_resume"), threadId: Id, hermesSessionId: Id, resumeId: Id,
});
export const AttachV1MemoryRequestSchema = Type.Object({
  kind: Type.Literal("memory_request"), requestId: Id,
  operation: Type.Union([Type.Literal("overview"), Type.Literal("items"), Type.Literal("item"), Type.Literal("create"), Type.Literal("update"), Type.Literal("delete"), Type.Literal("graph")]),
  input: Type.Object({
    sourceId: Type.Optional(Id), itemId: Type.Optional(Id), q: Type.Optional(Type.String({ maxLength: 512 })), kind: Type.Optional(BotMemoryKindSchema),
    since: Type.Optional(Type.Integer({ minimum: 0 })), until: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    content: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000 })), title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), category: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 64 })), expectedRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type AttachV1MemoryRequest = Static<typeof AttachV1MemoryRequestSchema>;
/** Gateway-observed truth about ONE scheduled delivery occurrence, sent back to the plugin that
 * produced it so its own spool stops guessing. `displayed` means a paired device reported the row
 * on screen; `failed` means the occurrence is terminal in the gateway and will never be projected,
 * with `stage` saying where it died (`authorization` at inbox admission, `projection` at the
 * dead-letter barrier) and `reason` carrying the bounded gateway-side text.
 *
 * States never regress: the gateway emits at most one command per (delivery, state), keyed
 * `rcpt:<deliveryId>:<state>`, and a plugin that receives both keeps the first terminal one. */
const DeliveryReceiptCommand = Type.Object({
  kind: Type.Literal("delivery_receipt"), deliveryId: Id, messageId: Id,
  state: Type.Union([Type.Literal("displayed"), Type.Literal("failed")]),
  at: Type.Integer({ minimum: 0 }),
  stage: Type.Optional(Type.Union([Type.Literal("authorization"), Type.Literal("projection")])),
  reason: Type.Optional(Type.String({ maxLength: 256 })),
});

/** Capability-free transport tombstone. It advances the durable command sequence without
 * invoking a Hermes action when a command queued while disconnected is no longer supported by
 * the plugin that reconnects. */
const DiscardCommand = Type.Object({
  kind: Type.Literal("discard"),
  originalKind: Type.Union([
    Type.Literal("turn"), Type.Literal("steer"), Type.Literal("interrupt"),
    Type.Literal("resolve_approval"), Type.Literal("resolve_clarify"),
    Type.Literal("desktop_session_resume"), Type.Literal("delivery_receipt"),
  ]),
  reason: Type.String({ minLength: 1, maxLength: 512 }),
});

export const AttachV1CommandSchema = Type.Union([
  TurnCommand, SteerCommand, InterruptCommand, ResolveApprovalCommand, ResolveClarifyCommand,
  DesktopSessionResumeCommand, DeliveryReceiptCommand, DiscardCommand,
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
/** `mediaPositions`, when present, is aligned index-for-index with `mediaIds` and MUST have the
 * same length: entry `i` is the block index BEFORE which media `i` renders (capability 32). It is
 * all or nothing, because a partial array would silently claim index 0 for every attachment it
 * omits. A plugin that cannot say where an attachment belongs omits the field, and the gateway
 * then builds today's unpositioned attachments.
 *
 * `continues` is the plugin saying "this reply is a message, not the end of the turn". A Hermes
 * agent loop may deliver several replies before it is done, and the gateway cannot tell them apart
 * from the frame alone: every reply is a commit. The plugin can, because Hermes marks its own final
 * turn delivery (the per-turn reply anchor, and its `notify` marker). An omitted or false field is
 * the historic terminal commit, so an older plugin and an older gateway both keep today's meaning. */
const CommitEvent = Type.Object({
  kind: Type.Literal("commit"), threadId: Id, turnId: Id, messageId: Id,
  blocks: Type.Array(RichBlockSchema), mediaIds: Type.Optional(Type.Array(Id, { maxItems: 16 })),
  mediaPositions: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 4096 }), { maxItems: 16 })),
  continues: Type.Optional(Type.Boolean()),
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
/** Closed status vocabulary for one delegated child. `queued|starting|running|stalling` are
 * live; the rest are settled. `unknown` is the honest settle for work whose outcome cannot be
 * proven (a restart with the child in flight) -- never rendered as failure. */
const DelegationStatus = Type.Union([
  Type.Literal("queued"), Type.Literal("starting"), Type.Literal("running"),
  Type.Literal("stalling"), Type.Literal("succeeded"), Type.Literal("failed"),
  Type.Literal("interrupted"), Type.Literal("stalled"), Type.Literal("unknown"),
]);
/** EPHEMERAL delegation lifecycle behind the turn's live batch card. One event is one child
 * update; identity is (batchId, childId), never the tool name, so identical concurrent tools
 * cannot collide. `batchId` is the parent's own `delegate_task` tool-call id until Hermes
 * exposes its real delegation id in the lifecycle hooks (a compatibility fallback clients
 * treat as opaque). `childId` is the Hermes child session id: the one identifier present on
 * both the spawn and finish legs. Only bounded display metadata crosses this wire -- a
 * truncated label and a tool NAME; never args, results, reasoning, prompts, paths, or child
 * summaries. Like `tool`, the event is rendering state: the gateway must never let an
 * undeliverable one dead-letter the stream (issue #193/#194). */
const DelegationEvent = Type.Object({
  kind: Type.Literal("delegation"), threadId: Id, turnId: Id, batchId: Id, childId: Id,
  /** Position within the batch, from 0, stable for the child's lifetime. */
  index: Type.Integer({ minimum: 0 }),
  /** Children known to the batch so far; grows monotonically (exact once Hermes reports
   * `task_count`). */
  count: Type.Integer({ minimum: 1 }),
  label: Type.Optional(Type.String({ maxLength: 200 })),
  status: DelegationStatus,
  /** Tool NAME only. */
  currentTool: Type.Optional(Type.String({ maxLength: 128 })),
  apiCalls: Type.Optional(Type.Integer({ minimum: 0 })),
  toolCount: Type.Optional(Type.Integer({ minimum: 0 })),
  /** Structured synchronous terminal-result enrichment only. Async and older Hermes results
   * omit both fields rather than synthesizing lifecycle data that the hooks do not carry. */
  costUsd: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000_000 })),
  schemaValid: Type.Optional(Type.Boolean()),
  /** MILLISECONDS, plugin clock: when the child last showed observable activity. */
  lastActiveAt: Type.Integer({ minimum: 0 }),
  /** Canonical Hermes delegation id (`deleg_...`) for the WHOLE batch, once the plugin has
   * learned it from the structured `delegation_id` field of the parent `delegate_task`
   * result. Batch-level: identical on every child event that carries it, and typically
   * present only from the finish legs onward (async spawn legs precede the tool result).
   * It never replaces (batchId, childId) as identity -- it exists so clients can reconcile
   * the live card with Hermes's "[ASYNC DELEGATION BATCH COMPLETE - <deleg_id>]" row. */
  aliasId: Type.Optional(Id),
});
/** EPHEMERAL rolling reasoning preview behind the turn's thinking shimmer (capability
 * `thinking`). A deliberate, bounded reopening of the closed no-reasoning rule below: reasoning
 * models deliver their visible reply in one end burst, so without this the whole turn is a
 * generic spinner. One event REPLACES the previous one for its turn (latest-only; `seq` is the
 * plugin's monotonic per-turn counter, so a stale replay cannot regress the preview). `text` is
 * a sanitized tail preview, capped at 280 chars ON THE SCHEMA so the bound holds even against an
 * unsanitized peer -- never tool args or results, prompts, credentials, or file paths. Never
 * emitted after the turn's terminal, never persisted, gone on reopen. Like `draft`/`tool`, it is
 * rendering state: an undeliverable one is skipped after bounded retries, never dead-lettered. */
const ThinkingEvent = Type.Object({
  kind: Type.Literal("thinking"), threadId: Id, turnId: Id,
  text: Type.String({ maxLength: 280 }),
  /** Plugin's per-turn preview counter, from 1. Lower-or-equal = stale, dropped. */
  seq: Type.Integer({ minimum: 1 }),
  /** MILLISECONDS, plugin clock: when reasoning last streamed. */
  lastActiveAt: Type.Integer({ minimum: 0 }),
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
  mediaPositions: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 4096 }), { maxItems: 16 })),
});
/** The attach bearer already identifies the Hermes profile, so a semantic home target never
 * carries a second caller-controlled profile field. Gateway admission binds it once to the
 * selected native Bot Mode session; a retry reuses that durable binding. */
const ScheduledCanonicalHomeEvent = Type.Object({
  kind: Type.Literal("scheduled"), target: Type.Object({ kind: Type.Literal("canonical_home") }),
  deliveryId: Id, messageId: Id,
  blocks: Type.Array(RichBlockSchema), mediaIds: Type.Optional(Type.Array(Id, { maxItems: 16 })),
  mediaPositions: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 4096 }), { maxItems: 16 })),
});
const MediaEvent = Type.Object({ kind: Type.Literal("media"), media: AttachV1MediaDescriptorSchema });
const PresenceEvent = Type.Object({
  kind: Type.Literal("presence"), state: Type.Union([Type.Literal("online"), Type.Literal("degraded"), Type.Literal("absent")]),
});
/** Positive proof that the plugin switched this gateway-owned lane to the exact profile-local
 * Hermes resume target. No title, transcript, tool data, or host path crosses this receipt. */
const DesktopSessionResumedEvent = Type.Object({
  kind: Type.Literal("desktop_session_resumed"), threadId: Id, hermesSessionId: Id, resumeId: Id,
});
/** One rendered SessionDB row observed after an explicitly linked desktop-capable session. The
 * original TUI selection and current raw id are separate because compaction can resolve one raw
 * id onto another. The gateway never treats either id as its native chat identity. */
const DesktopSessionMessageEvent = Type.Union([
  Type.Object({
    kind: Type.Literal("desktop_session_message"), threadId: Id, hermesSessionId: Id,
    source: Type.Literal("cozygateway"), rowId: Id,
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    text: Type.String({ minLength: 1, maxLength: 32_000 }), at: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("desktop_session_message"), threadId: Id, hermesSessionId: Id,
    desktopSessionId: Id, source: Type.Literal("tui"), rowId: Id,
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    text: Type.String({ minLength: 1, maxLength: 32_000 }), at: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
]);
export const AttachV1MemoryResultSchema = Type.Object({
  kind: Type.Literal("memory_result"), requestId: Id,
  status: Type.Union([Type.Literal("ok"), Type.Literal("conflict"), Type.Literal("not_found"), Type.Literal("invalid_request"), Type.Literal("unavailable")]),
  result: Type.Optional(Type.Union([BotMemoryOverviewResponseSchema, BotMemoryItemsResponseSchema, BotMemoryGraphResponseSchema, BotMemoryItemSchema, BotMemoryWriteResponseSchema, BotMemoryDeleteResponseSchema])),
  message: Type.Optional(Type.String({ maxLength: 512 })), current: Type.Optional(BotMemoryItemSchema),
}, { additionalProperties: false });
export type AttachV1MemoryResult = Static<typeof AttachV1MemoryResultSchema>;
const AttachV1MobileStatusRequestSchema = Type.Object({
  kind: Type.Literal("mobile_request"), requestId: Id, command: Type.Literal("device.status"),
  threadId: Id, turnId: Id, expiresAt: Type.Integer({ minimum: 0 }), purpose: MobileNodePurposeSchema,
}, { additionalProperties: false });
const AttachV1MobileLocationRequestSchema = Type.Object({
  kind: Type.Literal("mobile_request"), requestId: Id, command: Type.Literal("location.current"),
  threadId: Id, turnId: Id, expiresAt: Type.Integer({ minimum: 0 }), purpose: MobileNodePurposeSchema,
}, { additionalProperties: false });
const AttachV1MobileCameraRequestSchema = Type.Object({ kind: Type.Literal("mobile_request"), requestId: Id, command: Type.Literal("camera.capture"), threadId: Id, turnId: Id, expiresAt: Type.Integer({ minimum: 0 }), purpose: MobileNodePurposeSchema, camera: Type.Union([Type.Literal("front"), Type.Literal("rear")]), capture: Type.Union([Type.Literal("photo"), Type.Literal("video")]), videoDurationSeconds: Type.Literal(10) }, { additionalProperties: false });
const AttachV1MobileFileRequestSchema = Type.Object({ kind: Type.Literal("mobile_request"), requestId: Id, command: Type.Literal("file.pick"), threadId: Id, turnId: Id, expiresAt: Type.Integer({ minimum: 0 }), purpose: MobileNodePurposeSchema, selection: Type.Union([Type.Literal("photo"), Type.Literal("file")]) }, { additionalProperties: false });
const AttachV1MobileNotificationRequestSchema = Type.Object({ kind: Type.Literal("mobile_request"), requestId: Id, command: Type.Literal("notification.present"), threadId: Id, turnId: Id, expiresAt: Type.Integer({ minimum: 0 }), purpose: MobileNodePurposeSchema, title: Type.String({ minLength: 1, maxLength: 80 }), body: Type.String({ minLength: 1, maxLength: 240 }) }, { additionalProperties: false });
export const AttachV1MobileRequestSchema = Type.Union([AttachV1MobileStatusRequestSchema, AttachV1MobileLocationRequestSchema, AttachV1MobileCameraRequestSchema, AttachV1MobileFileRequestSchema, AttachV1MobileNotificationRequestSchema]);
export type AttachV1MobileRequest = Static<typeof AttachV1MobileRequestSchema>;
export const AttachV1MobileCancelSchema = Type.Object({ kind: Type.Literal("mobile_cancel"), requestId: Id }, { additionalProperties: false });
export type AttachV1MobileCancel = Static<typeof AttachV1MobileCancelSchema>;
export const AttachV1MobileFailureStageSchema = Type.Union([
  Type.Literal("policy"), Type.Literal("routing"), Type.Literal("dispatch"),
  Type.Literal("response"), Type.Literal("media"), Type.Literal("receipt"),
  Type.Literal("lifecycle"),
]);
export const AttachV1MobileFailureReasonSchema = Type.Union([
  Type.Literal("no_selected_device"), Type.Literal("command_not_advertised"),
  Type.Literal("selected_socket_unavailable"), Type.Literal("frame_send_failed"),
  Type.Literal("phone_disconnected_pending"), Type.Literal("invalid_phone_payload"),
  Type.Literal("lease_mismatch"), Type.Literal("cross_device_result"),
  Type.Literal("receipt_persistence_failed"), Type.Literal("broker_closed_pending"),
  Type.Literal("malformed_request_frame"), Type.Literal("request_expired_unanswered"),
  Type.Literal("request_policy_rejected"), Type.Literal("selected_app_not_foreground"),
  Type.Literal("media_validation_failed"), Type.Literal("media_storage_failed"),
]);
const AttachV1MobileTerminalStatusSchema = Type.Union([
  Type.Literal("denied"), Type.Literal("expired"), Type.Literal("cancelled"),
  Type.Literal("device_unavailable"), Type.Literal("foreground_required"), Type.Literal("policy_blocked"),
]);
export const AttachV1MobileResultSchema = Type.Union([
  Type.Object({ kind: Type.Literal("mobile_result"), requestId: Id, status: Type.Literal("ok"), result: MobileNodeGatewayStatusResultSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("mobile_result"), requestId: Id, status: Type.Literal("ok"), result: Type.Object({ latitude: Type.Number({ minimum: -90, maximum: 90 }), longitude: Type.Number({ minimum: -180, maximum: 180 }) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("mobile_result"), requestId: Id, status: Type.Literal("ok"), result: MobileNodeMediaDescriptorSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("mobile_result"), requestId: Id, status: Type.Literal("ok"), result: Type.Object({ action: Type.Union([Type.Literal("approve"), Type.Literal("snooze"), Type.Literal("open"), Type.Literal("cancel")]) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("mobile_result"), requestId: Id, status: AttachV1MobileTerminalStatusSchema }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("mobile_result"), requestId: Id, status: AttachV1MobileTerminalStatusSchema,
    stage: AttachV1MobileFailureStageSchema, reason: AttachV1MobileFailureReasonSchema,
  }, { additionalProperties: false }),
]);
export type AttachV1MobileResult = Static<typeof AttachV1MobileResultSchema>;
export type AttachV1MobileResultInput =
  | { requestId: string; status: "ok"; result: MobileNodeGatewayStatusResult }
  | { requestId: string; status: "ok"; result: { latitude: number; longitude: number } }
  | { requestId: string; status: "ok"; result: { mediaId: string; mimeType: string; byteCount: number; sha256: string; filename: string; family: "image" | "audio" | "video" | "file" } }
  | { requestId: string; status: "ok"; result: { action: "approve" | "snooze" | "open" | "cancel" } }
  | ({ requestId: string; status: "denied" | "expired" | "cancelled" | "device_unavailable" | "foreground_required" | "policy_blocked" }
    & Partial<{ stage: Static<typeof AttachV1MobileFailureStageSchema>; reason: Static<typeof AttachV1MobileFailureReasonSchema> }>);

/** This union was deliberately closed to reasoning ("no thinking/reasoning/chain-of-thought
 * event exists"). Capability `thinking` consciously reopens it, bounded: `ThinkingEvent` is a
 * sanitized, latest-only, schema-capped 280-char preview -- not the chain of thought, not a
 * transcript, and raw reasoning still never crosses this wire. */
export const AttachV1EventSchema = Type.Union([
  DraftEvent, CommitEvent, FailedEvent, CancelledEvent, InterruptedEvent, ToolEvent, DelegationEvent,
  ThinkingEvent,
  ApprovalEvent, ClarifyEvent, ScheduledEvent, ScheduledCanonicalHomeEvent, MediaEvent, PresenceEvent,
  DesktopSessionResumedEvent, DesktopSessionMessageEvent,
]);
export type AttachV1Event = Static<typeof AttachV1EventSchema>;

export const AttachV1EventFrameSchema = Type.Object({
  kind: Type.Literal("event"), sequence: Type.Integer({ minimum: 1 }), eventId: Id,
  event: AttachV1EventSchema,
});
export type AttachV1EventFrame = Static<typeof AttachV1EventFrameSchema>;

export const AttachV1DiscardReasonSchema = Type.Union([
  Type.Literal("capability_not_negotiated"),
  Type.Literal("unauthorized_target"),
]);
export type AttachV1DiscardReason = Static<typeof AttachV1DiscardReasonSchema>;

export const AttachV1AckSchema = Type.Object({
  kind: Type.Literal("ack"), channel: Type.Union([Type.Literal("event"), Type.Literal("command")]),
  sequence: Type.Integer({ minimum: 1 }), id: Id, duplicate: Type.Optional(Type.Boolean()),
  discarded: Type.Optional(Type.Literal(true)), reason: Type.Optional(AttachV1DiscardReasonSchema),
});
export type AttachV1Ack = Static<typeof AttachV1AckSchema>;

export const AttachV1HeartbeatSchema = Type.Object({
  kind: Type.Literal("heartbeat"), sentAt: Type.Integer({ minimum: 0 }),
  telemetry: Type.Optional(AttachV1TelemetrySchema),
}, { additionalProperties: false });
export const AttachV1GapSchema = Type.Object({
  kind: Type.Literal("gap"), channel: Type.Union([Type.Literal("event"), Type.Literal("command")]),
  requestedAfter: Sequence, earliestAvailable: Type.Integer({ minimum: 1 }), latestAvailable: Sequence,
});

export const AttachV1HelloAckSchema = Type.Object({
  kind: Type.Literal("hello_ack"), version: Type.Literal(2), agentId: Id,
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
  AttachV1MemoryResultSchema,
]);
export type AttachV1ClientFrame = Static<typeof AttachV1ClientFrameSchema>;
export const AttachV1ServerFrameSchema = Type.Union([AttachV1HelloAckSchema, AttachV1CommandFrameSchema, AttachV1AckSchema, AttachV1GapSchema, AttachV1HeartbeatSchema, AttachV1MobileResultSchema, AttachV1MemoryRequestSchema]);
export type AttachV1ServerFrame = Static<typeof AttachV1ServerFrameSchema>;

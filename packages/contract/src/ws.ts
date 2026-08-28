/** One WebSocket per device carries all threads. Auth rides in the FIRST client frame, never
 *  the URL. Drafts are ephemeral full-replace frames; only `committed` carries a seq. Clients
 *  must ignore unknown server frame types (forward compatibility); the gateway answers unknown
 *  client frames with an `error` frame. */
import { type Static, Type } from "@sinclair/typebox";

import { RichBlockSchema } from "./rich-blocks.ts";
import {
  BotApprovalPendingFrameSchema,
  BotApprovalResolutionRequestedFrameSchema,
  BotApprovalResolvedFrameSchema,
  BotClarifyPendingFrameSchema,
  BotClarifyResolutionRequestedFrameSchema,
  BotClarifyResolvedFrameSchema,
  BotChatAdoptedFrameSchema,
  BotChatDeltaFrameSchema,
  BotChatFrameSchema,
  BotChatResetFrameSchema,
  BotChatStateFrameSchema,
  BotMobileReceiptFrameSchema,
  BotGroupFrameSchema,
  BotGroupStateFrameSchema,
  BotPresenceFrameSchema,
  BotRosterFrameSchema,
  BotRoutinesFrameSchema,
  BotToolActivityFrameSchema,
  BotDelegationActivityFrameSchema,
  BotThinkingActivityFrameSchema,
} from "./ext-bots.ts";
import {
  ApprovalArgSummarySchema,
  ApprovalOutcomeSchema,
  GatewayInfoSchema,
  MessageSchema,
  PresenceStateSchema,
  ToolCallSchema,
} from "./resources.ts";

export const AuthFrameSchema = Type.Object({
  type: Type.Literal("auth"),
  token: Type.String({ minLength: 1 }),
});
export type AuthFrame = Static<typeof AuthFrameSchema>;

/** threads maps threadId -> the client's high-water seq (0 = send everything). */
export const SyncFrameSchema = Type.Object({
  type: Type.Literal("sync"),
  threads: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});
export type SyncFrame = Static<typeof SyncFrameSchema>;

export const MobileNodeCommandSchema = Type.Union([
  Type.Literal("device.status"), Type.Literal("location.current"),
  Type.Literal("camera.capture"), Type.Literal("file.pick"), Type.Literal("notification.present"),
]);
const MobileNodePermissionSchema = Type.Union([
  Type.Literal("authorized"), Type.Literal("denied"),
  Type.Literal("restricted"), Type.Literal("not_determined"), Type.Literal("unavailable"),
]);
const DeviceStatusCommandCapabilitySchema = Type.Object({
  command: Type.Literal("device.status"), permission: Type.Literal("not_required"),
}, { additionalProperties: false });
const LocationCurrentCapabilitySchema = Type.Object({
  command: Type.Literal("location.current"), permission: MobileNodePermissionSchema,
}, { additionalProperties: false });
const CameraCaptureCapabilitySchema = Type.Object({ command: Type.Literal("camera.capture"), permission: MobileNodePermissionSchema }, { additionalProperties: false });
// A system picker grants only the item the person chose, and presenting a notification asks for
// nothing of its own, so neither carries a permission state the way the camera and location do.
const FilePickCapabilitySchema = Type.Object({ command: Type.Literal("file.pick"), permission: Type.Literal("not_required") }, { additionalProperties: false });
const LocalNotificationCapabilitySchema = Type.Object({ command: Type.Literal("notification.present"), permission: Type.Literal("not_required") }, { additionalProperties: false });
/** The exact command permissions the selected device can offer, in one fixed order.
 * A tuple rather than an array: every entry is named, so a duplicate, a missing command or a
 * reordering is a malformed frame rather than something a client has to defend against. */
const DeviceStatusCapabilitiesSchema = Type.Tuple([
  DeviceStatusCommandCapabilitySchema, LocationCurrentCapabilitySchema,
  CameraCaptureCapabilitySchema, FilePickCapabilitySchema, LocalNotificationCapabilitySchema,
]);
export const MobileNodePhoneStatusResultSchema = Type.Object({
  appState: Type.Union([Type.Literal("foreground"), Type.Literal("background")]),
  batteryBand: Type.Optional(Type.Union([Type.Literal("critical"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  lowPowerMode: Type.Boolean(),
  thermalState: Type.Optional(Type.Union([Type.Literal("nominal"), Type.Literal("fair"), Type.Literal("serious"), Type.Literal("critical")])),
  networkClass: Type.Optional(Type.Union([Type.Literal("wifi"), Type.Literal("cellular"), Type.Literal("none")])),
  capabilities: DeviceStatusCapabilitiesSchema,
  wakeReason: Type.Optional(Type.Union([Type.Literal("notification"), Type.Literal("notification_action"), Type.Literal("deep_link")])),
}, { additionalProperties: false });
export type MobileNodePhoneStatusResult = Static<typeof MobileNodePhoneStatusResultSchema>;
export const MobileNodeGatewayStatusResultSchema = Type.Object({
  ...MobileNodePhoneStatusResultSchema.properties,
  authenticatedReachable: Type.Literal(true),
  lastAuthenticatedPresenceAt: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type MobileNodeGatewayStatusResult = Static<typeof MobileNodeGatewayStatusResultSchema>;
export const MobileNodePurposeSchema = Type.String({
  minLength: 1,
  maxLength: 160,
  pattern: "^[^\\s\\u0000-\\u001f\\u007f-\\u009f]+(?: [^\\s\\u0000-\\u001f\\u007f-\\u009f]+)*$",
});
export const MobileNodeLeaseSchema = Type.String({
  minLength: 43,
  maxLength: 43,
  pattern: "^[A-Za-z0-9_-]{43}$",
});
const MobileNodeLocationResultSchema = Type.Object({
  // JSON Schema `multipleOf` is not stable for decimal floating-point values.
  // The broker validates the integer-cent invariant before accepting this result.
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
}, { additionalProperties: false });
export const MobileNodeMediaDescriptorSchema = Type.Object({
  mediaId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
  mimeType: Type.String({ minLength: 1, maxLength: 128 }), byteCount: Type.Integer({ minimum: 1, maximum: 40 * 1024 * 1024 }), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  filename: Type.String({ minLength: 1, maxLength: 255 }),
  family: Type.Union([Type.Literal("image"), Type.Literal("audio"), Type.Literal("video"), Type.Literal("file")]),
}, { additionalProperties: false });
const MobileNodeNotificationResultSchema = Type.Object({
  action: Type.Union([Type.Literal("approve"), Type.Literal("snooze"), Type.Literal("open"), Type.Literal("cancel")]),
}, { additionalProperties: false });

export const MobileNodeAdvertiseFrameSchema = Type.Object({
  type: Type.Literal("mobile_node_advertise"),
  commands: Type.Array(MobileNodeCommandSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
  foreground: Type.Boolean(),
}, { additionalProperties: false });
export type MobileNodeAdvertiseFrame = Static<typeof MobileNodeAdvertiseFrameSchema>;

export const MobileNodeResultFrameSchema = Type.Union([
  Type.Object({ type: Type.Literal("mobile_node_result"), requestId: Type.String({ minLength: 1, maxLength: 256 }), lease: MobileNodeLeaseSchema, status: Type.Literal("ok"), result: MobileNodePhoneStatusResultSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("mobile_node_result"), requestId: Type.String({ minLength: 1, maxLength: 256 }), lease: MobileNodeLeaseSchema, status: Type.Literal("ok"), result: MobileNodeLocationResultSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("mobile_node_result"), requestId: Type.String({ minLength: 1, maxLength: 256 }), lease: MobileNodeLeaseSchema, status: Type.Literal("ok"), result: MobileNodeNotificationResultSchema }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("mobile_node_result"), requestId: Type.String({ minLength: 1, maxLength: 256 }), lease: MobileNodeLeaseSchema, status: Type.Union([Type.Literal("denied"), Type.Literal("cancelled"), Type.Literal("expired"), Type.Literal("foreground_required")]) }, { additionalProperties: false }),
]);
export type MobileNodeResultFrame = Static<typeof MobileNodeResultFrameSchema>;

export const ClientFrameSchema = Type.Union([AuthFrameSchema, SyncFrameSchema, MobileNodeAdvertiseFrameSchema, MobileNodeResultFrameSchema]);
export type ClientFrame = Static<typeof ClientFrameSchema>;

export const ReadyFrameSchema = Type.Object({
  type: Type.Literal("ready"),
  deviceId: Type.String(),
  gateway: GatewayInfoSchema,
});
export type ReadyFrame = Static<typeof ReadyFrameSchema>;

export const SyncedFrameSchema = Type.Object({ type: Type.Literal("synced") });
export type SyncedFrame = Static<typeof SyncedFrameSchema>;

export const CommittedFrameSchema = Type.Object({
  type: Type.Literal("committed"),
  threadId: Type.String(),
  seq: Type.Integer({ minimum: 1 }),
  message: MessageSchema,
});
export type CommittedFrame = Static<typeof CommittedFrameSchema>;

export const DraftFrameSchema = Type.Object({
  type: Type.Literal("draft"),
  threadId: Type.String(),
  turnId: Type.String(),
  blocks: Type.Array(RichBlockSchema),
  toolCalls: Type.Array(ToolCallSchema),
});
export type DraftFrame = Static<typeof DraftFrameSchema>;

export const DoneFrameSchema = Type.Object({
  type: Type.Literal("done"),
  threadId: Type.String(),
  turnId: Type.String(),
});
export type DoneFrame = Static<typeof DoneFrameSchema>;

/** A tool call inside the turn is waiting on a human decision (contract v1.md section 5a). It
 *  rides the live channel like a draft: never sealed, never durable, no `seq`. `toolCallId` is
 *  the correlation id the resolve routes and the resolved frame both key on. */
export const ApprovalPendingFrameSchema = Type.Object({
  type: Type.Literal("approval_pending"),
  threadId: Type.String(),
  turnId: Type.String(),
  toolCallId: Type.String(),
  name: Type.String(),
  argSummary: Type.Optional(ApprovalArgSummarySchema),
});
export type ApprovalPendingFrame = Static<typeof ApprovalPendingFrameSchema>;

/** The pending approval reached one of its three terminal states. Exactly one of these is
 *  emitted per `toolCallId`: a later duplicate resolution is swallowed by the producer. */
export const ApprovalResolvedFrameSchema = Type.Object({
  type: Type.Literal("approval_resolved"),
  threadId: Type.String(),
  turnId: Type.String(),
  toolCallId: Type.String(),
  outcome: ApprovalOutcomeSchema,
});
export type ApprovalResolvedFrame = Static<typeof ApprovalResolvedFrameSchema>;

export const PresenceFrameSchema = Type.Object({
  type: Type.Literal("presence"),
  agentId: Type.String(),
  state: PresenceStateSchema,
});
export type PresenceFrame = Static<typeof PresenceFrameSchema>;

export const ErrorFrameSchema = Type.Object({
  type: Type.Literal("error"),
  code: Type.String(),
  message: Type.String(),
  threadId: Type.Optional(Type.String()),
});
export type ErrorFrame = Static<typeof ErrorFrameSchema>;

const MobileNodeStatusRequestFrameSchema = Type.Object({
  type: Type.Literal("mobile_node_request"), requestId: Type.String({ minLength: 1, maxLength: 256 }),
  lease: MobileNodeLeaseSchema, command: Type.Literal("device.status"), bot: Type.String({ minLength: 1, maxLength: 128 }),
  threadId: Type.String({ minLength: 1, maxLength: 256 }), turnId: Type.String({ minLength: 1, maxLength: 256 }),
  expiresAt: Type.Integer({ minimum: 0 }), purpose: MobileNodePurposeSchema,
}, { additionalProperties: false });
const MobileNodeLocationRequestFrameSchema = Type.Object({
  type: Type.Literal("mobile_node_request"), requestId: Type.String({ minLength: 1, maxLength: 256 }),
  lease: MobileNodeLeaseSchema, command: Type.Literal("location.current"), bot: Type.String({ minLength: 1, maxLength: 128 }),
  threadId: Type.String({ minLength: 1, maxLength: 256 }), turnId: Type.String({ minLength: 1, maxLength: 256 }),
  expiresAt: Type.Integer({ minimum: 0 }), purpose: MobileNodePurposeSchema,
}, { additionalProperties: false });
const MobileNodeCameraRequestFrameSchema = Type.Object({
  type: Type.Literal("mobile_node_request"), requestId: Type.String({ minLength: 1, maxLength: 256 }), lease: MobileNodeLeaseSchema,
  command: Type.Literal("camera.capture"), bot: Type.String({ minLength: 1, maxLength: 128 }), threadId: Type.String({ minLength: 1, maxLength: 256 }), turnId: Type.String({ minLength: 1, maxLength: 256 }), expiresAt: Type.Integer({ minimum: 0 }), purpose: MobileNodePurposeSchema,
  camera: Type.Union([Type.Literal("front"), Type.Literal("rear")]), capture: Type.Union([Type.Literal("photo"), Type.Literal("video")]), videoDurationSeconds: Type.Literal(10),
}, { additionalProperties: false });
const MobileNodeFileRequestFrameSchema = Type.Object({
  type: Type.Literal("mobile_node_request"), requestId: Type.String({ minLength: 1, maxLength: 256 }), lease: MobileNodeLeaseSchema,
  command: Type.Literal("file.pick"), bot: Type.String({ minLength: 1, maxLength: 128 }), threadId: Type.String({ minLength: 1, maxLength: 256 }), turnId: Type.String({ minLength: 1, maxLength: 256 }), expiresAt: Type.Integer({ minimum: 0 }), purpose: MobileNodePurposeSchema,
  selection: Type.Union([Type.Literal("photo"), Type.Literal("file")]),
}, { additionalProperties: false });
const MobileNodeNotificationRequestFrameSchema = Type.Object({
  type: Type.Literal("mobile_node_request"), requestId: Type.String({ minLength: 1, maxLength: 256 }), lease: MobileNodeLeaseSchema,
  command: Type.Literal("notification.present"), bot: Type.String({ minLength: 1, maxLength: 128 }), threadId: Type.String({ minLength: 1, maxLength: 256 }), turnId: Type.String({ minLength: 1, maxLength: 256 }), expiresAt: Type.Integer({ minimum: 0 }), purpose: MobileNodePurposeSchema,
  title: Type.String({ minLength: 1, maxLength: 80 }), body: Type.String({ minLength: 1, maxLength: 240 }),
}, { additionalProperties: false });
export const MobileNodeRequestFrameSchema = Type.Union([MobileNodeStatusRequestFrameSchema, MobileNodeLocationRequestFrameSchema, MobileNodeCameraRequestFrameSchema, MobileNodeFileRequestFrameSchema, MobileNodeNotificationRequestFrameSchema]);
export type MobileNodeRequestFrame = Static<typeof MobileNodeRequestFrameSchema>;

export const MobileNodeCancelFrameSchema = Type.Object({
  type: Type.Literal("mobile_node_cancel"), requestId: Type.String({ minLength: 1, maxLength: 256 }),
  lease: MobileNodeLeaseSchema,
  status: Type.Union([Type.Literal("cancelled"), Type.Literal("expired")]),
}, { additionalProperties: false });
export type MobileNodeCancelFrame = Static<typeof MobileNodeCancelFrameSchema>;

export const ServerFrameSchema = Type.Union([
  ReadyFrameSchema,
  SyncedFrameSchema,
  CommittedFrameSchema,
  DraftFrameSchema,
  DoneFrameSchema,
  ApprovalPendingFrameSchema,
  ApprovalResolvedFrameSchema,
  PresenceFrameSchema,
  ErrorFrameSchema,
  MobileNodeRequestFrameSchema,
  MobileNodeCancelFrameSchema,
  // Vendor extension com.cozylabs.bots v1 (contract/ext-bots-v1.md). Emitted only by a gateway
  // that advertises the capability; clients that do not know it ignore unknown frame types.
  BotRosterFrameSchema,
  BotPresenceFrameSchema,
  BotMobileReceiptFrameSchema,
  BotChatFrameSchema,
  BotChatStateFrameSchema,
  BotChatDeltaFrameSchema,
  BotChatResetFrameSchema,
  BotChatAdoptedFrameSchema,
  BotRoutinesFrameSchema,
  BotGroupFrameSchema,
  BotGroupStateFrameSchema,
  BotApprovalPendingFrameSchema,
  BotApprovalResolutionRequestedFrameSchema,
  BotApprovalResolvedFrameSchema,
  BotClarifyPendingFrameSchema,
  BotClarifyResolutionRequestedFrameSchema,
  BotClarifyResolvedFrameSchema,
  BotToolActivityFrameSchema,
  BotDelegationActivityFrameSchema,
  BotThinkingActivityFrameSchema,
]);
export type ServerFrame = Static<typeof ServerFrameSchema>;

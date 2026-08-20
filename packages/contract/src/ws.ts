/** One WebSocket per device carries all threads. Auth rides in the FIRST client frame, never
 *  the URL. Drafts are ephemeral full-replace frames; only `committed` carries a seq. Clients
 *  must ignore unknown server frame types (forward compatibility); the gateway answers unknown
 *  client frames with an `error` frame. */
import { type Static, Type } from "@sinclair/typebox";

import { RichBlockSchema } from "./rich-blocks.ts";
import {
  BotApprovalPendingFrameSchema,
  BotApprovalResolvedFrameSchema,
  BotChatAdoptedFrameSchema,
  BotChatDeltaFrameSchema,
  BotChatFrameSchema,
  BotChatResetFrameSchema,
  BotChatStateFrameSchema,
  BotGroupFrameSchema,
  BotGroupStateFrameSchema,
  BotPresenceFrameSchema,
  BotRosterFrameSchema,
  BotRoutinesFrameSchema,
  BotToolActivityFrameSchema,
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

export const ClientFrameSchema = Type.Union([AuthFrameSchema, SyncFrameSchema]);
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
  // Vendor extension com.cozylabs.bots v1 (contract/ext-bots-v1.md). Emitted only by a gateway
  // that advertises the capability; clients that do not know it ignore unknown frame types.
  BotRosterFrameSchema,
  BotPresenceFrameSchema,
  BotChatFrameSchema,
  BotChatStateFrameSchema,
  BotChatDeltaFrameSchema,
  BotChatResetFrameSchema,
  BotChatAdoptedFrameSchema,
  BotRoutinesFrameSchema,
  BotGroupFrameSchema,
  BotGroupStateFrameSchema,
  BotApprovalPendingFrameSchema,
  BotApprovalResolvedFrameSchema,
  BotToolActivityFrameSchema,
]);
export type ServerFrame = Static<typeof ServerFrameSchema>;

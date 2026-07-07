/** One WebSocket per device carries all threads. Auth rides in the FIRST client frame, never
 *  the URL. Drafts are ephemeral full-replace frames; only `committed` carries a seq. Clients
 *  must ignore unknown server frame types (forward compatibility); the gateway answers unknown
 *  client frames with an `error` frame. */
import { type Static, Type } from "@sinclair/typebox";

import { RichBlockSchema } from "./rich-blocks.ts";
import {
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
  PresenceFrameSchema,
  ErrorFrameSchema,
]);
export type ServerFrame = Static<typeof ServerFrameSchema>;

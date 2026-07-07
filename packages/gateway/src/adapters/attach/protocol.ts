import { type Static, Type } from "@sinclair/typebox";
import { RichBlockSchema, ToolCallSchema } from "cozygateway-contract";

/** Adapter-facing attach wire protocol v0 (contract/attach-v0.md). A harness-side plugin dials
 *  the gateway's /attach WebSocket and speaks this closed frame union. v0 is versioned
 *  independently of the frozen client contract v1 and may change until declared stable. Objects
 *  stay open (unknown fields ignored) but unknown update KINDS are invalid, mirroring the
 *  client contract's forward-compatibility stance. */

export const AttachDraftUpdateSchema = Type.Object({
  kind: Type.Literal("draft"),
  turnId: Type.String({ minLength: 1 }),
  blocks: Type.Array(RichBlockSchema),
  toolCalls: Type.Optional(Type.Array(ToolCallSchema)),
});
export type AttachDraftUpdate = Static<typeof AttachDraftUpdateSchema>;

export const AttachDoneUpdateSchema = Type.Object({
  kind: Type.Literal("done"),
  turnId: Type.String({ minLength: 1 }),
});
export type AttachDoneUpdate = Static<typeof AttachDoneUpdateSchema>;

export const AttachFailedUpdateSchema = Type.Object({
  kind: Type.Literal("failed"),
  turnId: Type.String({ minLength: 1 }),
  message: Type.Optional(Type.String()),
});
export type AttachFailedUpdate = Static<typeof AttachFailedUpdateSchema>;

export const AttachUpdateSchema = Type.Union([
  AttachDraftUpdateSchema,
  AttachDoneUpdateSchema,
  AttachFailedUpdateSchema,
]);
export type AttachUpdate = Static<typeof AttachUpdateSchema>;

/** Every plugin-to-gateway frame names the thread it belongs to; the agent identity comes from
 *  the authenticated connection, never from the frame. */
export const AttachInboundFrameSchema = Type.Object({
  threadId: Type.String({ minLength: 1 }),
  update: AttachUpdateSchema,
});
export type AttachInboundFrame = Static<typeof AttachInboundFrameSchema>;

/** Gateway-to-plugin: one frame kind, a content-bearing turn start. The prompt text rides the
 *  frame (push); there is no side channel to pull content from. */
export const AttachTurnFrameSchema = Type.Object({
  kind: Type.Literal("turn"),
  threadId: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
  text: Type.String(),
});
export type AttachTurnFrame = Static<typeof AttachTurnFrameSchema>;

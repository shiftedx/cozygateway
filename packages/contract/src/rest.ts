import { type Static, Type } from "@sinclair/typebox";

import { RichBlockSchema } from "./rich-blocks.ts";
import { DeviceSchema, GatewayInfoSchema, MessageSchema } from "./resources.ts";

export const PairRequestSchema = Type.Object({
  setupCode: Type.String({ minLength: 1 }),
  /** Capability 52. Absent means "device", so every client shipped before 52 is unaffected.
   *  A `runner` pair mints a per-runner token for `/runner/v1` instead of a device token, and
   *  `deviceName` carries the runner's name so the request shape stays additive. */
  kind: Type.Optional(Type.Union([Type.Literal("device"), Type.Literal("runner")])),
  /** Required for a device pair, optional for a runner pair. Validated at the route rather than
   *  here, so no existing device client's request or error changes shape. */
  deviceName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  devicePubkey: Type.Optional(Type.String()),
});
export type PairRequest = Static<typeof PairRequestSchema>;

export const PairResponseSchema = Type.Object({
  deviceToken: Type.String(),
  device: DeviceSchema,
  gateway: GatewayInfoSchema,
});
export type PairResponse = Static<typeof PairResponseSchema>;

export const CreateThreadRequestSchema = Type.Object({
  agentId: Type.String({ minLength: 1 }),
  title: Type.Optional(Type.String({ maxLength: 200 })),
});
export type CreateThreadRequest = Static<typeof CreateThreadRequestSchema>;

export const RenameThreadRequestSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
});
export type RenameThreadRequest = Static<typeof RenameThreadRequestSchema>;

/** Messages are returned in ascending seq order. */
export const ListMessagesResponseSchema = Type.Object({
  messages: Type.Array(MessageSchema),
});
export type ListMessagesResponse = Static<typeof ListMessagesResponseSchema>;

export const SendMessageRequestSchema = Type.Object({
  blocks: Type.Array(RichBlockSchema, { minItems: 1 }),
});
export type SendMessageRequest = Static<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = Type.Object({
  message: MessageSchema,
});
export type SendMessageResponse = Static<typeof SendMessageResponseSchema>;

/** pushKey is the symmetric key the gateway uses to encrypt notification payloads. The relay
 *  never sees it; it travels only device -> gateway over the paired TLS channel. */
export const PushRegisterRequestSchema = Type.Object({
  pushId: Type.String({ minLength: 1 }),
  relayUrl: Type.String({ minLength: 1 }),
  pushKey: Type.String({ minLength: 1 }),
});
export type PushRegisterRequest = Static<typeof PushRegisterRequestSchema>;

/** Response body of POST /threads/:id/interrupt when a turn was in flight and the interrupt was
 *  dispatched (HTTP 202). An idle thread returns HTTP 204 with no body instead. */
export const InterruptResponseSchema = Type.Object({
  status: Type.Literal("interrupting"),
});
export type InterruptResponse = Static<typeof InterruptResponseSchema>;

/** Response body of POST /threads/:id/approvals/:toolCallId/{approve,deny} when the decision was
 *  dispatched to the backend (HTTP 202). The terminal proof is the `approval_resolved` frame on
 *  the live channel; this body only reports which decision the gateway took. `expired` is not a
 *  legal status here: resolving an approval that already expired is an error, not a success. */
export const ApprovalResolveResponseSchema = Type.Object({
  status: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
});
export type ApprovalResolveResponse = Static<typeof ApprovalResolveResponseSchema>;

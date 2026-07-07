import { type Static, Type } from "@sinclair/typebox";

import { RichBlockSchema } from "./rich-blocks.ts";
import { DeviceSchema, GatewayInfoSchema, MessageSchema } from "./resources.ts";

export const PairRequestSchema = Type.Object({
  setupCode: Type.String({ minLength: 1 }),
  deviceName: Type.String({ minLength: 1, maxLength: 120 }),
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

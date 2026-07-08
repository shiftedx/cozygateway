import { type Static, Type } from "@sinclair/typebox";

export const RELAY_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "over_cap",
  "unsupported_platform",
  "internal",
] as const;
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

export interface RelayErrorBody {
  error: { code: RelayErrorCode; message: string };
}

export function relayError(code: RelayErrorCode, message: string): RelayErrorBody {
  return { error: { code, message } };
}

export const RegisterRequestSchema = Type.Object({
  platform: Type.Union([Type.Literal("webhook"), Type.Literal("apns")]),
  token: Type.String({ minLength: 1, maxLength: 2048 }),
});
export type RegisterRequest = Static<typeof RegisterRequestSchema>;

/** Far above any real payload; bounds abuse (design spec, section 3). */
export const CIPHERTEXT_MAX_LENGTH = 8192;

export const NotifyRequestSchema = Type.Object({
  pushId: Type.String({ minLength: 1 }),
  ciphertext: Type.String({ minLength: 1, maxLength: CIPHERTEXT_MAX_LENGTH }),
});
export type NotifyRequest = Static<typeof NotifyRequestSchema>;

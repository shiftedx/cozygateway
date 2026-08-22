import { type Static, Type } from "@sinclair/typebox";

import { COLLAPSE_ID_MAX_LENGTH, COLLAPSE_ID_PATTERN, PUSH_CATEGORY_IDS } from "./categories.ts";

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
  platform: Type.Union([Type.Literal("webhook"), Type.Literal("apns"), Type.Literal("apns-liveactivity")]),
  token: Type.String({ minLength: 1, maxLength: 2048 }),
  /** APNs device tokens are scoped to Apple's sandbox or production service. Older clients omit
   * this and retain the relay's configured APNS_ENVIRONMENT for backwards compatibility. */
  environment: Type.Optional(Type.Union([Type.Literal("development"), Type.Literal("production")])),
});
export type RegisterRequest = Static<typeof RegisterRequestSchema>;

/** Far above any real payload; bounds abuse (design spec, section 3). */
export const CIPHERTEXT_MAX_LENGTH = 8192;

/**
 * `/notify` is a CLOSED body: `additionalProperties: false`.
 *
 * This is the relay's redaction boundary (issue #19). The approval payload -- `toolCallId`,
 * `name`, the key-names-and-type-tags-only `argSummary`, the addressing ids -- is required to
 * be redacted by its producer and to travel INSIDE `ciphertext`, which the relay cannot read
 * and therefore cannot vet. What the relay CAN do is guarantee that no cleartext field
 * describing a tool call exists at this boundary at all: a caller that (buggily) tried to send
 * `argSummary`, `name`, or a `preview` in the clear is rejected with `invalid_request` and
 * nothing is delivered.
 *
 * Reject, not strip: silently dropping an unknown field would let a broken producer ship a
 * push that looks fine while quietly losing data, and would leave the leak live the day a
 * later relay version starts reading that field. A 400 reaches the gateway's error log on the
 * first call rather than the hundredth.
 */
export const NotifyRequestSchema = Type.Object(
  {
    pushId: Type.String({ minLength: 1 }),
    ciphertext: Type.Optional(Type.String({ minLength: 1, maxLength: CIPHERTEXT_MAX_LENGTH })),
    liveActivity: Type.Optional(Type.Object({
      timestamp: Type.Integer(),
      event: Type.Union([Type.Literal("update"), Type.Literal("end")]),
      contentState: Type.Object({
        phase: Type.Union([
          Type.Literal("queued"), Type.Literal("thinking"), Type.Literal("usingTools"),
          Type.Literal("writing"), Type.Literal("completed"), Type.Literal("failed"),
        ]),
        toolCallCount: Type.Integer({ minimum: 0, maximum: 10_000 }),
        shortStatus: Type.String({ minLength: 1, maxLength: 80 }),
        eventSequence: Type.Integer({ minimum: 0 }),
        elapsedSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 604_800 })),
      }),
      staleDate: Type.Optional(Type.Integer()),
      dismissalDate: Type.Optional(Type.Integer()),
      priority: Type.Union([Type.Literal(5), Type.Literal(10)]),
    })),
    /** Optional routing metadata (issue #19, section 2). Omitted = today's message push. */
    category: Type.Optional(Type.Union(PUSH_CATEGORY_IDS.map((id) => Type.Literal(id)))),
    /** Coalescing key; approvals use `toolCallId`, bot messages use a bot/chat digest. */
    collapseId: Type.Optional(
      Type.String({ minLength: 1, maxLength: COLLAPSE_ID_MAX_LENGTH, pattern: COLLAPSE_ID_PATTERN }),
    ),
  },
  { additionalProperties: false },
);
export type NotifyRequest = Static<typeof NotifyRequestSchema>;

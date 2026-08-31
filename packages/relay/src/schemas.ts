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

const PushTokenSchema = Type.String({ minLength: 1, maxLength: 2048 });
const ApnsEnvironmentSchema = Type.Union([
  Type.Literal("development"),
  Type.Literal("production"),
]);

export const RegisterRequestSchema = Type.Union([
  Type.Object(
    { platform: Type.Literal("webhook"), token: PushTokenSchema },
    { additionalProperties: false },
  ),
  Type.Object({
    platform: Type.Union([Type.Literal("apns"), Type.Literal("apns-liveactivity")]),
    token: PushTokenSchema,
    environment: ApnsEnvironmentSchema,
  }, { additionalProperties: false }),
]);
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
          Type.Literal("writing"), Type.Literal("waitingOnApproval"),
          Type.Literal("completed"), Type.Literal("failed"),
        ]),
        toolCallCount: Type.Integer({ minimum: 0, maximum: 10_000 }),
        shortStatus: Type.String({ minLength: 1, maxLength: 80 }),
        eventSequence: Type.Integer({ minimum: 0 }),
        elapsedSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 604_800 })),
        /** The approval a `waitingOnApproval` card is blocked on, so the Live Activity's Approve
         * and Deny buttons have something to resolve. Bounded here rather than waved through: it
         * is producer input that ends up verbatim in an APNs payload. */
        approvalID: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      }),
      staleDate: Type.Optional(Type.Integer()),
      dismissalDate: Type.Optional(Type.Integer()),
      alert: Type.Optional(Type.Object({
        title: Type.String({ minLength: 1, maxLength: 80 }),
        body: Type.String({ minLength: 1, maxLength: 160 }),
        sound: Type.Literal("default"),
      })),
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

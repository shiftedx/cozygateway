import { type Static, Type } from "@sinclair/typebox";

export const HARNESS_UPDATE_CAPABILITY_ID = "com.cozylabs.harness-update";
export const HARNESS_UPDATE_CAPABILITY_VERSION = 1;

export const HarnessInstallMethodSchema = Type.Union([
  Type.Literal("git"),
  Type.Literal("docker"),
  Type.Literal("nix"),
  Type.Literal("apt"),
  Type.Literal("managed"),
  Type.Literal("unknown"),
]);
export type HarnessInstallMethod = Static<typeof HarnessInstallMethodSchema>;

export const HarnessUpdateCheckSchema = Type.Object({
  harnessId: Type.String({ minLength: 1, maxLength: 128 }),
  currentVersion: Type.String({ minLength: 1, maxLength: 128 }),
  installMethod: HarnessInstallMethodSchema,
  behind: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  updateAvailable: Type.Boolean(),
  canApply: Type.Boolean(),
  guidance: Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]),
  checkedAt: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type HarnessUpdateCheck = Static<typeof HarnessUpdateCheckSchema>;

/** Optimistic concurrency is mandatory: a confirmation is valid only for the version shown. */
export const HarnessUpdateStartRequestSchema = Type.Object({
  expectedCurrentVersion: Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._+:-]*$",
  }),
}, { additionalProperties: false });
export type HarnessUpdateStartRequest = Static<typeof HarnessUpdateStartRequestSchema>;

export const HarnessUpdateStartSchema = Type.Object({
  harnessId: Type.String({ minLength: 1, maxLength: 128 }),
  state: Type.Union([Type.Literal("running"), Type.Literal("ambiguous")]),
  actionId: Type.Optional(Type.String({ pattern: "^[0-9a-f]{32}$" })),
  coalesced: Type.Boolean(),
  pollAfterMs: Type.Integer({ minimum: 250, maximum: 60_000 }),
}, { additionalProperties: false });
export type HarnessUpdateStart = Static<typeof HarnessUpdateStartSchema>;

export const HarnessUpdateReceiptSchema = Type.Object({
  outcome: Type.Union([
    Type.Literal("success"),
    Type.Literal("partial"),
    Type.Literal("failed"),
    Type.Literal("refused"),
  ]),
  startedAt: Type.Integer({ minimum: 0 }),
  finishedAt: Type.Integer({ minimum: 0 }),
  postVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
}, { additionalProperties: false });
export type HarnessUpdateReceipt = Static<typeof HarnessUpdateReceiptSchema>;

export const HarnessUpdateStatusSchema = Type.Object({
  harnessId: Type.String({ minLength: 1, maxLength: 128 }),
  state: Type.Union([
    Type.Literal("idle"),
    Type.Literal("running"),
    Type.Literal("success"),
    Type.Literal("partial"),
    Type.Literal("failed"),
    Type.Literal("unknown"),
  ]),
  actionId: Type.Optional(Type.String({ pattern: "^[0-9a-f]{32}$" })),
  receipt: Type.Optional(HarnessUpdateReceiptSchema),
  pollAfterMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 60_000 })),
  guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
}, { additionalProperties: false });
export type HarnessUpdateStatus = Static<typeof HarnessUpdateStatusSchema>;

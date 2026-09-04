import { type Static, Type } from "@sinclair/typebox";

/** Privileged, paired-device control of the process that owns CozyGateway. This deliberately
 * does not imply that every installation can update itself: restart and update are separately
 * reported so a Docker host can safely offer the former while denying the latter. */
export const GATEWAY_MAINTENANCE_CAPABILITY_ID = "com.cozylabs.gateway-maintenance";
export const GATEWAY_MAINTENANCE_CAPABILITY_VERSION = 2;

export const GatewayMaintenanceActionSchema = Type.Union([
  Type.Literal("restart"),
  Type.Literal("update"),
]);
export type GatewayMaintenanceAction = Static<typeof GatewayMaintenanceActionSchema>;

export const GatewayMaintenanceStepSchema = Type.Union([
  Type.Literal("agents"),
  Type.Literal("gateway"),
  Type.Literal("postflight"),
]);
export type GatewayMaintenanceStep = Static<typeof GatewayMaintenanceStepSchema>;

export const GatewayMaintenanceOperationStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("rolled_back"),
  Type.Literal("failed"),
]);
export type GatewayMaintenanceOperationStatus = Static<typeof GatewayMaintenanceOperationStatusSchema>;

export const GatewayMaintenanceNextActionSchema = Type.Union([
  Type.Literal("wait"),
  Type.Literal("retry_update"),
  Type.Literal("run_repair"),
  Type.Literal("confirm_hermes_repair"),
  Type.Literal("use_hermes_repair"),
]);
export type GatewayMaintenanceNextAction = Static<typeof GatewayMaintenanceNextActionSchema>;

export const GatewayMaintenanceVersionsSchema = Type.Object({
  gateway: Type.String({ minLength: 1, maxLength: 120 }),
  cozyAgents: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, { additionalProperties: false });
export type GatewayMaintenanceVersions = Static<typeof GatewayMaintenanceVersionsSchema>;

const GatewayMaintenanceResultingVersionsSchema = Type.Object({
  gateway: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  cozyAgents: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, { additionalProperties: false });

export const GatewayMaintenanceOperationSchema = Type.Object({
  operationId: Type.String({ pattern: "^maintenance_[a-f0-9]{32}$" }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
  action: GatewayMaintenanceActionSchema,
  step: GatewayMaintenanceStepSchema,
  status: GatewayMaintenanceOperationStatusSchema,
  priorVersions: GatewayMaintenanceVersionsSchema,
  resultingVersions: GatewayMaintenanceResultingVersionsSchema,
  createdAt: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Integer({ minimum: 0 }),
  completedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  failureCode: Type.Optional(Type.String({ pattern: "^[a-z0-9_]{1,64}$" })),
  message: Type.Optional(Type.String({ maxLength: 240 })),
  nextAction: GatewayMaintenanceNextActionSchema,
}, { additionalProperties: false });
export type GatewayMaintenanceOperation = Static<typeof GatewayMaintenanceOperationSchema>;

const GatewayMaintenanceUpdateMetadata = {
  releaseNotesURL: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  checkedAt: Type.Optional(Type.Integer({ minimum: 0 })),
};
/** `latestVersion` is present only when an update is actually safe to install. Keeping these as
 * separate objects makes the contract reject the tempting but unsafe `available` + no target. */
export const GatewayMaintenanceUpdateSchema = Type.Union([
  Type.Object({
    state: Type.Literal("available"),
    latestVersion: Type.String({ minLength: 1, maxLength: 120 }),
    ...GatewayMaintenanceUpdateMetadata,
  }, { additionalProperties: false }),
  Type.Object({ state: Type.Literal("upToDate"), ...GatewayMaintenanceUpdateMetadata }, { additionalProperties: false }),
  Type.Object({ state: Type.Literal("unavailable"), ...GatewayMaintenanceUpdateMetadata }, { additionalProperties: false }),
]);
export type GatewayMaintenanceUpdate = Static<typeof GatewayMaintenanceUpdateSchema>;

export const GatewayMaintenanceStatusSchema = Type.Object({
  currentVersion: Type.String({ minLength: 1, maxLength: 120 }),
  restartSupported: Type.Boolean(),
  update: GatewayMaintenanceUpdateSchema,
  health: Type.Object({
    state: Type.Union([Type.Literal("working"), Type.Literal("updating"), Type.Literal("needs_attention")]),
    gateway: Type.Object({
      state: Type.Union([Type.Literal("working"), Type.Literal("updating"), Type.Literal("needs_attention")]),
      version: Type.String({ minLength: 1, maxLength: 120 }),
      operationId: Type.Optional(Type.String({ pattern: "^maintenance_[a-f0-9]{32}$" })),
    }, { additionalProperties: false }),
    harness: Type.Object({
      product: Type.Union([Type.Literal("hermes"), Type.Literal("cozyagents")]),
      state: Type.Union([Type.Literal("attached"), Type.Literal("needs_attention")]),
      failureCode: Type.Optional(Type.String({ pattern: "^[a-z0-9_]{1,64}$" })),
      message: Type.Optional(Type.String({ maxLength: 240 })),
      nextAction: Type.Optional(GatewayMaintenanceNextActionSchema),
    }, { additionalProperties: false }),
    cozyAgents: Type.Optional(Type.Object({
      state: Type.Union([Type.Literal("working"), Type.Literal("updating"), Type.Literal("needs_attention")]),
      version: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      failureCode: Type.Optional(Type.String({ pattern: "^[a-z0-9_]{1,64}$" })),
      message: Type.Optional(Type.String({ maxLength: 240 })),
      nextAction: Type.Optional(GatewayMaintenanceNextActionSchema),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type GatewayMaintenanceStatus = Static<typeof GatewayMaintenanceStatusSchema>;

export const GatewayMaintenanceRestartRequestSchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });
export type GatewayMaintenanceRestartRequest = Static<typeof GatewayMaintenanceRestartRequestSchema>;

export const GatewayMaintenanceUpdateRequestSchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 128 }),
  expectedCurrentVersion: Type.String({ minLength: 1, maxLength: 120 }),
  expectedTargetVersion: Type.String({ minLength: 1, maxLength: 120 }),
}, { additionalProperties: false });
export type GatewayMaintenanceUpdateRequest = Static<typeof GatewayMaintenanceUpdateRequestSchema>;

export const GatewayMaintenanceReceiptSchema = Type.Object({
  operationId: Type.String({ minLength: 1, maxLength: 160 }),
  acceptedAt: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type GatewayMaintenanceReceipt = Static<typeof GatewayMaintenanceReceiptSchema>;

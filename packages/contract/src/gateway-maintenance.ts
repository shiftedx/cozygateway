import { type Static, Type } from "@sinclair/typebox";

/** Privileged, paired-device control of the process that owns CozyGateway. This deliberately
 * does not imply that every installation can update itself: restart and update are separately
 * reported so a Docker host can safely offer the former while denying the latter. */
export const GATEWAY_MAINTENANCE_CAPABILITY_ID = "com.cozylabs.gateway-maintenance";
export const GATEWAY_MAINTENANCE_CAPABILITY_VERSION = 1;

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

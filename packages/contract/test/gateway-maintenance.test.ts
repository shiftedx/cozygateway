import { describe, expect, it } from "vitest";

import {
  ContractViolation,
  GATEWAY_MAINTENANCE_CAPABILITY_VERSION,
  GatewayMaintenanceOperationSchema,
  GatewayMaintenanceStatusSchema,
  GatewayMaintenanceUpdateRequestSchema,
  assertValid,
} from "../src/index.ts";

const operation = {
  operationId: "maintenance_0123456789abcdef0123456789abcdef",
  idempotencyKey: "phone-request-1",
  action: "update",
  step: "postflight",
  status: "succeeded",
  priorVersions: { gateway: "0.6.4", cozyAgents: "0.3.0" },
  resultingVersions: { gateway: "0.6.5", cozyAgents: "0.3.1" },
  createdAt: 100,
  updatedAt: 200,
  completedAt: 200,
  nextAction: "wait",
} as const;

describe("gateway maintenance v2 contract", () => {
  it("accepts the complete durable Gateway operation shape", () => {
    expect(GATEWAY_MAINTENANCE_CAPABILITY_VERSION).toBe(2);
    expect(assertValid(GatewayMaintenanceOperationSchema, operation)).toEqual(operation);
  });

  it.each(["command", "logs", "argv", "environment"])(
    "rejects worker commands logs and unknown fields (%s)",
    (field) => {
      expect(() => assertValid(GatewayMaintenanceOperationSchema, {
        ...operation,
        [field]: "fixture-secret",
      })).toThrow(ContractViolation);
    },
  );

  it("requires one fixed health projection rather than a component graph", () => {
    const status = {
      currentVersion: "0.6.5",
      restartSupported: true,
      update: { state: "upToDate" },
      health: {
        state: "working",
        gateway: { state: "working", version: "0.6.5" },
        harness: { product: "hermes", state: "attached" },
      },
    } as const;
    expect(assertValid(GatewayMaintenanceStatusSchema, status)).toEqual(status);
    expect(() => assertValid(GatewayMaintenanceStatusSchema, {
      ...status,
      health: { ...status.health, components: [] },
    })).toThrow(ContractViolation);
  });

  it("keeps requestId as the POST idempotency key", () => {
    expect(assertValid(GatewayMaintenanceUpdateRequestSchema, {
      requestId: "existing-client-key",
      expectedCurrentVersion: "0.6.4",
      expectedTargetVersion: "0.6.5",
    }).requestId).toBe("existing-client-key");
  });
});

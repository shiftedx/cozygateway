import { describe, expect, it } from "vitest";
import {
  ARTIFACT_DELIVERY_STATES,
  ARTIFACT_MARKS,
  ARTIFACT_ORIGINS,
  ARTIFACT_STATES,
  ARTIFACT_VALIDATIONS,
  ArtifactSchema,
  ArtifactDeliverySchema,
  BOTS_CAPABILITY_VERSION,
  check,
} from "../src/index.ts";

describe("capability 65 Artifact schemas", () => {
  it("closes the Artifact, mark, validation and delivery vocabularies", () => {
    expect([...ARTIFACT_STATES]).toEqual(["declared", "committed", "commit_failed", "deleted"]);
    expect([...ARTIFACT_MARKS]).toEqual(["draft", "review_copy", "final"]);
    expect([...ARTIFACT_VALIDATIONS]).toEqual(["unvalidated", "verified", "mismatch"]);
    expect([...ARTIFACT_DELIVERY_STATES]).toEqual(["queued", "delivered", "acknowledged", "failed"]);
    expect(BOTS_CAPABILITY_VERSION).toBe(67);
  });

  it("requires provenance, byte evidence and a closed state on every record", () => {
    const record = {
      artifactId: "artifact-1", bot: "sage", sessionId: "session-1", createdBy: "sage",
      taskId: "task-1", runId: "run-1", filename: "report.pdf", mediaType: "application/pdf",
      sizeBytes: 9, sha256: "a".repeat(64), state: "committed", mark: "final",
      validation: "verified", version: 1, createdAt: 10, committedAt: 20,
      location: "/artifacts/artifact-1/content",
    };
    expect(check(ArtifactSchema, record)).toBe(true);
    expect(check(ArtifactSchema, { ...record, state: "published" })).toBe(false);
    expect(check(ArtifactSchema, { ...record, sha256: "short" })).toBe(false);
    const { sizeBytes: _sizeBytes, ...withoutSize } = record;
    expect(check(ArtifactSchema, withoutSize)).toBe(false);
  });

  it("carries a closed origin and a derived record's honestly absent fields", () => {
    expect([...ARTIFACT_ORIGINS]).toEqual(["declared", "derived"]);
    const declared = {
      artifactId: "artifact-1", bot: "sage", sessionId: "session-1", createdBy: "sage",
      filename: "report.pdf", mediaType: "application/pdf", sizeBytes: 9,
      sha256: "a".repeat(64), state: "committed", mark: "final", validation: "verified",
      version: 1, createdAt: 10,
    };
    // Additive: a record written before `origin` existed still decodes, and reads as declared.
    expect(check(ArtifactSchema, declared)).toBe(true);
    expect(check(ArtifactSchema, { ...declared, origin: "declared" })).toBe(true);
    expect(check(ArtifactSchema, { ...declared, origin: "inferred" })).toBe(false);

    // A derived record names no checksum, no mark and no Task, because none was ever declared.
    const { sha256: _sha256, mark: _mark, ...derived } = declared;
    expect(check(ArtifactSchema, { ...derived, origin: "derived", validation: "unvalidated", sourceMessageId: "message-1" })).toBe(true);
    expect(check(ArtifactSchema, { ...derived, origin: "derived", sourceMessageId: "" })).toBe(false);
  });

  it("keeps delivery a separate identity with its own state", () => {
    const delivery = { deliveryId: "delivery-1", artifactId: "artifact-1", attempt: 2, state: "acknowledged", queuedAt: 30, deliveredAt: 40, acknowledgedAt: 50 };
    expect(check(ArtifactDeliverySchema, delivery)).toBe(true);
    expect(check(ArtifactDeliverySchema, { ...delivery, state: "received" })).toBe(false);
    expect(check(ArtifactDeliverySchema, { ...delivery, attempt: 0 })).toBe(false);
  });
});

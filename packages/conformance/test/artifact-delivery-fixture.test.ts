import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_DELIVERY_STATES, ARTIFACT_MARKS, ARTIFACT_STATES, ARTIFACT_VALIDATIONS,
  ArtifactSchema, ArtifactDeclareRequestSchema, ArtifactListSchema, BOTS_CAPABILITY_VERSION,
  assertValid, check,
} from "cozygateway-contract";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/artifact-delivery-v1.json", import.meta.url), "utf8")) as
  {
    capability: number; artifact: Record<string, unknown>; derived: Record<string, unknown>;
    unstated: Record<string, unknown>; tombstone: Record<string, unknown>;
  };

/** Portable decoder evidence for row 65. Commitment authority is exercised separately through the
 * authenticated storage, route and delivery tests; this fixture proves only the wire shapes a
 * third-party client has to decode. */
describe("Artifact v1 portable client fixture", () => {
  it("pins row 65 and decodes a committed record with its delivery", () => {
    expect(fixture.capability).toBe(65);
    expect(BOTS_CAPABILITY_VERSION).toBeGreaterThanOrEqual(65);
    assertValid(ArtifactSchema, fixture.artifact);
    assertValid(ArtifactListSchema, { artifacts: [fixture.artifact, fixture.tombstone] });
  });

  it("closes every state vocabulary the client renders", () => {
    for (const state of ARTIFACT_STATES) expect(check(ArtifactSchema, { ...fixture.artifact, state })).toBe(true);
    for (const mark of ARTIFACT_MARKS) expect(check(ArtifactSchema, { ...fixture.artifact, mark })).toBe(true);
    for (const validation of ARTIFACT_VALIDATIONS) expect(check(ArtifactSchema, { ...fixture.artifact, validation })).toBe(true);
    for (const state of ARTIFACT_DELIVERY_STATES)
      expect(check(ArtifactSchema, { ...fixture.artifact, delivery: { ...(fixture.artifact.delivery as object), state } })).toBe(true);
    expect(check(ArtifactSchema, { ...fixture.artifact, state: "published" })).toBe(false);
    expect(check(ArtifactSchema, { ...fixture.artifact, mark: "shared" })).toBe(false);
    expect(check(ArtifactSchema, { ...fixture.artifact, delivery: { ...(fixture.artifact.delivery as object), state: "received" } })).toBe(false);
  });

  it("decodes a derived record and reads an absent origin as declared", () => {
    assertValid(ArtifactSchema, fixture.derived);
    assertValid(ArtifactListSchema, { artifacts: [fixture.artifact, fixture.derived] });
    expect(fixture.derived).toMatchObject({ origin: "derived", validation: "unvalidated" });
    // Derived means nothing was declared, so no checksum, mark or Task provenance is claimed.
    for (const absent of ["sha256", "mark", "taskId", "runId"]) expect(fixture.derived[absent]).toBeUndefined();
    // Additive on row 65: a record written before `origin` existed still decodes, as declared.
    const { origin: _origin, ...beforeOrigin } = fixture.artifact;
    expect(check(ArtifactSchema, beforeOrigin)).toBe(true);
    expect(check(ArtifactSchema, { ...fixture.derived, origin: "inferred" })).toBe(false);
  });

  it("decodes a declared record whose producer left the mark unstated", () => {
    assertValid(ArtifactSchema, fixture.unstated);
    assertValid(ArtifactListSchema, { artifacts: [fixture.artifact, fixture.unstated] });
    // Declared, checksummed and joined to its Task, and still saying nothing about circulation.
    expect(fixture.unstated).toMatchObject({ origin: "declared", validation: "verified", taskId: "task-1" });
    expect(fixture.unstated.mark).toBeUndefined();
    // A client renders no mark. It never reads absence as `draft`, which is a claim nobody made.
    expect(check(ArtifactSchema, { ...fixture.unstated, mark: "unstated" })).toBe(false);
    // The declaration a producer sends may omit it for the same reason.
    const declaration = {
      artifactId: "artifact-2", sessionId: "session-1", runId: "run-1", filename: "notes.txt",
      mediaType: "text/plain", sizeBytes: 5, sha256: fixture.unstated.sha256,
    };
    expect(check(ArtifactDeclareRequestSchema, declaration)).toBe(true);
    expect(check(ArtifactDeclareRequestSchema, { ...declaration, mark: "review_copy" })).toBe(true);
    expect(check(ArtifactDeclareRequestSchema, { ...declaration, mark: "shared" })).toBe(false);
  });

  it("decodes the joined and the unresolved shapes of Task provenance", () => {
    // A joined record: the producer stated the Run, and the gateway's own join named the Task.
    expect(fixture.artifact).toMatchObject({ runId: "run-1", taskId: "task-1" });
    // A Run this gateway could not map: the Run stays exactly as stated and no Task is claimed,
    // which a client must render as unknown provenance rather than as no Run.
    const { taskId: _taskId, ...unresolved } = fixture.artifact;
    expect(check(ArtifactSchema, unresolved)).toBe(true);
    // And a record that named no Run at all keeps both absent.
    const { runId: _runId, ...runless } = unresolved;
    expect(check(ArtifactSchema, runless)).toBe(true);
    // A producer declares its Run, never a Task id it has no way to know.
    expect(check(ArtifactDeclareRequestSchema, {
      artifactId: "artifact-3", sessionId: "session-1", runId: "run-1", filename: "notes.txt",
      mediaType: "text/plain", sizeBytes: 5, sha256: fixture.unstated.sha256, mark: "final",
    })).toBe(true);
  });

  it("keeps a tombstone truthful without offering deleted bytes or a host path", () => {
    expect(fixture.tombstone).toMatchObject({ state: "deleted", supersededByArtifactId: "artifact-1", version: 1 });
    expect(fixture.tombstone.location).toBeUndefined();
    expect(JSON.stringify(fixture)).not.toMatch(/\/Users\/|\/home\/|Bearer |token/i);
  });
});

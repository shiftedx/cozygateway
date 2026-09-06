import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_DELIVERY_STATES, ARTIFACT_MARKS, ARTIFACT_STATES, ARTIFACT_VALIDATIONS,
  ArtifactSchema, ArtifactListSchema, BOTS_CAPABILITY_VERSION, assertValid, check,
} from "cozygateway-contract";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/artifact-delivery-v1.json", import.meta.url), "utf8")) as
  { capability: number; artifact: Record<string, unknown>; derived: Record<string, unknown>; tombstone: Record<string, unknown> };

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

  it("keeps a tombstone truthful without offering deleted bytes or a host path", () => {
    expect(fixture.tombstone).toMatchObject({ state: "deleted", supersededByArtifactId: "artifact-1", version: 1 });
    expect(fixture.tombstone.location).toBeUndefined();
    expect(JSON.stringify(fixture)).not.toMatch(/\/Users\/|\/home\/|Bearer |token/i);
  });
});

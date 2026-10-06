import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  HARNESS_UPDATE_CAPABILITY_ID,
  HARNESS_UPDATE_CAPABILITY_VERSION,
  HarnessUpdateCheckSchema,
  HarnessUpdateStartRequestSchema,
  HarnessUpdateStartSchema,
  HarnessUpdateStatusSchema,
  assertValid,
} from "cozygateway-contract";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/harness-update-v1.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

describe("harness update v1 client fixture", () => {
  it("pins capability discovery, optimistic concurrency, and durable receipt status", () => {
    expect(fixture["capability"]).toEqual({
      id: HARNESS_UPDATE_CAPABILITY_ID,
      version: HARNESS_UPDATE_CAPABILITY_VERSION,
    });
    assertValid(HarnessUpdateCheckSchema, fixture["check"]);
    assertValid(HarnessUpdateStartRequestSchema, fixture["startRequest"]);
    assertValid(HarnessUpdateStartSchema, fixture["start"]);
    assertValid(HarnessUpdateStatusSchema, fixture["status"]);
    assertValid(HarnessUpdateStatusSchema, fixture["partialStatus"]);
    expect(fixture["partialStatus"]).not.toHaveProperty("actionId");
    expect(JSON.stringify(fixture)).not.toMatch(
      /\/Users\/|[A-Za-z]:\\|\bpid\b|\blines\b|\bargv\b|\benv(?:ironment)?\b|token|secret/i,
    );
  });
});

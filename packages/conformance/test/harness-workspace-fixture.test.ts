import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  HARNESS_WORKSPACE_CAPABILITY_ID,
  HARNESS_WORKSPACE_CAPABILITY_VERSION,
  HarnessWorkspaceListSchema,
  assertValid,
} from "cozygateway-contract";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/harness-workspace-v1.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

describe("harness workspace v1 client fixture", () => {
  it("pins capability discovery, the privacy projection, and safe partial-download metadata", () => {
    expect(fixture["capability"]).toEqual({
      id: HARNESS_WORKSPACE_CAPABILITY_ID,
      version: HARNESS_WORKSPACE_CAPABILITY_VERSION,
    });
    assertValid(HarnessWorkspaceListSchema, fixture["list"]);
    expect(JSON.stringify(fixture)).not.toMatch(/\/Users\/|[A-Za-z]:\\/);
    expect(fixture["download"]).toMatchObject({
      requestRange: "bytes=2-5",
      status: 206,
      headers: {
        "content-range": "bytes 2-5/12",
        "content-length": "4",
        "x-content-type-options": "nosniff",
      },
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  HARNESS_WORKSPACE_CAPABILITY_ID,
  HARNESS_WORKSPACE_CAPABILITY_VERSION,
  HarnessWorkspaceListSchema,
  WORKSPACE_FILE_MAX_BYTES,
  WORKSPACE_LIST_MAX_ENTRIES,
  WORKSPACE_PATH_MAX_BYTES,
  WORKSPACE_RANGE_MAX_BYTES,
  WORKSPACE_SEGMENT_MAX_BYTES,
  check,
} from "../src/index.ts";

describe("locked harness workspace contract", () => {
  it("pins capability identity and public bounds", () => {
    expect(HARNESS_WORKSPACE_CAPABILITY_ID).toBe("com.cozylabs.harness-workspace");
    expect(HARNESS_WORKSPACE_CAPABILITY_VERSION).toBe(1);
    expect(WORKSPACE_PATH_MAX_BYTES).toBe(4096);
    expect(WORKSPACE_SEGMENT_MAX_BYTES).toBe(255);
    expect(WORKSPACE_LIST_MAX_ENTRIES).toBe(1000);
    expect(WORKSPACE_FILE_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(WORKSPACE_RANGE_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it("accepts only the bounded privacy projection", () => {
    expect(check(HarnessWorkspaceListSchema, {
      path: "reports",
      parent: "",
      entries: [{
        name: "summary.pdf",
        path: "reports/summary.pdf",
        kind: "file",
        size: 12,
        modifiedAt: 1_700_000_000_000,
        mimeType: "application/pdf",
      }],
    })).toBe(true);
    expect(check(HarnessWorkspaceListSchema, {
      path: "",
      parent: null,
      root: "/srv/private",
      entries: [],
    })).toBe(false);
  });
});

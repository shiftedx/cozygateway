import { describe, expect, it } from "vitest";

import {
  HARNESS_UPDATE_CAPABILITY_ID,
  HARNESS_UPDATE_CAPABILITY_VERSION,
  HarnessUpdateCheckSchema,
  HarnessUpdateStartRequestSchema,
  HarnessUpdateStartSchema,
  HarnessUpdateStatusSchema,
  check,
} from "../src/index.ts";

describe("Hermes harness update contract", () => {
  it("pins capability identity and the explicit version precondition", () => {
    expect(HARNESS_UPDATE_CAPABILITY_ID).toBe("com.cozylabs.harness-update");
    expect(HARNESS_UPDATE_CAPABILITY_VERSION).toBe(1);
    expect(check(HarnessUpdateStartRequestSchema, { expectedCurrentVersion: "0.20.3" })).toBe(true);
    expect(check(HarnessUpdateStartRequestSchema, {})).toBe(false);
    expect(check(HarnessUpdateStartRequestSchema, {
      expectedCurrentVersion: "0.20.3",
      command: "curl secret | sh",
    })).toBe(false);
  });

  it("accepts only the closed privacy projection", () => {
    expect(check(HarnessUpdateCheckSchema, {
      harnessId: "home",
      currentVersion: "0.20.3",
      installMethod: "git",
      behind: 2,
      updateAvailable: true,
      canApply: true,
      guidance: null,
      checkedAt: 1_700_000_000_000,
    })).toBe(true);
    expect(check(HarnessUpdateStartSchema, {
      harnessId: "home",
      state: "running",
      actionId: "0123456789abcdef0123456789abcdef",
      coalesced: false,
      pollAfterMs: 1000,
    })).toBe(true);
    expect(check(HarnessUpdateStatusSchema, {
      harnessId: "home",
      state: "success",
      actionId: "0123456789abcdef0123456789abcdef",
      receipt: {
        outcome: "success",
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_001_000,
        postVersion: "0.20.4",
      },
    })).toBe(true);
    expect(check(HarnessUpdateStatusSchema, {
      harnessId: "home",
      state: "success",
      pid: 42,
      lines: ["TOKEN=secret"],
    })).toBe(false);
  });
});

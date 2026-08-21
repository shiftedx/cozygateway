import { describe, expect, it } from "vitest";

import {
  COLLAPSE_ID_MAX_LENGTH,
  PUSH_CATEGORIES,
  PUSH_CATEGORY_IDS,
  isPushCategoryId,
  isValidCollapseId,
} from "../src/categories.ts";

describe("push category registry", () => {
  it("exposes message coalescing and the approval pair", () => {
    expect(PUSH_CATEGORY_IDS).toEqual(["message", "approval.pending", "approval.resolved"]);
  });

  it("keys every spec by its own id, so a category cannot be mis-mapped", () => {
    for (const id of PUSH_CATEGORY_IDS) {
      expect(PUSH_CATEGORIES[id].id).toBe(id);
    }
  });

  it("requires a collapse id for every coalescing category", () => {
    expect(PUSH_CATEGORIES["message"].requiresCollapseId).toBe(true);
    expect(PUSH_CATEGORIES["approval.pending"].requiresCollapseId).toBe(true);
    expect(PUSH_CATEGORIES["approval.resolved"].requiresCollapseId).toBe(true);
  });

  it("ships a value-free fallback alert per category (the relay cannot read the ciphertext)", () => {
    for (const id of PUSH_CATEGORY_IDS) {
      const { alert } = PUSH_CATEGORIES[id];
      expect(alert.title.length).toBeGreaterThan(0);
      expect(alert.body.length).toBeGreaterThan(0);
    }
  });

  it("recognizes exactly the registered ids", () => {
    expect(isPushCategoryId("message")).toBe(true);
    expect(isPushCategoryId("approval.pending")).toBe(true);
    expect(isPushCategoryId("approval.granted")).toBe(false);
    expect(isPushCategoryId("")).toBe(false);
  });
});

describe("collapse id validation", () => {
  it("accepts an opaque correlation id", () => {
    expect(isValidCollapseId("toolu_01ABCdef-9.8:7")).toBe(true);
  });

  it("rejects anything that could carry a redacted-away argument value", () => {
    // The collapse id is the only caller-controlled cleartext string on /notify besides the
    // opaque ciphertext; keeping it to an id charset closes it as a smuggling channel.
    for (const bad of ["rm -rf /", 'a"b', "cat /etc/passwd", "id\nid", "a/b", "{}"]) {
      expect(isValidCollapseId(bad)).toBe(false);
    }
  });

  it("rejects an over-long id rather than truncating it (truncation could collide two approvals)", () => {
    expect(isValidCollapseId("a".repeat(COLLAPSE_ID_MAX_LENGTH))).toBe(true);
    expect(isValidCollapseId("a".repeat(COLLAPSE_ID_MAX_LENGTH + 1))).toBe(false);
    expect(isValidCollapseId("")).toBe(false);
  });

  it("bounds the id at the APNs apns-collapse-id limit of 64 bytes", () => {
    expect(COLLAPSE_ID_MAX_LENGTH).toBe(64);
  });
});

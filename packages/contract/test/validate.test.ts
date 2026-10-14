import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";

import { ContractViolation, assertValid, check } from "../src/validate.ts";

const Point = Type.Object({ x: Type.Number(), y: Type.Number() });

describe("check", () => {
  it("accepts a conforming value", () => {
    expect(check(Point, { x: 1, y: 2 })).toBe(true);
  });
  it("accepts unknown extra fields (open objects)", () => {
    expect(check(Point, { x: 1, y: 2, z: 3 })).toBe(true);
  });
  it("rejects a malformed value", () => {
    expect(check(Point, { x: 1 })).toBe(false);
  });
});

describe("assertValid", () => {
  it("returns the typed value on success", () => {
    const p = assertValid(Point, { x: 1, y: 2 });
    expect(p.x).toBe(1);
  });
  it("throws ContractViolation with a path on failure", () => {
    try {
      assertValid(Point, { x: 1, y: "nope" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ContractViolation);
      expect((err as ContractViolation).path).toBe("/y");
    }
  });
});

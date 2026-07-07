import { describe, expect, it } from "vitest";

import { CONTRACT_VERSION } from "../src/index.ts";

describe("contract package", () => {
  it("exports the frozen contract version", () => {
    expect(CONTRACT_VERSION).toBe("v1");
  });
});

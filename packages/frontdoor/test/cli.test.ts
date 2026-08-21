import { describe, expect, it } from "vitest";

import { parseFrontdoorConfig } from "../src/cli.ts";

describe("parseFrontdoorConfig", () => {
  it("applies defaults and parses the pool", () => {
    const c = parseFrontdoorConfig({ FRONTDOOR_POOL: "relay-01.cozylabs.ai, relay-02.cozylabs.ai" });
    expect(c.port).toBe(8790);
    expect(c.pool).toEqual(["relay-01.cozylabs.ai", "relay-02.cozylabs.ai"]);
    expect(c.apiHostnames).toEqual(["relay.cozylabs.ai"]);
    expect(c.maxHouseholds).toBe(500);
  });

  it("throws without a pool", () => {
    expect(() => parseFrontdoorConfig({})).toThrow(/FRONTDOOR_POOL/);
  });
});

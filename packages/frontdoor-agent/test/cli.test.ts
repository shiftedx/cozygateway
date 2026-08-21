import { describe, expect, it } from "vitest";

import { parseAgentConfig } from "../src/cli.ts";

describe("parseAgentConfig", () => {
  it("applies target defaults", () => {
    expect(parseAgentConfig({ FRONTDOOR_URL: "https://frontdoor.example", FRONTDOOR_CREDENTIAL: "fdc_test" })).toEqual({
      frontdoorUrl: "https://frontdoor.example",
      credential: "fdc_test",
      targetHost: "127.0.0.1",
      targetPort: 8099,
    });
  });

  it("throws with the missing FRONTDOOR_URL name", () => {
    expect(() => parseAgentConfig({ FRONTDOOR_CREDENTIAL: "fdc_test" })).toThrow(/FRONTDOOR_URL/);
  });

  it("throws with the missing FRONTDOOR_CREDENTIAL name", () => {
    expect(() => parseAgentConfig({ FRONTDOOR_URL: "https://frontdoor.example" })).toThrow(/FRONTDOOR_CREDENTIAL/);
  });
});

import { describe, expect, it } from "vitest";
import { OneTimeProviderHandoffs } from "../src/provider-handoffs.ts";

describe("provider credential handoff", () => {
  it("is bound to the authenticated agent and can be consumed only once", () => {
    const handoffs = new OneTimeProviderHandoffs();
    const input = { name: "Local", baseUrl: "http://localhost:1234/v1", apiKey: "private-value" };
    const id = handoffs.create("sage", input);
    expect(id).not.toContain(input.apiKey);
    expect(handoffs.consume("luna", id)).toBeUndefined();
    expect(handoffs.consume("sage", id)).toEqual(input);
    expect(handoffs.consume("sage", id)).toBeUndefined();
  });

  it("expires after 30 seconds and supports revocation on cancelled setup", () => {
    let now = 1000;
    const handoffs = new OneTimeProviderHandoffs(() => now);
    const input = { name: "Local", baseUrl: "http://localhost:1234/v1" };
    const expired = handoffs.create("sage", input);
    now += 30_000;
    expect(handoffs.consume("sage", expired)).toBeUndefined();
    const cancelled = handoffs.create("sage", input);
    handoffs.revoke(cancelled);
    expect(handoffs.consume("sage", cancelled)).toBeUndefined();
  });

  it("does not adopt later mutation of the HTTP request object", () => {
    const handoffs = new OneTimeProviderHandoffs();
    const input = { name: "Local", baseUrl: "http://localhost:1234/v1", apiKey: "original" };
    const id = handoffs.create("sage", input);
    input.apiKey = "changed";
    expect(handoffs.consume("sage", id)?.apiKey).toBe("original");
  });
});

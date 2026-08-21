import { describe, expect, it } from "vitest";

import { PerMinuteRateLimiter } from "../src/rate-limit.ts";

describe("PerMinuteRateLimiter", () => {
  it("uses a token bucket and reports whole-second retry-after values", () => {
    const limiter = new PerMinuteRateLimiter(10);
    for (let i = 0; i < 10; i += 1) expect(limiter.consume("source", 1_000).allowed).toBe(true);
    expect(limiter.consume("source", 1_000)).toEqual({ allowed: false, retryAfterSeconds: 6 });
    expect(limiter.consume("source", 6_999)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.consume("source", 7_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("keeps sources independent and lazily expires idle buckets", () => {
    const limiter = new PerMinuteRateLimiter(1);
    expect(limiter.consume("a", 0).allowed).toBe(true);
    expect(limiter.consume("a", 0).allowed).toBe(false);
    expect(limiter.consume("b", 0).allowed).toBe(true);
    expect(limiter.consume("a", 60_000).allowed).toBe(true);
  });
});

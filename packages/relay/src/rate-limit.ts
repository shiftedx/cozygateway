export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  expiresAt: number;
}

const MINUTE_MS = 60_000;

/**
 * In-memory token bucket keyed by an untrusted source identifier. Buckets expire once
 * they have been idle long enough to refill completely and are swept lazily on use.
 */
export class PerMinuteRateLimiter {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #buckets = new Map<string, Bucket>();
  #nextSweepAt = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("rate limit capacity must be a positive integer");
    this.#capacity = capacity;
    this.#refillPerMs = capacity / MINUTE_MS;
  }

  consume(key: string, now: number): RateLimitDecision {
    this.#sweep(now);
    const previous = this.#buckets.get(key);
    const elapsed = previous === undefined ? 0 : Math.max(0, now - previous.updatedAt);
    const tokens = previous === undefined
      ? this.#capacity
      : Math.min(this.#capacity, previous.tokens + elapsed * this.#refillPerMs);
    const expiresAt = now + MINUTE_MS;

    if (tokens >= 1) {
      this.#buckets.set(key, { tokens: tokens - 1, updatedAt: now, expiresAt });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    this.#buckets.set(key, { tokens, updatedAt: now, expiresAt });
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.#refillPerMs / 1000)),
    };
  }

  #sweep(now: number): void {
    if (now < this.#nextSweepAt) return;
    for (const [key, bucket] of this.#buckets) {
      if (bucket.expiresAt <= now) this.#buckets.delete(key);
    }
    this.#nextSweepAt = now + MINUTE_MS;
  }
}

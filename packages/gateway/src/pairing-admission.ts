/** `/pair` is the one unauthenticated credential-minting route. Keep its bounded admission
 *  separate from parsing and setup-code storage so a proxy header never becomes an identity seam. */
export const PAIR_REQUEST_MAX_BYTES = 4 * 1024;

const PAIR_ATTEMPT_CAPACITY = 10;
const PAIR_ATTEMPT_WINDOW_MS = 60_000;

export type PairBody =
  | { kind: "body"; value: unknown }
  | { kind: "too_large" };

export interface PairingAttemptLimiter {
  attempt(): number | undefined;
}

/** One process-wide bucket per app instance. The injected clock is the same gateway clock that
 *  timestamps setup-code use, making refill timing deterministic without exposing a public knob. */
export class PairingAdmission implements PairingAttemptLimiter {
  #tokens = PAIR_ATTEMPT_CAPACITY;
  #lastRefillAt: number | undefined;
  readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Spends an attempt or returns the whole seconds until one is available. */
  attempt(): number | undefined {
    const at = this.now();
    if (this.#lastRefillAt === undefined) {
      this.#lastRefillAt = at;
    } else if (at > this.#lastRefillAt) {
      this.#tokens = Math.min(
        PAIR_ATTEMPT_CAPACITY,
        this.#tokens + ((at - this.#lastRefillAt) * PAIR_ATTEMPT_CAPACITY) / PAIR_ATTEMPT_WINDOW_MS,
      );
      this.#lastRefillAt = at;
    }

    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return undefined;
    }

    const waitMs = ((1 - this.#tokens) * PAIR_ATTEMPT_WINDOW_MS) / PAIR_ATTEMPT_CAPACITY;
    return Math.max(1, Math.ceil(waitMs / 1_000));
  }
}

/** Reads the complete request body under the admission cap. Content-Length is only an early
 *  rejection hint: the stream remains authoritative because chunked requests can omit or lie. */
export async function readPairBody(request: Request): Promise<PairBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > PAIR_REQUEST_MAX_BYTES) {
    await request.body?.cancel().catch(() => {});
    return { kind: "too_large" };
  }

  if (request.body === null) return { kind: "body", value: undefined };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > PAIR_REQUEST_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "body", value: undefined };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { kind: "body", value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { kind: "body", value: undefined };
  }
}

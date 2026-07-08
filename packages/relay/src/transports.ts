export const DELIVERY_TIMEOUT_MS = 10_000;

/** A delivery transport. The APNs transport plugs in here in the phone-app phase without
 *  touching routes or storage (design spec, section 3). */
export interface Transport {
  deliver(token: string, ciphertext: string): Promise<void>;
}

/** Delivers by POSTing {ciphertext} to the registered URL. This is also the shape a
 *  UnifiedPush-style endpoint consumes, so a generic push server can be pointed at directly. */
export function webhookTransport(fetchImpl: typeof fetch = fetch): Transport {
  return {
    async deliver(token: string, ciphertext: string): Promise<void> {
      const res = await fetchImpl(token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ciphertext }),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`webhook delivery failed: HTTP ${res.status}`);
    },
  };
}

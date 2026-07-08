import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

import { isBlockedAddress, isBlockedLiteralHost, stripIpv6Brackets } from "./egress.ts";

export const DELIVERY_TIMEOUT_MS = 10_000;

/** A delivery transport. The APNs transport plugs in here in the phone-app phase without
 *  touching routes or storage (design spec, section 3). */
export interface Transport {
  deliver(token: string, ciphertext: string): Promise<void>;
}

/** Thrown (and surfaced as a rejected `deliver()`) when restricted-egress mode refuses
 *  to connect to a resolved address (design decision, issue #8). Handled by the caller
 *  exactly like any other failed delivery: best-effort, never blocks `/notify`. */
export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressBlockedError";
  }
}

export interface WebhookTransportOptions {
  /** Unrestricted-mode fetch implementation (default: global `fetch`). Unused when
   *  `restrictEgress` is true. */
  fetchImpl?: typeof fetch;
  /** When true, delivery resolves the webhook host exactly once and refuses to connect
   *  if the resolved address is loopback, link-local, private, or unspecified (design
   *  decision, issue #8). Default false (current, unrestricted behavior, unchanged). */
  restrictEgress?: boolean;
  /** Injectable DNS resolver seam for restricted mode, default `node:dns` `lookup`.
   *  Exists so tests can stub what a hostname resolves to without a real DNS query. */
  lookup?: LookupFunction;
}

/**
 * Wraps a `LookupFunction` so the single address it resolves is vetted against the
 * restricted ranges before being handed back to the HTTP client. The client (see
 * `deliverRestricted` below) is given this wrapper as its own `lookup` request option,
 * so it connects to exactly the address vetted here: there is no separate check-then-
 * resolve-again step, which is what makes this immune to DNS rebinding between a check
 * and a connect.
 */
export function createVettingLookup(baseLookup: LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    baseLookup(hostname, options, (err, address, family) => {
      if (err) {
        callback(err, address, family);
        return;
      }
      if (Array.isArray(address)) {
        callback(
          new EgressBlockedError(`webhook delivery refused: resolver returned multiple addresses for "${hostname}"`),
          address,
          family,
        );
        return;
      }
      const resolvedFamily = family === 6 ? 6 : 4;
      if (isBlockedAddress(address, resolvedFamily)) {
        callback(
          new EgressBlockedError(`webhook delivery refused: "${hostname}" resolved to blocked address ${address}`),
          address,
          family,
        );
        return;
      }
      callback(null, address, family);
    });
  };
}

/** Restricted-mode delivery: `node:http`/`node:https` `request` with a vetting `lookup`,
 *  keeping the URL's own hostname for the Host header and TLS servername (design
 *  decision, issue #8; the relay is dependency-free, so this is stdlib-only). */
function deliverRestricted(token: string, ciphertext: string, lookup: LookupFunction): Promise<void> {
  const url = new URL(token);
  const hostname = stripIpv6Brackets(url.hostname);
  // A literal-IP host never reaches the `lookup` option below: Node's connection layer
  // recognizes an already-valid IP address and connects directly, skipping DNS
  // resolution (and so skipping our vetting `lookup` wrapper) entirely. Vet it here
  // explicitly so a literal blocked IP cannot bypass restricted mode this way.
  if (isBlockedLiteralHost(hostname)) {
    return Promise.reject(
      new EgressBlockedError(`webhook delivery refused: "${hostname}" is a blocked literal address`),
    );
  }
  const body = JSON.stringify({ ciphertext });
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        hostname,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
        timeout: DELIVERY_TIMEOUT_MS,
        lookup: createVettingLookup(lookup),
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`webhook delivery failed: HTTP ${status}`));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("webhook delivery timed out")));
    req.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
    req.write(body);
    req.end();
  });
}

/** Delivers by POSTing {ciphertext} to the registered URL. This is also the shape a
 *  UnifiedPush-style endpoint consumes, so a generic push server can be pointed at
 *  directly. Unrestricted mode (default) is unchanged fetch-based delivery; restricted
 *  mode switches to `deliverRestricted` above. */
export function webhookTransport(options: WebhookTransportOptions = {}): Transport {
  if (options.restrictEgress === true) {
    const lookup = options.lookup ?? dnsLookup;
    return {
      deliver: (token, ciphertext) => deliverRestricted(token, ciphertext, lookup),
    };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
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

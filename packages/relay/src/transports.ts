import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

import { isBlockedAddress, isBlockedLiteralHost, stripIpv6Brackets } from "./egress.ts";

/** Vets a single resolved address. Defaults to the real `isBlockedAddress` restricted-
 *  range check. This is a narrow, test-only injection seam: production code always
 *  gets the real default (see `webhookTransport` below), and tests use it only to
 *  control the public/blocked decision for a resolved address they don't otherwise
 *  control (e.g. a local test server bound to loopback), never to weaken the default. */
export type VetAddress = (address: string, family: 4 | 6) => boolean;

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
  /** Injectable address-vetting seam for restricted mode, default the real
   *  `isBlockedAddress` restricted-range check (see `VetAddress` above). Tests use this
   *  to control the public/blocked decision for a resolver-controlled address (e.g. a
   *  local test server) without touching production defaults; leave unset in production. */
  vetAddress?: VetAddress;
}

/**
 * Wraps a `LookupFunction` so every address it resolves is vetted against the
 * restricted ranges before being handed back to the HTTP client. The client (see
 * `deliverRestricted` below) is given this wrapper as its own `lookup` request option,
 * so it connects to exactly the address (or addresses) vetted here: there is no
 * separate check-then-resolve-again step, which is what makes this immune to DNS
 * rebinding between a check and a connect.
 *
 * `http.request`/`https.request` call the `lookup` option with `{ all: true }` by
 * default (autoSelectFamily / Happy Eyeballs, on by default on modern Node), in which
 * case `address` is an array of `{address, family}` objects rather than a single
 * string. Refusing whenever an array shows up would refuse every hostname delivery
 * unconditionally (only literal-IP tokens, which skip `lookup` entirely, would ever
 * succeed) -- so both callback shapes are handled here: every address in an `all: true`
 * array is vetted, and the whole delivery is refused if *any* member is blocked (the
 * conservative reading: a mixed `localhost -> [::1, 127.0.0.1]` result must not fall
 * through on its public-looking member); otherwise the full vetted array is passed
 * through unchanged so Happy Eyeballs / family selection still works downstream. The
 * single-address shape (no `all: true`) is vetted exactly as before.
 */
export function createVettingLookup(
  baseLookup: LookupFunction,
  vetAddress: VetAddress = isBlockedAddress,
): LookupFunction {
  return (hostname, options, callback) => {
    baseLookup(hostname, options, (err, address, family) => {
      if (err) {
        callback(err, address, family);
        return;
      }
      if (Array.isArray(address)) {
        const blocked = address.find((entry: LookupAddress) =>
          vetAddress(entry.address, entry.family === 6 ? 6 : 4),
        );
        if (blocked) {
          callback(
            new EgressBlockedError(
              `webhook delivery refused: "${hostname}" resolved to blocked address ${blocked.address}`,
            ),
            address,
            family,
          );
          return;
        }
        callback(null, address, family);
        return;
      }
      const resolvedFamily = family === 6 ? 6 : 4;
      if (vetAddress(address, resolvedFamily)) {
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
function deliverRestricted(
  token: string,
  ciphertext: string,
  lookup: LookupFunction,
  vetAddress: VetAddress,
): Promise<void> {
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
        lookup: createVettingLookup(lookup, vetAddress),
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
    const vetAddress = options.vetAddress ?? isBlockedAddress;
    return {
      deliver: (token, ciphertext) => deliverRestricted(token, ciphertext, lookup, vetAddress),
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

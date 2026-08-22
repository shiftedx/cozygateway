import { randomBytes } from "node:crypto";

import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";

import { isBlockedLiteralHost, stripIpv6Brackets } from "./egress.ts";
import { PerMinuteRateLimiter } from "./rate-limit.ts";
import { NotifyRequestSchema, RegisterRequestSchema, relayError } from "./schemas.ts";
import { DEFAULT_REGISTRATION_TTL_DAYS, utcDay, type RelayStorage } from "./storage.ts";
import type { Transport } from "./transports.ts";

export interface RelayAppDeps {
  storage: RelayStorage;
  /** Keyed by platform. A platform with no transport is recognized but unavailable (501). */
  transports: Readonly<Record<string, Transport | undefined>>;
  dailyCap: number;
  /** Total-row cap on `registrations`. Bounds unauthenticated flood growth ahead of the
   *  auth-hook slot landing (design decision, issue #9). Refreshing an existing pushId
   *  never counts against it. */
  maxRegistrations: number;
  /** TTL in days for `registrations` rows, from `created_at` (issue #28). Swept lazily on
   *  /register (before the cap check, so expired rows free headroom) and /notify (before the
   *  lookup, so an expired id 404s on the request itself, the signal the gateway's own prune
   *  loop listens for). Defaults to DEFAULT_REGISTRATION_TTL_DAYS. */
  registrationTtlDays?: number;
  version: string;
  now: () => number;
  /** When true, `POST /register` rejects a webhook URL whose host is a literal IP in a
   *  restricted range (loopback, link-local, private, unspecified). A DNS-name host is
   *  not resolved here; it is vetted again at delivery time (design decision, issue #8). */
  restrictEgress: boolean;
  /** Trust the rightmost X-Forwarded-For value as the source IP. Enable only when the
   *  relay is directly behind a trusted reverse proxy. */
  trustForwarded?: boolean;
  registerRateLimitPerMinute?: number;
  notifyRateLimitPerMinute?: number;
  /** Test seam for requests not backed by a Node socket. */
  sourceIp?: (c: Context) => string;
  log?: (message: string) => void;
}

export const DEFAULT_REGISTER_RATE_LIMIT_PER_MINUTE = 10;
export const DEFAULT_NOTIFY_RATE_LIMIT_PER_MINUTE = 60;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** True when `value` is an http(s) URL whose host is a literal IP in a restricted range. */
function isBlockedWebhookUrl(value: string): boolean {
  const hostname = stripIpv6Brackets(new URL(value).hostname);
  return isBlockedLiteralHost(hostname);
}

export function createRelayApp(deps: RelayAppDeps): Hono {
  const log = deps.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const registrationTtlDays = deps.registrationTtlDays ?? DEFAULT_REGISTRATION_TTL_DAYS;
  const app = new Hono();

  const directSourceIp = deps.sourceIp ?? ((c: Context): string => {
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      // Hono's in-process app.request() has no socket. Production requests always do.
      return "unknown";
    }
  });
  const sourceIp = (c: Context): string => {
    if (deps.trustForwarded === true) {
      const forwarded = c.req.header("x-forwarded-for")
        ?.split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .at(-1);
      if (forwarded !== undefined) return forwarded;
    }
    return directSourceIp(c);
  };
  const registerLimiter = new PerMinuteRateLimiter(
    deps.registerRateLimitPerMinute ?? DEFAULT_REGISTER_RATE_LIMIT_PER_MINUTE,
  );
  const notifyLimiter = new PerMinuteRateLimiter(
    deps.notifyRateLimitPerMinute ?? DEFAULT_NOTIFY_RATE_LIMIT_PER_MINUTE,
  );
  const rateLimit = (limiter: PerMinuteRateLimiter) => createMiddleware(async (c, next) => {
    const decision = limiter.consume(sourceIp(c), deps.now());
    if (!decision.allowed) {
      return c.json(
        relayError("over_cap", "source rate limit exceeded"),
        429,
        { "retry-after": String(decision.retryAfterSeconds) },
      );
    }
    await next();
  });

  // Accountless by design: ciphertext-only payloads and the layered caps bound abuse without
  // adding an identity service. A future unlock check can land in this single middleware slot.
  const authHook = createMiddleware(async (_c, next) => {
    await next();
  });
  app.use("/register", rateLimit(registerLimiter));
  app.use("/notify", rateLimit(notifyLimiter));
  app.use("/register", authHook);
  app.use("/notify", authHook);

  const readBody = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  const parseBody = <S extends TSchema>(schema: S, body: unknown): Static<S> | undefined =>
    Value.Check(schema, body) ? (body as Static<S>) : undefined;

  app.get("/health", (c) => c.json({
    name: "cozygateway-relay",
    version: deps.version,
    registrations: deps.storage.registrationCount(),
    todaysNotifies: deps.storage.totalNotifyCount(utcDay(deps.now())),
  }));

  app.post("/register", async (c) => {
    const parsed = parseBody(RegisterRequestSchema, await readBody(c));
    if (parsed === undefined) return c.json(relayError("invalid_request", "malformed register body"), 400);
    if (parsed.platform !== "apns" && parsed.environment !== undefined) {
      return c.json(relayError("invalid_request", "environment is only valid for apns registrations"), 400);
    }
    const transportKey = parsed.platform === "apns" && parsed.environment !== undefined
      ? `apns:${parsed.environment}`
      : parsed.platform;
    if (deps.transports[transportKey] === undefined) {
      return c.json(
        relayError("unsupported_platform", `platform "${parsed.platform}" is not available on this relay yet`),
        501,
      );
    }
    if (parsed.platform === "webhook" && !isHttpUrl(parsed.token)) {
      return c.json(relayError("invalid_request", "webhook token must be an http(s) URL"), 400);
    }
    if (parsed.platform === "webhook" && deps.restrictEgress && isBlockedWebhookUrl(parsed.token)) {
      return c.json(relayError("invalid_request", "webhook token resolves to a restricted address range"), 400);
    }
    const now = deps.now();
    // Lazy TTL sweep BEFORE the cap check, so rows past their TTL free cap headroom instead
    // of 429ing a genuinely new device (issue #28).
    deps.storage.pruneRegistrations(now, registrationTtlDays);
    const pushId = randomBytes(16).toString("base64url");
    const saved = deps.storage.saveRegistration(
      { pushId, platform: transportKey, token: parsed.token, createdAt: now },
      deps.maxRegistrations,
    );
    if (!saved) {
      return c.json(relayError("over_cap", "registration cap reached for this relay"), 429);
    }
    return c.json({ pushId }, 201);
  });

  app.post("/notify", async (c) => {
    const parsed = parseBody(NotifyRequestSchema, await readBody(c));
    if (parsed === undefined) return c.json(relayError("invalid_request", "malformed notify body"), 400);
    // Category and collapse id are one unit (issue #19, section 2): a categorized push that
    // cannot coalesce could never be retracted or updated when its approval resolves, and a
    // collapse id with no category is a coalescing key the app has nothing to render against.
    // Refusing the half-specified forms keeps the app-side contract total.
    if ((parsed.category === undefined) !== (parsed.collapseId === undefined)) {
      return c.json(relayError("invalid_request", "category and collapseId must be sent together"), 400);
    }
    const now = deps.now();
    // TTL sweep BEFORE the lookup: an expired registration 404s on this very request (issue #28).
    deps.storage.pruneRegistrations(now, registrationTtlDays);
    const registration = deps.storage.registrationByPushId(parsed.pushId);
    if (registration === undefined) return c.json(relayError("not_found", "unknown push id"), 404);
    // Lazy retention sweep: no timer, so the relay stays dependency-free and trivial to shut
    // down (design decision, issue #9). Piggybacks on the existing notify traffic that already
    // reads/writes notify_counts.
    deps.storage.pruneNotifyCounts(now);
    const day = utcDay(now);
    if (deps.storage.notifyCount(registration.pushId, day) >= deps.dailyCap) {
      return c.json(relayError("over_cap", "daily notification cap reached for this push id"), 429);
    }
    deps.storage.incrementNotifyCount(registration.pushId, day);
    const transport = deps.transports[registration.platform];
    if (transport === undefined) {
      log(`push id ${registration.pushId}: no transport for platform "${registration.platform}"`);
      return c.json({}, 202);
    }
    // Delivery is best-effort and never blocks or fails the response (design spec, section 3):
    // the notify counts against the cap whether or not delivery succeeds.
    const push =
      parsed.category === undefined
        ? undefined
        : { category: parsed.category, collapseId: parsed.collapseId };
    void transport.deliver(registration.token, parsed.ciphertext, push).catch((err: unknown) => {
      log(`push id ${registration.pushId}: delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return c.json({}, 202);
  });

  app.delete("/register/:pushId", (c) => {
    deps.storage.deleteRegistration(c.req.param("pushId"));
    return c.body(null, 204);
  });

  app.notFound((c) => c.json(relayError("not_found", "no such route"), 404));
  app.onError((err, c) => {
    log(`unexpected relay fault: ${err.message}`);
    return c.json(relayError("internal", "unexpected relay fault"), 500);
  });

  return app;
}

import { randomBytes } from "node:crypto";

import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";

import { NotifyRequestSchema, RegisterRequestSchema, relayError } from "./schemas.ts";
import { utcDay, type RelayStorage } from "./storage.ts";
import type { Transport } from "./transports.ts";

export interface RelayAppDeps {
  storage: RelayStorage;
  /** Keyed by platform. A platform with no transport is recognized but unavailable (501). */
  transports: Readonly<Record<string, Transport | undefined>>;
  dailyCap: number;
  version: string;
  now: () => number;
  log?: (message: string) => void;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function createRelayApp(deps: RelayAppDeps): Hono {
  const log = deps.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const app = new Hono();

  // Auth hook: the hosted instance's future unlock check lands in this single middleware slot.
  // v0 ships open with abuse caps only (design spec, section 2, decision 2).
  const authHook = createMiddleware(async (_c, next) => {
    await next();
  });
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

  app.get("/health", (c) => c.json({ name: "cozygateway-relay", version: deps.version }));

  app.post("/register", async (c) => {
    const parsed = parseBody(RegisterRequestSchema, await readBody(c));
    if (parsed === undefined) return c.json(relayError("invalid_request", "malformed register body"), 400);
    if (deps.transports[parsed.platform] === undefined) {
      return c.json(
        relayError("unsupported_platform", `platform "${parsed.platform}" is not available on this relay yet`),
        501,
      );
    }
    if (parsed.platform === "webhook" && !isHttpUrl(parsed.token)) {
      return c.json(relayError("invalid_request", "webhook token must be an http(s) URL"), 400);
    }
    const pushId = randomBytes(16).toString("base64url");
    deps.storage.saveRegistration({
      pushId,
      platform: parsed.platform,
      token: parsed.token,
      createdAt: deps.now(),
    });
    return c.json({ pushId }, 201);
  });

  app.post("/notify", async (c) => {
    const parsed = parseBody(NotifyRequestSchema, await readBody(c));
    if (parsed === undefined) return c.json(relayError("invalid_request", "malformed notify body"), 400);
    const registration = deps.storage.registrationByPushId(parsed.pushId);
    if (registration === undefined) return c.json(relayError("not_found", "unknown push id"), 404);
    const day = utcDay(deps.now());
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
    void transport.deliver(registration.token, parsed.ciphertext).catch((err: unknown) => {
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

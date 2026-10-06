import type { Context, Hono, MiddlewareHandler } from "hono";

import { HermesRpcError } from "./client.ts";
import { HERMES_DISPLAY_ERROR, ScreenRequestNotFound, type BotScreenConfig, type BotScreenSurface } from "./bot-screen.ts";
import { canonicalName, failure, type Env } from "./routes.ts";

/** Capability 85: `/bots/:name/screen*`. Every body is Hermes's own `display.*` result passed through
 *  verbatim; the only shapes this gateway authors are `observe`'s ticket and path, the sudo relay and
 *  the two small config documents. See contract/ext-bots-v1.md row 85. */

const GEOMETRY_RE = /^\d{3,5}x\d{3,5}$/;

class InvalidScreenBody extends Error {}

async function body(c: Context<Env>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidScreenBody("the body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new InvalidScreenBody("the body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function optionalBool(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new InvalidScreenBody(`${key} must be a boolean`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string, max = 512): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new InvalidScreenBody(`${key} must be a string`);
  return value;
}

function optionalCount(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InvalidScreenBody(`${key} must be a non-negative integer`);
  return value;
}

function screenFailure(c: Context<Env>, err: unknown) {
  if (err instanceof InvalidScreenBody) return c.json({ error: { code: "invalid_request", message: err.message } }, 400);
  if (err instanceof ScreenRequestNotFound) return c.json({ error: { code: "not_found", message: err.message } }, 404);
  // 5300 is Hermes saying no about the SCREEN (a human holds it, a viewer id it never minted, the
  // screen is not running), not the link failing: a conflict the client can act on (offer Force),
  // never a 502 that reads as "check your gateway".
  if (err instanceof HermesRpcError && err.code === HERMES_DISPLAY_ERROR) {
    const data = typeof err.data === "object" && err.data !== null ? (err.data as Record<string, unknown>) : {};
    return c.json(
      {
        error: { code: "conflict", message: err.message },
        hermesError: err.message,
        hermesErrorCode: HERMES_DISPLAY_ERROR,
        ...(typeof data["code"] === "string" ? { reason: data["code"] } : {}),
      },
      409,
    );
  }
  return failure(c, err);
}

export function registerBotScreenRoutes(
  app: Hono<Env>,
  requireDevice: MiddlewareHandler<Env>,
  screen: BotScreenSurface,
): void {
  const route = (
    handler: (c: Context<Env>, name: string) => Promise<Response>,
  ) => async (c: Context<Env>) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    try {
      return await handler(c, resolved.name);
    } catch (err) {
      return screenFailure(c, err);
    }
  };

  app.get("/bots/:name/screen", requireDevice, route(async (c, name) => c.json(await screen.status(name))));
  app.get("/bots/:name/screen/thumbnail", requireDevice, route(async (c, name) => c.json(await screen.thumbnail(name))));
  app.post("/bots/:name/screen/start", requireDevice, route(async (c, name) => c.json(await screen.start(name))));
  app.post("/bots/:name/screen/stop", requireDevice, route(async (c, name) => {
    const input = await body(c);
    return c.json(await screen.stop(name, optionalBool(input, "force") === true));
  }));
  app.post("/bots/:name/screen/install", requireDevice, route(async (c, name) =>
    c.json(await screen.install(name, c.get("deviceId")))));
  app.post("/bots/:name/screen/install/sudo", requireDevice, route(async (c, name) => {
    const input = await body(c);
    const requestId = optionalString(input, "requestId", 128);
    // "" is Hermes's own "skip": the install then reports no sudo and prints the command instead.
    const password = optionalString(input, "password", 4096) ?? "";
    if (requestId === undefined || requestId === "") throw new InvalidScreenBody("requestId is required");
    screen.answerSudo(name, requestId, password, c.get("deviceId"));
    return c.body(null, 204);
  }));
  app.post("/bots/:name/screen/observe", requireDevice, route(async (c, name) => {
    const input = await body(c);
    const viewerId = optionalString(input, "viewerId", 256);
    return c.json(await screen.observe(name, c.get("deviceId"), viewerId === "" ? undefined : viewerId));
  }));
  app.post("/bots/:name/screen/lease/acquire", requireDevice, route(async (c, name) => {
    const input = await body(c);
    const viewerId = optionalString(input, "viewerId", 256);
    if (viewerId === undefined || viewerId === "") throw new InvalidScreenBody("viewerId is required");
    return c.json(await screen.acquire(name, viewerId, optionalString(input, "reason", 500) ?? ""));
  }));
  app.post("/bots/:name/screen/lease/release", requireDevice, route(async (c, name) => {
    const input = await body(c);
    const viewerId = optionalString(input, "viewerId", 256);
    return c.json(await screen.release(name, viewerId === "" ? undefined : viewerId, optionalBool(input, "force") === true));
  }));
  app.get("/bots/:name/screen/config", requireDevice, route(async (c, name) => c.json(await screen.config(name))));
  app.patch("/bots/:name/screen/config", requireDevice, route(async (c, name) => {
    const input = await body(c);
    const patch: BotScreenConfig = {};
    const geometry = optionalString(input, "geometry", 16);
    if (geometry !== undefined) {
      if (!GEOMETRY_RE.test(geometry)) throw new InvalidScreenBody("geometry must look like 1440x900");
      patch.geometry = geometry;
    }
    const autoStart = optionalBool(input, "autoStart");
    if (autoStart !== undefined) patch.autoStart = autoStart;
    const minFree = optionalCount(input, "minFreeMemoryMb");
    if (minFree !== undefined) patch.minFreeMemoryMb = minFree;
    const idle = optionalCount(input, "idleStopMinutes");
    if (idle !== undefined) patch.idleStopMinutes = idle;
    const headed = optionalBool(input, "browserHeaded");
    if (headed !== undefined) patch.browserHeaded = headed;
    return c.json(await screen.patchConfig(name, patch));
  }));
  app.get("/bots/:name/screen/auto-open", requireDevice, route(async (c, name) => c.json(await screen.autoOpen(name))));
  app.put("/bots/:name/screen/auto-open", requireDevice, route(async (c, name) => {
    const input = await body(c);
    const enabled = optionalBool(input, "enabled");
    if (enabled === undefined) throw new InvalidScreenBody("enabled is required");
    return c.json(await screen.setAutoOpen(name, enabled));
  }));
}

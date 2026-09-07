import type { Hono, Context } from "hono";
import type { AppDeps } from "../http.ts";
import { hashToken } from "../auth.ts";
import { OBSERVE_ASSETS, OBSERVE_ASSET_VERSION } from "./assets.generated.ts";

export const OBSERVE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const COOKIE = "cozygateway_observe";

/** Cookie authentication bridges static GETs only. APIs and websocket authentication retain the
 * device bearer. Every request resolves the device record, preserving immediate revocation. */
export function registerObserveDashboard(app: Hono<{ Variables: { deviceId: string } }>, deps: AppDeps): void {
  const enabled = () => deps.config.observability?.enabled === true;
  function tokenOf(c: Context, cookie = true): string {
    const authorization = c.req.header("authorization");
    if (authorization !== undefined) return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!cookie) return "";
    const value = (c.req.header("cookie") ?? "").split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
    try { return value === undefined ? "" : decodeURIComponent(value.slice(COOKIE.length + 1)); } catch { return ""; }
  }
  function authorized(c: Context, cookie = true): boolean {
    const token = tokenOf(c, cookie);
    const device = token ? deps.storage.deviceByTokenHash(hashToken(token)) : undefined;
    if (!device) return false;
    deps.storage.touchDevice(device.id, deps.now());
    return true;
  }
  function respond(c: Context, name: string, cache = true): Response {
    const asset = OBSERVE_ASSETS[name];
    if (!asset) return new Response("Not found", { status: 404 });
    c.header("Content-Security-Policy", OBSERVE_CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", cache && c.req.query("v") === OBSERVE_ASSET_VERSION ? "private, max-age=31536000, immutable" : "private, no-store");
    c.header("Content-Type", asset.type);
    c.header("ETag", `"observe-${OBSERVE_ASSET_VERSION}-${name.replaceAll("/", "-")}"`);
    return c.body(new Uint8Array(Buffer.from(asset.base64, "base64")));
  }
  app.get("/observe/pair", c => enabled() ? respond(c, "pair.html", false) : c.notFound());
  app.get("/observe/pair/app.css", c => enabled() ? respond(c, "pair.css") : c.notFound());
  app.get("/observe/pair/app.js", c => enabled() ? respond(c, "pair.js") : c.notFound());
  app.get("/observe/session", c => {
    if (!enabled()) return c.notFound();
    if (!authorized(c, false)) return c.json({ error: { code: "unauthorized" } }, 401);
    const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
    c.header("Set-Cookie", `${COOKIE}=${encodeURIComponent(tokenOf(c, false))}; HttpOnly; SameSite=Strict; Path=/observe${secure ? "; Secure" : ""}`);
    c.header("Cache-Control", "no-store");
    return c.json({ paired: true });
  });
  app.get("/observe", c => {
    if (!enabled()) return c.notFound();
    if (!authorized(c)) {
      c.header("Content-Security-Policy", OBSERVE_CSP);
      c.header("Cache-Control", "no-store");
      return c.html('<!doctype html><html lang="en"><title>Pair Observe</title><h1>Observer pairing required</h1><p><a href="/observe/pair">Pair this browser with CozyChat</a></p></html>', 401);
    }
    return respond(c, "index.html", false);
  });
  app.get("/observe/assets/:name", c => {
    if (!enabled()) return c.notFound();
    if (!authorized(c)) return c.json({ error: { code: "unauthorized" } }, 401);
    const name = c.req.param("name");
    return respond(c, name === "app.css" || name === "app.js" ? name : `fonts/${name}`);
  });
}

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { OBSERVE_CSP } from "../src/observe/dashboard.ts";
import { OBSERVE_ASSET_VERSION } from "../src/observe/assets.generated.ts";
import { mintDeviceToken } from "../src/auth.ts";

let storage: Storage;
let readToken: string;
let writeToken: string;
function app(enabled = true) {
  return createApp({
    storage, config: { name: "test", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0, observability: { enabled, retentionDays: 7 } },
    gatewayInfo: { name: "test", version: "0.7.6", contract: "v1" },
    presenceOf: () => "online", submitUserMessage: () => { throw new Error("not used"); },
    interruptThread: () => "idle", resolveApproval: async () => "unknown",
    onDeviceRevoked: () => {}, now: () => 1_700_000_000_000,
  });
}
function bearer(token = readToken) { return { authorization: `Bearer ${token}` }; }
beforeEach(() => {
  storage = openStorage(":memory:");
  for (const scope of ["read", "write"] as const) {
    const minted = mintDeviceToken();
    storage.createDevice({ id: scope, name: scope, tokenHash: minted.tokenHash, createdAt: 1, kind: scope === "read" ? "observer" : "device", scope });
    if (scope === "read") readToken = minted.token; else writeToken = minted.token;
  }
});
afterEach(() => storage.close());

describe("the embedded Observe dashboard", () => {
  it("serves a strict self-only CSP with no inline scripts or styles", async () => {
    const response = await app().request("/observe", { headers: bearer() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(OBSERVE_CSP);
    expect(OBSERVE_CSP).not.toContain("unsafe-inline");
    const html = await response.text();
    expect(html).not.toMatch(/<style|style=|on(?:click|load)=/);
    expect(html).not.toMatch(/<script(?![^>]*src=)/);
    expect(html).not.toContain("warm.cozylabs.ai");
  });
  it("answers 404 for the whole dashboard when observability is disabled", async () => {
    for (const path of ["/observe", "/observe/assets/app.js", "/observe/pair", "/observe/pair/app.css", "/observe/pair/craft.png", "/observe/session"]) {
      expect((await app(false).request(path, { headers: bearer() })).status).toBe(404);
    }
  });
  it("requires a paired device but accepts both read and write scopes", async () => {
    const gateway = app();
    expect((await gateway.request("/observe")).status).toBe(302);
    expect((await gateway.request("/observe", { headers: bearer("unknown") })).status).toBe(302);
    expect((await gateway.request("/observe", { headers: bearer(readToken) })).status).toBe(200);
    expect((await gateway.request("/observe", { headers: bearer(writeToken) })).status).toBe(200);
    expect((await gateway.request("/observe/assets/app.js")).status).toBe(401);
  });
  it("takes unpaired browser navigation directly to the styled pairing flow", async () => {
    const gateway = app();
    const unpairedHeaders: HeadersInit[] = [{}, bearer("unknown"), { cookie: "cozygateway_observe=%invalid" }];
    for (const headers of unpairedHeaders) {
      const response = await gateway.request("https://example.test/observe", { headers });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/observe/pair");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toBe(OBSERVE_CSP);
      const pairing = await gateway.request(response.headers.get("location")!, { headers });
      expect(pairing.status).toBe(200);
      const html = await pairing.text();
      expect(html).toMatch(/<h1(?:\s[^>]*)?>Pair this browser<\/h1>/);
      expect(html).toContain('/observe/pair/app.css?v=');
      expect(html).toContain('/observe/pair/app.js?v=');
      expect(html).not.toContain('Observer pairing required');
    }
    expect((await gateway.request("/observe/pair/app.css")).status).toBe(200);
    expect((await gateway.request("/observe/pair/app.js")).status).toBe(200);
    expect((await gateway.request("/observe/session", { headers: bearer("unknown") })).status).toBe(401);
  });
  it("serves embedded fonts as same-origin bytes without remote references", async () => {
    const gateway = app();
    const css = await (await gateway.request("/observe/assets/app.css", { headers: bearer() })).text();
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|https:\/\//);
    const fontUrls = [...css.matchAll(/src: url\("([^\"]+\.woff2[^\"]*)"\)/g)].map(match => match[1]!);
    expect(fontUrls).toHaveLength(2);
    expect(fontUrls.every(path => path.includes("jetbrains-mono"))).toBe(true);
    for (const path of fontUrls) {
      const font = await gateway.request(path, { headers: bearer() });
      expect(font.status).toBe(200);
      expect(font.headers.get("content-type")).toBe("font/woff2");
      expect(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString()).toBe("wOF2");
    }
  });
  it("serves the bundled craft backdrop without exposing dashboard data", async () => {
    const gateway = app();
    const response = await gateway.request(`/observe/pair/craft.png?v=${OBSERVE_ASSET_VERSION}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toBe(OBSERVE_CSP);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(new URL("../src/observe/dashboard/pair-craft.png", import.meta.url)))).toBe(true);
    const html = await (await gateway.request("/observe", { headers: bearer() })).text();
    expect(html).toContain('/observe/pair/app.css?v=');
    expect((await gateway.request("/observe/assets/app.js")).status).toBe(401);
    expect((await gateway.request("/observe/session")).status).toBe(401);
  });
  it("bridges bearer auth to a scoped HttpOnly cookie and checks revocation on every navigation", async () => {
    const gateway = app();
    const response = await gateway.request("https://example.test/observe/session", { headers: bearer() });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly; SameSite=Strict; Path=/observe; Secure");
    const headers = { cookie: cookie.split(";")[0]! };
    expect((await gateway.request("/observe", { headers })).status).toBe(200);
    expect((await gateway.request("/observe/assets/app.js", { headers })).status).toBe(200);
    expect((await gateway.request("/observe/session", { headers })).status).toBe(401);
    expect((await gateway.request("/devices", { headers })).status).toBe(401);
    storage.deleteDevice("read");
    const revoked = await gateway.request("/observe", { headers });
    expect(revoked.status).toBe(302);
    expect(revoked.headers.get("location")).toBe("/observe/pair");
    expect((await gateway.request("/observe/assets/app.js", { headers })).status).toBe(401);
    expect((await gateway.request("/observe/session", { headers: bearer() })).status).toBe(401);
  });
  it("only marks content-addressed assets immutable and keeps the shell private", async () => {
    const gateway=app();
    const asset=await gateway.request(`/observe/assets/app.js?v=${OBSERVE_ASSET_VERSION}`,{headers:bearer()});
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await gateway.request("/observe/assets/app.js?v=old",{headers:bearer()})).headers.get("cache-control")).toBe("private, no-store");
    expect((await gateway.request("/observe",{headers:bearer()})).headers.get("cache-control")).toBe("private, no-store");
  });
  it("exposes only the pairing bootstrap before auth and adds no action route", async () => {
    const gateway=app();
    expect((await gateway.request("/observe/pair")).status).toBe(200);
    expect((await gateway.request("/observe/pair/app.js")).status).toBe(200);
    expect((await gateway.request("/observe/session",{method:"POST",headers:bearer()})).status).toBe(403);
    const js=await(await gateway.request("/observe/assets/app.js",{headers:bearer()})).text();
    expect(js).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)/);
    expect(js).toContain("observe_subscribe");
    expect(js).toContain("observe_gap");
    expect(js).toContain("observe_update");
  });
});

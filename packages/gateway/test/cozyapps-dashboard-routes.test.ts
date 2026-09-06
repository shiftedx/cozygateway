import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/http.ts";
import { openStorage, type Storage } from "../src/storage.ts";

const JSON_HEADERS = { "content-type": "application/json" };
const stores: Storage[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const tree = {
  root: { id: "root", kind: "stack", children: [{ id: "refresh", kind: "button", label: "Refresh", actionId: "refresh", role: "primary" }] },
} as const;
const document = {
  title: "Market watchlist",
  sections: [{
    id: "main",
    components: [
      { kind: "input", id: "ticker-input", label: "Ticker", valueRef: "ticker", valueType: "string" },
      { kind: "metric", id: "quote-metric", label: "Last price", valueRef: "quote" },
      { kind: "action", id: "refresh-action", label: "Refresh", actionId: "refresh" },
    ],
  }],
};

async function setup() {
  const storage = openStorage(":memory:");
  stores.push(storage);
  let now = 100;
  const sent: Array<{ id: string }> = [];
  const app = createApp({
    storage,
    config: { name: "test", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0 },
    gatewayInfo: { name: "test", version: "test", contract: "v1", capabilities: { "com.cozylabs.cozyapps": 2 } },
    presenceOf: () => "online",
    submitUserMessage: () => { throw new Error("not used"); },
    interruptThread: () => "idle",
    resolveApproval: async () => "unknown",
    onDeviceRevoked: () => {},
    sendCozyAppAction: (action) => { sent.push(action); return true; },
    now: () => now,
  });
  storage.createSetupCode("cozyapps-pair", 10_000);
  const paired = await app.request("/pair", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ setupCode: "cozyapps-pair", deviceName: "phone" }) });
  const { deviceToken } = await paired.json() as { deviceToken: string };
  const device = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: `Bearer ${deviceToken}`, ...(init.headers ?? {}) } });
  storage.upsertCozyApp({ id: "sage:market", name: "Market", creatorBot: "sage", tree, now });
  return { storage, app, device, sent, setNow: (value: number) => { now = value; } };
}

describe("cozyapps v2 routes", () => {
  it("leaves every v1 route byte identical, with no new member on an app or an action", async () => {
    const { device } = await setup();
    const summaries = await (await device("/cozyapps")).json() as Array<Record<string, unknown>>;
    expect(Object.keys(summaries[0]!).sort()).toEqual(["createdAt", "creatorBot", "id", "name", "revision", "updatedAt"]);
    const app = await (await device("/cozyapps/sage:market")).json() as Record<string, unknown>;
    expect(Object.keys(app).sort()).toEqual(["createdAt", "creatorBot", "id", "name", "revision", "tree", "updatedAt"]);
    const accepted = await device("/cozyapps/sage:market/actions", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ idempotencyKey: "tap-1", actionId: "refresh" }) });
    expect(accepted.status).toBe(202);
    const action = await accepted.json() as Record<string, unknown>;
    expect(Object.keys(action).sort()).toEqual(["actionId", "appId", "createdAt", "creatorBot", "id", "status", "updatedAt"]);
    // HTTP acceptance is never a completed action.
    expect(action["status"]).toBe("requested");
  });

  it("writes a saved value, replays its key, and answers a stale write 409 with the current value", async () => {
    const { device } = await setup();
    const write = (body: object) => device("/cozyapps/sage:market/values/ticker", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });
    const first = await write({ expectedRevision: 0, idempotencyKey: "tap-1", type: "string", value: "AAPL" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ appId: "sage:market", valueId: "ticker", value: "AAPL", revision: 1 });
    const replay = await write({ expectedRevision: 0, idempotencyKey: "tap-1", type: "string", value: "AAPL" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ revision: 1 });
    expect(await write({ expectedRevision: 1, idempotencyKey: "tap-2", type: "string", value: "MSFT" }).then((r) => r.status)).toBe(200);
    const stale = await write({ expectedRevision: 1, idempotencyKey: "tap-3", type: "string", value: "NVDA" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "conflict" }, current: { value: "MSFT", revision: 2 } });
    expect(await (await device("/cozyapps/sage:market/values")).json()).toMatchObject({ values: [{ value: "MSFT", revision: 2 }] });
  });

  it("refuses a value that is not a product field type of its declared kind", async () => {
    const { device } = await setup();
    for (const body of [
      { expectedRevision: 0, idempotencyKey: "tap-1", type: "date", value: "yesterday" },
      { expectedRevision: 0, idempotencyKey: "tap-1", type: "string", value: { nested: true } },
      { expectedRevision: 0, idempotencyKey: "tap-1", type: "secret", value: "x" },
    ])
      expect((await device("/cozyapps/sage:market/values/ticker", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) })).status, JSON.stringify(body)).toBe(400);
  });

  it("round-trips the envelope through the route unchanged and rejects an unknown document", async () => {
    const { device } = await setup();
    expect((await device("/cozyapps/sage:market/dashboard")).status).toBe(404);
    const written = await device("/cozyapps/sage:market/dashboard", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ expectedRevision: 0, documentVersion: 1, document }) });
    expect(written.status).toBe(200);
    const envelope = await written.json() as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["creatorBot", "data", "document", "documentVersion", "id", "owner", "revision", "updatedAt"]);
    expect(JSON.stringify(envelope["document"])).toBe(JSON.stringify(document));
    expect(JSON.stringify((await (await device("/cozyapps/sage:market/dashboard")).json())).length).toBe(JSON.stringify(envelope).length);
    // An out-of-bounds or unknown document is refused at validation and never stored.
    const rejected = await device("/cozyapps/sage:market/dashboard", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ expectedRevision: 1, documentVersion: 1, document: { title: "x", sections: [{ id: "s", components: [{ kind: "iframe", id: "c", label: "x", valueRef: "a" }] }] } }) });
    expect(rejected.status).toBe(400);
    expect((await (await device("/cozyapps/sage:market/dashboard")).json() as { revision: number }).revision).toBe(1);
    const conflict = await device("/cozyapps/sage:market/dashboard", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ expectedRevision: 0, documentVersion: 1, document }) });
    expect(conflict.status).toBe(409);
  });

  it("binds an action to the revisions it was made against and reads back the four public names", async () => {
    const { device, storage } = await setup();
    const accepted = await device("/cozyapps/sage:market/actions", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ idempotencyKey: "tap-1", actionId: "refresh", appRevision: 1, valueRevisions: [{ valueId: "ticker", revision: 2 }] }),
    });
    expect(accepted.status).toBe(202);
    const receipts = await (await device("/cozyapps/sage:market/receipts")).json() as { receipts: Array<Record<string, unknown>> };
    expect(receipts.receipts[0]).toMatchObject({ status: "queued", appRevision: 1, valueRevisions: [{ valueId: "ticker", revision: 2 }] });
    storage.markCozyAppActionDelivered(receipts.receipts[0]!["id"] as string, 150);
    expect(((await (await device("/cozyapps/sage:market/receipts")).json()) as { receipts: Array<{ status: string }> }).receipts[0]?.status).toBe("running");
  });

  it("keeps the new routes behind device authentication", async () => {
    const { app } = await setup();
    for (const [path, init] of [
      ["/cozyapps/sage:market/values", {}],
      ["/cozyapps/sage:market/values/ticker", { method: "PUT", headers: JSON_HEADERS, body: "{}" }],
      ["/cozyapps/sage:market/dashboard", {}],
      ["/cozyapps/sage:market/dashboard", { method: "PUT", headers: JSON_HEADERS, body: "{}" }],
      ["/cozyapps/sage:market/receipts", {}],
    ] as Array<[string, RequestInit]>)
      expect((await app.request(path, init)).status, path).toBe(401);
  });
});

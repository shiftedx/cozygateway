import { describe, expect, it } from "vitest";
import {
  COZYAPPS_CAPABILITY_VERSION,
  COZYAPP_DATA_STATES,
  COZYAPP_DOCUMENT_VERSION,
  COZYAPP_MAX_DATA_BYTES,
  COZYAPP_MAX_DOCUMENT_BYTES,
  COZYAPP_RECEIPT_STATES,
  COZYAPP_VALUE_TYPES,
  CozyAppActionReceiptSchema,
  CozyAppActionSchema,
  CozyAppDashboardSchema,
  CozyAppDashboardWriteRequestSchema,
  CozyAppDataSchema,
  CozyAppDocumentSchema,
  CozyAppValueSchema,
  CozyAppValueWriteRequestSchema,
  assertValidCozyAppData,
  assertValidCozyAppDocument,
  check,
  cozyAppReceiptStatus,
  cozyAppValueOfType,
} from "../src/index.ts";

const document = {
  title: "Market watchlist",
  sections: [{
    id: "main",
    title: "Watchlist",
    components: [
      { kind: "input", id: "ticker-input", label: "Ticker", valueRef: "ticker", valueType: "selection", options: ["AAPL", "MSFT"] },
      { kind: "metric", id: "quote-metric", label: "Last price", valueRef: "quote.value" },
      { kind: "action", id: "refresh-action", label: "Refresh", actionId: "refresh" },
    ],
  }],
} as const;

describe("cozyapps v2 dashboard records", () => {
  it("declares the document contract version the capability bump stands for", () => {
    expect(COZYAPPS_CAPABILITY_VERSION).toBe(2);
    expect(COZYAPP_DOCUMENT_VERSION).toBe(1);
    expect([...COZYAPP_VALUE_TYPES]).toEqual(["string", "number", "boolean", "date", "selection"]);
    expect([...COZYAPP_RECEIPT_STATES]).toEqual(["queued", "running", "completed", "failed"]);
    expect([...COZYAPP_DATA_STATES]).toEqual(["fresh", "stale", "error"]);
  });

  it("round-trips one typed document through the schema unchanged", () => {
    const parsed = assertValidCozyAppDocument(JSON.parse(JSON.stringify(document)));
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(document));
    expect(check(CozyAppDocumentSchema, document)).toBe(true);
  });

  it("refuses a document outside the closed component catalog or the bounds", () => {
    // Presentation is never remote: no colour, font, coordinate, HTML, script, or URL member exists.
    for (const bad of [
      { title: "x", sections: [{ id: "s", components: [{ kind: "html", id: "c", label: "x", valueRef: "a" }] }] },
      { title: "x", sections: [{ id: "s", components: [{ kind: "metric", id: "c", label: "x", valueRef: "a", color: "#ff0000" }] }] },
      { title: "x", sections: [{ id: "s", components: [{ kind: "metric", id: "c", label: "x", valueRef: "javascript:alert(1)" }] }] },
      { title: "x", sections: [{ id: "s", components: [{ kind: "metric", id: "c", label: "x", valueRef: "https://example.com" }] }] },
      { title: "x", sections: [{ id: "s", components: [{ kind: "action", id: "c", label: "x", actionId: "refresh", url: "https://example.com" }] }] },
      { title: "x", sections: [] , extra: 1 },
    ])
      expect(() => assertValidCozyAppDocument(bad), JSON.stringify(bad)).toThrow();
  });

  it("refuses duplicate ids, a control character, and an oversized document", () => {
    expect(() => assertValidCozyAppDocument({
      title: "x",
      sections: [{ id: "s", components: [
        { kind: "metric", id: "dupe", label: "a", valueRef: "a" },
        { kind: "metric", id: "dupe", label: "b", valueRef: "b" },
      ] }],
    })).toThrow(/unique/);
    expect(() => assertValidCozyAppDocument({
      title: "badtitle",
      sections: [{ id: "s", components: [{ kind: "metric", id: "m", label: "a", valueRef: "a" }] }],
    })).toThrow(/control/);
    expect(COZYAPP_MAX_DOCUMENT_BYTES).toBe(32 * 1024);
    expect(() => assertValidCozyAppDocument({
      title: "x",
      sections: Array.from({ length: 13 }, (_, index) => ({ id: `s${index}`, components: [] })),
    })).toThrow();
  });

  it("keeps a typed saved value to product field types and their own revision", () => {
    expect(check(CozyAppValueSchema, { appId: "app", valueId: "ticker", type: "string", value: "MSFT", revision: 8, updatedAt: 1 })).toBe(true);
    expect(cozyAppValueOfType("date", 1788638400000)).toBe(true);
    expect(cozyAppValueOfType("date", "yesterday")).toBe(false);
    expect(cozyAppValueOfType("number", "1")).toBe(false);
    expect(cozyAppValueOfType("boolean", true)).toBe(true);
    // Nested JSON is not a product field type, so no write can smuggle one.
    expect(check(CozyAppValueWriteRequestSchema, { expectedRevision: 8, idempotencyKey: "tap-1", type: "string", value: { nested: true } })).toBe(false);
    expect(check(CozyAppValueWriteRequestSchema, { expectedRevision: 0, idempotencyKey: "tap-1", type: "string", value: "MSFT" })).toBe(true);
  });

  it("carries the small envelope and its source-attributed data snapshot", () => {
    const envelope = {
      id: "app_market", revision: 4, owner: "user", creatorBot: "sage", documentVersion: 1,
      document, data: { "quote.value": { source: "quotes.example", asOf: 1788638400000, value: "214.35", state: "stale" } },
      updatedAt: 1788638400000,
    };
    expect(check(CozyAppDashboardSchema, envelope)).toBe(true);
    expect(check(CozyAppDashboardSchema, { ...envelope, data: { "quote.value": { source: "s", asOf: 1, value: "1", state: "unknown" } } })).toBe(false);
    expect(check(CozyAppDashboardWriteRequestSchema, { expectedRevision: 4, documentVersion: 1, document })).toBe(true);
    // A user regeneration never writes source data; only the bot does, over attach.
    expect(check(CozyAppDashboardWriteRequestSchema, { expectedRevision: 4, documentVersion: 1, document, data: {} })).toBe(false);
  });

  it("derives the four public receipt names from the durable internal states", () => {
    expect(cozyAppReceiptStatus("requested")).toBe("queued");
    expect(cozyAppReceiptStatus("delivered")).toBe("running");
    expect(cozyAppReceiptStatus("completed")).toBe("completed");
    expect(cozyAppReceiptStatus("failed")).toBe("failed");
    expect(check(CozyAppActionReceiptSchema, {
      id: "action-1", appId: "app", creatorBot: "sage", actionId: "refresh", status: "running",
      appRevision: 4, valueRevisions: [{ valueId: "ticker", revision: 8 }], createdAt: 1, updatedAt: 2,
    })).toBe(true);
  });

  it("leaves the v1 action payload byte identical, with no new member on it", () => {
    const v1 = { id: "a", appId: "app", creatorBot: "sage", actionId: "refresh", status: "requested", createdAt: 1, updatedAt: 1 };
    expect(check(CozyAppActionSchema, v1)).toBe(true);
    expect(check(CozyAppActionSchema, { ...v1, status: "queued" })).toBe(false);
    expect(check(CozyAppActionSchema, { ...v1, appRevision: 4 })).toBe(false);
  });
});

/** Fix round 1, review r0 finding I2. The snapshot a client reads by key had unvalidated keys and
 *  no byte ceiling, which made the contract's own "no URL can occupy a reference" claim false of
 *  the half a bot writes. */
describe("cozyapps v2 snapshot data bounds", () => {
  const point = { source: "quotes.example", asOf: 1, value: "1", state: "fresh" as const };

  it("accepts a bounded identifier key and the point shape it names", () => {
    expect(assertValidCozyAppData({ "quote.value": point })).toEqual({ "quote.value": point });
    expect(check(CozyAppDataSchema, { "quote.value": point })).toBe(true);
  });

  it("refuses a key that is not the same bounded reference a component uses", () => {
    for (const key of ["javascript:alert(1)", "a/b", "https://attacker.example/x", ".leading", "", "a".repeat(129)])
      expect(() => assertValidCozyAppData({ [key]: point }), JSON.stringify(key.slice(0, 40))).toThrow();
    expect(check(CozyAppDataSchema, { "javascript:alert(1)": point })).toBe(false);
    expect(check(CozyAppDataSchema, { "a/b": point })).toBe(false);
  });

  it("refuses more entries than the ceiling and more bytes than the ceiling", () => {
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, point]));
    expect(() => assertValidCozyAppData(many)).toThrow(/entries/);
    const heavy = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
      `k${index}`, { ...point, source: "s".repeat(120), value: "v".repeat(2_048) },
    ]));
    expect(JSON.stringify(heavy).length).toBeGreaterThan(COZYAPP_MAX_DATA_BYTES);
    expect(() => assertValidCozyAppData(heavy)).toThrow(/size/);
  });
});

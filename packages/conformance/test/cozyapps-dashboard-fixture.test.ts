import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  COZYAPPS_CAPABILITY_ID,
  COZYAPPS_CAPABILITY_VERSION,
  COZYAPP_DATA_STATES,
  COZYAPP_DOCUMENT_VERSION,
  COZYAPP_RECEIPT_STATES,
  COZYAPP_VALUE_TYPES,
  CozyAppActionReceiptSchema,
  CozyAppActionRequestSchema,
  CozyAppActionSchema,
  CozyAppDashboardSchema,
  CozyAppSchema,
  CozyAppValueSchema,
  CozyAppValueWriteRequestSchema,
  assertValid,
  assertValidCozyAppDocument,
  check,
  cozyAppReceiptStatus,
  type CozyAppActionReceipt,
  type CozyAppDashboard,
} from "cozygateway-contract";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/cozyapps-dashboard-v1.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

/** com.cozylabs.cozyapps 2, contract/ext-cozyapps-v1.md section CozyApps 2, cross-referenced as
 *  row 68 in ext-bots-v1.md. A PORTABLE fixture: the records themselves are what a black-box
 *  client in any language can be held to, and above all the pre-2 payloads that must stay exactly
 *  what they were for a peer and a client that never negotiate the new lane. */
describe("cozyapps dashboard records client fixture", () => {
  it("pins the capability floor and the closed sets a client gates the row on", () => {
    expect(fixture["capability"]).toEqual({ id: COZYAPPS_CAPABILITY_ID, minimumVersion: 2 });
    expect(COZYAPPS_CAPABILITY_VERSION).toBeGreaterThanOrEqual(2);
    expect(fixture["attachCapability"]).toBe("cozyapps_dashboard");
    expect(fixture["valueTypes"]).toEqual([...COZYAPP_VALUE_TYPES]);
    expect(fixture["receiptStates"]).toEqual([...COZYAPP_RECEIPT_STATES]);
    expect(fixture["dataStates"]).toEqual([...COZYAPP_DATA_STATES]);
  });

  it("keeps a peer and a client below 2 byte identical to their pre-2 selves", () => {
    const app = assertValid(CozyAppSchema, fixture["appPre2"]);
    expect(Object.keys(app).sort()).toEqual(["createdAt", "creatorBot", "id", "name", "revision", "tree", "updatedAt"].sort());
    const action = assertValid(CozyAppActionSchema, fixture["actionPre2"]);
    expect(Object.keys(action).sort()).toEqual(["actionId", "appId", "createdAt", "creatorBot", "id", "status", "updatedAt"].sort());
    const requests = fixture["actionRequests"] as Record<string, unknown>;
    expect(check(CozyAppActionRequestSchema, requests["pre2"])).toBe(true);
    // The binding is optional, so the pre-2 request and the bound one are both this row's request.
    expect(check(CozyAppActionRequestSchema, requests["bound"])).toBe(true);
  });

  it("round-trips the typed document and the envelope it rides in, unchanged", () => {
    const document = fixture["document"];
    expect(JSON.stringify(assertValidCozyAppDocument(document))).toBe(JSON.stringify(document));
    const envelope = assertValid(CozyAppDashboardSchema, fixture["envelope"]) as CozyAppDashboard;
    expect(Object.keys(envelope).sort()).toEqual(
      ["creatorBot", "data", "document", "documentVersion", "id", "owner", "revision", "updatedAt"].sort(),
    );
    expect(envelope.documentVersion).toBe(COZYAPP_DOCUMENT_VERSION);
    expect(JSON.stringify(envelope.document)).toBe(JSON.stringify(document));
    // Every number a person reads says where it came from, how old it is, and whether it is fresh.
    for (const point of Object.values(envelope.data))
      expect(COZYAPP_DATA_STATES).toContain(point.state);
  });

  it("refuses every document outside the closed catalog, the bounds, or a semantic reference", () => {
    for (const document of fixture["refusedDocuments"] as unknown[])
      expect(() => assertValidCozyAppDocument(document), JSON.stringify(document)).toThrow();
  });

  it("carries a saved value with its own revision, and a conflict that shows the current one", () => {
    const values = fixture["values"] as Record<string, unknown>;
    const stored = assertValid(CozyAppValueSchema, values["stored"]);
    expect(check(CozyAppValueWriteRequestSchema, values["write"])).toBe(true);
    expect(check(CozyAppValueWriteRequestSchema, values["first"])).toBe(true);
    const conflict = values["conflict"] as { error: { code: string }; current: unknown };
    expect(conflict.error.code).toBe("conflict");
    expect(assertValid(CozyAppValueSchema, conflict.current)).toEqual(stored);
    for (const body of values["refused"] as unknown[])
      expect(check(CozyAppValueWriteRequestSchema, body), JSON.stringify(body)).toBe(false);
  });

  it("presents the four public receipt names, derived from the unchanged internal states", () => {
    const receipts = (fixture["receipts"] as unknown[]).map((receipt) => assertValid(CozyAppActionReceiptSchema, receipt) as CozyAppActionReceipt);
    expect(receipts.map((receipt) => receipt.status)).toEqual([...COZYAPP_RECEIPT_STATES]);
    for (const [internal, publicName] of Object.entries(fixture["internalToPublic"] as Record<string, string>))
      expect(cozyAppReceiptStatus(internal as "requested")).toBe(publicName);
    // A snapshot appears on the terminal receipts only: HTTP acceptance carries no reading, and a
    // queued receipt therefore claims none.
    expect(receipts[0]).not.toHaveProperty("data");
    expect(receipts[2]?.data?.["quote.value"]?.state).toBe("fresh");
    expect(receipts[3]?.data?.["quote.value"]?.state).toBe("error");
  });

  it("carries no credential, host path, colour, coordinate, script, or URL in an accepted payload", () => {
    const { refused: _refused, ...values } = fixture["values"] as Record<string, unknown>;
    const accepted = JSON.stringify({
      appPre2: fixture["appPre2"], actionPre2: fixture["actionPre2"], actionRequests: fixture["actionRequests"],
      document: fixture["document"], envelope: fixture["envelope"], values, receipts: fixture["receipts"],
    });
    expect(accepted).not.toMatch(/\/Users\/|[A-Za-z]:\\/);
    expect(accepted).not.toMatch(/authorization|bearer|api[-_]?key|password|secret/i);
    // The refused list is where a colour, a coordinate, a script and a URL appear, which is the
    // whole point of it: they exist in this file only as payloads the contract turns away.
    expect(accepted).not.toMatch(/https?:|javascript:|#[0-9a-f]{6}/i);
  });
});

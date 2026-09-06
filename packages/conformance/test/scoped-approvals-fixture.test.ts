import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  ALWAYS_REQUIRE_APPROVAL_CATEGORIES,
  BOTS_CAPABILITY_ID,
  BOTS_CAPABILITY_VERSION,
  BotApprovalDecisionRequestSchema,
  BotApprovalGrantsSchema,
  BotApprovalPendingFrameSchema,
  BotApprovalScopeSchema,
  BotPendingApprovalSchema,
  assertValid,
  check,
  type BotApprovalPendingFrame,
  type BotPendingApproval,
} from "cozygateway-contract";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/scoped-approvals-v1.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

/** Capability 66, contract/ext-bots-v1.md row 66. A PORTABLE fixture: the standing-grant lifecycle
 *  needs a runtime peer and a person, so what a black-box client in any language can be held to
 *  without either is the payload shapes themselves, and above all the two pre-66 payloads that must
 *  stay exactly what they were. */
describe("scoped approvals v1 client fixture", () => {
  it("pins the capability floor a client gates the whole row on", () => {
    expect(fixture["capability"]).toEqual({ id: BOTS_CAPABILITY_ID, minimumVersion: 66 });
    expect(BOTS_CAPABILITY_VERSION).toBeGreaterThanOrEqual(66);
  });

  it("keeps a peer and a client below 66 byte identical to their pre-66 selves", () => {
    // No `scope`, no `grantId`, and no decision body: three payloads a pre-66 peer and a pre-66
    // client already produced, still valid and still carrying nothing new.
    const frame = assertValid(BotApprovalPendingFrameSchema, fixture["pendingFramePre66"]) as BotApprovalPendingFrame;
    expect(Object.keys(frame).sort()).toEqual(
      ["type", "bot", "sessionId", "turnId", "toolCallId", "name", "updatedAt"].sort(),
    );
    const row = assertValid(BotPendingApprovalSchema, fixture["inboxRowPre66"]) as BotPendingApproval;
    expect(Object.keys(row).sort()).toEqual(
      ["bot", "sessionId", "turnId", "toolCallId", "ruleName", "createdAt"].sort(),
    );
    expect(check(BotApprovalDecisionRequestSchema, (fixture["decisions"] as Record<string, unknown>)["pre66"])).toBe(true);
  });

  it("carries one validated block on the live frame and on the inbox row it comes back as", () => {
    const frame = assertValid(BotApprovalPendingFrameSchema, fixture["pendingFrame"]) as BotApprovalPendingFrame;
    const row = assertValid(BotPendingApprovalSchema, fixture["inboxRow"]) as BotPendingApproval;
    expect(JSON.stringify(frame.scope)).toBe(JSON.stringify(row.scope));
    expect(frame.scope?.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    // A frame the gateway is settling from a standing grant names it, so the decision is visible
    // rather than silent.
    const honored = assertValid(BotApprovalPendingFrameSchema, fixture["pendingFrameHonored"]) as BotApprovalPendingFrame;
    expect(honored.grantId).toBe("grant:sage:approval-0");
    // The same attribution survives a reconnect: it is on the durable record, so the cold inbox
    // read carries it and a person can revoke the grant that answered for them.
    const covered = assertValid(BotPendingApprovalSchema, fixture["inboxRowCovered"]) as BotPendingApproval;
    expect(covered.grantId).toBe(honored.grantId);
  });

  it("names the always-require categories once, and the fixture repeats the contract's list", () => {
    expect(fixture["alwaysRequire"]).toEqual([...ALWAYS_REQUIRE_APPROVAL_CATEGORIES]);
    // The money-movement approval in this fixture is on that list: a client must never offer a
    // category grant for it, whatever the peer asked for. The category is the PEER's assertion, so
    // this is a guarantee about what a declared category can be covered by, not a classifier.
    const frame = fixture["pendingFrame"] as { scope: { category: string } };
    expect(ALWAYS_REQUIRE_APPROVAL_CATEGORIES).toContain(frame.scope.category);
  });

  it("accepts both decision bodies inside their bounds and refuses everything outside them", () => {
    const decisions = fixture["decisions"] as Record<string, unknown>;
    expect(check(BotApprovalDecisionRequestSchema, decisions["once"])).toBe(true);
    expect(check(BotApprovalDecisionRequestSchema, decisions["category"])).toBe(true);
    for (const body of decisions["refused"] as unknown[])
      expect(check(BotApprovalDecisionRequestSchema, body), JSON.stringify(body)).toBe(false);
  });

  it("refuses every scope block outside the closed sets, the hash bound, or the closed object", () => {
    for (const block of fixture["refusedScopes"] as unknown[])
      expect(check(BotApprovalScopeSchema, block), JSON.stringify(block)).toBe(false);
  });

  it("renders a revocation view whose rows carry no payload hash and no deciding device", () => {
    const grants = assertValid(BotApprovalGrantsSchema, fixture["grants"]);
    expect(grants.grants.map((grant) => grant.scope)).toEqual(["category", "once"]);
    for (const grant of grants.grants) {
      expect(grant).not.toHaveProperty("payloadHash");
      expect(grant).not.toHaveProperty("deviceId");
    }
  });

  it("carries no credential, token, or host path", () => {
    const raw = JSON.stringify(fixture);
    expect(raw).not.toMatch(/\/Users\/|[A-Za-z]:\\/);
    // The one URL in this file is a REFUSED block: the closed object leaves no member for it, which
    // is exactly what that case proves.
    // `secret_access` is a CATEGORY NAME, the one place that word belongs: it says an approval is
    // about a secret, it never carries one.
    expect(raw).not.toMatch(/authorization|bearer|api[-_]?key|password|secret(?!_access)/i);
  });
});

/** The bots-channel approval frames (contract/ext-bots-v1.md, capability 10).
 *
 *  They exist BECAUSE the bots surface is a parallel path: every bots frame is keyed `bot` +
 *  `sessionId` and nothing on it touches the core threads spine, so the `approval_pending` /
 *  `approval_resolved` frames of contract v1.md section 5a cannot address a bot chat. Every field
 *  these two carry beyond that keying is copied one for one from the core pair, deliberately, so a
 *  client renders both with one view. */
import { describe, expect, it } from "vitest";

import {
  ALWAYS_REQUIRE_APPROVAL_CATEGORIES,
  BOTS_CAPABILITY_VERSION,
  BotApprovalDecisionRequestSchema,
  BotApprovalGrantSchema,
  BotApprovalGrantsSchema,
  BotApprovalScopeSchema,
  BotApprovalPendingFrameSchema,
  BotApprovalRepairSchema,
  BotApprovalResolutionRequestedFrameSchema,
  BotApprovalResolvedFrameSchema,
  BotClarifyResolutionRequestedFrameSchema,
  BotPendingApprovalSchema,
  BotPendingApprovalsSchema,
  ServerFrameSchema,
  check,
} from "../src/index.ts";

const pending = {
  type: "bot_approval_pending",
  bot: "scout",
  sessionId: "stored-1",
  turnId: "runtime-1#1-1",
  toolCallId: "4e8b2c1d9f0a4c1e8b2c1d9f0a4c1e8b",
  name: "terminal:rm",
  updatedAt: 1_800_000_000_000,
};

const resolved = {
  type: "bot_approval_resolved",
  bot: "scout",
  sessionId: "stored-1",
  turnId: "runtime-1#1-1",
  toolCallId: "4e8b2c1d9f0a4c1e8b2c1d9f0a4c1e8b",
  outcome: "approved",
  updatedAt: 1_800_000_000_000,
};

const approvalRequested = {
  type: "bot_approval_resolution_requested",
  bot: "scout",
  sessionId: "stored-1",
  turnId: "runtime-1#1-1",
  toolCallId: "4e8b2c1d9f0a4c1e8b2c1d9f0a4c1e8b",
  updatedAt: 1_800_000_000_000,
};

const clarifyRequested = {
  type: "bot_clarify_resolution_requested",
  bot: "scout",
  sessionId: "stored-1",
  turnId: "runtime-1#1-1",
  clarifyId: "question-1",
  updatedAt: 1_800_000_000_000,
};

describe("bots approval frames", () => {
  it("accepts both shapes, on their own schema and on the ServerFrame union", () => {
    expect(check(BotApprovalPendingFrameSchema, pending)).toBe(true);
    expect(check(ServerFrameSchema, pending)).toBe(true);
    expect(check(BotApprovalResolvedFrameSchema, resolved)).toBe(true);
    expect(check(ServerFrameSchema, resolved)).toBe(true);
    expect(check(BotApprovalResolutionRequestedFrameSchema, approvalRequested)).toBe(true);
    expect(check(ServerFrameSchema, approvalRequested)).toBe(true);
    expect(check(BotClarifyResolutionRequestedFrameSchema, clarifyRequested)).toBe(true);
    expect(check(ServerFrameSchema, clarifyRequested)).toBe(true);
  });

  it("requires every addressing field", () => {
    for (const field of ["bot", "sessionId", "turnId", "toolCallId", "name", "updatedAt"] as const) {
      const { [field]: _drop, ...missing } = pending;
      expect(check(BotApprovalPendingFrameSchema, missing), `${field} must be required`).toBe(false);
    }
    for (const field of ["bot", "sessionId", "turnId", "toolCallId", "outcome", "updatedAt"] as const) {
      const { [field]: _drop, ...missing } = resolved;
      expect(check(BotApprovalResolvedFrameSchema, missing), `${field} must be required`).toBe(false);
    }
  });

  it("has NO argSummary member, and no member for the hermes free-text fields", () => {
    // Not "argSummary is optional and we happen to omit it". The hermes `approval.request` event
    // carries no structured arguments to summarize (issue #19 bridge-lane ruling 1), and the
    // free-text `command` / `description` it DOES carry are never forwarded anywhere (ruling 4). A
    // frame with no such member cannot leak one, which is stronger than any validator.
    const members = Object.keys(BotApprovalPendingFrameSchema.properties);
    expect(members).not.toContain("argSummary");
    expect(members).not.toContain("command");
    expect(members).not.toContain("description");
    expect(members).toEqual(["type", "bot", "sessionId", "turnId", "toolCallId", "name", "updatedAt", "room", "detail", "repair", "scope", "grantId"]);
  });

  it("takes the three core outcomes and nothing else", () => {
    for (const outcome of ["approved", "denied", "expired"]) {
      expect(check(BotApprovalResolvedFrameSchema, { ...resolved, outcome })).toBe(true);
    }
    // `once` and `session` are native hermes choices, never wire outcomes.
    for (const outcome of ["once", "session", "always", "pending"]) {
      expect(check(BotApprovalResolvedFrameSchema, { ...resolved, outcome })).toBe(false);
    }
  });

  it("rides capability 10, and the advertised version has moved past it", () => {
    // The approval surface landed AT 10 and the number only ever goes up, so this pins the floor a
    // client must require for approve/deny while letting later, additive bumps through.
    expect(BOTS_CAPABILITY_VERSION).toBeGreaterThanOrEqual(28);
  });

  it("defines a bounded safe pending-approval inbox with no raw tool payload fields", () => {
    const item = {
      bot: "scout",
      sessionId: "stored-1",
      turnId: "runtime-1#1-1",
      toolCallId: "4e8b2c1d9f0a4c1e8b2c1d9f0a4c1e8b",
      ruleName: "terminal:rm",
      createdAt: 1_800_000_000_000,
    };
    expect(check(BotPendingApprovalSchema, item)).toBe(true);
    expect(check(BotPendingApprovalsSchema, { approvals: [item] })).toBe(true);
    // `room` (capability 51) names the group room whose member turn raised the approval. It is a
    // room NAME, which the room surface already publishes: no rule payload, no tool arguments, and
    // absent for every 1:1 row, which is every row written before 51.
    expect(Object.keys(BotPendingApprovalSchema.properties)).toEqual([
      "bot", "sessionId", "turnId", "toolCallId", "ruleName", "createdAt", "resolutionRequestedAt",
      "room", "repair", "scope",
    ]);
  });
});

/** Capability 62 (contract/ext-bots-v1.md row 62): an approval may carry one typed MCP repair
 *  proposal. The block is the shape the harness health record produces, closed sets and bounded
 *  strings, and it rides the existing pending frame and the existing inbox row unchanged otherwise. */
describe("approval repair proposal (capability 62)", () => {
  const repair = {
    kind: "mcp_reconnect",
    server: "github",
    impact: ["github_search_issues", "github_create_issue"],
    scope: "server",
    fingerprint: { previous: "sha256:1f3a", current: "sha256:9c0e" },
    reason: "stale_tool",
    policy: "approve_once",
  };
  const inboxRow = {
    bot: "scout",
    sessionId: "stored-1",
    turnId: "runtime-1#1-1",
    toolCallId: "4e8b2c1d9f0a4c1e8b2c1d9f0a4c1e8b",
    ruleName: "mcp_reconnect",
    createdAt: 1_800_000_000_000,
  };

  it("accepts the block on its own schema, on the pending frame, and on the inbox row", () => {
    expect(check(BotApprovalRepairSchema, repair)).toBe(true);
    // Nothing listed and nothing fingerprinted is still a proposal: the peer may not know either.
    expect(check(BotApprovalRepairSchema, { ...repair, impact: [], fingerprint: {} })).toBe(true);
    expect(check(BotApprovalPendingFrameSchema, { ...pending, repair })).toBe(true);
    expect(check(ServerFrameSchema, { ...pending, repair })).toBe(true);
    expect(check(BotPendingApprovalSchema, { ...inboxRow, repair })).toBe(true);
    expect(check(BotPendingApprovalsSchema, { approvals: [{ ...inboxRow, repair }] })).toBe(true);
  });

  it("holds every closed set closed", () => {
    for (const [field, value] of [
      ["kind", "restart"], ["scope", "tool"], ["reason", "bored"], ["policy", "always"],
    ] as const) {
      expect(check(BotApprovalRepairSchema, { ...repair, [field]: value }), field).toBe(false);
    }
  });

  it("holds the bounds and refuses a member the shape does not name", () => {
    expect(check(BotApprovalRepairSchema, { ...repair, server: "" })).toBe(false);
    expect(check(BotApprovalRepairSchema, { ...repair, server: "s".repeat(65) })).toBe(false);
    expect(check(BotApprovalRepairSchema, { ...repair, impact: ["t".repeat(129)] })).toBe(false);
    expect(check(BotApprovalRepairSchema, { ...repair, impact: [""] })).toBe(false);
    expect(check(BotApprovalRepairSchema, {
      ...repair, impact: Array.from({ length: 65 }, (_, i) => `tool_${i}`),
    })).toBe(false);
    expect(check(BotApprovalRepairSchema, { ...repair, fingerprint: { previous: "f".repeat(129) } })).toBe(false);
    const { fingerprint: _drop, ...noFingerprint } = repair;
    expect(check(BotApprovalRepairSchema, noFingerprint)).toBe(false);
    // Closed objects: the only place a URL, header, or env value could ride is a member the shape
    // never named, so an unnamed member fails the block outright.
    expect(check(BotApprovalRepairSchema, { ...repair, url: "https://mcp.example" })).toBe(false);
    expect(check(BotApprovalRepairSchema, {
      ...repair, fingerprint: { ...repair.fingerprint, authorization: "Bearer x" },
    })).toBe(false);
  });
});

/** Capability 66. The typed scoped-approval block, the standing grant it can leave behind, and the
 *  optional decision body that asks for one. */
describe("the scoped-approval block (capability 66)", () => {
  const scope = {
    kind: "scoped_approval",
    action: "payments.transfer",
    category: "money_movement",
    system: "stripe",
    resource: "account/acct_1",
    change: "send 40.00 USD to vendor acct_2",
    effects: ["the balance drops by 40.00 USD"],
    reason: "always_require",
    payloadHash: "0".repeat(64),
    expiresAt: 1_800_000_060_000,
    retry: "not_idempotent",
    requested: "once",
  };

  it("rides the pending frame and the inbox row as one optional block", () => {
    expect(check(BotApprovalPendingFrameSchema, { ...pending, scope })).toBe(true);
    expect(check(BotApprovalPendingFrameSchema, { ...pending, scope, grantId: "grant:scout:a-1" })).toBe(true);
    expect(check(BotPendingApprovalSchema, {
      bot: "scout", sessionId: "stored-1", turnId: "runtime-1#1-1",
      toolCallId: pending.toolCallId, ruleName: "payments.transfer", createdAt: 1, scope,
    })).toBe(true);
    // Absent is the pre-66 approval, which every earlier assertion in this file already pins.
    expect(check(BotApprovalPendingFrameSchema, pending)).toBe(true);
  });

  it("names the always-require categories once, and closes every set", () => {
    expect([...ALWAYS_REQUIRE_APPROVAL_CATEGORIES]).toEqual([
      "money_movement", "secret_access", "destructive", "lock_or_alarm", "public_publishing",
      "account_change",
    ]);
    expect(ALWAYS_REQUIRE_APPROVAL_CATEGORIES).not.toContain("other");
    for (const bad of [
      { ...scope, kind: "scoped" },
      { ...scope, category: "vibes" },
      { ...scope, reason: "because" },
      { ...scope, retry: "maybe" },
      { ...scope, requested: "forever" },
    ]) expect(check(BotApprovalScopeSchema, bad), JSON.stringify(bad)).toBe(false);
    expect(check(BotApprovalScopeSchema, scope)).toBe(true);
  });

  it("binds on a real sha256 and holds every bound, with no member to ride a secret in", () => {
    for (const bad of [
      { ...scope, payloadHash: "not-a-hash" },
      { ...scope, payloadHash: "A".repeat(64) },
      { ...scope, payloadHash: "0".repeat(63) },
      { ...scope, action: "" },
      { ...scope, action: "a".repeat(65) },
      { ...scope, resource: "r".repeat(257) },
      { ...scope, change: "c".repeat(401) },
      { ...scope, effects: [""] },
      { ...scope, effects: Array.from({ length: 17 }, (_, i) => `effect ${i}`) },
      { ...scope, expiresAt: -1 },
      { ...scope, authorization: "Bearer x" },
    ]) expect(check(BotApprovalScopeSchema, bad), JSON.stringify(bad)).toBe(false);
  });

  it("keeps the payload hash, the deciding device and the payload out of the grant a person revokes", () => {
    const grant = {
      grantId: "grant:scout:approval-1",
      scope: "category",
      action: "workspace.write",
      category: "other",
      system: "workspace",
      resource: "repo/notes.md",
      sessionId: "stored-1",
      expiresAt: 1_800_003_600_000,
      createdAt: 1_800_000_000_000,
    };
    expect(check(BotApprovalGrantSchema, grant)).toBe(true);
    expect(check(BotApprovalGrantsSchema, { grants: [grant] })).toBe(true);
    for (const bad of [
      { ...grant, scope: "always" },
      { ...grant, category: "vibes" },
    ]) expect(check(BotApprovalGrantSchema, bad), JSON.stringify(bad)).toBe(false);
    // Stronger than a validator on an open object: the shape names no member a payload hash, a
    // deciding device, or a payload value could ride out on.
    const members = Object.keys(BotApprovalGrantSchema.properties);
    expect(members).toEqual([
      "grantId", "scope", "action", "category", "system", "resource", "sessionId", "expiresAt",
      "createdAt",
    ]);
  });

  it("makes the decision body optional, closed, and unable to name anything but a scope and a bound", () => {
    expect(check(BotApprovalDecisionRequestSchema, {})).toBe(true);
    expect(check(BotApprovalDecisionRequestSchema, { grant: "once" })).toBe(true);
    expect(check(BotApprovalDecisionRequestSchema, { grant: "category", expiresAt: 1_800_003_600_000 })).toBe(true);
    for (const bad of [
      { grant: "forever" },
      { grant: "category", expiresAt: -1 },
      { grant: "category", expiresAt: 1, reason: "trust me" },
    ]) expect(check(BotApprovalDecisionRequestSchema, bad), JSON.stringify(bad)).toBe(false);
  });

  it("pins the capability floor a client gates the whole row on", () => {
    expect(BOTS_CAPABILITY_VERSION).toBeGreaterThanOrEqual(66);
  });
});

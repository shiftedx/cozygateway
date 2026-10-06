/** Approval lifecycle, contract v1.x additive surface (issue #19, core lane).
 *
 *  The scope guard carried verbatim from the proposal is the reason half of this file exists:
 *  `argSummary` is key NAMES and type TAGS only, and the schema is where that is ENFORCED. A
 *  free-string value would let a raw `rm -rf /` ride the frame and still validate. */
import { describe, expect, it } from "vitest";

import {
  APPROVALS_CAPABILITY_ID,
  APPROVALS_CAPABILITY_VERSION,
  ApprovalArgSummarySchema,
  ApprovalOutcomeSchema,
  ApprovalPendingFrameSchema,
  ApprovalResolveResponseSchema,
  ApprovalResolvedFrameSchema,
  ERROR_CODES,
  ServerFrameSchema,
  check,
} from "../src/index.ts";

const pending = {
  type: "approval_pending",
  threadId: "th_1",
  turnId: "t_5",
  toolCallId: "call_1",
  name: "run_shell",
  argSummary: { command: "string", timeout: "number" },
};

const resolved = {
  type: "approval_resolved",
  threadId: "th_1",
  turnId: "t_5",
  toolCallId: "call_1",
  outcome: "approved",
};

describe("approval frames", () => {
  it("accepts a full approval_pending frame", () => {
    expect(check(ApprovalPendingFrameSchema, pending)).toBe(true);
    expect(check(ServerFrameSchema, pending)).toBe(true);
  });

  it("accepts an approval_pending frame with no argSummary at all", () => {
    const { argSummary: _drop, ...bare } = pending;
    expect(check(ApprovalPendingFrameSchema, bare)).toBe(true);
    expect(check(ServerFrameSchema, bare)).toBe(true);
  });

  it("requires threadId, turnId, toolCallId and name", () => {
    for (const field of ["threadId", "turnId", "toolCallId", "name"] as const) {
      const { [field]: _drop, ...missing } = pending;
      expect(check(ApprovalPendingFrameSchema, missing), `${field} must be required`).toBe(false);
    }
  });

  it("accepts every terminal outcome on approval_resolved, and nothing else", () => {
    for (const outcome of ["approved", "denied", "expired"]) {
      expect(check(ApprovalResolvedFrameSchema, { ...resolved, outcome })).toBe(true);
      expect(check(ApprovalOutcomeSchema, outcome)).toBe(true);
    }
    expect(check(ApprovalResolvedFrameSchema, { ...resolved, outcome: "timeout" })).toBe(false);
    expect(check(ApprovalResolvedFrameSchema, { ...resolved, outcome: "pending" })).toBe(false);
  });

  it("keeps expired distinguishable from denied on the wire", () => {
    const expired = { ...resolved, outcome: "expired" };
    const denied = { ...resolved, outcome: "denied" };
    expect(check(ApprovalResolvedFrameSchema, expired)).toBe(true);
    expect(check(ApprovalResolvedFrameSchema, denied)).toBe(true);
    expect(expired.outcome).not.toBe(denied.outcome);
  });

  it("is part of the ServerFrame union, so a client validating frames generically sees it", () => {
    expect(check(ServerFrameSchema, resolved)).toBe(true);
  });
});

describe("argSummary is names and type tags only", () => {
  it("accepts the closed tag vocabulary", () => {
    for (const tag of ["string", "number", "boolean", "object", "array", "null"]) {
      expect(check(ApprovalArgSummarySchema, { arg: tag }), `${tag} should be a legal tag`).toBe(
        true,
      );
    }
  });

  it("REJECTS a raw argument value smuggled in as a summary value", () => {
    expect(check(ApprovalArgSummarySchema, { command: "rm -rf /" })).toBe(false);
    expect(check(ApprovalPendingFrameSchema, { ...pending, argSummary: { command: "rm -rf /" } })).toBe(
      false,
    );
    expect(check(ServerFrameSchema, { ...pending, argSummary: { command: "rm -rf /" } })).toBe(false);
  });

  it("rejects a non-string summary value (no nested payloads either)", () => {
    expect(check(ApprovalArgSummarySchema, { command: 1 })).toBe(false);
    expect(check(ApprovalArgSummarySchema, { command: { type: "string" } })).toBe(false);
  });

  it("accepts an empty summary", () => {
    expect(check(ApprovalArgSummarySchema, {})).toBe(true);
  });
});

describe("approve/deny REST response", () => {
  it("accepts the two resolve statuses and nothing else", () => {
    expect(check(ApprovalResolveResponseSchema, { status: "approved" })).toBe(true);
    expect(check(ApprovalResolveResponseSchema, { status: "denied" })).toBe(true);
    // "expired" is an OUTCOME the gateway reports on a frame, never a status a client's own
    // resolve call produced: resolving an expired approval is an error, not a success.
    expect(check(ApprovalResolveResponseSchema, { status: "expired" })).toBe(false);
    expect(check(ApprovalResolveResponseSchema, {})).toBe(false);
  });
});

describe("approval error codes", () => {
  it("adds the two approval codes to the frozen list (an additive v1.x minor bump)", () => {
    expect(ERROR_CODES).toContain("approval_not_pending");
    expect(ERROR_CODES).toContain("approval_expired");
  });

  it("keeps every pre-existing code (additive only, nothing removed or renamed)", () => {
    for (const code of [
      "unauthorized",
      "not_found",
      "invalid_request",
      "setup_code_invalid",
      "thread_archived",
      "backend_unavailable",
      "turn_failed",
      "interrupt_unsupported",
      "internal",
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});

describe("approvals capability", () => {
  it("is a CORE capability id (no vendor reverse-DNS prefix) at version 1", () => {
    expect(APPROVALS_CAPABILITY_ID).toBe("approvals");
    expect(APPROVALS_CAPABILITY_ID.includes(".")).toBe(false);
    expect(APPROVALS_CAPABILITY_VERSION).toBe(1);
  });
});

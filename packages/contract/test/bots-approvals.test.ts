/** The bots-channel approval frames (contract/ext-bots-v1.md, capability 10).
 *
 *  They exist BECAUSE the bots surface is a parallel path: every bots frame is keyed `bot` +
 *  `sessionId` and nothing on it touches the core threads spine, so the `approval_pending` /
 *  `approval_resolved` frames of contract v1.md section 5a cannot address a bot chat. Every field
 *  these two carry beyond that keying is copied one for one from the core pair, deliberately, so a
 *  client renders both with one view. */
import { describe, expect, it } from "vitest";

import {
  BOTS_CAPABILITY_VERSION,
  BotApprovalPendingFrameSchema,
  BotApprovalResolvedFrameSchema,
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

describe("bots approval frames", () => {
  it("accepts both shapes, on their own schema and on the ServerFrame union", () => {
    expect(check(BotApprovalPendingFrameSchema, pending)).toBe(true);
    expect(check(ServerFrameSchema, pending)).toBe(true);
    expect(check(BotApprovalResolvedFrameSchema, resolved)).toBe(true);
    expect(check(ServerFrameSchema, resolved)).toBe(true);
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
    expect(members).toEqual(["type", "bot", "sessionId", "turnId", "toolCallId", "name", "updatedAt"]);
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

  it("rides capability 10", () => {
    expect(BOTS_CAPABILITY_VERSION).toBe(10);
  });
});

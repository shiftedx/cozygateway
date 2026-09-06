import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { BOTS_CAPABILITY_ID, BOTS_CAPABILITY_VERSION, check } from "cozygateway-contract";

import {
  AttachV1ClientFrameSchema,
  AttachV1HelloSchema,
  type AttachV1Hello,
} from "../../gateway/src/adapters/attach/protocol-v1.ts";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/stale-turn-reconciliation-v1.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

/** Capability 69, contract/ext-bots-v1.md row 69 and contract/attach-v1.md. A PORTABLE fixture:
 *  the reconciliation itself needs a peer that can drop a turn and re-attach, so what any peer in
 *  any language can be held to without one is the two frames it may now send, the bound on them,
 *  and above all that the frames it already sent are untouched.
 *
 *  The promotion trigger is the second of those frames: a `failed` carrying `reason:
 *  "unknown_turn"` is a peer saying it was handed a steer for a turn it does not hold, which is
 *  what makes the gateway seal that turn and promote the person's words into a new durable turn. */
describe("stale turn reconciliation v1 peer fixture", () => {
  it("pins the capability floor a peer gates both new fields on", () => {
    expect(fixture["capability"]).toEqual({ id: BOTS_CAPABILITY_ID, minimumVersion: 69 });
    expect(BOTS_CAPABILITY_VERSION).toBeGreaterThanOrEqual(69);
  });

  it("keeps a peer below 69 byte identical to its pre-69 self", () => {
    const hello = fixture["helloPre69"] as Record<string, unknown>;
    expect(check(AttachV1HelloSchema, hello)).toBe(true);
    expect(Object.keys(hello)).not.toContain("activeTurns");
    // An ordinary failure carries no reason, and never has to.
    const failed = fixture["failedPre69"] as Record<string, unknown>;
    expect(check(AttachV1ClientFrameSchema, failed)).toBe(true);
    expect(Object.keys(failed["event"] as Record<string, unknown>)).not.toContain("reason");
  });

  it("accepts both declarations, and they are different answers", () => {
    const none = fixture["helloCarryingNoTurns"] as AttachV1Hello;
    const one = fixture["helloCarryingOneTurn"] as AttachV1Hello;
    expect(check(AttachV1HelloSchema, none)).toBe(true);
    expect(check(AttachV1HelloSchema, one)).toBe(true);
    // An EMPTY array is the declaration "I hold none", which is a fact. An ABSENT field is a peer
    // that cannot declare, which is not. A peer must never send one meaning the other.
    expect(none.activeTurns).toEqual([]);
    expect(one.activeTurns).toEqual(["turn-still-running"]);
    expect((fixture["helloPre69"] as AttachV1Hello).activeTurns).toBeUndefined();
  });

  it("refuses a declaration that repeats a turn id", () => {
    expect(check(AttachV1HelloSchema, fixture["helloWithDuplicateTurns"])).toBe(false);
  });

  it("carries the typed unknown-turn failure that triggers promotion, and only that reason", () => {
    expect(check(AttachV1ClientFrameSchema, fixture["failedUnknownTurn"])).toBe(true);
    // The set is CLOSED: a peer cannot invent a reason and have the gateway act on it.
    expect(check(AttachV1ClientFrameSchema, fixture["failedUnknownReason"])).toBe(false);
  });
});

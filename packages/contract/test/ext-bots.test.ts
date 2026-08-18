import { describe, expect, it } from "vitest";

import type { BotSummary, ServerFrame } from "../src/index.ts";
import {
  BOTS_CAPABILITY_ID,
  BOTS_CAPABILITY_VERSION,
  BotFocusRequestSchema,
  BotSummarySchema,
  ServerFrameSchema,
  check,
} from "../src/index.ts";

const bot: BotSummary = {
  name: "scout",
  displayName: "Scout",
  handle: "scout",
  description: "watches CI",
  hasAvatar: true,
  group: "Ops",
  pinned: false,
  active: true,
  lastActiveAt: 1_800_000_000_000,
  chatSessionId: "sess-1",
  preview: { kind: "a2a", text: "the build is green", sender: "luna" },
  meta: { title: "Scout", created: 1_799_000_000_000 },
};

describe("bot summary", () => {
  it("accepts a full row and one with every nullable field empty", () => {
    expect(check(BotSummarySchema, bot)).toBe(true);
    expect(
      check(BotSummarySchema, {
        ...bot,
        description: null,
        group: null,
        lastActiveAt: null,
        chatSessionId: null,
        meta: null,
        preview: { kind: "empty", text: "" },
      }),
    ).toBe(true);
  });

  it("rejects an unknown preview kind", () => {
    expect(check(BotSummarySchema, { ...bot, preview: { kind: "toast", text: "x" } })).toBe(false);
  });
});

describe("bots server frames", () => {
  it("are members of the server frame union", () => {
    const frames: ServerFrame[] = [
      { type: "bot_roster", bots: [bot], updatedAt: 1 },
      { type: "bot_presence", active: ["scout"], updatedAt: 1 },
    ];
    for (const frame of frames) expect(check(ServerFrameSchema, frame)).toBe(true);
  });

  it("still rejects an unknown frame type, since the union stays closed", () => {
    expect(check(ServerFrameSchema, { type: "bot_routines", jobs: [] })).toBe(false);
  });
});

describe("focus request", () => {
  it("accepts the two screens and null, and nothing else", () => {
    expect(check(BotFocusRequestSchema, { screen: "roster" })).toBe(true);
    expect(check(BotFocusRequestSchema, { screen: "routines" })).toBe(true);
    expect(check(BotFocusRequestSchema, { screen: null })).toBe(true);
    expect(check(BotFocusRequestSchema, { screen: "kitchen" })).toBe(false);
    expect(check(BotFocusRequestSchema, {})).toBe(false);
  });
});

describe("capability advertisement", () => {
  it("is a vendor-scoped id with an integer version", () => {
    expect(BOTS_CAPABILITY_ID).toBe("com.cozylabs.bots");
    // Bumped for the write route and the chat frames: a v1 gateway 404s the composer.
    expect(BOTS_CAPABILITY_VERSION).toBe(2);
  });
});

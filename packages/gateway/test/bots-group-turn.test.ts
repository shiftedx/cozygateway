import { describe, expect, it } from "vitest";

import { settledGroupTurn } from "../src/hermes-bridge/group-turn.ts";
import type { BotGroupTurnRow } from "../src/storage.ts";

const row = (state: BotGroupTurnRow["state"], extra: Partial<BotGroupTurnRow> = {}): BotGroupTurnRow => ({
  key: "launch", turnId: "turn", member: "scout", agentId: "scout", threadId: "group:launch:scout",
  messageId: "message", epoch: 1, watermark: 2, state, createdAt: 1, ...extra,
});

describe("native group turn settlement", () => {
  it("turns attach commit text into a spoken answer and empty commits into a pass", () => {
    expect(settledGroupTurn(row("commit", { text: "  ready  " }))).toEqual({ outcome: "spoke", text: "ready" });
    expect(settledGroupTurn(row("commit", { text: " " }))).toEqual({ outcome: "pass" });
  });

  it("does not settle pending rows and preserves terminal failure truth", () => {
    expect(settledGroupTurn(row("pending"))).toBeUndefined();
    expect(settledGroupTurn(row("failed", { detail: "runner stopped" }))).toEqual({ outcome: "failed", detail: "runner stopped" });
    expect(settledGroupTurn(row("timeout", { detail: "no reply" }))).toEqual({ outcome: "timeout", detail: "no reply" });
  });
});

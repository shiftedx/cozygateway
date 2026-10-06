import { describe, expect, it } from "vitest";
import { roomApprovalPush } from "../src/push-crypto.ts";
import { openStorage } from "../src/storage.ts";

describe("F18b room delivery provenance", () => {
  it("maps pending and resolved room approvals without exposing cause or tool details in routing", () => {
    const frame = { type: "bot_approval_pending" as const, bot: "sage", sessionId: "group:launch:sage", turnId: "t", toolCallId: "call", name: "send_file", room: "Launch", updatedAt: 1, cause: { kind: "user" as const, seq: 1 }, detail: "private filename" };
    expect(roomApprovalPush(frame)).toEqual({ kind: "approval_pending", threadId: "group:Launch", agentId: "sage", turnId: "t", toolCallId: "call", name: "send_file" });
    expect(roomApprovalPush({ ...frame, type: "bot_approval_resolved", outcome: "approved" })).toEqual({ kind: "approval_resolved", threadId: "group:Launch", agentId: "sage", turnId: "t", toolCallId: "call", outcome: "approved" });
    const { room: _, ...chat } = frame;
    expect(roomApprovalPush(chat)).toBeUndefined();
  });

  it("round trips legacy room entries without inventing writing provenance", () => {
    const storage = openStorage(":memory:");
    try {
      storage.createBotGroup({ key: "legacy", name: "Legacy", members: ["sage"], createdAt: 1 });
      const row = storage.appendBotGroupMessage("legacy", { kind: "member", name: "sage", displayName: "Sage", text: "old reply", at: 1 });
      expect(storage.botGroupLog("legacy")).toEqual([row]);
      expect(row).not.toHaveProperty("turnId");
      expect(row).not.toHaveProperty("cause");
    } finally { storage.close(); }
  });
});

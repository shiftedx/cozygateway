import { describe, expect, it } from "vitest";

import { parseSessionList } from "../src/hermes-bridge/canonical-chat.ts";
import { parseChatSnapshot } from "../src/hermes-bridge/chat-messages.ts";
import { inboxMessages, inboxThread } from "../src/hermes-bridge/inbox.ts";

describe("agent inbox projection", () => {
  it("uses normalized session metadata and the shared clean a2a preview", () => {
    const row = parseSessionList({
      sessions: [
        {
          id: "delivery",
          preview: "Message from 🤖 pixel (@pixel): deploy is green",
          created_at: 1_799_999_980,
          last_active: "1799999999",
          message_count: "2",
        },
      ],
    })[0]!;

    expect(inboxThread(row, row.messageCount ?? 0)).toEqual({
      id: "delivery",
      peers: ["pixel"],
      startedAt: 1_799_999_980_000,
      lastActiveAt: 1_799_999_999_000,
      preview: "deploy is green",
      messageCount: 2,
    });
  });

  it("attributes every transcript line to its agent in the group-room shape", () => {
    const snapshot = parseChatSnapshot(
      {
        messages: [
          { role: "user", text: "Message from agent 'pixel': status?", timestamp: 1_799_999_990 },
          { role: "assistant", text: "Green.", timestamp: 1_799_999_991 },
          { role: "tool", text: "internal machinery", timestamp: 1_799_999_992 },
        ],
      },
      "delivery",
    );

    expect(inboxMessages(snapshot, "scout", (name) => `${name}!`)).toEqual([
      {
        seq: 1,
        from: { kind: "member", name: "pixel", displayName: "pixel!" },
        text: "status?",
        at: 1_799_999_990_000,
      },
      {
        seq: 2,
        from: { kind: "member", name: "scout", displayName: "scout!" },
        text: "Green.",
        at: 1_799_999_991_000,
      },
    ]);
  });
});

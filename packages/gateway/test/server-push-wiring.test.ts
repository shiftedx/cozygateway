import { describe, expect, it } from "vitest";

import { createChatMessagePushHandler } from "../src/server.ts";

describe("bot chat push server wiring", () => {
  it("passes the bridge event and the hub's current connected-device snapshot to the notifier", () => {
    const event = {
      bot: "scout",
      displayName: "Scout",
      messageId: "m1",
      chatSessionId: "stored-1",
      preview: "the reply",
    };
    const connected = new Set(["phone"]);
    const calls: unknown[] = [];
    const handler = createChatMessagePushHandler(
      { notifyChatMessage: (...args: unknown[]) => calls.push(args) },
      () => connected,
    );
    handler(event);
    expect(calls).toEqual([[event, connected]]);
  });
});

import { describe, expect, it } from "vitest";

import { createChatMessagePushHandler, createMobileNodeWakeHandler } from "../src/server.ts";

describe("bot chat push server wiring", () => {
  it("excludes both connected devices and devices covered by a Live Activity", () => {
    const event = {
      bot: "scout",
      displayName: "Scout",
      messageId: "m1",
      chatSessionId: "stored-1",
      preview: "the reply",
    };
    const connected = new Set(["phone"]);
    const liveActivity = new Set(["tablet"]);
    const calls: unknown[] = [];
    const handler = createChatMessagePushHandler(
      { notifyChatMessage: (...args: unknown[]) => calls.push(args) },
      () => connected,
      () => liveActivity,
    );
    handler(event);
    expect(calls).toEqual([[event, new Set(["phone", "tablet"])]]);
  });
});

describe("mobile-node wake server wiring", () => {
  it("returns the notifier's registration scheduling decision to the broker", () => {
    const calls: string[] = [];
    const wake = createMobileNodeWakeHandler({
      notifyMobileNodeWake: (deviceId) => {
        calls.push(deviceId);
        return deviceId === "registered";
      },
    });

    expect(wake("registered")).toBe(true);
    expect(wake("missing")).toBe(false);
    expect(calls).toEqual(["registered", "missing"]);
  });
});

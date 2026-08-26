import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

describe("mobile sharing receipts", () => {
  it("persists metadata once per requestId and scopes history to the originating conversation", () => {
    const storage = openStorage(":memory:");
    try {
      const receipt = {
        requestId: "request-1",
        bot: "sage",
        sessionId: "session-1",
        turnId: "turn-1",
        command: "location.current" as const,
        sharedDescription: "Approximate location" as const,
        purpose: "Find nearby coffee",
        sharedAt: 1_000,
      };
      expect(storage.recordBotMobileReceipt(receipt)).toEqual(receipt);
      expect(storage.recordBotMobileReceipt({
        ...receipt,
        sessionId: "forged-session",
        purpose: "Changed purpose",
        sharedAt: 2_000,
      })).toBeUndefined();

      expect(storage.nativeBotMobileReceipts("sage", "session-1")).toEqual([receipt]);
      expect(storage.nativeBotMobileReceipts("sage", "forged-session")).toEqual([]);
      expect(JSON.stringify(storage.nativeBotMobileReceipts("sage", "session-1")))
        .not.toMatch(/lease|deviceId|latitude|longitude|result/i);
    } finally {
      storage.close();
    }
  });
});

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

  it("persists a receipt for every phone-node command", () => {
    const storage = openStorage(":memory:");
    try {
      const receipts = [
        ["device.status", "Device status"],
        ["location.current", "Approximate location"],
        ["camera.capture", "Camera photo"],
        ["camera.capture", "Camera video"],
        ["file.pick", "Selected photo"],
        ["file.pick", "Selected file"],
        ["notification.present", "Notification action"],
      ] as const;

      for (const [index, [command, sharedDescription]] of receipts.entries()) {
        expect(storage.recordBotMobileReceipt({
          requestId: `request-${index}`,
          bot: "cleo",
          sessionId: "session-1",
          turnId: "turn-1",
          command,
          sharedDescription,
          purpose: "Acceptance test",
          sharedAt: 1_000 + index,
        })).toMatchObject({ command, sharedDescription });
      }
    } finally {
      storage.close();
    }
  });

});

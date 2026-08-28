import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

  it("migrates the original receipt constraints without losing existing rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-mobile-receipts-"));
    const dbPath = join(directory, "gateway.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE bot_mobile_receipts (
        request_id TEXT PRIMARY KEY,
        bot TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        command TEXT NOT NULL CHECK (command IN ('device.status', 'location.current')),
        shared_description TEXT NOT NULL CHECK (shared_description IN ('Device status', 'Approximate location')),
        purpose TEXT NOT NULL,
        shared_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX bot_mobile_receipts_session
        ON bot_mobile_receipts (bot, session_id, shared_at, request_id);
      INSERT INTO bot_mobile_receipts VALUES
        ('existing', 'cleo', 'session-1', 'turn-1', 'device.status', 'Device status', 'Preflight', 1000);
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const storage = openStorage(dbPath);
    try {
      expect(storage.nativeBotMobileReceipts("cleo", "session-1")).toHaveLength(1);
      expect(storage.recordBotMobileReceipt({
        requestId: "notification",
        bot: "cleo",
        sessionId: "session-1",
        turnId: "turn-2",
        command: "notification.present",
        sharedDescription: "Notification action",
        purpose: "Choose an action",
        sharedAt: 2_000,
      })).toMatchObject({ command: "notification.present" });
      expect(storage.nativeBotMobileReceipts("cleo", "session-1")).toHaveLength(2);
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

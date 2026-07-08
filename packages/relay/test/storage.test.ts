import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import {
  CIPHERTEXT_MAX_LENGTH,
  NotifyRequestSchema,
  RegisterRequestSchema,
  relayError,
} from "../src/schemas.ts";
import { openRelayStorage, utcDay, type RelayStorage } from "../src/storage.ts";

const MAX_REGISTRATIONS = 10000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function memoryStorage(): RelayStorage {
  const storage = openRelayStorage(":memory:");
  cleanups.push(() => storage.close());
  return storage;
}

describe("schemas", () => {
  it("accepts a webhook register request and rejects unknown platforms", () => {
    expect(Value.Check(RegisterRequestSchema, { platform: "webhook", token: "https://x.example/hook" })).toBe(true);
    expect(Value.Check(RegisterRequestSchema, { platform: "apns", token: "abc" })).toBe(true);
    expect(Value.Check(RegisterRequestSchema, { platform: "smoke-signal", token: "abc" })).toBe(false);
    expect(Value.Check(RegisterRequestSchema, { platform: "webhook", token: "" })).toBe(false);
  });

  it("bounds notify ciphertext length", () => {
    expect(Value.Check(NotifyRequestSchema, { pushId: "p", ciphertext: "c" })).toBe(true);
    expect(Value.Check(NotifyRequestSchema, { pushId: "p", ciphertext: "x".repeat(CIPHERTEXT_MAX_LENGTH + 1) })).toBe(false);
  });

  it("builds the error envelope", () => {
    expect(relayError("not_found", "nope")).toEqual({ error: { code: "not_found", message: "nope" } });
  });
});

describe("relay storage", () => {
  it("saves, fetches, and deletes registrations; delete is idempotent", () => {
    const storage = memoryStorage();
    storage.saveRegistration(
      { pushId: "p1", platform: "webhook", token: "https://x.example/hook", createdAt: 111 },
      MAX_REGISTRATIONS,
    );
    expect(storage.registrationByPushId("p1")).toEqual({ pushId: "p1", platform: "webhook", token: "https://x.example/hook" });
    expect(storage.registrationByPushId("missing")).toBeUndefined();
    storage.deleteRegistration("p1");
    expect(storage.registrationByPushId("p1")).toBeUndefined();
    storage.deleteRegistration("p1");
  });

  it("refuses a new registration beyond the configured cap", () => {
    const storage = memoryStorage();
    expect(storage.saveRegistration({ pushId: "p1", platform: "webhook", token: "t1", createdAt: 1 }, 2)).toBe(true);
    expect(storage.saveRegistration({ pushId: "p2", platform: "webhook", token: "t2", createdAt: 2 }, 2)).toBe(true);
    expect(storage.saveRegistration({ pushId: "p3", platform: "webhook", token: "t3", createdAt: 3 }, 2)).toBe(false);
    expect(storage.registrationByPushId("p3")).toBeUndefined();
    expect(storage.registrationCount()).toBe(2);
  });

  it("does not refuse re-registering (upserting) an existing pushId, even at the cap", () => {
    const storage = memoryStorage();
    expect(storage.saveRegistration({ pushId: "p1", platform: "webhook", token: "t1", createdAt: 1 }, 1)).toBe(true);
    // Already at the cap of 1, but this is a refresh of an existing pushId, not a new row.
    expect(storage.saveRegistration({ pushId: "p1", platform: "webhook", token: "t1-refreshed", createdAt: 2 }, 1)).toBe(
      true,
    );
    expect(storage.registrationByPushId("p1")).toEqual({ pushId: "p1", platform: "webhook", token: "t1-refreshed" });
    expect(storage.registrationCount()).toBe(1);
  });

  it("counts total registrations", () => {
    const storage = memoryStorage();
    expect(storage.registrationCount()).toBe(0);
    storage.saveRegistration({ pushId: "p1", platform: "webhook", token: "t1", createdAt: 1 }, MAX_REGISTRATIONS);
    storage.saveRegistration({ pushId: "p2", platform: "webhook", token: "t2", createdAt: 2 }, MAX_REGISTRATIONS);
    expect(storage.registrationCount()).toBe(2);
  });

  it("counts notifies per push id per day", () => {
    const storage = memoryStorage();
    expect(storage.notifyCount("p1", "2026-07-07")).toBe(0);
    storage.incrementNotifyCount("p1", "2026-07-07");
    storage.incrementNotifyCount("p1", "2026-07-07");
    storage.incrementNotifyCount("p1", "2026-07-08");
    storage.incrementNotifyCount("p2", "2026-07-07");
    expect(storage.notifyCount("p1", "2026-07-07")).toBe(2);
    expect(storage.notifyCount("p1", "2026-07-08")).toBe(1);
    expect(storage.notifyCount("p2", "2026-07-07")).toBe(1);
  });

  it("persists registrations across a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-storage-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, "relay.db");
    const first = openRelayStorage(dbPath);
    first.saveRegistration(
      { pushId: "p1", platform: "webhook", token: "https://x.example/hook", createdAt: 1 },
      MAX_REGISTRATIONS,
    );
    first.close();
    const second = openRelayStorage(dbPath);
    cleanups.push(() => second.close());
    expect(second.registrationByPushId("p1")).toEqual({ pushId: "p1", platform: "webhook", token: "https://x.example/hook" });
  });

  it("formats UTC days", () => {
    expect(utcDay(Date.UTC(2026, 6, 7, 0, 0, 1))).toBe("2026-07-07");
    expect(utcDay(Date.UTC(2026, 6, 7, 23, 59, 59))).toBe("2026-07-07");
    expect(utcDay(Date.UTC(2026, 6, 8, 0, 0, 0))).toBe("2026-07-08");
  });

  describe("pruneNotifyCounts", () => {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 6, 7, 12, 0, 0); // 2026-07-07 noon UTC

    it("deletes notify_counts rows older than the retention window and keeps the rest", () => {
      const storage = memoryStorage();
      const day = (offsetDays: number): string => utcDay(now - offsetDays * MS_PER_DAY);
      storage.incrementNotifyCount("old", day(10)); // 10 days old: older than the 7-day window
      storage.incrementNotifyCount("old", day(8)); // 8 days old: older than the 7-day window
      storage.incrementNotifyCount("recent", day(1)); // 1 day old: within the window
      storage.incrementNotifyCount("today", day(0)); // today: within the window

      const removed = storage.pruneNotifyCounts(now);

      expect(removed).toBe(2);
      expect(storage.notifyCount("old", day(10))).toBe(0);
      expect(storage.notifyCount("old", day(8))).toBe(0);
      expect(storage.notifyCount("recent", day(1))).toBe(1);
      expect(storage.notifyCount("today", day(0))).toBe(1);
    });

    it("does not delete anything when all rows are within the retention window", () => {
      const storage = memoryStorage();
      storage.incrementNotifyCount("p1", utcDay(now));
      expect(storage.pruneNotifyCounts(now)).toBe(0);
      expect(storage.notifyCount("p1", utcDay(now))).toBe(1);
    });

    it("is a no-op on an empty table", () => {
      const storage = memoryStorage();
      expect(storage.pruneNotifyCounts(now)).toBe(0);
    });
  });
});

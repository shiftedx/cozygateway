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
    storage.saveRegistration({ pushId: "p1", platform: "webhook", token: "https://x.example/hook", createdAt: 111 });
    expect(storage.registrationByPushId("p1")).toEqual({ pushId: "p1", platform: "webhook", token: "https://x.example/hook" });
    expect(storage.registrationByPushId("missing")).toBeUndefined();
    storage.deleteRegistration("p1");
    expect(storage.registrationByPushId("p1")).toBeUndefined();
    storage.deleteRegistration("p1");
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
    first.saveRegistration({ pushId: "p1", platform: "webhook", token: "https://x.example/hook", createdAt: 1 });
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
});

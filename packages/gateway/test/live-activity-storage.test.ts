import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { LiveActivityNotifier } from "../src/live-activity-notifier.ts";
import { openStorage } from "../src/storage.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("live activity storage migration", () => {
  it("retires legacy duplicates before enforcing one card per device conversation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-live-activity-"));
    const path = join(directory, "gateway.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, last_seen_at INTEGER
      ) STRICT;
      CREATE TABLE live_activity_registrations (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        activity_id TEXT NOT NULL, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        bot TEXT NOT NULL, push_id TEXT NOT NULL, event_sequence INTEGER NOT NULL DEFAULT 0,
        last_timestamp INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, activity_id)
      ) STRICT;
      INSERT INTO devices (id, name, token_hash, created_at)
      VALUES ('device', 'phone', 'hash', 1);
    `);
    const insert = legacy.prepare(`
      INSERT INTO live_activity_registrations
        (device_id, activity_id, run_id, conversation_id, bot, push_id, created_at)
      VALUES ('device', ?, ?, 'session', 'sage', ?, ?)
    `);
    for (let index = 0; index < 10; index += 1) {
      insert.run(`activity-${index}`, `run-${index}`, `push-${index}`, index);
    }
    legacy.close();

    const storage = openStorage(path);
    expect(storage.liveActivityRegistrations("sage")).toMatchObject([
      { activityId: "activity-9", pushId: "push-9" },
    ]);
    expect(storage.liveActivityRelayDeletions(20)).toEqual([
      "push-0", "push-1", "push-2", "push-3", "push-4",
      "push-5", "push-6", "push-7", "push-8",
    ]);

    const notifications: string[] = [];
    const notifier = new LiveActivityNotifier({
      storage, relayBaseUrl: "https://relay.test",
      fetchImpl: async (_input, init) => {
        notifications.push(JSON.parse(String(init?.body)).pushId);
        return new Response(null, { status: 202 });
      },
    });
    notifier.handleFrame({ type: "bot_chat_state", bot: "sage", sessionId: "session",
      phase: "polling", running: true, inflight: true, updatedAt: 1 } as ServerFrame);
    await tick();
    expect(notifications).toEqual(["push-9"]);

    const invariant = new DatabaseSync(path);
    expect(() => invariant.prepare(`
      INSERT INTO live_activity_registrations
        (device_id, activity_id, run_id, conversation_id, bot, push_id, created_at)
      VALUES ('device', 'duplicate', 'run', 'session', 'sage', 'duplicate-push', 20)
    `).run()).toThrow(/UNIQUE constraint failed/);
    invariant.close();
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("conditionally deletes only the relay registration version it was asked to retire", () => {
    const storage = openStorage(":memory:");
    storage.createDevice({ id: "device", name: "phone", tokenHash: "hash", createdAt: 1 });
    storage.saveLiveActivityRegistration({ deviceId: "device", activityId: "activity", runId: "old",
      conversationId: "session", bot: "sage", pushId: "old-push", createdAt: 1 });
    storage.saveLiveActivityRegistration({ deviceId: "device", activityId: "activity", runId: "new",
      conversationId: "session", bot: "sage", pushId: "new-push", createdAt: 2 });

    expect(storage.deleteLiveActivityRegistration("device", "activity", {
      expectedPushId: "old-push", queuedAt: 50,
    })).toBeUndefined();
    expect(storage.liveActivityRegistration("device", "activity")).toMatchObject({
      runId: "new", pushId: "new-push",
    });
    expect(storage.liveActivityRelayDeletions(10)).toEqual(["old-push"]);

    expect(storage.deleteLiveActivityRegistration("device", "activity", {
      expectedPushId: "new-push", queuedAt: 50,
    })).toMatchObject({ pushId: "new-push" });
    expect(storage.liveActivityRegistration("device", "activity")).toBeUndefined();
    expect(storage.liveActivityRelayDeletions(10)).toEqual(["old-push", "new-push"]);
    storage.close();
  });
});

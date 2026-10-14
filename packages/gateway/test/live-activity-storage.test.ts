import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

describe("live activity storage", () => {
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

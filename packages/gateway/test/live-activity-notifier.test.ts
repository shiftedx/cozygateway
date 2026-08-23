import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { LiveActivityNotifier } from "../src/live-activity-notifier.ts";
import { openStorage } from "../src/storage.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("live activity notifier", () => {
  it("keeps one ActivityKit conversation card across consecutive bot replies", async () => {
    const storage = openStorage(":memory:");
    storage.createDevice({ id: "device", name: "phone", tokenHash: "hash", createdAt: 1 });
    storage.saveLiveActivityRegistration({
      deviceId: "device", activityId: "activity", runId: "run", conversationId: "s",
      bot: "sage", pushId: "opaque", createdAt: 1,
    });
    const bodies: unknown[] = [];
    const notifier = new LiveActivityNotifier({
      storage, relayBaseUrl: "https://relay.test", now: () => 10_000,
      fetchImpl: async (_input, init) => {
        if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)));
        return new Response(null, { status: init?.method === "DELETE" ? 204 : 202 });
      },
    });

    // A replayed history snapshot can contain an old assistant row. It is not a settled-turn edge.
    notifier.handleFrame({ type: "bot_chat", bot: "sage", messages: [
      { id: "old", role: "assistant", text: "sensitive old answer", at: 1 },
    ] } as ServerFrame);
    await tick();
    expect(bodies).toHaveLength(0);

    notifier.handleFrame({ type: "bot_chat_state", bot: "sage", sessionId: "s", phase: "polling",
      running: true, inflight: true, updatedAt: 2 } as ServerFrame);
    await tick();
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0])).not.toContain("sensitive");
    expect(bodies[0]).toMatchObject({ pushId: "opaque", liveActivity: {
      event: "update", priority: 5, contentState: { phase: "thinking", eventSequence: 1 },
    } });

    notifier.handleFrame({ type: "bot_chat_state", bot: "sage", sessionId: "s", phase: "complete",
      running: false, inflight: false, updatedAt: 3 } as ServerFrame);
    await tick();
    expect(bodies[1]).toMatchObject({ liveActivity: {
      event: "update", priority: 10,
      alert: { title: "CozyChat", body: "Your bot’s reply is ready", sound: "default" },
      contentState: { phase: "completed", eventSequence: 2, elapsedSeconds: 9 },
    } });
    expect(storage.liveActivityRegistrations()).toHaveLength(1);

    notifier.handleFrame({ type: "bot_chat_state", bot: "sage", sessionId: "s", phase: "polling",
      running: true, inflight: true, updatedAt: 4 } as ServerFrame);
    await tick();
    expect(bodies[2]).toMatchObject({ pushId: "opaque", liveActivity: {
      event: "update", priority: 5, contentState: { phase: "thinking", eventSequence: 3 },
    } });
    expect(storage.liveActivityRegistrations()).toHaveLength(1);
    storage.close();
  });

  it("covers exactly one ordinary chat push before or after the terminal frame", async () => {
    for (const chatFirst of [true, false]) {
      const storage = openStorage(":memory:");
      storage.createDevice({ id: "device", name: "phone", tokenHash: "hash", createdAt: 1 });
      storage.saveLiveActivityRegistration({
        deviceId: "device", activityId: `activity-${chatFirst}`, runId: "run",
        conversationId: "session", bot: "sage", pushId: "opaque", createdAt: 1,
      });
      const notifier = new LiveActivityNotifier({
        storage, relayBaseUrl: "https://relay.test", now: () => 10_000,
        fetchImpl: async () => new Response(null, { status: 202 }),
      });
      const event = { bot: "sage", chatSessionId: "session" };
      const terminal = { type: "bot_chat_state", bot: "sage", sessionId: "session", phase: "complete",
        running: false, inflight: false, updatedAt: 3 } as ServerFrame;

      if (chatFirst) {
        expect([...notifier.coveredDeviceIdsForChat(event)]).toEqual(["device"]);
        notifier.handleFrame(terminal);
      } else {
        notifier.handleFrame(terminal);
        expect([...notifier.coveredDeviceIdsForChat(event)]).toEqual(["device"]);
      }
      await tick();
      expect([...notifier.coveredDeviceIdsForChat(event)]).toEqual([]);
      storage.close();
    }
  });

  it("does not claim an unrelated scheduled-message session from the same bot", () => {
    const storage = openStorage(":memory:");
    storage.createDevice({ id: "device", name: "phone", tokenHash: "hash", createdAt: 1 });
    storage.saveLiveActivityRegistration({
      deviceId: "device", activityId: "activity", runId: "run",
      conversationId: "bot-session", bot: "sage", pushId: "opaque", createdAt: 1,
    });
    const notifier = new LiveActivityNotifier({ storage, relayBaseUrl: "https://relay.test" });

    expect([...notifier.coveredDeviceIdsForChat({
      bot: "sage", chatSessionId: "scheduled-session",
    })]).toEqual([]);
    storage.close();
  });
});

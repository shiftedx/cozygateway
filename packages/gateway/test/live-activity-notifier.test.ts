import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { LiveActivityNotifier } from "../src/live-activity-notifier.ts";
import { openStorage } from "../src/storage.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("live activity notifier", () => {
  it("uses authoritative state frames, sends only coarse state, and ends remotely", async () => {
    const storage = openStorage(":memory:");
    storage.createDevice({ id: "device", name: "phone", tokenHash: "hash", createdAt: 1 });
    storage.saveLiveActivityRegistration({
      deviceId: "device", activityId: "activity", runId: "run", conversationId: "gateway",
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
      event: "end", priority: 5,
      contentState: { phase: "completed", eventSequence: 2, elapsedSeconds: 9 },
    } });
    expect(storage.liveActivityRegistrations()).toHaveLength(0);
    storage.close();
  });
});

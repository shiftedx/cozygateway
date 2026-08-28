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

  it("blocks the card on a pending approval and resumes the prior phase when it resolves", async () => {
    const storage = openStorage(":memory:");
    storage.createDevice({ id: "device", name: "phone", tokenHash: "hash", createdAt: 1 });
    storage.saveLiveActivityRegistration({
      deviceId: "device", activityId: "activity", runId: "run", conversationId: "s",
      bot: "sage", pushId: "opaque", createdAt: 1,
    });
    const bodies: any[] = [];
    const notifier = new LiveActivityNotifier({
      storage, relayBaseUrl: "https://relay.test", now: () => 10_000, toolCoalesceMs: 0,
      fetchImpl: async (_input, init) => {
        if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 202 });
      },
    });

    notifier.handleFrame({ type: "bot_tool_activity", bot: "sage", sessionId: "s", turnId: "t",
      steps: [{ id: "c1", name: "shell", state: "running" }], updatedAt: 2 } as unknown as ServerFrame);
    await tick();
    expect(bodies.at(-1).liveActivity.contentState).toMatchObject({ phase: "usingTools", toolCallCount: 1 });

    // A group-room approval belongs to the room surface, never to this 1:1 conversation card.
    notifier.handleFrame({ type: "bot_approval_pending", bot: "sage", sessionId: "s", turnId: "t",
      toolCallId: "call-room", name: "shell", updatedAt: 3, room: "lounge" } as unknown as ServerFrame);
    await tick();
    expect(bodies).toHaveLength(1);

    notifier.handleFrame({ type: "bot_approval_pending", bot: "sage", sessionId: "s", turnId: "t",
      toolCallId: "call-1", name: "shell", updatedAt: 3 } as unknown as ServerFrame);
    await tick();
    expect(bodies.at(-1).liveActivity).toMatchObject({
      priority: 5,
      contentState: {
        phase: "waitingOnApproval", approvalID: "call-1", toolCallCount: 1,
        shortStatus: "Waiting on your approval",
      },
    });
    // The blocked card waits on a person, so it must not go stale on the working-card window.
    expect(bodies.at(-1).liveActivity.staleDate)
      .toBe(bodies.at(-1).liveActivity.timestamp + 30 * 60);
    expect(JSON.stringify(bodies.at(-1))).not.toContain("shell");

    // A second approval on the same turn keeps the card blocked when the first one resolves.
    notifier.handleFrame({ type: "bot_approval_pending", bot: "sage", sessionId: "s", turnId: "t",
      toolCallId: "call-2", name: "shell", updatedAt: 4 } as unknown as ServerFrame);
    notifier.handleFrame({ type: "bot_approval_resolved", bot: "sage", sessionId: "s", turnId: "t",
      toolCallId: "call-1", outcome: "approved", updatedAt: 5 } as unknown as ServerFrame);
    await tick();
    expect(bodies.at(-1).liveActivity.contentState).toMatchObject({
      phase: "waitingOnApproval", approvalID: "call-2",
    });

    // Expiry is a resolution too, and it must unblock the card without anyone answering here.
    notifier.handleFrame({ type: "bot_approval_resolved", bot: "sage", sessionId: "s", turnId: "t",
      toolCallId: "call-2", outcome: "expired", updatedAt: 6 } as unknown as ServerFrame);
    await tick();
    expect(bodies.at(-1).liveActivity.contentState).toMatchObject({
      phase: "usingTools", toolCallCount: 1,
    });
    expect(bodies.at(-1).liveActivity.contentState.approvalID).toBeUndefined();
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

  it("does not let an old 404 delete a rotated registration or its projection state", async () => {
    const storage = openStorage(":memory:");
    storage.createDevice({ id: "device", name: "phone", tokenHash: "hash", createdAt: 1 });
    storage.saveLiveActivityRegistration({ deviceId: "device", activityId: "activity", runId: "old",
      conversationId: "session", bot: "sage", pushId: "old-push", createdAt: 1 });
    const bodies: any[] = [];
    let resolveOld: ((response: Response) => void) | undefined;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const notifier = new LiveActivityNotifier({
      storage, relayBaseUrl: "https://relay.test", now: () => 10_000,
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1 ? await oldResponse : new Response(null, { status: 202 });
      },
    });
    const polling = { type: "bot_chat_state", bot: "sage", sessionId: "session", phase: "polling",
      running: true, inflight: true, updatedAt: 1 } as ServerFrame;
    notifier.handleFrame(polling);
    expect(bodies).toMatchObject([{ pushId: "old-push" }]);

    storage.saveLiveActivityRegistration({ deviceId: "device", activityId: "activity", runId: "new",
      conversationId: "session", bot: "sage", pushId: "new-push", createdAt: 2 });
    resolveOld?.(new Response(null, { status: 404 }));
    await tick();

    expect(storage.liveActivityRegistration("device", "activity")).toMatchObject({
      runId: "new", pushId: "new-push",
    });
    expect(storage.liveActivityRelayDeletions(10)).toEqual(["old-push"]);
    notifier.handleFrame(polling);
    await tick();
    expect(bodies).toHaveLength(1);

    notifier.handleFrame({ type: "bot_chat_delta", bot: "sage", sessionId: "session", turnId: "turn",
      text: "new draft", updatedAt: 2 } as unknown as ServerFrame);
    await tick();
    expect(bodies.at(-1)).toMatchObject({ pushId: "new-push" });
    storage.close();
  });

  it("never fans a current conversation frame out to stale conversations from the same bot", async () => {
    const storage = openStorage(":memory:");
    for (let index = 0; index < 10; index += 1) {
      storage.createDevice({
        id: `stale-device-${index}`, name: `stale phone ${index}`,
        tokenHash: `stale-hash-${index}`, createdAt: 1,
      });
      storage.saveLiveActivityRegistration({
        deviceId: `stale-device-${index}`, activityId: `stale-${index}`, runId: `stale-run-${index}`,
        conversationId: "session-a", bot: "sage", pushId: `stale-push-${index}`, createdAt: index,
      });
    }
    storage.createDevice({ id: "device", name: "phone", tokenHash: "hash", createdAt: 1 });
    storage.saveLiveActivityRegistration({
      deviceId: "device", activityId: "current", runId: "current-run",
      conversationId: "session-b", bot: "sage", pushId: "current-push", createdAt: 20,
    });
    const bodies: any[] = [];
    const notifier = new LiveActivityNotifier({
      storage, relayBaseUrl: "https://relay.test", now: () => 10_000, toolCoalesceMs: 0,
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 202 });
      },
    });
    const notify = async (frame: ServerFrame) => {
      const before = bodies.length;
      notifier.handleFrame(frame);
      await tick();
      expect.soft(bodies.slice(before).map((body) => body.pushId)).toEqual(["current-push"]);
    };

    await notify({ type: "bot_chat_state", bot: "sage", sessionId: "session-b", phase: "polling",
      running: true, inflight: true, updatedAt: 1 } as ServerFrame);
    await notify({ type: "bot_tool_activity", bot: "sage", sessionId: "session-b", turnId: "turn",
      steps: [{ id: "call", name: "shell", state: "running" }], updatedAt: 2 } as unknown as ServerFrame);
    await notify({ type: "bot_chat_delta", bot: "sage", sessionId: "session-b", turnId: "turn",
      text: "draft", updatedAt: 3 } as unknown as ServerFrame);
    await notify({ type: "bot_approval_pending", bot: "sage", sessionId: "session-b", turnId: "turn",
      toolCallId: "call", name: "shell", updatedAt: 4 } as unknown as ServerFrame);
    await notify({ type: "bot_approval_resolved", bot: "sage", sessionId: "session-b", turnId: "turn",
      toolCallId: "call", outcome: "approved", updatedAt: 5 } as unknown as ServerFrame);
    await notify({ type: "bot_chat_state", bot: "sage", sessionId: "session-b", phase: "complete",
      running: false, inflight: false, updatedAt: 6 } as ServerFrame);

    expect.soft(bodies).toHaveLength(6);
    storage.close();
  });
});

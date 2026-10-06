import { describe, expect, it } from "vitest";
import type { BotSummary, ServerFrame } from "cozygateway-contract";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { HermesBridge, type BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { HermesClient } from "../src/hermes-bridge/client.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/** Two wire-level defects behind a long bot run going silent in the app.
 *
 *  A: a Hermes agent loop replies more than once. Every reply is an attach-v1 `commit`, and the
 *  gateway used to end the turn on the first one, so the tool activity and drafts the agent went
 *  on producing for many minutes were discarded against a turn it had already sealed.
 *
 *  B: the `bot_roster` frame carried `chatSessionId: null` while `GET /bots` carried the real id,
 *  so nothing a client received on the socket could be joined to the roster row it belongs to. */

interface Harness {
  storage: Storage;
  plane: NativeBotDataPlane;
  frames: ServerFrame[];
  sessionId: string;
  turnId: string;
  close: () => void;
}

async function startTurn(): Promise<Harness> {
  const storage = openStorage(":memory:");
  const frames: ServerFrame[] = [];
  let now = 1_000;
  let sent: Record<string, unknown> | undefined;
  const interrupts: Array<Record<string, unknown>> = [];
  const ingress = {
    sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
      sent = input;
      storage.enqueueAttachCommand(bot, "turn-command", { kind: "turn", ...input } as never, now);
      return true;
    },
    sendNativeInterrupt: (_bot: string, input: Record<string, unknown>) => {
      interrupts.push(input);
      return true;
    },
    sendApprovalResolution: () => true,
  } as unknown as AttachV1Ingress;
  const plane = new NativeBotDataPlane({
    control: {} as BotsSurface,
    storage,
    ingress,
    nativeBots: ["sage"],
    chatSuggestion: "",
    broadcast: (frame) => frames.push(frame),
    now: () => now++,
  });
  const accepted = await plane.surface().sendChatMessage("sage", "audit every sensor", {
    clientId: "client-1",
  });
  return {
    storage,
    plane,
    frames,
    sessionId: accepted.sessionId,
    turnId: String(sent?.turnId),
    close: () => {
      plane.close();
      storage.close();
    },
  };
}

function toolEvent(sessionId: string, turnId: string, callId: string, status: "running" | "ok") {
  return {
    kind: "event" as const,
    sequence: 1,
    eventId: `${callId}-${status}`,
    event: { kind: "tool" as const, threadId: sessionId, turnId, callId, name: "terminal", status },
  };
}

describe("an interim reply commits a message without ending the turn", () => {
  it("keeps the turn running and keeps broadcasting tool activity after an interim commit", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    expect(
      plane.handle("sage", toolEvent(sessionId, turnId, "call-1", "running")),
    ).toBe(true);
    expect(
      plane.handle("sage", {
        kind: "event",
        sequence: 2,
        eventId: "commit-interim",
        event: {
          kind: "commit",
          threadId: sessionId,
          turnId,
          messageId: "interim-1",
          blocks: [{ type: "paragraph", text: "Two rooms done, still going." }],
          continues: true,
        },
      }),
    ).toBe(true);

    // The interim reply is an ordinary transcript row, immediately.
    const afterInterim = await plane.surface().chatHistory("sage");
    expect(afterInterim.messages.map((message) => message.text)).toContain(
      "Two rooms done, still going.",
    );
    // ...and the turn is still the active one.
    expect(afterInterim.running).toBe(true);
    const stateAfterInterim = harness.frames.filter((frame) => frame.type === "bot_chat_state").at(-1);
    expect(stateAfterInterim).toMatchObject({ phase: "polling", running: true });
    // No terminalized tool strip: nothing has stopped running.
    expect(
      harness.frames.some((frame) => frame.type === "bot_tool_activity" && frame.done === true),
    ).toBe(false);

    // Work that arrives after the interim reply still reaches the app.
    const before = harness.frames.length;
    expect(plane.handle("sage", toolEvent(sessionId, turnId, "call-1", "ok"))).toBe(true);
    expect(plane.handle("sage", toolEvent(sessionId, turnId, "call-2", "running"))).toBe(true);
    expect(
      plane.handle("sage", {
        kind: "event",
        sequence: 5,
        eventId: "draft-late",
        event: {
          kind: "draft",
          threadId: sessionId,
          turnId,
          blocks: [{ type: "paragraph", text: "Room three" }],
        },
      }),
    ).toBe(true);
    const later = harness.frames.slice(before);
    expect(later.some((frame) => frame.type === "bot_tool_activity")).toBe(true);

    // The reply that ends the run omits `continues`, and that seals the turn.
    expect(
      plane.handle("sage", {
        kind: "event",
        sequence: 6,
        eventId: "commit-final",
        event: {
          kind: "commit",
          threadId: sessionId,
          turnId,
          messageId: "final-1",
          blocks: [{ type: "paragraph", text: "All rooms audited." }],
        },
      }),
    ).toBe(true);
    const settled = await plane.surface().chatHistory("sage");
    expect(settled.running).toBe(false);
    expect(settled.messages.map((message) => message.text)).toEqual([
      "audit every sensor",
      "Two rooms done, still going.",
      "All rooms audited.",
    ]);
    harness.close();
  });

  it("still force-terminalizes running tool steps when a turn is genuinely interrupted", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    expect(plane.handle("sage", toolEvent(sessionId, turnId, "call-1", "running"))).toBe(true);
    expect(
      plane.handle("sage", {
        kind: "event",
        sequence: 2,
        eventId: "commit-interim",
        event: {
          kind: "commit",
          threadId: sessionId,
          turnId,
          messageId: "interim-1",
          blocks: [{ type: "paragraph", text: "Working on it." }],
          continues: true,
        },
      }),
    ).toBe(true);
    expect(
      plane.handle("sage", {
        kind: "event",
        sequence: 3,
        eventId: "interrupted-1",
        event: { kind: "interrupted", threadId: sessionId, turnId, messageId: "stop-1" },
      }),
    ).toBe(true);

    const sealed = harness.frames.filter(
      (frame) => frame.type === "bot_tool_activity" && frame.done === true,
    );
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatchObject({
      steps: [{ stepId: "call-1", status: "error" }],
    });
    expect((await plane.surface().chatHistory("sage")).running).toBe(false);
    harness.close();
  });
});

describe("the bot_roster frame carries the chat session id", () => {
  it("publishes the same rows GET /bots returns", async () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: () => undefined,
      now: () => 5_000,
    });
    const client = {
      request: async (method: string) =>
        method === "profiles.list"
          ? {
              profiles: [
                { name: "sage", description: "audits sensors", has_avatar: false },
                { name: "unmanaged", description: "no attach identity", has_avatar: false },
              ],
              bot_mode_protocol: true,
            }
          : {},
      state: () => "online",
      liveness: () => ({ state: "online", since: 1, reconnectAttempt: 0 }),
      onStateChange: () => undefined,
      onEvent: () => undefined,
      start: () => undefined,
      close: async () => undefined,
    } as unknown as HermesClient;
    const bridge = new HermesBridge({
      client,
      storage,
      broadcast: (frame) => frames.push(frame),
      now: () => 5_000,
    });
    bridge.setRosterOverlay((bots) => plane.rosterBots(bots));

    await bridge.refresh("test");

    const published = frames.find((frame) => frame.type === "bot_roster");
    expect(published).toBeDefined();
    const rows = (published as { bots: BotSummary[] }).bots;
    const canonical = await plane.surface().canonicalChat("sage");
    expect(rows.map((row) => row.name)).toEqual(["sage", "unmanaged"]);
    expect(rows[0]?.chatSessionId).toBe(canonical.sessionId);
    expect(rows[0]?.chatSessionId).not.toBeNull();
    expect(rows[1]).toMatchObject({ chatSessionId: null, syncState: "setup_required" });

    await bridge.close();
    plane.close();
    storage.close();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame } from "cozygateway-contract";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/** Issue #193: an event acknowledged into the journal MUST eventually apply, exactly once,
 *  regardless of process death. These tests drive journaled-but-unapplied events through a fresh
 *  assembly (the boot shape) and through the seal-vs-projection crash gaps that produced the
 *  production ghosts: a turn that shows "thinking" forever while its reply sits in the journal. */

const NOW_START = 1_000_000;

interface Assembly {
  plane: NativeBotDataPlane;
  ingress: AttachV1Ingress;
  frames: ServerFrame[];
  close: () => void;
}

function assemble(storage: Storage, now: () => number): Assembly {
  const frames: ServerFrame[] = [];
  const fakeTurnIngress = {
    sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
      storage.enqueueAttachCommand(bot, "turn-command", { kind: "turn", ...input } as never, now());
      return true;
    },
    sendNativeInterrupt: () => true,
    sendApprovalResolution: () => true,
  } as unknown as AttachV1Ingress;
  const plane = new NativeBotDataPlane({
    control: {} as BotsSurface,
    storage,
    ingress: fakeTurnIngress,
    nativeBots: ["sage"],
    chatSuggestion: "",
    broadcast: (frame) => frames.push(frame),
    now,
    log: () => {},
  });
  const ingress = new AttachV1Ingress({
    tokens: new Map([["secret", "sage"]]),
    storage,
    events: {
      onEvent: (agentId, frame) => plane.handle(agentId, frame),
      onPresence: () => {},
    },
    now,
    projectionRetryMs: 5,
    projectionMaxAttempts: 3,
    log: () => {},
  });
  return {
    plane,
    ingress,
    frames,
    close: () => {
      ingress.close();
      plane.close();
    },
  };
}

/** Opens a durable native turn exactly the way the app path does, then acks its command so the
 *  plugin provably took it. Returns the durable coordinates. */
async function openTurn(storage: Storage, assembly: Assembly, now: number): Promise<{ sessionId: string; turnId: string }> {
  const accepted = await assembly.plane.surface().sendChatMessage("sage", "hello", { clientId: "user-1" });
  const chat = storage.nativeBotChat("sage", now);
  expect(chat.activeTurnId).toBeDefined();
  expect(storage.ackAttachCommand("sage", 1, "turn-command", now)).toBe(true);
  return { sessionId: accepted.sessionId, turnId: chat.activeTurnId as string };
}

function journal(storage: Storage, sequence: number, eventId: string, event: AttachV1EventFrame["event"], at: number): void {
  const frame: AttachV1EventFrame = { kind: "event", sequence, eventId, event };
  const admission = storage.acceptAttachEvent("sage", frame, at);
  expect(admission.status).toBe("accepted");
}

describe("boot replay of journaled-unapplied attach events (issue #193)", () => {
  let storage: Storage;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    storage = openStorage(":memory:");
    clock = NOW_START;
  });
  afterEach(() => storage.close());

  it("applies a journaled commit on fresh assembly: message projected, turn cleared, state on the wire", async () => {
    const first = assemble(storage, now);
    const { sessionId, turnId } = await openTurn(storage, first, clock);
    // The container dies here: ingest journaled the reply, the in-memory apply never ran.
    journal(storage, 1, "draft-1", { kind: "draft", threadId: sessionId, turnId, blocks: [{ type: "paragraph", text: "half" }] }, clock);
    journal(storage, 2, "commit-1", { kind: "commit", threadId: sessionId, turnId, messageId: "answer-1", blocks: [{ type: "paragraph", text: "the answer" }] }, clock);
    first.close();
    expect(storage.unappliedAttachEvents("sage")).toHaveLength(2);

    const second = assemble(storage, now);
    second.ingress.replayUnapplied("sage");

    expect(storage.unappliedAttachEvents("sage")).toHaveLength(0);
    const messages = storage.nativeBotMessages("sage", sessionId);
    expect(messages.filter((message) => message.id === "answer-1")).toHaveLength(1);
    expect(storage.nativeBotChat("sage", clock).activeTurnId).toBeUndefined();
    expect(storage.nativeBotTurnTerminal("sage", sessionId, turnId)).toMatchObject({ status: "completed" });
    expect(second.frames.some((frame) => frame.type === "bot_chat" && frame.messages.some((message) => message.id === "answer-1"))).toBe(true);
    expect(second.frames.some((frame) => frame.type === "bot_chat_state" && frame.running === false)).toBe(true);
    second.close();
  });

  it("replays idempotently: a second assembly projects no duplicate rows and no duplicate broadcasts", async () => {
    const first = assemble(storage, now);
    const { sessionId, turnId } = await openTurn(storage, first, clock);
    journal(storage, 1, "commit-1", { kind: "commit", threadId: sessionId, turnId, messageId: "answer-1", blocks: [{ type: "paragraph", text: "the answer" }] }, clock);
    first.close();

    const second = assemble(storage, now);
    second.ingress.replayUnapplied("sage");
    second.close();

    const third = assemble(storage, now);
    third.ingress.replayUnapplied("sage");

    expect(storage.nativeBotMessages("sage", sessionId).filter((message) => message.id === "answer-1")).toHaveLength(1);
    expect(third.frames).toHaveLength(0);
    third.close();
  });

  it("heals a mid-apply crash that sealed the turn but never projected the reply", async () => {
    const first = assemble(storage, now);
    const { sessionId, turnId } = await openTurn(storage, first, clock);
    journal(storage, 1, "commit-1", { kind: "commit", threadId: sessionId, turnId, messageId: "answer-1", blocks: [{ type: "paragraph", text: "the answer" }] }, clock);
    // Crash simulation: the old apply order sealed the turn first and died before projecting.
    storage.recordNativeBotTerminal({ bot: "sage", sessionId, turnId, status: "completed", completedAt: clock });
    storage.clearNativeBotTurn("sage", sessionId, turnId, clock);
    first.close();

    const second = assemble(storage, now);
    second.ingress.replayUnapplied("sage");

    expect(storage.unappliedAttachEvents("sage")).toHaveLength(0);
    expect(storage.nativeBotMessages("sage", sessionId).filter((message) => message.id === "answer-1")).toHaveLength(1);
    second.close();
  });

  it("projects a commit that lands after the stale-turn reaper sealed the turn", async () => {
    vi.useFakeTimers();
    try {
      const frames: ServerFrame[] = [];
      const fakeTurnIngress = {
        sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
          storage.enqueueAttachCommand(bot, "turn-command", { kind: "turn", ...input } as never, clock);
          return true;
        },
        sendNativeInterrupt: () => true,
        sendApprovalResolution: () => true,
      } as unknown as AttachV1Ingress;
      const plane = new NativeBotDataPlane({
        control: {} as BotsSurface,
        storage,
        ingress: fakeTurnIngress,
        nativeBots: ["sage"],
        chatSuggestion: "",
        broadcast: (frame) => frames.push(frame),
        now,
        log: () => {},
        staleTurnSweepMs: 60_000,
        staleTurnInterruptGraceMs: 120_000,
        staleTurnCeilingMs: 1_800_000,
      });
      const accepted = await plane.surface().sendChatMessage("sage", "hello", { clientId: "user-1" });
      const sessionId = accepted.sessionId;
      const turnId = storage.nativeBotChat("sage", clock).activeTurnId as string;
      expect(storage.ackAttachCommand("sage", 1, "turn-command", clock)).toBe(true);
      expect(await plane.surface().stopChat("sage")).toBe("stopped");
      // Total silence past the interrupt grace: the reaper seals the turn itself.
      clock += 180_000;
      vi.advanceTimersByTime(180_000);
      expect(storage.nativeBotTurnTerminal("sage", sessionId, turnId)).toMatchObject({ status: "interrupted" });
      // The plugin's reply was already in flight. It must still reach the user.
      const projected = plane.handle("sage", {
        kind: "event", sequence: 1, eventId: "late-commit",
        event: { kind: "commit", threadId: sessionId, turnId, messageId: "late-answer", blocks: [{ type: "paragraph", text: "finished anyway" }] },
      });
      expect(projected).toBe(true);
      expect(storage.nativeBotMessages("sage", sessionId).filter((message) => message.id === "late-answer")).toHaveLength(1);
      expect(storage.nativeBotTurnTerminal("sage", sessionId, turnId)).toMatchObject({ status: "completed" });
      expect(frames.some((frame) => frame.type === "bot_chat" && frame.messages.some((message) => message.id === "late-answer"))).toBe(true);
      plane.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { ServerFrame } from "cozygateway-contract";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/** HF2. The live incident, at the seam where each half of it lives.
 *
 *  A Hermes peer took a turn, dropped it internally, and never sent a terminal. The gateway kept
 *  the turn running for 21 minutes, so the next thing the person said went out as a steer on a
 *  turn no process held any more, and the reply that came back was declined for having no durable
 *  turn command and never reached the phone.
 *
 *  Three server-side floors, in the order they fire: hello reconciliation seals a turn the
 *  re-attached peer does not carry, the owner-loss lease bounds the silence when nothing declares
 *  anything, and an orphaned commit carrying words is projected rather than dropped. */

const SWEEP_MS = 60_000;
const GRACE_MS = 120_000;
const CEILING_MS = 1_800_000;
/** ADR 0004's provisional owner-loss lease, the same bound a Task gets. */
const LEASE_MS = 120_000;

interface Harness {
  storage: Storage;
  plane: NativeBotDataPlane;
  frames: ServerFrame[];
  sessionId: string;
  turnId: string;
  turns: Array<Record<string, unknown>>;
  steers: Array<Record<string, unknown>>;
  now: () => number;
  advance: (ms: number) => void;
  event: (eventId: string, event: Record<string, unknown>) => boolean;
  close: () => void;
}

async function startTurn(): Promise<Harness> {
  const storage = openStorage(":memory:");
  const frames: ServerFrame[] = [];
  let now = 1_000_000;
  const turns: Array<Record<string, unknown>> = [];
  const steers: Array<Record<string, unknown>> = [];
  let sequence = 0;
  const ingress = {
    sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
      turns.push(input);
      storage.enqueueAttachCommand(bot, `turn-command-${turns.length}`, { kind: "turn", ...input } as never, now);
      return true;
    },
    sendNativeSteer: (_bot: string, input: Record<string, unknown>) => {
      steers.push(input);
      return true;
    },
    sendNativeInterrupt: () => true,
    sendApprovalResolution: () => true,
  } as unknown as AttachV1Ingress;
  const plane = new NativeBotDataPlane({
    control: {} as BotsSurface,
    storage,
    ingress,
    nativeBots: ["sage"],
    chatSuggestion: "",
    broadcast: (frame) => frames.push(frame),
    now: () => now,
    log: () => {},
    staleTurnSweepMs: SWEEP_MS,
    staleTurnInterruptGraceMs: GRACE_MS,
    staleTurnCeilingMs: CEILING_MS,
  });
  const accepted = await plane.surface().sendChatMessage("sage", "what is the plan", { clientId: "client-1" });
  const sessionId = accepted.sessionId;
  const turnId = String(turns[0]?.["turnId"]);
  return {
    storage,
    plane,
    frames,
    sessionId,
    turnId,
    turns,
    steers,
    now: () => now,
    advance: (ms) => { now += ms; vi.advanceTimersByTime(ms); },
    event: (eventId, event) => {
      sequence += 1;
      return plane.handle("sage", { kind: "event", sequence, eventId, event } as never);
    },
    close: () => { plane.close(); storage.close(); },
  };
}

function terminalOf(harness: Harness, turnId = harness.turnId) {
  return harness.storage.nativeBotTurnTerminal("sage", harness.sessionId, turnId);
}

describe("HF2: a stale native turn never swallows a reply", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("seals a turn the re-attached peer does not carry, immediately, on hello", async () => {
    const harness = await startTurn();

    // 19 minutes of nothing: the peer took the command and dropped the turn internally.
    harness.advance(19 * 60_000);
    expect(terminalOf(harness)).toBeUndefined();

    // The peer restarted and says exactly which turns it still holds. This one is not among them.
    harness.plane.handleAttachHello("sage", []);

    expect(terminalOf(harness)).toMatchObject({ status: "failed" });
    expect(harness.storage.nativeBotChat("sage", harness.now()).activeTurnId).toBeUndefined();
    expect(harness.frames.filter((frame) => frame.type === "bot_chat_state").at(-1))
      .toMatchObject({ phase: "failed", running: false });
    harness.close();
  });

  it("never seals a turn the peer still reports active", async () => {
    const harness = await startTurn();

    harness.advance(19 * 60_000);
    harness.plane.handleAttachHello("sage", [harness.turnId]);

    expect(terminalOf(harness)).toBeUndefined();
    // And the confirmation restores the long window rather than the owner-loss lease.
    harness.advance(LEASE_MS + SWEEP_MS);
    expect(terminalOf(harness)).toBeUndefined();
    harness.close();
  });

  it("bounds an older peer's undeclared turn to the owner-loss lease instead of the long ceiling", async () => {
    const harness = await startTurn();

    // A peer that cannot declare its active turns re-attaches. It gets a short grace, not 30
    // minutes: the ONLY thing that keeps this turn alive now is a frame proving it is running.
    harness.plane.handleAttachHello("sage", undefined);
    harness.advance(SWEEP_MS);
    expect(terminalOf(harness)).toBeUndefined();

    harness.advance(LEASE_MS);

    expect(terminalOf(harness)).toBeDefined();
    expect(harness.storage.nativeBotChat("sage", harness.now()).activeTurnId).toBeUndefined();
    harness.close();
  });

  it("bounds a disconnected peer's turn to the owner-loss lease", async () => {
    const harness = await startTurn();

    harness.plane.handleAttachPresence("sage", "absent");
    harness.advance(LEASE_MS + SWEEP_MS);

    expect(terminalOf(harness)).toBeDefined();
    harness.close();
  });

  it("keeps the long window while the peer is attached and still reports the turn active", async () => {
    const harness = await startTurn();

    harness.plane.handleAttachHello("sage", [harness.turnId]);
    harness.advance(CEILING_MS - SWEEP_MS);
    expect(terminalOf(harness)).toBeUndefined();
    harness.advance(SWEEP_MS);
    expect(terminalOf(harness)).toBeDefined();
    harness.close();
  });

  it("promotes a steer the peer answers as an unknown turn into a new durable turn", async () => {
    const harness = await startTurn();

    // The gateway still believes the first turn is running, so the next message steers it.
    await harness.plane.surface().sendChatMessage("sage", "and the timeline?", { clientId: "client-2" });
    expect(harness.steers).toHaveLength(1);
    expect(harness.turns).toHaveLength(1);

    // HF1: the plugin holds no such turn and says so in a typed failure.
    harness.event("unknown-turn", {
      kind: "failed", threadId: harness.sessionId, turnId: harness.turnId,
      messageId: "client-2", reason: "unknown_turn",
    });

    expect(terminalOf(harness)).toBeDefined();
    // Same text, a fresh durable turn, and the app sees an ordinary new turn.
    expect(harness.turns).toHaveLength(2);
    expect(harness.turns[1]).toMatchObject({ threadId: harness.sessionId, text: "and the timeline?" });
    const promoted = String(harness.turns[1]?.["turnId"]);
    expect(promoted).not.toBe(harness.turnId);
    expect(harness.storage.nativeBotChat("sage", harness.now()).activeTurnId).toBe(promoted);
    // The person's own message now belongs to the turn that will answer it.
    expect(harness.storage.nativeBotTurnUserMessageId("sage", harness.sessionId, promoted)).toBe("client-2");

    // And the promoted turn answers normally.
    harness.event("promoted-commit", {
      kind: "commit", threadId: harness.sessionId, turnId: promoted,
      messageId: "answer-2", blocks: [{ type: "paragraph", text: "two weeks" }],
    });
    expect(harness.storage.nativeBotMessages("sage", harness.sessionId).map((m) => m.text))
      .toContain("two weeks");
    harness.close();
  });

  it("promotes a pending steer when hello reconciliation seals the turn under it", async () => {
    const harness = await startTurn();
    await harness.plane.surface().sendChatMessage("sage", "and the timeline?", { clientId: "client-2" });
    expect(harness.steers).toHaveLength(1);

    harness.plane.handleAttachHello("sage", []);

    expect(harness.turns).toHaveLength(2);
    expect(harness.turns[1]).toMatchObject({ text: "and the timeline?" });
    harness.close();
  });

  it("never promotes a steer the peer actually answered", async () => {
    const harness = await startTurn();
    await harness.plane.surface().sendChatMessage("sage", "and the timeline?", { clientId: "client-2" });
    // The peer is working on it: any frame at all on that turn proves it holds the turn.
    harness.event("draft-1", {
      kind: "draft", threadId: harness.sessionId, turnId: harness.turnId,
      blocks: [{ type: "paragraph", text: "thinking" }],
    });
    harness.event("commit-1", {
      kind: "commit", threadId: harness.sessionId, turnId: harness.turnId,
      messageId: "answer-1", blocks: [{ type: "paragraph", text: "two weeks" }],
    });

    expect(harness.turns).toHaveLength(1);
    harness.close();
  });

  it("projects an orphaned commit that carries the bot's own words instead of discarding it", async () => {
    const harness = await startTurn();
    await harness.plane.surface().sendChatMessage("sage", "and the timeline?", { clientId: "client-2" });

    // The restarted peer treated the steer as a fresh inbound message and answered on a turn id
    // this gateway never issued. This is the frame the incident logged as "no durable turn
    // command" and then acknowledged as orphaned.
    const accepted = harness.event("orphan-commit", {
      kind: "commit", threadId: harness.sessionId, turnId: `${harness.turnId}:steer`,
      messageId: "orphan-answer", blocks: [{ type: "paragraph", text: "two weeks, give or take" }],
    });

    expect(accepted).toBe(true);
    const messages = harness.storage.nativeBotMessages("sage", harness.sessionId);
    expect(messages.map((message) => message.text)).toContain("two weeks, give or take");
    expect(messages.find((message) => message.id === "orphan-answer")).toMatchObject({
      role: "assistant", authorBot: "sage",
    });
    expect(harness.frames.some((frame) =>
      frame.type === "bot_chat" && frame.messages.some((message) => message.id === "orphan-answer"))).toBe(true);
    harness.close();
  });

  it("still declines an orphaned frame that carries nothing a person can read", async () => {
    const harness = await startTurn();

    expect(harness.event("orphan-tool", {
      kind: "tool", threadId: harness.sessionId, turnId: "never-issued",
      callId: "call-1", name: "terminal", status: "running",
    })).toBe(false);
    harness.close();
  });
});

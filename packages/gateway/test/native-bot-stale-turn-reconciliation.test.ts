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
/** The longer window a peer that re-attached but cannot declare its turns gets. */
const GRACE_WINDOW_MS = 600_000;
/** F2. How often a live peer proves it is alive: the attach-v1 heartbeat interval, well inside the
 *  30 second staleness bound the lease clock uses for that proof. */
const LIVENESS_MS = 30_000;

interface Harness {
  storage: Storage;
  plane: NativeBotDataPlane;
  frames: ServerFrame[];
  sessionId: string;
  turnId: string;
  turns: Array<Record<string, unknown>>;
  steers: Array<Record<string, unknown>>;
  now: () => number;
  /** Whether a dispatched command is taken off the wire, i.e. whether the bot is awake. */
  deliver: (value: boolean) => void;
  /** Make the next dispatch fail, the way an unavailable peer does. */
  refuse: () => void;
  /** Drop every piece of in-process bookkeeping and rebuild the plane on the same durable store. */
  restart: () => { storage: Storage; plane: NativeBotDataPlane; close: () => void };
  advance: (ms: number) => void;
  event: (eventId: string, event: Record<string, unknown>) => boolean;
  close: () => void;
}

async function startTurn(opts: { awake?: boolean } = {}): Promise<Harness> {
  const storage = openStorage(":memory:");
  const frames: ServerFrame[] = [];
  let now = 1_000_000;
  const turns: Array<Record<string, unknown>> = [];
  const steers: Array<Record<string, unknown>> = [];
  let sequence = 0;
  let acknowledge = opts.awake !== false;
  let refuse = false;
  const ingress = {
    sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
      if (refuse) return false;
      turns.push(input);
      const commandId = `turn-command-${turns.length}`;
      const sequence = storage.enqueueAttachCommand(bot, commandId, { kind: "turn", ...input } as never, now).sequence;
      // A peer that is awake takes the command off the wire. A queued turn for a sleeping bot
      // never does, which is the whole difference reconciliation has to respect.
      if (acknowledge) storage.ackAttachCommand(bot, sequence, commandId, now);
      return true;
    },
    sendNativeSteer: (bot: string, input: Record<string, unknown>) => {
      steers.push(input);
      const commandId = `steer-command-${steers.length}`;
      const sequence = storage.enqueueAttachCommand(bot, commandId, { kind: "steer", ...input } as never, now).sequence;
      if (acknowledge) storage.ackAttachCommand(bot, sequence, commandId, now);
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
    deliver: (value: boolean) => { acknowledge = value; },
    refuse: () => { refuse = true; },
    restart: () => {
      plane.close();
      const revived = new NativeBotDataPlane({
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
      return { storage, plane: revived, close: () => { revived.close(); storage.close(); } };
    },
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

  it("bounds an older peer's undeclared turn to the undeclared grace, not the long ceiling", async () => {
    const harness = await startTurn();

    // A peer that cannot declare its active turns re-attaches. It gets a grace, not 30 minutes:
    // the ONLY thing that keeps this turn alive now is a frame proving it is running.
    harness.plane.handleAttachHello("sage", undefined);
    harness.advance(GRACE_WINDOW_MS - SWEEP_MS);
    expect(terminalOf(harness)).toBeUndefined();

    harness.advance(SWEEP_MS);

    expect(terminalOf(harness)).toBeDefined();
    expect(harness.storage.nativeBotChat("sage", harness.now()).activeTurnId).toBeUndefined();
    harness.close();
  });

  it("never reaps a turn a re-attached older peer is still working on quietly", async () => {
    const harness = await startTurn();
    harness.plane.handleAttachHello("sage", undefined);

    // A minute of frame silence inside one long prefill-bound model call, which is ordinary on a
    // shared endpoint. The peer is attached and the run is alive; nothing may end it.
    harness.advance(60_000);
    expect(terminalOf(harness)).toBeUndefined();

    // And one progress frame resets the window, so a slow run that keeps breathing never dies.
    harness.event("thinking-1", {
      kind: "thinking", threadId: harness.sessionId, turnId: harness.turnId,
      text: "reading the plan", seq: 1, lastActiveAt: harness.now(),
    });
    harness.advance(GRACE_WINDOW_MS - SWEEP_MS);
    expect(terminalOf(harness)).toBeUndefined();
    harness.close();
  });

  it("bounds a disconnected peer's turn to the owner-loss lease", async () => {
    const harness = await startTurn();

    harness.plane.handleAttachPresence("sage", "absent");
    harness.advance(LEASE_MS + SWEEP_MS);

    expect(terminalOf(harness)).toBeDefined();
    harness.close();
  });

  it("never reaps a detached peer that keeps proving it is alive through a long model request", async () => {
    const harness = await startTurn();

    // F2. The socket dropped mid-turn, so the turn is on the 120 second lease. The process is
    // very much alive: it is inside one cold prefill-bound model call, which LV1 measured at
    // about 123 seconds for a 45k token window, and it answers every attach-v1 heartbeat while
    // producing not one frame. Three minutes of that must not end the turn.
    harness.plane.handleAttachPresence("sage", "absent");
    for (let elapsed = 0; elapsed < 3 * 60_000; elapsed += LIVENESS_MS) {
      harness.plane.handleAttachLiveness("sage", harness.now());
      harness.advance(LIVENESS_MS);
    }

    expect(terminalOf(harness)).toBeUndefined();
    expect(harness.storage.nativeBotChat("sage", harness.now()).activeTurnId).toBe(harness.turnId);
    harness.close();
  });

  it("reaps a detached peer that stops proving it is alive, one lease after the last proof", async () => {
    const harness = await startTurn();

    // The same turn, and the same three minutes of heartbeats, and then the process dies. The
    // lease clock runs from the LAST proof of life, so the reap still lands within one lease.
    harness.plane.handleAttachPresence("sage", "absent");
    for (let elapsed = 0; elapsed < 3 * 60_000; elapsed += LIVENESS_MS) {
      harness.plane.handleAttachLiveness("sage", harness.now());
      harness.advance(LIVENESS_MS);
    }
    expect(terminalOf(harness)).toBeUndefined();

    harness.advance(LEASE_MS + SWEEP_MS);

    expect(terminalOf(harness)).toMatchObject({ status: "failed" });
    expect(harness.storage.nativeBotChat("sage", harness.now()).activeTurnId).toBeUndefined();
    harness.close();
  });

  it("never lets a proof of life shorten the undeclared grace an older peer keeps", async () => {
    const harness = await startTurn();

    // Never nerf Hermes. A peer that re-attached without declaring its turns keeps the 600 second
    // grace exactly as it was: proof of life may only ever extend a window, never shorten one.
    harness.plane.handleAttachHello("sage", undefined);
    harness.plane.handleAttachLiveness("sage", harness.now());
    harness.advance(GRACE_WINDOW_MS - SWEEP_MS);
    expect(terminalOf(harness)).toBeUndefined();

    harness.advance(SWEEP_MS);

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

    // C1. The person was answered, so the steer is accounted for. Sealing the dead turn now must
    // NOT ask the same question a second time and pay for a second answer.
    harness.plane.handleAttachHello("sage", []);
    expect(harness.turns).toHaveLength(1);
    expect(harness.storage.nativeBotMessages("sage", harness.sessionId)
      .filter((message) => message.text === "two weeks, give or take")).toHaveLength(1);
    expect(harness.storage.pendingNativeSteers("sage", harness.sessionId)).toEqual([]);
    harness.close();
  });

  it("never seals a turn the peer has not been handed yet, and never promotes one", async () => {
    // C2. The laptop is asleep. The gateway accepts the turn and queues the command durably; the
    // peer has never seen it, so its truthful "I hold none" at hello says nothing about it.
    const harness = await startTurn({ awake: false });
    await harness.plane.surface().sendChatMessage("sage", "and the timeline?", { clientId: "client-2" });
    expect(harness.steers).toHaveLength(1);

    harness.plane.handleAttachHello("sage", []);

    expect(terminalOf(harness)).toBeUndefined();
    expect(harness.storage.nativeBotChat("sage", harness.now()).activeTurnId).toBe(harness.turnId);
    // Both messages are still exactly one queued turn and one queued steer, waiting to be run.
    expect(harness.turns).toHaveLength(1);
    expect(harness.steers).toHaveLength(1);
    // And the lease does not run against a turn nobody has been handed either.
    harness.advance(GRACE_WINDOW_MS + SWEEP_MS);
    expect(terminalOf(harness)).toBeUndefined();
    harness.close();
  });

  it("promotes several steers on one dead turn in the order the person sent them", async () => {
    const harness = await startTurn();
    await harness.plane.surface().sendChatMessage("sage", "and the timeline?", { clientId: "client-2" });
    await harness.plane.surface().sendChatMessage("sage", "and the budget?", { clientId: "client-3" });
    expect(harness.steers).toHaveLength(2);

    harness.plane.handleAttachHello("sage", []);

    // The oldest becomes the durable turn; the one that followed it is re-dispatched onto that
    // turn, in order, rather than silently replacing the first.
    expect(harness.turns).toHaveLength(2);
    expect(harness.turns[1]).toMatchObject({ text: "and the timeline?" });
    const promoted = String(harness.turns[1]?.["turnId"]);
    expect(harness.steers.at(-1)).toMatchObject({ turnId: promoted, text: "and the budget?" });
    expect(harness.storage.pendingNativeSteers("sage", harness.sessionId).map((steer) => steer.text))
      .toEqual(["and the budget?"]);
    harness.close();
  });

  it("keeps a steer across a gateway restart and still promotes it", async () => {
    const harness = await startTurn();
    await harness.plane.surface().sendChatMessage("sage", "and the timeline?", { clientId: "client-2" });

    // The gateway restarts. The in-process bookkeeping is gone; the person's words are not.
    const restarted = harness.restart();
    expect(restarted.storage.pendingNativeSteers("sage", harness.sessionId).map((steer) => steer.text))
      .toEqual(["and the timeline?"]);

    restarted.plane.handleAttachHello("sage", []);

    expect(harness.turns).toHaveLength(2);
    expect(harness.turns[1]).toMatchObject({ text: "and the timeline?" });
    restarted.close();
  });

  it("records a visible failed delivery when a steer cannot be promoted at all", async () => {
    const harness = await startTurn();
    await harness.plane.surface().sendChatMessage("sage", "and the timeline?", { clientId: "client-2" });
    harness.refuse();

    harness.plane.handleAttachHello("sage", []);

    // Nothing was dispatched, and the words are on the conversation rather than gone.
    expect(harness.turns).toHaveLength(1);
    const failed = harness.storage.nativeBotMessages("sage", harness.sessionId).at(-1);
    expect(failed?.marker).toBe("delivery.failed");
    expect(failed?.text).toContain("and the timeline?");
    expect(harness.storage.pendingNativeSteers("sage", harness.sessionId)).toEqual([]);
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

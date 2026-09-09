import { describe, expect, it } from "vitest";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { NativeBotDataPlane, TURN_DELIVERY_FAILED_TEXT } from "../src/hermes-bridge/native-data-plane.ts";
import { openStorage } from "../src/storage.ts";

/** Regression floor for a pre-fix plugin which treated an interim commit as spool-terminal. */
describe("native turn delivery watchdog", () => {
  async function start({ acknowledged = true }: { acknowledged?: boolean } = {}) {
    const storage = openStorage(":memory:");
    const frames: unknown[] = [];
    const interrupts: unknown[] = [];
    let now = 1_000_000;
    let sent: Record<string, unknown> | undefined;
    const ingress = {
      sendNativeTurn: (peer: string, input: Record<string, unknown>) => {
        sent = input;
        storage.enqueueAttachCommand(peer, "turn-command", { kind: "turn", ...input } as never, now);
        return true;
      },
      sendNativeInterrupt: (_peer: string, input: unknown) => { interrupts.push(input); return true; },
    } as unknown as AttachV1Ingress;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress, nativeBots: ["sage"], chatSuggestion: "",
      broadcast: (frame) => frames.push(frame), now: () => now,
      staleTurnSweepMs: 0,
    });
    const accepted = await plane.surface().sendChatMessage("sage", "make the change", { clientId: "c1" });
    const turnId = String(sent?.turnId);
    const delivery = storage.nativeBotTurnDelivery("sage", turnId)!;
    if (acknowledged) storage.ackAttachCommand("sage", delivery.sequence, delivery.commandId, now);
    return {
      storage, plane, frames, interrupts, sessionId: accepted.sessionId, turnId,
      now: () => now, advance: (ms: number) => { now += ms; },
      close: () => { plane.close(); storage.close(); },
    };
  }

  it("fails exactly one ACKed turn when an applied interim commit is falsely reported sealed", async () => {
    const h = await start();
    const interim = {
      kind: "event" as const, sequence: 1, eventId: "interim-event",
      event: {
        kind: "commit" as const, threadId: h.sessionId, turnId: h.turnId, messageId: "interim-message",
        blocks: [{ type: "paragraph" as const, text: "I changed part of it." }], continues: true,
      },
    };
    h.storage.acceptAttachEvent("sage", interim, h.now());
    expect(h.plane.handle("sage", interim)).toBe(true);
    h.storage.markAttachEventApplied("sage", interim.eventId, h.now());

    h.advance(30_000);
    const report = [{ turnId: h.turnId, execution: "active" as const, delivery: "sealed" as const,
      terminalEventId: interim.eventId, rejectedEvents: 0 }];
    expect(h.plane.handleAttachTurnHealth("sage", report)).toEqual([h.turnId]);
    expect(h.interrupts).toEqual([{ threadId: h.sessionId, turnId: h.turnId }]);
    expect(h.storage.nativeBotTurnTerminal("sage", h.sessionId, h.turnId)).toMatchObject({ status: "failed" });
    expect(h.storage.nativeBotMessages("sage", h.sessionId).filter((row) => row.text === TURN_DELIVERY_FAILED_TEXT)).toHaveLength(1);
    expect(h.frames.some((frame) => (frame as { type?: string; phase?: string }).type === "bot_chat_state"
      && (frame as { phase?: string }).phase === "failed")).toBe(true);

    // A replayed heartbeat cannot append a second notice, interrupt, or promoted turn.
    expect(h.plane.handleAttachTurnHealth("sage", report)).toEqual([]);
    expect(h.interrupts).toHaveLength(1);
    expect(h.storage.nativeBotMessages("sage", h.sessionId).filter((row) => row.text === TURN_DELIVERY_FAILED_TEXT)).toHaveLength(1);
    expect(h.storage.nativeBotActiveTurns("sage")).toEqual([]);
    h.close();
  });

  it("only marks a quiet ACKed turn as checking and clears it on real progress", async () => {
    const h = await start();
    const thinking = {
      kind: "event" as const, sequence: 1, eventId: "thinking-event",
      event: { kind: "thinking" as const, threadId: h.sessionId, turnId: h.turnId, text: "working", seq: 1, lastActiveAt: h.now() },
    };
    expect(h.plane.handle("sage", thinking)).toBe(true);
    h.advance(30_000);
    expect(h.plane.handleAttachTurnHealth("sage", undefined)).toEqual([]);
    expect(h.storage.nativeBotTurnTerminal("sage", h.sessionId, h.turnId)).toBeUndefined();
    expect(h.frames.filter((frame) => (frame as { type?: string; deliveryStatus?: string }).type === "bot_chat_state")
      .at(-1)).toMatchObject({ running: true, deliveryStatus: "checking" });

    const progress = { ...thinking, sequence: 2, eventId: "thinking-progress", event: { ...thinking.event, seq: 2, text: "still working" } };
    expect(h.plane.handle("sage", progress)).toBe(true);
    expect(h.frames.filter((frame) => (frame as { type?: string }).type === "bot_chat_state").at(-1))
      .not.toMatchObject({ deliveryStatus: "checking" });
    h.close();
  });

  it("leaves a turn waiting for approval alone even after its last progress is old", async () => {
    const h = await start();
    const approval = {
      kind: "event" as const, sequence: 1, eventId: "approval-event",
      event: {
        kind: "approval" as const, threadId: h.sessionId, turnId: h.turnId,
        approvalId: "approval-1", callId: "call-1", name: "workspace_write", status: "pending" as const,
      },
    };
    expect(h.plane.handle("sage", approval)).toBe(true);
    h.advance(60_000);
    expect(h.plane.handleAttachTurnHealth("sage", undefined)).toEqual([]);
    expect(h.storage.nativeBotTurnTerminal("sage", h.sessionId, h.turnId)).toBeUndefined();
    expect(h.frames.filter((frame) => (frame as { type?: string }).type === "bot_chat_state").at(-1))
      .not.toMatchObject({ deliveryStatus: "checking" });
    h.close();
  });

  it("does not mark a turn checking while its elapsed time was suspended", async () => {
    const h = await start();
    h.storage.recordNativeInteraction({
      bot: "sage", kind: "approval", interactionId: "approval-1", sessionId: h.sessionId, turnId: h.turnId,
      status: "pending", expiresAt: h.now() + 60_000, payload: {}, updatedAt: h.now(),
    });
    h.advance(20_000);
    h.storage.resolveNativeInteraction("sage", "approval", "approval-1", "approved", h.now());
    h.advance(29_999);
    expect(h.plane.handleAttachTurnHealth("sage", undefined)).toEqual([]);
    expect(h.frames.filter((frame) => (frame as { type?: string; deliveryStatus?: string }).type === "bot_chat_state")
      .at(-1)).not.toMatchObject({ deliveryStatus: "checking" });
    h.advance(1);
    expect(h.plane.handleAttachTurnHealth("sage", undefined)).toEqual([]);
    expect(h.frames.filter((frame) => (frame as { type?: string; deliveryStatus?: string }).type === "bot_chat_state")
      .at(-1)).toMatchObject({ deliveryStatus: "checking" });
    h.close();
  });

  it("does not accept an unACKed interim seal as failure proof", async () => {
    const h = await start({ acknowledged: false });
    const interim = {
      kind: "event" as const, sequence: 1, eventId: "unacked-interim-event",
      event: {
        kind: "commit" as const, threadId: h.sessionId, turnId: h.turnId, messageId: "interim-message",
        blocks: [{ type: "paragraph" as const, text: "I changed part of it." }], continues: true,
      },
    };
    h.storage.acceptAttachEvent("sage", interim, h.now());
    h.storage.markAttachEventApplied("sage", interim.eventId, h.now());
    const report = [{ turnId: h.turnId, execution: "active" as const, delivery: "sealed" as const,
      terminalEventId: interim.eventId, rejectedEvents: 0 }];
    expect(h.plane.handleAttachTurnHealth("sage", report)).toEqual([]);
    expect(h.storage.nativeBotTurnTerminal("sage", h.sessionId, h.turnId)).toBeUndefined();
    expect(h.interrupts).toEqual([]);
    h.close();
  });

  it("does not accept a final or foreign report as failure proof", async () => {
    const h = await start();
    const final = {
      kind: "event" as const, sequence: 1, eventId: "final-event",
      event: { kind: "commit" as const, threadId: h.sessionId, turnId: h.turnId, messageId: "final-message", blocks: [{ type: "paragraph" as const, text: "done" }] },
    };
    h.storage.acceptAttachEvent("sage", final, h.now());
    h.storage.markAttachEventApplied("sage", final.eventId, h.now());
    const report = [{ turnId: h.turnId, execution: "active" as const, delivery: "sealed" as const, terminalEventId: final.eventId, rejectedEvents: 0 }];
    expect(h.plane.handleAttachTurnHealth("sage", report)).toEqual([]);
    expect(h.plane.handleAttachTurnHealth("other-peer", report)).toEqual([]);
    expect(h.storage.nativeBotTurnTerminal("sage", h.sessionId, h.turnId)).toBeUndefined();
    expect(h.interrupts).toEqual([]);
    h.close();
  });
});

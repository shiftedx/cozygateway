/** Capability 56: `ApprovalEvent.detail` on attach-v1. A runtime peer may send a short sentence
 *  naming what the approval concretely covers (for example which Chrome and which profile
 *  `my_browser_open` would drive). The gateway carries it, sanitized, on the Bot Mode
 *  `bot_approval_pending` frame and the durable interaction row, and omits it entirely when the
 *  raising event sent none -- so a pre-56 payload shape never changes. */
import { describe, expect, it } from "vitest";
import type { BotApprovalPendingFrame, ServerFrame } from "cozygateway-contract";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

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
  const ingress = {
    sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
      sent = input;
      storage.enqueueAttachCommand(bot, "turn-command", { kind: "turn", ...input } as never, now);
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
    now: () => now++,
  });
  const accepted = await plane.surface().sendChatMessage("sage", "open a browser tab", {
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

function approvalEvent(
  sessionId: string,
  turnId: string,
  approvalId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    kind: "event" as const,
    sequence: 1,
    eventId: approvalId,
    event: {
      kind: "approval" as const,
      threadId: sessionId,
      turnId,
      approvalId,
      callId: "call-1",
      name: "my_browser_open",
      status: "pending" as const,
      ...extra,
    },
  };
}

function pendingFrames(frames: ServerFrame[]): BotApprovalPendingFrame[] {
  return frames.filter(
    (frame): frame is BotApprovalPendingFrame => frame.type === "bot_approval_pending",
  );
}

describe("approval detail (capability 56)", () => {
  it("reaches the Bot Mode client when the runtime peer sends one", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    expect(
      plane.handle(
        "sage",
        approvalEvent(sessionId, turnId, "approval-1", {
          detail: "Would drive Chrome (Work profile).",
        }),
      ),
    ).toBe(true);

    const pending = pendingFrames(harness.frames);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      toolCallId: "approval-1",
      name: "my_browser_open",
      detail: "Would drive Chrome (Work profile).",
    });
    harness.close();
  });

  it("is byte-identical to today's payload when no detail is sent", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    expect(plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1"))).toBe(true);

    const pending = pendingFrames(harness.frames);
    expect(pending).toHaveLength(1);
    expect(pending[0]).not.toHaveProperty("detail");
    expect(Object.keys(pending[0]!).sort()).toEqual(
      ["bot", "sessionId", "toolCallId", "turnId", "type", "name", "updatedAt"].sort(),
    );
    harness.close();
  });

  it("sanitizes an overlong or control-bearing detail instead of dropping the frame", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    const word = "profile";
    const overlong = Array.from({ length: 80 }, () => word).join(" ");
    // \u0000 (NUL, C0), \u0007 (BEL, C0), \u200b (zero-width space, Unicode Format/Cf).
    const controlBearing = "Chrome\u0000 (Work\u200bprofile)\u0007.";

    expect(
      plane.handle(
        "sage",
        approvalEvent(sessionId, turnId, "approval-overlong", { detail: overlong }),
      ),
    ).toBe(true);
    expect(
      plane.handle(
        "sage",
        approvalEvent(sessionId, turnId, "approval-controls", { detail: controlBearing }),
      ),
    ).toBe(true);

    const pending = pendingFrames(harness.frames);
    expect(pending).toHaveLength(2);
    // Neither malformed frame was dropped: both approvals are pending and visible.
    const overlongFrame = pending.find((frame) => frame.toolCallId === "approval-overlong");
    const controlsFrame = pending.find((frame) => frame.toolCallId === "approval-controls");
    expect(overlongFrame).toBeDefined();
    expect(controlsFrame).toBeDefined();
    expect([...overlongFrame!.detail!].length).toBeLessThanOrEqual(400);
    expect(overlongFrame!.detail!.endsWith("…")).toBe(true);
    expect(controlsFrame!.detail).toBe("Chrome (Workprofile).");
    harness.close();
  });

  it("carries detail on the durable record so a reconnecting app's rebroadcast matches the live frame", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    expect(
      plane.handle(
        "sage",
        approvalEvent(sessionId, turnId, "approval-1", {
          detail: "Would drive Chrome (Work profile).",
        }),
      ),
    ).toBe(true);

    const firstCount = pendingFrames(harness.frames).length;
    expect(firstCount).toBe(1);

    // A reconnecting app re-pins the chat, which rebroadcasts every still-pending interaction.
    await plane.surface().chatHistory("sage");

    const rebroadcast = pendingFrames(harness.frames).slice(firstCount);
    expect(rebroadcast).toHaveLength(1);
    expect(rebroadcast[0]).toMatchObject({
      toolCallId: "approval-1",
      detail: "Would drive Chrome (Work profile).",
    });
    harness.close();
  });

  it("a pre-56 client is unaffected: an event carrying no detail never introduces the field anywhere", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    expect(plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1"))).toBe(true);
    await plane.surface().chatHistory("sage");

    for (const frame of pendingFrames(harness.frames)) {
      expect(frame).not.toHaveProperty("detail");
    }
    harness.close();
  });
});

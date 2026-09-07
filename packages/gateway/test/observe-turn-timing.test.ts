import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { ObservationRing } from "../src/observe/index.ts";

/** Dashboard packet D2, the per-turn half of section 10. Everything here rides on hooks that
 *  already fired before the ring existed, so the point of these tests is as much that the turn
 *  still behaves as that the rows appear. */

const AT = 1_700_000_000_000;

interface Harness {
  storage: Storage;
  plane: NativeBotDataPlane;
  observe: ObservationRing;
  frames: ServerFrame[];
  sessionId: string;
  turnId: string;
  close: () => void;
}

async function startTurn(enabled: boolean): Promise<Harness> {
  const storage = openStorage(":memory:");
  const observe = new ObservationRing({
    store: storage.observe,
    options: { enabled, retentionDays: 7 },
    now: () => AT,
  });
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
    observe,
    nativeBots: ["sage"],
    chatSuggestion: "",
    broadcast: (frame) => frames.push(frame),
    now: () => now++,
  });
  const accepted = await plane.surface().sendChatMessage("sage", "audit every sensor", {
    clientId: "client-1",
  });
  const turnId = String(sent?.turnId);
  return {
    storage, plane, observe, frames,
    sessionId: accepted.sessionId,
    turnId,
    close: () => {
      plane.close();
      storage.close();
    },
  };
}

function draft(sessionId: string, turnId: string, sequence: number, text: string) {
  return {
    kind: "event" as const,
    sequence,
    eventId: `draft-${sequence}`,
    event: {
      kind: "draft" as const,
      threadId: sessionId,
      turnId,
      blocks: [{ type: "paragraph" as const, text }],
    },
  };
}

function commit(sessionId: string, turnId: string, sequence: number) {
  return {
    kind: "event" as const,
    sequence,
    eventId: `commit-${sequence}`,
    event: {
      kind: "commit" as const,
      threadId: sessionId,
      turnId,
      messageId: `m-${sequence}`,
      blocks: [{ type: "paragraph" as const, text: "done" }],
      final: true,
    },
  };
}

function samples(storage: Storage, series: string) {
  return storage.observe.samples({ series, from: 0, to: Number.MAX_SAFE_INTEGER });
}

describe("per-turn timing on the native data plane", () => {
  it("writes ttft, turn duration, the delta frame count and the gateway handling legs", async () => {
    const harness = await startTurn(true);
    const { plane, storage, sessionId, turnId } = harness;
    try {
      // Admission already happened inside sendChatMessage. Dispatch is the peer taking the command.
      plane.taskTurnQueued("sage", { threadId: sessionId, turnId });
      expect(plane.handle("sage", draft(sessionId, turnId, 1, "thinking"))).toBe(true);
      expect(plane.handle("sage", draft(sessionId, turnId, 2, "thinking more"))).toBe(true);
      expect(plane.handle("sage", draft(sessionId, turnId, 3, "nearly"))).toBe(true);
      expect(plane.handle("sage", commit(sessionId, turnId, 4))).toBe(true);

      // One first-token measurement per turn, however many drafts arrive.
      expect(samples(storage, "ttft_ms")).toHaveLength(1);
      expect(samples(storage, "ttft_ms")[0]?.bot).toBe("sage");

      const frames = samples(storage, "delta_frames");
      expect(frames).toHaveLength(1);
      expect(frames[0]?.value).toBe(3);

      const turnMs = samples(storage, "turn_ms");
      expect(turnMs).toHaveLength(1);
      expect(turnMs[0]?.value).toBeGreaterThanOrEqual(0);
      // Monotonic, so a wall clock frozen at AT cannot have produced it, and it is a duration
      // rather than a timestamp.
      expect(turnMs[0]?.value).toBeLessThan(60_000);
      expect(turnMs[0]?.at).toBe(AT);

      // Two legs of gateway handling: admission to dispatch, and terminal to broadcast.
      expect(samples(storage, "gateway_handle_ms")).toHaveLength(2);

      const terminals = storage.observe.events({ kind: "turn_terminal", from: 0, to: Number.MAX_SAFE_INTEGER });
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.bot).toBe("sage");
      expect(terminals[0]?.ref).toBe(turnId);
      expect(JSON.parse(terminals[0]?.detailJson ?? "{}")).toEqual({ status: "completed" });
      // The reply text the turn produced never reaches the ring.
      expect(terminals[0]?.detailJson).not.toContain("done");
      expect(terminals[0]?.detailJson).not.toContain("sensor");
      expect(storage.observe.refused).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("still delivers the turn's frames and writes nothing when observability is off", async () => {
    const harness = await startTurn(false);
    const { plane, storage, frames, sessionId, turnId } = harness;
    try {
      plane.taskTurnQueued("sage", { threadId: sessionId, turnId });
      expect(plane.handle("sage", draft(sessionId, turnId, 1, "thinking"))).toBe(true);
      expect(plane.handle("sage", commit(sessionId, turnId, 2))).toBe(true);

      // The turn is unchanged: the app still sees its deltas and its terminal.
      const deltas = frames.filter((frame) => frame.type === "bot_chat_delta");
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.some((frame) => "done" in frame && frame.done === true)).toBe(true);

      for (const series of ["ttft_ms", "turn_ms", "delta_frames", "gateway_handle_ms"]) {
        expect(samples(storage, series), series).toHaveLength(0);
      }
      expect(storage.observe.events({ from: 0, to: Number.MAX_SAFE_INTEGER })).toHaveLength(0);
    } finally {
      harness.close();
    }
  });
});

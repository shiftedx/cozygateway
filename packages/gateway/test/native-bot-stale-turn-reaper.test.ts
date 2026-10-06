import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { ServerFrame } from "cozygateway-contract";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/** The belt under issue #190: a native turn nothing ever terminalizes.
 *
 *  Live, `/compact` from the composer opened a durable turn that Hermes consumed as a command, so
 *  no agent turn ran and no commit or terminal ever arrived. The app showed "thinking" for 75
 *  minutes, through a container restart, and three interrupts were acked without producing a
 *  terminal. The plugin now seals both cases; this is the server-side floor for every case it
 *  cannot see -- including a plugin that hangs mid-command and never returns at all.
 *
 *  The signal is total silence. A working turn is noisy (tool steps, drafts, and since #189
 *  interim commits), so a legitimately long run must never be reaped -- the last test here is
 *  that negative. */

const SWEEP_MS = 60_000;
const GRACE_MS = 120_000;
const CEILING_MS = 1_800_000;

interface Harness {
  storage: Storage;
  plane: NativeBotDataPlane;
  frames: ServerFrame[];
  sessionId: string;
  turnId: string;
  interrupts: Array<Record<string, unknown>>;
  advance: (ms: number) => void;
  tool: (callId: string, status: "running" | "ok") => void;
  close: () => void;
}

async function startTurn(opts: { queuedAtOffset?: number } = {}): Promise<Harness> {
  const storage = openStorage(":memory:");
  const frames: ServerFrame[] = [];
  let now = 1_000_000;
  let sent: Record<string, unknown> | undefined;
  const interrupts: Array<Record<string, unknown>> = [];
  let sequence = 0;
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
    now: () => now,
    log: () => {},
    staleTurnSweepMs: SWEEP_MS,
    staleTurnInterruptGraceMs: GRACE_MS,
    staleTurnCeilingMs: CEILING_MS,
  });
  const accepted = await plane.surface().sendChatMessage("sage", "/compact", {
    clientId: "client-1",
  });
  const sessionId = accepted.sessionId;
  const turnId = String(sent?.turnId);
  return {
    storage,
    plane,
    frames,
    sessionId,
    turnId,
    interrupts,
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
    tool: (callId, status) => {
      sequence += 1;
      plane.handle("sage", {
        kind: "event",
        sequence,
        eventId: `${callId}-${status}`,
        event: {
          kind: "tool",
          threadId: sessionId,
          turnId,
          callId,
          name: "terminal",
          status,
        },
      });
    },
    close: () => {
      plane.close();
      storage.close();
    },
  };
}

function terminalOf(harness: Harness) {
  return harness.storage.nativeBotTurnTerminal("sage", harness.sessionId, harness.turnId);
}

describe("the gateway reaps a native turn that has gone dark", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("seals an acked interrupt that produced no terminal", async () => {
    const harness = await startTurn();

    expect(await harness.plane.surface().stopChat("sage")).toBe("stopped");
    expect(harness.interrupts).toHaveLength(1);
    // The interrupt alone changes nothing: the plugin acked a stop for work that was not running.
    harness.advance(SWEEP_MS);
    expect(terminalOf(harness)).toBeUndefined();

    harness.advance(GRACE_MS);

    expect(terminalOf(harness)).toMatchObject({ status: "interrupted" });
    const state = harness.frames.filter((frame) => frame.type === "bot_chat_state").at(-1);
    expect(state).toMatchObject({ phase: "failed", running: false });
    expect((await harness.plane.surface().chatHistory("sage")).running).toBe(false);
    harness.close();
  });

  it("seals a turn that has produced nothing at all past the hard ceiling", async () => {
    const harness = await startTurn();

    harness.advance(CEILING_MS - SWEEP_MS);
    expect(terminalOf(harness)).toBeUndefined();

    harness.advance(SWEEP_MS);

    expect(terminalOf(harness)).toMatchObject({ status: "timed_out" });
    const delta = harness.frames.filter((frame) => frame.type === "bot_chat_delta").at(-1);
    expect(delta).toMatchObject({ done: true });
    harness.close();
  });

  it("never reaps a long run that keeps producing tool events", async () => {
    const harness = await startTurn();

    // Three hours of real work, noisy the whole way: well past both the interrupt grace and the
    // hard ceiling, and never once silent for a full window.
    for (let step = 0; step < 12; step += 1) {
      harness.tool(`call-${step}`, "running");
      harness.advance(CEILING_MS / 2);
      harness.tool(`call-${step}`, "ok");
      harness.advance(CEILING_MS / 2);
    }

    expect(terminalOf(harness)).toBeUndefined();
    expect((await harness.plane.surface().chatHistory("sage")).running).toBe(true);
    harness.close();
  });

  it("reaps a stopped long run once its tool events dry up", async () => {
    const harness = await startTurn();

    harness.tool("call-1", "running");
    harness.advance(CEILING_MS / 2);
    expect(await harness.plane.surface().stopChat("sage")).toBe("stopped");
    harness.advance(GRACE_MS);

    expect(terminalOf(harness)).toMatchObject({ status: "interrupted" });
    harness.close();
  });

  it("leaves the reaper off when the sweep is disabled", async () => {
    const storage = openStorage(":memory:");
    let now = 1_000_000;
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
      broadcast: () => {},
      now: () => now,
      log: () => {},
      staleTurnSweepMs: 0,
    });
    const accepted = await plane.surface().sendChatMessage("sage", "/compact", {});
    await plane.surface().stopChat("sage");

    now += CEILING_MS * 4;
    vi.advanceTimersByTime(CEILING_MS * 4);

    expect(
      storage.nativeBotTurnTerminal("sage", accepted.sessionId, String(sent?.turnId)),
    ).toBeUndefined();
    plane.close();
    storage.close();
  });
});

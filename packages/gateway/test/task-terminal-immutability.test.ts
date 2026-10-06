import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStorage } from "../src/storage.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { ServerFrame } from "cozygateway-contract";

describe("Task Run first-terminal immutability at native ingress", () => {
  for (const status of ["timed_out", "failed", "interrupted"] as const) {
    for (const continues of [false, true]) {
      it(`delivers a late ${continues ? "interim" : "final"} reply after ${status} without rewriting its seal or clearing a newer turn`, async () => {
        const storage = openStorage(":memory:");
        const frames: ServerFrame[] = [];
        const plane = new NativeBotDataPlane({
          control: {} as BotsSurface, storage, nativeBots: ["sage"], chatSuggestion: "", now: () => 3,
          broadcast: (frame) => frames.push(frame),
          ingress: { sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
            const command = storage.enqueueAttachCommand(bot, String(input.turnId), { kind: "turn", ...input } as never, 1);
            storage.ackAttachCommand(bot, command.sequence, command.commandId, 2);
            return true;
          } } as unknown as AttachV1Ingress,
        });
        const sent = await plane.surface().sendChatMessage("sage", "work");
        const turnId = storage.nativeBotChat("sage", 3).activeTurnId!;
        storage.recordNativeBotTerminal({ bot: "sage", sessionId: sent.sessionId, turnId, status, completedAt: 3 });
        storage.clearNativeBotTurn("sage", sent.sessionId, turnId, 3);
        storage.setNativeBotTurn("sage", sent.sessionId, "newer-turn", 3);
        const frame = { kind: "event" as const, sequence: 1, eventId: "late", event: {
          kind: "commit" as const, threadId: sent.sessionId, turnId, messageId: "late-reply",
          blocks: [{ type: "paragraph" as const, text: "Durable answer" }], ...(continues ? { continues: true as const } : {}),
        } };
        expect(plane.handle("sage", frame)).toBe(true);
        expect(plane.handle("sage", frame)).toBe(true);
        expect(storage.nativeBotTurnTerminal("sage", sent.sessionId, turnId)?.status).toBe(status);
        expect(storage.nativeBotChat("sage", 3).activeTurnId).toBe("newer-turn");
        expect(storage.nativeBotMessages("sage", sent.sessionId).filter((message) => message.id === "late-reply")).toHaveLength(1);
        expect(frames.filter((frame) => frame.type === "bot_chat_state" && frame.status === "completed")).toHaveLength(0);
        plane.close(); storage.close();
      });
    }
  }
  it("keeps the attach journal open after an interim commit so final proof can arrive", () => {
    const root = join(process.cwd(), "../../benchmark-runs/2b-durable-task");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "interim-restart-"));
    const path = join(directory, "gateway.sqlite");
    let storage = openStorage(path);
    storage.enqueueAttachCommand("sage", "turn", { kind: "turn", threadId: "session", turnId: "run", messageId: "user", text: "work" }, 1);
    const interim = { kind: "event" as const, sequence: 1, eventId: "interim", event: { kind: "commit" as const, threadId: "session", turnId: "run", messageId: "interim-reply", blocks: [{ type: "paragraph" as const, text: "Still working" }], continues: true as const } };
    expect(storage.acceptAttachEvent("sage", interim, 2).status).toBe("accepted");
    storage.close();
    storage = openStorage(path);
    expect(storage.acceptAttachEvent("sage", interim, 2).status).toBe("duplicate");
    expect(storage.acceptAttachEvent("sage", { kind: "event", sequence: 2, eventId: "verify", event: { kind: "tool", threadId: "session", turnId: "run", callId: "check", name: "test", role: "verification", status: "running" } }, 3).status).toBe("accepted");
    expect(storage.acceptAttachEvent("sage", { ...interim, sequence: 3, eventId: "final", event: { kind: "commit", threadId: "session", turnId: "run", messageId: "final-reply", blocks: [] } }, 4).status).toBe("accepted");
    expect(storage.acceptAttachEvent("sage", { kind: "event", sequence: 4, eventId: "late-failure", event: { kind: "failed", threadId: "session", turnId: "run", messageId: "late" } }, 5).status).toBe("ignored_terminal");
    storage.close();
    rmSync(directory, { recursive: true });
  });
  it("refuses a storage-level rewrite of the first outcome", () => {
    const storage = openStorage(":memory:");
    storage.recordNativeBotTerminal({ bot: "sage", sessionId: "session", turnId: "run", status: "failed", completedAt: 1 });
    storage.recordNativeBotTerminal({ bot: "sage", sessionId: "session", turnId: "run", status: "completed", completedAt: 2 });
    expect(storage.nativeBotTurnTerminal("sage", "session", "run")).toMatchObject({ status: "failed" });
    storage.close();
  });
});

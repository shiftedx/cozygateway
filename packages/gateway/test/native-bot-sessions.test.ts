import { describe, expect, it, vi } from "vitest";

import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import {
  BotSessionConflict,
  BotSessionNotFound,
  type BotsSurface,
} from "../src/hermes-bridge/bridge.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { openStorage } from "../src/storage.ts";

function nativePlane(bots = ["sage", "luna"]) {
  const storage = openStorage(":memory:");
  const frames: unknown[] = [];
  const commands: Array<{ bot: string; threadId: string }> = [];
  const control = {
    newSession: vi.fn(),
    sessions: vi.fn(),
    adoptSession: vi.fn(),
    canonicalChat: vi.fn(),
    chatHistory: vi.fn(),
    sendChatMessage: vi.fn(),
  } as unknown as BotsSurface;
  const ingress = {
    sendNativeTurn: (bot: string, turn: { threadId: string }) => {
      commands.push({ bot, threadId: turn.threadId });
      return true;
    },
    sendNativeInterrupt: () => true,
  } as unknown as AttachV1Ingress;
  let now = 1_000;
  const plane = new NativeBotDataPlane({
    control,
    storage,
    ingress,
    nativeBots: bots,
    chatSuggestion: "",
    broadcast: (frame) => frames.push(frame),
    now: () => now++,
  });
  return { storage, frames, commands, control, plane, surface: plane.surface() };
}

describe("attach-v1 native Bot Mode sessions", () => {
  it("creates, selects, and lists local conversations newest first without Dashboard calls", async () => {
    const h = nativePlane();
    const first = (await h.surface.canonicalChat("sage")).sessionId;
    h.storage.appendNativeBotMessage({ bot: "sage", sessionId: first, messageId: "first", role: "user", text: "older", at: 1_000 });

    const created = await h.surface.newSession("sage");
    expect(created.previousSessionId).toBe(first);
    expect(created.sessionId).not.toBe(first);
    expect(h.frames.at(-1)).toMatchObject({
      type: "bot_chat_adopted", bot: "sage", sessionId: created.sessionId, previousSessionId: first,
    });

    const listed = await h.surface.sessions("sage", 100);
    expect(listed.activeSessionId).toBe(created.sessionId);
    expect(listed.sessions).toMatchObject([
      { id: created.sessionId, kind: "conversation", title: "Bot Chat" },
      { id: first, kind: "conversation", title: "Bot Chat", preview: "older" },
    ]);
    expect(h.control.newSession).not.toHaveBeenCalled();
    expect(h.control.sessions).not.toHaveBeenCalled();
    h.plane.close();
    h.storage.close();
  });

  it("adopts an owned local conversation so history and subsequent sends use it", async () => {
    const h = nativePlane();
    const first = (await h.surface.canonicalChat("sage")).sessionId;
    h.storage.appendNativeBotMessage({ bot: "sage", sessionId: first, messageId: "one", role: "assistant", text: "first chat", at: 2_000 });
    const second = (await h.surface.newSession("sage")).sessionId;
    h.storage.appendNativeBotMessage({ bot: "sage", sessionId: second, messageId: "two", role: "assistant", text: "second chat", at: 3_000 });

    await h.surface.adoptSession("sage", first, 100);
    expect(await h.surface.chatHistory("sage")).toMatchObject({
      sessionId: first,
      messages: [{ text: "first chat" }],
    });
    await h.surface.sendChatMessage("sage", "continue");
    expect(h.commands.at(-1)).toEqual({ bot: "sage", threadId: first });
    expect(h.frames.findLast((frame) => (frame as { type?: string }).type === "bot_chat_adopted")).toMatchObject({
      type: "bot_chat_adopted", bot: "sage", sessionId: first, previousSessionId: second,
    });
    expect(h.control.adoptSession).not.toHaveBeenCalled();
    expect(h.control.chatHistory).not.toHaveBeenCalled();
    expect(h.control.sendChatMessage).not.toHaveBeenCalled();
    h.plane.close();
    h.storage.close();
  });

  it("keeps ownership errors byte-compatible for unknown and another bot's session", async () => {
    const h = nativePlane();
    const luna = (await h.surface.canonicalChat("luna")).sessionId;
    await expect(h.surface.adoptSession("sage", "missing", 100)).rejects.toBeInstanceOf(BotSessionNotFound);
    await expect(h.surface.adoptSession("sage", luna, 100)).rejects.toBeInstanceOf(BotSessionConflict);
    h.plane.close();
    h.storage.close();
  });

  it("does not claim a core thread merely because it shares the Hermes profile token", () => {
    const h = nativePlane(["sage"]);
    const coreCommit: AttachV1EventFrame = {
      kind: "event" as const,
      sequence: 1,
      eventId: "core-commit",
      event: {
        kind: "commit" as const,
        threadId: "core:thread-1",
        turnId: "core-turn-1",
        messageId: "core-reply-1",
        blocks: [{ type: "paragraph", text: "this belongs to /threads" }],
      },
    };
    expect(h.plane.canAccept("sage", coreCommit)).toBe(false);
    expect(h.plane.handle("sage", coreCommit)).toBe(false);
    h.plane.close();
    h.storage.close();
  });

  it("reset starts a fresh selected conversation while retaining the old local session", async () => {
    const h = nativePlane();
    const first = (await h.surface.canonicalChat("sage")).sessionId;
    h.storage.appendNativeBotMessage({ bot: "sage", sessionId: first, messageId: "one", role: "user", text: "keep me", at: 2_000 });

    const reset = await h.surface.resetChat("sage");
    expect(reset).toMatchObject({ previousSessionId: first });
    expect((await h.surface.sessions("sage", 100)).sessions.map((session) => session.id)).toContain(first);
    expect(await h.surface.chatHistory("sage")).toMatchObject({ sessionId: reset.sessionId, messages: [] });
    expect(h.frames.at(-1)).toMatchObject({ type: "bot_chat_reset", bot: "sage", sessionId: reset.sessionId, previousSessionId: first });
    h.plane.close();
    h.storage.close();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "cozygateway-contract";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import { BackendUnavailable } from "../src/errors.ts";
import { openStorage } from "../src/storage.ts";

describe("attach-v1 native Bot Mode plane", () => {
  it("lists only configured attach identities", () => {
    const storage = openStorage(":memory:");
    const control = {
      roster: () => ({
        bots: [
          { name: "sage", displayName: "Sage" },
          { name: "unmanaged", displayName: "Unmanaged" },
        ],
        updatedAt: 1,
        stale: false,
        hermesState: "connected",
      }),
    } as unknown as BotsSurface;
    const plane = new NativeBotDataPlane({
      control,
      storage,
      ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: () => undefined,
    });

    expect(plane.surface().roster().bots.map((bot) => bot.name)).toEqual(["sage"]);
    plane.close();
    storage.close();
  });

  it("submits and settles native text without dashboard chat RPC", async () => {
    const storage = openStorage(":memory:");
    const dashboardSend = vi.fn();
    const frames: ServerFrame[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const control = {
      sendChatMessage: dashboardSend,
      chatHistory: vi.fn(async () => ({ sessionId: "dashboard-sage", adoption: "pin", messages: [], running: false, inflight: false, updatedAt: 1 })),
    } as unknown as BotsSurface;
    const ingress = {
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        sent.push(input);
        storage.enqueueAttachCommand(bot, "turn-command", { kind: "turn", ...input } as never, now);
        return true;
      },
      sendNativeInterrupt: () => true,
      sendApprovalResolution: () => true,
    } as unknown as AttachV1Ingress;
    let now = 100;
    const plane = new NativeBotDataPlane({ control, storage, ingress, nativeBots: ["Sage"], chatSuggestion: "Say hello", broadcast: (frame) => frames.push(frame), now: () => now++ });
    const surface = plane.surface();

    expect(await surface.chatHistory("sage")).toMatchObject({ suggestion: "Say hello", messages: [] });

    const accepted = await surface.sendChatMessage("sage", "hello", { clientId: "client-1" });
    expect(dashboardSend).not.toHaveBeenCalled();
    expect(accepted.message).toMatchObject({ id: "client-1", role: "user", text: "hello" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId: accepted.sessionId, messageId: "client-1", text: "hello" });

    const turnId = String(sent[0]?.turnId);
    expect(plane.handle("sage", { kind: "event", sequence: 1, eventId: "draft-1", event: { kind: "draft", threadId: accepted.sessionId, turnId, blocks: [{ type: "paragraph", text: "hel" }] } })).toBe(true);
    expect(plane.handle("sage", { kind: "event", sequence: 2, eventId: "commit-1", event: { kind: "commit", threadId: accepted.sessionId, turnId, messageId: "answer-1", blocks: [{ type: "paragraph", text: "hello back" }], mediaIds: ["missing-media"] } })).toBe(true);

    const history = await surface.chatHistory("sage");
    expect(history.suggestion).toBeUndefined();
    expect(history.messages.map((message) => [message.role, message.text])).toEqual([["user", "hello"], ["assistant", "hello back"]]);
    expect(history.messages.at(-1)?.attachments).toBeUndefined();
    expect(frames.some((frame) => frame.type === "bot_chat_delta")).toBe(true);
    expect(frames.some((frame) => frame.type === "bot_chat" && frame.messages.some((message) => message.id === "answer-1"))).toBe(true);
    expect(frames.at(-1)).toMatchObject({ type: "bot_chat", bot: "sage" });
    storage.close();
  });

  it("steers a follow-up into the active native turn without replacing its binding", async () => {
    const storage = openStorage(":memory:");
    const turns: Array<Record<string, unknown>> = [];
    const steers: Array<Record<string, unknown>> = [];
    const ingress = {
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        turns.push(input);
        storage.enqueueAttachCommand(
          bot,
          `turn:${String(input.turnId)}`,
          { kind: "turn", ...input } as never,
          1,
        );
        return true;
      },
      sendNativeSteer: (_bot: string, input: Record<string, unknown>) => {
        steers.push(input);
        return true;
      },
      sendNativeInterrupt: () => true,
    } as unknown as AttachV1Ingress;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: () => undefined,
      now: () => 10,
    });
    const surface = plane.surface();

    const first = await surface.sendChatMessage("sage", "first", {
      clientId: "first",
    });
    await surface.sendChatMessage("sage", "follow up", { clientId: "second" });

    expect(turns).toHaveLength(1);
    expect(steers).toEqual([
      expect.objectContaining({
        threadId: first.sessionId,
        turnId: turns[0]?.turnId,
        messageId: "second",
        text: "follow up",
      }),
    ]);
    expect(await surface.chatHistory("sage")).toMatchObject({
      running: true,
      messages: [{ id: "first" }, { id: "second" }],
    });

    expect(
      plane.handle("sage", {
        kind: "event",
        sequence: 1,
        eventId: "done",
        event: {
          kind: "commit",
          threadId: first.sessionId,
          turnId: String(turns[0]?.turnId),
          messageId: "answer",
          blocks: [{ type: "paragraph", text: "done" }],
        },
      }),
    ).toBe(true);
    expect(await surface.chatHistory("sage")).toMatchObject({ running: false });
    plane.close();
    storage.close();
  });

  it("does not persist text, photos, or media when attach admission fails", async () => {
    const storage = openStorage(":memory:");
    let rejectedMediaId: string | undefined;
    const ingress = {
      sendNativeTurn: (
        _bot: string,
        input: { mediaIds?: string[] },
      ) => {
        rejectedMediaId = input.mediaIds?.[0];
        return false;
      },
      sendNativeSteer: () => false,
    } as unknown as AttachV1Ingress;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: () => undefined,
      now: () => 10,
    });
    const surface = plane.surface();

    await expect(surface.sendChatMessage("sage", "not queued")).rejects.toBeInstanceOf(
      BackendUnavailable,
    );
    expect((await surface.chatHistory("sage")).messages).toEqual([]);

    await expect(
      surface.sendChatPhoto("sage", {
        bytes: new Uint8Array([1, 2, 3]),
        mime: "image/png",
        ext: "png",
        text: "not queued",
      }),
    ).rejects.toBeInstanceOf(BackendUnavailable);
    expect(rejectedMediaId).toBeDefined();
    expect(storage.attachMediaInfo("sage", rejectedMediaId!, 10)).toBeUndefined();
    expect((await surface.chatHistory("sage")).messages).toEqual([]);
    plane.close();
    storage.close();
  });

  it("projects tools, approvals, and scheduled delivery", async () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const approvals: unknown[] = [];
    const pushes: unknown[] = [];
    const control = {} as BotsSurface;
    const ingress = { sendApprovalResolution: vi.fn(() => true) } as unknown as AttachV1Ingress;
    const plane = new NativeBotDataPlane({ control, storage, ingress, nativeBots: ["sage"], chatSuggestion: "", broadcast: (frame) => frames.push(frame), onApproval: (event) => approvals.push(event), onChatMessage: (event) => pushes.push(event), now: () => 500 });
    const chat = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn-command", { kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello" }, 2);

    plane.handle("sage", { kind: "event", sequence: 1, eventId: "tool", event: { kind: "tool", threadId: chat.sessionId, turnId: "turn", callId: "call", name: "search", status: "running" } });
    plane.handle("sage", { kind: "event", sequence: 2, eventId: "approval", event: { kind: "approval", threadId: chat.sessionId, turnId: "turn", approvalId: "approval-1", callId: "call", name: "search", status: "pending" } });
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device")).toBe("approved");
    expect(await plane.surface().resolveApproval("sage", "approval-1", "deny", "other-device")).toBe("not_pending");
    expect((ingress.sendApprovalResolution as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    const scheduled: AttachV1EventFrame = { kind: "event", sequence: 1, eventId: "scheduled", event: { kind: "scheduled", threadId: chat.sessionId, deliveryId: "cron-1", messageId: "scheduled-1", blocks: [{ type: "paragraph", text: "daily note" }] } };
    expect(storage.acceptAttachEvent("sage", scheduled, 3).status).toBe("accepted");
    plane.handle("sage", scheduled);
    expect(frames.some((frame) => frame.type === "bot_tool_activity")).toBe(true);
    expect(frames.some((frame) => frame.type === "bot_approval_pending")).toBe(true);
    expect(approvals).toEqual([
      expect.objectContaining({ toolCallId: "approval-1" }),
      expect.objectContaining({ toolCallId: "approval-1", outcome: "approved" }),
    ]);
    expect(storage.nativeBotMessages("sage", chat.sessionId).at(-1)?.text).toBe("daily note");
    expect(pushes).toEqual([expect.objectContaining({ bot: "sage", messageId: "scheduled-1", preview: "daily note" })]);

    storage.close();
  });

  it("recovers approvals and clarifications across restart with first-terminal-wins resolution", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "native-interactions-")), "gateway.sqlite");
    let storage = openStorage(path);
    const chat = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn", { kind: "turn", threadId: chat.sessionId, turnId: "turn-1", messageId: "user", text: "hello" }, 1);
    const control = { chatHistory: vi.fn(async () => ({ sessionId: "dashboard-sage", adoption: "pin", messages: [], running: false, inflight: false, updatedAt: 1 })) } as unknown as BotsSurface;
    const first = new NativeBotDataPlane({
      control,
      storage,
      ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: () => undefined,
      now: () => 1,
    });
    expect(first.handle("sage", { kind: "event", sequence: 1, eventId: "approval", event: { kind: "approval", threadId: chat.sessionId, turnId: "turn-1", approvalId: "approve-1", callId: "call", name: "search", status: "pending", expiresAt: 10 } })).toBe(true);
    expect(first.handle("sage", { kind: "event", sequence: 2, eventId: "clarify", event: { kind: "clarify", threadId: chat.sessionId, turnId: "turn-1", clarifyId: "clarify-1", prompt: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], status: "pending" } })).toBe(true);
    first.close();
    storage.close();

    storage = openStorage(path);
    const frames: ServerFrame[] = [];
    const ingress = { sendClarifyResolution: vi.fn(() => true), sendApprovalResolution: vi.fn(() => true) } as unknown as AttachV1Ingress;
    const recovered = new NativeBotDataPlane({ control, storage, ingress, nativeBots: ["sage"], chatSuggestion: "", broadcast: (frame) => frames.push(frame), now: () => 20 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(storage.nativeInteraction("sage", "approval", "approve-1")?.status).toBe("expired");
    expect(frames).toContainEqual(expect.objectContaining({ type: "bot_approval_resolved", toolCallId: "approve-1", outcome: "expired" }));

    await recovered.surface().chatHistory("sage");
    expect(frames).toContainEqual(expect.objectContaining({ type: "bot_clarify_pending", clarifyId: "clarify-1", prompt: "Which?" }));
    expect(await recovered.surface().resolveClarify("sage", "clarify-1", "b", "device-1")).toBe("selected");
    expect(await recovered.surface().resolveClarify("sage", "clarify-1", "a", "device-2")).toBe("not_pending");
    expect(ingress.sendClarifyResolution).toHaveBeenCalledTimes(1);
    expect(storage.nativeInteraction("sage", "clarify", "clarify-1")).toMatchObject({ status: "selected", selectedOptionId: "b" });
    expect(frames).toContainEqual(expect.objectContaining({ type: "bot_clarify_resolved", clarifyId: "clarify-1", outcome: "selected", selectedOptionId: "b" }));
    recovered.close();
    storage.close();
  });

  it("commits and pushes a scheduled delivery only once across projection replay and restart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "native-scheduled-")), "gateway.sqlite");
    let storage = openStorage(path);
    const chat = storage.nativeBotChat("sage", 1);
    const scheduled: AttachV1EventFrame = { kind: "event", sequence: 1, eventId: "scheduled-event", event: { kind: "scheduled", threadId: chat.sessionId, deliveryId: "daily:2026-08-21", messageId: "daily-message:2026-08-21", blocks: [{ type: "paragraph", text: "daily note" }] } };
    expect(storage.acceptAttachEvent("sage", scheduled, 1).status).toBe("accepted");
    const pushes: unknown[] = [];
    let plane = new NativeBotDataPlane({ control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress, nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, onChatMessage: (event) => pushes.push(event), now: () => 2 });
    expect(plane.handle("sage", scheduled)).toBe(true);
    expect(pushes).toHaveLength(1);
    plane.close();
    storage.close();

    storage = openStorage(path);
    plane = new NativeBotDataPlane({ control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress, nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, onChatMessage: (event) => pushes.push(event), now: () => 3 });
    expect(plane.handle("sage", scheduled)).toBe(true);
    expect(storage.nativeBotMessages("sage", chat.sessionId).filter((message) => message.id === "daily-message:2026-08-21")).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    plane.close();
    storage.close();
  });
});

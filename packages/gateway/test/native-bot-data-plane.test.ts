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
import { ATTACH_MEDIA_TTL_MS } from "../src/hermes-bridge/photos.ts";
import { openStorage } from "../src/storage.ts";

describe("attach-v1 native Bot Mode plane", () => {
  it("distinguishes a listed profile from an attached bot", () => {
    const storage = openStorage(":memory:");
    let attached = false;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: { isAttached: () => attached } as unknown as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: () => undefined,
      now: () => 42,
    });

    expect(plane.surface().readiness("sage")).toEqual({
      name: "sage", status: "starting", updatedAt: 42,
    });
    attached = true;
    plane.handleAttachPresence("sage", "online");
    expect(plane.surface().readiness("sage")).toEqual({
      name: "sage", status: "ready", updatedAt: 42,
    });
    plane.handleAttachPresence("sage", "degraded");
    expect(plane.surface().readiness("sage").status).toBe("starting");
    plane.close();
    storage.close();
  });

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
    const traces: string[] = [];
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
    const plane = new NativeBotDataPlane({ control, storage, ingress, nativeBots: ["Sage"], chatSuggestion: "Say hello", broadcast: (frame) => frames.push(frame), now: () => now++, trace: (line) => traces.push(line) });
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
    expect(traces.map((line) => JSON.parse(line))).toMatchObject([
      { event: "native_turn_transition", status: "queued" },
      { event: "native_turn_transition", status: "completed" },
    ]);
    expect(traces.join("\n")).not.toContain("hello");
    expect(traces.join("\n")).not.toContain("answer-1");
    expect([...new Set(traces.map((line) => JSON.parse(line).turn))]).toHaveLength(1);
    expect(String(JSON.parse(traces[0] ?? "{}").turn)).toMatch(/^[0-9a-f]{16}$/);
    storage.close();
  });

  it("binds a mobile request to the authenticated POST device, never the agent frame", async () => {
    const storage = openStorage(":memory:");
    let turn: Record<string, unknown> | undefined;
    const invoked = vi.fn();
    const rejected = vi.fn();
    const cancelled = vi.fn();
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {
        sendNativeTurn: (_bot: string, input: Record<string, unknown>) => { turn = input; return true; },
        sendNativeInterrupt: () => true,
      } as unknown as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, now: () => 10,
      mobileNode: { invoke: invoked, reject: rejected, cancelTurn: cancelled } as never,
    });
    const accepted = await plane.surface().sendChatMessage("sage", "status", { deviceId: "origin-device" });
    const turnId = String(turn?.turnId);

    plane.mobileRequest("sage", { kind: "mobile_request", requestId: "request-1", command: "device.status", threadId: accepted.sessionId, turnId, expiresAt: 1_000, purpose: "Report phone readiness" });
    plane.mobileRequest("sage", { kind: "mobile_request", requestId: "location-1", command: "location.current", threadId: accepted.sessionId, turnId, expiresAt: 1_000, purpose: "Find coffee" });
    plane.mobileRequest("sage", { kind: "mobile_request", requestId: "request-2", command: "device.status", threadId: accepted.sessionId, turnId: "agent-selected", expiresAt: 1_000, purpose: "Report phone readiness" });

    expect(invoked).toHaveBeenCalledWith(expect.objectContaining({ agentId: "sage", deviceId: "origin-device", turnId }));
    expect(invoked).toHaveBeenCalledWith(expect.objectContaining({ requestId: "location-1", command: "location.current", purpose: "Find coffee", deviceId: "origin-device", turnId }));
    expect(rejected).toHaveBeenCalledWith("sage", "request-2");
    await plane.surface().stopChat("sage");
    expect(cancelled).toHaveBeenCalledWith("sage", turnId);
    plane.close();
    storage.close();
  });

  it("preserves list items when a native bot reply is committed", async () => {
    const storage = openStorage(":memory:");
    let turnId = "";
    const ingress = {
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        turnId = String(input.turnId);
        storage.enqueueAttachCommand(bot, "turn-command", { kind: "turn", ...input } as never, 1);
        return true;
      },
    } as unknown as AttachV1Ingress;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress,
      nativeBots: ["cleo"],
      chatSuggestion: "",
      broadcast: () => undefined,
      now: () => 1,
    });
    const surface = plane.surface();
    const accepted = await surface.sendChatMessage("cleo", "What could be better?", {
      clientId: "question",
    });

    expect(
      plane.handle("cleo", {
        kind: "event",
        sequence: 1,
        eventId: "commit",
        event: {
          kind: "commit",
          threadId: accepted.sessionId,
          turnId,
          messageId: "answer",
          blocks: [
            { type: "heading", level: 2, text: "Biggest improvements" },
            { type: "list", items: [{ text: "Reliable approvals" }, { text: "Better context" }] },
            { type: "paragraph", text: "The core loop is already clean." },
          ],
        },
      }),
    ).toBe(true);

    expect((await surface.chatHistory("cleo")).messages.at(-1)?.text).toBe(
      "## Biggest improvements\n\n- Reliable approvals\n- Better context\n\nThe core loop is already clean.",
    );
    plane.close();
    storage.close();
  });

  it("bounds gateway-owned native attachments and photos to the attachment retention window", async () => {
    const storage = openStorage(":memory:");
    const turns: Array<{ mediaIds?: string[] }> = [];
    const now = 10;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage,
      ingress: { sendNativeTurn: (bot: string, turn: { mediaIds?: string[] }) => {
        turns.push(turn);
        return true;
      } } as unknown as AttachV1Ingress,
      nativeBots: ["sage", "cleo"], chatSuggestion: "", broadcast: () => undefined, now: () => now,
    });
    const attachmentSent = await plane.surface().sendChatAttachment("sage", {
      bytes: new TextEncoder().encode('{"ok":true}'), mime: "application/json", name: "report.json", text: "Read this.",
    });
    const photoSent = await plane.surface().sendChatPhoto("cleo", {
      bytes: new Uint8Array([137, 80, 78, 71]), mime: "image/png", ext: "png", text: "Look at this.",
    });
    const attachment = attachmentSent.message.attachments?.[0]!;
    const photo = photoSent.message.attachments?.[0]!;
    expect(attachment).toMatchObject({ name: "report.json", mimeType: "application/json", mediaKind: "file" });
    expect(photo).toMatchObject({ name: "image.png", mimeType: "image/png", mediaKind: "image" });
    expect(turns.map((turn) => turn.mediaIds)).toEqual([[attachment.fileId], [photo.fileId]]);
    for (const [bot, media] of [["sage", attachment], ["cleo", photo]] as const) {
      const stored = storage.attachMediaInfo(bot, media.fileId, now);
      expect(stored?.descriptor).toMatchObject({ expiresAt: now + ATTACH_MEDIA_TTL_MS });
      expect(storage.attachMediaSlice(bot, media.fileId, 0, 1, now + ATTACH_MEDIA_TTL_MS - 1)).toBeDefined();
      expect(storage.attachMediaInfo(bot, media.fileId, now + ATTACH_MEDIA_TTL_MS)).toBeUndefined();
      expect(storage.attachMediaSlice(bot, media.fileId, 0, 1, now + ATTACH_MEDIA_TTL_MS)).toBeUndefined();
    }
    plane.close();
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

  it("returns durable tool history and seals a running tool when a turn commits", async () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const ingress = {
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        storage.enqueueAttachCommand(
          bot,
          `turn:${String(input.turnId)}`,
          { kind: "turn", ...input } as never,
          1,
        );
        return true;
      },
    } as unknown as AttachV1Ingress;
    let now = 100;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: (frame) => frames.push(frame),
      now: () => now++,
    });
    const sent = await plane.surface().sendChatMessage("sage", "search");
    const turnId = storage.nativeBotChat("sage", now).activeTurnId!;

    expect(plane.handle("sage", {
      kind: "event", sequence: 1, eventId: "tool-running", event: {
        kind: "tool", threadId: sent.sessionId, turnId, callId: "search-1", name: "search", status: "running",
      },
    })).toBe(true);
    expect(plane.handle("sage", {
      kind: "event", sequence: 2, eventId: "tool-ok", event: {
        kind: "tool", threadId: sent.sessionId, turnId, callId: "search-1", name: "search", status: "ok",
      },
    })).toBe(true);
    expect(plane.handle("sage", {
      kind: "event", sequence: 3, eventId: "tool-still-running", event: {
        kind: "tool", threadId: sent.sessionId, turnId, callId: "render-1", name: "render", status: "running",
      },
    })).toBe(true);
    expect(plane.handle("sage", {
      kind: "event", sequence: 4, eventId: "commit", event: {
        kind: "commit", threadId: sent.sessionId, turnId, messageId: "answer", blocks: [{ type: "paragraph", text: "done" }],
      },
    })).toBe(true);

    expect(await plane.surface().chatHistory("sage")).toMatchObject({
      running: false,
      toolSteps: [{ turnId, steps: [{ stepId: "search-1", status: "ok" }, { stepId: "render-1", status: "ok" }] }],
    });
    expect(frames.filter((frame) => frame.type === "bot_tool_activity").at(-1)).toMatchObject({
      turnId, done: true, steps: [{ stepId: "search-1", status: "ok" }, { stepId: "render-1", status: "ok" }],
    });
    expect(frames.filter((frame) => frame.type === "bot_chat_state").at(-1)).toMatchObject({
      phase: "complete", status: "completed", running: false, inflight: false,
    });
    plane.close();
    storage.close();
  });

  it("treats an identical tool lifecycle replay as a projected no-op", () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: (frame) => frames.push(frame),
      now: () => 100,
    });
    const chat = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn", {
      kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello",
    } as never, 1);
    storage.setNativeBotTurn("sage", chat.sessionId, "turn", 1);
    const event = {
      kind: "tool" as const, threadId: chat.sessionId, turnId: "turn",
      callId: "call", name: "search", status: "running" as const, detail: "query",
    };

    expect(plane.handle("sage", { kind: "event", sequence: 1, eventId: "first", event })).toBe(true);
    expect(plane.handle("sage", { kind: "event", sequence: 2, eventId: "repeat", event })).toBe(true);

    expect(frames.filter((frame) => frame.type === "bot_tool_activity")).toHaveLength(1);
    expect(storage.botChatToolSteps(chat.sessionId, 0)).toHaveLength(1);
    plane.close();
    storage.close();
  });

  it("coalesces a burst of tool activity into the latest durable snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    try {
      const storage = openStorage(":memory:");
      const frames: ServerFrame[] = [];
      const plane = new NativeBotDataPlane({
        control: {} as BotsSurface,
        storage,
        ingress: {} as AttachV1Ingress,
        nativeBots: ["sage"],
        chatSuggestion: "",
        broadcast: (frame) => frames.push(frame),
      });
      const chat = storage.nativeBotChat("sage", 1);
      storage.enqueueAttachCommand("sage", "turn", {
        kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello",
      } as never, 1);
      storage.setNativeBotTurn("sage", chat.sessionId, "turn", 1);

      expect(plane.handle("sage", { kind: "event", sequence: 1, eventId: "search-running", event: {
        kind: "tool", threadId: chat.sessionId, turnId: "turn",
        callId: "search", name: "search", status: "running",
      } })).toBe(true);
      expect(plane.handle("sage", { kind: "event", sequence: 2, eventId: "search-ok", event: {
        kind: "tool", threadId: chat.sessionId, turnId: "turn",
        callId: "search", name: "search", status: "ok",
      } })).toBe(true);
      expect(plane.handle("sage", { kind: "event", sequence: 3, eventId: "render-running", event: {
        kind: "tool", threadId: chat.sessionId, turnId: "turn",
        callId: "render", name: "render", status: "running",
      } })).toBe(true);

      expect(frames.filter((frame) => frame.type === "bot_tool_activity")).toHaveLength(1);
      expect(await plane.surface().chatHistory("sage")).toMatchObject({
        toolSteps: [{ turnId: "turn", steps: [
          { stepId: "search", status: "ok" },
          { stepId: "render", status: "running" },
        ] }],
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(frames.filter((frame) => frame.type === "bot_tool_activity")).toHaveLength(2);
      expect(frames.filter((frame) => frame.type === "bot_tool_activity").at(-1)).toMatchObject({
        seq: 3,
        steps: [
          { stepId: "search", status: "ok" },
          { stepId: "render", status: "running" },
        ],
      });
      expect(plane.handle("sage", { kind: "event", sequence: 4, eventId: "render-ok", event: {
        kind: "tool", threadId: chat.sessionId, turnId: "turn",
        callId: "render", name: "render", status: "ok",
      } })).toBe(true);
      expect(frames.filter((frame) => frame.type === "bot_tool_activity")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(frames.filter((frame) => frame.type === "bot_tool_activity").at(-1)).toMatchObject({
        seq: 4,
        steps: [{ status: "ok" }, { status: "ok" }],
      });
      plane.close();
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the latest live activity before terminal frames and leaves no stale timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    try {
      const storage = openStorage(":memory:");
      const frames: ServerFrame[] = [];
      const plane = new NativeBotDataPlane({
        control: {} as BotsSurface,
        storage,
        ingress: {} as AttachV1Ingress,
        nativeBots: ["sage"], chatSuggestion: "",
        broadcast: (frame) => frames.push(frame),
      });
      const chat = storage.nativeBotChat("sage", 1);
      storage.enqueueAttachCommand("sage", "turn", {
        kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello",
      } as never, 1);
      storage.setNativeBotTurn("sage", chat.sessionId, "turn", 1);

      expect(plane.handle("sage", { kind: "event", sequence: 1, eventId: "draft-1", event: {
        kind: "draft", threadId: chat.sessionId, turnId: "turn",
        blocks: [{ type: "paragraph", text: "working" }],
      } })).toBe(true);
      expect(plane.handle("sage", { kind: "event", sequence: 2, eventId: "tool", event: {
        kind: "tool", threadId: chat.sessionId, turnId: "turn",
        callId: "search", name: "search", status: "running",
      } })).toBe(true);
      expect(plane.handle("sage", { kind: "event", sequence: 3, eventId: "draft-2", event: {
        kind: "draft", threadId: chat.sessionId, turnId: "turn",
        blocks: [{ type: "paragraph", text: "almost done" }],
      } })).toBe(true);
      expect(plane.handle("sage", { kind: "event", sequence: 4, eventId: "commit", event: {
        kind: "commit", threadId: chat.sessionId, turnId: "turn", messageId: "answer",
        blocks: [{ type: "paragraph", text: "done" }],
      } })).toBe(true);

      const latestDraft = frames.findIndex(
        (frame) => frame.type === "bot_chat_delta" && frame.text === "almost done",
      );
      const liveTool = frames.findIndex(
        (frame) => frame.type === "bot_tool_activity" && frame.done !== true,
      );
      const doneTool = frames.findIndex(
        (frame) => frame.type === "bot_tool_activity" && frame.done === true,
      );
      const doneDraft = frames.findIndex(
        (frame) => frame.type === "bot_chat_delta" && frame.done === true,
      );
      const terminalState = frames.findIndex(
        (frame) => frame.type === "bot_chat_state" && frame.status === "completed",
      );
      const answer = frames.findIndex(
        (frame) => frame.type === "bot_chat" && frame.messages.some((message) => message.id === "answer"),
      );
      expect(latestDraft).toBeGreaterThanOrEqual(0);
      expect(liveTool).toBeGreaterThan(latestDraft);
      expect(doneTool).toBeGreaterThan(liveTool);
      expect(doneDraft).toBeGreaterThan(doneTool);
      expect(terminalState).toBeGreaterThan(doneDraft);
      expect(answer).toBeGreaterThan(terminalState);
      expect(vi.getTimerCount()).toBe(0);
      const count = frames.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(frames).toHaveLength(count);
      plane.close();
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "seals running tools as errors when attach reports %s",
    async (kind) => {
      const storage = openStorage(":memory:");
      const frames: ServerFrame[] = [];
      const plane = new NativeBotDataPlane({
        control: {} as BotsSurface,
        storage,
        ingress: {} as AttachV1Ingress,
        nativeBots: ["sage"],
        chatSuggestion: "",
        broadcast: (frame) => frames.push(frame),
        now: () => 100,
      });
      const chat = storage.nativeBotChat("sage", 1);
      storage.enqueueAttachCommand("sage", "turn", {
        kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello",
      } as never, 1);
      storage.setNativeBotTurn("sage", chat.sessionId, "turn", 1);
      expect(plane.handle("sage", {
        kind: "event", sequence: 1, eventId: "tool", event: {
          kind: "tool", threadId: chat.sessionId, turnId: "turn", callId: "call", name: "search", status: "running",
        },
      })).toBe(true);
      expect(plane.handle("sage", {
        kind: "event", sequence: 2, eventId: kind, event: {
          kind, threadId: chat.sessionId, turnId: "turn", messageId: `${kind}-message`,
        },
      })).toBe(true);

      expect(await plane.surface().chatHistory("sage")).toMatchObject({
        running: false,
        toolSteps: [{ turnId: "turn", steps: [{ stepId: "call", status: "error" }] }],
      });
      expect(frames.filter((frame) => frame.type === "bot_tool_activity").at(-1)).toMatchObject({
        done: true, steps: [{ status: "error" }],
      });
      expect(frames.filter((frame) => frame.type === "bot_chat_state").at(-1)).toMatchObject({
        phase: "failed", status: kind === "failed" ? "failed" : "interrupted",
        ...(kind === "cancelled" ? { cause: "cancelled" } : {}),
        running: false, inflight: false,
      });
      plane.close();
      storage.close();
    },
  );

  it("reconstructs an active turn and its running tool after a gateway restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "native-tools-restart-")), "gateway.sqlite");
    let storage = openStorage(path);
    const chat = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn", {
      kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello",
    } as never, 1);
    storage.setNativeBotTurn("sage", chat.sessionId, "turn", 1);
    storage.upsertBotChatToolStep({
      bot: "sage", sessionId: chat.sessionId, turnId: "turn", stepId: "call", seq: 1,
      name: "search", status: "running", startedAt: 1, endedAt: undefined,
    });
    storage.close();

    storage = openStorage(path);
    const frames: ServerFrame[] = [];
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: (frame) => frames.push(frame),
      now: () => 100,
    });
    expect(await plane.surface().chatHistory("sage")).toMatchObject({
      running: true,
      toolSteps: [{ turnId: "turn", steps: [{ stepId: "call", status: "running" }] }],
    });
    const interrupted: AttachV1EventFrame = {
      kind: "event", sequence: 1, eventId: "interrupted", event: {
        kind: "interrupted", threadId: chat.sessionId, turnId: "turn", messageId: "interrupted-message",
      },
    };
    expect(storage.acceptAttachEvent("sage", interrupted, 100).status).toBe("accepted");
    expect(plane.handle("sage", interrupted)).toBe(true);
    expect(await plane.surface().chatHistory("sage")).toMatchObject({
      running: false,
      toolSteps: [{ turnId: "turn", steps: [{ stepId: "call", status: "error" }] }],
    });
    expect(plane.handle("sage", {
      kind: "event", sequence: 2, eventId: "interrupted-duplicate", event: {
        kind: "interrupted", threadId: chat.sessionId, turnId: "turn", messageId: "interrupted-message",
      },
    })).toBe(true);
    expect(frames.filter((frame) => frame.type === "bot_tool_activity")).toHaveLength(1);
    plane.close();
    storage.close();

    storage = openStorage(path);
    const restarted = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: () => undefined,
      now: () => 101,
    });
    expect(await restarted.surface().chatHistory("sage")).toMatchObject({
      running: false,
      status: "interrupted",
      toolSteps: [{ turnId: "turn", steps: [{ stepId: "call", status: "error" }] }],
    });
    restarted.close();
    storage.close();
  });

  it("does not report a stopped native turn when its interrupt cannot be queued", async () => {
    const storage = openStorage(":memory:");
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: { sendNativeInterrupt: () => false } as unknown as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: () => undefined,
      now: () => 1,
    });
    const chat = storage.nativeBotChat("sage", 1);
    storage.setNativeBotTurn("sage", chat.sessionId, "turn", 1);

    await expect(plane.surface().stopChat("sage")).rejects.toBeInstanceOf(BackendUnavailable);
    expect(await plane.surface().chatHistory("sage")).toMatchObject({ running: true });
    plane.close();
    storage.close();
  });

  it("projects queued, execution, tool, input, connectivity-loss, and interrupted status", async () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    let attached = false;
    let command: { sequence: number; commandId: string } | undefined;
    const ingress = {
      isAttached: () => attached,
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        const queued = storage.enqueueAttachCommand(
          bot,
          `turn:${String(input.turnId)}`,
          { kind: "turn", ...input } as never,
          10,
        );
        command = { sequence: queued.sequence, commandId: queued.commandId };
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
      now: () => 10,
    });
    const sent = await plane.surface().sendChatMessage("sage", "hello");
    const turnId = storage.nativeBotChat("sage", 10).activeTurnId!;
    expect(frames.filter((frame) => frame.type === "bot_chat_state").at(-1)).toMatchObject({
      status: "queued", cause: "attach_absent", queuedAt: 10,
    });

    attached = true;
    storage.ackAttachCommand("sage", command!.sequence, command!.commandId, 11);
    plane.handleAttachPresence("sage", "online");
    expect(frames.filter((frame) => frame.type === "bot_chat_state").at(-1)).toMatchObject({ status: "executing" });

    expect(plane.handle("sage", {
      kind: "event", sequence: 1, eventId: "tool", event: {
        kind: "tool", threadId: sent.sessionId, turnId, callId: "call", name: "search", status: "running",
      },
    })).toBe(true);
    expect(frames.filter((frame) => frame.type === "bot_chat_state").at(-1)).toMatchObject({ status: "using_tools" });

    expect(plane.handle("sage", {
      kind: "event", sequence: 2, eventId: "approval", event: {
        kind: "approval", threadId: sent.sessionId, turnId, approvalId: "approval", callId: "call", name: "search", status: "pending",
      },
    })).toBe(true);
    expect(frames.filter((frame) => frame.type === "bot_chat_state").at(-1)).toMatchObject({ status: "awaiting_input" });

    attached = false;
    plane.handleAttachPresence("sage", "degraded");
    expect(frames.filter((frame) => frame.type === "bot_chat_state").at(-1)).toMatchObject({
      status: "awaiting_input", cause: "attach_degraded",
    });
    plane.handleAttachPresence("sage", "absent");
    expect(frames.filter((frame) => frame.type === "bot_chat_state").at(-1)).toMatchObject({
      status: "awaiting_input", cause: "attach_lost",
    });

    expect(plane.handle("sage", {
      kind: "event", sequence: 3, eventId: "interrupted", event: {
        kind: "interrupted", threadId: sent.sessionId, turnId, messageId: "interrupted",
      },
    })).toBe(true);
    expect(frames.filter((frame) => frame.type === "bot_chat_state").at(-1)).toMatchObject({
      phase: "failed", status: "interrupted", running: false,
    });
    plane.close();
    storage.close();
  });

  it("times out a durable queued turn at the existing gateway bound", async () => {
    vi.useFakeTimers();
    try {
      const storage = openStorage(":memory:");
      let now = 0;
      const plane = new NativeBotDataPlane({
        control: {} as BotsSurface,
        storage,
        ingress: {
          sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
            storage.enqueueAttachCommand(bot, "turn", { kind: "turn", ...input } as never, now);
            return true;
          },
        } as unknown as AttachV1Ingress,
        nativeBots: ["sage"],
        chatSuggestion: "",
        broadcast: () => undefined,
        now: () => now,
        turnTimeoutMs: 50,
      });
      const sent = await plane.surface().sendChatMessage("sage", "offline");
      const turnId = storage.nativeBotChat("sage", now).activeTurnId!;
      now = 50;
      await vi.advanceTimersByTimeAsync(50);

      expect(storage.pendingAttachCommands("sage", 0, 1)[0]?.command).toMatchObject({ kind: "discard" });
      expect(plane.handle("sage", {
        kind: "event", sequence: 1, eventId: "late-commit", event: {
          kind: "commit", threadId: sent.sessionId, turnId, messageId: "late", blocks: [{ type: "paragraph", text: "late" }],
        },
      })).toBe(true);
      expect(await plane.surface().chatHistory("sage")).toMatchObject({
        sessionId: sent.sessionId, running: false, status: "timed_out", messages: [{ text: "offline" }],
      });
      plane.close();
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not impose a wall-clock timeout when none is configured", async () => {
    vi.useFakeTimers();
    try {
      const storage = openStorage(":memory:");
      const interrupt = vi.fn(() => true);
      let command: { sequence: number; commandId: string } | undefined;
      const plane = new NativeBotDataPlane({
        control: {} as BotsSurface,
        storage,
        ingress: {
          isAttached: () => true,
          sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
            const queued = storage.enqueueAttachCommand(
              bot,
              "turn",
              { kind: "turn", ...input } as never,
              Date.now(),
            );
            command = { sequence: queued.sequence, commandId: queued.commandId };
            return true;
          },
          sendNativeInterrupt: interrupt,
        } as unknown as AttachV1Ingress,
        nativeBots: ["cleo"],
        chatSuggestion: "",
        broadcast: () => undefined,
      });
      const sent = await plane.surface().sendChatMessage("cleo", "keep working");
      storage.ackAttachCommand("cleo", command!.sequence, command!.commandId, Date.now());

      await vi.advanceTimersByTimeAsync(600_000);

      expect(interrupt).not.toHaveBeenCalled();
      expect(await plane.surface().chatHistory("cleo")).toMatchObject({
        sessionId: sent.sessionId,
        running: true,
      });
      plane.close();
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects an acknowledged turn's final answer even when it arrives after the gateway timeout", async () => {
    vi.useFakeTimers();
    try {
      const storage = openStorage(":memory:");
      let now = 0;
      let command: { sequence: number; commandId: string } | undefined;
      const interrupt = vi.fn(() => true);
      const frames: ServerFrame[] = [];
      const plane = new NativeBotDataPlane({
        control: {} as BotsSurface,
        storage,
        ingress: {
          isAttached: () => true,
          sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
            const queued = storage.enqueueAttachCommand(bot, "turn", { kind: "turn", ...input } as never, now);
            command = { sequence: queued.sequence, commandId: queued.commandId };
            return true;
          },
          sendNativeInterrupt: interrupt,
        } as unknown as AttachV1Ingress,
        nativeBots: ["sage"],
        chatSuggestion: "",
        broadcast: (frame) => frames.push(frame),
        now: () => now,
        turnTimeoutMs: 50,
      });
      const sent = await plane.surface().sendChatMessage("sage", "running");
      const turnId = storage.nativeBotChat("sage", now).activeTurnId!;
      storage.ackAttachCommand("sage", command!.sequence, command!.commandId, 1);
      now = 50;
      await vi.advanceTimersByTimeAsync(50);

      expect(interrupt).toHaveBeenCalledOnce();
      expect(await plane.surface().chatHistory("sage")).toMatchObject({ running: false, status: "timed_out" });
      expect(storage.nativeBotLastTerminal("sage", sent.sessionId)?.status).toBe("timed_out");

      expect(plane.handle("sage", {
        kind: "event", sequence: 1, eventId: "eventual-final", event: {
          kind: "commit", threadId: sent.sessionId, turnId,
          messageId: "eventual-final", blocks: [{ type: "paragraph", text: "The real answer." }],
        },
      })).toBe(true);
      expect(await plane.surface().chatHistory("sage")).toMatchObject({
        running: false,
        status: "completed",
        messages: [{ text: "running" }, { id: "eventual-final", text: "The real answer." }],
      });
      expect(plane.handle("sage", {
        kind: "event", sequence: 2, eventId: "eventual-final-retry", event: {
          kind: "commit", threadId: sent.sessionId, turnId,
          messageId: "eventual-final", blocks: [{ type: "paragraph", text: "The real answer." }],
        },
      })).toBe(true);
      expect((await plane.surface().chatHistory("sage")).messages.filter(
        (message) => message.id === "eventual-final",
      )).toHaveLength(1);
      expect(frames.filter(
        (frame) => frame.type === "bot_chat" && frame.messages.some(
          (message) => message.id === "eventual-final",
        ),
      )).toHaveLength(1);
      plane.close();
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not revive a user-cancelled turn when a late final arrives", async () => {
    const storage = openStorage(":memory:");
    let command: { sequence: number; commandId: string } | undefined;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {
        sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
          const queued = storage.enqueueAttachCommand(bot, "turn", { kind: "turn", ...input } as never, 1);
          command = { sequence: queued.sequence, commandId: queued.commandId };
          return true;
        },
      } as unknown as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, now: () => 2,
    });
    const sent = await plane.surface().sendChatMessage("sage", "cancel this");
    const turnId = storage.nativeBotChat("sage", 2).activeTurnId!;
    storage.ackAttachCommand("sage", command!.sequence, command!.commandId, 2);
    storage.recordNativeBotTerminal({
      bot: "sage", sessionId: sent.sessionId, turnId,
      status: "interrupted", cause: "cancelled", completedAt: 2,
    });

    expect(plane.handle("sage", {
      kind: "event", sequence: 1, eventId: "late-after-cancel", event: {
        kind: "commit", threadId: sent.sessionId, turnId,
        messageId: "late-after-cancel", blocks: [{ type: "paragraph", text: "Too late." }],
      },
    })).toBe(true);
    expect((await plane.surface().chatHistory("sage")).messages).toEqual([
      expect.objectContaining({ role: "user", text: "cancel this" }),
    ]);
    expect(storage.nativeBotLastTerminal("sage", sent.sessionId)).toEqual({
      status: "interrupted", cause: "cancelled",
    });
    plane.close();
    storage.close();
  });

  it("recovers the remaining durable queue deadline after a gateway restart", async () => {
    vi.useFakeTimers();
    try {
      const path = join(mkdtempSync(join(tmpdir(), "native-timeout-restart-")), "gateway.sqlite");
      let now = 0;
      let storage = openStorage(path);
      let plane = new NativeBotDataPlane({
        control: {} as BotsSurface,
        storage,
        ingress: {
          sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
            storage.enqueueAttachCommand(bot, "turn", { kind: "turn", ...input } as never, now);
            return true;
          },
        } as unknown as AttachV1Ingress,
        nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined,
        now: () => now, turnTimeoutMs: 50,
      });
      await plane.surface().sendChatMessage("sage", "restart");
      plane.close();
      storage.close();

      now = 40;
      storage = openStorage(path);
      plane = new NativeBotDataPlane({
        control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress,
        nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined,
        now: () => now, turnTimeoutMs: 50,
      });
      now = 50;
      await vi.advanceTimersByTimeAsync(10);
      expect(await plane.surface().chatHistory("sage")).toMatchObject({ running: false, status: "timed_out" });
      plane.close();
      storage.close();
    } finally {
      vi.useRealTimers();
    }
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

    await expect(
      surface.sendChatAttachment("sage", {
        bytes: new TextEncoder().encode("%PDF-1.7\n"),
        mime: "application/pdf",
        name: "report.pdf",
        text: "not queued",
      }),
    ).rejects.toBeInstanceOf(BackendUnavailable);
    expect(rejectedMediaId).toBeDefined();
    expect(storage.attachMediaInfo("sage", rejectedMediaId!, 10)).toBeUndefined();
    expect((await surface.chatHistory("sage")).messages).toEqual([]);
    plane.close();
    storage.close();
  });

  it("keeps approval requested until Hermes confirms it", async () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const approvals: unknown[] = [];
    const control = {} as BotsSurface;
    const ingress = {
      requestNativeApprovalResolution: vi.fn((bot: string, input: { threadId: string; turnId: string; approvalId: string; decision: "approve" | "deny" }) => storage.requestNativeInteractionResolution({
        bot,
        kind: "approval",
        interactionId: input.approvalId,
        decision: input.decision,
        commandId: `approval:${bot}:${input.approvalId}`,
        command: { kind: "resolve_approval", ...input },
        requestedAt: 500,
      })),
    } as unknown as AttachV1Ingress;
    const plane = new NativeBotDataPlane({ control, storage, ingress, nativeBots: ["sage"], chatSuggestion: "", broadcast: (frame) => frames.push(frame), onApproval: (event) => approvals.push(event), now: () => 500 });
    const chat = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn-command", { kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello" }, 2);

    plane.handle("sage", { kind: "event", sequence: 1, eventId: "tool", event: { kind: "tool", threadId: chat.sessionId, turnId: "turn", callId: "call", name: "search", status: "running" } });
    plane.handle("sage", { kind: "event", sequence: 2, eventId: "approval", event: { kind: "approval", threadId: chat.sessionId, turnId: "turn", approvalId: "approval-1", callId: "call", name: "search", status: "pending" } });
    expect(plane.surface().pendingApprovals()).toEqual([{
      bot: "sage", sessionId: chat.sessionId, turnId: "turn", toolCallId: "approval-1",
      ruleName: "search", createdAt: 500,
    }]);
    expect(await plane.surface().resolveApproval("sage", "approval-1", "approve", "device")).toBe("requested");
    expect(plane.surface().pendingApprovals()).toEqual([expect.objectContaining({ toolCallId: "approval-1", resolutionRequestedAt: 500 })]);
    expect(frames).toContainEqual(expect.objectContaining({ type: "bot_approval_resolution_requested", toolCallId: "approval-1" }));
    expect(frames).not.toContainEqual(expect.objectContaining({ type: "bot_approval_resolved", toolCallId: "approval-1" }));
    expect(approvals).toHaveLength(1);
    expect(await plane.surface().resolveApproval("sage", "approval-1", "deny", "other-device")).toBe("resolution_pending");
    expect((ingress.requestNativeApprovalResolution as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);

    expect(plane.handle("sage", { kind: "event", sequence: 3, eventId: "approval-approved", event: { kind: "approval", threadId: chat.sessionId, turnId: "turn", approvalId: "approval-1", callId: "call", name: "search", status: "approved" } })).toBe(true);
    expect(plane.surface().pendingApprovals()).toEqual([]);
    expect(approvals).toEqual([
      expect.objectContaining({ toolCallId: "approval-1" }),
      expect.objectContaining({ toolCallId: "approval-1", outcome: "approved" }),
    ]);

    plane.close();
    storage.close();
  });

  it("rejects terminal interactions that do not match their durable session and turn binding", () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: (frame) => frames.push(frame),
      now: () => 10,
    });
    const first = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn-first", {
      kind: "turn", threadId: first.sessionId, turnId: "turn-first", messageId: "user-first", text: "first",
    }, 1);
    expect(plane.handle("sage", {
      kind: "event", sequence: 1, eventId: "approval-pending",
      event: {
        kind: "approval", threadId: first.sessionId, turnId: "turn-first",
        approvalId: "approval-1", callId: "call-first", name: "workspace.write", status: "pending",
      },
    })).toBe(true);
    const secondSessionId = storage.resetNativeBotChat("sage", 2);
    storage.enqueueAttachCommand("sage", "turn-second", {
      kind: "turn", threadId: secondSessionId, turnId: "turn-second", messageId: "user-second", text: "second",
    }, 2);

    expect(plane.handle("sage", {
      kind: "event", sequence: 3, eventId: "approval-wrong-binding",
      event: {
        kind: "approval", threadId: secondSessionId, turnId: "turn-second",
        approvalId: "approval-1", callId: "call-second", name: "workspace.write", status: "approved",
      },
    // Acknowledged (true) rather than declined: the frame is PERMANENTLY mis-bound, and a
    // decline would dead-letter it and block every later event for the agent (issue #193).
    // Rejection now means "no durable state changes, no resolved frame", asserted below.
    })).toBe(true);
    expect(storage.nativeInteraction("sage", "approval", "approval-1")).toMatchObject({
      sessionId: first.sessionId, turnId: "turn-first", status: "pending",
    });

    expect(frames).not.toContainEqual(expect.objectContaining({ type: "bot_approval_resolved", toolCallId: "approval-1" }));
    plane.close();
    storage.close();
  });

  it("rejects a terminal clarification option that was not in the durable prompt", () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: (frame) => frames.push(frame),
      now: () => 10,
    });
    const chat = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn", {
      kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "choose",
    }, 1);
    expect(plane.handle("sage", {
      kind: "event", sequence: 1, eventId: "clarify-pending",
      event: {
        kind: "clarify", threadId: chat.sessionId, turnId: "turn",
        clarifyId: "clarify-1", prompt: "Choose", options: [{ id: "a", label: "A" }], status: "pending",
      },
    })).toBe(true);

    expect(plane.handle("sage", {
      kind: "event", sequence: 2, eventId: "clarify-invalid-option",
      event: {
        kind: "clarify", threadId: chat.sessionId, turnId: "turn",
        clarifyId: "clarify-1", prompt: "Choose", options: [{ id: "a", label: "A" }],
        status: "resolved", selectedOptionId: "not-an-offered-option",
      },
    // Acknowledged (true) rather than declined: the durable option list can never grow this id,
    // so a decline could only dead-letter the agent's inbox (issue #193). Rejection now means
    // "no durable state changes, no resolved frame", asserted below.
    })).toBe(true);
    expect(storage.nativeInteraction("sage", "clarify", "clarify-1")).toMatchObject({
      status: "pending", selectedOptionId: null,
    });
    expect(frames).not.toContainEqual(expect.objectContaining({ type: "bot_clarify_resolved", clarifyId: "clarify-1" }));
    plane.close();
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
    const ingress = {
      requestNativeApprovalResolution: vi.fn((bot: string, input: { threadId: string; turnId: string; approvalId: string; decision: "approve" | "deny" }) =>
        storage.requestNativeInteractionResolution({
          bot, kind: "approval", interactionId: input.approvalId, decision: input.decision,
          commandId: `approval:${bot}:${input.approvalId}`,
          command: { kind: "resolve_approval", ...input }, requestedAt: 20,
        })),
      requestNativeClarifyResolution: vi.fn((bot: string, input: { threadId: string; turnId: string; clarifyId: string; optionId: string }) =>
        storage.requestNativeInteractionResolution({
          bot, kind: "clarify", interactionId: input.clarifyId, decision: "select", optionId: input.optionId,
          commandId: `clarify:${bot}:${input.clarifyId}`,
          command: { kind: "resolve_clarify", ...input }, requestedAt: 20,
        })),
    } as unknown as AttachV1Ingress;
    const recovered = new NativeBotDataPlane({ control, storage, ingress, nativeBots: ["sage"], chatSuggestion: "", broadcast: (frame) => frames.push(frame), now: () => 20 });
    // No sleep: a user can tap the approval push in the first event-loop turn after restart.
    // Resolution itself must synchronously recognize the already-past durable deadline.
    expect(await recovered.surface().resolveApproval("sage", "approve-1", "approve", "device-1")).toBe("expired");
    expect(storage.nativeInteraction("sage", "approval", "approve-1")?.status).toBe("expired");
    expect(recovered.surface().pendingApprovals()).toEqual([]);
    expect(frames).toContainEqual(expect.objectContaining({ type: "bot_approval_resolved", toolCallId: "approve-1", outcome: "expired" }));

    await recovered.surface().chatHistory("sage");
    expect(frames).toContainEqual(expect.objectContaining({ type: "bot_clarify_pending", clarifyId: "clarify-1", prompt: "Which?" }));
    expect(await recovered.surface().resolveClarify("sage", "clarify-1", "b", "device-1")).toBe("requested");
    expect(await recovered.surface().resolveClarify("sage", "clarify-1", "a", "device-2")).toBe("resolution_pending");
    expect(ingress.requestNativeClarifyResolution).toHaveBeenCalledTimes(2);
    expect(storage.nativeInteraction("sage", "clarify", "clarify-1")).toMatchObject({ status: "pending", requestedOptionId: "b" });
    expect(frames).toContainEqual(expect.objectContaining({ type: "bot_clarify_resolution_requested", clarifyId: "clarify-1" }));
    expect(frames).not.toContainEqual(expect.objectContaining({ type: "bot_clarify_resolved", clarifyId: "clarify-1" }));
    expect(recovered.handle("sage", { kind: "event", sequence: 3, eventId: "clarify-selected", event: { kind: "clarify", threadId: chat.sessionId, turnId: "turn-1", clarifyId: "clarify-1", prompt: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], status: "resolved", selectedOptionId: "b" } })).toBe(true);
    expect(storage.nativeInteraction("sage", "clarify", "clarify-1")).toMatchObject({ status: "selected", selectedOptionId: "b" });
    expect(frames).toContainEqual(expect.objectContaining({ type: "bot_clarify_resolved", clarifyId: "clarify-1", outcome: "selected", selectedOptionId: "b" }));
    recovered.close();
    storage.close();
  });

  it("keeps removed profiles out of the approval inbox and expires stale active rows before listing", async () => {
    const storage = openStorage(":memory:");
    for (const input of [
      { bot: "sage", interactionId: "expired-list", expiresAt: 10 },
      { bot: "sage", interactionId: "live", expiresAt: 30 },
      { bot: "removed", interactionId: "orphan", expiresAt: undefined },
    ]) {
      storage.recordNativeInteraction({
        bot: input.bot, kind: "approval", interactionId: input.interactionId,
        sessionId: `session-${input.bot}`, turnId: `turn-${input.interactionId}`,
        payload: { name: "workspace.write" }, status: "pending",
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        updatedAt: 1,
      });
    }
    const frames: ServerFrame[] = [];
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress, nativeBots: ["sage"],
      chatSuggestion: "", broadcast: (frame) => frames.push(frame), now: () => 20,
    });

    // No sleep: this is the same immediate read a cold push-launch takes.
    expect(plane.surface().pendingApprovals()).toEqual([{
      bot: "sage", sessionId: "session-sage", turnId: "turn-live", toolCallId: "live",
      ruleName: "workspace.write", createdAt: 1,
    }]);
    expect(storage.nativeInteraction("sage", "approval", "expired-list")?.status).toBe("expired");
    expect(frames).toContainEqual(expect.objectContaining({
      type: "bot_approval_resolved", toolCallId: "expired-list", outcome: "expired",
    }));
    expect(storage.nativeInteraction("removed", "approval", "orphan")?.status).toBe("pending");
    expect(await plane.surface().resolveApproval("removed", "orphan", "approve", "device-1")).toBe("unknown");

    plane.close();
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

  it("accepts scheduled delivery only for the selected native bot session", () => {
    const storage = openStorage(":memory:");
    const historical = storage.nativeBotChat("sage", 1);
    const selected = storage.resetNativeBotChat("sage", 2);
    const plane = new NativeBotDataPlane({ control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress, nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, now: () => 3 });
    const event = (threadId: string): AttachV1EventFrame => ({
      kind: "event", sequence: 1, eventId: `scheduled-${threadId}`,
      event: { kind: "scheduled", threadId, deliveryId: `delivery-${threadId}`, messageId: `message-${threadId}`, blocks: [{ type: "paragraph", text: "report" }] },
    });
    expect(plane.canAccept("sage", event(selected))).toBe(true);
    expect(plane.canAccept("sage", event(historical.sessionId))).toBe(false);
    expect(plane.handle("sage", event(historical.sessionId))).toBe(false);
    plane.close();
    storage.close();
  });

  it("projects a delegation batch out of order, isolates one child failure, and restores on reopen", async () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const ingress = {
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        storage.enqueueAttachCommand(bot, `turn:${String(input.turnId)}`, { kind: "turn", ...input } as never, 1);
        return true;
      },
    } as unknown as AttachV1Ingress;
    let now = 100;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress, nativeBots: ["sage"],
      chatSuggestion: "", broadcast: (frame) => frames.push(frame), now: () => now++,
    });
    const sent = await plane.surface().sendChatMessage("sage", "rewrite the skills");
    const turnId = storage.nativeBotChat("sage", now).activeTurnId!;
    // Below capability 34 nothing changes: without delegation events history has no field.
    expect(await plane.surface().chatHistory("sage")).not.toHaveProperty("delegations");

    const child = (eventId: string, sequence: number, body: Record<string, unknown>) => ({
      kind: "event" as const, sequence, eventId,
      event: {
        kind: "delegation", threadId: sent.sessionId, turnId,
        batchId: "call-1", count: 3, lastActiveAt: 5, ...body,
      } as never,
    });
    // Siblings update independently and OUT OF ORDER, and identical concurrent tool names
    // cannot collide: identity is (batchId, childId), tool names are display metadata.
    expect(plane.handle("sage", child("b-run", 1, { childId: "sa-1", index: 1, status: "running", label: "Rewrite B", currentTool: "write_file" }))).toBe(true);
    expect(plane.handle("sage", child("a-run", 2, { childId: "sa-0", index: 0, status: "running", label: "Rewrite A", currentTool: "write_file" }))).toBe(true);
    expect(plane.handle("sage", child("c-run", 3, { childId: "sa-2", index: 2, status: "running", label: "Rewrite C" }))).toBe(true);
    expect(plane.handle("sage", child("b-done", 4, { childId: "sa-1", index: 1, status: "succeeded", toolCount: 7 }))).toBe(true);
    // One child failing must not touch its siblings.
    expect(plane.handle("sage", child("a-fail", 5, { childId: "sa-0", index: 0, status: "failed" }))).toBe(true);
    expect(plane.handle("sage", {
      kind: "event", sequence: 6, eventId: "commit", event: {
        kind: "commit", threadId: sent.sessionId, turnId, messageId: "answer",
        blocks: [{ type: "paragraph", text: "dispatched" }],
      } as never,
    })).toBe(true);
    // The batch outlives its turn (async dispatch): sa-2's finish leg lands AFTER the seal
    // and still settles its card instead of being dropped.
    expect(plane.handle("sage", child("c-done", 7, { childId: "sa-2", index: 2, status: "succeeded" }))).toBe(true);

    const last = frames
      .filter((frame): frame is Extract<ServerFrame, { type: "bot_delegation_activity" }> => frame.type === "bot_delegation_activity")
      .at(-1)!;
    expect(last).toMatchObject({
      bot: "sage", turnId, batchId: "call-1", count: 3, done: true,
      children: [
        { childId: "sa-0", index: 0, status: "failed", label: "Rewrite A" },
        { childId: "sa-1", index: 1, status: "succeeded", toolCount: 7, label: "Rewrite B" },
        { childId: "sa-2", index: 2, status: "succeeded", label: "Rewrite C" },
      ],
    });
    // Privacy: only bounded display fields cross the wire -- no args, results, reasoning,
    // summaries, prompts, or paths.
    const allowed = new Set(["apiCalls", "childId", "currentTool", "endedAt", "index", "label", "lastActiveAt", "startedAt", "status", "toolCount"]);
    for (const entry of last.children) {
      for (const field of Object.keys(entry)) expect(allowed.has(field), field).toBe(true);
    }

    expect(await plane.surface().chatHistory("sage")).toMatchObject({
      running: false,
      delegations: [{ turnId, batchId: "call-1", count: 3, children: [
        { childId: "sa-0", status: "failed" },
        { childId: "sa-1", status: "succeeded" },
        { childId: "sa-2", status: "succeeded" },
      ] }],
    });

    // A fresh plane over the same storage restores the batch for reconnecting clients.
    plane.close();
    const reopened = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress, nativeBots: ["sage"],
      chatSuggestion: "", broadcast: () => undefined, now: () => now++,
    });
    expect(await reopened.surface().chatHistory("sage")).toMatchObject({
      delegations: [{ batchId: "call-1", children: [
        { childId: "sa-0", status: "failed" },
        { childId: "sa-1", toolCount: 7 },
        { childId: "sa-2", status: "succeeded" },
      ] }],
    });
    reopened.close();
    storage.close();
  });

  it("projects a latest-only thinking preview, drops stale seq, and suppresses it after the seal", async () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const ingress = {
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        storage.enqueueAttachCommand(bot, `turn:${String(input.turnId)}`, { kind: "turn", ...input } as never, 1);
        return true;
      },
    } as unknown as AttachV1Ingress;
    let now = 100;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress, nativeBots: ["sage"],
      chatSuggestion: "", broadcast: (frame) => frames.push(frame), now: () => now++,
    });
    const sent = await plane.surface().sendChatMessage("sage", "think it through");
    const turnId = storage.nativeBotChat("sage", now).activeTurnId!;
    const think = (eventId: string, sequence: number, seq: number, text: string) => ({
      kind: "event" as const, sequence, eventId,
      event: { kind: "thinking", threadId: sent.sessionId, turnId, text, seq, lastActiveAt: 5 } as never,
    });
    const previews = () =>
      frames.filter((frame): frame is Extract<ServerFrame, { type: "bot_thinking_activity" }> => frame.type === "bot_thinking_activity");

    expect(plane.handle("sage", think("t1", 1, 1, "weighing the options"))).toBe(true);
    expect(plane.handle("sage", think("t2", 2, 2, "checking the diff"))).toBe(true);
    expect(plane.handle("sage", think("t3", 3, 3, "writing the answer"))).toBe(true);
    // An at-least-once replay with an old seq is acknowledged but can never regress the preview.
    expect(plane.handle("sage", think("stale", 4, 2, "checking the diff"))).toBe(true);
    // The commit seals the turn and flushes the coalescing window.
    expect(plane.handle("sage", {
      kind: "event", sequence: 5, eventId: "commit", event: {
        kind: "commit", threadId: sent.sessionId, turnId, messageId: "answer",
        blocks: [{ type: "paragraph", text: "done" }],
      } as never,
    })).toBe(true);

    // Latest-only: inside one flush window only the newest preview survives (1 immediate, 3 on
    // flush); the stale replay broadcast nothing.
    expect(previews().map((frame) => frame.seq)).toEqual([1, 3]);
    expect(previews().at(-1)).toMatchObject({ bot: "sage", turnId, text: "writing the answer" });

    // Post-terminal suppression: a late preview is acknowledged (never dead-letters, never
    // retries) and never reaches a client.
    expect(plane.handle("sage", think("late", 6, 4, "after the seal"))).toBe(true);
    expect(previews()).toHaveLength(2);

    // Ephemeral by design: reopen recovers commits and tool steps, never thinking.
    expect(await plane.surface().chatHistory("sage")).not.toHaveProperty("thinking");
    plane.close();
    storage.close();
  });

  it("treats a replayed delegation state as a projected no-op and never resurrects a settled child", () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: (frame) => frames.push(frame), now: () => 100,
    });
    const chat = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn", {
      kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello",
    } as never, 1);
    storage.setNativeBotTurn("sage", chat.sessionId, "turn", 1);
    const running = {
      kind: "delegation", threadId: chat.sessionId, turnId: "turn",
      batchId: "b", childId: "sa-0", index: 0, count: 1, status: "running", lastActiveAt: 5,
    } as never;

    expect(plane.handle("sage", { kind: "event", sequence: 1, eventId: "first", event: running })).toBe(true);
    expect(plane.handle("sage", { kind: "event", sequence: 2, eventId: "repeat", event: running })).toBe(true);
    expect(plane.handle("sage", { kind: "event", sequence: 3, eventId: "finish", event: {
      kind: "delegation", threadId: chat.sessionId, turnId: "turn",
      batchId: "b", childId: "sa-0", index: 0, count: 1, status: "succeeded", lastActiveAt: 6,
    } as never })).toBe(true);
    // A live leg replayed AFTER the child settled is acknowledged, never a resurrection.
    expect(plane.handle("sage", { kind: "event", sequence: 4, eventId: "stale-run", event: running })).toBe(true);

    expect(storage.botChatDelegations(chat.sessionId, 0)).toHaveLength(1);
    expect(storage.botChatDelegations(chat.sessionId, 0)[0]).toMatchObject({ status: "succeeded" });
    plane.close();
    storage.close();
  });

  it("admits and projects delegation updates after the attach turn seals", () => {
    const storage = openStorage(":memory:");
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, now: () => 100,
    });
    const chat = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn", {
      kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello",
    } as never, 1);
    storage.setNativeBotTurn("sage", chat.sessionId, "turn", 1);

    const project = (frame: AttachV1EventFrame) => {
      expect(storage.unappliedAttachEvents("sage").map((pending) => pending.eventId)).toContain(frame.eventId);
      expect(plane.handle("sage", frame)).toBe(true);
      storage.markAttachEventApplied("sage", frame.eventId, frame.sequence);
    };
    const running = {
      kind: "event", sequence: 1, eventId: "running", event: {
        kind: "delegation", threadId: chat.sessionId, turnId: "turn",
        batchId: "batch", childId: "child", index: 0, count: 1,
        status: "running", lastActiveAt: 1,
      },
    } as AttachV1EventFrame;
    expect(storage.acceptAttachEvent("sage", running, 1)).toEqual({
      status: "accepted", acknowledgedSequence: 1,
    });
    project(running);

    const commit = {
      kind: "event", sequence: 2, eventId: "commit", event: {
        kind: "commit", threadId: chat.sessionId, turnId: "turn", messageId: "answer",
        blocks: [{ type: "paragraph", text: "dispatched" }],
      },
    } as AttachV1EventFrame;
    expect(storage.acceptAttachEvent("sage", commit, 2)).toEqual({
      status: "accepted", acknowledgedSequence: 2,
    });
    project(commit);
    expect(storage.nativeBotTurnTerminal("sage", chat.sessionId, "turn")).toMatchObject({
      status: "completed",
    });

    const succeeded = {
      kind: "event", sequence: 3, eventId: "succeeded", event: {
        ...running.event, status: "succeeded", lastActiveAt: 3,
      },
    } as AttachV1EventFrame;
    expect(storage.acceptAttachEvent("sage", succeeded, 3)).toEqual({
      status: "accepted", acknowledgedSequence: 3,
    });
    project(succeeded);
    expect(storage.botChatDelegations(chat.sessionId, 0)[0]).toMatchObject({ status: "succeeded" });
    expect(storage.acceptAttachEvent("sage", succeeded, 4)).toEqual({
      status: "duplicate", acknowledgedSequence: 3,
    });

    const lateDraft = {
      kind: "event", sequence: 4, eventId: "late-draft", event: {
        kind: "draft", threadId: chat.sessionId, turnId: "turn", blocks: [],
      },
    } as AttachV1EventFrame;
    expect(storage.acceptAttachEvent("sage", lateDraft, 4)).toEqual({
      status: "ignored_terminal", acknowledgedSequence: 4,
    });
    const lateThinking = {
      kind: "event", sequence: 5, eventId: "late-thinking", event: {
        kind: "thinking", threadId: chat.sessionId, turnId: "turn",
        text: "after seal", seq: 1, lastActiveAt: 5,
      },
    } as AttachV1EventFrame;
    expect(storage.acceptAttachEvent("sage", lateThinking, 5)).toEqual({
      status: "ignored_terminal", acknowledgedSequence: 5,
    });
    expect(storage.unappliedAttachEvents("sage")).toEqual([]);

    const staleRunning = {
      ...running, sequence: 6, eventId: "stale-running",
    } as AttachV1EventFrame;
    expect(storage.acceptAttachEvent("sage", staleRunning, 6)).toEqual({
      status: "accepted", acknowledgedSequence: 6,
    });
    project(staleRunning);
    expect(storage.botChatDelegations(chat.sessionId, 0)[0]).toMatchObject({ status: "succeeded" });

    plane.close();
    storage.close();
  });

  it("an interrupted turn settles its live children interrupted, leaving no spinner", async () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const ingress = {
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        storage.enqueueAttachCommand(bot, `turn:${String(input.turnId)}`, { kind: "turn", ...input } as never, 1);
        return true;
      },
    } as unknown as AttachV1Ingress;
    let now = 100;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress, nativeBots: ["sage"],
      chatSuggestion: "", broadcast: (frame) => frames.push(frame), now: () => now++,
    });
    const sent = await plane.surface().sendChatMessage("sage", "delegate");
    const turnId = storage.nativeBotChat("sage", now).activeTurnId!;
    expect(plane.handle("sage", { kind: "event", sequence: 1, eventId: "run", event: {
      kind: "delegation", threadId: sent.sessionId, turnId,
      batchId: "b", childId: "sa-0", index: 0, count: 1, status: "running", lastActiveAt: 5,
    } as never })).toBe(true);
    expect(plane.handle("sage", { kind: "event", sequence: 2, eventId: "stop", event: {
      kind: "interrupted", threadId: sent.sessionId, turnId,
    } as never })).toBe(true);

    expect(frames.filter((frame) => frame.type === "bot_delegation_activity").at(-1)).toMatchObject({
      turnId, batchId: "b", done: true, children: [{ childId: "sa-0", status: "interrupted" }],
    });
    expect(await plane.surface().chatHistory("sage")).toMatchObject({
      delegations: [{ turnId, children: [{ childId: "sa-0", status: "interrupted" }] }],
    });
    plane.close();
    storage.close();
  });

  it("a new turn settles a prior turn's unproven children unknown, never failed", async () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const ingress = {
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        storage.enqueueAttachCommand(bot, `turn:${String(input.turnId)}`, { kind: "turn", ...input } as never, 1);
        return true;
      },
    } as unknown as AttachV1Ingress;
    let now = 100;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress, nativeBots: ["sage"],
      chatSuggestion: "", broadcast: (frame) => frames.push(frame), now: () => now++,
    });
    const sent = await plane.surface().sendChatMessage("sage", "delegate");
    const turnId = storage.nativeBotChat("sage", now).activeTurnId!;
    expect(plane.handle("sage", { kind: "event", sequence: 1, eventId: "run", event: {
      kind: "delegation", threadId: sent.sessionId, turnId,
      batchId: "b", childId: "sa-0", index: 0, count: 1, status: "running", lastActiveAt: 5,
    } as never })).toBe(true);
    // A COMPLETED turn keeps live children live: the async batch legitimately continues.
    expect(plane.handle("sage", { kind: "event", sequence: 2, eventId: "commit", event: {
      kind: "commit", threadId: sent.sessionId, turnId, messageId: "answer",
      blocks: [{ type: "paragraph", text: "dispatched" }],
    } as never })).toBe(true);
    expect(storage.botChatDelegations(sent.sessionId, 0)[0]).toMatchObject({ status: "running" });

    // Whatever finish leg was coming may never come once a NEW turn starts over the same
    // chat: the unproven child settles `unknown` -- never `failed`.
    await plane.surface().sendChatMessage("sage", "next question");
    expect(storage.botChatDelegations(sent.sessionId, 0)[0]).toMatchObject({ status: "unknown" });
    expect(frames.filter((frame) => frame.type === "bot_delegation_activity").at(-1)).toMatchObject({
      turnId, batchId: "b", children: [{ childId: "sa-0", status: "unknown" }],
    });
    plane.close();
    storage.close();
  });

  it("a gateway restart leaves in-flight children unknown, never failed", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "delegation-restart-")), "gateway.sqlite");
    const storage = openStorage(dbPath);
    const ingress = {
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        storage.enqueueAttachCommand(bot, `turn:${String(input.turnId)}`, { kind: "turn", ...input } as never, 1);
        return true;
      },
    } as unknown as AttachV1Ingress;
    let now = 100;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress, nativeBots: ["sage"],
      chatSuggestion: "", broadcast: () => undefined, now: () => now++,
    });
    const sent = await plane.surface().sendChatMessage("sage", "delegate");
    const turnId = storage.nativeBotChat("sage", now).activeTurnId!;
    expect(plane.handle("sage", { kind: "event", sequence: 1, eventId: "run", event: {
      kind: "delegation", threadId: sent.sessionId, turnId,
      batchId: "b", childId: "sa-0", index: 0, count: 1, status: "running", lastActiveAt: 5,
    } as never })).toBe(true);
    expect(plane.handle("sage", { kind: "event", sequence: 2, eventId: "commit", event: {
      kind: "commit", threadId: sent.sessionId, turnId, messageId: "answer",
      blocks: [{ type: "paragraph", text: "dispatched" }],
    } as never })).toBe(true);
    plane.close();
    storage.close();

    // Boot-time reconciliation: Hermes cannot prove what an in-flight child did across a
    // restart, so the surviving row is `unknown` -- and a late finish leg replayed through
    // the spool is still free to overwrite it with the real outcome.
    const reopened = openStorage(dbPath);
    expect(reopened.botChatDelegations(sent.sessionId, 0)[0]).toMatchObject({ status: "unknown" });
    reopened.close();
  });

  it("carries the canonical Hermes alias from the terminal leg into snapshots, history, and reopen", async () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const ingress = {
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        storage.enqueueAttachCommand(bot, `turn:${String(input.turnId)}`, { kind: "turn", ...input } as never, 1);
        return true;
      },
    } as unknown as AttachV1Ingress;
    let now = 100;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress, nativeBots: ["sage"],
      chatSuggestion: "", broadcast: (frame) => frames.push(frame), now: () => now++,
    });
    const sent = await plane.surface().sendChatMessage("sage", "delegate");
    const turnId = storage.nativeBotChat("sage", now).activeTurnId!;
    // The spawn leg runs INSIDE the delegate_task call, before its result exists: no alias.
    expect(plane.handle("sage", { kind: "event", sequence: 1, eventId: "run", event: {
      kind: "delegation", threadId: sent.sessionId, turnId,
      batchId: "call_d3R3", childId: "sa-0", index: 0, count: 1, status: "running", lastActiveAt: 5,
    } as never })).toBe(true);
    expect(plane.handle("sage", { kind: "event", sequence: 2, eventId: "commit", event: {
      kind: "commit", threadId: sent.sessionId, turnId, messageId: "answer",
      blocks: [{ type: "paragraph", text: "dispatched" }],
    } as never })).toBe(true);
    // The async finish leg carries the canonical deleg_... id the plugin read from the result.
    expect(plane.handle("sage", { kind: "event", sequence: 3, eventId: "done", event: {
      kind: "delegation", threadId: sent.sessionId, turnId,
      batchId: "call_d3R3", childId: "sa-0", index: 0, count: 1, status: "succeeded",
      lastActiveAt: 6, aliasId: "deleg_c6eb9310",
    } as never })).toBe(true);

    const last = frames
      .filter((frame): frame is Extract<ServerFrame, { type: "bot_delegation_activity" }> => frame.type === "bot_delegation_activity")
      .at(-1)!;
    expect(last).toMatchObject({
      batchId: "call_d3R3", aliasId: "deleg_c6eb9310", done: true,
      children: [{ childId: "sa-0", status: "succeeded" }],
    });
    expect(storage.botChatDelegations(sent.sessionId, 0)[0]).toMatchObject({ aliasId: "deleg_c6eb9310" });
    expect(await plane.surface().chatHistory("sage")).toMatchObject({
      delegations: [{ batchId: "call_d3R3", aliasId: "deleg_c6eb9310" }],
    });
    plane.close();
    // A reopened plane restores the alias for reconnecting clients along with the batch.
    const reopened = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress, nativeBots: ["sage"],
      chatSuggestion: "", broadcast: () => undefined, now: () => now++,
    });
    expect(await reopened.surface().chatHistory("sage")).toMatchObject({
      delegations: [{ batchId: "call_d3R3", aliasId: "deleg_c6eb9310" }],
    });
    reopened.close();
    storage.close();
  });

  it("adopts a late alias without resurrecting a settled child and logs a broadcast-free terminal ack", () => {
    const storage = openStorage(":memory:");
    const frames: ServerFrame[] = [];
    const logs: string[] = [];
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: (frame) => frames.push(frame),
      now: () => 100, log: (message) => logs.push(message),
    });
    const chat = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn", {
      kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello",
    } as never, 1);
    storage.setNativeBotTurn("sage", chat.sessionId, "turn", 1);
    const base = {
      kind: "delegation", threadId: chat.sessionId, turnId: "turn",
      batchId: "call-1", childId: "sa-0", index: 0, count: 1,
    };
    expect(plane.handle("sage", { kind: "event", sequence: 1, eventId: "run",
      event: { ...base, status: "running", lastActiveAt: 5 } as never })).toBe(true);
    // An otherwise-identical replay whose only news is the alias must NOT be dropped.
    expect(plane.handle("sage", { kind: "event", sequence: 2, eventId: "run-alias",
      event: { ...base, status: "running", lastActiveAt: 5, aliasId: "deleg_11223344" } as never })).toBe(true);
    expect(storage.botChatDelegations(chat.sessionId, 0)[0]).toMatchObject({
      status: "running", aliasId: "deleg_11223344",
    });
    const succeeded = { ...base, status: "succeeded", lastActiveAt: 6, aliasId: "deleg_11223344" };
    expect(plane.handle("sage", { kind: "event", sequence: 3, eventId: "done",
      event: succeeded as never })).toBe(true);
    // A running replay AFTER settle never resurrects, even when it carries the alias.
    expect(plane.handle("sage", { kind: "event", sequence: 4, eventId: "stale",
      event: { ...base, status: "running", lastActiveAt: 5, aliasId: "deleg_11223344" } as never })).toBe(true);
    expect(storage.botChatDelegations(chat.sessionId, 0)[0]).toMatchObject({
      status: "succeeded", aliasId: "deleg_11223344",
    });
    // A duplicate settled replay is a no-op ack -- and an acknowledged TERMINAL event that
    // produces no broadcast is exactly the stuck-card shape, so it must hit the log.
    const rows = storage.botChatDelegations(chat.sessionId, 0).length;
    expect(plane.handle("sage", { kind: "event", sequence: 5, eventId: "dup",
      event: succeeded as never })).toBe(true);
    expect(storage.botChatDelegations(chat.sessionId, 0)).toHaveLength(rows);
    expect(logs.some((line) => line.includes("acknowledged without broadcast"))).toBe(true);
    plane.close();
    storage.close();
  });

  it("keeps aliases per batch when overlapping batches settle independently", () => {
    const storage = openStorage(":memory:");
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress: {} as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, now: () => 100,
    });
    const chat = storage.nativeBotChat("sage", 1);
    storage.enqueueAttachCommand("sage", "turn", {
      kind: "turn", threadId: chat.sessionId, turnId: "turn", messageId: "user", text: "hello",
    } as never, 1);
    storage.setNativeBotTurn("sage", chat.sessionId, "turn", 1);
    const child = (batchId: string, body: Record<string, unknown>) => ({
      kind: "delegation", threadId: chat.sessionId, turnId: "turn",
      batchId, childId: "sa-0", index: 0, count: 1, ...body,
    });
    let sequence = 0;
    const deliver = (eventId: string, event: unknown) =>
      plane.handle("sage", { kind: "event", sequence: ++sequence, eventId, event: event as never });
    expect(deliver("a-run", child("call-A", { status: "running", lastActiveAt: 5 }))).toBe(true);
    expect(deliver("b-run", child("call-B", { status: "running", lastActiveAt: 5 }))).toBe(true);
    // B settles FIRST: event ordering across batches must not matter, and each batch keeps
    // its own alias.
    expect(deliver("b-done", child("call-B", { status: "succeeded", lastActiveAt: 6, aliasId: "deleg_bbbb2222" }))).toBe(true);
    expect(deliver("a-done", child("call-A", { status: "succeeded", lastActiveAt: 7, aliasId: "deleg_aaaa1111" }))).toBe(true);
    const rows = storage.botChatDelegations(chat.sessionId, 0);
    expect(rows.find((row) => row.batchId === "call-A")).toMatchObject({
      status: "succeeded", aliasId: "deleg_aaaa1111",
    });
    expect(rows.find((row) => row.batchId === "call-B")).toMatchObject({
      status: "succeeded", aliasId: "deleg_bbbb2222",
    });
    plane.close();
    storage.close();
  });
});

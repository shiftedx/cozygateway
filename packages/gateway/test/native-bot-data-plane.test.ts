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

  it("queues a document as gateway-owned file media", async () => {
    const storage = openStorage(":memory:");
    const turns: Array<{ mediaIds?: string[] }> = [];
    let mediaWasAvailable = false;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage,
      ingress: { sendNativeTurn: (bot: string, turn: { mediaIds?: string[] }) => {
        turns.push(turn);
        mediaWasAvailable = storage.attachMediaInfo(bot, turn.mediaIds?.[0] ?? "", 10) !== undefined;
        return true;
      } } as unknown as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, now: () => 10,
    });
    const sent = await plane.surface().sendChatAttachment("sage", {
      bytes: new TextEncoder().encode('{"ok":true}'), mime: "application/json", name: "report.json", text: "Read this.",
    });
    const attachment = sent.message.attachments?.[0];
    expect(attachment).toMatchObject({ name: "report.json", mimeType: "application/json", mediaKind: "file" });
    expect(turns[0]?.mediaIds).toEqual([attachment?.fileId]);
    expect(mediaWasAvailable).toBe(true);
    expect(storage.attachMediaInfo("sage", attachment!.fileId, 10)?.descriptor.family).toBe("file");
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

  it("interrupts an acknowledged executing turn when the existing gateway bound expires", async () => {
    vi.useFakeTimers();
    try {
      const storage = openStorage(":memory:");
      let now = 0;
      let command: { sequence: number; commandId: string } | undefined;
      const interrupt = vi.fn(() => true);
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
        broadcast: () => undefined,
        now: () => now,
        turnTimeoutMs: 50,
      });
      await plane.surface().sendChatMessage("sage", "running");
      storage.ackAttachCommand("sage", command!.sequence, command!.commandId, 1);
      now = 50;
      await vi.advanceTimersByTimeAsync(50);

      expect(interrupt).toHaveBeenCalledOnce();
      expect(await plane.surface().chatHistory("sage")).toMatchObject({ running: false, status: "timed_out" });
      plane.close();
      storage.close();
    } finally {
      vi.useRealTimers();
    }
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

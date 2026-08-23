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

    plane.mobileRequest("sage", { kind: "mobile_request", requestId: "request-1", command: "device.status", threadId: accepted.sessionId, turnId, expiresAt: 1_000 });
    plane.mobileRequest("sage", { kind: "mobile_request", requestId: "location-1", command: "location.current", threadId: accepted.sessionId, turnId, expiresAt: 1_000, purpose: "Find coffee" });
    plane.mobileRequest("sage", { kind: "mobile_request", requestId: "request-2", command: "device.status", threadId: accepted.sessionId, turnId: "agent-selected", expiresAt: 1_000 });

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
    })).toBe(false);
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
    })).toBe(false);
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
});

import { describe, expect, it } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";
import { check } from "cozygateway-contract";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { AttachV1ChatContextFrameSchema } from "../src/adapters/attach/protocol-v1.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";
import { openStorage } from "../src/storage.ts";

describe("native chat context readings", () => {
  it("keeps a runtime sample separate from history, marks it stale for the next turn, and refuses another session", async () => {
    let now = 1_000;
    const frames: unknown[] = [];
    const storage = openStorage(":memory:");
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {
        isAttached: () => true,
        sendNativeTurn: () => true,
      } as unknown as AttachV1Ingress,
      nativeBots: ["sage"],
      chatSuggestion: "",
      broadcast: (frame) => frames.push(frame),
      now: () => now++,
    });
    const surface = plane.surface();
    const accepted = await surface.sendChatMessage("sage", "hello");
    const first = storage.nativeBotChat("sage", now++);
    const firstTurn = first.activeTurnId;
    expect(firstTurn).toBeDefined();
    expect(await surface.chatContext?.("sage")).toEqual({ sessionId: accepted.sessionId, context: null });

    plane.handleChatContext("sage", {
      kind: "chat_context",
      threadId: accepted.sessionId,
      turnId: firstTurn!,
      usedTokens: 0,
      windowTokens: 128_000,
      measurement: "reported",
      source: "provider_usage",
      model: "test-model",
    });
    expect(await surface.chatContext?.("sage")).toMatchObject({
      sessionId: accepted.sessionId,
      context: {
        usedTokens: 0,
        windowTokens: 128_000,
        measurement: "reported",
        source: "provider_usage",
        stale: false,
        model: "test-model",
      },
    });

    // This is the exact latest-only producer shape. Gateway receipt stamps observedAt and the
    // HTTP response retains the canonical session at the outer level, never inside context.
    const app = new Hono<{ Variables: { deviceId: string } }>();
    const requireDevice: MiddlewareHandler<{ Variables: { deviceId: string } }> = async (c, next) => {
      c.set("deviceId", "device-1");
      await next();
    };
    registerBotRoutes(app, requireDevice, surface);
    const response = await app.request("/bots/sage/chat/context");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "sage", sessionId: accepted.sessionId,
      context: { usedTokens: 0, windowTokens: 128_000, stale: false, observedAt: expect.any(Number) },
    });

    // A spoofed session is ignored even though its agent identity is otherwise authenticated.
    plane.handleChatContext("sage", {
      kind: "chat_context", threadId: "foreign", turnId: firstTurn!, usedTokens: 9,
      windowTokens: 10, measurement: "estimated", source: "local_estimate",
    });
    expect((await surface.chatContext?.("sage"))?.context?.usedTokens).toBe(0);

    storage.clearNativeBotTurn("sage", accepted.sessionId, firstTurn!, now++);
    storage.recordNativeBotTerminal({
      bot: "sage", sessionId: accepted.sessionId, turnId: firstTurn!, status: "completed", completedAt: now++,
    });
    await surface.sendChatMessage("sage", "next");
    expect((await surface.chatContext?.("sage"))?.context?.stale).toBe(true);
    const secondTurn = storage.nativeBotChat("sage", now++).activeTurnId;
    expect(secondTurn).toBeDefined();
    plane.handleChatContext("sage", {
      kind: "chat_context", threadId: accepted.sessionId, turnId: secondTurn!, usedTokens: 321,
      windowTokens: 128_000, measurement: "estimated", source: "provider_usage_plus_estimate",
    });
    expect((await surface.chatContext?.("sage"))?.context).toMatchObject({ usedTokens: 321, stale: false });
    surface.contextConfigurationChanged?.("sage", accepted.sessionId);
    // Changing a model/workspace invalidates the current generation before its late sample can
    // replace the reading under a now-wrong model window.
    plane.handleChatContext("sage", {
      kind: "chat_context", threadId: accepted.sessionId, turnId: secondTurn!, usedTokens: 322,
      windowTokens: 128_000, measurement: "reported", source: "provider_usage",
    });
    expect((await surface.chatContext?.("sage"))?.context).toMatchObject({ usedTokens: 321, stale: true });
    storage.clearNativeBotTurn("sage", accepted.sessionId, secondTurn!, now++);
    storage.recordNativeBotTerminal({
      bot: "sage", sessionId: accepted.sessionId, turnId: secondTurn!, status: "completed", completedAt: now++,
    });
    // Turn 1 is terminal too, but can never replace a newer completed generation.
    plane.handleChatContext("sage", {
      kind: "chat_context", threadId: accepted.sessionId, turnId: firstTurn!, usedTokens: 1,
      windowTokens: 2, measurement: "reported", source: "provider_usage",
    });
    expect((await surface.chatContext?.("sage"))?.context?.usedTokens).toBe(321);
    const reset = await surface.resetChat("sage");
    expect(await surface.chatContext?.("sage")).toEqual({ sessionId: reset.sessionId, context: null });
    expect(frames).toContainEqual(expect.objectContaining({
      type: "bot_chat_context", bot: "sage", sessionId: accepted.sessionId,
    }));
    plane.close();
    storage.close();
  });

  it("keeps the optional route absent for a surface without runtime collection and rejects malformed producer frames", async () => {
    const app = new Hono<{ Variables: { deviceId: string } }>();
    const requireDevice: MiddlewareHandler<{ Variables: { deviceId: string } }> = async (c, next) => {
      c.set("deviceId", "device-1");
      await next();
    };
    registerBotRoutes(app, requireDevice, {} as BotsSurface);
    expect((await app.request("/bots/sage/chat/context")).status).toBe(404);
    expect(check(AttachV1ChatContextFrameSchema, {
      kind: "chat_context", threadId: "session", turnId: "turn", usedTokens: -1,
      windowTokens: 1, measurement: "reported", source: "provider_usage",
    })).toBe(false);
  });
});

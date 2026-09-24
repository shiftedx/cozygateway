import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";
import { BotCanonicalChatResponseSchema, BotChatReactionFrameSchema, check } from "cozygateway-contract";

import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { createCanonicalBotChat, ensureBotModeMarker, findCanonicalBotChat } from "../src/hermes-bridge/bot-chat.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";
import { openStorage } from "../src/storage.ts";

/** Capability 86 (bot parity S2): the canonical Hermes `Bot Chat`, its binding to the gateway's
 *  current chat, retire-on-clear, profile-model stickiness and Tapback reactions. The RPC shapes
 *  below are the ones recorded from a live Hermes 0.21.4 (068db016fb) on 2026-09-23. */

function rpc(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    request: async (method: string, params?: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: p });
      const handler = handlers[method];
      if (handler === undefined) throw new Error(`unexpected ${method}`);
      return handler(p);
    },
  };
}

describe("canonical Bot Chat registry (control plane)", () => {
  it("finds the exact-title row, follows the lineage tip, and never matches a lookalike", async () => {
    const hermes = rpc({
      "session.list": () => ({ sessions: [
        { id: "a", title: "Bot Chat 2", source: "desktop" },
        { id: "20260820_211955_e6baa9", resolved_id: "tip", title: "Bot Chat", source: "cli", message_count: 58 },
      ] }),
    });
    await expect(findCanonicalBotChat(hermes, "cleo")).resolves.toEqual({
      hermesSessionId: "20260820_211955_e6baa9", resolvedId: "tip",
    });
    expect(hermes.calls[0]).toEqual({ method: "session.list", params: {
      profile: "cleo", title: "Bot Chat", include_hidden: true, limit: 200,
    } });
  });

  it("fails CLOSED: a lookup error is never read as 'no Bot Chat'", async () => {
    const hermes = rpc({ "session.list": () => { throw new Error("backend restarting"); } });
    await expect(findCanonicalBotChat(hermes, "cleo")).rejects.toThrow(/not starting a new chat/);
  });

  it("mints hidden, desktop-sourced, following the profile, and titles it before anything else", async () => {
    const hermes = rpc({
      "session.create": () => ({ session_id: "1dd09306", stored_session_id: "20260924_033203_fc99be", message_count: 0 }),
      "session.title": () => ({ pending: false, title: "Bot Chat" }),
    });
    await expect(createCanonicalBotChat(hermes, "s2scout")).resolves.toEqual({ hermesSessionId: "20260924_033203_fc99be" });
    expect(hermes.calls.map((call) => call.method)).toEqual(["session.create", "session.title"]);
    expect(hermes.calls[0]!.params).toEqual({
      profile: "s2scout", title: "Bot Chat", hidden: true, follow_profile_config: true, source: "desktop",
    });
    expect(hermes.calls[1]!.params).toEqual({ session_id: "1dd09306", title: "Bot Chat" });
  });

  it("adopts the winner when another writer took the title first", async () => {
    const hermes = rpc({
      "session.create": () => ({ session_id: "r", stored_session_id: "stray" }),
      "session.title": () => { throw new Error("Title 'Bot Chat' is already in use by session winner"); },
      "session.list": () => ({ sessions: [{ id: "winner", title: "Bot Chat" }] }),
    });
    await expect(createCanonicalBotChat(hermes, "cleo")).resolves.toEqual({ hermesSessionId: "winner" });
  });

  it("writes the Bot-Mode marker only when no profile on the install has one", async () => {
    const unmanaged = rpc({
      "profiles.list": () => ({ profiles: [{ name: "default", ui_meta: null }, { name: "pixel", ui_meta: {} }] }),
      "profiles.configure": () => ({ applied: { ui_meta: true } }),
    });
    await expect(ensureBotModeMarker(unmanaged, "pixel")).resolves.toBe(true);
    expect(unmanaged.calls[1]!.params).toEqual({
      name: "pixel", ui_meta: { "hermes-bots": {} }, ui_meta_expected_revisions: { "hermes-bots": 0 },
    });
    const managed = rpc({
      "profiles.list": () => ({ profiles: [{ name: "cleo", ui_meta: { "hermes-bots": { pinned: true } } }, { name: "pixel" }] }),
    });
    await expect(ensureBotModeMarker(managed, "pixel")).resolves.toBe(false);
    expect(managed.calls).toHaveLength(1);
  });
});

function plane(opts: { canonical?: { hermesSessionId: string; created: boolean } | null } = {}) {
  const storage = openStorage(":memory:");
  const frames: Array<Record<string, unknown>> = [];
  const resumes: Array<{ threadId: string; hermesSessionId: string; resumeId: string }> = [];
  let canonical = opts.canonical === undefined ? { hermesSessionId: "bot-chat-1", created: true } : opts.canonical;
  const control = {
    canonicalBotChat: vi.fn(async () => canonical),
    archiveHermesSession: vi.fn(async () => undefined),
    desktopSessions: vi.fn(async () => [{
      source: "hermes_desktop", origin: "tui", hermesSessionId: "newer-scratch", startedAt: 1, lastActiveAt: 9_999_999_999_999,
    }]),
    desktopSessionTranscript: vi.fn(async () => []),
    configureModel: vi.fn(async () => ({ model: { id: "gpt-5" } })),
  } as unknown as BotsSurface;
  const ingress = {
    sendNativeTurn: () => true,
    sendNativeDesktopResume: (_peer: string, resume: { threadId: string; hermesSessionId: string; resumeId: string }) => {
      resumes.push(resume);
      return true;
    },
  } as unknown as AttachV1Ingress;
  const p = new NativeBotDataPlane({
    control, storage, ingress, nativeBots: ["sage"], chatSuggestion: "",
    broadcast: (frame) => frames.push(frame as Record<string, unknown>), staleTurnSweepMs: 0,
  });
  const confirm = () => {
    const resume = resumes.at(-1)!;
    expect(p.handle("sage", {
      kind: "event", sequence: resumes.length, eventId: `confirm-${resumes.length}`,
      event: { kind: "desktop_session_resumed", threadId: resume.threadId, hermesSessionId: resume.hermesSessionId, resumeId: resume.resumeId },
    } as never)).toBe(true);
  };
  return {
    storage, frames, resumes, control, plane: p, surface: p.surface(), confirm,
    setCanonical: (next: typeof canonical) => { canonical = next; },
    close: () => { p.close(); storage.close(); },
  };
}

describe("capability 86 on the native data plane", () => {
  it("binds the current chat to the Bot Chat through the resume proof and reports a mint", async () => {
    const h = plane();
    const opening = h.surface.openBotChat!("sage");
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1));
    expect(h.resumes[0]!.hermesSessionId).toBe("bot-chat-1");
    h.confirm();
    const opened = await opening;
    expect(check(BotCanonicalChatResponseSchema, opened)).toBe(true);
    expect(opened).toMatchObject({ name: "sage", created: true, status: "resumed", sessionId: h.resumes[0]!.threadId });
    expect(h.storage.nativeBotChat("sage", Date.now()).sessionId).toBe(h.resumes[0]!.threadId);

    // Re-opening with the proof held is free: no second resume command.
    h.setCanonical({ hermesSessionId: "bot-chat-1", created: false });
    await expect(h.surface.openBotChat!("sage")).resolves.toMatchObject({ created: false, status: "resumed" });
    expect(h.resumes).toHaveLength(1);

    // A newer desktop scratch session never displaces the bound Bot Chat.
    await h.surface.canonicalChat("sage");
    expect(h.resumes).toHaveLength(1);

    // A restarted gateway (no in-memory proof) keeps the durable binding instead of re-staging
    // it: live, a re-stage came back `pending` because Hermes re-stamps the row `cozygateway`.
    const restarted = new NativeBotDataPlane({
      control: h.control, storage: h.storage,
      ingress: { sendNativeTurn: () => true, sendNativeDesktopResume: () => { throw new Error("re-staged"); } } as unknown as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, staleTurnSweepMs: 0,
    });
    await expect(restarted.surface().openBotChat!("sage")).resolves.toMatchObject({ status: "resumed" });
    restarted.close();
    h.close();
  });

  it("the Bot Chat binding survives a gateway restart: no displacement, and Clear chat still retires", async () => {
    const h = plane();
    const opening = h.surface.openBotChat!("sage");
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1));
    h.confirm();
    await opening;
    h.plane.close();
    // A fresh plane on the same database, no roster open since: the durable row is all it has.
    const resumes: unknown[] = [];
    const restarted = new NativeBotDataPlane({
      control: h.control, storage: h.storage,
      ingress: { sendNativeTurn: () => true, sendNativeDesktopResume: (_p: string, r: unknown) => { resumes.push(r); return true; } } as unknown as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, staleTurnSweepMs: 0,
    });
    const surface = restarted.surface();
    // The newer desktop scratch session does not take the chat over.
    await surface.canonicalChat("sage");
    expect(resumes).toEqual([]);
    // Clear chat still archives the Hermes Bot Chat, and forgets it durably.
    await surface.resetChat("sage");
    expect(h.control.archiveHermesSession).toHaveBeenCalledWith("sage", "bot-chat-1");
    expect(h.storage.canonicalBotChat("sage")).toBeUndefined();
    restarted.close();
    h.storage.close();
  });

  it("a teammate's DM written into the bound Bot Chat shows up once as a bot_chat message", async () => {
    const h = plane();
    const opening = h.surface.openBotChat!("sage");
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1));
    h.confirm();
    await opening;
    const threadId = h.resumes[0]!.threadId;
    const row = (eventId: string) => ({
      kind: "event", sequence: 10, eventId,
      event: {
        kind: "desktop_session_message", threadId, hermesSessionId: "bot-chat-1", desktopSessionId: "bot-chat-1",
        source: "desktop", rowId: "44", role: "assistant", text: "PONG back to pixel", at: 1_790_222_400_000,
      },
    });
    const before = h.frames.length;
    expect(h.plane.handle("sage", row("mirror-44") as never)).toBe(true);
    // At-least-once attach: a replay of the same Hermes row is acknowledged and not re-sent.
    expect(h.plane.handle("sage", row("mirror-44-replay") as never)).toBe(true);
    const chats = h.frames.slice(before).filter((frame) => frame["type"] === "bot_chat");
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ bot: "sage", sessionId: threadId,
      messages: [expect.objectContaining({ role: "assistant", text: "PONG back to pixel" })] });
    expect(h.storage.nativeBotMessages("sage", threadId).filter((m) => m.text === "PONG back to pixel")).toHaveLength(1);
    h.close();
  });

  it("clearing a bound Bot Chat retires it in Hermes (archive + hide)", async () => {
    const h = plane();
    const opening = h.surface.openBotChat!("sage");
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1));
    h.confirm();
    await opening;
    const reset = await h.surface.resetChat("sage");
    expect(h.control.archiveHermesSession).toHaveBeenCalledWith("sage", "bot-chat-1");
    expect(reset.previousSessionId).toBe(h.resumes[0]!.threadId);
    // An ordinary (unbound) chat's clear touches nothing in Hermes.
    await h.surface.resetChat("sage");
    expect(h.control.archiveHermesSession).toHaveBeenCalledTimes(1);
    h.close();
  });

  it("a failed archive fails Clear chat and keeps the binding (review #3)", async () => {
    const h = plane();
    const opening = h.surface.openBotChat!("sage");
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1));
    h.confirm();
    await opening;
    const before = h.storage.nativeBotChat("sage", Date.now()).sessionId;
    (h.control.archiveHermesSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("dashboard down"));
    await expect(h.surface.resetChat("sage")).rejects.toThrow(/dashboard down/);
    expect(h.storage.canonicalBotChat("sage")).toBe("bot-chat-1");
    expect(h.storage.nativeBotChat("sage", Date.now()).sessionId).toBe(before);
    expect(h.frames.filter((f) => f["type"] === "bot_chat_reset")).toEqual([]);
    // The retry succeeds and retires it.
    await h.surface.resetChat("sage");
    expect(h.storage.canonicalBotChat("sage")).toBeUndefined();
    h.close();
  });

  it("session.reclaimed re-proves only a chat bound to the Bot Chat, never switching selection (review #4)", async () => {
    const h = plane();
    const opening = h.surface.openBotChat!("sage");
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1));
    h.confirm();
    await opening;
    const bound = h.storage.nativeBotChat("sage", Date.now()).sessionId;
    h.plane.sessionReclaimed("bot-chat-1");
    await vi.waitFor(() => expect(h.resumes).toHaveLength(2));
    // The re-proof names the SAME gateway chat, so confirming it moves nothing.
    expect(h.resumes[1]!.threadId).toBe(bound);
    h.confirm();
    expect(h.storage.nativeBotChat("sage", Date.now()).sessionId).toBe(bound);
    // The user moves to another chat: a reclaim of the Bot Chat now does nothing at all.
    await h.surface.newSession("sage");
    h.plane.sessionReclaimed("bot-chat-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.resumes).toHaveLength(2);
    expect(h.storage.nativeBotChat("sage", Date.now()).sessionId).not.toBe(bound);
    h.close();
  });

  it("deleting a conversation deletes its Tapbacks (review #7)", async () => {
    const h = plane();
    const old = h.storage.nativeBotChat("sage", 1).sessionId;
    h.storage.appendNativeBotMessage({ bot: "sage", sessionId: old, messageId: `${old}#0`, role: "assistant", text: "x", at: 1 });
    h.storage.setBotMessageReaction({ bot: "sage", messageId: `${old}#0`, author: "user", emoji: "❤️", now: 2 });
    await h.surface.newSession("sage");
    expect(h.storage.deleteNativeBotSession({ bot: "sage", sessionId: old, deletedAt: 3, enqueue: false }).outcome).toBe("deleted");
    expect(h.storage.botMessageReactions("sage", `${old}#0`)).toEqual([]);
    h.close();
  });

  it("a new profile model clears every per-chat override of that bot", async () => {
    const h = plane();
    const chat = h.storage.nativeBotChat("sage", Date.now());
    expect(h.storage.updateNativeChatConfiguration({
      bot: "sage", sessionId: chat.sessionId, model: { id: "claude-opus" } as never, now: Date.now(),
    }).outcome).toBe("updated");
    await h.surface.configureModel("sage", { model: { id: "gpt-5" } } as never);
    expect(h.storage.nativeChatConfiguration("sage", chat.sessionId)?.model).toBeNull();
    h.close();
  });

  it("Tapbacks: one per author, repeat retracts, null clears, and every device hears it", async () => {
    const h = plane();
    const chat = h.storage.nativeBotChat("sage", Date.now());
    const row = h.storage.appendNativeBotMessage({
      bot: "sage", sessionId: chat.sessionId, messageId: `${chat.sessionId}#0`, role: "assistant", text: "hi", at: Date.now(),
    });
    await expect(h.surface.reactToChatMessage!("sage", row.id, "❤️")).resolves.toMatchObject({
      messageId: row.id, reactions: [{ emoji: "❤️", author: "user" }],
    });
    await expect(h.surface.reactToChatMessage!("sage", row.id, "👍")).resolves.toMatchObject({
      reactions: [{ emoji: "👍", author: "user" }],
    });
    expect(h.storage.nativeBotMessages("sage", chat.sessionId)[0]!.reactions).toEqual([
      expect.objectContaining({ emoji: "👍", author: "user" }),
    ]);
    await expect(h.surface.reactToChatMessage!("sage", row.id, "👍")).resolves.toMatchObject({ reactions: [] });
    await h.surface.reactToChatMessage!("sage", row.id, "‼️");
    await expect(h.surface.reactToChatMessage!("sage", row.id, null)).resolves.toMatchObject({ reactions: [] });
    expect(h.storage.nativeBotMessages("sage", chat.sessionId)[0]!.reactions).toBeUndefined();
    const reactionFrames = h.frames.filter((frame) => frame["type"] === "bot_chat_reaction");
    expect(reactionFrames).toHaveLength(5);
    for (const frame of reactionFrames) expect(check(BotChatReactionFrameSchema, frame)).toBe(true);
    await expect(h.surface.reactToChatMessage!("sage", "nope", "❤️")).rejects.toThrow();
    h.close();
  });
});

describe("capability 86 routes", () => {
  type Env = { Variables: { deviceId: string } };
  const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
    c.set("deviceId", "device-1");
    await next();
  };

  it("opens the Bot Chat and takes a Tapback; an absent emoji key is refused, null clears", async () => {
    const app = new Hono<Env>();
    const openBotChat = vi.fn(async () => ({ name: "sage", created: true, status: "resumed", sessionId: "native:sage:1" }));
    const reactToChatMessage = vi.fn(async (_name: string, messageId: string, emoji: string | null) =>
      ({ messageId, reactions: emoji === null ? [] : [{ emoji, author: "user" }] }));
    registerBotRoutes(app, requireDevice, { openBotChat, reactToChatMessage } as unknown as BotsSurface);

    const opened = await app.request("/bots/SAGE/bot-chat", { method: "POST", body: "{}" });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ created: true, status: "resumed" });
    expect(openBotChat).toHaveBeenCalledWith("sage");

    const put = (body: string) => app.request("/bots/sage/chat/messages/native%3Asage%3A1%230/reaction", {
      method: "PUT", body, headers: { "Content-Type": "application/json" },
    });
    expect((await put(JSON.stringify({ emoji: "❤️" }))).status).toBe(200);
    expect(reactToChatMessage).toHaveBeenLastCalledWith("sage", "native:sage:1#0", "❤️");
    expect((await put("{}")).status).toBe(400);
    expect((await put(JSON.stringify({ emoji: null }))).status).toBe(200);
    expect(reactToChatMessage).toHaveBeenLastCalledWith("sage", "native:sage:1#0", null);
  });

  it("a surface without a Hermes profile registers neither route", async () => {
    const app = new Hono<Env>();
    registerBotRoutes(app, requireDevice, {} as unknown as BotsSurface);
    expect((await app.request("/bots/sage/bot-chat", { method: "POST", body: "{}" })).status).toBe(404);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { Message, RichBlock, ServerFrame } from "cozygateway-contract";

import { BOTS_CAPABILITY_VERSION } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { syntheticChatId } from "../src/hermes-bridge/chat-identity.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { CANONICAL_CHAT_TITLE } from "../src/hermes-bridge/canonical-chat.ts";
import { startFakeHermesServer, type FakeHermesBehavior, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** The duplex chat path end to end against a fake Hermes: history, send, the turn poll, the frames
 *  the app renders from, and the duplicate-adoption bug that shipped in wave 1.
 *
 *  The poll cadence and cap are scaled down; `bots-chat-turns.test.ts` asserts the production
 *  values. Everything else here is the real bridge, the real routes, and the real device auth. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  agents: [{ id: "mock", name: "Mock", backend: "mock" }],
};

const NOW = 1_800_000_000_000;

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
});

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  server: FakeHermesServer;
  bridge: HermesBridge;
  client: HermesClient;
  storage: Storage;
  frames: ServerFrame[];
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  /** Same app, no device token attached. */
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

async function setup(
  behavior: FakeHermesBehavior = {},
  overrides: {
    chatPollMs?: number;
    chatTurnTimeoutMs?: number;
    chatDeltaThrottleMs?: number;
    onChatMessage?: (event: {
      bot: string;
      displayName: string;
      messageId: string;
      chatSessionId: string;
      preview: string;
    }) => void;
  } = {},
): Promise<Harness> {
  const server = await startFakeHermesServer(behavior);
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const frames: ServerFrame[] = [];
  // A clock that ticks once per read. The bridge stamps pin writes and roster snapshots with it,
  // and the ORDER of those two stamps is what tells a pin this gateway just wrote from one the
  // cached roster has already had a chance to see.
  let clock = NOW;
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => (clock += 1),
    logSink: () => {},
    chatPollMs: overrides.chatPollMs ?? 10,
    chatTurnTimeoutMs: overrides.chatTurnTimeoutMs ?? 2_000,
    chatDeltaThrottleMs: overrides.chatDeltaThrottleMs ?? 10,
    ...(overrides.onChatMessage === undefined ? {} : { onChatMessage: overrides.onChatMessage }),
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 2 } },
    presenceOf: () => "online",
    submitUserMessage: (threadId: string, blocks: RichBlock[]): Message =>
      storage.appendMessage(threadId, { role: "user", blocks }, 500),
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
  const pairRes = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

  bridge.start();
  await until(() => client.state() === "online", 4_000);
  return {
    server,
    bridge,
    client,
    storage,
    frames,
    authed: async (path, init) =>
      app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } }),
    request: async (path, init) => app.request(path, init),
  };
}

interface FakeBotState {
  meta: Record<string, unknown> | null;
  sessions: Array<{ id: string; title: string; source?: string; preview?: string; last_active?: number }>;
  created: number;
  /** stored session id -> RUNTIME session id, the only id `prompt.submit` accepts. */
  runtime: Map<string, string>;
}

/** A Hermes whose bot has one canonical chat with a growing message list, and which stores what
 *  `profiles.configure` writes so the roster reflects it, exactly as the real gateway does.
 *
 *  Strict about session ids on purpose. The real gateway distinguishes the STORED id (what gets
 *  pinned) from the RUNTIME id (what `prompt.submit` is addressed to, dissection 1.2 row 11), and a
 *  session with no persisted row cannot be resumed at all. A fake that accepts any id in any slot
 *  is what let a send against the stored id look green for a whole release. */
function fakeBotMode(options: {
  /** Sessions `session.list` reports. Empty models a chat nobody has written in, which persists no
   *  row and is therefore unlistable. */
  sessions?: Array<{ id: string; title: string; source?: string; preview?: string; last_active?: number }>;
  messages?: Array<Record<string, unknown>>;
  running?: () => boolean;
  /** Omit to make `profiles.configure` an unknown method, which is what an old gateway does. */
  supportsConfigure?: boolean;
  /** Starting `ui_meta["hermes-bots"]` blob; null means the profile carries no ui_meta at all. */
  meta?: Record<string, unknown> | null;
} = {}): { behavior: FakeHermesBehavior; state: FakeBotState } {
  const sessions = options.sessions ?? [];
  const state: FakeBotState = {
    meta: options.meta === undefined ? { title: "Scout" } : options.meta,
    sessions,
    created: 0,
    runtime: new Map(sessions.map((session, index) => [session.id, `runtime-${index + 1}`])),
  };
  const storedOf = (id: string): string | undefined => {
    if (state.runtime.has(id)) return id;
    for (const [stored, runtime] of state.runtime) if (runtime === id) return stored;
    return undefined;
  };
  const behavior: FakeHermesBehavior = {
    methods: {
      "profiles.list": () => ({
        profiles: [
          {
            name: "scout",
            description: "watches CI",
            has_avatar: false,
            last_session: { last_active: Math.round(NOW / 1000) - 5, preview: "all green" },
            ...(state.meta === null ? {} : { ui_meta: { "hermes-bots": state.meta } }),
          },
        ],
        bot_mode_protocol: true,
      }),
      "session.list": () => ({ sessions: state.sessions }),
      "session.create": () => {
        state.created += 1;
        const stored = `stored-${state.created}`;
        state.runtime.set(stored, `runtime-${state.created}`);
        // Deliberately persists NOTHING: the row only appears once a prompt lands, which is the
        // real host's behavior and the whole reason the duplicate bug existed.
        return { stored_session_id: stored, session_id: `runtime-${state.created}` };
      },
      "prompt.submit": (params) => {
        const id = String(params["session_id"] ?? "");
        const stored = storedOf(id);
        if (stored === undefined || state.runtime.get(stored) !== id) {
          throw { code: 5003, message: `prompt.submit needs the runtime session id, got ${id}` };
        }
        return { ok: true };
      },
      "session.interrupt": () => ({ status: "interrupted" }),
      "session.resume": (params) => {
        const id = String(params["session_id"] ?? "");
        const stored = storedOf(id);
        // A session with no listed row has not persisted yet: hermes has nothing to resume.
        if (stored === undefined || !state.sessions.some((session) => session.id === stored)) {
          throw { code: 5003, message: "no such session" };
        }
        return {
          session_id: state.runtime.get(stored),
          session_key: "k",
          message_count: (options.messages ?? []).length,
          running: options.running?.() ?? false,
          inflight: false,
          ...(params["omit_messages"] === true ? {} : { messages: options.messages ?? [] }),
        };
      },
      ...(options.supportsConfigure === false
        ? {}
        : {
            "profiles.configure": (params) => {
              const uiMeta = params["ui_meta"] as Record<string, unknown> | undefined;
              const blob = uiMeta?.["hermes-bots"];
              if (typeof blob === "object" && blob !== null) state.meta = blob as Record<string, unknown>;
              return { applied: { ui_meta: true } };
            },
          }),
    },
  };
  return { behavior, state };
}

describe("GET /bots/:name/chat/messages", () => {
  it("maps the canonical chat's history to the stable wire shape", async () => {
    const { behavior } = fakeBotMode({
      sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }],
      messages: [
        { id: "m1", role: "user", content: "morning", at: Math.round(NOW / 1000) },
        { role: "assistant", content: [{ text: "morning " }, "yourself"] },
      ],
    });
    const { authed, server } = await setup(behavior);

    const res = await authed("/bots/scout/chat/messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      sessionId: string;
      messages: Array<{ id: string; role: string; text: string; at: number | null }>;
      running: boolean;
      inflight: boolean;
    };
    expect(body.name).toBe("scout");
    expect(body.sessionId).toBe("canonical");
    expect(body.messages).toEqual([
      { id: "m1", role: "user", text: "morning", at: NOW },
      {
        id: syntheticChatId("canonical", "assistant", "morning yourself", 0),
        role: "assistant",
        text: "morning yourself",
        at: null,
      },
    ]);
    expect(body.running).toBe(false);
    expect(body.inflight).toBe(false);
    // History is read with the message bodies, unlike the pre-submit baseline read.
    expect(server.callsOf("session.resume")[0]!.params).toEqual({
      session_id: "canonical",
      profile: "scout",
      omit_messages: false,
    });
  });

  it("answers an empty history for a chat nobody has written in yet", async () => {
    // A just-created session has no row to resume, so hermes rejects. That is not an error the app
    // should see: the chat is simply empty, and it says so.
    const { behavior } = fakeBotMode({ sessions: [] });
    behavior.methods!["session.resume"] = () => {
      throw { code: 5003, message: "no such session" };
    };
    const { authed } = await setup(behavior);
    const body = (await (await authed("/bots/scout/chat/messages")).json()) as {
      messages: unknown[];
      adoption: string;
    };
    expect(body.adoption).toBe("created");
    expect(body.messages).toEqual([]);
  });

  it("passes an unknown-method rejection through verbatim", async () => {
    const { behavior } = fakeBotMode({ sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }] });
    delete behavior.methods!["session.resume"];
    const { authed } = await setup(behavior);
    const res = await authed("/bots/scout/chat/messages");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { hermesError: string };
    expect(body.hermesError).toMatch(/unknown method/i);
    expect(body.hermesError).toBe("unknown method: session.resume");
  });

  it("refuses a device-less request", async () => {
    const { behavior } = fakeBotMode();
    const { request } = await setup(behavior);
    const res = await request("/bots/scout/chat/messages", { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
});

describe("POST /bots/:name/chat/messages", () => {
  it("submits the prompt, answers 202 with the committed message, and streams the turn over /ws", async () => {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "how is CI" }];
    let running = true;
    const { behavior } = fakeBotMode({
      sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }],
      messages,
      running: () => running,
    });
    const { authed, server, frames, bridge } = await setup(behavior);

    const res = await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "how is CI" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { name: string; sessionId: string; message: { role: string; text: string } };
    expect(body).toMatchObject({ name: "scout", sessionId: "canonical", message: { role: "user", text: "how is CI" } });

    // The prompt rides the RUNTIME id the resume reported, never the stored one.
    expect(server.callsOf("prompt.submit")[0]!.params).toEqual({ session_id: "runtime-1", text: "how is CI" });

    // The reply lands mid-poll, then hermes goes idle.
    messages.push({ role: "assistant", content: "all green" });
    running = false;
    await bridge.chatSettled("scout");

    const chat = frames.filter((frame) => frame.type === "bot_chat");
    expect(chat.flatMap((frame) => (frame as { messages: Array<{ text: string }> }).messages).map((m) => m.text)).toEqual([
      "how is CI",
      "all green",
    ]);
    expect(chat[0]).toMatchObject({ type: "bot_chat", bot: "scout", sessionId: "canonical" });
    const states = frames.filter((frame) => frame.type === "bot_chat_state");
    expect(states.at(0)).toMatchObject({ phase: "polling", bot: "scout" });
    expect(states.at(-1)).toMatchObject({ phase: "complete", running: false, inflight: false });
  });

  it("rejects an empty body and an empty message", async () => {
    const { behavior } = fakeBotMode({ sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }] });
    const { authed } = await setup(behavior);
    for (const body of [undefined, JSON.stringify({}), JSON.stringify({ text: "" })]) {
      const res = await authed("/bots/scout/chat/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("requires a device, stops the live turn, completes every device, and 409s while idle", async () => {
    const { behavior } = fakeBotMode({
      sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }],
      messages: [{ role: "user", content: "loop" }],
      running: () => true,
    });
    const { authed, request, server, frames, bridge } = await setup(behavior, {
      chatPollMs: 50,
      chatTurnTimeoutMs: 1_000,
    });

    expect((await request("/bots/scout/chat/stop", { method: "POST" })).status).toBe(401);
    expect((await authed("/bots/scout/chat/stop", { method: "POST" })).status).toBe(409);
    expect(
      (
        await authed("/bots/scout/chat/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "loop" }),
        })
      ).status,
    ).toBe(202);
    expect(bridge.chatPolling("scout")).toBe(true);

    const stopped = await authed("/bots/scout/chat/stop", { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ status: "stopped" });
    expect(server.callsOf("session.interrupt").at(-1)?.params).toEqual({ session_id: "runtime-1" });
    expect(frames.filter((frame) => frame.type === "bot_chat_state").at(-1)).toMatchObject({
      phase: "complete",
      running: false,
      inflight: false,
    });
    expect((await authed("/bots/scout/chat/stop", { method: "POST" })).status).toBe(409);
  });

  it("passes a submit rejection through verbatim and starts no poll", async () => {
    const { behavior } = fakeBotMode({ sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }] });
    behavior.methods!["prompt.submit"] = () => {
      throw { code: 5007, message: "provider refused the request" };
    };
    const { authed, bridge } = await setup(behavior);
    const res = await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ hermesError: "provider refused the request" });
    expect(bridge.chatPolling("scout")).toBe(false);
  });

  it("runs one turn poll per bot however many sends arrive", async () => {
    const { behavior } = fakeBotMode({
      sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }],
      messages: [{ role: "assistant", content: "working" }],
      running: () => true,
    });
    const { authed, server, bridge } = await setup(behavior, { chatPollMs: 10, chatTurnTimeoutMs: 300 });
    const send = async (text: string): Promise<Response> =>
      authed("/bots/scout/chat/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });

    await send("one");
    const after = server.callsOf("session.resume").length;
    await Promise.all([send("two"), send("three")]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(bridge.chatPolling("scout")).toBe(true);
    // Two more baseline reads plus ONE loop's polls, not three loops'.
    expect(server.callsOf("session.resume").length - after).toBeLessThanOrEqual(12);
  });
});

describe("canonical chat duplicate adoption (wave 1 regression)", () => {
  it("resolves the first chat on the second call while the new chat is still unlisted", async () => {
    // The live failure: two consecutive GETs both answered adoption "created", with different
    // session ids, because session.create persists no row until its first prompt lands, so
    // session.list was still empty on the second call. Since capability 11 the gateway submits no
    // prompt of its own, so "still unlisted" is not a race window any more: it lasts until the user
    // writes something, and this rule is what carries the chat across it.
    const { behavior, state } = fakeBotMode({ sessions: [] });
    const { authed, server } = await setup(behavior);

    const first = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string; adoption: string };
    expect(first).toEqual({ name: "scout", sessionId: "stored-1", adoption: "created" });

    const second = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string; adoption: string };
    expect(second.sessionId).toBe("stored-1");
    expect(second.adoption).toBe("pin");
    expect(server.callsOf("session.create")).toHaveLength(1);
    expect(state.created).toBe(1);
    // The pin was pushed into ui_meta, so any other device reads it back instead of re-deriving.
    expect(state.meta?.["chat"]).toBe("stored-1");
  });

  it("still resolves the first chat when the gateway cannot store ui_meta", async () => {
    // An older gateway rejects profiles.configure as an unknown method. The pin then lives only in
    // the gateway's SQLite, and it must still survive the next open.
    const { behavior } = fakeBotMode({ sessions: [], supportsConfigure: false });
    const { authed, server, storage } = await setup(behavior);

    await authed("/bots/scout/chat");
    const second = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string; adoption: string };
    expect(second).toEqual({ name: "scout", sessionId: "stored-1", adoption: "pin" });
    expect(server.callsOf("session.create")).toHaveLength(1);
    expect(storage.botChatPin("scout")).toBe("stored-1");
  });

  it("adopts the minted session once it has persisted, without minting another", async () => {
    const { behavior, state } = fakeBotMode({ sessions: [] });
    const { authed, server, bridge } = await setup(behavior);

    await authed("/bots/scout/chat");
    // The user's first message lands: the row finally appears, carrying the canonical title.
    state.sessions = [{ id: "stored-1", title: CANONICAL_CHAT_TITLE }];
    await bridge.refresh("first message landed");

    const second = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string; adoption: string };
    expect(second.sessionId).toBe("stored-1");
    expect(server.callsOf("session.create")).toHaveLength(1);
  });

  it("sends into the chat the second call resolved, not a second one", async () => {
    const { behavior, state } = fakeBotMode({ sessions: [], messages: [{ role: "assistant", content: "hi" }] });
    const { authed, server } = await setup(behavior);

    await authed("/bots/scout/chat/messages");
    const sent = await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(((await sent.json()) as { sessionId: string }).sessionId).toBe("stored-1");
    expect(state.created).toBe(1);
    // The user's message, and ONLY the user's message. Up to capability 10 a canned opener was
    // submitted ahead of it and the app drew it as a line the user had typed.
    expect(server.callsOf("prompt.submit").map((call) => call.params["text"])).toEqual(["hello"]);
  });
});

describe("a chat with no persisted row yet (review C1/C2)", () => {
  it("answers an empty history on EVERY read of an unwritten chat, not just the first", async () => {
    // The app's own sequence: open the bot, resolve, read history. The second read resolves the
    // pin (adoption "pin", not "created"), and gating the empty-history tolerance on adoption made
    // exactly that read answer 502 for the scenario the tolerance exists for.
    const { behavior } = fakeBotMode({ sessions: [] });
    const { authed } = await setup(behavior);

    const first = await authed("/bots/scout/chat/messages");
    const second = await authed("/bots/scout/chat/messages");
    expect([first.status, second.status]).toEqual([200, 200]);
    const firstBody = (await first.json()) as { adoption: string; sessionId: string; messages: unknown[] };
    const secondBody = (await second.json()) as { adoption: string; sessionId: string; messages: unknown[] };
    expect(firstBody).toMatchObject({ adoption: "created", sessionId: "stored-1", messages: [] });
    expect(secondBody).toMatchObject({ adoption: "pin", sessionId: "stored-1", messages: [] });
  });

  it("still reports a resume failure for a chat this gateway is not holding a runtime id for", async () => {
    // A chat this gateway did not just create has no excuse: the hermes text goes through verbatim.
    // This is the arm the old 180 s window used to reach by expiry; it is now reached by the absence
    // of a durable runtime id, which is a fact about the chat rather than about the clock.
    const { behavior } = fakeBotMode({ sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }] });
    behavior.methods!["session.resume"] = () => {
      throw { code: 5003, message: "no such session" };
    };
    const { authed } = await setup(behavior);
    const res = await authed("/bots/scout/chat/messages");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ hermesError: "no such session", hermesErrorCode: 5003 });
  });

  it("submits a send into an unwritten chat against the RUNTIME id", async () => {
    // The unwritten session cannot be resumed, so the runtime id `session.create` returned is the
    // only one prompt.submit accepts. Submitting the STORED id answered 202 and lost the message.
    const { behavior, state } = fakeBotMode({ sessions: [] });
    const { authed, server } = await setup(behavior);

    await authed("/bots/scout/chat");
    const res = await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(202);
    expect(state.created).toBe(1);
    // One submit, the user's, and it is addressed at the runtime id.
    expect(server.callsOf("prompt.submit").map((call) => call.params["session_id"])).toEqual(["runtime-1"]);
  });

  it("never submits the STORED id for a send it cannot address, and heals the chat instead", async () => {
    // No runtime id anywhere: the resume fails and this gateway did not create the chat. Up to
    // issue #66 this answered 502, and kept answering 502 on every send forever, because nothing
    // ever minted a replacement for a PINNED chat. It now heals (see
    // `bots-chat-session-heal.test.ts`), and the invariant this test has always been about survives
    // the change intact: the STORED id is never what gets submitted, because a prompt aimed at it
    // is a 202 for a message that went nowhere.
    const { behavior } = fakeBotMode({ sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }] });
    behavior.methods!["session.resume"] = () => {
      throw { code: 5003, message: "no such session" };
    };
    const { authed, server } = await setup(behavior);
    const res = await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(202);
    const submitted = server.callsOf("prompt.submit").map((call) => call.params["session_id"]);
    expect(submitted).not.toContain("canonical");
    // One submit, into the chat the heal minted, addressed by its RUNTIME id.
    expect(submitted).toEqual(["runtime-1"]);
  });
});

describe("ui_meta writeback (review I2/I3)", () => {
  it("merges onto a FRESH read, so a desktop edge since the last poll survives", async () => {
    const { behavior, state } = fakeBotMode({ sessions: [] });
    const { authed, bridge } = await setup(behavior);
    await bridge.refresh("prime the cache");
    // The desktop renames the bot AFTER the cache snapshot. Building the write from that cache
    // reverted the rename; the blob is replaced whole by profiles.configure.
    state.meta = { title: "Renamed", group: "Ops" };

    await authed("/bots/scout/chat");
    expect(state.meta).toEqual({ title: "Renamed", group: "Ops", chat: "stored-1" });
  });

  it("does not resurrect a pin the desktop cleared after the snapshot", async () => {
    const { behavior, state } = fakeBotMode({
      sessions: [{ id: "sess-9", title: CANONICAL_CHAT_TITLE }],
      meta: { title: "Scout", chat: "sess-9" },
    });
    const { authed, bridge } = await setup(behavior);
    await bridge.refresh("prime the cache");
    // Compaction rewrote the lineage AND the desktop cleared the pin. The recovery re-pin must stay
    // gateway-local: the clear is authoritative (dissection 3.2), and the write path must not be a
    // second way to resurrect it.
    state.sessions = [{ id: "sess-2", title: CANONICAL_CHAT_TITLE }];
    state.meta = { title: "Scout" };

    const body = (await (await authed("/bots/scout/chat")).json()) as { adoption: string; sessionId: string };
    expect(body).toMatchObject({ adoption: "recovery", sessionId: "sess-2" });
    expect(state.meta).toEqual({ title: "Scout" });
  });

  it("strips the asset fields instead of pushing a data URL through every roster poll", async () => {
    const { behavior, state } = fakeBotMode({
      sessions: [],
      meta: { title: "Scout", image: "data:image/png;base64,AAAA", pet: "cat", custom: "<svg/>" },
    });
    const { authed } = await setup(behavior);
    await authed("/bots/scout/chat");
    expect(state.meta).toEqual({ title: "Scout", chat: "stored-1" });
  });

  it("does not read an absent pin as a CLEAR on a gateway that cannot store ui_meta (R1)", async () => {
    // The residual from the #31 verification. On a Hermes with no ui_meta support NO blob will ever
    // carry `chat`, so every roster refresh read the absent key as an authoritative clear and threw
    // the gateway-local pin away. Open the chat, refresh once, open again: before the fix that
    // second open found no pin, an empty session list (nothing has been written in the chat, so it
    // has no row), and minted a SECOND canonical chat.
    const { behavior } = fakeBotMode({ sessions: [], supportsConfigure: false });
    const { authed, server, bridge, storage } = await setup(behavior);

    const first = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string };
    expect(first.sessionId).toBe("stored-1");

    await bridge.refresh("the refresh that used to erase the pin");
    expect(storage.botChatPin("scout")).toBe("stored-1");
    // And the roster reports it too, rather than showing "no conversation" for a chat the app is in.
    expect(bridge.roster().bots.find((bot) => bot.name === "scout")?.chatSessionId).toBe("stored-1");

    const second = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string; adoption: string };
    expect(second).toMatchObject({ sessionId: "stored-1", adoption: "pin" });
    expect(server.callsOf("session.create")).toHaveLength(1);
  });

  it("honors a fresh-read clear even when the resolve saw no pin at all (R2)", async () => {
    // The other residual. `clearedSinceResolve` required the resolve to have seen a STRING pin, so
    // when it saw nothing (the profile carried no blob yet) a blob that appeared meanwhile without a
    // `chat` key was written over anyway. The fresh read is by definition newer than anything this
    // gateway holds, so the only blob it may add a pin to is one the resolve observed itself.
    const { behavior, state } = fakeBotMode({ sessions: [], meta: null });
    const create = behavior.methods!["session.create"]!;
    behavior.methods!["session.create"] = (params, ctx) => {
      const result = create(params, ctx);
      // The desktop writes the bot's look between our resolve and our writeback, and that blob
      // carries no pin.
      state.meta = { title: "Scout", color: "#8b5cf6" };
      return result;
    };
    const { authed, server } = await setup(behavior);

    await authed("/bots/scout/chat");
    expect(state.meta).toEqual({ title: "Scout", color: "#8b5cf6" });
    expect(server.callsOf("profiles.configure")).toHaveLength(0);
  });

  it("stops asking a gateway that cannot store ui_meta", async () => {
    const { behavior } = fakeBotMode({ sessions: [], supportsConfigure: false });
    const { authed, server } = await setup(behavior);
    await authed("/bots/scout/chat");
    await authed("/bots/scout/chat");
    await authed("/bots/scout/chat");
    // One rejected attempt, then the bridge keeps the pin gateway-local instead of firing a
    // configure on every chat open forever.
    expect(server.callsOf("profiles.configure")).toHaveLength(1);
  });
});

describe("what reaches the phone (review I6/I9)", () => {
  it("keeps system and tool rows, and blank tool-only turns, out of the history", async () => {
    const { behavior } = fakeBotMode({
      sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }],
      messages: [
        { role: "system", content: "you are a bot" },
        { role: "assistant", content: [{ type: "tool_use", name: "read" }] },
        { role: "tool", content: "file1\nfile2" },
        { role: "user", content: "what did you find" },
        { role: "assistant", content: "done" },
      ],
    });
    const { authed } = await setup(behavior);
    const body = (await (await authed("/bots/scout/chat/messages")).json()) as {
      messages: Array<{ role: string; text: string }>;
    };
    expect(body.messages).toEqual([
      { id: syntheticChatId("canonical", "user", "what did you find", 0), role: "user", text: "what did you find", at: null },
      { id: syntheticChatId("canonical", "assistant", "done", 0), role: "assistant", text: "done", at: null },
    ]);
  });

  it("echoes the sender's clientId back on the message when the poll finds it", async () => {
    const messages: Array<Record<string, unknown>> = [];
    let running = true;
    const { behavior } = fakeBotMode({
      sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }],
      messages,
      running: () => running,
    });
    const { authed, frames, bridge } = await setup(behavior);

    const res = await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "how is CI", clientId: "phone-7" }),
    });
    const body = (await res.json()) as { message: { id: string; clientId?: string } };
    expect(body.message.clientId).toBe("phone-7");

    // The same message comes back with hermes' own id, which is why the id alone can never dedupe.
    messages.push({ id: "m-real", role: "user", content: "how is CI" });
    messages.push({ id: "m-reply", role: "assistant", content: "all green" });
    running = false;
    await bridge.chatSettled("scout");

    const delivered = frames
      .filter((frame) => frame.type === "bot_chat")
      .flatMap((frame) => (frame as { messages: Array<{ id: string; clientId?: string }> }).messages);
    expect(delivered.find((message) => message.id === "m-real")?.clientId).toBe("phone-7");
    expect(delivered.find((message) => message.id === "m-reply")?.clientId).toBeUndefined();
  });
});

describe("bot_chat_delta", () => {
  /** The live draft, end to end: a real bridge holding a real socket to the fake Hermes, which
   *  emits the token events a real Hermes 0.20.3 emits (`message.start`, one `message.delta` per
   *  token, `message.complete` with the whole reply), interleaved with the `thinking.delta` and
   *  `reasoning.delta` frames that ride the same socket. */

  type DeltaFrame = Extract<ServerFrame, { type: "bot_chat_delta" }>;
  const deltasOf = (frames: ServerFrame[]): DeltaFrame[] =>
    frames.filter((frame): frame is DeltaFrame => frame.type === "bot_chat_delta");

  async function sendAndStream(
    frames: ServerFrame[],
    authed: Harness["authed"],
    server: FakeHermesServer,
    stream: Parameters<FakeHermesServer["streamMessage"]>[1],
  ): Promise<void> {
    await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "how is CI" }),
    });
    await until(() => server.callsOf("prompt.submit").length === 1);
    server.streamMessage("runtime-1", stream);
    await until(() => deltasOf(frames).some((frame) => frame.done === true), 4_000);
  }

  it("turns the hermes token stream into a growing draft, and the poll still delivers the reply", async () => {
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "how is CI" }];
    let running = true;
    const { behavior } = fakeBotMode({
      sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }],
      messages,
      running: () => running,
    });
    const { authed, frames, server, bridge } = await setup(behavior);

    await sendAndStream(frames, authed, server, {
      deltas: ["all", " green", " on", " main"],
      thinking: ["( \u2022_\u2022)>\u2310\u25a0-\u25a0 cogitating..."],
      reasoning: ["the user is asking about CI, the last run passed"],
    });

    const drafts = deltasOf(frames);
    expect(drafts.length).toBeGreaterThan(0);
    // Every frame names the bot and the STORED session id, carries the full text so far, and the
    // text only ever grows.
    for (const frame of drafts) expect(frame).toMatchObject({ bot: "scout", sessionId: "canonical" });
    const texts = drafts.map((frame) => frame.text);
    for (let index = 1; index < texts.length; index += 1) {
      expect(texts[index]!.startsWith(texts[index - 1]!)).toBe(true);
    }
    expect(drafts.map((frame) => frame.seq)).toEqual(drafts.map((_, index) => index + 1));
    expect(new Set(drafts.map((frame) => frame.turnId)).size).toBe(1);
    expect(drafts.at(-1)).toMatchObject({ text: "all green on main", done: true });

    // Nothing from the reasoning family reached the wire, on any frame.
    const rendered = JSON.stringify(frames);
    expect(rendered).not.toContain("cogitating");
    expect(rendered).not.toContain("asking about CI");

    // And the draft changed nothing about how the reply is delivered: the poll finds the canonical
    // message and broadcasts it, which is still the only thing a client stores.
    messages.push({ id: "m-reply", role: "assistant", content: "all green on main" });
    running = false;
    await bridge.chatSettled("scout");
    const delivered = frames
      .filter((frame) => frame.type === "bot_chat")
      .flatMap((frame) => (frame as { messages: Array<{ id: string; text: string }> }).messages);
    expect(delivered.find((message) => message.id === "m-reply")?.text).toBe("all green on main");
  });

  it("keeps the draft out of a second turn on the same session", async () => {
    const messages: Array<Record<string, unknown>> = [];
    let running = true;
    const { behavior } = fakeBotMode({
      sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }],
      messages,
      running: () => running,
    });
    const { authed, frames, server } = await setup(behavior);

    await sendAndStream(frames, authed, server, { deltas: ["first reply"] });
    const firstTurn = deltasOf(frames).at(-1)!.turnId;
    frames.length = 0;

    await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "and now" }),
    });
    await until(() => server.callsOf("prompt.submit").length === 2);
    server.streamMessage("runtime-1", { deltas: ["second reply"] });
    await until(() => deltasOf(frames).some((frame) => frame.done === true), 4_000);

    const second = deltasOf(frames).at(-1)!;
    // A Hermes session id is reused across turns; a turn id is not, which is what invalidates the
    // previous draft on a client instead of appending to it.
    expect(second.turnId).not.toBe(firstTurn);
    expect(second.text).toBe("second reply");
    // Seq restarts with the turn, which is why a client compares it only within one turnId.
    expect(deltasOf(frames)[0]!.seq).toBe(1);
  });

  it("stays silent for a session this gateway never submitted into", async () => {
    const { behavior } = fakeBotMode({ sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }] });
    const { frames, server } = await setup(behavior);

    // What a Hermes desktop's own session looks like from here: events for a session id the bridge
    // has no binding for. They are somebody else's turn and produce nothing.
    server.streamMessage("runtime-someone-else", { deltas: ["not ours"] });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(deltasOf(frames)).toHaveLength(0);
  });

  it("advertises the streaming capability version", () => {
    // A client gates its draft rendering on >= 6; everything else about the bots surface is
    // unchanged, so an older client simply ignores an unknown frame type. The advertised number has
    // moved past it (7 added the media proxy, 8 the chat reset, 9 photos to bots, 10 approve/deny,
    // 11 the empty fresh chat and its suggestion), which is exactly why a client compares `>=`.
    expect(BOTS_CAPABILITY_VERSION).toBeGreaterThanOrEqual(6);
  });
});

describe("scheduled assistant push seam (cozygateway#119)", () => {
  it("raises a settled message for an unbound cron session", async () => {
    const sessionId = "cron_job7_1755600000";
    const messages = [{ id: "cron-a1", role: "assistant", content: "scheduled digest" }];
    const { behavior } = fakeBotMode({
      sessions: [{ id: sessionId, title: "Nightly digest · Aug 20 03:00", source: "cron" }],
      messages,
    });
    const events: Array<{
      bot: string;
      displayName: string;
      messageId: string;
      chatSessionId: string;
      preview: string;
    }> = [];
    const { server } = await setup(behavior, { onChatMessage: (event) => events.push(event) });

    // Scheduler-originated work was not submitted through CozyChat, so its runtime session has no
    // BotChatStream binding. The bridge still has to resolve the settled session and raise push.
    server.streamMessage("runtime-1", { deltas: ["scheduled digest"] });
    await until(() => events.length > 0, 1_000);

    expect(events).toEqual([
      {
        bot: "scout",
        displayName: "Scout",
        messageId: "cron-a1",
        chatSessionId: sessionId,
        preview: "scheduled digest",
      },
    ]);

    // A replayed completion (Hermes reconnects can replay event edges) must not produce a second
    // push for the same persisted assistant row.
    server.streamMessage("runtime-1", { deltas: ["scheduled digest"] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toHaveLength(1);
  });

  it.each([
    { title: CANONICAL_CHAT_TITLE },
    { title: "Group: Release Room" },
    { title: "handoff", preview: "Message from agent 'scout': scheduled digest" },
  ])("does not raise an unbound $title session", async (session) => {
    const { behavior } = fakeBotMode({
      sessions: [{ id: "other-1", ...session }],
      messages: [{ id: "other-a1", role: "assistant", content: "scheduled digest" }],
    });
    const events: unknown[] = [];
    const { server } = await setup(behavior, { onChatMessage: (event) => events.push(event) });

    server.streamMessage("runtime-1", { deltas: ["scheduled digest"] });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(events).toHaveLength(0);
    expect(server.callsOf("session.resume")).toHaveLength(0);
  });

  it("retries until the completed cron row becomes listable", async () => {
    const messages = [{ id: "late-a1", role: "assistant", content: "late digest" }];
    const { behavior, state } = fakeBotMode({ messages });
    const events: Array<{ messageId: string }> = [];
    const { server } = await setup(behavior, { onChatMessage: (event) => events.push(event) });

    server.streamMessage("runtime-late", { deltas: ["late digest"] });
    setTimeout(() => {
      state.sessions.push({ id: "cron_late_1755600000", title: "Late digest", source: "cron" });
      state.runtime.set("cron_late_1755600000", "runtime-late");
    }, 25);

    await until(() => events.length === 1, 1_000);
    expect(events.map((event) => event.messageId)).toEqual(["late-a1"]);
  });
});

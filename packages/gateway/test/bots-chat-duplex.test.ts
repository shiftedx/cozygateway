import { afterEach, describe, expect, it } from "vitest";
import type { Message, RichBlock, ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
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
  overrides: { chatPollMs?: number; chatTurnTimeoutMs?: number } = {},
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
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 1 } },
    presenceOf: () => "online",
    submitUserMessage: (threadId: string, blocks: RichBlock[]): Message =>
      storage.appendMessage(threadId, { role: "user", blocks }, 500),
    interruptThread: () => "idle",
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

/** A Hermes whose bot has one canonical chat with a growing message list, and which stores what
 *  `profiles.configure` writes so the roster reflects it, exactly as the real gateway does. */
function fakeBotMode(options: {
  /** Sessions `session.list` reports. Empty models a chat whose kickoff has not landed yet. */
  sessions?: Array<{ id: string; title: string }>;
  messages?: Array<Record<string, unknown>>;
  running?: () => boolean;
  /** Omit to make `profiles.configure` an unknown method, which is what an old gateway does. */
  supportsConfigure?: boolean;
} = {}): { behavior: FakeHermesBehavior; state: { meta: Record<string, unknown>; sessions: Array<{ id: string; title: string }>; created: number } } {
  const state = {
    meta: { title: "Scout" } as Record<string, unknown>,
    sessions: options.sessions ?? [],
    created: 0,
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
            ui_meta: { "hermes-bots": state.meta },
          },
        ],
        bot_mode_protocol: true,
      }),
      "session.list": () => ({ sessions: state.sessions }),
      "session.create": () => {
        state.created += 1;
        // Deliberately persists NOTHING: the row only appears once the kickoff prompt lands, which
        // is the real gateway's behavior and the whole reason the duplicate bug existed.
        return { stored_session_id: `stored-${state.created}`, session_id: `runtime-${state.created}` };
      },
      "prompt.submit": () => ({ ok: true }),
      "session.resume": (params) => ({
        session_id: "runtime-1",
        session_key: "k",
        message_count: (options.messages ?? []).length,
        running: options.running?.() ?? false,
        inflight: false,
        ...(params["omit_messages"] === true ? {} : { messages: options.messages ?? [] }),
      }),
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
      { id: "canonical#1", role: "assistant", text: "morning yourself", at: null },
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

  it("answers an empty history for a chat whose kickoff has not landed yet", async () => {
    // A just-created session has no row to resume, so hermes rejects. That is not an error the app
    // should see: the messages arrive over bot_chat frames moments later.
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
  it("resolves the first chat on the second call while the kickoff is still in flight", async () => {
    // The live failure: two consecutive GETs both answered adoption "created", with different
    // session ids, because session.create persists no row until its first prompt lands, so
    // session.list was still empty on the second call.
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
    expect(state.meta["chat"]).toBe("stored-1");
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

  it("adopts the kickoff's session once it has persisted, without minting another", async () => {
    const { behavior, state } = fakeBotMode({ sessions: [] });
    const { authed, server, bridge } = await setup(behavior);

    await authed("/bots/scout/chat");
    // The kickoff lands: the row finally appears, carrying the canonical title.
    state.sessions = [{ id: "stored-1", title: CANONICAL_CHAT_TITLE }];
    await bridge.refresh("kickoff landed");

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
    // The kickoff and the user message, in that order, both on the same session.
    expect(server.callsOf("prompt.submit").map((call) => call.params["text"])).toEqual([
      "Hey, tell me about yourself!",
      "hello",
    ]);
  });
});

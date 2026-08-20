import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { BOT_CHAT_RETIRED_LIMIT, openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { CANONICAL_CHAT_TITLE, resolveCanonicalChat, type PinStore } from "../src/hermes-bridge/canonical-chat.ts";
import {
  startFakeHermesServer,
  type FakeHermesBehavior,
  type FakeHermesServer,
} from "./support/fake-hermes-server.ts";

/** `POST /bots/:name/chat/reset` (contract/ext-bots-v1.md section 4, capability 8): retire the
 *  canonical Bot Chat and pin a fresh one.
 *
 *  The property most worth pinning here is the one the route's name oversells. Hermes has no session
 *  delete on this surface, so a reset DELETES NOTHING: the retired session stays on the Hermes host
 *  and stays listable. One of these tests asserts exactly that, on the recorded RPC calls, because a
 *  future refactor that "helpfully" started deleting sessions would destroy transcripts a user
 *  believed were only being set aside. */

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
}

async function setup(behavior: FakeHermesBehavior = {}): Promise<Harness> {
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
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => NOW,
    logSink: () => {},
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 8 } },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("not used");
    },
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
  const authed = async (path: string, init?: RequestInit): Promise<Response> =>
    app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
    });

  bridge.start();
  await until(() => client.state() === "online", 4_000);
  return { server, bridge, client, storage, frames, authed };
}

const scoutRow = {
  name: "scout",
  description: "watches CI",
  has_avatar: false,
  ui_meta: { "hermes-bots": { title: "Scout" } },
};

function profiles(): Record<string, unknown> {
  return { profiles: [scoutRow], bot_mode_protocol: true };
}

/** A Hermes that already holds one canonical chat (`sess-1`) and mints `stored-2` / `runtime-2` for
 *  the next `session.create`. The session list NEVER loses `sess-1`, which is the point: a reset
 *  does not remove it. */
function withOneChat(extra: FakeHermesBehavior["methods"] = {}): FakeHermesBehavior {
  return {
    methods: {
      "profiles.list": () => profiles(),
      "session.list": () => ({ sessions: [{ id: "sess-1", title: CANONICAL_CHAT_TITLE }] }),
      "session.create": () => ({ stored_session_id: "stored-2", session_id: "runtime-2" }),
      "prompt.submit": () => ({ ok: true }),
      "profiles.configure": () => ({ applied: { ui_meta: true } }),
      ...extra,
    },
  };
}

describe("POST /bots/:name/chat/reset", () => {
  it("retires the current chat and pins a newly minted one", async () => {
    const { authed, bridge, storage } = await setup(withOneChat());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    // The chat that is about to be retired, resolved the way the app resolves it.
    expect(((await (await authed("/bots/scout/chat")).json()) as { sessionId: string }).sessionId).toBe("sess-1");

    const res = await authed("/bots/scout/chat/reset", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "scout",
      sessionId: "stored-2",
      previousSessionId: "sess-1",
    });

    // The pin is the new STORED id, both in this gateway's own record and on the next resolve.
    expect(storage.botChatPin("scout")).toBe("stored-2");
  });

  it("deletes nothing: the retired session is never removed from hermes", async () => {
    const { authed, bridge, server } = await setup(withOneChat());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    expect((await authed("/bots/scout/chat/reset", { method: "POST" })).status).toBe(200);

    // Hermes exposes no session delete on this surface and the reset must not invent one. Asserted
    // on the METHOD NAMES that actually went on the wire rather than on a specific spelling, so a
    // delete introduced under any of the plausible names fails this test.
    const spoken = new Set(server.calls().map((call) => call.method));
    for (const method of spoken) expect(method).not.toMatch(/delete|remove|destroy|purge/i);

    // And it is still listed, which is what `GET /bots/:name/sessions` reports to a client.
    const sessions = (await (await authed("/bots/scout/sessions")).json()) as {
      sessions: Array<{ id: string }>;
    };
    expect(sessions.sessions.map((row) => row.id)).toContain("sess-1");
  });

  it("mints the new chat with the canonical title and says nothing in it", async () => {
    const { authed, bridge, server, storage } = await setup(withOneChat());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    expect((await authed("/bots/scout/chat/reset", { method: "POST" })).status).toBe(200);

    const create = server.callsOf("session.create");
    expect(create).toHaveLength(1);
    expect(create[0]!.params).toEqual({ profile: "scout", title: CANONICAL_CHAT_TITLE, hidden: true });
    // Capability 11: the replacement chat is EMPTY. Up to 10 the reset submitted a canned opener
    // here, so "clear chat" handed the user back a chat that already had an exchange in it -- one
    // half of which was attributed to them.
    expect(server.callsOf("prompt.submit")).toHaveLength(0);
    // Which makes the replacement unresumable until the user writes in it, so the reset writes down
    // the RUNTIME id the same way the resolve path does. `prompt.submit` accepts nothing else, and
    // it has to outlive this process: the chat can sit untouched indefinitely now.
    // Stamped with the link generation that minted it (issue #66): the send path compares that stamp
    // before it trusts the id, so a reset that wrote none would leave the replacement unaddressable.
    expect(storage.botChatRuntimeId("scout", "stored-2", bridge.linkGeneration())).toBe("runtime-2");
  });

  it("cancels the live turn poll belonging to the retired chat", async () => {
    const { authed, bridge, frames } = await setup(
      withOneChat({
        "session.resume": () => ({
          session_id: "runtime-1",
          session_key: "k",
          message_count: 0,
          running: true,
          inflight: false,
          messages: [],
        }),
      }),
    );
    await until(() => bridge.roster().bots.length === 1, 4_000);

    expect(
      (
        await authed("/bots/scout/chat/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi" }),
        })
      ).status,
    ).toBe(202);
    await until(() => bridge.chatPolling("scout"), 4_000);

    expect((await authed("/bots/scout/chat/reset", { method: "POST" })).status).toBe(200);
    expect(bridge.chatPolling("scout")).toBe(false);
    await bridge.chatSettled("scout");

    // A poll left running would keep broadcasting for a chat nobody is in any more.
    const chatFrames = (): number =>
      frames.filter((frame) => frame.type === "bot_chat" || frame.type === "bot_chat_state").length;
    const before = chatFrames();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(chatFrames()).toBe(before);
  });

  it("broadcasts bot_chat_reset carrying both ids", async () => {
    const { authed, bridge, frames } = await setup(withOneChat());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    expect((await authed("/bots/scout/chat/reset", { method: "POST" })).status).toBe(200);

    const reset = frames.find((frame) => frame.type === "bot_chat_reset");
    expect(reset).toEqual({
      type: "bot_chat_reset",
      bot: "scout",
      sessionId: "stored-2",
      previousSessionId: "sess-1",
      updatedAt: NOW,
    });
  });

  it("records the retired session so no later adoption can pick it up", async () => {
    const { authed, bridge, storage } = await setup(withOneChat());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    expect((await authed("/bots/scout/chat/reset", { method: "POST" })).status).toBe(200);

    // The durable half of the guard. The in-memory half would be useless: the hazard this defends
    // against IS a restart, because that is when the pin can go missing.
    expect(storage.botChatRetired("scout").has("sess-1")).toBe(true);
  });

  it("answers 404 for a name that is not a hermes profile at all", async () => {
    const { authed, bridge } = await setup(withOneChat());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    const res = await authed("/bots/ghost/chat/reset", { method: "POST" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    // The 404 arm must come before anything mints, or the reset would create the very profile it
    // was asked about (Hermes 0.20.x auto-creates one on `session.create`).
  });
});

/** A Hermes whose session list GROWS: every `session.create` adds the new chat to the list, exactly
 *  as a real host does once something is written in the chat. That is what lets these tests reach the state the
 *  reset actually produces, a bot holding SEVERAL sessions all titled `Bot Chat`, which is the state
 *  the adoption heuristics cannot read.
 *
 *  `insert` places the new chat at the front or the BACK of the list. The back is not a contrivance:
 *  `session.list` carries no timestamp at all on this surface, so "newest first" is a convention the
 *  gateway observes and cannot verify, and a host that answers in any other order is within its
 *  rights. Back-inserting is simply that host. */
function withGrowingChats(state: {
  sessions: Array<{ id: string; title: string }>;
  insert: "front" | "back";
}): FakeHermesBehavior {
  let next = 2;
  return {
    methods: {
      "profiles.list": () => profiles(),
      "session.list": () => ({ sessions: state.sessions.map((row) => ({ ...row })) }),
      "session.create": () => {
        const stored = `stored-${next}`;
        const runtime = `runtime-${next}`;
        next += 1;
        const row = { id: stored, title: CANONICAL_CHAT_TITLE };
        if (state.insert === "front") state.sessions.unshift(row);
        else state.sessions.push(row);
        return { stored_session_id: stored, session_id: runtime };
      },
      "prompt.submit": () => ({ ok: true }),
      "profiles.configure": () => ({ applied: { ui_meta: true } }),
    },
  };
}

function pinStore(initial: Record<string, string> = {}): PinStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: (name) => map.get(name),
    set: (name, sessionId) => void map.set(name, sessionId),
    clear: (name) => void map.delete(name),
  };
}

/** The hazard the reset opens and the retired set closes.
 *
 *  A reset mints the replacement with the SAME title as the chat it retires, deliberately, so the two
 *  are byte-compatible. The consequence is that after a reset the bot has two sessions titled
 *  `Bot Chat` and only the pin says which one the user is in. The pin is losable: pushing it to
 *  `ui_meta` is never allowed to fail a reset, so a gateway that cannot store it keeps the pin local
 *  and a restart can arrive with nothing. What then decides is a title match or a list position,
 *  neither of which knows anything about which chat the user cleared, and the wrong answer hands back
 *  the conversation they asked to be rid of. */
describe("chat reset: a retired chat is never adopted again", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("does not resurrect the retired chat when the pin is lost and the retired one sorts FIRST", async () => {
    const state = { sessions: [{ id: "sess-1", title: CANONICAL_CHAT_TITLE }], insert: "back" as const };
    const { authed, bridge, storage } = await setup(withGrowingChats(state));
    await until(() => bridge.roster().bots.length === 1, 4_000);

    const reset = (await (await authed("/bots/scout/chat/reset", { method: "POST" })).json()) as {
      sessionId: string;
      previousSessionId?: string;
    };
    expect(reset).toEqual({ name: "scout", sessionId: "stored-2", previousSessionId: "sess-1" });
    // Both chats are on the host, both titled `Bot Chat`, the retired one first.
    expect(state.sessions.map((row) => row.id)).toEqual(["sess-1", "stored-2"]);

    // The pin goes missing, which is the whole scenario: a restart on a gateway whose `ui_meta`
    // writeback never landed has exactly this state.
    storage.clearBotChatPin("scout");

    const chat = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string };
    expect(chat.sessionId).toBe("stored-2");
    // Said the other way round, because this is the assertion that matters: the cleared conversation
    // does not come back.
    expect(chat.sessionId).not.toBe("sess-1");
  });

  it("does not resurrect the retired chat when the PIN ITSELF names it (review G5: stale server pin)", async () => {
    const state = { sessions: [{ id: "sess-1", title: CANONICAL_CHAT_TITLE }], insert: "back" as const };
    const { authed, bridge, storage } = await setup(withGrowingChats(state));
    await until(() => bridge.roster().bots.length === 1, 4_000);

    const reset = (await (await authed("/bots/scout/chat/reset", { method: "POST" })).json()) as {
      sessionId: string;
    };
    expect(reset.sessionId).toBe("stored-2");

    // The stale-pin shape: `saveServerPin` failed silently after the reset, so the pin still names
    // the RETIRED session, which is listed. Honoring it would be the cleared conversation back.
    storage.setBotChatPin("scout", "sess-1", Date.now());

    const chat = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string };
    expect(chat.sessionId).toBe("stored-2");
    expect(chat.sessionId).not.toBe("sess-1");
  });

  it("does not resurrect it across TWO resets either, with every retired chat ahead of the live one", async () => {
    const state = { sessions: [{ id: "sess-1", title: CANONICAL_CHAT_TITLE }], insert: "back" as const };
    const { authed, bridge, storage } = await setup(withGrowingChats(state));
    await until(() => bridge.roster().bots.length === 1, 4_000);

    expect((await authed("/bots/scout/chat/reset", { method: "POST" })).status).toBe(200);
    expect((await authed("/bots/scout/chat/reset", { method: "POST" })).status).toBe(200);
    expect(state.sessions.map((row) => row.id)).toEqual(["sess-1", "stored-2", "stored-3"]);

    storage.clearBotChatPin("scout");

    const chat = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string };
    expect(chat.sessionId).toBe("stored-3");
  });

  it("skips a retired row 0 on the RECOVERY path, where the pin names a session that is gone", async () => {
    // The recovery path is the one that trusts position outright: it re-pins `rows[0]`. Reached here
    // the way it is reached in life, by a pin naming a session compaction rewrote away.
    const pins = pinStore();
    const rows = {
      sessions: [
        { id: "sess-1", title: CANONICAL_CHAT_TITLE },
        { id: "stored-2", title: CANONICAL_CHAT_TITLE },
      ],
    };
    const result = await resolveCanonicalChat("scout", {
      rpc: {
        request: async (method: string) =>
          method === "session.list" ? rows : Promise.reject(new Error(`unexpected method ${method}`)),
      },
      pins,
      hideBotChats: true,
      serverPin: "compacted-away",
      isRetired: (sessionId) => sessionId === "sess-1",
    });
    expect(result).toEqual({ sessionId: "stored-2", adoption: "recovery" });
    expect(pins.map.get("scout")).toBe("stored-2");
  });

  it("mints a fresh chat when EVERY candidate is retired and there is no pin, and does not mint again", async () => {
    const pins = pinStore();
    const rows = { sessions: [{ id: "sess-1", title: CANONICAL_CHAT_TITLE }] };
    const creates: unknown[] = [];
    const rpc = {
      request: async (method: string, params?: unknown) => {
        if (method === "session.list") return rows;
        if (method === "session.create") {
          creates.push(params);
          return { stored_session_id: "stored-2", session_id: "runtime-2" };
        }
        if (method === "prompt.submit") return { ok: true };
        throw new Error(`unexpected method ${method}`);
      },
    };
    const deps = {
      rpc,
      pins,
      hideBotChats: true,
      serverPin: null,
      isRetired: (sessionId: string) => sessionId === "sess-1",
    };

    const first = await resolveCanonicalChat("scout", deps);
    expect(first).toEqual({ sessionId: "stored-2", adoption: "created", runtimeId: "runtime-2" });
    expect(creates).toHaveLength(1);

    // The second open happens while the minted chat still has no row: nobody has written in it, so
    // `session.list` still returns only the retired row and the pin names something not in it. That
    // is the recovery path with no acceptable candidate, and minting there would spawn a chat on
    // EVERY open until the user finally typed. The pin is honored instead.
    const second = await resolveCanonicalChat("scout", { ...deps, serverPin: undefined });
    expect(second).toEqual({ sessionId: "stored-2", adoption: "pin" });
    expect(creates).toHaveLength(1);
  });

  it("keeps the retired set across a storage round trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "cozygateway-retired-"));
    dirs.push(dir);
    const path = join(dir, "gw.db");

    const first = openStorage(path);
    first.retireBotChat("scout", "sess-1", 10);
    first.close();

    // Re-opened, the way a restarted gateway opens it. An in-memory set would have been empty here,
    // and empty here is exactly where the retired chat gets adopted back.
    const second = openStorage(path);
    try {
      expect(second.botChatRetired("scout").has("sess-1")).toBe(true);
    } finally {
      second.close();
    }
  });

  it("bounds the retired set per bot and forgets it with the bot", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);

    for (let i = 0; i < BOT_CHAT_RETIRED_LIMIT + 10; i += 1) {
      storage.retireBotChat("scout", `sess-${i}`, 1_000 + i);
    }
    const retired = storage.botChatRetired("scout");
    expect(retired.size).toBe(BOT_CHAT_RETIRED_LIMIT);
    // The newest survive and the oldest are dropped: an id old enough to fall off both the bound and
    // `session.list` cannot be adopted anyway.
    expect(retired.has(`sess-${BOT_CHAT_RETIRED_LIMIT + 9}`)).toBe(true);
    expect(retired.has("sess-0")).toBe(false);

    // Re-retiring an id already in the set refreshes it rather than duplicating it, so a repeat
    // cannot push the newest entries out.
    storage.retireBotChat("scout", `sess-${BOT_CHAT_RETIRED_LIMIT + 9}`, 9_999);
    expect(storage.botChatRetired("scout").size).toBe(BOT_CHAT_RETIRED_LIMIT);

    // Another bot's rows are its own.
    storage.retireBotChat("pixel", "px-1", 1);
    storage.forgetBot("scout");
    expect(storage.botChatRetired("scout").size).toBe(0);
    expect(storage.botChatRetired("pixel").has("px-1")).toBe(true);
  });
});

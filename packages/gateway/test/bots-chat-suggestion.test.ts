import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { CANONICAL_CHAT_TITLE, DEFAULT_CHAT_SUGGESTION } from "../src/hermes-bridge/canonical-chat.ts";
import { CHAT_TURN_TIMEOUT_MS } from "../src/hermes-bridge/chat-turns.ts";
import {
  startFakeHermesServer,
  type FakeHermesBehavior,
  type FakeHermesServer,
} from "./support/fake-hermes-server.ts";

/** Capability 11 (issue #59): a fresh bot chat is BORN EMPTY, and the canned opener is a
 *  presentation-only SUGGESTION the client may offer.
 *
 *  The rule this file exists to pin is a product ruling, not an implementation detail: the user's
 *  own input is the only thing that is ever submitted in a conversation. Before capability 11 both
 *  fresh-chat paths (the resolve that mints, and the reset that mints a replacement) submitted a
 *  canned kickoff prompt on the user's behalf, and the app rendered the result as a message the USER
 *  had sent. Nothing here may reintroduce that, so the assertions are on `prompt.submit` actually
 *  reaching the wire, never on a flag.
 *
 *  The second half is what removing the auto-submit costs. Hermes persists NO row for a session
 *  until its first prompt, so a chat nobody has written to is unresumable for as long as it stays
 *  unwritten-to -- which is now unbounded, where before it was the few seconds a kickoff took. The
 *  old tolerance was a 180 s window keyed on a timer and held in memory; both of those are wrong
 *  now, and the two tests at the foot of this file are the ones that say so. */

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
  /** Moves the bridge's clock forward. The suggestion path has no timer left, and this is how the
   *  test that says so proves it. */
  advance: (ms: number) => void;
}

async function setup(
  behavior: FakeHermesBehavior = {},
  overrides: { chatSuggestion?: string } = {},
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
  // A clock that ticks once per read, exactly as `bots-chat-duplex.test.ts` does: the ORDER of the
  // pin write and the roster snapshot is what tells a pin this gateway just wrote from one the
  // cached roster has already had a chance to see, and a frozen clock makes every pin look stale.
  let clock = NOW;
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => (clock += 1),
    logSink: () => {},
    ...(overrides.chatSuggestion === undefined ? {} : { chatSuggestion: overrides.chatSuggestion }),
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 11 } },
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
  return { server, bridge, client, storage, frames, authed, advance: (ms) => (clock += ms) };
}

/** The `ui_meta["hermes-bots"]` blob a fake profile carries, WRITEABLE, because the gateway pushes
 *  the pin back into it and reads it again on the next open. A fake that forgets the write reads as
 *  an authoritative "the pin is cleared" on every refresh, which sends every open down the mint arm
 *  and hides exactly the once-minted-then-untouched state these tests are about. */
function profilesList(meta: () => Record<string, unknown>): () => Record<string, unknown> {
  return () => ({
    profiles: [{ name: "scout", description: "watches CI", has_avatar: false, ui_meta: { "hermes-bots": meta() } }],
    bot_mode_protocol: true,
  });
}

function configureInto(state: { meta: Record<string, unknown> }): (params: Record<string, unknown>) => unknown {
  return (params) => {
    const uiMeta = params["ui_meta"] as Record<string, unknown> | undefined;
    const blob = uiMeta?.["hermes-bots"];
    if (typeof blob === "object" && blob !== null) state.meta = blob as Record<string, unknown>;
    return { applied: { ui_meta: true } };
  };
}

/** A Hermes with a profile and NO sessions at all: the state that makes the next open mint. Every
 *  `session.create` mints an unresumable session, exactly as the real host does, because nothing
 *  here ever submits a prompt to persist it. */
function withNoChats(extra: FakeHermesBehavior["methods"] = {}): FakeHermesBehavior {
  const state = { meta: { title: "Scout" } as Record<string, unknown> };
  let created = 0;
  return {
    methods: {
      "profiles.list": profilesList(() => state.meta),
      "session.list": () => ({ sessions: [] }),
      "session.create": () => {
        created += 1;
        return { stored_session_id: `stored-${created}`, session_id: `runtime-${created}` };
      },
      "session.resume": () => {
        throw { code: 5003, message: "no such session" };
      },
      "prompt.submit": () => ({ ok: true }),
      "profiles.configure": configureInto(state),
      ...extra,
    },
  };
}

/** A Hermes holding one canonical chat the user has already written in. */
function withOneChat(extra: FakeHermesBehavior["methods"] = {}): FakeHermesBehavior {
  const state = { meta: { title: "Scout", chat: "sess-1" } as Record<string, unknown> };
  return {
    methods: {
      "profiles.list": profilesList(() => state.meta),
      "session.list": () => ({ sessions: [{ id: "sess-1", title: CANONICAL_CHAT_TITLE }] }),
      "session.create": () => ({ stored_session_id: "stored-2", session_id: "runtime-2" }),
      "session.resume": (params) => {
        if (String(params["session_id"] ?? "") !== "sess-1") throw { code: 5003, message: "no such session" };
        return {
          session_id: "runtime-1",
          session_key: "k",
          message_count: 1,
          running: false,
          inflight: false,
          ...(params["omit_messages"] === true ? {} : { messages: [{ id: "m1", role: "user", content: "morning" }] }),
        };
      },
      "prompt.submit": () => ({ ok: true }),
      "profiles.configure": configureInto(state),
      ...extra,
    },
  };
}

describe("a fresh bot chat submits nothing", () => {
  it("mints the canonical chat WITHOUT a prompt when a bot is opened for the first time", async () => {
    const { authed, bridge, server } = await setup(withNoChats());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    const body = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string; adoption: string };
    expect(body.adoption).toBe("created");
    expect(body.sessionId).toBe("stored-1");

    // The chat exists and is pinned; nothing was said in it. Asserted on the wire, because a bot
    // answering an opener nobody typed is the exact bug capability 11 removes.
    expect(server.callsOf("session.create")).toHaveLength(1);
    expect(server.callsOf("prompt.submit")).toHaveLength(0);
  });

  it("mints the RESET replacement without a prompt either", async () => {
    const { authed, bridge, server } = await setup(withOneChat());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    const res = await authed("/bots/scout/chat/reset", { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sessionId: string }).sessionId).toBe("stored-2");

    expect(server.callsOf("session.create")).toHaveLength(1);
    // The reset is the second fresh-chat path, and it minted through the same helper, so a kickoff
    // left on either one would come back on both.
    expect(server.callsOf("prompt.submit")).toHaveLength(0);
  });
});

describe("the suggestion on GET /bots/:name/chat/messages", () => {
  it("carries the suggestion while the transcript is empty", async () => {
    const { authed, bridge } = await setup(withNoChats());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    const res = await authed("/bots/scout/chat/messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[]; suggestion?: string };
    expect(body.messages).toEqual([]);
    // The literal, not just the constant: the text is the desktop opener the gateway used to submit
    // on the user's behalf, kept word for word so the phone offers what a returning user recognizes.
    expect(DEFAULT_CHAT_SUGGESTION).toBe("Hey, tell me about yourself!");
    expect(body.suggestion).toBe(DEFAULT_CHAT_SUGGESTION);
  });

  it("drops the suggestion once the transcript holds anything at all", async () => {
    const { authed, bridge } = await setup(withOneChat());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    const body = (await (await authed("/bots/scout/chat/messages")).json()) as {
      messages: unknown[];
      suggestion?: string;
    };
    expect(body.messages).toHaveLength(1);
    // ABSENT, not empty: a client below 11 must see the field it always saw, and a client on 11
    // must be able to test for presence.
    expect(body).not.toHaveProperty("suggestion");
  });

  it("offers no suggestion when the deployment configured none", async () => {
    const { authed, bridge } = await setup(withNoChats(), { chatSuggestion: "" });
    await until(() => bridge.roster().bots.length === 1, 4_000);

    const body = (await (await authed("/bots/scout/chat/messages")).json()) as {
      messages: unknown[];
      suggestion?: string;
    };
    expect(body.messages).toEqual([]);
    expect(body).not.toHaveProperty("suggestion");
  });

  it("carries a suggestion the deployment set instead of the default", async () => {
    const { authed, bridge } = await setup(withNoChats(), { chatSuggestion: "What are you working on?" });
    await until(() => bridge.roster().bots.length === 1, 4_000);

    const body = (await (await authed("/bots/scout/chat/messages")).json()) as { suggestion?: string };
    expect(body.suggestion).toBe("What are you working on?");
  });
});

describe("a chat nobody has written to yet", () => {
  it("still reads as an empty chat long after the old 180 s kickoff window would have closed", async () => {
    const { authed, bridge, advance } = await setup(withNoChats());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    expect((await authed("/bots/scout/chat/messages")).status).toBe(200);

    // Nothing is in flight to wait for any more, so "the kickoff has not landed YET" has stopped
    // being a true description: the session is unresumable until the USER writes to it, which may
    // be never. A tolerance on a timer turns that into a 502 on a chat that is merely untouched.
    advance(CHAT_TURN_TIMEOUT_MS * 2);

    const res = await authed("/bots/scout/chat/messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[]; suggestion?: string };
    expect(body.messages).toEqual([]);
    expect(body.suggestion).toBe(DEFAULT_CHAT_SUGGESTION);
  });

  it("keeps the runtime id across a gateway restart, so the user's first message still lands", async () => {
    const { authed, bridge, storage, server } = await setup(withNoChats());
    await until(() => bridge.roster().bots.length === 1, 4_000);
    expect((await (await authed("/bots/scout/chat")).json()) as { adoption: string }).toMatchObject({
      adoption: "created",
    });

    // A gateway restart. `prompt.submit` accepts ONLY the runtime id, and an unprompted session has
    // no row to resume it out of, so a runtime id held only in memory is lost forever and the first
    // thing the user ever types 502s. Before capability 11 that window was the second or two a
    // kickoff took; now it is however long the chat sits unopened, which makes the restart ordinary.
    await bridge.close();
    bridges.splice(bridges.indexOf(bridge), 1);
    const revivedClient = createHermesClient({
      url: server.url,
      auth: { mode: "token", token: "T" },
      reconnect: { minMs: 15, maxMs: 60 },
    });
    const revived = new HermesBridge({
      client: revivedClient,
      storage,
      broadcast: () => {},
      now: () => NOW,
      logSink: () => {},
    });
    bridges.push(revived);
    revived.start();
    await until(() => revivedClient.state() === "online", 4_000);

    const sent = await revived.sendChatMessage("scout", "hi there");
    expect(sent.sessionId).toBe("stored-1");
    expect(server.callsOf("prompt.submit").at(-1)!.params).toMatchObject({
      session_id: "runtime-1",
      text: "hi there",
    });
  });
});

/** The durable half, at the storage seam. The bridge tests above prove the behaviour end to end;
 *  these pin the column's rules directly, because two of them are easy to break in a refactor and
 *  neither breaks loudly: a re-pin that DROPS the runtime id makes the user's first message
 *  unsendable, and a re-pin that KEEPS it across a session change aims that message at the chat a
 *  reset just retired. */
describe("bot_chat_pins.runtime_id", () => {
  it("survives a re-pin of the same session and is dropped when the pin moves", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);

    storage.setBotChatPin("scout", "stored-1", NOW);
    storage.setBotChatRuntimeId("scout", "stored-1", "runtime-1");
    expect(storage.botChatRuntimeId("scout", "stored-1")).toBe("runtime-1");

    // Every resolve of an already-pinned chat re-writes the same pin. Losing the runtime id there
    // would lose it on the second open of a chat nobody has written in.
    storage.setBotChatPin("scout", "stored-1", NOW + 1);
    expect(storage.botChatRuntimeId("scout", "stored-1")).toBe("runtime-1");

    // Asked about a session that is not the pinned one, the answer is nothing, whatever is stored.
    expect(storage.botChatRuntimeId("scout", "stored-2")).toBeUndefined();

    // A reset moves the pin. The old runtime id must not survive that.
    storage.setBotChatPin("scout", "stored-2", NOW + 2);
    expect(storage.botChatRuntimeId("scout", "stored-2")).toBeUndefined();
  });

  it("is forgotten once the session has a row, and with the pin when the pin is cleared", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);

    storage.setBotChatPin("scout", "stored-1", NOW);
    storage.setBotChatRuntimeId("scout", "stored-1", "runtime-1");
    storage.clearBotChatRuntimeId("scout", "stored-1");
    expect(storage.botChatRuntimeId("scout", "stored-1")).toBeUndefined();
    // The pin itself is untouched: the chat is still the bot's, it just resumes now.
    expect(storage.botChatPin("scout")).toBe("stored-1");

    storage.setBotChatRuntimeId("scout", "stored-1", "runtime-1");
    storage.clearBotChatPin("scout");
    expect(storage.botChatRuntimeId("scout", "stored-1")).toBeUndefined();
  });

  it("is added to a database created before capability 11", () => {
    // The migration, against a real pre-11 file rather than a fresh schema that already has the
    // column. An operator upgrading in place must not meet a "no such column" on their first chat.
    const dir = mkdtempSync(join(tmpdir(), "cozygateway-runtimeid-"));
    const dbPath = join(dir, "old.db");
    try {
      const old = new DatabaseSync(dbPath);
      old.exec(
        `CREATE TABLE bot_chat_pins (
           name TEXT PRIMARY KEY,
           session_id TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         ) STRICT`,
      );
      old.prepare("INSERT INTO bot_chat_pins (name, session_id, updated_at) VALUES (?, ?, ?)").run(
        "scout",
        "legacy-1",
        NOW,
      );
      old.close();

      const storage = openStorage(dbPath);
      storages.push(storage);
      expect(storage.botChatPin("scout")).toBe("legacy-1");
      // NULL for the pre-existing row, which is the honest answer: a pin an older gateway wrote
      // points at a chat its auto-submitted opener already persisted.
      expect(storage.botChatRuntimeId("scout", "legacy-1")).toBeUndefined();
      // And the column is writable, so the very next mint works.
      storage.setBotChatPin("scout", "stored-2", NOW + 1);
      storage.setBotChatRuntimeId("scout", "stored-2", "runtime-2");
      expect(storage.botChatRuntimeId("scout", "stored-2")).toBe("runtime-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
import { CANONICAL_CHAT_TITLE } from "../src/hermes-bridge/canonical-chat.ts";
import {
  startFakeHermesServer,
  type FakeHermesBehavior,
  type FakeHermesServer,
} from "./support/fake-hermes-server.ts";

/** Issue #66: a pinned chat whose hermes session is GONE.
 *
 *  The live shape this file is written from: hermes crashed with six of the household's seven bot
 *  chats sitting unwritten-in, i.e. holding a durable runtime id (or, on rows pinned by an older
 *  gateway, no runtime id at all) against a session that had never been persisted. Nothing on either
 *  side can bring such a session back. Before this change the consequences were both bad and both
 *  silent-ish: a send with no usable runtime id 502'd on every attempt forever, because no path ever
 *  minted a replacement for a PINNED chat; and a send with a runtime id from the dead hermes could be
 *  accepted into a session nothing would ever answer for, which is a 202, a user bubble, and no
 *  reply, which is worse than the error.
 *
 *  So there are two halves here and they are tested as two:
 *
 *   1. The send HEALS. A chat that cannot be addressed is retired and replaced through the very same
 *      path a user-initiated reset uses, the message goes into the replacement, and the answer is a
 *      202 naming the new session plus the `bot_chat_reset` frame every device already knows how to
 *      read. Re-homing is announced, never silent, which is what makes it safe for a client that
 *      caches the session id.
 *   2. The durable runtime id is BOUNDED by the life of the hermes that issued it, through a
 *      generation stamp. The invariant that has to survive alongside it is PR #61's: a GATEWAY
 *      restart against a hermes that never went down must still honour the id it was holding. */

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

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
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

async function setup(behavior: FakeHermesBehavior, storage = openStorage(":memory:")): Promise<Harness> {
  const server = await startFakeHermesServer(behavior);
  servers.push(server);
  if (!storages.includes(storage)) storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const frames: ServerFrame[] = [];
  let clock = NOW;
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => (clock += 1),
    logSink: () => {},
    // The turn poll is not what any of these tests are about, and a two second cadence against a
    // fake that answers instantly only slows them down.
    chatPollMs: 20,
    chatTurnTimeoutMs: 200,
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 12 } },
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
  await until(() => client.state() === "online");
  return { server, bridge, client, storage, frames, authed };
}

/** A hermes that CRASHED and came back with the bot's chat gone: the profile still carries the pin
 *  in its `ui_meta`, `session.list` no longer knows the session (it never had a row to know), and
 *  every resume of it is a 5003. Exactly the state the household box was left in.
 *
 *  `session.create` mints ids that are easy to tell apart from the dead one on the wire. */
function withDeadPinnedChat(): FakeHermesBehavior {
  const state = { meta: { title: "Scout", chat: "sess-dead" } as Record<string, unknown> };
  let created = 0;
  return {
    methods: {
      "profiles.list": () => ({
        profiles: [
          { name: "scout", description: "watches CI", has_avatar: false, ui_meta: { "hermes-bots": state.meta } },
        ],
        bot_mode_protocol: true,
      }),
      "session.list": () => ({ sessions: [] }),
      "session.create": () => {
        created += 1;
        return { stored_session_id: `stored-${created}`, session_id: `runtime-${created}` };
      },
      "session.resume": (params) => {
        // Only a session that was actually prompted into has a row. Nothing here ever submits on
        // the user's behalf (capability 11), so every resume fails the way the real host fails.
        throw { code: 5003, message: `no such session: ${String(params["session_id"] ?? "")}` };
      },
      "prompt.submit": () => ({ ok: true }),
      "profiles.configure": (params) => {
        const uiMeta = params["ui_meta"] as Record<string, unknown> | undefined;
        const blob = uiMeta?.["hermes-bots"];
        if (typeof blob === "object" && blob !== null) state.meta = blob as Record<string, unknown>;
        return { applied: { ui_meta: true } };
      },
    },
  };
}

describe("a send into a chat whose hermes session is gone", () => {
  it("mints a replacement, delivers the message into it, and answers 202", async () => {
    const { authed, bridge, server, frames, storage } = await setup(withDeadPinnedChat());
    await until(() => bridge.roster().bots.length === 1);

    // The state the box was in: a pin, and NO runtime id for it (six of seven live rows were NULL,
    // because an older gateway wrote the pin and the chat it pointed at is gone with hermes).
    expect((await (await authed("/bots/scout/chat")).json()) as { sessionId: string }).toMatchObject({
      sessionId: "sess-dead",
    });
    expect(storage.botChatUnwritten("scout", "sess-dead")).toBe(false);

    // The history READ still reports the failure verbatim, and that asymmetry is deliberate rather
    // than an oversight: a read has nothing to fix and no user intent behind it, so it says what
    // hermes said (the rule PR #61 set, pinned by `bots-chat-duplex.test.ts`), while a SEND carries a
    // message that has to go somewhere and is therefore the call that heals. After the send below,
    // this same read is an ordinary 200 against the replacement chat.
    expect((await authed("/bots/scout/chat/messages")).status).toBe(502);

    const res = await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "are you there?" }),
    });
    // 202 and not the 502 this used to be, forever, on every send.
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId: string; message: { text: string } };
    // The answer names the NEW chat, so a client that keys its transcript on the session id is
    // told which chat its own message landed in.
    expect(body.sessionId).toBe("stored-1");
    expect(body.message.text).toBe("are you there?");

    // The message actually reached hermes, addressed to the runtime id of the chat just minted.
    // Asserted on the wire: a heal that answered 202 without submitting would be the exact failure
    // mode (a rendered bubble and no reply) this issue is about, wearing a different hat.
    const submits = server.callsOf("prompt.submit");
    expect(submits).toHaveLength(1);
    expect(submits[0]!.params).toMatchObject({ session_id: "runtime-1", text: "are you there?" });
    expect(server.callsOf("session.create")).toHaveLength(1);
    expect(server.callsOf("session.create")[0]!.params).toMatchObject({ title: CANONICAL_CHAT_TITLE });

    // Every OTHER device hears about the re-home the same way it hears about a user-initiated
    // reset, naming both ends of the move.
    const reset = frames.filter((frame) => frame.type === "bot_chat_reset");
    expect(reset).toHaveLength(1);
    expect(reset[0]).toMatchObject({ bot: "scout", sessionId: "stored-1", previousSessionId: "sess-dead" });

    // And the dead session is recorded as retired, so no later adoption can pin it again.
    expect(storage.botChatRetired("scout").has("sess-dead")).toBe(true);

    // The chat the user is now in reads normally: the replacement is one this gateway minted, so
    // its unresumable-because-empty state is the ordinary capability 11 one.
    expect((await authed("/bots/scout/chat/messages")).status).toBe(200);
  });

  it("heals once, then reports the failure rather than minting chats in a loop", async () => {
    // `session.create` works, so the heal happens; the submit into the replacement fails anyway.
    // A second heal would answer a broken hermes by filling it with empty chats.
    const behavior = withDeadPinnedChat();
    behavior.methods!["prompt.submit"] = () => {
      throw { code: 5003, message: "no such session: runtime-1" };
    };
    const { authed, bridge, server } = await setup(behavior);
    await until(() => bridge.roster().bots.length === 1);

    const res = await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello?" }),
    });
    expect(res.status).toBe(502);
    expect(server.callsOf("session.create")).toHaveLength(1);
  });
});

describe("the hermes link generation bounds a durable runtime id", () => {
  it("ignores a runtime id stamped with a generation the link has moved past", async () => {
    const { authed, bridge, server, storage } = await setup(withDeadPinnedChat());
    await until(() => bridge.roster().bots.length === 1);

    // Open the bot: the pin is believed over the empty list, so the chat resolves to the pin and
    // this gateway holds no runtime id for it. Plant one from a hermes that is no longer running,
    // which is precisely what an orphaned `bot_chat_pins.runtime_id` row IS.
    await authed("/bots/scout/chat");
    storage.setBotChatRuntimeId("scout", "sess-dead", "runtime-zombie", "link-from-a-dead-hermes");
    expect(storage.botChatUnwritten("scout", "sess-dead")).toBe(true);
    // Same row, asked with the generation the link is actually on: nothing.
    expect(storage.botChatRuntimeId("scout", "sess-dead", bridge.linkGeneration())).toBeUndefined();

    const res = await authed("/bots/scout/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "still there?" }),
    });
    expect(res.status).toBe(202);

    // The whole point: the zombie id NEVER reaches the wire. Submitting at it is the silent failure
    // (hermes can accept a prompt into a phantom session), so this assertion is the one that would
    // catch a regression that still answered 202.
    const submits = server.callsOf("prompt.submit");
    expect(submits.map((call) => call.params["session_id"])).toEqual(["runtime-1"]);
  });

  it("moves on when hermes restarts under a gateway that stayed up", async () => {
    const { bridge, client, server, storage } = await setup(withDeadPinnedChat());
    await until(() => bridge.roster().bots.length === 1);
    const before = bridge.linkGeneration();
    storage.setBotChatPin("scout", "stored-9", NOW);
    storage.setBotChatRuntimeId("scout", "stored-9", "runtime-9", before);
    expect(storage.botChatRuntimeId("scout", "stored-9", bridge.linkGeneration())).toBe("runtime-9");

    // A hermes restart, as this side of the link experiences it: the socket goes, and a fresh
    // `gateway.ready` follows.
    server.dropAll();
    await until(() => client.state() !== "online");
    await until(() => client.state() === "online");
    await until(() => bridge.linkGeneration() !== before);

    // The stored id is now unaddressable, and the chat is still recognisably an empty one.
    expect(storage.botChatRuntimeId("scout", "stored-9", bridge.linkGeneration())).toBeUndefined();
    expect(storage.botChatUnwritten("scout", "stored-9")).toBe(true);
    // Written down, so the answer is the same after a gateway restart as before it.
    expect(storage.hermesLinkGeneration()).toBe(bridge.linkGeneration());
  });

  it("keeps the generation, and the runtime id, across a GATEWAY restart (the PR #61 win)", async () => {
    const { authed, bridge, server, storage } = await setup(withDeadPinnedChat());
    await until(() => bridge.roster().bots.length === 1);

    // A chat this gateway minted and nobody has written in. `prompt.submit` accepts nothing but its
    // runtime id, and that id has to survive the restart or the first thing the user ever types is
    // lost with no way back.
    await authed("/bots/scout/chat/reset", { method: "POST" });
    const generation = bridge.linkGeneration();
    expect(storage.botChatRuntimeId("scout", "stored-1", generation)).toBe("runtime-1");

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
    await until(() => revivedClient.state() === "online");

    // Nothing about hermes changed, so nothing about the generation changes either.
    expect(revived.linkGeneration()).toBe(generation);
    // Wait for the revived bridge's own roster refresh before sending. Its cache is the one the
    // previous process left behind, so until the refresh lands the server pin it reads is the
    // pre-reset one, and re-pinning to that would move the pin (and drop the runtime id) for
    // reasons that have nothing to do with what this test is about.
    await until(() => revived.roster().bots[0]?.chatSessionId === "stored-1");

    const sent = await revived.sendChatMessage("scout", "hi there");
    expect(sent.sessionId).toBe("stored-1");
    // The id from before the restart, used as-is. No re-mint: `session.create` was called once, by
    // the reset, and not again.
    expect(server.callsOf("prompt.submit").at(-1)!.params).toMatchObject({
      session_id: "runtime-1",
      text: "hi there",
    });
    expect(server.callsOf("session.create")).toHaveLength(1);
  });
});

describe("the runtime_generation migration", () => {
  it("adds the column to a pre-#66 database and is a no-op on the second open", () => {
    const dir = mkdtempSync(join(tmpdir(), "cozygateway-gen-"));
    const dbPath = join(dir, "old.db");
    try {
      // A capability 11 database: it HAS runtime_id and has never heard of a generation.
      const old = new DatabaseSync(dbPath);
      old.exec(
        `CREATE TABLE bot_chat_pins (
           name TEXT PRIMARY KEY,
           session_id TEXT NOT NULL,
           updated_at INTEGER NOT NULL,
           runtime_id TEXT
         ) STRICT`,
      );
      old.prepare(
        "INSERT INTO bot_chat_pins (name, session_id, updated_at, runtime_id) VALUES (?, ?, ?, ?)",
      ).run("scout", "stored-1", NOW, "runtime-1");
      old.close();

      const storage = openStorage(dbPath);
      storages.push(storage);
      expect(storage.botChatPin("scout")).toBe("stored-1");
      // The row is still recognisably an unwritten chat...
      expect(storage.botChatUnwritten("scout", "stored-1")).toBe(true);
      // ...and its id is not addressable under any generation, which is the safe direction: an id
      // carried over an upgrade cannot prove which hermes issued it, so it is treated as expired and
      // the send mints a replacement instead of submitting into a session that may not exist.
      expect(storage.botChatRuntimeId("scout", "stored-1", "link-0")).toBeUndefined();
      // The column is writable, so the very next mint is stamped properly.
      storage.setBotChatRuntimeId("scout", "stored-1", "runtime-1", "link-0");
      expect(storage.botChatRuntimeId("scout", "stored-1", "link-0")).toBe("runtime-1");
      storage.close();
      storages.splice(storages.indexOf(storage), 1);

      // Second open: the ALTER now duplicates a column that exists, which is the no-op the narrow
      // catch is for. Anything else throws, which is issue #64's rule.
      const again = openStorage(dbPath);
      storages.push(again);
      expect(again.botChatRuntimeId("scout", "stored-1", "link-0")).toBe("runtime-1");
      // And a database that has never held a link generation says so rather than inventing one.
      expect(again.hermesLinkGeneration()).toBeUndefined();
      again.setHermesLinkGeneration("link-7");
      expect(again.hermesLinkGeneration()).toBe("link-7");
      again.setHermesLinkGeneration("link-8");
      expect(again.hermesLinkGeneration()).toBe("link-8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

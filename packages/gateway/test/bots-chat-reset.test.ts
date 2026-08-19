import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { CANONICAL_CHAT_TITLE, KICKOFF_PROMPT } from "../src/hermes-bridge/canonical-chat.ts";
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

  it("mints the new chat with the canonical title and kicks it off against the RUNTIME id", async () => {
    const { authed, bridge, server } = await setup(withOneChat());
    await until(() => bridge.roster().bots.length === 1, 4_000);

    expect((await authed("/bots/scout/chat/reset", { method: "POST" })).status).toBe(200);

    const create = server.callsOf("session.create");
    expect(create).toHaveLength(1);
    expect(create[0]!.params).toEqual({ profile: "scout", title: CANONICAL_CHAT_TITLE, hidden: true });
    // `prompt.submit` accepts only the runtime id, and without the kickoff the session persists no
    // row at all, so a reset that skipped it would pin a chat nothing can resume.
    expect(server.callsOf("prompt.submit")[0]!.params).toEqual({
      session_id: "runtime-2",
      text: KICKOFF_PROMPT,
    });
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

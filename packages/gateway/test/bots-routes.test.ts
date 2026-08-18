import { afterEach, describe, expect, it } from "vitest";
import type { Message, RichBlock, ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { CANONICAL_CHAT_TITLE, KICKOFF_PROMPT } from "../src/hermes-bridge/canonical-chat.ts";
import {
  startFakeHermesServer,
  NO_REPLY,
  type FakeHermesBehavior,
  type FakeHermesServer,
} from "./support/fake-hermes-server.ts";

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
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

async function setup(
  behavior: FakeHermesBehavior = {},
  bridgeOverrides: { rosterPollMs?: number; now?: () => number } = {},
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
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: bridgeOverrides.now ?? (() => NOW),
    logSink: () => {},
    ...(bridgeOverrides.rosterPollMs === undefined ? {} : { rosterPollMs: bridgeOverrides.rosterPollMs }),
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
  const authed = async (path: string, init?: RequestInit): Promise<Response> =>
    app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
    });

  bridge.start();
  // Every test but the deliberately-offline ones assumes a live link, so settle it here.
  await until(() => client.state() === "online", 4_000);
  return {
    server,
    bridge,
    client,
    storage,
    frames,
    authed,
    request: async (path: string, init?: RequestInit): Promise<Response> => app.request(path, init),
  };
}

function profilesListResult(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  return { profiles: rows, bot_mode_protocol: true };
}

const scoutRow = {
  name: "scout",
  description: "watches CI",
  has_avatar: false,
  last_session: { last_active: Math.round(NOW / 1000) - 5, preview: "all green" },
  ui_meta: { "hermes-bots": { title: "Scout" } },
};

describe("GET /bots", () => {
  it("serves the cache instantly on a cold start and fills it in the background", async () => {
    // profiles.list is held open until the cold read has already been answered, so "the cache
    // answers without waiting for Hermes" is proven rather than raced.
    let release: (() => void) | undefined;
    const { authed, bridge, frames } = await setup({
      methods: {
        "profiles.list": (_params, ctx) => {
          release = () => ctx.reply(profilesListResult([scoutRow]));
          return NO_REPLY;
        },
      },
    });

    // Cold: the cache is empty and the route still answers, without waiting for Hermes.
    const cold = await authed("/bots");
    expect(cold.status).toBe(200);
    expect(await cold.json()).toEqual({ bots: [], updatedAt: null, stale: false });

    await until(() => release !== undefined, 4_000);
    release?.();

    await until(() => bridge.roster().bots.length === 1, 4_000);
    const warm = (await (await authed("/bots")).json()) as { bots: Array<{ name: string }>; updatedAt: number };
    expect(warm.bots.map((bot) => bot.name)).toEqual(["scout"]);
    expect(warm.updatedAt).toBe(NOW);

    const roster = frames.find((frame) => frame.type === "bot_roster");
    const presence = frames.find((frame) => frame.type === "bot_presence");
    expect(roster).toBeDefined();
    expect(presence).toMatchObject({ type: "bot_presence", active: ["scout"] });
  });

  it("keeps serving the last good roster when the hermes link drops, flagged stale", async () => {
    const { authed, bridge, server } = await setup({
      methods: { "profiles.list": () => profilesListResult([scoutRow]) },
    });
    await until(() => bridge.roster().bots.length === 1, 4_000);

    await bridge.close();
    const body = (await (await authed("/bots")).json()) as { bots: unknown[]; stale: boolean };
    expect(body.bots).toHaveLength(1);
    expect(body.stale).toBe(true);
    expect(server.callsOf("profiles.list").length).toBeGreaterThanOrEqual(1);
  });

  it("does not broadcast when a refresh produces an unchanged roster", async () => {
    const { bridge, frames } = await setup({
      methods: { "profiles.list": () => profilesListResult([scoutRow]) },
    });
    await until(() => bridge.roster().bots.length === 1, 4_000);
    const before = frames.length;
    await bridge.refresh("test");
    expect(frames.length).toBe(before);
  });
});

describe("GET /bots/:name/chat", () => {
  it("creates the canonical chat with the exact title, hidden flag and kickoff prompt", async () => {
    const { authed, server } = await setup({
      methods: {
        "profiles.list": () => profilesListResult([scoutRow]),
        "session.list": () => ({ sessions: [] }),
        "session.create": () => ({ stored_session_id: "stored-1", session_id: "runtime-1" }),
        "prompt.submit": () => ({ ok: true }),
      },
    });

    const body = (await (await authed("/bots/scout/chat")).json()) as { sessionId: string; adoption: string };
    expect(body).toEqual({ name: "scout", sessionId: "stored-1", adoption: "created" });

    const create = server.callsOf("session.create")[0]!;
    expect(create.params).toEqual({ profile: "scout", title: CANONICAL_CHAT_TITLE, hidden: true });
    expect(CANONICAL_CHAT_TITLE).toBe("Bot Chat");
    // The kickoff rides the RUNTIME id, not the stored one, and exists because session.create
    // persists no row until the first prompt.
    expect(server.callsOf("prompt.submit")[0]!.params).toEqual({
      session_id: "runtime-1",
      text: KICKOFF_PROMPT,
    });
  });

  it("rolls the pin back when the kickoff prompt fails", async () => {
    const { authed, storage } = await setup({
      methods: {
        "profiles.list": () => profilesListResult([scoutRow]),
        "session.list": () => ({ sessions: [] }),
        "session.create": () => ({ stored_session_id: "stored-1", session_id: "runtime-1" }),
        "prompt.submit": () => {
          throw { code: 5007, message: "session db unavailable" };
        },
      },
    });

    const res = await authed("/bots/scout/chat");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: { code: "backend_unavailable" },
      hermesError: "session db unavailable",
    });
    expect(storage.botChatPin("scout")).toBeUndefined();
  });

  it("adopts the session carrying the canonical title on a first open with history", async () => {
    const { authed, storage, server } = await setup({
      methods: {
        "profiles.list": () => profilesListResult([scoutRow]),
        "session.list": () => ({
          sessions: [
            { id: "newest", title: "Debugging the deploy" },
            { id: "canonical", title: CANONICAL_CHAT_TITLE },
          ],
        }),
      },
    });

    expect(await (await authed("/bots/scout/chat")).json()).toEqual({
      name: "scout",
      sessionId: "canonical",
      adoption: "title",
    });
    expect(storage.botChatPin("scout")).toBe("canonical");
    expect(server.callsOf("session.create")).toHaveLength(0);
  });

  it("adopts the newest session when no canonical title exists", async () => {
    const { authed } = await setup({
      methods: {
        "profiles.list": () => profilesListResult([scoutRow]),
        "session.list": () => ({ sessions: [{ id: "newest", title: "hello" }, { id: "older", title: "older" }] }),
      },
    });
    expect(await (await authed("/bots/scout/chat")).json()).toMatchObject({
      sessionId: "newest",
      adoption: "latest",
    });
  });

  it("returns the existing pin unchanged when it still resolves", async () => {
    const { authed, storage } = await setup({
      methods: {
        "profiles.list": () => profilesListResult([scoutRow]),
        "session.list": () => ({ sessions: [{ id: "newest", title: "x" }, { id: "pinned", title: "Bot Chat" }] }),
      },
    });
    storage.setBotChatPin("scout", "pinned", NOW);
    expect(await (await authed("/bots/scout/chat")).json()).toMatchObject({
      sessionId: "pinned",
      adoption: "pin",
    });
  });

  it("re-pins the newest session when the pinned id has vanished", async () => {
    const { authed, storage } = await setup({
      methods: {
        "profiles.list": () => profilesListResult([scoutRow]),
        "session.list": () => ({ sessions: [{ id: "newest", title: "x" }] }),
      },
    });
    storage.setBotChatPin("scout", "gone", NOW);
    expect(await (await authed("/bots/scout/chat")).json()).toMatchObject({
      sessionId: "newest",
      adoption: "recovery",
    });
    expect(storage.botChatPin("scout")).toBe("newest");
  });

  it("mints exactly one chat when two requests race", async () => {
    const { authed, server } = await setup({
      methods: {
        "profiles.list": () => profilesListResult([scoutRow]),
        "session.list": () => ({ sessions: [] }),
        "session.create": () => ({ stored_session_id: "stored-1", session_id: "runtime-1" }),
        "prompt.submit": () => ({ ok: true }),
      },
    });
    const [a, b] = await Promise.all([authed("/bots/scout/chat"), authed("/bots/scout/chat")]);
    expect(await a.json()).toEqual(await b.json());
    expect(server.callsOf("session.create")).toHaveLength(1);
  });

  it("passes an unknown-method rejection through verbatim", async () => {
    const { authed } = await setup({ methods: { "profiles.list": () => profilesListResult([scoutRow]) } });
    const res = await authed("/bots/scout/chat");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { hermesError: string };
    expect(body.hermesError).toMatch(/unknown method/i);
    expect(body.hermesError).toBe("unknown method: session.list");
  });
});

describe("GET /bots/:name/sessions", () => {
  it("passes session.list through with a 200 row limit", async () => {
    const { authed, server } = await setup({
      methods: {
        "profiles.list": () => profilesListResult([scoutRow]),
        "session.list": () => ({ sessions: [{ id: "s1", title: "one", preview: "hi", source: "desktop" }] }),
      },
    });
    const body = (await (await authed("/bots/scout/sessions")).json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([{ id: "s1", title: "one", preview: "hi", source: "desktop" }]);
    expect(server.callsOf("session.list")[0]!.params).toEqual({ profile: "scout", limit: 200 });
  });
});

describe("POST /bots/focus", () => {
  it("rejects an unknown screen", async () => {
    const { authed } = await setup({ methods: { "profiles.list": () => profilesListResult([]) } });
    const res = await authed("/bots/focus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ screen: "kitchen" }),
    });
    expect(res.status).toBe(400);
  });

  it("polls at the roster cadence only while a device is focused", async () => {
    const { authed, server, bridge } = await setup(
      { methods: { "profiles.list": () => profilesListResult([scoutRow]) } },
      { rosterPollMs: 30 },
    );
    await until(() => bridge.roster().bots.length === 1, 4_000);

    const idleCalls = server.callsOf("profiles.list").length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Idle: no focus declared, so nothing polls. The only calls are the ones the link's own
    // online transition and the earlier REST reads triggered.
    expect(server.callsOf("profiles.list").length).toBe(idleCalls);

    const focus = await authed("/bots/focus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ screen: "roster" }),
    });
    expect(focus.status).toBe(200);
    await until(() => server.callsOf("profiles.list").length >= idleCalls + 3, 4_000);

    await authed("/bots/focus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ screen: null }),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const settled = server.callsOf("profiles.list").length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.callsOf("profiles.list").length).toBe(settled);
  });
});

describe("route registration", () => {
  it("does not expose /bots when no bridge is configured", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const app = createApp({
      storage,
      config,
      gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: {} },
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
    const res = await app.request("/bots", { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(res.status).toBe(404);
  });

  it("requires a device token", async () => {
    const { request } = await setup({ methods: { "profiles.list": () => profilesListResult([]) } });
    expect((await request("/bots")).status).toBe(401);
    expect((await request("/bots", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { BotSummary, ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { validateNewBotName, BotNameInvalid } from "../src/hermes-bridge/crud.ts";
import { startFakeHermesServer, type FakeHermesBehavior, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Bot create and delete over the bridge (contract/ext-bots-v1.md section 4), plus the operator's
 *  roster hide list. Everything runs against the fake Hermes so the two-RPC create, the CLI delete
 *  fallback, and the shapes those calls carry are asserted on the wire rather than on a mock. */

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

async function setup(behavior: FakeHermesBehavior = {}, hiddenProfiles: string[] = []): Promise<Harness> {
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
    hiddenProfiles,
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 1 } },
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

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** A `profiles.list` that answers with whatever profiles have been created so far, so a create or
 *  delete is followed by a roster that actually reflects it. */
function liveProfiles(names: Set<string>, meta = new Map<string, Record<string, unknown>>()) {
  return () => ({
    profiles: [...names].map((name) => ({
      name,
      description: "",
      has_avatar: false,
      ...(meta.has(name) ? { ui_meta: { "hermes-bots": meta.get(name) } } : {}),
    })),
    bot_mode_protocol: true,
  });
}

describe("bot name validation", () => {
  it("mirrors the hermes profile-name rule, normalizing before it judges", () => {
    // Upstream normalize_profile_name lowercases first, so a title-cased label from a form is
    // accepted and stored canonically rather than refused for a rule it only breaks in display.
    expect(validateNewBotName("  Scout  ")).toBe("scout");
    expect(validateNewBotName("bot_2-x")).toBe("bot_2-x");

    // _PROFILE_ID_RE: must start alphanumeric, no dots, slashes, spaces, or 65th character.
    expect(() => validateNewBotName("-scout")).toThrow(BotNameInvalid);
    expect(() => validateNewBotName("scout.1")).toThrow(/a-z0-9/);
    expect(() => validateNewBotName("two words")).toThrow(BotNameInvalid);
    expect(() => validateNewBotName("a".repeat(65))).toThrow(BotNameInvalid);
    expect(() => validateNewBotName("   ")).toThrow(/required/);

    // _RESERVED_NAMES, and the built-in profile, which upstream refuses with its own message.
    for (const reserved of ["hermes", "test", "tmp", "root", "sudo"]) {
      expect(() => validateNewBotName(reserved)).toThrow(/reserved/);
    }
    expect(() => validateNewBotName("Default")).toThrow(/built-in/);
  });
});

describe("POST /bots", () => {
  it("creates the profile with share_auth on, writes the look, and answers with the roster row", async () => {
    const names = new Set<string>(["default"]);
    const meta = new Map<string, Record<string, unknown>>();
    const { authed, server, frames } = await setup({
      methods: {
        "profiles.list": liveProfiles(names, meta),
        "profiles.create": (params) => {
          names.add(String(params["name"]));
          return {};
        },
        "profiles.configure": (params) => {
          meta.set(String(params["name"]), (params["ui_meta"] as Record<string, Record<string, unknown>>)[
            "hermes-bots"
          ]!);
          return { applied: { ui_meta: true } };
        },
      },
    });

    const res = await authed(
      "/bots",
      post({ name: "Scout", title: "Scout", description: "watches CI", shape: "squircle", color: "#8b5cf6" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { bot: BotSummary; metaOutcome: string };
    expect(body.metaOutcome).toBe("persisted");
    expect(body.bot.name).toBe("scout");
    expect(body.bot.displayName).toBe("Scout");

    // share_auth rides EXPLICITLY: the backend default is false, which COPIES auth.json and forks
    // the OAuth token pool, so an omitted flag breaks the main profile's login hours later.
    const create = server.callsOf("profiles.create")[0];
    expect(create?.params).toMatchObject({
      name: "scout",
      description: "watches CI",
      share_auth: true,
    });

    // The look is the desktop's own blob under the desktop's own namespace key, with `created` in
    // MILLISECONDS. A different key means a desktop and a phone cannot see each other's bots.
    const configure = server.callsOf("profiles.configure")[0];
    expect(configure?.params).toEqual({
      name: "scout",
      ui_meta: { "hermes-bots": { title: "Scout", shape: "squircle", color: "#8b5cf6", created: NOW } },
    });

    // The roster the app is about to receive carries the new bot, so the 201 and the frame agree.
    const roster = frames.filter((frame) => frame.type === "bot_roster").at(-1);
    expect(roster?.type === "bot_roster" && roster.bots.map((bot) => bot.name)).toContain("scout");
    const listed = (await (await authed("/bots")).json()) as { bots: BotSummary[] };
    expect(listed.bots.map((bot) => bot.name)).toContain("scout");
  });

  it("answers 409 for a name that already exists, without writing any look", async () => {
    const { authed, server } = await setup({
      methods: {
        "profiles.list": liveProfiles(new Set(["default", "scout"])),
        "profiles.create": () => {
          // Upstream turns create_profile's FileExistsError into 4062 with this text.
          throw { code: 4062, message: "Profile 'scout' already exists at /home/h/.hermes/profiles/scout" };
        },
      },
    });

    const res = await authed("/bots", post({ name: "scout" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "conflict", message: 'a bot named "scout" already exists' },
    });
    expect(server.callsOf("profiles.configure")).toHaveLength(0);
  });

  it("refuses an invalid or reserved name before anything reaches hermes", async () => {
    const { authed, server } = await setup({ methods: { "profiles.list": liveProfiles(new Set(["default"])) } });

    for (const [name, pattern] of [
      ["two words", /a-z0-9/],
      ["root", /reserved/],
      ["default", /built-in/],
    ] as const) {
      const res = await authed("/bots", post({ name }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toMatch(pattern);
    }
    expect(server.callsOf("profiles.create")).toHaveLength(0);
  });

  it("reports the three-way ui_meta outcome and never fails a create over the look", async () => {
    // `failed`: the gateway speaks the applied contract and said the blob did NOT apply.
    const names = new Set<string>(["default"]);
    const failing = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "profiles.create": (params) => {
          names.add(String(params["name"]));
          return {};
        },
        "profiles.configure": () => ({ applied: { soul: true } }),
      },
    });
    const failedRes = await failing.authed("/bots", post({ name: "scout", color: "#ef4444" }));
    expect(failedRes.status).toBe(201);
    expect(((await failedRes.json()) as { metaOutcome: string }).metaOutcome).toBe("failed");

    // `unsupported`: an older gateway that does not know profiles.configure at all. Silent by
    // design, and the bot still exists, so the create still answers 201.
    const older = new Set<string>(["default"]);
    const legacy = await setup({
      methods: {
        "profiles.list": liveProfiles(older),
        "profiles.create": (params) => {
          older.add(String(params["name"]));
          return {};
        },
      },
    });
    const legacyRes = await legacy.authed("/bots", post({ name: "scout" }));
    expect(legacyRes.status).toBe(201);
    const legacyBody = (await legacyRes.json()) as { metaOutcome: string; bot: BotSummary };
    expect(legacyBody.metaOutcome).toBe("unsupported");
    expect(legacyBody.bot.name).toBe("scout");
  });

  it("rejects a malformed body before it reaches the bridge", async () => {
    const { authed, server } = await setup({ methods: { "profiles.list": liveProfiles(new Set(["default"])) } });
    expect((await authed("/bots", post({ title: "no name" }))).status).toBe(400);
    expect((await authed("/bots", post({ name: "scout", color: "purple" }))).status).toBe(400);
    expect(server.callsOf("profiles.create")).toHaveLength(0);
  });
});

describe("DELETE /bots/:name", () => {
  it("falls back to the cli when the gateway has no profiles.delete, and cleans up local state", async () => {
    // Hermes 0.20.3 registers no profiles.delete, so the fake's unknown-method rejection is
    // exactly what a real gateway answers, and the CLI path is the live one today.
    const names = new Set(["default", "scout"]);
    const { authed, server, storage, frames, bridge } = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "cli.exec": (params) => {
          const argv = params["argv"] as string[];
          names.delete(argv[2]!);
          return { blocked: false, code: 0, output: "Deleted profile 'scout'" };
        },
      },
    });
    await until(() => bridge.roster().bots.length === 2, 4_000);
    storage.setBotChatPin("scout", "sess-1", NOW);

    const res = await authed("/bots/scout", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    // The argv is byte-exact: the gateway's allow-list matches on argv, so a reworded flag is a
    // blocked command rather than a delete.
    expect(server.callsOf("cli.exec")[0]?.params["argv"]).toEqual(["profile", "delete", "scout", "--yes"]);
    // The teardown-first RPC is probed first, so the day upstream ships it this takes it.
    expect(server.callsOf("profiles.delete")).toHaveLength(1);

    expect(storage.botChatPin("scout")).toBeUndefined();
    expect(storage.botRoster().bots.map((bot) => bot.name)).toEqual(["default"]);
    const roster = frames.filter((frame) => frame.type === "bot_roster").at(-1);
    expect(roster?.type === "bot_roster" && roster.bots.map((bot) => bot.name)).toEqual(["default"]);
  });

  it("prefers a teardown-first profiles.delete RPC when the gateway has one", async () => {
    const names = new Set(["default", "scout"]);
    const { authed, server } = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "profiles.delete": (params) => {
          names.delete(String(params["name"]));
          return { ok: true };
        },
        "cli.exec": () => ({ blocked: false, code: 0, output: "" }),
      },
    });

    expect((await authed("/bots/scout", { method: "DELETE" })).status).toBe(204);
    expect(server.callsOf("profiles.delete")[0]?.params).toEqual({ name: "scout" });
    // The CLI bypasses backend teardown and races the profile directory, so it must not run when
    // the RPC did the job.
    expect(server.callsOf("cli.exec")).toHaveLength(0);
  });

  it("refuses to delete the built-in default profile, without touching hermes", async () => {
    const { authed, server } = await setup({
      methods: { "profiles.list": liveProfiles(new Set(["default"])) },
    });
    const res = await authed("/bots/Default", { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toMatch(/built-in/);
    expect(server.callsOf("cli.exec")).toHaveLength(0);
    expect(server.callsOf("profiles.delete")).toHaveLength(0);
  });

  it("surfaces a blocked command with the gateway's own hint, and keeps the bot", async () => {
    const names = new Set(["default", "scout"]);
    const { authed, storage, bridge } = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "cli.exec": () => ({ blocked: true, hint: "profile delete is not on the allow-list", code: -1, output: "" }),
      },
    });
    await until(() => bridge.roster().bots.length === 2, 4_000);
    storage.setBotChatPin("scout", "sess-1", NOW);

    const res = await authed("/bots/scout", { method: "DELETE" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: "command_blocked", message: "the hermes gateway blocked the profile delete command" },
      blocked: true,
      hint: "profile delete is not on the allow-list",
    });

    // Nothing local was thrown away: the bot still exists, so its canonical-chat pin must survive
    // or the next open would mint a second chat.
    expect(storage.botChatPin("scout")).toBe("sess-1");
    expect(bridge.roster().bots.map((bot) => bot.name)).toContain("scout");
  });

  it("surfaces a failing delete command with its exit code and output", async () => {
    const { authed, storage } = await setup({
      methods: {
        "profiles.list": liveProfiles(new Set(["default", "scout"])),
        "cli.exec": () => ({ blocked: false, code: 1, output: "PermissionError: [Errno 13]" }),
      },
    });
    storage.setBotChatPin("scout", "sess-1", NOW);

    const res = await authed("/bots/scout", { method: "DELETE" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: { code: "backend_unavailable" },
      blocked: false,
      exitCode: 1,
      hermesError: "PermissionError: [Errno 13]",
    });
    expect(storage.botChatPin("scout")).toBe("sess-1");
  });
});

describe("hidden profiles", () => {
  it("keeps hidden names off the roster and the frames while leaving them addressable", async () => {
    const { authed, frames, bridge, server } = await setup(
      {
        methods: {
          "profiles.list": liveProfiles(new Set(["default", "scout", "ops-runner"])),
          "session.list": () => ({ sessions: [{ id: "s1", title: "Bot Chat", preview: null, source: "cli" }] }),
        },
      },
      ["Ops-Runner"],
    );
    await until(() => bridge.roster().bots.length > 0, 4_000);

    const listed = (await (await authed("/bots")).json()) as { bots: BotSummary[] };
    expect(listed.bots.map((bot) => bot.name)).toEqual(["default", "scout"]);

    const roster = frames.filter((frame) => frame.type === "bot_roster").at(-1);
    expect(roster?.type === "bot_roster" && roster.bots.map((bot) => bot.name)).toEqual(["default", "scout"]);
    const presence = frames.filter((frame) => frame.type === "bot_presence").at(-1);
    expect(presence?.type === "bot_presence" && presence.active).not.toContain("ops-runner");

    // Hidden is a roster filter, not an access rule: the profile is real Hermes-side and every
    // by-name route still reaches it.
    const sessions = await authed("/bots/ops-runner/sessions");
    expect(sessions.status).toBe(200);
    expect(server.callsOf("session.list")[0]?.params).toMatchObject({ profile: "ops-runner" });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { BotSummary, ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { validateNewBotName, BotNameInvalid } from "../src/hermes-bridge/crud.ts";
import {
  NO_REPLY,
  startFakeHermesServer,
  type FakeHermesBehavior,
  type FakeHermesServer,
} from "./support/fake-hermes-server.ts";

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

async function setup(
  behavior: FakeHermesBehavior = {},
  hiddenProfiles: string[] = [],
  extra: { bridgeProfile?: string; deleteTimeoutMs?: number } = {},
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
    now: () => NOW,
    logSink: () => {},
    hiddenProfiles,
    ...(extra.bridgeProfile === undefined ? {} : { bridgeProfile: extra.bridgeProfile }),
    ...(extra.deleteTimeoutMs === undefined ? {} : { deleteTimeoutMs: extra.deleteTimeoutMs }),
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
    // Index 0 is no longer this route's call: the roster preview (cozygateway#102) issues its own
    // session.list per visible bot before any by-name route runs. The property under test is that
    // the hidden profile IS addressed, wherever its call lands in the order.
    expect(
      server.callsOf("session.list").some((call) => {
        const params = call.params as { profile?: string };
        return params.profile === "ops-runner";
      }),
    ).toBe(true);
  });
});

/** Everything the adversarial review of this PR turned up. Each case names the finding it closes
 *  and fails without its fix. */
describe("review fixes", () => {
  /** A Hermes with one hidden bot that has a desktop-authored look blob, a session list, and a
   *  working `profiles.configure`. The blob lives in `meta` so a test can read back exactly what
   *  the gateway wrote. */
  function hiddenBotHermes(meta: Record<string, unknown>, sessions: Array<{ id: string; title: string }>) {
    const state = { meta, sessions, created: 0 };
    const behavior: FakeHermesBehavior = {
      methods: {
        "profiles.list": () => ({
          profiles: [
            { name: "default", description: "", has_avatar: false },
            { name: "ops-runner", description: "", has_avatar: false, ui_meta: { "hermes-bots": state.meta } },
          ],
          bot_mode_protocol: true,
        }),
        "session.list": () => ({ sessions: state.sessions }),
        "session.create": () => {
          state.created += 1;
          return { stored_session_id: `stored-${state.created}`, session_id: `runtime-${state.created}` };
        },
        // Present so a stray submit would be recorded rather than rejected: since capability 11
        // nothing here should reach it unless a user sends something.
        "prompt.submit": () => ({ ok: true }),
        "profiles.configure": (params) => {
          const blob = (params["ui_meta"] as Record<string, unknown>)["hermes-bots"];
          if (typeof blob === "object" && blob !== null) state.meta = blob as Record<string, unknown>;
          return { applied: { ui_meta: true } };
        },
      },
    };
    return { behavior, state };
  }

  it("B1: a hidden bot's chat open preserves its server blob instead of wiping it", async () => {
    // Hidden bots are absent from the roster cache by design, and the pin write path used to build
    // its replacement blob from that cache. The first chat open from a phone therefore wrote
    // `ui_meta["hermes-bots"] = { chat: <id> }` WHOLE, destroying the desktop's title, shape, color
    // and created stamp for a bot the docs say is still chattable.
    const { behavior, state } = hiddenBotHermes({ title: "Ops", shape: "squircle", color: "#8b5cf6" }, []);
    const { authed } = await setup(behavior, ["ops-runner"]);

    const body = (await (await authed("/bots/ops-runner/chat")).json()) as { sessionId: string };
    expect(body.sessionId).toBe("stored-1");
    expect(state.meta).toEqual({ title: "Ops", shape: "squircle", color: "#8b5cf6", chat: "stored-1" });
  });

  it("B1: a hidden bot's SERVER pin is honored, not just its local one", async () => {
    // `#serverPinOf` read the filtered cache too, so for a hidden bot it always answered "the server
    // knows nothing" and the authoritative pin was never consulted.
    const { behavior } = hiddenBotHermes({ title: "Ops", chat: "sess-9" }, [
      { id: "sess-9", title: "Bot Chat" },
      { id: "newer", title: "Bot Chat" },
    ]);
    const { authed, server } = await setup(behavior, ["ops-runner"]);

    expect(await (await authed("/bots/ops-runner/chat")).json()).toMatchObject({
      sessionId: "sess-9",
      adoption: "pin",
    });
    expect(server.callsOf("session.create")).toHaveLength(0);
  });

  it("B2: DELETE applies the same name rule as POST, before anything reaches hermes", async () => {
    const { authed, server } = await setup({ methods: { "profiles.list": liveProfiles(new Set(["default"])) } });

    // Hono decodes the path param, so these are the real strings the handler saw. All three were
    // forwarded into `profiles.delete` and into a `cli.exec` argv this gateway builds itself.
    for (const [path, pattern] of [
      ["/bots/%2E%2E%2F%2E%2E%2Fetc", /a-z0-9/],
      ["/bots/--help", /a-z0-9/],
      ["/bots/a%2Fb", /a-z0-9/],
      ["/bots/hermes", /reserved/],
      ["/bots/root", /reserved/],
    ] as const) {
      const res = await authed(path, { method: "DELETE" });
      expect(res.status, path).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_request");
      expect(body.error.message).toMatch(pattern);
    }
    expect(server.callsOf("profiles.delete")).toHaveLength(0);
    expect(server.callsOf("cli.exec")).toHaveLength(0);
  });

  it("M1: one canonical name across chat and delete, so no pin outlives the bot", async () => {
    // `GET /bots/Scout/chat` pinned under "Scout" while `DELETE /bots/scout` forgot "scout": the
    // orphan pin `forgetBot` exists to prevent, plus two independent identities for one bot.
    const names = new Set(["default", "scout"]);
    const { authed, server, storage } = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "session.list": () => ({ sessions: [{ id: "sess-1", title: "Bot Chat" }] }),
        "cli.exec": (params) => {
          names.delete((params["argv"] as string[])[2]!);
          return { blocked: false, code: 0, output: "" };
        },
      },
    });

    await authed("/bots/Scout/chat");
    expect(storage.botChatPin("scout")).toBe("sess-1");
    expect(storage.botChatPin("Scout")).toBeUndefined();

    expect((await authed("/bots/SCOUT", { method: "DELETE" })).status).toBe(204);
    expect(server.callsOf("cli.exec")[0]?.params["argv"]).toEqual(["profile", "delete", "scout", "--yes"]);
    expect(storage.botChatPin("scout")).toBeUndefined();
  });

  it("M2: a slow delete is given room, and its bound is honest when it runs out", async () => {
    // The 30 s client default rejected a delete that was succeeding for real (upstream stops a
    // service and rmtrees a directory), answered 503 "the bridge is not connected", which is
    // factually wrong, and never cleaned up. The call now carries its own bound, and a bound that
    // does run out says so rather than blaming the link.
    const names = new Set(["default", "scout"]);
    const { authed, server } = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "cli.exec": (params) => {
          names.delete((params["argv"] as string[])[2]!);
          return { blocked: false, code: 0, output: "" };
        },
      },
    });
    expect((await authed("/bots/scout", { method: "DELETE" })).status).toBe(204);
    // `cli.exec`'s own timeout rides the params, in SECONDS, well inside its 600 s cap.
    expect(server.callsOf("cli.exec")[0]?.params["timeout"]).toBe(180);
  });

  it("M2: a delete that times out reports it honestly and keeps every local record", async () => {
    const { authed, storage, bridge } = await setup(
      {
        methods: {
          "profiles.list": liveProfiles(new Set(["default", "scout"])),
          // Never answers: the client-side bound is what ends this call.
          "cli.exec": () => NO_REPLY,
        },
      },
      [],
      // A short bound stands in for the 180 s one so the test does not wait three minutes.
      { deleteTimeoutMs: 40 },
    );
    await until(() => bridge.roster().bots.length === 2, 4_000);
    storage.setBotChatPin("scout", "sess-1", NOW);

    const res = await authed("/bots/scout", { method: "DELETE" });
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: { code: string; message: string }; timedOut: boolean };
    expect(body.error.code).toBe("backend_unavailable");
    expect(body.error.message).toMatch(/may still be running/);
    expect(body.timedOut).toBe(true);

    // Nothing local was cleared: the delete may be completing right now, and a pin thrown away for
    // a bot that still exists is a second canonical chat on the next open.
    expect(storage.botChatPin("scout")).toBe("sess-1");
    expect(bridge.roster().bots.map((bot) => bot.name)).toContain("scout");
  });

  it("M3: a look write lost to the transport is `failed`, not the silent `unsupported`", async () => {
    // `unsupported` is documented as the expected, silent fallback on an old gateway. Reporting a
    // dropped socket as that told the app nothing was wrong about a write that really was lost.
    const names = new Set<string>(["default"]);
    const { authed } = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "profiles.create": (params) => {
          names.add(String(params["name"]));
          return {};
        },
      },
      dropOnMethod: ["profiles.configure"],
    });

    const res = await authed("/bots", post({ name: "scout", color: "#ef4444" }));
    // Still 201: `profiles.create` already returned, so the bot exists. Answering 502 here would
    // tell the caller its bot was not made and send its retry into a 409 on a bot it owns.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { metaOutcome: string; metaError?: string };
    expect(body.metaOutcome).toBe("failed");
    expect(body.metaError).toBeTypeOf("string");
  });

  it("minor 1: deleting a bot that is not there answers 404, not a raw 502", async () => {
    const { authed } = await setup({
      methods: {
        "profiles.list": liveProfiles(new Set(["default"])),
        "cli.exec": () => ({ blocked: false, code: 1, output: "Error: profile 'ghost' does not exist" }),
      },
    });
    const res = await authed("/bots/ghost", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("minor 2: a delete cancels the bot's live turn poll instead of leaving it broadcasting", async () => {
    const names = new Set(["default", "scout"]);
    const { authed, bridge, frames } = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "session.list": () => ({ sessions: [{ id: "sess-1", title: "Bot Chat" }] }),
        "session.resume": () => ({
          session_id: "runtime-1",
          session_key: "k",
          message_count: 0,
          running: true,
          inflight: false,
          messages: [],
        }),
        "prompt.submit": () => ({ ok: true }),
        "cli.exec": (params) => {
          names.delete((params["argv"] as string[])[2]!);
          return { blocked: false, code: 0, output: "" };
        },
      },
    });
    await until(() => bridge.roster().bots.length === 2, 4_000);

    expect((await authed("/bots/scout/chat/messages", post({ text: "hi" }))).status).toBe(202);
    await until(() => bridge.chatPolling("scout"), 4_000);

    expect((await authed("/bots/scout", { method: "DELETE" })).status).toBe(204);
    expect(bridge.chatPolling("scout")).toBe(false);

    // No further chat frames for a bot that is off the roster.
    const before = frames.filter((frame) => frame.type === "bot_chat" || frame.type === "bot_chat_state").length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = frames.filter((frame) => frame.type === "bot_chat" || frame.type === "bot_chat_state").length;
    expect(after).toBe(before);
  });

  it("minor 3: two racing creates of one name cost exactly one profiles.create", async () => {
    const names = new Set<string>(["default"]);
    const { authed, server } = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "profiles.create": (params) => {
          const name = String(params["name"]);
          if (names.has(name)) throw { code: 4062, message: `Profile '${name}' already exists at /x` };
          names.add(name);
          return {};
        },
        "profiles.configure": () => ({ applied: { ui_meta: true } }),
      },
    });

    const [a, b] = await Promise.all([
      authed("/bots", post({ name: "scout" })),
      authed("/bots", post({ name: "Scout" })),
    ]);
    expect([a!.status, b!.status]).toEqual([201, 201]);
    expect(server.callsOf("profiles.create")).toHaveLength(1);
  });

  it("minor 4: the profile the bridge itself runs on cannot be deleted from here", async () => {
    const { authed, server } = await setup(
      { methods: { "profiles.list": liveProfiles(new Set(["default", "scout"])) } },
      [],
      { bridgeProfile: "Scout" },
    );
    const res = await authed("/bots/scout", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/own hermes link/i);
    expect(server.callsOf("cli.exec")).toHaveLength(0);
    expect(server.callsOf("profiles.delete")).toHaveLength(0);
  });
});

/** GET /bots/probe-bot/chat for a name Hermes never heard of answered 200 with `adoption: "created"`:
 *  `session.create` does not itself validate the profile it is handed, so the bridge minted a live
 *  chat session for a profile that was never there, and the follow-up `POST .../chat/messages` 202'd
 *  into the void. Every `/bots/:name/*` route must 404 `not_found` on such a name instead, checked
 *  against a fresh `profiles.list` on a cache miss so neither a just-created bot nor a hidden one is
 *  wrongly caught by it. */
describe("unknown bot (contract/ext-bots-v1.md section 4)", () => {
  it("404s chat, chat history, chat send, sessions and delete, without minting anything hermes-side", async () => {
    const { authed, server } = await setup({
      methods: {
        "profiles.list": liveProfiles(new Set(["default"])),
        "session.create": () => ({ stored_session_id: "stored-1", session_id: "runtime-1" }),
        "session.list": () => ({ sessions: [] }),
        "prompt.submit": () => ({ ok: true }),
        "cli.exec": () => ({ blocked: false, code: 1, output: "Error: profile 'probe-bot' does not exist" }),
      },
    });

    const sessionListCallsBefore = server.callsOf("session.list").length;

    const chat = await authed("/bots/probe-bot/chat");
    expect(chat.status).toBe(404);
    expect(((await chat.json()) as { error: { code: string } }).error.code).toBe("not_found");

    const history = await authed("/bots/probe-bot/chat/messages");
    expect(history.status).toBe(404);
    expect(((await history.json()) as { error: { code: string } }).error.code).toBe("not_found");

    const send = await authed("/bots/probe-bot/chat/messages", post({ text: "hello?" }));
    expect(send.status).toBe(404);
    expect(((await send.json()) as { error: { code: string } }).error.code).toBe("not_found");

    const sessions = await authed("/bots/probe-bot/sessions");
    expect(sessions.status).toBe(404);
    expect(((await sessions.json()) as { error: { code: string } }).error.code).toBe("not_found");

    const del = await authed("/bots/probe-bot", { method: "DELETE" });
    expect(del.status).toBe(404);

    // The exact bug this closes: nothing hermes-side was ever touched for a profile that is not
    // there, the canonical chat's own mint (`session.create`) included.
    expect(server.callsOf("session.create")).toHaveLength(0);
    expect(server.callsOf("session.list")).toHaveLength(sessionListCallsBefore);
    expect(server.callsOf("prompt.submit")).toHaveLength(0);
  });

  it("a bot created moments ago is immediately chattable, not 404'd by a stale cache", async () => {
    const names = new Set<string>(["default"]);
    const { authed, server, bridge } = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "profiles.create": (params) => {
          names.add(String(params["name"]));
          return {};
        },
        "profiles.configure": () => ({ applied: { ui_meta: true } }),
        "session.list": () => ({ sessions: [] }),
        "session.create": () => ({ stored_session_id: "stored-1", session_id: "runtime-1" }),
        "prompt.submit": () => ({ ok: true }),
      },
    });
    // Let the connect-time refresh (and its trailing debounce) settle before measuring, so it is
    // never mistaken for a round trip the chat guard caused.
    await until(() => bridge.roster().bots.length >= 1, 4_000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const created = await authed("/bots", post({ name: "scout" }));
    expect(created.status).toBe(201);

    // The roster cache already carries `scout` (`createBot` awaits its own refresh before
    // answering 201), so the unknown-bot guard is satisfied from the cache, no extra round trip.
    const before = server.calls().length;
    const chat = await authed("/bots/scout/chat");
    expect(chat.status).toBe(200);
    expect(await chat.json()).toMatchObject({ name: "scout", adoption: "created" });

    // The unknown-bot guard is satisfied from the roster cache `createBot` already refreshed, so
    // the FIRST call this resolve makes is `session.list`, not another `profiles.list` spent just
    // to confirm a bot the gateway itself just created still exists. (A later `profiles.list` is
    // expected: it is the unrelated, pre-existing pin-writeback read.)
    expect(server.calls().slice(before).map((call) => call.method)[0]).toBe("session.list");
  });

  /** The same auto-create hazard the group rooms were bitten by, on the 1:1 path: the unknown-bot
   *  guard is satisfied from the roster cache, and a cache is only ever as young as its last
   *  refresh. Everywhere else a stale yes costs one 404 that Hermes hands back a moment later, but
   *  `session.create` does not answer 404 for a name it does not know, it CREATES the profile. So the
   *  one path that mints a chat re-checks, fresh, immediately before it does. */
  it("does not mint a chat for a bot the cache still lists but hermes no longer has", async () => {
    const names = new Set<string>(["default", "scout"]);
    const { authed, server, bridge } = await setup({
      methods: {
        "profiles.list": liveProfiles(names),
        "session.list": () => ({ sessions: [] }),
        "session.create": () => ({ stored_session_id: "stored-1", session_id: "runtime-1" }),
        "prompt.submit": () => ({ ok: true }),
      },
    });
    await until(() => bridge.roster().bots.some((bot) => bot.name === "scout"), 4_000);

    // Deleted behind the bridge's back, with no refresh behind it: the cache is as stale as it was
    // when this happened live.
    names.delete("scout");
    expect(bridge.roster().bots.map((bot) => bot.name)).toContain("scout");

    const chat = await authed("/bots/scout/chat");
    expect(chat.status).toBe(404);
    expect(((await chat.json()) as { error: { code: string } }).error.code).toBe("not_found");
    // Nothing was minted, so nothing was resurrected.
    expect(server.callsOf("session.create")).toHaveLength(0);
    expect(server.callsOf("prompt.submit")).toHaveLength(0);
  });

  it("a hidden bot is resolved off a fresh profiles.list rather than read as unknown", async () => {
    const { authed } = await setup(
      {
        methods: {
          "profiles.list": liveProfiles(new Set(["default", "ops-runner"])),
          "session.list": () => ({ sessions: [{ id: "s1", title: "Bot Chat", preview: null, source: "cli" }] }),
        },
      },
      ["ops-runner"],
    );

    // Hidden bots never land in the roster cache by design, so this exercises the fresh-read arm
    // of the same guard the unknown-bot case takes, and it must resolve, not 404.
    const chat = await authed("/bots/ops-runner/chat");
    expect(chat.status).toBe(200);
    expect(await chat.json()).toMatchObject({ name: "ops-runner", sessionId: "s1", adoption: "title" });

    const sessions = await authed("/bots/ops-runner/sessions");
    expect(sessions.status).toBe(200);
  });
});

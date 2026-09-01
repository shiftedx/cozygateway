import { afterEach, describe, expect, it } from "vitest";
import { BOTS_CAPABILITY_VERSION } from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { resolveAttachBearer, revokeAttachTokens } from "../src/adapters/attach/token-auth.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 37, `DELETE /bots/:name`. The promise under test is "no traces remaining", so the
 *  assertions are about what is GONE rather than what the reply says: the profile delete really
 *  rides the Hermes dashboard wire (fake Hermes, not a mocked bridge), every seeded gateway row
 *  really disappears, and the attach identity really stops resolving. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};

const NOW = 1_800_000_000_000;
const BOT = "night-owl";
const KEEPER = "day-owl";

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

interface DashboardCall {
  method: string;
  path: string;
}

interface Harness {
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  /** The app with NO device token injected, for the authentication test. */
  raw: (path: string, init?: RequestInit) => Promise<Response>;
  storage: Storage;
  dashboard: DashboardCall[];
  /** Every name passed to the revocation hook, in call order. */
  revoked: string[];
  /** Whether the roster still held the bot at the moment revocation was asked for. Proves the
   *  identity dies BEFORE the sweep rather than after it. */
  rosterAliveAtRevoke: boolean[];
  /** Whether the fake Hermes still has the profile directory. */
  hermesHas: (name: string) => boolean;
}

async function setup(
  opts: {
    /** Status the fake dashboard answers a profile DELETE with. Default: really delete it. */
    deleteStatus?: number;
  } = {},
): Promise<Harness> {
  const names = new Set<string>(["default", BOT, KEEPER]);
  const dashboard: DashboardCall[] = [];
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({
        profiles: [...names].map((name) => ({ name, description: "", has_avatar: false })),
        bot_mode_protocol: true,
      }),
    },
    dashboard: (request) => {
      dashboard.push({ method: request.method, path: request.path });
      const match = /^\/api\/profiles\/([^/]+)$/.exec(request.path);
      if (request.method === "DELETE" && match !== null) {
        const name = decodeURIComponent(match[1] ?? "");
        if (opts.deleteStatus !== undefined && opts.deleteStatus !== 200)
          return { status: opts.deleteStatus, body: { detail: "the dashboard said no" } };
        if (!names.has(name)) return { status: 404, body: { detail: `Profile '${name}' does not exist.` } };
        // The real dashboard removes the whole profile directory here.
        names.delete(name);
        return { body: { ok: true, path: `/home/h/.hermes/profiles/${name}` } };
      }
      return { body: { ok: true } };
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const revoked: string[] = [];
  const rosterAliveAtRevoke: boolean[] = [];
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: () => {},
    now: () => NOW,
    logSink: () => {},
    revokeAttachIdentity: (name) => {
      revoked.push(name);
      rosterAliveAtRevoke.push(storage.botRoster().bots.some((bot) => bot.name === name));
      return true;
    },
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: {
      name: "g",
      version: "0.1.0",
      contract: "v1",
      capabilities: { "com.cozylabs.bots": BOTS_CAPABILITY_VERSION },
    },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("unused");
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
  await until(() => storage.botRoster().bots.length > 0);
  const raw = async (path: string, init?: RequestInit): Promise<Response> => app.request(path, init);
  return { authed, raw, storage, dashboard, revoked, rosterAliveAtRevoke, hermesHas: (n) => names.has(n) };
}

/** Writes one row into every durable area a bot owns, so the purge has something to prove.
 *  Returns the session id, which several of the rows are keyed by. */
function seedEverything(storage: Storage, bot: string, deviceId: string): string {
  const { sessionId } = storage.nativeBotChat(bot, NOW);
  storage.appendNativeBotMessage({
    bot, sessionId, messageId: `${bot}-m1`, role: "user", text: "hello", at: NOW,
  });
  storage.recordBotMessageDisplayed(bot, [`${bot}-m1`], deviceId, NOW);
  storage.bindTurnMediaDelivery(bot, `${bot}-m1`, `turn:${bot}-t1`);
  storage.upsertBotChatToolStep({
    bot, sessionId, turnId: `${bot}-t1`, stepId: "s1", seq: 1, name: "file", status: "running",
    startedAt: NOW, endedAt: undefined,
  });
  storage.upsertBotChatDelegation({
    bot, sessionId, turnId: `${bot}-t1`, batchId: "b1", childId: "c1", index: 0, count: 1,
    status: "running", lastActiveAt: NOW, startedAt: NOW, endedAt: undefined,
  });
  storage.setBotRoutineOverrides(bot, "r1", { model: "sonnet" });
  storage.recordNativeInteraction({
    bot, kind: "approval", interactionId: "i1", sessionId, turnId: `${bot}-t1`,
    payload: { toolCallId: "i1", name: "file" }, status: "pending", updatedAt: NOW,
  });
  storage.recordNativeBotTerminal({
    bot, sessionId, turnId: `${bot}-t1`, status: "interrupted", cause: "cancelled", completedAt: NOW,
  });
  storage.recordBotMobileReceipt({
    requestId: `${bot}-phone-1`, bot, sessionId, turnId: `${bot}-t1`, command: "device.status",
    sharedDescription: "Device status", purpose: "Check phone status", sharedAt: NOW,
  });
  storage.enqueueAttachCommand(
    bot,
    "cmd-1",
    { kind: "turn", threadId: `bot:${bot}`, turnId: `${bot}-t1`, messageId: `${bot}-m1`, text: "go" },
    NOW,
  );
  storage.saveAttachMedia(
    bot,
    {
      mediaId: `${bot}-media-1`, mimeType: "image/png", byteCount: 3, sha256: "a".repeat(64),
      filename: "pic.png", family: "image",
    },
    new Uint8Array([1, 2, 3]),
    NOW,
  );
  storage.saveLiveActivityRegistration({
    deviceId, activityId: `${bot}-act-1`, runId: `${bot}-run-1`,
    conversationId: sessionId, bot, pushId: `${bot}-push-1`, createdAt: NOW,
  });
  // The bot's half of the core thread surface.
  storage.upsertAgent({ id: bot, name: bot, avatar: null, backend: "attach" });
  storage.createThread({ id: `thread-${bot}`, agentId: bot, title: "t", createdAt: NOW });
  storage.appendMessage(`thread-${bot}`, { role: "user", blocks: [{ type: "paragraph", text: "hi" }] }, NOW);
  return sessionId;
}

/** Every delete in this file is the same bare request; the query string, when a test needs one,
 *  rides the path. */
/** The paired device is the only id `live_activity_registrations` will accept (it carries an FK
 *  to `devices`), so the seed always runs against the one this harness actually paired. */
function seed(h: Harness, bot: string): string {
  const deviceId = h.storage.listDevices()[0]?.id;
  if (deviceId === undefined) throw new Error("the harness paired no device");
  return seedEverything(h.storage, bot, deviceId);
}

const DELETE_REQUEST: RequestInit = { method: "DELETE" };

describe("DELETE /bots/:name deletes the profile and purges the gateway", () => {
  it("removes the Hermes profile, purges every table, and revokes the identity", async () => {
    const h = await setup();
    seed(h, BOT);
    seed(h, KEEPER);

    const res = await h.authed(`/bots/${BOT}`, DELETE_REQUEST);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      hermesProfile: string;
      purged: Record<string, number>;
      tokenRevoked: boolean;
      residue: string[];
    };

    // The profile delete rode the real dashboard wire, not a mock of the bridge.
    expect(h.dashboard).toContainEqual({ method: "DELETE", path: `/api/profiles/${BOT}` });
    expect(h.hermesHas(BOT)).toBe(false);
    expect(body.name).toBe(BOT);
    expect(body.hermesProfile).toBe("deleted");
    expect(body.tokenRevoked).toBe(true);
    expect(body.residue.length).toBeGreaterThan(0);

    // Every area that was seeded reports a purge, and nothing is left for a second sweep.
    for (const area of [
      "roster", "toolSteps", "delegations", "routineOverrides", "chatPointer", "sessions",
      "messages", "receipts", "mobileReceipts", "turnMediaDeliveries", "interactions", "turnTerminals",
      "attachStream", "attachCommands", "attachMedia", "liveActivities",
      "coreMessages", "coreThreads", "agentRow",
    ]) {
      expect(body.purged[area], `expected ${area} rows to be purged`).toBeGreaterThan(0);
    }
    expect(h.storage.purgeBot(BOT)).toEqual({});

    // Reads agree with the report, and the OTHER bot is untouched throughout.
    expect(h.storage.botRoster().bots.some((b) => b.name === BOT)).toBe(false);
    expect(h.storage.nativeBotMessages(BOT, `${BOT}-x`)).toEqual([]);
    expect(h.storage.threadById(`thread-${BOT}`)).toBeUndefined();
    expect(h.storage.listAgents().some((a) => a.id === BOT)).toBe(false);
    expect(h.storage.listAgents().some((a) => a.id === KEEPER)).toBe(true);
    expect(h.storage.threadById(`thread-${KEEPER}`)).toBeDefined();
    expect(h.storage.liveActivityRegistrations(KEEPER).length).toBe(1);
    expect(h.storage.liveActivityRegistrations(BOT).length).toBe(0);
    expect(h.hermesHas(KEEPER)).toBe(true);
  });

  it("revokes the attach identity BEFORE the sweep, so nothing can race the purge", async () => {
    const h = await setup();
    seed(h, BOT);

    expect((await h.authed(`/bots/${BOT}`, DELETE_REQUEST)).status).toBe(200);
    expect(h.revoked).toEqual([BOT]);
    // The roster row was still there when revocation was asked for: the identity died first.
    expect(h.rosterAliveAtRevoke).toEqual([true]);
  });

  it("reports already_absent when Hermes no longer has the profile but rows remain", async () => {
    const h = await setup();
    seed(h, BOT);
    // Hermes lost the profile some other way; the gateway's own rows are the recovery case.
    const first = await h.authed(`/bots/${BOT}`, DELETE_REQUEST);
    expect(first.status).toBe(200);
    // Put rows back without the profile existing on the host, then delete again.
    seed(h, BOT);
    const second = await h.authed(`/bots/${BOT}`, DELETE_REQUEST);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { hermesProfile: string; purged: Record<string, number> };
    expect(body.hermesProfile).toBe("already_absent");
    expect(body.purged["sessions"]).toBeGreaterThan(0);
  });

  it("refuses a running turn with 409 and names it, and force=1 proceeds", async () => {
    const h = await setup();
    const sessionId = seed(h, BOT);
    h.storage.setNativeBotTurn(BOT, sessionId, "turn-live", NOW);

    const refused = await h.authed(`/bots/${BOT}`, DELETE_REQUEST);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { code: string }; turnId: string };
    expect(body.error.code).toBe("conflict");
    expect(body.turnId).toBe("turn-live");
    // A refusal changes nothing anywhere: the profile is still on the host and the rows survive.
    expect(h.hermesHas(BOT)).toBe(true);
    expect(h.storage.botRoster().bots.some((b) => b.name === BOT)).toBe(true);
    expect(h.revoked).toEqual([]);

    const forced = await h.authed(`/bots/${BOT}?force=1`, DELETE_REQUEST);
    expect(forced.status).toBe(200);
    expect(h.hermesHas(BOT)).toBe(false);
    expect(h.storage.purgeBot(BOT)).toEqual({});
  });

  it("answers 404 in the ordinary not-found shape for a bot nobody knows", async () => {
    const h = await setup();
    seed(h, BOT);

    expect((await h.authed(`/bots/${BOT}`, DELETE_REQUEST)).status).toBe(200);
    // Idempotence is a clean not-found, never a second success.
    const again = await h.authed(`/bots/${BOT}`, DELETE_REQUEST);
    expect(again.status).toBe(404);
    expect((await again.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_found" },
    });

    const never = await h.authed("/bots/ghost-bot", DELETE_REQUEST);
    expect(never.status).toBe(404);
  });

  it("refuses a reserved name with 400 and never calls Hermes", async () => {
    const h = await setup();
    const res = await h.authed("/bots/default", DELETE_REQUEST);
    expect(res.status).toBe(400);
    expect(h.dashboard.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("purges NOTHING when Hermes refuses the profile delete", async () => {
    const h = await setup({ deleteStatus: 500 });
    seed(h, BOT);

    const res = await h.authed(`/bots/${BOT}`, DELETE_REQUEST);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "backend_unavailable" },
    });
    // A gateway that dropped its rows while the bot kept running on its host would be the exact
    // opposite of what this route promises.
    expect(h.storage.botRoster().bots.some((b) => b.name === BOT)).toBe(true);
    expect(h.storage.nativeBotActiveTurn(BOT)).toBeUndefined();
    expect(h.storage.purgeBot(BOT)["sessions"]).toBeGreaterThan(0);
    expect(h.revoked).toEqual([]);
  });

  it("requires device authentication", async () => {
    const h = await setup();
    // No device token at all, then a token that names no device: neither reaches the bridge.
    expect((await h.raw(`/bots/${BOT}`, DELETE_REQUEST)).status).toBe(401);
    expect(
      (await h.raw(`/bots/${BOT}`, { method: "DELETE", headers: { authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
    expect(h.dashboard.some((call) => call.method === "DELETE")).toBe(false);
  });
});

describe("capability 37 is additive", () => {
  it("advertises the bumped integer and adds no field to any pre-37 shape", async () => {
    const h = await setup();
    expect(BOTS_CAPABILITY_VERSION).toBe(48);

    const before = (await (await h.authed("/bots")).json()) as { bots: Array<Record<string, unknown>> };
    expect((await h.authed(`/bots/${BOT}`, DELETE_REQUEST)).status).toBe(200);
    const after = (await (await h.authed("/bots")).json()) as { bots: Array<Record<string, unknown>> };

    // A client below 37 never calls the route, and the surface it DOES read is unchanged: the
    // surviving row carries exactly the keys it carried before, one row fewer on the roster.
    const keeperBefore = before.bots.find((b) => b["name"] === KEEPER);
    const keeperAfter = after.bots.find((b) => b["name"] === KEEPER);
    expect(keeperAfter).toEqual(keeperBefore);
    expect(after.bots.length).toBe(before.bots.length - 1);
  });
});

describe("attach token revocation", () => {
  it("stops the revoked bot resolving while leaving every other identity alone", () => {
    const tokens = new Map<string, string>([
      ["token-night", BOT],
      ["token-day", KEEPER],
    ]);
    expect(resolveAttachBearer(tokens, "Bearer token-night")).toBe(BOT);

    expect(revokeAttachTokens(tokens, BOT)).toBe(true);
    expect(resolveAttachBearer(tokens, "Bearer token-night")).toBeUndefined();
    expect(resolveAttachBearer(tokens, "Bearer token-day")).toBe(KEEPER);
    // Idempotent: a second revocation held nothing.
    expect(revokeAttachTokens(tokens, BOT)).toBe(false);
  });
});

/** Mobile approve/deny for bot chats, end to end against a fake Hermes (issue #19, bridge lane;
 *  ext-bots capability 10).
 *
 *  Everything here is the real bridge, the real routes and the real device auth. The only fake is
 *  Hermes itself, and what it speaks is the surface the 2026-08-19 probe read off 0.20.3/0.20.4
 *  source: an `approval.request` event carrying `request_id` / `command` / `description` /
 *  `pattern_key`, and an `approval.respond` RPC answering `{"resolved": <int>}`.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Message, RichBlock, ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import type { BotApprovalPush } from "../src/hermes-bridge/approvals.ts";
import { CANONICAL_CHAT_TITLE } from "../src/hermes-bridge/canonical-chat.ts";
import {
  startFakeHermesServer,
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
const REQUEST_ID = "4e8b2c1d9f0a4c1e8b2c1d9f0a4c1e8b";
const SECRET = "secret-token-abc";

type PendingFrame = Extract<ServerFrame, { type: "bot_approval_pending" }>;
type ResolvedFrame = Extract<ServerFrame, { type: "bot_approval_resolved" }>;

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

/** The probe's `approval.request` payload, in shape and in spirit: the free text carries something
 *  that must never leave the gateway. */
function approvalPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: REQUEST_ID,
    command: `rm -rf /tmp/${SECRET}`,
    description: `delete a directory called ${SECRET}`,
    pattern_key: "terminal:rm",
    pattern_keys: ["terminal:rm"],
    allow_permanent: true,
    allow_session: true,
    choices: ["once", "session", "always", "deny"],
    ...overrides,
  };
}

/** A hermes with one bot, one canonical chat, and whatever `approval.respond` the test wants. */
function fakeBot(respond?: (params: Record<string, unknown>) => unknown): FakeHermesBehavior {
  const stored = "canonical";
  const runtime = "runtime-1";
  return {
    methods: {
      "profiles.list": () => ({
        profiles: [
          {
            name: "scout",
            description: "watches CI",
            has_avatar: false,
            last_session: { last_active: Math.round(NOW / 1000) - 5, preview: "all green" },
            ui_meta: { "hermes-bots": { title: "Scout", chat: stored } },
          },
        ],
        bot_mode_protocol: true,
      }),
      "session.list": () => ({ sessions: [{ id: stored, title: CANONICAL_CHAT_TITLE }] }),
      "prompt.submit": (params) => {
        if (params["session_id"] !== runtime) {
          throw { code: 5003, message: `prompt.submit needs the runtime session id` };
        }
        return { ok: true };
      },
      "session.resume": (params) => ({
        session_id: runtime,
        session_key: "k",
        message_count: 0,
        running: false,
        inflight: false,
        ...(params["omit_messages"] === true ? {} : { messages: [] }),
      }),
      "profiles.configure": () => ({ applied: { ui_meta: true } }),
      ...(respond === undefined ? {} : { "approval.respond": respond }),
    },
  };
}

interface Harness {
  server: FakeHermesServer;
  bridge: HermesBridge;
  frames: ServerFrame[];
  pushes: BotApprovalPush[];
  audit: string[];
  logs: string[];
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Puts a turn on the wire so the stream learns which bot the runtime session belongs to, which
   *  is the same thing that has to be true for a draft to render. */
  openTurn: () => Promise<void>;
  pendings: () => PendingFrame[];
  resolveds: () => ResolvedFrame[];
}

async function setup(behavior: FakeHermesBehavior, opts: { approvalTimeoutMs?: number } = {}): Promise<Harness> {
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
  const pushes: BotApprovalPush[] = [];
  const audit: string[] = [];
  const logs: string[] = [];
  let clock = NOW;
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => (clock += 1),
    logSink: (line) => logs.push(line),
    chatPollMs: 10,
    chatTurnTimeoutMs: 500,
    chatDeltaThrottleMs: 10,
    onApproval: (event) => pushes.push(event),
    approvalLog: (line) => audit.push(line),
    ...(opts.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: opts.approvalTimeoutMs }),
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 10 } },
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

  const authed = async (path: string, init?: RequestInit): Promise<Response> =>
    app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } });

  return {
    server,
    bridge,
    frames,
    pushes,
    audit,
    logs,
    authed,
    request: async (path, init) => app.request(path, init),
    openTurn: async () => {
      const res = await authed("/bots/scout/chat/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "run the deploy" }),
      });
      expect(res.status).toBe(202);
    },
    pendings: () => frames.filter((f): f is PendingFrame => f.type === "bot_approval_pending"),
    resolveds: () => frames.filter((f): f is ResolvedFrame => f.type === "bot_approval_resolved"),
  };
}

describe("bot approvals, end to end", () => {
  it("fans an approval.request out as a bot_approval_pending frame and approves it with `once`", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 1 })));
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pendings().length === 1);

    const pending = h.pendings()[0]!;
    expect(pending).toMatchObject({
      bot: "scout",
      // The STORED id, the one every other bots frame is keyed on.
      sessionId: "canonical",
      toolCallId: REQUEST_ID,
      name: "terminal:rm",
    });
    expect(pending.turnId.length).toBeGreaterThan(0);

    const res = await h.authed(`/bots/scout/approvals/${REQUEST_ID}/approve`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "approved" });

    // Addressed by request_id against the RUNTIME session, with the least-privilege scope. The
    // client sent neither of those: both came off the gateway's own record.
    expect(h.server.callsOf("approval.respond").map((call) => call.params)).toEqual([
      { session_id: "runtime-1", request_id: REQUEST_ID, choice: "once" },
    ]);
    await until(() => h.resolveds().length === 1);
    expect(h.resolveds()[0]).toMatchObject({
      bot: "scout",
      sessionId: "canonical",
      turnId: pending.turnId,
      toolCallId: REQUEST_ID,
      outcome: "approved",
    });
  });

  it("denies with `deny`, and audits the decision without describing the action", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 1 })));
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pendings().length === 1);

    const res = await h.authed(`/bots/scout/approvals/${REQUEST_ID}/deny`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "denied" });
    expect(h.server.callsOf("approval.respond")[0]!.params["choice"]).toBe("deny");

    const line = h.audit.join("\n");
    expect(line).toContain("approval denied");
    expect(line).toContain("bot=scout");
    expect(line).toContain(`toolCall=${REQUEST_ID}`);
    expect(line).not.toContain(SECRET);
  });

  it("never lets the hermes free text reach a frame, a push, an audit line, or a log line", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 1 })));
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pendings().length === 1);
    await h.authed(`/bots/scout/approvals/${REQUEST_ID}/approve`, { method: "POST" });
    await until(() => h.resolveds().length === 1);

    const everything = JSON.stringify({
      frames: h.frames,
      pushes: h.pushes,
      audit: h.audit,
      logs: h.logs,
      calls: h.server.calls(),
    });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("rm -rf");
  });

  it("raises the out-of-band pushes, pending then resolved, with no argument summary", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 1 })));
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pushes.length === 1);
    await h.authed(`/bots/scout/approvals/${REQUEST_ID}/deny`, { method: "POST" });
    await until(() => h.pushes.length === 2);
    expect(h.pushes.map((push) => push.kind)).toEqual(["approval_pending", "approval_resolved"]);
    expect(h.pushes[0]).toMatchObject({ bot: "scout", toolCallId: REQUEST_ID, name: "terminal:rm" });
    expect(h.pushes[0]).not.toHaveProperty("argSummary");
    expect(h.pushes[1]).toMatchObject({ outcome: "denied" });
  });

  it("resolves two pendings in one session independently, which the FIFO /approve path could not", async () => {
    // The reason the RPC was chosen over the injected slash command: `/approve` resolves the
    // FIFO-oldest entry and cannot name a request_id, so this is the test it would fail.
    const h = await setup(fakeBot(() => ({ resolved: 1 })));
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload({ request_id: "id-one" }), "runtime-1");
    h.server.sendEvent(
      "approval.request",
      approvalPayload({ request_id: "id-two", pattern_key: "execute_code:python" }),
      "runtime-1",
    );
    await until(() => h.pendings().length === 2);

    expect((await h.authed("/bots/scout/approvals/id-two/deny", { method: "POST" })).status).toBe(202);
    expect(h.server.callsOf("approval.respond").map((c) => c.params["request_id"])).toEqual(["id-two"]);
    expect(h.resolveds().map((f) => f.toolCallId)).toEqual(["id-two"]);
    // The older one is untouched and still answerable.
    expect((await h.authed("/bots/scout/approvals/id-one/approve", { method: "POST" })).status).toBe(202);
    expect(h.resolveds().map((f) => f.toolCallId)).toEqual(["id-two", "id-one"]);
  });

  it("answers the second decision on the same approval with 409, and emits no second frame", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 1 })));
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pendings().length === 1);
    await h.authed(`/bots/scout/approvals/${REQUEST_ID}/approve`, { method: "POST" });
    const res = await h.authed(`/bots/scout/approvals/${REQUEST_ID}/deny`, { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "approval_not_pending" },
    });
    expect(h.resolveds()).toHaveLength(1);
  });

  it("maps hermes {resolved: 0} to 409 approval_expired and one expired frame", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 0 })));
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pendings().length === 1);

    const res = await h.authed(`/bots/scout/approvals/${REQUEST_ID}/approve`, { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "approval_expired" },
    });
    expect(h.resolveds().map((f) => f.outcome)).toEqual(["expired"]);
  });

  it("synthesizes `expired` from its own timer, because hermes emits no expiry event", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 1 })), { approvalTimeoutMs: 40 });
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pendings().length === 1);
    await until(() => h.resolveds().length === 1, 2_000);
    expect(h.resolveds()[0]!.outcome).toBe("expired");
    // Hermes was never told: it already dropped the entry itself.
    expect(h.server.callsOf("approval.respond")).toEqual([]);
    const res = await h.authed(`/bots/scout/approvals/${REQUEST_ID}/approve`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("404s an unknown correlation id and one belonging to a different bot", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 1 })));
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pendings().length === 1);

    expect((await h.authed("/bots/scout/approvals/nope/approve", { method: "POST" })).status).toBe(404);
    // Same id, a different bot in the path: still 404, because records are per bot.
    expect((await h.authed(`/bots/pixel/approvals/${REQUEST_ID}/approve`, { method: "POST" })).status).toBe(404);
    expect(h.server.callsOf("approval.respond")).toEqual([]);
  });

  it("503s when this hermes has no approval.respond, and leaves the approval pending", async () => {
    // No `approval.respond` handler at all: the fake answers `unknown method`, which is what an
    // older hermes does.
    const h = await setup(fakeBot());
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pendings().length === 1);

    const res = await h.authed(`/bots/scout/approvals/${REQUEST_ID}/approve`, { method: "POST" });
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "backend_unavailable" },
    });
    // Nothing announced: the decision did not land, so the approval is still awaiting one.
    expect(h.resolveds()).toEqual([]);
    expect(h.bridge.approvalPending("scout", REQUEST_ID)).toBe(true);
  });

  it("refuses a device-less request before it reaches the bridge", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 1 })));
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pendings().length === 1);

    const res = await h.request(`/bots/scout/approvals/${REQUEST_ID}/approve`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(h.server.callsOf("approval.respond")).toEqual([]);
  });

  it("drops an approval for a hermes session this gateway is not driving", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 1 })));
    await h.openTurn();
    // A human at the hermes desktop, in a session this gateway never submitted into.
    h.server.sendEvent("approval.request", approvalPayload(), "some-other-session");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.pendings()).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/not driving/i);
  });

  it("does not double-emit when the same entry arrives twice (the reconnect replay)", async () => {
    const h = await setup(fakeBot(() => ({ resolved: 1 })));
    await h.openTurn();
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await until(() => h.pendings().length === 1);
    h.server.sendEvent("approval.request", approvalPayload(), "runtime-1");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.pendings()).toHaveLength(1);
    expect(h.pushes.filter((push) => push.kind === "approval_pending")).toHaveLength(1);
  });
});

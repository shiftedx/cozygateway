import { afterEach, describe, expect, it } from "vitest";
import { BotRelayDeliverResponseSchema, BotRelayPendingFrameSchema, check, type ServerFrame } from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { RELAY_DELIVER_TIMEOUT_MS } from "../src/hermes-bridge/relay.ts";
import { parseProfileRow } from "../src/hermes-bridge/roster.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 87: the relay courier's doors. The phone is the courier (upstream `relay.ts`); the
 *  gateway only forwards `bot_relay.roster.sync`, `.outbox.drain`, `.deliver` and `.reply` to its
 *  Hermes, in Hermes's own param names, and turns `bot_relay.outbox.pending` into a frame. The fake
 *  answers in the shapes of `tui_gateway/methods_bot_relay.py` at hermes-agent 068db016fb. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};

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

const ENVELOPE = {
  id: "5f0c",
  created_at: 1_800_000_000,
  from_profile: "pixel",
  from_handle: "pixel",
  target_connection: "mac-studio",
  target_profile: "cleo",
  target_handle: "cleo",
  message: "Message from 🤖 Pixel (@pixel): S7 relay test",
};

async function setup(opts: { failDeliver?: { code: number; message: string; data?: unknown } } = {}) {
  const frames: ServerFrame[] = [];
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({ profiles: [{ name: "pixel", ui_meta: null }], bot_mode_protocol: true }),
      "bot_relay.roster.sync": (params) => ({ count: (params["agents"] as unknown[]).length }),
      "bot_relay.outbox.drain": () => ({ envelopes: [ENVELOPE] }),
      "bot_relay.deliver": () => {
        if (opts.failDeliver !== undefined) throw opts.failDeliver;
        return { reply: "hello from pixel" };
      },
      "bot_relay.reply": () => ({ ok: true }),
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "T" }, reconnect: { minMs: 15, maxMs: 60 } });
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => 1_800_000_000_000,
    logSink: () => {},
  });
  bridges.push(bridge);
  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 87 } },
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
  bridge.start();
  await until(() => client.state() === "online");
  const post = (path: string, body: unknown = {}, token: string | null = deviceToken) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    });
  return { server, frames, post };
}

describe("relay routes (capability 87)", () => {
  it("forwards the roster push verbatim, in Hermes's own row shape", async () => {
    const { server, post } = await setup();
    const agents = [
      { profile: "cleo", handle: "cleo", connection_id: "mac-studio", connection_label: "Mac Studio", title: "Cleo", description: "" },
    ];
    const res = await post("/bot-relay/roster", { agents });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 1 });
    expect(server.callsOf("bot_relay.roster.sync").at(-1)?.params).toEqual({ agents });
  });

  it("refuses a roster row whose connection id Hermes would drop", async () => {
    const { post } = await setup();
    const res = await post("/bot-relay/roster", { agents: [{ profile: "cleo", handle: "cleo", connection_id: "mac studio!" }] });
    expect(res.status).toBe(400);
  });

  it("drains the outbox and hands the envelopes back unchanged", async () => {
    const { post } = await setup();
    const res = await post("/bot-relay/drain");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ envelopes: [ENVELOPE] });
  });

  it("delivers with upstream's param names and the long turn budget", async () => {
    const { server, post } = await setup();
    const res = await post("/bot-relay/deliver", {
      profile: "pixel",
      message: "Message from 🤖 Cleo (@cleo): hi",
      fromProfile: "cleo",
      fromHandle: "cleo",
      fromConnection: "mac-studio",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(check(BotRelayDeliverResponseSchema, body)).toBe(true);
    expect(body).toEqual({ reply: "hello from pixel" });
    expect(server.callsOf("bot_relay.deliver").at(-1)?.params).toEqual({
      profile: "pixel",
      message: "Message from 🤖 Cleo (@cleo): hi",
      from_profile: "cleo",
      from_handle: "cleo",
      from_connection: "mac-studio",
    });
    expect(RELAY_DELIVER_TIMEOUT_MS).toBe(1_500_000);
  });

  it("answers a failed turn as an outcome that keeps the target's typed reason", async () => {
    const { post } = await setup({
      failDeliver: { code: 5092, message: "delivery turn failed: 401", data: { reason: "provider_auth_or_access" } },
    });
    const res = await post("/bot-relay/deliver", { profile: "pixel", message: "hi" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ error: "delivery turn failed: 401", reason: "provider_auth_or_access" });
  });

  it("an untyped refusal is an outcome with no reason", async () => {
    const { post } = await setup({ failDeliver: { code: 4092, message: "no profile 'x' on this gateway" } });
    const res = await post("/bot-relay/deliver", { profile: "x", message: "hi" });
    expect(await res.json()).toEqual({ error: "no profile 'x' on this gateway" });
  });

  it("posts a reply or a typed failure back, sending only the keys it was given", async () => {
    const { server, post } = await setup();
    expect((await post("/bot-relay/reply", { id: "5f0c", reply: "hello" })).status).toBe(200);
    expect((await post("/bot-relay/reply", { id: "5f0d", error: "boom", reason: "target_busy" })).status).toBe(200);
    expect(server.callsOf("bot_relay.reply").map((call) => call.params)).toEqual([
      { id: "5f0c", reply: "hello" },
      { id: "5f0d", error: "boom", reason: "target_busy" },
    ]);
  });

  it("every door needs a paired device", async () => {
    const { post } = await setup();
    for (const path of ["/bot-relay/roster", "/bot-relay/drain", "/bot-relay/deliver", "/bot-relay/reply"]) {
      expect((await post(path, {}, null)).status).toBe(401);
    }
  });

  it("turns bot_relay.outbox.pending into the bot_relay_pending frame", async () => {
    const { server, frames } = await setup();
    server.sendEvent("bot_relay.outbox.pending", {});
    await until(() => frames.some((frame) => frame.type === "bot_relay_pending"));
    const frame = frames.find((f) => f.type === "bot_relay_pending");
    expect(check(BotRelayPendingFrameSchema, frame)).toBe(true);
  });
});

describe("worker heartbeat on the roster (capability 87)", () => {
  it("reads worker_session.last_active in milliseconds, null when absent", () => {
    expect(parseProfileRow({ name: "pixel", worker_session: { last_active: 1_800_000_123.4 } })?.workerActiveAt)
      .toBe(1_800_000_123_400);
    expect(parseProfileRow({ name: "pixel" })?.workerActiveAt).toBeNull();
    expect(parseProfileRow({ name: "pixel", worker_session: null })?.workerActiveAt).toBeNull();
  });
});

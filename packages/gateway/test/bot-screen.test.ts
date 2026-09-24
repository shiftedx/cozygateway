import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { ServerFrame } from "cozygateway-contract";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { testHermes } from "./support/test-config.ts";
import { SETUP_CODE_TTL_MS, hashToken, newSetupCode } from "../src/auth.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { BotScreenSurface, SCREEN_TICKET_TTL_MS, sendableCloseCode } from "../src/hermes-bridge/bot-screen.ts";
import { createApp } from "../src/http.ts";
import { openStorage } from "../src/storage.ts";
import { createUpgradeDispatcher } from "../src/upgrade-dispatcher.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 85. The screen routes are a courier over Hermes `display.*`, and the WebSocket is a
 *  byte splice to Hermes `/api/display/ws`. The fake RFB peer below stands in for that socket: it
 *  checks the Hermes ticket, sends the RFB 3.8 banner and echoes whatever the viewer sends. */

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const PROFILE_KEY = "/home/hermes/.hermes/profiles/pixel";
const agentLease = { holder: "agent", viewer_id: null, viewer_hash: null, since: 1, reason: "", epoch: 3 };
const status = {
  profile: "pixel", profile_key: PROFILE_KEY, supported: true, installed: true, missing: [], running: true,
  pid: 42, display: ":20", socket: "/x/rfb.sock", geometry: "1440x900", install_command: null,
  browser: "/usr/bin/chromium", blocker: null, memory_available_mb: 4096, memory_limit_mb: null, lease: agentLease,
};

interface RfbPeer {
  port: number;
  received: Buffer[];
  tickets: string[];
  closes: number[];
  sockets: WebSocket[];
}

/** Stands in for Hermes `/api/display/ws`: only a ticket Hermes minted is accepted. */
async function startRfbPeer(valid: () => Set<string>): Promise<RfbPeer> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http, path: "/api/display/ws" });
  const peer: RfbPeer = { port: 0, received: [], tickets: [], closes: [], sockets: [] };
  wss.on("connection", (ws, req) => {
    const ticket = new URL(req.url ?? "/", "http://x").searchParams.get("display_ticket") ?? "";
    peer.tickets.push(ticket);
    if (!valid().delete(ticket)) {
      ws.close(4401, "display ticket missing, expired or used");
      return;
    }
    peer.sockets.push(ws);
    ws.on("close", (code) => peer.closes.push(code));
    ws.send(Buffer.from("RFB 003.008\n"), { binary: true });
    ws.on("message", (data, binary) => {
      const bytes = Buffer.from(data as Buffer);
      peer.received.push(bytes);
      ws.send(Buffer.concat([Buffer.from("echo:"), bytes]), { binary });
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  peer.port = (http.address() as AddressInfo).port;
  closers.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return peer;
}

async function setup(opts: { now?: () => number } = {}) {
  const hermesTickets = new Set<string>();
  let minted = 0;
  let uiMeta: Record<string, unknown> = { "hermes-bots": { pinned: true, title: "Pixel" } };
  let revision = 4;
  let conflictsLeft = 0;
  let unapplied = false;
  const configWrites: unknown[] = [];
  const server: FakeHermesServer = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({
        profiles: [{ name: "pixel", ui_meta: uiMeta, ui_meta_revisions: { "hermes-bots": revision } }],
        bot_mode_protocol: true,
      }),
      "profiles.configure": (params) => {
        const expected = (params["ui_meta_expected_revisions"] as Record<string, number>)["hermes-bots"];
        if (conflictsLeft > 0 || expected !== revision) {
          conflictsLeft -= 1;
          // A concurrent writer landed first: its key must survive our retry.
          uiMeta = { "hermes-bots": { ...(uiMeta["hermes-bots"] as object), hidden: true } };
          revision += 1;
          return { applied: { ui_meta: false, ui_meta_conflicts: ["hermes-bots"] } };
        }
        uiMeta = { ...uiMeta, ...(params["ui_meta"] as object) };
        revision += 1;
        if (unapplied) return { applied: { ui_meta: false } };
        return { applied: { ui_meta: true } };
      },
      "display.status": (params) => {
        expect(params["profile"]).toBe("pixel");
        return status;
      },
      "display.thumbnail": () => ({ data_url: "data:image/jpeg;base64,/9j/", suppressed: undefined }),
      "display.start": () => status,
      "display.stop": (params) => {
        if (params["force"] !== true) {
          throw { code: 5300, message: "a human holds this screen; pass force: true to stop it anyway" };
        }
        return { ...status, running: false, stopped: true };
      },
      "display.install": () => ({ started: true, command: "apt-get install -y tigervnc", profile_key: PROFILE_KEY }),
      "display.observe": (params) => {
        const ticket = `hermes-ticket-${++minted}`;
        hermesTickets.add(ticket);
        return { ...status, ticket, path: "/api/display/ws", viewer_id: (params["viewer_id"] as string) || "viewer-A" };
      },
      "display.lease.acquire": (params) => ({
        lease: { ...agentLease, holder: "human", viewer_hash: "abc", epoch: 4, reason: params["reason"] },
      }),
      "display.lease.release": () => ({ lease: { ...agentLease, epoch: 5 } }),
    },
    dashboard: ({ method, path, query, body }) => {
      expect(query.get("profile")).toBe("pixel");
      if (method === "GET" && path === "/api/config")
        return { body: { bot_desktop: { geometry: "1440x900", auto_start: false, min_free_memory_mb: 1536, idle_stop_minutes: 30 }, browser: { headed: true } } };
      if (method === "PUT" && path === "/api/config") {
        configWrites.push(body);
        return { body: { ok: true } };
      }
      return { status: 404, body: { detail: "Not Found" } };
    },
  });
  closers.push(() => server.close());
  const rfb = await startRfbPeer(() => hermesTickets);

  const storage = openStorage(":memory:");
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "HERMES-TOKEN" } });
  const bridge = new HermesBridge({ client, storage, broadcast: () => {}, logSink: () => {}, now: Date.now });
  const frames: ServerFrame[] = [];
  const targeted: Array<{ deviceId: string; frame: ServerFrame }> = [];
  const screen = new BotScreenSurface({
    // The RPC link and the display socket share an origin in production; the test splits them only
    // so the fake RFB peer can be its own server.
    endpoints: [{ client, apiWsUrl: `ws://127.0.0.1:${rfb.port}/api/ws` }],
    broadcast: (frame) => frames.push(frame),
    sendToDevice: (deviceId, frame) => {
      targeted.push({ deviceId, frame });
      return true;
    },
    ...(opts.now === undefined ? {} : { now: opts.now }),
    deviceForToken: (token) => storage.deviceByTokenHash(hashToken(token))?.id,
    logSink: () => {},
  });
  const app = createApp({
    storage,
    config: { name: "g", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0, hermesEndpoints: [{ id: "default", ...testHermes() }] },
    bots: bridge,
    botScreen: screen,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 85 } },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("unused");
    },
    interruptThread: () => "idle",
    resolveApproval: async () => "unknown",
    onDeviceRevoked: () => {},
    now: Date.now,
  });
  bridge.start();
  await until(() => client.state() === "online");
  const code = newSetupCode();
  storage.createSetupCode(code, Date.now() + SETUP_CODE_TTL_MS);
  const paired = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const pairedBody = (await paired.json()) as { deviceToken: string };
  const secondCode = newSetupCode();
  storage.createSetupCode(secondCode, Date.now() + SETUP_CODE_TTL_MS);
  const secondBody = (await (await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: secondCode, deviceName: "other phone" }),
  })).json()) as { deviceToken: string };

  // The gateway's own listener, carrying only the screen WebSocket route.
  const http = createServer();
  http.on("upgrade", createUpgradeDispatcher(new Map(), (pathname) =>
    BotScreenSurface.matches(pathname) ? (req, socket, head) => screen.handleUpgrade(req, socket, head) : undefined));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const gatewayPort = (http.address() as AddressInfo).port;

  closers.push(async () => {
    screen.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await bridge.close();
    storage.close();
  });
  const as = (token: string) => (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });
  const authed = as(pairedBody.deviceToken);
  const other = as(secondBody.deviceToken);
  // The screen socket carries the phone's own token (GatewayClient.webSocketTask sends it).
  const dialAs = (token: string) => (port: number, path: string) => dial(port, path, token);
  return {
    server, rfb, screen, frames, targeted, configWrites, authed, other, gatewayPort,
    dial: dialAs(pairedBody.deviceToken), dialOther: dialAs(secondBody.deviceToken),
    setUnapplied: (value: boolean) => { unapplied = value; },
    uiMeta: () => uiMeta,
    setConflicts: (n: number) => { conflictsLeft = n; },
  };
}

function dial(port: number, path: string, token?: string): Promise<{ ws: WebSocket; messages: Buffer[]; closed: Promise<{ code: number; reason: string }> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } });
  const messages: Buffer[] = [];
  ws.on("message", (data) => messages.push(Buffer.from(data as Buffer)));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, messages, closed }));
    ws.once("error", reject);
  });
}

async function observe(authed: (p: string, i?: RequestInit) => Response | Promise<Response>, viewerId?: string) {
  const response = await authed("/bots/pixel/screen/observe", {
    method: "POST", body: JSON.stringify(viewerId === undefined ? {} : { viewerId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown> & { ticket: string; path: string; viewer_id: string };
}

describe("bot screen splice", () => {
  it("splices the RFB banner and bytes both ways on a gateway ticket, re-minting the Hermes ticket", async () => {
    const { authed, gatewayPort, rfb, server, dial } = await setup();
    const observed = await observe(authed);
    expect(observed.path).toBe("/bots/pixel/screen/ws");
    expect(observed.viewer_id).toBe("viewer-A");
    expect(observed.ticket).not.toMatch(/^hermes-ticket/);
    expect(observed.running).toBe(true);

    const { ws, messages } = await dial(gatewayPort, `${observed.path}?ticket=${observed.ticket}`);
    await until(() => messages.length >= 1);
    expect(messages[0]!.toString()).toBe("RFB 003.008\n");
    // The splice spent a SECOND, fresh Hermes ticket, for the same viewer.
    expect(rfb.tickets).toEqual(["hermes-ticket-2"]);
    expect(server.callsOf("display.observe").at(-1)?.params).toMatchObject({ profile: "pixel", viewer_id: "viewer-A" });

    ws.send(Buffer.from("RFB 003.008\n"));
    ws.send(Buffer.from([5, 0, 0, 10, 0, 20]));
    await until(() => messages.length >= 3);
    expect(Buffer.concat(rfb.received).toString("latin1")).toBe(Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([5, 0, 0, 10, 0, 20])]).toString("latin1"));
    expect(messages[2]!.subarray(0, 5).toString()).toBe("echo:");

    // A clean viewer close reaches Hermes as a clean close: that is what hands control back.
    ws.close(1000);
    await until(() => rfb.closes.length === 1);
    expect(rfb.closes[0]).toBe(1000);
  });

  it("refuses a used, foreign-bot or expired ticket with 4401 after accept", async () => {
    let clock = 1_000_000;
    const { authed, gatewayPort, dial } = await setup({ now: () => clock });
    const observed = await observe(authed);
    const first = await dial(gatewayPort, `${observed.path}?ticket=${observed.ticket}`);
    await until(() => first.messages.length >= 1);
    const replay = await dial(gatewayPort, `${observed.path}?ticket=${observed.ticket}`);
    expect((await replay.closed).code).toBe(4401);
    first.ws.close(1000);

    const other = await observe(authed);
    const foreign = await dial(gatewayPort, `/bots/scout/screen/ws?ticket=${other.ticket}`);
    expect((await foreign.closed).code).toBe(4401);
    // ...and a ticket is spent by ANY presentation, so the right bot cannot use it afterwards.
    const spent = await dial(gatewayPort, `${other.path}?ticket=${other.ticket}`);
    expect((await spent.closed).code).toBe(4401);

    const late = await observe(authed);
    clock += SCREEN_TICKET_TTL_MS + 1;
    const expired = await dial(gatewayPort, `${late.path}?ticket=${late.ticket}`);
    expect((await expired.closed).code).toBe(4401);
  });

  it("redeems a ticket only on the device that minted it", async () => {
    const { authed, gatewayPort, dial, dialOther } = await setup();
    const mine = await observe(authed);
    // Another paired phone holding a leaked ticket is refused, and the ticket is spent.
    const stolen = await dialOther(gatewayPort, `${mine.path}?ticket=${mine.ticket}`);
    expect((await stolen.closed).code).toBe(4401);
    const after = await dial(gatewayPort, `${mine.path}?ticket=${mine.ticket}`);
    expect((await after.closed).code).toBe(4401);
    // No device token at all is refused too.
    const fresh = await observe(authed);
    const bare = await new Promise<{ code: number }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}${fresh.path}?ticket=${fresh.ticket}`);
      ws.on("close", (code) => resolve({ code }));
      ws.on("error", () => {});
    });
    expect(bare.code).toBe(4401);
  });

  it("forwards every sendable close code unchanged and reports reserved ones as a lost stream", () => {
    for (const code of [1000, 1001, 1002, 1003, 1007, 1011, 1014, 3000, 4000, 4999]) expect(sendableCloseCode(code)).toBe(true);
    for (const code of [999, 1004, 1005, 1006, 1015, 2999, 5000]) expect(sendableCloseCode(code)).toBe(false);
  });

  it("forwards Hermes's 4000 control-taken close, and cuts (not closes) Hermes on a dropped viewer", async () => {
    const { authed, gatewayPort, rfb, dial } = await setup();
    const observed = await observe(authed, "viewer-B");
    expect(observed.viewer_id).toBe("viewer-B");
    const evicted = await dial(gatewayPort, `${observed.path}?ticket=${observed.ticket}`);
    await until(() => rfb.sockets.length === 1);
    rfb.sockets[0]!.close(4000, "control-taken");
    expect(await evicted.closed).toEqual({ code: 4000, reason: "control-taken" });

    const again = await observe(authed, "viewer-B");
    const dropped = await dial(gatewayPort, `${again.path}?ticket=${again.ticket}`);
    await until(() => rfb.sockets.length === 2);
    dropped.ws.terminate();
    await until(() => rfb.closes.length === 2);
    // 1006: Hermes sees a dropped link, so a human's lease stays put, as upstream intends.
    expect(rfb.closes[1]).toBe(1006);
  });
});

describe("bot screen routes", () => {
  it("passes status, thumbnail, start and config through, and maps 5300 to a 409 the app can force past", async () => {
    const { authed, configWrites } = await setup();
    expect(await (await authed("/bots/pixel/screen")).json()).toEqual(status);
    expect(await (await authed("/bots/pixel/screen/thumbnail")).json()).toEqual({ data_url: "data:image/jpeg;base64,/9j/" });
    expect((await authed("/bots/pixel/screen/start", { method: "POST" })).status).toBe(200);

    const refused = await authed("/bots/pixel/screen/stop", { method: "POST", body: "{}" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "conflict" }, hermesErrorCode: 5300 });
    const forced = await authed("/bots/pixel/screen/stop", { method: "POST", body: JSON.stringify({ force: true }) });
    expect(await forced.json()).toMatchObject({ running: false, stopped: true });

    expect(await (await authed("/bots/pixel/screen/lease/acquire", {
      method: "POST", body: JSON.stringify({ viewerId: "viewer-A", reason: "log in" }),
    })).json()).toMatchObject({ lease: { holder: "human", reason: "log in", epoch: 4 } });
    expect((await authed("/bots/pixel/screen/lease/acquire", { method: "POST", body: "{}" })).status).toBe(400);
    expect(await (await authed("/bots/pixel/screen/lease/release", {
      method: "POST", body: JSON.stringify({ force: true }),
    })).json()).toMatchObject({ lease: { holder: "agent", epoch: 5 } });

    expect(await (await authed("/bots/pixel/screen/config")).json()).toEqual({
      geometry: "1440x900", autoStart: false, minFreeMemoryMb: 1536, idleStopMinutes: 30, browserHeaded: true,
    });
    const patched = await authed("/bots/pixel/screen/config", {
      method: "PATCH", body: JSON.stringify({ autoStart: true, browserHeaded: false }),
    });
    expect(patched.status).toBe(200);
    expect(configWrites).toEqual([{ config: { bot_desktop: { auto_start: true }, browser: { headed: false } } }]);
    expect((await authed("/bots/pixel/screen/config", { method: "PATCH", body: JSON.stringify({ geometry: "big" }) })).status).toBe(400);
  });

  it("relays the sudo request to the installing phone, answers Hermes once, and forwards install events", async () => {
    const { authed, other, server, frames, targeted } = await setup();
    expect(await (await authed("/bots/pixel/screen/install", { method: "POST" })).json()).toMatchObject({ started: true });
    server.sendRaw({ jsonrpc: "2.0", id: "srq-abc123", method: "display.install.sudo", params: { session_id: "", profile_key: PROFILE_KEY } });
    await until(() => targeted.length === 1);
    expect(targeted[0]).toEqual({ deviceId: expect.stringMatching(/.+/), frame: { type: "bot_screen_install_sudo", bot: "pixel", requestId: "srq-abc123" } });

    expect((await authed("/bots/pixel/screen/install/sudo", {
      method: "POST", body: JSON.stringify({ requestId: "srq-nope", password: "x" }),
    })).status).toBe(404);
    // The card went to the installing phone; nobody else may answer it.
    expect((await other("/bots/pixel/screen/install/sudo", {
      method: "POST", body: JSON.stringify({ requestId: "srq-abc123", password: "guess" }),
    })).status).toBe(404);
    expect(frames.some((frame) => frame.type === "bot_screen_install_sudo")).toBe(false);
    expect((await authed("/bots/pixel/screen/install/sudo", {
      method: "POST", body: JSON.stringify({ requestId: "srq-abc123", password: "hunter2" }),
    })).status).toBe(204);
    await until(() => server.clientResponses().length === 1);
    expect(server.clientResponses()[0]).toEqual({ jsonrpc: "2.0", id: "srq-abc123", result: { value: "hunter2" } });
    // Once only: the request is closed after one answer.
    expect((await authed("/bots/pixel/screen/install/sudo", {
      method: "POST", body: JSON.stringify({ requestId: "srq-abc123", password: "hunter2" }),
    })).status).toBe(404);

    server.sendEvent("display.install.log", { profile_key: PROFILE_KEY, line: "Setting up xfwm4" });
    server.sendEvent("display.install.done", { profile_key: PROFILE_KEY, code: 0, status });
    server.sendEvent("display.lease", { profile_key: PROFILE_KEY, lease: { ...agentLease, epoch: 9 } });
    server.sendEvent("display.status", { ...status, running: false });
    server.sendEvent("display.lease", { profile_key: "/somebody/else", lease: agentLease });
    await until(() => frames.length === 4);
    expect(frames.map((frame) => frame.type)).toEqual([
      "bot_screen_install_log", "bot_screen_install_done", "bot_screen_lease", "bot_screen_status",
    ]);
    expect(frames[1]).toMatchObject({ bot: "pixel", code: 0, status: { running: true } });
  });

  it("reads and compare-and-swaps screenAutoOpen without clobbering other hermes-bots keys", async () => {
    const { authed, uiMeta, setConflicts } = await setup();
    expect(await (await authed("/bots/pixel/screen/auto-open")).json()).toEqual({ enabled: false });
    setConflicts(1);
    const response = await authed("/bots/pixel/screen/auto-open", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    // The concurrent writer's `hidden` survived the retry, and so did the older keys.
    expect(uiMeta()["hermes-bots"]).toEqual({ pinned: true, title: "Pixel", hidden: true, screenAutoOpen: true });
    expect(await (await authed("/bots/pixel/screen/auto-open")).json()).toEqual({ enabled: true });
  });

  it("does not report an auto-open write Hermes did not apply as a success", async () => {
    const { authed, setUnapplied } = await setup();
    setUnapplied(true);
    const response = await authed("/bots/pixel/screen/auto-open", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(response.status).toBe(502);
  });

  it("skips a sudo request no installing phone can answer, instead of broadcasting it", async () => {
    const { authed, server, frames } = await setup();
    // Teach the gateway the profile key, then ask for sudo with no install from this gateway.
    expect((await authed("/bots/pixel/screen")).status).toBe(200);
    server.sendRaw({ jsonrpc: "2.0", id: "srq-orphan", method: "display.install.sudo", params: { session_id: "", profile_key: PROFILE_KEY } });
    await until(() => server.clientResponses().length === 1);
    expect(server.clientResponses()[0]).toEqual({ jsonrpc: "2.0", id: "srq-orphan", result: { value: "" } });
    expect(frames.some((frame) => frame.type === "bot_screen_install_sudo")).toBe(false);
  });
});

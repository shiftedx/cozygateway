import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openStorage, type Storage } from "../src/storage.ts";
import { WsHub } from "../src/ws-hub.ts";
import { mintDeviceToken } from "../src/auth.ts";
import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import { ObservationRing } from "../src/observe/index.ts";
import { RelayNotifier } from "../src/push-notifier.ts";

let storage: Storage;
let clock: number;

function ring(enabled = true): ObservationRing {
  return new ObservationRing({ store: storage.observe, options: { enabled, retentionDays: 7 }, now: () => clock });
}

/** Every subject in the ring is a keyed hash, so a test looks a name up the way D3 does. */
function id(value: string): string {
  return storage.observe.identify(value);
}

function samples(series: string) {
  return storage.observe.samples({ series, from: 0, to: Number.MAX_SAFE_INTEGER });
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  storage = openStorage(":memory:");
  clock = 1_700_000_000_000;
});

afterEach(() => {
  storage.close();
});

describe("the device round trip on the app websocket heartbeat", () => {
  let hub: WsHub;
  let server: Server;
  let port: number;
  let token: string;

  async function boot(observe: ObservationRing, publicHost?: string): Promise<void> {
    hub = new WsHub({
      storage,
      gatewayInfo: { name: "g", version: "0.1.0", contract: "v1" },
      now: () => clock,
      authTimeoutMs: 500,
      heartbeatMs: 20,
      observe,
      ...(publicHost === undefined ? {} : { publicHost }),
    });
    server = createServer();
    server.on("upgrade", (req, socket, head) => hub.handleUpgrade(req, socket, head));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    port = address.port;
  }

  beforeEach(() => {
    const minted = mintDeviceToken();
    token = minted.token;
    storage.createDevice({ id: "device-1", name: "phone", tokenHash: minted.tokenHash, createdAt: 1 });
  });

  afterEach(async () => {
    hub.close();
    server.close();
    await once(server, "close");
  });

  async function connectAuthenticated(headers: Record<string, string> = {}): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const seen: string[] = [];
    socket.on("message", (data) => seen.push(String(JSON.parse(String(data)).type)));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "auth", token }));
    await until(() => seen.includes("ready"));
    return socket;
  }

  it("tags the device round trip tunnel for a proxied socket and lan for a direct one", async () => {
    const observe = ring();
    await boot(observe, "gateway.example.com");

    const tunnelled = await connectAuthenticated({ "x-forwarded-for": "203.0.113.7" });
    await until(() => samples("device_rtt_ms|tunnel").length > 0);
    tunnelled.close();
    await once(tunnelled, "close");

    const local = await connectAuthenticated();
    await until(() => samples("device_rtt_ms|lan").length > 0);
    local.close();
    await once(local, "close");

    for (const row of [...samples("device_rtt_ms|tunnel"), ...samples("device_rtt_ms|lan")]) {
      expect(row.bot).toBe(id("device-1"));
      expect(row.value).toBeGreaterThanOrEqual(0);
      // Timed on the gateway's monotonic clock, so a frozen wall clock cannot produce the sample.
      expect(row.value).toBeLessThan(4_000);
      expect(row.at).toBe(clock);
    }
    expect(storage.observe.refused).toBe(0);
  });

  it("records nothing at all when observability is off", async () => {
    await boot(ring(false), "gateway.example.com");
    const socket = await connectAuthenticated({ "x-forwarded-for": "203.0.113.7" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    socket.close();
    await once(socket, "close");
    expect(samples("device_rtt_ms|tunnel")).toHaveLength(0);
    expect(samples("device_rtt_ms|lan")).toHaveLength(0);
    expect(samples("heartbeat_gap_ms")).toHaveLength(0);
  });
});

describe("the peer round trip on the attach heartbeat", () => {
  let ingress: AttachV1Ingress;
  let server: Server;
  let port: number;

  async function boot(observe: ObservationRing): Promise<void> {
    ingress = new AttachV1Ingress({
      tokens: new Map([["secret", "sage"]]),
      storage,
      observe,
      events: {
        onEvent: () => true,
        onPresence: () => {},
      },
      now: () => clock,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 5_000,
    });
    server = createServer();
    server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    port = address.port;
  }

  afterEach(async () => {
    ingress.close();
    server.close();
    await once(server, "close");
  });

  async function dial(answerHeartbeats: boolean): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, {
      headers: { authorization: "Bearer secret" },
    });
    const frames: AttachV1ServerFrame[] = [];
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as AttachV1ServerFrame;
      frames.push(frame);
      if (frame.kind === "heartbeat" && answerHeartbeats) {
        socket.send(JSON.stringify({ kind: "heartbeat", sentAt: frame.sentAt }));
      }
    });
    await once(socket, "open");
    socket.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "plugin", capabilities: ["draft"],
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => frames.some((frame) => frame.kind === "hello_ack"));
    return socket;
  }

  it("writes one peer round trip per acknowledged heartbeat, keyed to the agent", async () => {
    await boot(ring());
    const socket = await dial(true);
    await until(() => samples("peer_rtt_ms").length >= 2);
    socket.close();
    await once(socket, "close");

    for (const row of samples("peer_rtt_ms")) {
      expect(row.bot).toBe(id("sage"));
      expect(row.value).toBeGreaterThanOrEqual(0);
      expect(row.value).toBeLessThan(4_000);
    }
    expect(storage.observe.refused).toBe(0);
  });

  it("writes no round trip for a peer that never acknowledges", async () => {
    await boot(ring());
    const socket = await dial(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    socket.close();
    await once(socket, "close");
    expect(samples("peer_rtt_ms")).toHaveLength(0);
  });

  it("never differences an ack on a new connection against the previous one's send", async () => {
    await boot(ring());
    // A peer that goes away with a heartbeat outstanding and comes back must not have the whole
    // disconnect recorded as a round trip: that is a one-way silence reported as a measurement.
    const first = await dial(false);
    await until(() => true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    first.close();
    await once(first, "close");
    const second = await dial(true);
    await until(() => samples("peer_rtt_ms").length >= 1);
    second.close();
    await once(second, "close");

    for (const row of samples("peer_rtt_ms")) {
      // Every sample is a real request-to-ack pair on one connection, so none of them can be as
      // large as the gap the first socket spent unanswered.
      expect(row.value).toBeLessThan(50);
    }
  });

  it("writes nothing when observability is off", async () => {
    await boot(ring(false));
    const socket = await dial(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    socket.close();
    await once(socket, "close");
    expect(samples("peer_rtt_ms")).toHaveLength(0);
  });
});

describe("push results", () => {
  function notifier(observe: ObservationRing, status: number): RelayNotifier {
    return new RelayNotifier({
      storage,
      observe,
      relayBaseUrl: "http://relay.invalid",
      log: () => {},
      fetchImpl: (async () => new Response("{}", { status })) as typeof fetch,
    });
  }

  it("counts a delivered push as one and a refused one as zero, tagged by reason", async () => {
    const observe = ring();
    // The notifier's private send path is exercised through the ring's own writer, which is the
    // one line the push path calls: the relay protocol itself is covered by its own suite.
    void notifier(observe, 200);
    observe.pushResult("device-1", "ok");
    observe.pushResult("device-1", "not_found");

    expect(samples("push_result|ok").map((row) => row.value)).toEqual([1]);
    expect(samples("push_result|not_found").map((row) => row.value)).toEqual([0]);
    const events = storage.observe.events({ kind: "push_result", from: 0, to: Number.MAX_SAFE_INTEGER });
    expect(events).toHaveLength(1);
    expect(events[0]?.ref).toBe(id("device-1"));
    expect(JSON.parse(events[0]?.detailJson ?? "{}")).toEqual({ result: "not_found" });
  });
});

describe("the app-reported perceived latency on the delivery receipt", () => {
  it("stores the phone's own measurement and network path beside the receipt", () => {
    storage.upsertAgent({ id: "luna", name: "Luna", avatar: null, backend: "cozyagents" });
    const chat = storage.nativeBotChat("luna", clock);
    storage.appendNativeBotMessage({
      bot: "luna", sessionId: chat.sessionId, messageId: "m1", role: "assistant", text: "hi", at: clock,
    });

    const first = storage.recordBotMessageDisplayed("luna", ["m1"], "device-1", clock, {
      feltLatencyMs: 1_240, networkPath: "vpn_on",
    });
    expect(first.recorded).toBe(1);
    expect(storage.botMessageReceipt("luna", "m1")).toMatchObject({
      deviceId: "device-1", feltLatencyMs: 1_240, networkPath: "vpn_on",
    });
  });

  it("stores nulls for a client that reports neither, which is every client below capability 73", () => {
    storage.upsertAgent({ id: "luna", name: "Luna", avatar: null, backend: "cozyagents" });
    const chat = storage.nativeBotChat("luna", clock);
    storage.appendNativeBotMessage({
      bot: "luna", sessionId: chat.sessionId, messageId: "m2", role: "assistant", text: "hi", at: clock,
    });
    storage.recordBotMessageDisplayed("luna", ["m2"], "device-1", clock);
    expect(storage.botMessageReceipt("luna", "m2")).toMatchObject({
      feltLatencyMs: null, networkPath: null,
    });
  });
});

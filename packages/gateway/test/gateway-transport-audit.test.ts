import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";

import { mintDeviceToken } from "../src/auth.ts";
import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { WsHub } from "../src/ws-hub.ts";

let hub: WsHub | undefined;
let storage: Storage | undefined;
let server: ReturnType<typeof createServer> | undefined;
let client: WebSocket | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  client?.close();
  hub?.close();
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  storage?.close();
  hub = undefined;
  storage = undefined;
  server = undefined;
  client = undefined;
});

it("closes a slow write client with 1013 and restores durable history after reconnect", async () => {
  storage = openStorage(":memory:");
  const minted = mintDeviceToken();
  storage.createDevice({ id: "d1", name: "phone", tokenHash: minted.tokenHash, createdAt: 1 });
  storage.upsertAgent({ id: "sage", name: "Sage", avatar: null, backend: "mock" });
  storage.createThread({ id: "thread", agentId: "sage", title: "Thread", createdAt: 1 });
  storage.appendMessage("thread", { role: "agent", blocks: [{ type: "paragraph", text: "durable reply" }] }, 2);
  hub = new WsHub({
    storage,
    gatewayInfo: { name: "audit", version: "test", contract: "v1" },
    now: () => 1,
    heartbeatMs: 60_000,
  });
  server = createServer();
  server.on("upgrade", (request, socket, head) => hub!.handleUpgrade(request, socket, head));
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing port");

  const url = `ws://127.0.0.1:${address.port}/ws`;
  client = new WebSocket(url);
  const ready = new Promise<void>((resolve) => client!.on("message", (data) => {
    if (JSON.parse(String(data)).type === "ready") resolve();
  }));
  await once(client, "open");
  client.send(JSON.stringify({ type: "auth", token: minted.token }));
  await ready;

  // The live socket has already accumulated the hard 4 MiB bound. A broadcast must not append
  // another frame to that sender queue; close 1013 so this device reconnects and uses `sync`.
  const buffered = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockReturnValue(4 * 1024 * 1024);
  const send = vi.spyOn(WebSocket.prototype, "send");
  const stringify = vi.spyOn(JSON, "stringify");
  const baseline = send.mock.calls.length;
  const closed = once(client, "close");
  hub.broadcast({
    type: "bot_chat_delta", bot: "sage", sessionId: "thread", turnId: "turn",
    text: "new live state", seq: 1, updatedAt: 3,
  });
  buffered.mockRestore();

  const [code] = await closed as [number];
  expect(code).toBe(1013);
  expect(send.mock.calls.length - baseline).toBe(0);
  expect(stringify).toHaveBeenCalledTimes(1);

  client = new WebSocket(url);
  const restored: unknown[] = [];
  client.on("message", (data) => restored.push(JSON.parse(String(data))));
  await once(client, "open");
  client.send(JSON.stringify({ type: "auth", token: minted.token }));
  await waitFor(() => restored.some((frame) => isFrame(frame, "ready")));
  client.send(JSON.stringify({ type: "sync", threads: { thread: 0 } }));
  await waitFor(() => restored.some((frame) => isFrame(frame, "synced")));
  expect(restored).toContainEqual(expect.objectContaining({
    type: "committed", threadId: "thread", seq: 1,
    message: expect.objectContaining({ blocks: [{ type: "paragraph", text: "durable reply" }] }),
  }));
});

it("delivers an oversized first committed frame despite a small queued preceding frame", async () => {
  storage = openStorage(":memory:");
  const minted = mintDeviceToken();
  storage.createDevice({ id: "d1", name: "phone", tokenHash: minted.tokenHash, createdAt: 1 });
  storage.upsertAgent({ id: "sage", name: "Sage", avatar: null, backend: "mock" });
  storage.createThread({ id: "thread", agentId: "sage", title: "Thread", createdAt: 1 });
  const oversizedText = "x".repeat(4 * 1024 * 1024);
  storage.appendMessage("thread", { role: "agent", blocks: [{ type: "paragraph", text: oversizedText }] }, 2);
  hub = new WsHub({
    storage,
    gatewayInfo: { name: "audit", version: "test", contract: "v1" },
    now: () => 1,
    heartbeatMs: 60_000,
  });
  server = createServer();
  server.on("upgrade", (request, socket, head) => hub!.handleUpgrade(request, socket, head));
  server.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing port");
  const url = `ws://127.0.0.1:${address.port}/ws`;

  const received: unknown[] = [];
  let closeCode: number | undefined;
  client = new WebSocket(url);
  client.on("message", (data) => received.push(JSON.parse(String(data))));
  client.on("close", (code) => { closeCode = code; });
  await once(client, "open");
  client.send(JSON.stringify({ type: "auth", token: minted.token }));
  await waitFor(() => received.some((frame) => isFrame(frame, "ready")));

  // `ready` may still be queued when an auth snapshot or first sync record is very large. The
  // cap is a backlog high-water mark, so this one valid committed frame must still be delivered.
  let bufferedAmount = 1;
  const buffered = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockImplementation(() => bufferedAmount);
  client.send(JSON.stringify({ type: "sync", threads: { thread: 0 } }));
  await waitFor(() => received.some((frame) => isFrame(frame, "committed")), 12_000);
  await waitFor(() => received.some((frame) => isFrame(frame, "synced")));
  bufferedAmount = 0;
  buffered.mockRestore();

  expect(closeCode).not.toBe(1013);
  expect(received).toContainEqual(expect.objectContaining({
    type: "committed", threadId: "thread", seq: 1,
    message: expect.objectContaining({ blocks: [{ type: "paragraph", text: oversizedText }] }),
  }));

  const firstClose = once(client, "close");
  client.close();
  const [firstCode] = await firstClose as [number];
  expect(firstCode).not.toBe(1013);

  // A client that persisted the delivered sequence reconnects without replaying that oversized
  // frame, so the normal sync completion remains available rather than becoming a 1013 loop.
  const replayed: unknown[] = [];
  client = new WebSocket(url);
  client.on("message", (data) => replayed.push(JSON.parse(String(data))));
  await once(client, "open");
  client.send(JSON.stringify({ type: "auth", token: minted.token }));
  await waitFor(() => replayed.some((frame) => isFrame(frame, "ready")));
  client.send(JSON.stringify({ type: "sync", threads: { thread: 1 } }));
  await waitFor(() => replayed.some((frame) => isFrame(frame, "synced")));
  expect(replayed).not.toContainEqual(expect.objectContaining({ type: "committed", threadId: "thread", seq: 1 }));
}, 20_000);

it("keeps the app and six idle peers alive through Cleo-sized history plus 1,000 live events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cozygateway-transport-history-"));
  const dbPath = join(directory, "gateway.sqlite");
  let localStorage: Storage | undefined;
  let localHub: WsHub | undefined;
  let ingress: AttachV1Ingress | undefined;
  let localServer: ReturnType<typeof createServer> | undefined;
  let eventLoopMonitor: ReturnType<typeof setInterval> | undefined;
  const sockets: WebSocket[] = [];
  try {
    // The live database contained about 128k already-applied Cleo events. Populate only the
    // immutable history in one SQLite transaction; new frames still traverse the real WS ingress.
    const initialized = openStorage(dbPath);
    initialized.close();
    seedAppliedAttachHistory(dbPath, "cleo", 128_000);
    localStorage = openStorage(dbPath);

    const device = mintDeviceToken();
    localStorage.createDevice({ id: "phone", name: "phone", tokenHash: device.tokenHash, createdAt: Date.now() });
    localHub = new WsHub({
      storage: localStorage,
      gatewayInfo: { name: "audit", version: "test", contract: "v1" },
      now: () => Date.now(),
      heartbeatMs: 100,
    });
    const peerTokens = Array.from({ length: 6 }, (_, index) => [`peer-token-${index}`, `peer-${index}`] as const);
    ingress = new AttachV1Ingress({
      storage: localStorage,
      tokens: new Map([["cleo-token", "cleo"], ...peerTokens]),
      events: { onEvent: () => true, onPresence: () => {} },
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 2_000,
      log: () => {},
    });
    localServer = createServer();
    localServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/ws") localHub!.handleUpgrade(request, socket, head);
      else if (pathname === "/attach/v1") ingress!.handleUpgrade(request, socket, head);
      else socket.destroy();
    });
    localServer.listen(0, "127.0.0.1");
    await once(localServer, "listening");
    const address = localServer.address();
    if (address === null || typeof address === "string") throw new Error("missing port");
    const base = `ws://127.0.0.1:${address.port}`;

    let appClosed = false;
    const app = new WebSocket(`${base}/ws`);
    sockets.push(app);
    app.on("close", () => { appClosed = true; });
    const appReady = new Promise<void>((resolve) => app.on("message", (data) => {
      if (JSON.parse(String(data)).type === "ready") resolve();
    }));
    await once(app, "open");
    app.send(JSON.stringify({ type: "auth", token: device.token }));
    await appReady;

    const cleo = await attach(`${base}/attach/v1`, "cleo-token", "cleo", sockets, 128_000);
    const peers = await Promise.all(peerTokens.map(([token, agentId]) => attach(`${base}/attach/v1`, token, agentId, sockets)));
    const peerCloseCodes = new Map<string, number>();
    for (const peer of peers) peer.socket.on("close", (code) => peerCloseCodes.set(peer.instanceId, code));
    await delay(150); // Establish heartbeat traffic before the event burst.

    let largestEventLoopGap = 0;
    let lastMonitorTick = performance.now();
    eventLoopMonitor = setInterval(() => {
      const now = performance.now();
      largestEventLoopGap = Math.max(largestEventLoopGap, now - lastMonitorTick);
      lastMonitorTick = now;
    }, 10);
    const burstStartedAt = performance.now();
    for (let sequence = 1; sequence <= 1_000; sequence += 1) {
      const event = sequence % 25 === 0
        ? { kind: "tool" as const, threadId: "thread", turnId: "turn", callId: `call-${sequence}`, name: "read", status: "ok" as const, role: "investigation" as const, detail: "complete" }
        : { kind: "draft" as const, threadId: "thread", turnId: "turn", blocks: [{ type: "paragraph" as const, text: "working" }] };
      cleo.socket.send(JSON.stringify({
        kind: "event", sequence: 128_000 + sequence, eventId: `live-${sequence}`, event,
      }));
    }
    await waitFor(() => cleo.eventAcks === 1_000, 5_000);
    const ackLatencyMs = performance.now() - burstStartedAt;
    await delay(220);
    if (eventLoopMonitor !== undefined) {
      clearInterval(eventLoopMonitor);
      eventLoopMonitor = undefined;
    }

    expect(appClosed).toBe(false);
    expect(app.readyState).toBe(WebSocket.OPEN);
    // This is a liveness regression, not a workstation benchmark. The test ingress watchdog is
    // two seconds, so both the complete ACK burst and the worst observed timer delay must stay
    // inside that actual failure boundary; a loaded parallel test run is allowed to be slower
    // than the local ~0.4 s baseline.
    expect(ackLatencyMs).toBeLessThan(2_000);
    expect(largestEventLoopGap).toBeLessThan(2_000);
    for (const peer of peers) {
      expect(peer.socket.readyState, `peer ${peer.instanceId} close code ${peerCloseCodes.get(peer.instanceId)}`).toBe(WebSocket.OPEN);
      expect(peer.heartbeats).toBeGreaterThan(1);
    }
  } finally {
    if (eventLoopMonitor !== undefined) clearInterval(eventLoopMonitor);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    }
    await delay(5);
    ingress?.close();
    localHub?.close();
    if (localServer?.listening) await new Promise<void>((resolve) => localServer!.close(() => resolve()));
    localStorage?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

function seedAppliedAttachHistory(path: string, agentId: string, count: number): void {
  const database = new DatabaseSync(path);
  try {
    const frameJson = JSON.stringify({ padding: "x".repeat(2_000) });
    const insert = database.prepare(
      `INSERT INTO attach_event_inbox
         (agent_id, sequence, event_id, frame_json, received_at, disposition, applied_at)
       VALUES (?, ?, ?, ?, 0, 'accepted', 0)`,
    );
    database.exec("BEGIN");
    for (let sequence = 1; sequence <= count; sequence += 1)
      insert.run(agentId, sequence, `history-${sequence}`, frameJson);
    database.prepare(
      `INSERT INTO attach_streams (agent_id, next_command_sequence, last_event_sequence, updated_at)
       VALUES (?, 1, ?, 0)`,
    ).run(agentId, count);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

async function attach(url: string, token: string, instanceId: string, sockets: WebSocket[], eventSequence = 0): Promise<{
  socket: WebSocket;
  instanceId: string;
  eventAcks: number;
  heartbeats: number;
}> {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  sockets.push(socket);
  let hello = false;
  let eventAcks = 0;
  let heartbeats = 0;
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as AttachV1ServerFrame;
    if (frame.kind === "hello_ack") hello = true;
    if (frame.kind === "heartbeat") {
      heartbeats += 1;
      socket.send(JSON.stringify({ kind: "heartbeat", sentAt: frame.sentAt }));
    }
    if (frame.kind === "ack" && frame.channel === "event") eventAcks += 1;
  });
  await once(socket, "open");
  socket.send(JSON.stringify({
    kind: "hello", version: 2, instanceId, capabilities: ["draft"],
    resume: { eventSequence, commandSequence: 0 },
  }));
  await waitFor(() => hello);
  return {
    socket,
    instanceId,
    get eventAcks() { return eventAcks; },
    get heartbeats() { return heartbeats; },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("timed out waiting for condition");
    await delay(2);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isFrame(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && "type" in value
    && (value as { type?: unknown }).type === type;
}

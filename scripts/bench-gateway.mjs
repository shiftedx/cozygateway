import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Session } from "node:inspector";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKER = "bench";
const HISTORY_ROWS = parseCount(process.env.HISTORY, 128_000);
const TOOL_COUNT = 40;
const DRAFT_COUNT = 920;
const EVENT_COUNT = TOOL_COUNT * 2 + DRAFT_COUNT + 1;
const TIMEOUT_MS = 30_000;

try {
  const result = await run();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}

async function run() {
  const scriptRoot = dirname(fileURLToPath(import.meta.url));
  const buildRoot = resolve(process.env.GATEWAY_BUILD_ROOT ?? join(scriptRoot, "..", "packages", "gateway", "dist"));
  const cpuProfilePath = process.env.CPU_PROFILE;
  if (cpuProfilePath !== undefined && !isAbsolute(cpuProfilePath))
    throw new Error("CPU_PROFILE must be an absolute path");

  const [{ Storage, openStorage }, { AttachV1Ingress }, { WsHub }, { NativeBotDataPlane }, { mintDeviceToken }] = await Promise.all([
    import(pathToFileURL(join(buildRoot, "storage.js")).href),
    import(pathToFileURL(join(buildRoot, "adapters", "attach", "ingress-v1.js")).href),
    import(pathToFileURL(join(buildRoot, "ws-hub.js")).href),
    import(pathToFileURL(join(buildRoot, "hermes-bridge", "native-data-plane.js")).href),
    import(pathToFileURL(join(buildRoot, "auth.js")).href),
  ]);
  if (typeof Storage !== "function" || typeof openStorage !== "function")
    throw new Error(`compiled gateway storage is missing under ${buildRoot}`);

  const { WebSocket } = createRequire(join(buildRoot, "index.js"))("ws");
  const scratchDir = await mkdtemp(join(tmpdir(), "cozygateway-bench-"));
  const dbPath = join(scratchDir, "gateway.sqlite");
  const sockets = [];
  let burstRecording = false;
  let closeEventsDuringBurst = 0;
  let eventLoopTimer;
  let cpuProfile;
  let storage;
  let ingress;
  let hub;
  let plane;
  let server;

  try {
    const initialized = openStorage(dbPath);
    initialized.close();
    seedAppliedAttachHistory(dbPath, WORKER, HISTORY_ROWS);
    storage = openStorage(dbPath);

    const appToken = mintDeviceToken();
    storage.createDevice({
      id: "bench-app",
      name: "benchmark app",
      tokenHash: appToken.tokenHash,
      createdAt: Date.now(),
    });

    const peerTokens = [
      ["worker-token", WORKER],
      ...Array.from({ length: 6 }, (_, index) => [`idle-token-${index}`, `idle-${index}`]),
    ];
    const tokens = new Map(peerTokens);
    const appFrames = { count: 0, bytes: 0 };
    let appSawTerminalState = false;
    let appSawAnswer = false;

    hub = new WsHub({
      storage,
      gatewayInfo: { name: "bench", version: "benchmark", contract: "v1" },
      now: () => Date.now(),
    });

    ingress = new AttachV1Ingress({
      storage,
      tokens,
      events: {
        canAcceptEvent: (agentId, frame) => plane?.canAccept(agentId, frame) === true,
        onEvent: (agentId, frame) => plane?.handle(agentId, frame) === true,
        onHello: (agentId, activeTurns) => plane?.handleAttachHello(agentId, activeTurns),
        onPresence: (agentId, state) => plane?.handleAttachPresence(agentId, state),
        onTaskTurnQueued: (agentId, command) => plane?.taskTurnQueued(agentId, command),
        onTurnDispatched: (agentId, turnId) => plane?.turnDispatched(agentId, turnId),
      },
      log: () => {},
    });

    plane = new NativeBotDataPlane({
      control: {},
      storage,
      ingress,
      nativeBots: [WORKER],
      chatSuggestion: "",
      now: () => Date.now(),
      broadcast: (frame) => hub.broadcast(frame),
      log: () => {},
    });

    server = createServer();
    server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/ws") hub.handleUpgrade(request, socket, head);
      else if (pathname === "/attach/v1") ingress.handleUpgrade(request, socket, head);
      else socket.destroy();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing benchmark port");
    const base = `ws://127.0.0.1:${address.port}`;

    const track = (socket, label) => trackSocket(socket, label, sockets, () => {
      if (burstRecording) closeEventsDuringBurst += 1;
    });
    const app = await connectApp(`${base}/ws`, appToken.token, (data) => {
      if (!burstRecording) return;
      appFrames.count += 1;
      appFrames.bytes += Buffer.byteLength(String(data));
      const frame = parseJson(data);
      if (frame?.type === "bot_chat_state" && frame.status === "completed") appSawTerminalState = true;
      if (frame?.type === "bot_chat" && Array.isArray(frame.messages)
        && frame.messages.some((message) => message?.id === "bench-answer")) appSawAnswer = true;
    }, WebSocket, track);

    const worker = await connectAttach(
      `${base}/attach/v1`,
      "worker-token",
      WORKER,
      ["draft", "tools"],
      HISTORY_ROWS,
      WebSocket,
      track,
    );
    const idlePeers = await Promise.all(
      peerTokens.slice(1).map(([token, agentId]) => connectAttach(
      `${base}/attach/v1`, token, agentId, ["draft"], 0, WebSocket, track,
      )),
    );
    await waitFor(
      () => worker.helloAck && idlePeers.every((peer) => peer.helloAck),
      TIMEOUT_MS,
      "attach hello",
    );
    await waitFor(
      () => worker.heartbeats > 0 && idlePeers.every((peer) => peer.heartbeats > 0),
      TIMEOUT_MS,
      "attach heartbeat ACK",
    );

    const sent = await plane.surface().sendChatMessage(WORKER, "benchmark turn", { clientId: "bench-question" });
    ingress.flushQueuedCommands(WORKER);
    const turnId = sent.message.turnId;
    if (turnId === undefined) throw new Error("native turn did not get a turn id");
    const command = storage.attachTurnCommand(WORKER, turnId);
    if (command?.threadId !== sent.sessionId || command.messageId !== "bench-question")
      throw new Error("native turn command was not durably bound");
    await waitFor(
      () => worker.commandAcks === 1 && storage.nativeBotTurnDelivery(WORKER, turnId)?.acknowledgedAt != null,
      TIMEOUT_MS,
      `durable turn command ACK (frames=${worker.commandFrames}, acks=${worker.commandAcks}, queue=${storage.attachPeerHealth(WORKER).queueDepth}, cursor=${storage.attachCommandCursor(WORKER)}, pending=${storage.pendingAttachCommands(WORKER, 0, 4).length}, attached=${ingress.isAttached(WORKER)}, caps=${[...ingress.negotiatedCapabilities(WORKER)].join(",")}, state=${worker.socket.readyState})`,
    );

    const appStart = appFrames.count;
    const appBytesStart = appFrames.bytes;
    let largestTimerGapMs = 0;
    let lastTimerTick = performance.now();
    eventLoopTimer = setInterval(() => {
      const now = performance.now();
      largestTimerGapMs = Math.max(largestTimerGapMs, now - lastTimerTick);
      lastTimerTick = now;
    }, 10);
    eventLoopTimer.unref?.();
    cpuProfile = await startCpuProfile(cpuProfilePath);
    const cpuStart = process.cpuUsage();
    const rssStart = process.memoryUsage().rss;
    const burstStartedAt = performance.now();
    burstRecording = true;

    let sequence = HISTORY_ROWS;
    for (let tool = 0; tool < TOOL_COUNT; tool += 1) {
      const callId = `tool-${tool}`;
      await sendEvent(worker, ++sequence, `tool-running-${tool}`, {
        kind: "tool", threadId: sent.sessionId, turnId, callId,
        name: "read", status: "running", role: "investigation",
      });
      await sendEvent(worker, ++sequence, `tool-ok-${tool}`, {
        kind: "tool", threadId: sent.sessionId, turnId, callId,
        name: "read", status: "ok", role: "investigation", detail: "complete",
      });
    }
    for (let draft = 0; draft < DRAFT_COUNT; draft += 1) {
      await sendEvent(worker, ++sequence, `draft-${draft}`, {
        kind: "draft", threadId: sent.sessionId, turnId,
        blocks: [{ type: "paragraph", text: "working" }],
      });
    }
    await sendEvent(worker, ++sequence, "commit", {
      kind: "commit", threadId: sent.sessionId, turnId, messageId: "bench-answer",
      blocks: [{ type: "paragraph", text: "done" }],
    });
    if (sequence !== HISTORY_ROWS + EVENT_COUNT) throw new Error("benchmark event count drifted");

    await waitFor(() => worker.eventAcks === EVENT_COUNT, TIMEOUT_MS, "durable event ACKs");
    const ackMs = performance.now() - burstStartedAt;
    await waitFor(
      () => appSawTerminalState && appSawAnswer
        && storage.nativeBotTurnTerminal(WORKER, sent.sessionId, turnId)?.status === "completed",
      TIMEOUT_MS,
      "projected terminal and app delivery",
    );
    const burstMs = performance.now() - burstStartedAt;
    burstRecording = false;
    const cpuDelta = process.cpuUsage(cpuStart);
    const rssEnd = process.memoryUsage().rss;
    if (eventLoopTimer !== undefined) {
      clearInterval(eventLoopTimer);
      eventLoopTimer = undefined;
    }
    await cpuProfile?.stop();
    cpuProfile = undefined;

    const historyStartedAt = performance.now();
    const history = await plane.surface().chatHistory(WORKER);
    const freshHistoryReadMs = performance.now() - historyStartedAt;
    const toolRows = storage.botChatToolSteps(sent.sessionId, 0).filter((row) => row.turnId === turnId);
    const messages = storage.nativeBotMessages(WORKER, sent.sessionId);
    const terminal = storage.nativeBotTurnTerminal(WORKER, sent.sessionId, turnId);
    const unapplied = [...new Set(tokens.values())]
      .reduce((count, agentId) => count + storage.unappliedAttachEvents(agentId).length, 0);
    const deadLetters = storage.attachProjectionDeadLetters().length;
    const queueDepth = storage.attachPeerHealth(WORKER).queueDepth;
    const socketsOpen = sockets.every(({ socket }) => socket.readyState === WebSocket.OPEN);
    const validation = {
      attachHello: worker.helloAck && idlePeers.every((peer) => peer.helloAck),
      commandAcks: worker.commandAcks === 1,
      heartbeatAcks: worker.heartbeats > 0 && idlePeers.every((peer) => peer.heartbeats > 0),
      eventAcks: worker.eventAcks === EVENT_COUNT,
      finalToolSteps: toolRows.length === TOOL_COUNT && toolRows.every((row) => row.status === "ok"),
      terminalPersisted: terminal?.status === "completed" && history.running === false,
      messagePersisted: messages.some((message) => message.id === "bench-answer"),
      appTerminal: appSawTerminalState && appSawAnswer,
      socketCloses: closeEventsDuringBurst === 0 && socketsOpen,
      unappliedRows: unapplied === 0,
      deadLetters: deadLetters === 0,
      commandQueue: queueDepth === 0,
    };
    const ok = Object.values(validation).every(Boolean);
    return {
      ok,
      node: process.version,
      buildRoot,
      historyRows: HISTORY_ROWS,
      eventWindow: worker.eventWindow,
      events: { tools: TOOL_COUNT, drafts: DRAFT_COUNT, total: EVENT_COUNT },
      metrics: {
        burstAckMs: round(ackMs),
        burstMs: round(burstMs),
        cpuMs: {
          user: round(cpuDelta.user / 1_000),
          system: round(cpuDelta.system / 1_000),
          total: round((cpuDelta.user + cpuDelta.system) / 1_000),
        },
        rssBytes: { before: rssStart, after: rssEnd, delta: rssEnd - rssStart },
        app: { frames: appFrames.count - appStart, bytes: appFrames.bytes - appBytesStart },
        timerMaximumGapMs: round(largestTimerGapMs),
        freshHistoryReadMs: round(freshHistoryReadMs),
      },
      validation,
      profile: cpuProfilePath ?? null,
      limitations: [
        "CPU and RSS are process-wide measurements for the burst window, including gateway timer and heartbeat work.",
        "App bytes count UTF-8 JSON payload bytes, not WebSocket framing or TCP bytes.",
        "The attach worker is a synthetic local peer; no real bot, provider, or external network is used.",
        ...(cpuProfilePath === undefined ? ["CPU profiling is disabled unless CPU_PROFILE is set to an absolute path."] : []),
      ],
    };
  } finally {
    burstRecording = false;
    if (eventLoopTimer !== undefined) clearInterval(eventLoopTimer);
    await cpuProfile?.stop().catch(() => {});
    plane?.close();
    ingress?.close();
    hub?.close();
    await closeSockets(sockets);
    if (server?.listening) {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
    storage?.close();
    await rm(scratchDir, { recursive: true, force: true });
  }
}

function parseCount(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("HISTORY must be a non-negative integer");
  return count;
}

function seedAppliedAttachHistory(path, agentId, count) {
  const database = new DatabaseSync(path);
  let transaction = false;
  try {
    const frameJson = JSON.stringify({ padding: "x".repeat(2_000) });
    const insert = database.prepare(
      `INSERT INTO attach_event_inbox
         (agent_id, sequence, event_id, frame_json, received_at, disposition, applied_at)
       VALUES (?, ?, ?, ?, 0, 'accepted', 0)`,
    );
    database.exec("BEGIN");
    transaction = true;
    for (let sequence = 1; sequence <= count; sequence += 1)
      insert.run(agentId, sequence, `history-${sequence}`, frameJson);
    database.prepare(
      `INSERT INTO attach_streams (agent_id, next_command_sequence, last_event_sequence, updated_at)
       VALUES (?, 1, ?, 0)`,
    ).run(agentId, count);
    database.exec("COMMIT");
    transaction = false;
  } catch (error) {
    if (transaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function parseJson(data) {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
}

function trackSocket(socket, label, sockets, onClose) {
  const record = { socket, label, closeCode: undefined };
  socket.on("error", () => {});
  socket.on("close", (code) => {
    record.closeCode = code;
    onClose?.();
  });
  sockets.push(record);
  return record;
}

async function connectApp(url, token, onMessage, Socket, track) {
  let ready = false;
  const record = track(new Socket(url), "app");
  record.socket.on("message", (data) => {
    const frame = parseJson(data);
    if (frame?.type === "ready") ready = true;
    onMessage(data);
  });
  await waitForOpen(record.socket, "app websocket");
  record.socket.send(JSON.stringify({ type: "auth", token }));
  await waitFor(() => ready, TIMEOUT_MS, "app auth");
  return record;
}

async function connectAttach(url, token, agentId, capabilities, eventSequence, Socket, track) {
  const state = {
    helloAck: false,
    commandAcks: 0,
    sentEvents: 0,
    eventWindow: 0,
    byteWindow: 0,
    eventAcks: 0,
    heartbeats: 0,
  };
  const record = track(new Socket(url, { headers: { authorization: `Bearer ${token}` } }), agentId);
  record.socket.on("message", (data) => {
    const frame = parseJson(data);
    if (frame?.kind === "hello_ack") {
      state.helloAck = true;
      state.eventWindow = frame.limits.maxInFlightEvents;
      state.byteWindow = frame.limits.maxInFlightBytes;
      return;
    }
    if (frame?.kind === "heartbeat") {
      state.heartbeats += 1;
      record.socket.send(JSON.stringify({ kind: "heartbeat", sentAt: frame.sentAt }));
      return;
    }
    if (frame?.kind === "command") {
      state.commandAcks += 1;
      record.socket.send(JSON.stringify({
        kind: "ack", channel: "command", sequence: frame.sequence, id: frame.commandId,
      }));
      return;
    }
    if (frame?.kind === "ack" && frame.channel === "event") state.eventAcks += 1;
  });
  await waitForOpen(record.socket, `${agentId} attach websocket`);
  record.socket.send(JSON.stringify({
    kind: "hello", version: 2, instanceId: `${agentId}-instance`, capabilities,
    resume: { eventSequence, commandSequence: 0 },
  }));
  await waitFor(() => state.helloAck, TIMEOUT_MS, `${agentId} hello`);
  return Object.assign(state, { socket: record.socket });
}

async function sendEvent(peer, sequence, eventId, event) {
  await waitFor(() => peer.sentEvents - peer.eventAcks < peer.eventWindow, TIMEOUT_MS, "event window");
  const data = JSON.stringify({ kind: "event", sequence, eventId, event });
  // Every fixture frame fits even when the whole negotiated count window is full.
  if (Buffer.byteLength(data) * peer.eventWindow > peer.byteWindow) throw new Error("fixture exceeds byte window");
  peer.socket.send(data);
  peer.sentEvents += 1;
}

async function waitForOpen(socket, label) {
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${label}`)), TIMEOUT_MS);
    const finish = (error) => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error === undefined) resolveOpen();
      else reject(error);
    };
    const onOpen = () => finish();
    const onError = (error) => finish(error instanceof Error ? error : new Error(`${label} failed`));
    const onClose = () => finish(new Error(`${label} closed before open`));
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt >= timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function closeSockets(records) {
  for (const { socket } of records) {
    if (socket.readyState === 0 || socket.readyState === 1) socket.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const { socket } of records) {
    if (socket.readyState !== 3) socket.terminate();
  }
}

async function startCpuProfile(outputPath) {
  if (outputPath === undefined) return undefined;
  const session = new Session();
  session.connect();
  await inspectorPost(session, "Profiler.enable");
  await inspectorPost(session, "Profiler.start");
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        const result = await inspectorPost(session, "Profiler.stop");
        await writeFile(outputPath, JSON.stringify(result.profile));
      } finally {
        try { await inspectorPost(session, "Profiler.disable"); } catch {}
        session.disconnect();
      }
    },
  };
}

function inspectorPost(session, method, params = {}) {
  return new Promise((resolvePost, reject) => {
    session.post(method, params, (error, result) => error === null ? resolvePost(result) : reject(error));
  });
}

function round(value) {
  return Math.round(value * 100) / 100;
}

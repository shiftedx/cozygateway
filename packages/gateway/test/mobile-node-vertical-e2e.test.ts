import { once } from "node:events";

import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { MOBILE_NODE_CAPABILITY_VERSION, type BotChatMessage, type ReadyFrame, type ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const phoneStatus = {
  appState: "background" as const, batteryBand: "medium" as const, lowPowerMode: false,
  thermalState: "nominal" as const, networkClass: "wifi" as const,
  capabilities: [
    { command: "device.status" as const, permission: "not_required" as const },
    { command: "location.current" as const, permission: "authorized" as const },
    { command: "camera.capture" as const, permission: "authorized" as const },
    { command: "file.pick" as const, permission: "not_required" as const },
    { command: "notification.present" as const, permission: "not_required" as const },
  ],
  wakeReason: "notification" as const,
};

it("keeps the P1 command names closed at the app/gateway boundary", () => {
  expect(["camera.capture", "file.pick", "notification.present"]).toEqual([
    "camera.capture", "file.pick", "notification.present",
  ]);
});

it("routes status through its authenticated origin in background while keeping location foreground-only", async () => {
  process.env["MOBILE_E2E_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["MOBILE_E2E_SAGE_TOKEN"] = "attach-secret";
  let gateway: RunningGateway | undefined;
  let hermes: FakeHermesServer | undefined;
  const sockets: WebSocket[] = [];
  try {
    hermes = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({ profiles: [{ name: "sage", description: "native", has_avatar: false, ui_meta: { "hermes-bots": { title: "Sage" } } }], bot_mode_protocol: true }),
      },
    });
    gateway = await startGateway({
      name: "mobile-node-e2e", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default",
        url: hermes.url, tokenEnv: "MOBILE_E2E_DASHBOARD_TOKEN",
        profiles: { sage: { tokenEnv: "MOBILE_E2E_SAGE_TOKEN", name: "Sage" } },
      }],
    });
    const tokenA = await pair(gateway);
    const tokenB = await pair(gateway);
    const appA = await appSocket(gateway.url, tokenA, sockets);
    const appB = await appSocket(gateway.url, tokenB, sockets);
    expect(appA.ready.deviceId).not.toBe(appB.ready.deviceId);
    expect(appA.ready.gateway.capabilities?.["com.cozylabs.mobile-node"]).toBe(MOBILE_NODE_CAPABILITY_VERSION);
    appA.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status", "location.current"], foreground: false }));
    appB.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status"], foreground: true }));
    await pause();

    const pluginFrames: Array<Record<string, any>> = [];
    const plugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer attach-secret" } });
    sockets.push(plugin);
    plugin.on("message", (data) => pluginFrames.push(JSON.parse(String(data))));
    await once(plugin, "open");
    plugin.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "mobile-node-e2e", capabilities: ["draft", "mobile_node", "mobile_location"], resume: { eventSequence: 0, commandSequence: 0 } }));
    await until(() => pluginFrames.some((frame) => frame.kind === "hello_ack"));

    await until(() => gateway!.storage.botRoster().bots.some((bot) => bot.name === "sage"));
    const sent = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST", headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "check status", clientId: "origin-a" }),
    });
    expect(sent.status).toBe(202);
    await until(() => pluginFrames.some((frame) => frame.kind === "command" && frame.command.kind === "turn"));
    const turn = pluginFrames.find((frame) => frame.kind === "command" && frame.command.kind === "turn")!.command;

    requestStatus(plugin, turn, "approved");
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "approved"));
    const approved = appA.frames.find((frame) => frame.type === "mobile_node_request" && frame.requestId === "approved") as Extract<(typeof appA.frames)[number], { type: "mobile_node_request" }>;
    expect(appB.frames.some((frame) => frame.type === "mobile_node_request")).toBe(false);
    appB.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "approved", lease: approved.lease, status: "denied" }));
    await pause();
    expect(results(pluginFrames, "approved")).toEqual([]);
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "approved", lease: approved.lease, status: "ok", result: phoneStatus }));
    await settledOnce(pluginFrames, "approved");
    await until(() => appA.frames.some((frame) => frame.type === "bot_mobile_receipt" && frame.requestId === "approved"));
    expect(results(pluginFrames, "approved")[0]).toEqual({
      kind: "mobile_result", requestId: "approved", status: "ok",
      result: { ...phoneStatus, authenticatedReachable: true, lastAuthenticatedPresenceAt: expect.any(Number) },
    });

    appA.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status", "location.current"], foreground: true }));
    await pause();
    requestLocation(plugin, turn, "location", "Find nearby coffee");
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "location"));
    const locationRequest = appA.frames.find((frame) => frame.type === "mobile_node_request" && frame.requestId === "location") as Extract<(typeof appA.frames)[number], { type: "mobile_node_request" }>;
    expect(locationRequest).toMatchObject({ command: "location.current", purpose: "Find nearby coffee" });
    expect(appB.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "location")).toBe(false);
    appB.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "location", lease: locationRequest!.lease, status: "ok", result: { latitude: 41.88, longitude: -87.63 } }));
    await pause();
    expect(results(pluginFrames, "location")).toEqual([]);
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "location", lease: locationRequest!.lease, status: "ok", result: { latitude: 41.88, longitude: -87.63 } }));
    await settledOnce(pluginFrames, "location");
    expect(results(pluginFrames, "location")[0]).toEqual({ kind: "mobile_result", requestId: "location", status: "ok", result: { latitude: 41.88, longitude: -87.63 } });

    // Two tool calls stay correlated by request id even when the phone answers out of order.
    requestStatus(plugin, turn, "reverse-first");
    requestStatus(plugin, turn, "reverse-second");
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "reverse-first"));
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "reverse-second"));
    const reverseFirst = appA.frames.find((frame) => frame.type === "mobile_node_request" && frame.requestId === "reverse-first") as Extract<(typeof appA.frames)[number], { type: "mobile_node_request" }>;
    const reverseSecond = appA.frames.find((frame) => frame.type === "mobile_node_request" && frame.requestId === "reverse-second") as Extract<(typeof appA.frames)[number], { type: "mobile_node_request" }>;
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "reverse-second", lease: reverseSecond.lease, status: "denied" }));
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "reverse-first", lease: reverseFirst.lease, status: "ok", result: { ...phoneStatus, appState: "foreground" } }));
    await settledOnce(pluginFrames, "reverse-first");
    await settledOnce(pluginFrames, "reverse-second");
    expect(results(pluginFrames, "reverse-first")[0]).toMatchObject({ status: "ok", result: { appState: "foreground", authenticatedReachable: true } });
    expect(results(pluginFrames, "reverse-second")[0]).toMatchObject({ status: "denied" });

    // A duplicate attach request and late phone result cannot make a second tool terminal.
    requestStatus(plugin, turn, "approved");
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "approved", status: "denied" }));
    await pause();
    expect(results(pluginFrames, "approved")).toHaveLength(1);

    requestStatus(plugin, turn, "denied");
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "denied"));
    const denied = appA.frames.find((frame) => frame.type === "mobile_node_request" && frame.requestId === "denied") as Extract<(typeof appA.frames)[number], { type: "mobile_node_request" }>;
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "denied", lease: denied.lease, status: "denied" }));
    await settledOnce(pluginFrames, "denied");
    expect(results(pluginFrames, "denied")[0]).toMatchObject({ status: "denied" });
    expect(appA.frames.some((frame) => frame.type === "bot_mobile_receipt" && frame.requestId === "denied")).toBe(false);

    requestStatus(plugin, turn, "expired", Date.now() + 100);
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "expired"));
    await settledOnce(pluginFrames, "expired");
    expect(results(pluginFrames, "expired")[0]).toMatchObject({ status: "expired" });
    expect(appA.frames.some((frame) => frame.type === "mobile_node_cancel" && frame.requestId === "expired")).toBe(true);

    requestStatus(plugin, turn, "disconnect");
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "disconnect"));
    const disconnected = appA.frames.find((frame) => frame.type === "mobile_node_request" && frame.requestId === "disconnect") as Extract<(typeof appA.frames)[number], { type: "mobile_node_request" }>;
    appA.socket.close();
    await once(appA.socket, "close");
    await pause();
    expect(results(pluginFrames, "disconnect")).toEqual([]);

    const appA2 = await appSocket(gateway.url, tokenA, sockets);
    appA2.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status"], foreground: true }));
    await until(() => appA2.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "disconnect"));
    const resent = appA2.frames.find((frame) => frame.type === "mobile_node_request" && frame.requestId === "disconnect") as Extract<(typeof appA2.frames)[number], { type: "mobile_node_request" }>;
    expect(resent).toEqual(disconnected);
    appA2.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "disconnect", lease: resent.lease, status: "ok", result: phoneStatus }));
    await settledOnce(pluginFrames, "disconnect");

    // Status remains available in background, and B is never substituted for authenticated origin A.
    appA2.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status"], foreground: false }));
    requestStatus(plugin, turn, "backgrounded");
    await until(() => appA2.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "backgrounded"));
    const backgrounded = appA2.frames.find((frame) => frame.type === "mobile_node_request" && frame.requestId === "backgrounded") as Extract<(typeof appA2.frames)[number], { type: "mobile_node_request" }>;
    appA2.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "backgrounded", lease: backgrounded.lease, status: "ok", result: phoneStatus }));
    await settledOnce(pluginFrames, "backgrounded");
    expect(results(pluginFrames, "backgrounded")[0]).toMatchObject({ status: "ok" });
    expect(appB.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "backgrounded")).toBe(false);

    requestStatus(plugin, turn, "cancelled");
    await until(() => appA2.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "cancelled"));
    plugin.send(JSON.stringify({ kind: "mobile_cancel", requestId: "cancelled" }));
    await settledOnce(pluginFrames, "cancelled");
    expect(results(pluginFrames, "cancelled")[0]).toMatchObject({ status: "cancelled" });
    expect(appA2.frames.some((frame) => frame.type === "mobile_node_cancel" && frame.requestId === "cancelled")).toBe(true);

    requestStatus(plugin, turn, "stopped");
    await until(() => appA2.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "stopped"));
    const stopped = await fetch(`${gateway.url}/bots/sage/chat/stop`, { method: "POST", headers: { authorization: `Bearer ${tokenA}` } });
    expect(stopped.status).toBe(200);
    await settledOnce(pluginFrames, "stopped");
    expect(results(pluginFrames, "stopped")[0]).toMatchObject({ status: "cancelled" });

    // Noninteractive/routine-style targets do not match the active canonical turn and never route.
    for (const requestId of ["routine", "scheduled", "historical"]) {
      plugin.send(JSON.stringify({ kind: "mobile_request", requestId, command: "device.status", threadId: requestId, turnId: "not-the-active-turn", expiresAt: Date.now() + 1_000, purpose: "Report phone readiness" }));
      await settledOnce(pluginFrames, requestId);
      expect(results(pluginFrames, requestId)[0]).toMatchObject({ status: "policy_blocked" });
      expect(appA2.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === requestId)).toBe(false);
    }

    const appRequestsBeforeReconnect = appA2.frames.filter((frame) => frame.type === "mobile_node_request").length;
    plugin.close();
    await once(plugin, "close");
    const replayedFrames: Array<Record<string, any>> = [];
    const pluginReconnect = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer attach-secret" } });
    sockets.push(pluginReconnect);
    pluginReconnect.on("message", (data) => replayedFrames.push(JSON.parse(String(data))));
    await once(pluginReconnect, "open");
    pluginReconnect.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "mobile-node-e2e", capabilities: ["draft", "mobile_node", "mobile_location"], resume: { eventSequence: 0, commandSequence: 0 } }));
    await until(() => replayedFrames.some((frame) => frame.kind === "hello_ack"));
    await pause();
    expect(replayedFrames.some((frame) => frame.kind === "mobile_result")).toBe(false);
    expect(appA2.frames.filter((frame) => frame.type === "mobile_node_request")).toHaveLength(appRequestsBeforeReconnect);

    pluginReconnect.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "assistant-answer", event: { kind: "commit", threadId: turn.threadId, turnId: turn.turnId, messageId: "ordinary-answer", blocks: [{ type: "paragraph", text: "ordinary assistant response" }] } }));
    await until(() => appA2.frames.some((frame) => frame.type === "bot_chat" && frame.messages.some((message) => message.id === "ordinary-answer")));
    const history = await (await fetch(`${gateway.url}/bots/sage/chat/messages`, { headers: { authorization: `Bearer ${tokenA}` } })).json() as {
      messages: BotChatMessage[];
      mobileReceipts: Array<Record<string, unknown>>;
    };
    expect(history.messages.map((message) => message.text)).toEqual(["check status", "ordinary assistant response"]);
    expect(history.mobileReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requestId: "approved", bot: "sage", sessionId: turn.threadId,
        turnId: turn.turnId, command: "device.status", sharedDescription: "Device status",
        purpose: "Report phone readiness", sharedAt: expect.any(Number),
      }),
    ]));
    expect(JSON.stringify(history.mobileReceipts)).not.toMatch(/lease|deviceId|latitude|longitude|result/i);
    // Only the real turn/commit advance attach's durable cursors; mobile frames stay volatile.
    expect(gateway.storage.attachCommandCursor("sage")).toBe(0);
    expect(gateway.storage.attachEventCursor("sage")).toBe(1);
  } finally {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    await hermes?.close();
    delete process.env["MOBILE_E2E_DASHBOARD_TOKEN"];
    delete process.env["MOBILE_E2E_SAGE_TOKEN"];
  }
}, 20_000);

it("returns an uploaded camera artifact to the requesting attach peer", async () => {
  process.env["MOBILE_MEDIA_E2E_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["MOBILE_MEDIA_E2E_SAGE_TOKEN"] = "attach-secret";
  let gateway: RunningGateway | undefined;
  let hermes: FakeHermesServer | undefined;
  const sockets: WebSocket[] = [];
  try {
    hermes = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({ profiles: [{ name: "sage", description: "native", has_avatar: false, ui_meta: { "hermes-bots": { title: "Sage" } } }], bot_mode_protocol: true }),
      },
    });
    gateway = await startGateway({
      name: "mobile-media-e2e", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default",
        url: hermes.url, tokenEnv: "MOBILE_MEDIA_E2E_DASHBOARD_TOKEN",
        profiles: { sage: { tokenEnv: "MOBILE_MEDIA_E2E_SAGE_TOKEN", name: "Sage" } },
      }],
    });
    const deviceToken = await pair(gateway);
    const app = await appSocket(gateway.url, deviceToken, sockets);
    app.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["camera.capture"], foreground: true }));

    const pluginFrames: Array<Record<string, any>> = [];
    const plugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer attach-secret" } });
    sockets.push(plugin);
    plugin.on("message", (data) => pluginFrames.push(JSON.parse(String(data))));
    await once(plugin, "open");
    plugin.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "mobile-media-e2e",
      capabilities: ["draft", "mobile_node", "mobile_media"],
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => pluginFrames.some((frame) => frame.kind === "hello_ack"));

    await until(() => gateway!.storage.botRoster().bots.some((bot) => bot.name === "sage"));
    const sent = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "take a photo", clientId: "camera-origin" }),
    });
    expect(sent.status).toBe(202);
    await until(() => pluginFrames.some((frame) => frame.kind === "command" && frame.command.kind === "turn"));
    const turn = pluginFrames.find((frame) => frame.kind === "command" && frame.command.kind === "turn")!.command;

    plugin.send(JSON.stringify({
      kind: "mobile_request", requestId: "camera-upload", command: "camera.capture",
      threadId: turn.threadId, turnId: turn.turnId, expiresAt: Date.now() + 120_000,
      purpose: "Capture one test photo", camera: "rear", capture: "photo", videoDurationSeconds: 10,
    }));
    await until(() => app.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "camera-upload"));
    const request = app.frames.find((frame): frame is Extract<ServerFrame, { type: "mobile_node_request" }> =>
      frame.type === "mobile_node_request" && frame.requestId === "camera-upload")!;
    const uploaded = await fetch(`${gateway.url}/mobile-node/media/camera-upload`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "image/png",
        "x-mobile-node-lease": request.lease,
        "x-attach-filename": "camera.png",
      },
      body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    expect(uploaded.status).toBe(201);
    const uploadBody = await uploaded.json() as { media: Record<string, unknown> };
    expect(uploadBody.media.expiresAt).toEqual(expect.any(Number));

    await settledOnce(pluginFrames, "camera-upload");
    expect(results(pluginFrames, "camera-upload")[0]).toEqual({
      kind: "mobile_result", requestId: "camera-upload", status: "ok",
      result: {
        mediaId: uploadBody.media.mediaId,
        mimeType: "image/png",
        byteCount: 8,
        sha256: expect.any(String),
        filename: "camera.png",
        family: "image",
      },
    });
  } finally {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    await hermes?.close();
    delete process.env["MOBILE_MEDIA_E2E_DASHBOARD_TOKEN"];
    delete process.env["MOBILE_MEDIA_E2E_SAGE_TOKEN"];
  }
}, 20_000);

async function pair(gateway: RunningGateway): Promise<string> {
  const response = await fetch(`${gateway.url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }) });
  return ((await response.json()) as { deviceToken: string }).deviceToken;
}

async function appSocket(url: string, token: string, sockets: WebSocket[]): Promise<{ socket: WebSocket; frames: ServerFrame[]; ready: ReadyFrame }> {
  const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
  const frames: ServerFrame[] = [];
  sockets.push(socket);
  socket.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "auth", token }));
  await until(() => frames.some((frame) => frame.type === "ready"));
  return { socket, frames, ready: frames.find((frame): frame is ReadyFrame => frame.type === "ready")! };
}

function requestStatus(plugin: WebSocket, turn: { threadId: string; turnId: string }, requestId: string, expiresAt = Date.now() + 1_000): void {
  plugin.send(JSON.stringify({ kind: "mobile_request", requestId, command: "device.status", threadId: turn.threadId, turnId: turn.turnId, expiresAt, purpose: "Report phone readiness" }));
}

function requestLocation(plugin: WebSocket, turn: { threadId: string; turnId: string }, requestId: string, purpose: string): void {
  plugin.send(JSON.stringify({ kind: "mobile_request", requestId, command: "location.current", threadId: turn.threadId, turnId: turn.turnId, expiresAt: Date.now() + 1_000, purpose }));
}

function results(frames: Array<Record<string, any>>, requestId: string): Array<Record<string, any>> {
  return frames.filter((frame) => frame.kind === "mobile_result" && frame.requestId === requestId);
}

async function settledOnce(frames: Array<Record<string, any>>, requestId: string): Promise<void> {
  await until(() => results(frames, requestId).length === 1);
  await pause();
  expect(results(frames, requestId)).toHaveLength(1);
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await pause(5);
  }
}

async function pause(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

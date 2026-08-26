import { once } from "node:events";

import { expect, it } from "vitest";
import { WebSocket } from "ws";
import type { BotChatMessage, ReadyFrame, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const phoneStatus = {
  appState: "background" as const, batteryBand: "medium" as const, lowPowerMode: false,
  thermalState: "nominal" as const, networkClass: "wifi" as const,
  capabilities: [
    { command: "device.status" as const, permission: "not_required" as const },
    { command: "location.current" as const, permission: "authorized" as const },
  ],
  wakeReason: "notification" as const,
};

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
      hermes: {
        url: hermes.url, tokenEnv: "MOBILE_E2E_DASHBOARD_TOKEN",
        profiles: { sage: { tokenEnv: "MOBILE_E2E_SAGE_TOKEN", name: "Sage" } },
      },
    });
    const tokenA = await pair(gateway);
    const tokenB = await pair(gateway);
    const appA = await appSocket(gateway.url, tokenA, sockets);
    const appB = await appSocket(gateway.url, tokenB, sockets);
    expect(appA.ready.deviceId).not.toBe(appB.ready.deviceId);
    expect(appA.ready.gateway.capabilities?.["com.cozylabs.mobile-node"]).toBe(3);
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
    expect(appB.frames.some((frame) => frame.type === "mobile_node_request")).toBe(false);
    appB.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "approved", status: "denied" }));
    await pause();
    expect(results(pluginFrames, "approved")).toEqual([]);
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "approved", status: "ok", result: phoneStatus }));
    await settledOnce(pluginFrames, "approved");
    expect(results(pluginFrames, "approved")[0]).toEqual({
      kind: "mobile_result", requestId: "approved", status: "ok",
      result: { ...phoneStatus, authenticatedReachable: true, lastAuthenticatedPresenceAt: expect.any(Number) },
    });

    appA.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status", "location.current"], foreground: true }));
    await pause();
    requestLocation(plugin, turn, "location", "Find nearby coffee");
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "location"));
    const locationRequest = appA.frames.find((frame) => frame.type === "mobile_node_request" && frame.requestId === "location");
    expect(locationRequest).toMatchObject({ command: "location.current", purpose: "Find nearby coffee" });
    expect(appB.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "location")).toBe(false);
    appB.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "location", status: "ok", result: { latitude: 41.88, longitude: -87.63 } }));
    await pause();
    expect(results(pluginFrames, "location")).toEqual([]);
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "location", status: "ok", result: { latitude: 41.88, longitude: -87.63 } }));
    await settledOnce(pluginFrames, "location");
    expect(results(pluginFrames, "location")[0]).toEqual({ kind: "mobile_result", requestId: "location", status: "ok", result: { latitude: 41.88, longitude: -87.63 } });

    // Two tool calls stay correlated by request id even when the phone answers out of order.
    requestStatus(plugin, turn, "reverse-first");
    requestStatus(plugin, turn, "reverse-second");
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "reverse-first"));
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "reverse-second"));
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "reverse-second", status: "denied" }));
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "reverse-first", status: "ok", result: { ...phoneStatus, appState: "foreground" } }));
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
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "denied", status: "denied" }));
    await settledOnce(pluginFrames, "denied");
    expect(results(pluginFrames, "denied")[0]).toMatchObject({ status: "denied" });

    requestStatus(plugin, turn, "expired", Date.now() + 100);
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "expired"));
    await settledOnce(pluginFrames, "expired");
    expect(results(pluginFrames, "expired")[0]).toMatchObject({ status: "expired" });
    expect(appA.frames.some((frame) => frame.type === "mobile_node_cancel" && frame.requestId === "expired")).toBe(true);

    requestStatus(plugin, turn, "disconnect");
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "disconnect"));
    appA.socket.close();
    await once(appA.socket, "close");
    await settledOnce(pluginFrames, "disconnect");
    expect(results(pluginFrames, "disconnect")[0]).toMatchObject({ status: "device_unavailable" });

    // B remains connected but is never substituted for the authenticated origin A.
    requestStatus(plugin, turn, "backgrounded");
    await settledOnce(pluginFrames, "backgrounded");
    expect(results(pluginFrames, "backgrounded")[0]).toMatchObject({ status: "foreground_required" });
    expect(appB.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "backgrounded")).toBe(false);

    const appA2 = await appSocket(gateway.url, tokenA, sockets);
    appA2.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status"], foreground: true }));
    await pause();
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
    const history = await (await fetch(`${gateway.url}/bots/sage/chat/messages`, { headers: { authorization: `Bearer ${tokenA}` } })).json() as { messages: BotChatMessage[] };
    expect(history.messages.map((message) => message.text)).toEqual(["check status", "ordinary assistant response"]);
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

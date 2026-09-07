/** Capability 70 end to end against a HERMES-BACKED bot's profile, which is the whole point of the
 *  row: capability 68's binding is keyed to the bot's identity and not to its backend, so device
 *  selection is admitted the same way whatever runs behind the attach socket. The peer here is the
 *  attach lane a Hermes plugin speaks; nothing in Hermes' own agent loop takes part, and the two
 *  frames it sends are the pre-70 frame plus one optional routing hint.
 *
 *  Capability 71 rides along at the end: a draft written by one paired device reaches the other,
 *  and the clear a send writes reaches it too, so nothing is ever offered for sending twice. */
import { once } from "node:events";

import { expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ReadyFrame, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

it("admits a Hermes bot's phone capability request against the selected device", async () => {
  process.env["SELECT_E2E_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["SELECT_E2E_SAGE_TOKEN"] = "attach-secret";
  let gateway: RunningGateway | undefined;
  let hermes: FakeHermesServer | undefined;
  const sockets: WebSocket[] = [];
  try {
    hermes = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({
          profiles: [{ name: "sage", description: "native", has_avatar: false, ui_meta: { "hermes-bots": { title: "Sage" } } }],
          bot_mode_protocol: true,
        }),
      },
    });
    gateway = await startGateway({
      name: "device-selection-e2e", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
      hermesEndpoints: [{
        id: "default", url: hermes.url, tokenEnv: "SELECT_E2E_DASHBOARD_TOKEN",
        profiles: { sage: { tokenEnv: "SELECT_E2E_SAGE_TOKEN", name: "Sage" } },
      }],
    });
    const tokenA = await pair(gateway);
    const tokenB = await pair(gateway);
    const appA = await appSocket(gateway.url, tokenA, sockets);
    const appB = await appSocket(gateway.url, tokenB, sockets);
    expect(appA.ready.deviceId).not.toBe(appB.ready.deviceId);
    for (const app of [appA, appB])
      app.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status"], foreground: true }));
    await pause();

    const pluginFrames: Array<Record<string, unknown>> = [];
    const plugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer attach-secret" } });
    sockets.push(plugin);
    plugin.on("message", (data) => pluginFrames.push(JSON.parse(String(data)) as Record<string, unknown>));
    await once(plugin, "open");
    plugin.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "device-selection-e2e",
      capabilities: ["draft", "mobile_node"], resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => pluginFrames.some((frame) => frame["kind"] === "hello_ack"));
    await until(() => gateway!.storage.botRoster().bots.some((bot) => bot.name === "sage"));

    // The turn is opened from device A, which is the pre-70 target for everything it asks for.
    const sent = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST", headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "check status", clientId: "origin-a" }),
    });
    expect(sent.status).toBe(202);
    await until(() => pluginFrames.some((frame) => frame["kind"] === "command" && (frame["command"] as { kind?: string }).kind === "turn"));
    const turn = (pluginFrames.find(
      (frame) => frame["kind"] === "command" && (frame["command"] as { kind?: string }).kind === "turn",
    )!["command"]) as { threadId: string; turnId: string };

    // The person chooses their other phone for this conversation.
    const chosen = await fetch(
      `${gateway.url}/bots/sage/mobile-requests/preferred-device?sessionId=${encodeURIComponent(turn.threadId)}`,
      {
        method: "PUT", headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
        body: JSON.stringify({ deviceId: appB.ready.deviceId }),
      },
    );
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toMatchObject({ sessionId: turn.threadId, deviceId: appB.ready.deviceId });

    // The Hermes-backed peer sends the frame it has always sent, with no new field at all.
    requestStatus(plugin, turn, "chosen");
    await until(() => appB.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "chosen"));
    // Admitted against the NAMED device, not the one that opened the turn.
    expect(appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "chosen")).toBe(false);

    // Row 68 still owns the binding: an answer from any other device is refused, and device A
    // reconnecting mid-request never becomes the target.
    const chosenFrame = appB.frames.find(
      (frame) => frame.type === "mobile_node_request" && frame.requestId === "chosen",
    ) as Extract<ServerFrame, { type: "mobile_node_request" }>;
    appA.socket.send(JSON.stringify({ type: "mobile_node_result", requestId: "chosen", lease: chosenFrame.lease, status: "denied" }));
    appA.socket.send(JSON.stringify({ type: "mobile_node_advertise", commands: ["device.status"], foreground: true }));
    await pause();
    expect(pluginFrames.some((frame) => frame["kind"] === "mobile_result" && frame["requestId"] === "chosen")).toBe(false);
    expect(appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "chosen")).toBe(false);

    // And the lifecycle record names the chosen device, not the turn's origin.
    const record = await lifecycle(gateway.url, tokenA, turn.threadId, "chosen");
    expect(record).toMatchObject({ deviceId: appB.ready.deviceId });

    // A hint the peer sends wins over the stored choice, and an unpaired one is DROPPED rather
    // than losing the request: it falls through to the same stored choice.
    plugin.send(JSON.stringify({
      kind: "mobile_request", requestId: "hinted", command: "device.status",
      threadId: turn.threadId, turnId: turn.turnId, expiresAt: Date.now() + 1_000,
      purpose: "Report phone readiness", targetDeviceId: appA.ready.deviceId,
    }));
    await until(() => appA.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "hinted"));

    plugin.send(JSON.stringify({
      kind: "mobile_request", requestId: "stranger", command: "device.status",
      threadId: turn.threadId, turnId: turn.turnId, expiresAt: Date.now() + 1_000,
      purpose: "Report phone readiness", targetDeviceId: "a-phone-paired-to-nobody",
    }));
    await until(() => appB.frames.some((frame) => frame.type === "mobile_node_request" && frame.requestId === "stranger"));

    // Capability 71. The draft belongs to the person: device A writes it, device B reads it, and
    // the clear a send writes reaches device B too, so it never offers to resend what was sent.
    const typed = await fetch(`${gateway.url}/bots/sage/drafts`, {
      method: "PUT", headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: turn.threadId, text: "half a thought" }),
    });
    expect(typed.status).toBe(200);
    await until(() => appB.frames.some(
      (frame) => (frame as { type: string }).type === "bot_draft_updated"
        && (frame as unknown as { text: string }).text === "half a thought",
    ));
    const readOnB = await fetch(
      `${gateway.url}/bots/sage/drafts?sessionId=${encodeURIComponent(turn.threadId)}`,
      { headers: { authorization: `Bearer ${tokenB}` } },
    );
    expect(await readOnB.json()).toMatchObject({ sessionId: turn.threadId, text: "half a thought" });

    await fetch(`${gateway.url}/bots/sage/drafts`, {
      method: "PUT", headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: turn.threadId, text: "" }),
    });
    await until(() => appB.frames.some(
      (frame) => (frame as { type: string }).type === "bot_draft_updated"
        && (frame as unknown as { text: string }).text === "",
    ));
    const clearedOnB = await fetch(
      `${gateway.url}/bots/sage/drafts?sessionId=${encodeURIComponent(turn.threadId)}`,
      { headers: { authorization: `Bearer ${tokenB}` } },
    );
    expect(await clearedOnB.json()).toMatchObject({ text: "" });
  } finally {
    for (const socket of sockets)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    await hermes?.close();
    delete process.env["SELECT_E2E_DASHBOARD_TOKEN"];
    delete process.env["SELECT_E2E_SAGE_TOKEN"];
  }
}, 20_000);

async function pair(gateway: RunningGateway): Promise<string> {
  const response = await fetch(`${gateway.url}/pair`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
  });
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

function requestStatus(plugin: WebSocket, turn: { threadId: string; turnId: string }, requestId: string): void {
  plugin.send(JSON.stringify({
    kind: "mobile_request", requestId, command: "device.status", threadId: turn.threadId,
    turnId: turn.turnId, expiresAt: Date.now() + 1_000, purpose: "Report phone readiness",
  }));
}

async function lifecycle(url: string, token: string, sessionId: string, requestId: string) {
  const response = await fetch(
    `${url}/bots/sage/mobile-requests?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(response.status).toBe(200);
  const body = await response.json() as { requests: Record<string, unknown>[] };
  return body.requests.find((request) => request["requestId"] === requestId);
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

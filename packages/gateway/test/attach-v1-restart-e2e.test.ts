import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import { expect, it } from "vitest";
import type { Message, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";

it("attach-v1 completes exactly once after a gateway restart mid-reply", async () => {
  const tokenEnv = "ATTACH_V1_RESTART_TOKEN";
  process.env[tokenEnv] = "restart-secret";
  const dbPath = join(mkdtempSync(join(tmpdir(), "attach-restart-")), "gateway.sqlite");
  const config = {
    name: "restart", port: 0, dbPath, turnTimeoutSeconds: 0,
    agents: [{ id: "sage", name: "Sage", backend: "attach", options: { tokenEnv, turnTimeoutSeconds: 120 } }],
  };
  let gateway: RunningGateway | undefined;
  const sockets: WebSocket[] = [];
  try {
    gateway = await startGateway(config);
    const pair = await fetch(`${gateway.url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }) });
    const deviceToken = ((await pair.json()) as { deviceToken: string }).deviceToken;
    const threadRes = await fetch(`${gateway.url}/threads`, { method: "POST", headers: auth(deviceToken), body: JSON.stringify({ agentId: "sage", title: "restart" }) });
    const threadId = ((await threadRes.json()) as { id: string }).id;

    const firstPluginFrames: any[] = [];
    const firstPlugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer restart-secret" } });
    sockets.push(firstPlugin);
    firstPlugin.on("message", (data) => firstPluginFrames.push(JSON.parse(String(data))));
    await once(firstPlugin, "open");
    firstPlugin.send(JSON.stringify({ kind: "hello", version: 1, instanceId: "plugin", capabilities: ["draft"], resume: { eventSequence: 0, commandSequence: 0 } }));
    await until(() => firstPluginFrames.some((frame) => frame.kind === "hello_ack"));

    await fetch(`${gateway.url}/threads/${threadId}/messages`, { method: "POST", headers: auth(deviceToken), body: JSON.stringify({ blocks: [{ type: "paragraph", text: "hello" }] }) });
    await until(() => firstPluginFrames.some((frame) => frame.kind === "command"));
    const command = firstPluginFrames.find((frame) => frame.kind === "command");
    firstPlugin.send(JSON.stringify({ kind: "ack", channel: "command", sequence: command.sequence, id: command.commandId }));
    firstPlugin.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "draft-1", event: { kind: "draft", threadId, turnId: command.command.turnId, blocks: [{ type: "paragraph", text: "half" }] } }));
    await until(() => firstPluginFrames.some((frame) => frame.kind === "ack" && frame.channel === "event"));

    await gateway.close();
    gateway = await startGateway(config);
    const clientFrames: ServerFrame[] = [];
    const client = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    sockets.push(client);
    client.on("message", (data) => clientFrames.push(JSON.parse(String(data)) as ServerFrame));
    await once(client, "open");
    client.send(JSON.stringify({ type: "auth", token: deviceToken }));
    await until(() => clientFrames.some((frame) => frame.type === "ready"));

    const secondPluginFrames: any[] = [];
    const secondPlugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer restart-secret" } });
    sockets.push(secondPlugin);
    secondPlugin.on("message", (data) => secondPluginFrames.push(JSON.parse(String(data))));
    await once(secondPlugin, "open");
    secondPlugin.send(JSON.stringify({ kind: "hello", version: 1, instanceId: "plugin", capabilities: ["draft"], resume: { eventSequence: 1, commandSequence: 1 } }));
    await until(() => secondPluginFrames.some((frame) => frame.kind === "hello_ack"));
    secondPlugin.send(JSON.stringify({ kind: "event", sequence: 2, eventId: "commit-1", event: { kind: "commit", threadId, turnId: command.command.turnId, messageId: "assistant-1", blocks: [{ type: "paragraph", text: "finished" }] } }));
    await until(() => secondPluginFrames.some((frame) => frame.kind === "ack" && frame.sequence === 2));
    await until(() => clientFrames.some((frame) => frame.type === "committed" && frame.message.role === "agent"));

    const history = await fetch(`${gateway.url}/threads/${threadId}/messages`, { headers: { authorization: `Bearer ${deviceToken}` } });
    const messages = ((await history.json()) as { messages: Message[] }).messages;
    expect(messages.filter((message) => message.role === "agent").map((message) => message.blocks)).toEqual([[{ type: "paragraph", text: "finished" }]]);
    expect(messages.some((message) => message.marker === "turn.failed")).toBe(false);
  } finally {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    delete process.env[tokenEnv];
  }
});

function auth(token: string) { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }
async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > 3000) throw new Error("timeout"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

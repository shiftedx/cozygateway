import { once } from "node:events";

import { WebSocket } from "ws";
import { expect, it } from "vitest";
import type { BotChatMessage, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

it("runs a native Bot Mode text turn over attach-v1 while Dashboard stays control-plane-only", async () => {
  process.env["NATIVE_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["NATIVE_SAGE_TOKEN"] = "attach-secret";
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
      name: "native-e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default",
        url: hermes.url,
        tokenEnv: "NATIVE_DASHBOARD_TOKEN",
        profiles: { sage: { tokenEnv: "NATIVE_SAGE_TOKEN", name: "Sage" } },
      }],
    });
    const pair = await fetch(`${gateway.url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }) });
    const deviceToken = ((await pair.json()) as { deviceToken: string }).deviceToken;
    expect((await fetch(`${gateway.url}/attach`)).status).toBe(404);

    const clientFrames: ServerFrame[] = [];
    const client = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    sockets.push(client);
    client.on("message", (data) => clientFrames.push(JSON.parse(String(data)) as ServerFrame));
    await once(client, "open");
    client.send(JSON.stringify({ type: "auth", token: deviceToken }));
    await until(() => clientFrames.some((frame) => frame.type === "ready"));
    await until(() => gateway!.storage.botRoster().bots.some((bot) => bot.name === "sage"));

    const readinessURL = `${gateway.url}/bots/sage/readiness`;
    const auth = { authorization: `Bearer ${deviceToken}` };
    expect(await (await fetch(readinessURL, { headers: auth })).json()).toMatchObject({
      name: "sage", status: "starting",
    });

    const pluginFrames: any[] = [];
    const plugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer attach-secret" } });
    sockets.push(plugin);
    plugin.on("message", (data) => pluginFrames.push(JSON.parse(String(data))));
    await once(plugin, "open");
    plugin.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "hermes-sage", capabilities: ["draft", "scheduled", "clarify"], resume: { eventSequence: 0, commandSequence: 0 } }));
    await until(() => pluginFrames.some((frame) => frame.kind === "hello_ack"));
    await until(async () =>
      ((await (await fetch(readinessURL, { headers: auth })).json()) as { status: string }).status === "ready");
    expect(pluginFrames.find((frame) => frame.kind === "hello_ack")?.capabilities).not.toContain("media");

    const send = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello native", clientId: "client-native-1" }),
    });
    expect(send.status).toBe(202);
    await until(() => pluginFrames.some((frame) => frame.kind === "command"));
    const command = pluginFrames.find((frame) => frame.kind === "command");
    expect(command.command).toMatchObject({ kind: "turn", messageId: "client-native-1", text: "hello native" });
    plugin.send(JSON.stringify({ kind: "ack", channel: "command", sequence: command.sequence, id: command.commandId }));
    plugin.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "native-draft", event: { kind: "draft", threadId: command.command.threadId, turnId: command.command.turnId, blocks: [{ type: "paragraph", text: "working" }] } }));
    plugin.send(JSON.stringify({ kind: "event", sequence: 2, eventId: "native-commit", event: { kind: "commit", threadId: command.command.threadId, turnId: command.command.turnId, messageId: "native-answer", blocks: [{ type: "paragraph", text: "native answer" }] } }));
    await until(() => clientFrames.some((frame) => frame.type === "bot_chat" && frame.messages.some((message) => message.id === "native-answer")));

    const historyResponse = await fetch(`${gateway.url}/bots/sage/chat/messages`, { headers: { authorization: `Bearer ${deviceToken}` } });
    const history = (await historyResponse.json()) as { messages: BotChatMessage[]; status?: string };
    expect(history.messages.map((message) => [message.role, message.text])).toEqual([["user", "hello native"], ["assistant", "native answer"]]);
    expect(history.status).toBe("completed");

    const rosterResponse = await fetch(`${gateway.url}/bots`, { headers: { authorization: `Bearer ${deviceToken}` } });
    const roster = (await rosterResponse.json()) as { bots: Array<{ name: string; chatSessionId: string | null; preview: { kind: string; text: string }; lastActiveAt: number | null }> };
    expect(roster.bots.find((bot) => bot.name === "sage")).toMatchObject({
      chatSessionId: command.command.threadId,
      preview: { kind: "plain", text: "native answer" },
    });
    expect(roster.bots.find((bot) => bot.name === "sage")?.lastActiveAt).not.toBeNull();

    const clarifyTurnResponse = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "ask me", clientId: "client-clarify" }),
    });
    expect(clarifyTurnResponse.status).toBe(202);
    await until(() => pluginFrames.filter((frame) => frame.kind === "command" && frame.command.kind === "turn").length === 2);
    const clarifyTurn = pluginFrames.filter((frame) => frame.kind === "command" && frame.command.kind === "turn").at(-1);
    plugin.send(JSON.stringify({ kind: "event", sequence: 3, eventId: "clarify-pending", event: { kind: "clarify", threadId: clarifyTurn.command.threadId, turnId: clarifyTurn.command.turnId, clarifyId: "question-1", prompt: "Choose one", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], status: "pending" } }));
    await until(() => clientFrames.some((frame) => frame.type === "bot_clarify_pending" && frame.clarifyId === "question-1"));
    const clarify = await fetch(`${gateway.url}/bots/sage/clarifications/question-1`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ optionId: "b" }),
    });
    expect(clarify.status).toBe(202);
    expect(await clarify.json()).toEqual({ outcome: "requested" });
    await until(() => pluginFrames.some((frame) => frame.kind === "command" && frame.command.kind === "resolve_clarify"));
    const clarifyCommand = pluginFrames.find((frame) => frame.kind === "command" && frame.command.kind === "resolve_clarify");
    expect(clarifyCommand?.command).toMatchObject({ clarifyId: "question-1", optionId: "b", threadId: clarifyTurn.command.threadId, turnId: clarifyTurn.command.turnId });
    plugin.send(JSON.stringify({ kind: "ack", channel: "command", sequence: clarifyCommand.sequence, id: clarifyCommand.commandId }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(clientFrames.some((frame) => frame.type === "bot_clarify_resolved" && frame.clarifyId === "question-1")).toBe(false);
    plugin.send(JSON.stringify({ kind: "event", sequence: 4, eventId: "clarify-selected", event: { kind: "clarify", threadId: clarifyTurn.command.threadId, turnId: clarifyTurn.command.turnId, clarifyId: "question-1", prompt: "Choose one", options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }], status: "resolved", selectedOptionId: "b" } }));
    await until(() => clientFrames.some((frame) => frame.type === "bot_clarify_resolved" && frame.clarifyId === "question-1" && frame.outcome === "selected"));

    const canonicalScheduled = { kind: "event", sequence: 5, eventId: "scheduled-home", event: { kind: "scheduled", target: { kind: "canonical_home" }, deliveryId: "daily-1", messageId: "daily-message-1", blocks: [{ type: "paragraph", text: "canonical daily" }] } };
    plugin.send(JSON.stringify(canonicalScheduled));
    await until(() => pluginFrames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 5));
    const receipt = await fetch(`${gateway.url}/attach/v1/deliveries/daily-1`, { headers: { authorization: "Bearer attach-secret" } });
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({
      state: "projected",
      target: { kind: "canonical_home", sessionId: command.command.threadId },
    });
    // A producer retry gets a new transport frame but remains one durable occurrence.
    plugin.send(JSON.stringify({ ...canonicalScheduled, sequence: 6, eventId: "scheduled-home-retry" }));
    await until(() => pluginFrames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 6));
    let scheduledHistory = (await (await fetch(`${gateway.url}/bots/sage/chat/messages`, { headers: { authorization: `Bearer ${deviceToken}` } })).json()) as { messages: BotChatMessage[] };
    expect(scheduledHistory.messages.filter((message) => message.id === "daily-message-1")).toHaveLength(1);

    const selectedSessionId = gateway.storage.resetNativeBotChat("sage", Date.now());
    plugin.send(JSON.stringify({ kind: "event", sequence: 7, eventId: "scheduled-historical", event: { kind: "scheduled", threadId: command.command.threadId, deliveryId: "historical-delivery", messageId: "historical-message", blocks: [{ type: "paragraph", text: "must not appear" }] } }));
    await until(() => pluginFrames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 7));
    expect(pluginFrames.find((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 7)).toMatchObject({
      discarded: true, reason: "unauthorized_target",
    });
    expect(gateway.storage.attachEventCursor("sage")).toBe(7);
    expect(gateway.storage.nativeBotMessages("sage", command.command.threadId).some((message) => message.id === "historical-message")).toBe(false);
    plugin.close();
    await once(plugin, "close");

    const selectedPluginFrames: any[] = [];
    const selectedPlugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer attach-secret" } });
    sockets.push(selectedPlugin);
    selectedPlugin.on("message", (data) => selectedPluginFrames.push(JSON.parse(String(data))));
    await once(selectedPlugin, "open");
    selectedPlugin.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "hermes-sage-selected", capabilities: ["draft", "scheduled", "clarify"], resume: { eventSequence: 7, commandSequence: 0 } }));
    await until(() => selectedPluginFrames.some((frame) => frame.kind === "hello_ack"));
    selectedPlugin.send(JSON.stringify({ kind: "event", sequence: 8, eventId: "scheduled-selected", event: { kind: "scheduled", threadId: selectedSessionId, deliveryId: "selected-delivery", messageId: "selected-message", blocks: [{ type: "paragraph", text: "selected daily" }] } }));
    await until(() => selectedPluginFrames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 8));
    expect(gateway.storage.attachEventCursor("sage")).toBe(8);
    scheduledHistory = (await (await fetch(`${gateway.url}/bots/sage/chat/messages`, { headers: { authorization: `Bearer ${deviceToken}` } })).json()) as { messages: BotChatMessage[] };
    expect(scheduledHistory.messages.map((message) => message.id)).toContain("selected-message");

    const offlineTurnResponse = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "ask while reconnecting", clientId: "client-offline-clarify" }),
    });
    expect(offlineTurnResponse.status).toBe(202);
    await until(() => selectedPluginFrames.some((frame) => frame.kind === "command" && frame.command.kind === "turn" && frame.command.messageId === "client-offline-clarify"));
    const offlineTurn = selectedPluginFrames.find((frame) => frame.kind === "command" && frame.command.kind === "turn" && frame.command.messageId === "client-offline-clarify");
    selectedPlugin.send(JSON.stringify({
      kind: "event", sequence: 9, eventId: "offline-clarify-pending",
      event: {
        kind: "clarify", threadId: offlineTurn.command.threadId, turnId: offlineTurn.command.turnId,
        clarifyId: "offline-question", prompt: "Choose after reconnect", options: [{ id: "a", label: "A" }], status: "pending",
      },
    }));
    await until(() => clientFrames.some((frame) => frame.type === "bot_clarify_pending" && frame.clarifyId === "offline-question"));
    selectedPlugin.close();
    await once(selectedPlugin, "close");

    const queuedResolution = await fetch(`${gateway.url}/bots/sage/clarifications/offline-question`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ optionId: "a" }),
    });
    expect(queuedResolution.status).toBe(202);
    expect(await queuedResolution.json()).toEqual({ outcome: "requested" });

    const downgradedFrames: any[] = [];
    const downgradedPlugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer attach-secret" } });
    sockets.push(downgradedPlugin);
    downgradedPlugin.on("message", (data) => downgradedFrames.push(JSON.parse(String(data))));
    await once(downgradedPlugin, "open");
    downgradedPlugin.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "hermes-sage-no-clarify", capabilities: ["draft", "scheduled"],
      resume: { eventSequence: 9, commandSequence: 0 },
    }));
    await until(() => downgradedFrames.some((frame) => frame.kind === "command" && frame.command.kind === "discard" && frame.command.originalKind === "resolve_clarify"));
    expect(gateway.storage.nativeInteraction("sage", "clarify", "offline-question")).toMatchObject({
      status: "pending", resolutionCommandId: null, resolutionRequestedAt: null,
    });
    // The fake Dashboard implements no prompt.submit/session.resume methods. Reaching this point
    // proves the authoritative native profile never attempted either chat RPC.
  } finally {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    await hermes?.close();
    delete process.env["NATIVE_DASHBOARD_TOKEN"];
    delete process.env["NATIVE_SAGE_TOKEN"];
  }
});

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

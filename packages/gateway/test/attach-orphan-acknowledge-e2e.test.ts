import { once } from "node:events";

import { WebSocket } from "ws";
import { expect, it } from "vitest";
import type { BotChatMessage } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Issue #193, the silent-brick class: one permanently unappliable event (its durable turn
 *  binding never existed or is gone) used to decline projection forever, dead-letter, and block
 *  every later journaled event for the agent -- acknowledged on the wire, never applied, nothing
 *  in the app. An orphaned event is a fact about the past, not future work: the gateway now
 *  acknowledges it and the stream keeps applying. */
it("an orphaned event does not block later turns from applying", async () => {
  process.env["ORPHAN_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["ORPHAN_SAGE_TOKEN"] = "attach-secret";
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
      name: "orphan-e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default",
        url: hermes.url,
        tokenEnv: "ORPHAN_DASHBOARD_TOKEN",
        profiles: { sage: { tokenEnv: "ORPHAN_SAGE_TOKEN", name: "Sage" } },
      }],
    });
    const pair = await fetch(`${gateway.url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }) });
    const deviceToken = ((await pair.json()) as { deviceToken: string }).deviceToken;
    await until(() => gateway!.storage.botRoster().bots.some((bot) => bot.name === "sage"));

    const pluginFrames: any[] = [];
    const plugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer attach-secret" } });
    sockets.push(plugin);
    plugin.on("message", (data) => pluginFrames.push(JSON.parse(String(data))));
    await once(plugin, "open");
    plugin.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "hermes-sage", capabilities: ["draft"], resume: { eventSequence: 0, commandSequence: 0 } }));
    await until(() => pluginFrames.some((frame) => frame.kind === "hello_ack"));

    const send = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello native", clientId: "client-1" }),
    });
    expect(send.status).toBe(202);
    await until(() => pluginFrames.some((frame) => frame.kind === "command"));
    const command = pluginFrames.find((frame) => frame.kind === "command");
    plugin.send(JSON.stringify({ kind: "ack", channel: "command", sequence: command.sequence, id: command.commandId }));

    // A restarted plugin replays its spool: first an event for a turn this gateway holds no
    // durable command for (the orphan), then the real turn's reply.
    plugin.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "orphan-commit", event: { kind: "commit", threadId: command.command.threadId, turnId: "turn-from-another-life", messageId: "orphan-answer", blocks: [{ type: "paragraph", text: "from a discarded turn" }] } }));
    plugin.send(JSON.stringify({ kind: "event", sequence: 2, eventId: "real-commit", event: { kind: "commit", threadId: command.command.threadId, turnId: command.command.turnId, messageId: "real-answer", blocks: [{ type: "paragraph", text: "the real answer" }] } }));
    await until(() => pluginFrames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 2));

    await until(() => gateway!.storage.unappliedAttachEvents("sage").length === 0);
    const history = (await (await fetch(`${gateway.url}/bots/sage/chat/messages`, { headers: { authorization: `Bearer ${deviceToken}` } })).json()) as { messages: BotChatMessage[]; status?: string };
    expect(history.messages.some((message) => message.id === "real-answer")).toBe(true);
    expect(history.messages.some((message) => message.id === "orphan-answer")).toBe(false);
    expect(history.status).toBe("completed");
  } finally {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    await hermes?.close();
    delete process.env["ORPHAN_DASHBOARD_TOKEN"];
    delete process.env["ORPHAN_SAGE_TOKEN"];
  }
});

async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 4000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

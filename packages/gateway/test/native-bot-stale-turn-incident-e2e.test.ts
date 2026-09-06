import { once } from "node:events";

import { WebSocket } from "ws";
import { expect, it } from "vitest";
import type { BotChatMessage, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** HF2. The 2026-09-06 incident, replayed frame for frame against a real gateway.
 *
 *  1. The gateway dispatches a turn. The peer acks the command and then drops the turn
 *     internally: no draft, no commit, no terminal, ever.
 *  2. The peer restarts.
 *  3. The person sends their next message.
 *  4. The peer answers.
 *
 *  Before capability 69, step 3 went out as a steer on a turn nothing held, step 4 arrived on a
 *  turn id the gateway never issued, was declined for having "no durable turn command", and the
 *  reply never reached the phone. The assertion that matters is the last one: the answer is in
 *  the conversation. */
it("never loses a reply to a native turn the peer dropped and then re-attached without", async () => {
  process.env["NATIVE_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["NATIVE_SAGE_TOKEN"] = "attach-secret";
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
      name: "hf2-incident",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{
        id: "default",
        url: hermes.url,
        tokenEnv: "NATIVE_DASHBOARD_TOKEN",
        profiles: { sage: { tokenEnv: "NATIVE_SAGE_TOKEN", name: "Sage" } },
      }],
    });
    const pair = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
    });
    const deviceToken = ((await pair.json()) as { deviceToken: string }).deviceToken;
    const auth = { authorization: `Bearer ${deviceToken}` };

    const clientFrames: ServerFrame[] = [];
    const client = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    sockets.push(client);
    client.on("message", (data) => clientFrames.push(JSON.parse(String(data)) as ServerFrame));
    await once(client, "open");
    client.send(JSON.stringify({ type: "auth", token: deviceToken }));
    await until(() => clientFrames.some((frame) => frame.type === "ready"));
    await until(() => gateway!.storage.botRoster().bots.some((bot) => bot.name === "sage"));

    // 1. The peer attaches and takes a turn, then goes quiet forever.
    const firstFrames: any[] = [];
    const first = await attach(gateway.url, firstFrames);
    sockets.push(first);
    first.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "hermes-sage-1",
      capabilities: ["draft", "scheduled"], resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => firstFrames.some((frame) => frame.kind === "hello_ack"));

    const send = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "what is the plan", clientId: "client-1" }),
    });
    expect(send.status).toBe(202);
    await until(() => firstFrames.some((frame) => frame.kind === "command" && frame.command.kind === "turn"));
    const dropped = firstFrames.find((frame) => frame.kind === "command" && frame.command.kind === "turn");
    first.send(JSON.stringify({ kind: "ack", channel: "command", sequence: dropped.sequence, id: dropped.commandId }));
    const sessionId: string = dropped.command.threadId;
    const droppedTurnId: string = dropped.command.turnId;
    await until(() => gateway!.storage.nativeBotChat("sage", Date.now()).activeTurnId === droppedTurnId);

    // 2. The peer restarts. Its new hello declares the turns it still carries: none.
    first.close();
    const secondFrames: any[] = [];
    const second = await attach(gateway.url, secondFrames);
    sockets.push(second);
    second.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "hermes-sage-2",
      capabilities: ["draft", "scheduled"], resume: { eventSequence: 0, commandSequence: 0 },
      activeTurns: [],
    }));
    await until(() => secondFrames.some((frame) => frame.kind === "hello_ack"));

    // The stale turn is sealed at once, through the ordinary turn transition, and not 21 minutes
    // later. Nothing is left running for the next message to steer.
    await until(() => gateway!.storage.nativeBotTurnTerminal("sage", sessionId, droppedTurnId) !== undefined);
    expect(gateway.storage.nativeBotTurnTerminal("sage", sessionId, droppedTurnId)).toMatchObject({ status: "failed" });
    expect(clientFrames.some((frame) => frame.type === "bot_chat_state" && frame.phase === "failed")).toBe(true);
    await until(() => gateway!.storage.nativeBotChat("sage", Date.now()).activeTurnId === undefined);

    // 3. Kyle's next message. It opens a NEW durable turn instead of steering a dead one.
    const followUp = await fetch(`${gateway.url}/bots/sage/chat/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "and the timeline?", clientId: "client-2" }),
    });
    expect(followUp.status).toBe(202);
    await until(() => secondFrames.some((frame) => frame.kind === "command" && frame.command.kind === "turn"));
    const live = secondFrames.find((frame) => frame.kind === "command" && frame.command.kind === "turn");
    expect(live.command.turnId).not.toBe(droppedTurnId);
    expect(live.command.text).toBe("and the timeline?");
    second.send(JSON.stringify({ kind: "ack", channel: "command", sequence: live.sequence, id: live.commandId }));

    // 4. The peer answers, and the answer lands in the conversation.
    second.send(JSON.stringify({
      kind: "event", sequence: 1, eventId: "hf2-answer",
      event: {
        kind: "commit", threadId: sessionId, turnId: live.command.turnId,
        messageId: "hf2-answer", blocks: [{ type: "paragraph", text: "two weeks" }],
      },
    }));
    await until(() => clientFrames.some((frame) =>
      frame.type === "bot_chat" && frame.messages.some((message) => message.id === "hf2-answer")));
    const transcript = await history(gateway.url, auth);
    expect(transcript.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "what is the plan"],
      ["user", "and the timeline?"],
      ["assistant", "two weeks"],
    ]);
  } finally {
    for (const socket of sockets)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    await hermes?.close();
    delete process.env["NATIVE_DASHBOARD_TOKEN"];
    delete process.env["NATIVE_SAGE_TOKEN"];
  }
});

async function attach(url: string, frames: any[]): Promise<WebSocket> {
  const socket = new WebSocket(`${url.replace("http", "ws")}/attach/v1`, {
    headers: { authorization: "Bearer attach-secret" },
  });
  socket.on("message", (data) => frames.push(JSON.parse(String(data))));
  await once(socket, "open");
  return socket;
}

async function history(url: string, auth: Record<string, string>): Promise<{
  messages: BotChatMessage[]; status?: string; running?: boolean;
}> {
  const response = await fetch(`${url}/bots/sage/chat/messages`, { headers: auth });
  return (await response.json()) as { messages: BotChatMessage[]; status?: string; running?: boolean };
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

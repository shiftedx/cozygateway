import { once } from "node:events";
import { WebSocket } from "ws";
import { expect, it } from "vitest";
import { startGateway } from "../src/server.ts";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

it("routes a configured chat through the selected runner and projects its reply as the original bot", async () => {
  process.env.CHAT_E2E_SOURCE_TOKEN = "source-example";
  process.env.COZYGATEWAY_RUNNER_TOKEN = "runner-example";
  const gateway = await startGateway({ name: "chat-execution-e2e", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
    bots: [{ id: "sage", name: "Sage", runtime: "cozyagents", tokenEnv: "CHAT_E2E_SOURCE_TOKEN" }],
  });
  const sockets: WebSocket[] = [];
  const pending: Promise<unknown>[] = [];
  try {
    const paired = await (await fetch(`${gateway.url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }) })).json() as { deviceToken: string };
    const auth = { authorization: `Bearer ${paired.deviceToken}`, "content-type": "application/json" };
    const request = (path: string, method = "GET", body?: unknown) => fetch(`${gateway.url}${path}`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const sourceTurns: unknown[] = [];
    const childTurns: any[] = [];
    let childPeer: string | undefined;
    async function attach(token: string, source: boolean): Promise<void> {
      const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: `Bearer ${token}` } });
      sockets.push(ws);
      let ready = false;
      ws.on("message", (data) => {
        const frame = JSON.parse(String(data));
        if (frame.kind === "hello_ack") { ready = true; if (!source) childPeer = frame.agentId; }
        if (frame.kind === "heartbeat") ws.send(JSON.stringify({ kind: "heartbeat", sentAt: frame.sentAt }));
        if (frame.kind === "config_request") {
          let result: unknown;
          if (frame.operation === "chat.configuration.read") result = { computer: { id: source ? "source-computer" : "legacy", name: "Computer", isAvailable: true }, configuration: null };
          else if (frame.operation === "profile.read") result = { name: "Sage", description: "", soul: "Source bot instructions", skills: [], toolsets: [], toolsetsPinned: false, mcpServers: [], model: { provider: "openai", default: "example" }, runtimeInert: [] };
          else if (frame.operation === "model.read") result = { model: "openai:example", effort: null, catalog: [{ id: "openai:example", displayName: "Example" }], efforts: [] };
          else if (frame.operation === "chat.configuration.prepare") result = { configuration: frame.input.configuration };
          else if (frame.operation === "providers.connections.list") result = { connections: [] };
          ws.send(JSON.stringify({ kind: "config_result", requestId: frame.requestId, status: result ? "ok" : "unavailable", ...(result ? { result } : {}) }));
        }
        if (frame.kind === "command" && frame.command.kind === "turn") {
          if (source) sourceTurns.push(frame.command);
          else {
            childTurns.push(frame.command);
            ws.send(JSON.stringify({ kind: "ack", channel: "command", sequence: frame.sequence, id: frame.commandId }));
            ws.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "remote-reply", event: { kind: "commit", threadId: frame.command.threadId, turnId: frame.command.turnId, messageId: "remote-answer", blocks: [{ type: "paragraph", text: "Finished on the selected computer" }] } }));
          }
        }
      });
      await once(ws, "open");
      ws.send(JSON.stringify({ kind: "hello", version: 2, instanceId: source ? "source" : "child", capabilities: ["bot_config", "chat_configuration", "provider_connections", "draft"], resume: { eventSequence: 0, commandSequence: 0 } }));
      await until(() => ready);
    }
    await attach("source-example", true);
    const runner = new WebSocket(`${gateway.url.replace("http", "ws")}/runner/v1`, { headers: { authorization: "Bearer runner-example" } });
    sockets.push(runner);
    let runnerReady = false;
    let launch: any;
    runner.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.kind === "hello_ack") runnerReady = true;
      if (frame.kind === "heartbeat") runner.send(JSON.stringify({ kind: "heartbeat", sentAt: frame.sentAt }));
      if (frame.command === "list_chat_projects") runner.send(JSON.stringify({ kind: "chat_workspace_result", requestId: frame.payload.requestId, result: { projects: [{ id: "project", name: "Project", isGitRepository: true, currentBranch: "main" }] } }));
      if (frame.command === "create_chat_execution") {
        launch = frame.payload;
        pending.push(attach(launch.attachToken, false));
      }
    });
    await once(runner, "open");
    runner.send(JSON.stringify({ kind: "hello", version: 1, runnerId: "remote-runner", backends: ["process"], capabilities: { chat_execution: 1 }, chatExecutionHarnesses: ["cozyagents"] }));
    await until(() => runnerReady);
    const oldSession = gateway.storage.nativeBotChat("sage", Date.now()).sessionId;
    expect((await request("/bots/sage/chat/reset", "POST")).status).toBe(200);
    const snapshot = await (await request("/bots/sage/chat/configuration")).json() as any;
    expect(snapshot.computers.map((row: any) => row.id)).toContain("legacy");
    const selected = { computerId: "legacy", projectId: "project", mode: "worktree", branch: "main" };
    expect((await request("/bots/sage/chat/configuration", "PUT", { sessionId: snapshot.configuration.sessionId, workspace: selected })).status).toBe(200);
    const sent = await request("/bots/sage/chat/messages", "POST", { text: "Work here", clientId: "first-remote-message" });
    expect(sent.status, await sent.clone().text()).toBe(202);
    await until(() => gateway.storage.nativeBotMessages("sage", snapshot.configuration.sessionId).some((message) => message.id === "remote-answer"));
    expect(sourceTurns).toEqual([]);
    expect(childTurns).toHaveLength(1);
    expect(childTurns[0].chatContext).toMatchObject({ sessionId: snapshot.configuration.sessionId, workspace: selected, model: { providerId: "openai", modelId: "example" } });
    expect(launch.sourceProfile.soul).toBe("Source bot instructions");
    expect(launch.botId).toBe("sage");
    expect(launch.executionId).toBe(childPeer);
    expect(gateway.storage.chatExecution("sage", oldSession)).toBeUndefined();
    const roster = await (await request("/bots")).json() as any;
    expect(roster.bots.map((bot: any) => bot.name)).toEqual(["sage"]);
    expect((await request("/gateway/harnesses")).status).toBe(200);
    expect((await request("/gateway/harnesses/cozyagents/scopes/sage/provider-connections")).status).toBe(200);
  } finally {
    await Promise.allSettled(pending);
    for (const socket of sockets) socket.close();
    await gateway.close();
    delete process.env.CHAT_E2E_SOURCE_TOKEN;
    delete process.env.COZYGATEWAY_RUNNER_TOKEN;
  }
});

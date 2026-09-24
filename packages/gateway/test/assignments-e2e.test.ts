import { once } from "node:events";

import { WebSocket } from "ws";
import { expect, it } from "vitest";
import type { AssignmentView, GatewayInfo, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** agent-inbox 1 end to end over the real listener: a leader profile assigns work with its own
 *  attach bearer, a stock Hermes profile answers it as an ordinary attach-v1 turn over the real
 *  socket, the leader acknowledges it, and the paired phone reads the Task, the inbox and the
 *  live activity frames. */
it("a leader assigns to a Hermes profile over attach-v1 and acknowledges the result", async () => {
  process.env["ASSIGN_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["ASSIGN_LEAD_TOKEN"] = "lead-secret";
  process.env["ASSIGN_SCOUT_TOKEN"] = "scout-secret";
  let gateway: RunningGateway | undefined;
  let hermes: FakeHermesServer | undefined;
  const sockets: WebSocket[] = [];
  try {
    hermes = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({ profiles: [
          { name: "lead", description: "leads", has_avatar: false, ui_meta: { "hermes-bots": { title: "Lead" } } },
          { name: "scout", description: "scouts", has_avatar: false, ui_meta: { "hermes-bots": { title: "Scout" } } },
        ], bot_mode_protocol: true }),
      },
    });
    gateway = await startGateway({
      name: "assign-e2e", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", url: hermes.url, tokenEnv: "ASSIGN_DASHBOARD_TOKEN",
        profiles: { lead: { tokenEnv: "ASSIGN_LEAD_TOKEN", name: "Lead" }, scout: { tokenEnv: "ASSIGN_SCOUT_TOKEN", name: "Scout" } } }],
    });
    const url = gateway.url;
    await until(() => gateway!.storage.botRoster().bots.some((bot) => bot.name === "lead"));
    const health = (await (await fetch(`${url}/health`)).json()) as GatewayInfo;
    expect(health.capabilities?.["com.cozylabs.agent-inbox"]).toBe(1);
    expect(health.capabilities?.["com.cozylabs.bots"]).toBe(89);

    const pair = await fetch(`${url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }) });
    const deviceToken = ((await pair.json()) as { deviceToken: string }).deviceToken;
    const device = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" } });
    const lead = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { authorization: "Bearer lead-secret", "content-type": "application/json" }, body: JSON.stringify(body) });

    const frames: ServerFrame[] = [];
    const phone = new WebSocket(`${url.replace("http", "ws")}/ws`);
    sockets.push(phone);
    phone.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    await once(phone, "open");
    phone.send(JSON.stringify({ type: "auth", token: deviceToken }));
    await until(() => frames.some((frame) => frame.type === "ready"));

    // A stock Hermes plugin: it answers every turn with a reply that ends in a Result: block.
    const pluginFrames: any[] = [];
    const plugin = new WebSocket(`${url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer scout-secret" } });
    sockets.push(plugin);
    let sequence = 0;
    plugin.on("message", (data) => {
      const frame = JSON.parse(String(data));
      pluginFrames.push(frame);
      if (frame.kind !== "command" || frame.command.kind !== "turn") return;
      plugin.send(JSON.stringify({ kind: "ack", channel: "command", sequence: frame.sequence, id: frame.commandId }));
      sequence += 1;
      plugin.send(JSON.stringify({ kind: "event", sequence, eventId: `reply-${sequence}`, event: {
        kind: "commit", threadId: frame.command.threadId, turnId: frame.command.turnId, messageId: `answer-${sequence}`,
        blocks: [{ type: "paragraph", text: "Checked.\nResult:\nstatus: done\nCI is green on main.\nartifacts: ci/log.txt" }],
      } }));
    });
    await once(plugin, "open");
    plugin.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "hermes-scout", capabilities: ["draft"], resume: { eventSequence: 0, commandSequence: 0 } }));
    await until(() => pluginFrames.some((frame) => frame.kind === "hello_ack"));

    // Only a leader may assign, and the team is set from the phone.
    const refused = await lead("/bots/lead/assignments", { to: "scout", brief: "Check CI", doneCriteria: "main is green" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: "not_leader" });
    expect((await device("/bots/lead/profile", { method: "PATCH", body: JSON.stringify({ role: "leader", reports: ["scout"] }) })).status).toBe(200);

    const created = await lead("/bots/lead/assignments", { to: "scout", brief: "Check CI", doneCriteria: "main is green", idempotencyKey: "ci-1" });
    expect(created.status).toBe(201);
    const { taskId, threadId } = (await created.json()) as AssignmentView;
    const turn = pluginFrames.find((frame) => frame.kind === "command" && frame.command.kind === "turn");
    expect(turn.command).toMatchObject({ threadId, text: expect.stringMatching(/^\[Task from Lead\] Check CI\n/), context: { task: { id: taskId, assignedBy: "lead" } } });

    await until(async () => ((await (await device(`/assignments/${taskId}`)).json()) as AssignmentView).state === "verifying");
    expect(((await (await device(`/tasks/${taskId}`)).json()) as { view: { state: string } }).view.state).toBe("completed");
    const ack = await lead(`/assignments/${taskId}/acknowledge`, { outcome: "completed" });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toMatchObject({ taskId, state: "completed", result: { status: "done", artifacts: ["ci/log.txt"] } });

    // A duplicate delivery of the same request answers the same Task and queues nothing.
    const again = (await (await lead("/bots/lead/assignments", { to: "scout", brief: "Check CI", doneCriteria: "main is green", idempotencyKey: "ci-1" })).json()) as AssignmentView;
    expect(again.taskId).toBe(taskId);
    expect(pluginFrames.filter((frame) => frame.kind === "command" && frame.command.kind === "turn")).toHaveLength(1);

    const inbox = (await (await device("/bots/scout/inbox")).json()) as { threads: Array<{ id: string; messageCount: number }> };
    expect(inbox.threads).toEqual([expect.objectContaining({ id: threadId, messageCount: 2 })]);
    await until(() => frames.some((frame) => frame.type === "bot_inbox_activity" && frame.taskId === taskId && frame.state === "completed"));
    expect(frames.filter((frame) => frame.type === "bot_inbox_activity").map((frame) => (frame as { bot: string }).bot)).toEqual(expect.arrayContaining(["lead", "scout"]));
  } finally {
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    await hermes?.close();
    delete process.env["ASSIGN_DASHBOARD_TOKEN"];
    delete process.env["ASSIGN_LEAD_TOKEN"];
    delete process.env["ASSIGN_SCOUT_TOKEN"];
  }
});

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > 4000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

import { once } from "node:events";

import { WebSocket } from "ws";
import { expect, it } from "vitest";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

it("creates, updates, and acts on a CozyApp through the production attach-v1 lane", async () => {
  process.env["COZYAPPS_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["COZYAPPS_ATTACH_TOKEN"] = "attach-secret";
  let gateway: RunningGateway | undefined;
  let hermes: FakeHermesServer | undefined;
  const sockets: WebSocket[] = [];
  try {
    hermes = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({
          profiles: [{ name: "nighty", description: "native", has_avatar: false }],
          bot_mode_protocol: true,
        }),
      },
    });
    gateway = await startGateway({
      name: "cozyapps-e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{
        id: "default",
        url: hermes.url,
        tokenEnv: "COZYAPPS_DASHBOARD_TOKEN",
        profiles: { nighty: { tokenEnv: "COZYAPPS_ATTACH_TOKEN", name: "Nighty" } },
      }],
    });

    const pair = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
    });
    const deviceToken = ((await pair.json()) as { deviceToken: string }).deviceToken;
    const auth = { authorization: `Bearer ${deviceToken}` };

    const clientFrames: Array<{ type?: string }> = [];
    const client = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    sockets.push(client);
    client.on("message", (data) => clientFrames.push(JSON.parse(String(data))));
    await once(client, "open");
    client.send(JSON.stringify({ type: "auth", token: deviceToken }));
    await until(() => clientFrames.some((frame) => frame.type === "ready"));

    const pluginFrames: any[] = [];
    const plugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, {
      headers: { authorization: "Bearer attach-secret" },
    });
    sockets.push(plugin);
    plugin.on("message", (data) => pluginFrames.push(JSON.parse(String(data))));
    await once(plugin, "open");
    plugin.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "hermes-nighty", capabilities: ["cozyapps"],
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => pluginFrames.some((frame) => frame.kind === "hello_ack"));

    const firstTree = {
      root: { id: "root", kind: "stack", children: [
        { id: "temperature", kind: "keyValue", key: "Bedroom", value: "70 °F" },
        { id: "refresh", kind: "button", label: "Refresh", actionId: "refresh", role: "primary" },
      ] },
    };
    plugin.send(JSON.stringify({
      kind: "event", sequence: 1, eventId: "app-create",
      event: { kind: "cozyapp_upsert", appId: "house-temperature", name: "House Temperature", tree: firstTree },
    }));
    await until(() => pluginFrames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 1));

    const apps = (await (await fetch(`${gateway.url}/cozyapps`, { headers: auth })).json()) as Array<{ id: string; name: string; creatorBot: string; revision: number }>;
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ name: "House Temperature", creatorBot: "nighty", revision: 1 });
    const appId = apps[0]!.id;

    const rename = await fetch(`${gateway.url}/cozyapps/${appId}`, {
      method: "PATCH", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "My House" }),
    });
    expect(rename.status).toBe(200);

    const secondTree = {
      root: { id: "root", kind: "stack", children: [
        { id: "temperature", kind: "keyValue", key: "Bedroom", value: "71 °F" },
        { id: "refresh", kind: "button", label: "Refresh", actionId: "refresh", role: "primary" },
      ] },
    };
    plugin.send(JSON.stringify({
      kind: "event", sequence: 2, eventId: "app-update",
      event: { kind: "cozyapp_upsert", appId, name: "Bot Name Must Not Win", tree: secondTree },
    }));
    await until(() => pluginFrames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 2));
    const updated = await (await fetch(`${gateway.url}/cozyapps/${appId}`, { headers: auth })).json() as { name: string; revision: number; tree: unknown };
    expect(updated).toMatchObject({ name: "My House", revision: 3, tree: secondTree });

    const actionResponse = await fetch(`${gateway.url}/cozyapps/${appId}/actions`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "phone-tap-1", actionId: "refresh" }),
    });
    expect(actionResponse.status).toBe(202);
    const requested = await actionResponse.json() as { id: string; status: string };
    expect(requested.status).toBe("requested");
    await until(() => pluginFrames.some((frame) => frame.kind === "command" && frame.command?.kind === "cozyapp_action"));
    const command = pluginFrames.find((frame) => frame.kind === "command" && frame.command?.kind === "cozyapp_action");
    expect(command.command).toMatchObject({ appId, actionId: "refresh", actionRequestId: requested.id });
    plugin.send(JSON.stringify({ kind: "ack", channel: "command", sequence: command.sequence, id: command.commandId }));
    plugin.send(JSON.stringify({
      kind: "event", sequence: 3, eventId: "action-complete",
      event: { kind: "cozyapp_action_status", appId, actionId: "refresh", actionRequestId: requested.id, status: "completed" },
    }));
    await until(() => pluginFrames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 3));
    await until(() => gateway!.storage.cozyAppsSnapshot().actions.some((action) => action.id === requested.id && action.status === "completed"));
    expect(clientFrames.some((frame) => frame.type === "cozyapps_snapshot")).toBe(true);
  } finally {
    for (const socket of sockets)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    await gateway?.close();
    await hermes?.close();
    delete process.env["COZYAPPS_DASHBOARD_TOKEN"];
    delete process.env["COZYAPPS_ATTACH_TOKEN"];
  }
});

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const gateways: RunningGateway[] = [];
const servers: FakeHermesServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0))
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await server.close();
  delete process.env["COZYAPPS2_DASHBOARD_TOKEN"];
  delete process.env["COZYAPPS2_ATTACH_TOKEN"];
});

const tree = {
  root: { id: "root", kind: "stack", children: [{ id: "refresh", kind: "button", label: "Refresh", actionId: "refresh", role: "primary" }] },
};
const document = {
  title: "Market watchlist",
  sections: [{
    id: "main",
    components: [
      { kind: "input", id: "ticker-input", label: "Ticker", valueRef: "ticker", valueType: "string" },
      { kind: "metric", id: "quote-metric", label: "Last price", valueRef: "quote" },
      { kind: "action", id: "refresh-action", label: "Refresh", actionId: "refresh" },
    ],
  }],
};

async function harness(capabilities: string[]) {
  process.env["COZYAPPS2_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["COZYAPPS2_ATTACH_TOKEN"] = "attach-secret";
  const hermes = await startFakeHermesServer({
    methods: { "profiles.list": () => ({ profiles: [{ name: "nighty", description: "native", has_avatar: false }], bot_mode_protocol: true }) },
  });
  servers.push(hermes);
  const gateway = await startGateway({
    name: "cozyapps2-e2e", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
    hermesEndpoints: [{ id: "default", url: hermes.url, tokenEnv: "COZYAPPS2_DASHBOARD_TOKEN", profiles: { nighty: { tokenEnv: "COZYAPPS2_ATTACH_TOKEN", name: "Nighty" } } }],
  });
  gateways.push(gateway);
  const pair = await fetch(`${gateway.url}/pair`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
  });
  const deviceToken = ((await pair.json()) as { deviceToken: string }).deviceToken;
  const auth = { authorization: `Bearer ${deviceToken}` };
  const frames: any[] = [];
  const plugin = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer attach-secret" } });
  sockets.push(plugin);
  plugin.on("message", (data) => frames.push(JSON.parse(String(data))));
  await once(plugin, "open");
  plugin.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "hermes-nighty", capabilities, resume: { eventSequence: 0, commandSequence: 0 } }));
  await until(() => frames.some((frame) => frame.kind === "hello_ack"));
  plugin.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "app-create", event: { kind: "cozyapp_upsert", appId: "market", name: "Market", tree } }));
  await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 1));
  const apps = (await (await fetch(`${gateway.url}/cozyapps`, { headers: auth })).json()) as Array<{ id: string }>;
  return { gateway, plugin, frames, auth, appId: apps[0]!.id };
}

it("publishes a dashboard envelope and a source-attributed receipt over the negotiated v2 lane", async () => {
  const { gateway, plugin, frames, auth, appId } = await harness(["cozyapps", "cozyapps_dashboard"]);
  expect((await (await fetch(`${gateway.url}/health`)).json() as { capabilities: Record<string, number> }).capabilities["com.cozylabs.cozyapps"]).toBe(2);

  plugin.send(JSON.stringify({
    kind: "event", sequence: 2, eventId: "dash-1",
    event: { kind: "cozyapp_dashboard_upsert", appId: "market", documentVersion: 1, document, data: { quote: { source: "quotes.example", asOf: 1788638400000, value: "214.35", state: "fresh" } } },
  }));
  await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 2));
  const envelope = await (await fetch(`${gateway.url}/cozyapps/${appId}/dashboard`, { headers: auth })).json() as Record<string, unknown>;
  expect(JSON.stringify(envelope["document"])).toBe(JSON.stringify(document));
  expect(envelope).toMatchObject({ id: appId, revision: 1, creatorBot: "nighty", documentVersion: 1 });
  expect(envelope["data"]).toEqual({ quote: { source: "quotes.example", asOf: 1788638400000, value: "214.35", state: "fresh" } });

  // The person saves a value, and the action the tap raises carries it to the peer.
  await fetch(`${gateway.url}/cozyapps/${appId}/values/ticker`, {
    method: "PUT", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, idempotencyKey: "tap-0", type: "string", value: "MSFT" }),
  });
  const accepted = await fetch(`${gateway.url}/cozyapps/${appId}/actions`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "tap-1", actionId: "refresh", appRevision: 1, valueRevisions: [{ valueId: "ticker", revision: 1 }] }),
  });
  const requested = await accepted.json() as { id: string };
  await until(() => frames.some((frame) => frame.kind === "command" && frame.command?.kind === "cozyapp_action"));
  const command = frames.find((frame) => frame.kind === "command" && frame.command?.kind === "cozyapp_action");
  expect(command.command.values).toEqual([{ valueId: "ticker", type: "string", value: "MSFT", revision: 1 }]);

  // Acking the command is the peer taking it, which is the public receipt's `running`.
  plugin.send(JSON.stringify({ kind: "ack", channel: "command", sequence: command.sequence, id: command.commandId }));
  await until(async () => ((await (await fetch(`${gateway.url}/cozyapps/${appId}/receipts`, { headers: auth })).json()) as { receipts: Array<{ status: string }> }).receipts[0]?.status === "running");

  plugin.send(JSON.stringify({
    kind: "event", sequence: 3, eventId: "receipt-1",
    event: { kind: "cozyapp_action_receipt", appId, actionId: "refresh", actionRequestId: requested.id, status: "completed", data: { quote: { source: "quotes.example", asOf: 1788638401000, value: "215.00", state: "fresh" } } },
  }));
  await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 3));
  const receipts = (await (await fetch(`${gateway.url}/cozyapps/${appId}/receipts`, { headers: auth })).json()) as { receipts: Array<Record<string, unknown>> };
  expect(receipts.receipts[0]).toMatchObject({ status: "completed", appRevision: 1, valueRevisions: [{ valueId: "ticker", revision: 1 }] });
  expect(receipts.receipts[0]!["data"]).toEqual({ quote: { source: "quotes.example", asOf: 1788638401000, value: "215.00", state: "fresh" } });
});

it("gives a peer that stays at cozyapps 1 unchanged v1 behavior plus everything the gateway derives", async () => {
  const { gateway, plugin, frames, auth, appId } = await harness(["cozyapps"]);

  // The dashboard frame is discarded as a capability the peer never negotiated, and it stores nothing.
  plugin.send(JSON.stringify({
    kind: "event", sequence: 2, eventId: "dash-1",
    event: { kind: "cozyapp_dashboard_upsert", appId: "market", documentVersion: 1, document },
  }));
  await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 2));
  expect(frames.find((frame) => frame.kind === "ack" && frame.sequence === 2)).toMatchObject({ discarded: true, reason: "capability_not_negotiated" });
  expect((await fetch(`${gateway.url}/cozyapps/${appId}/dashboard`, { headers: auth })).status).toBe(404);

  // A saved value is user-written, so it works whatever the creator bot negotiated.
  const saved = await fetch(`${gateway.url}/cozyapps/${appId}/values/ticker`, {
    method: "PUT", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, idempotencyKey: "tap-0", type: "string", value: "MSFT" }),
  });
  expect(saved.status).toBe(200);

  const accepted = await fetch(`${gateway.url}/cozyapps/${appId}/actions`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "tap-1", actionId: "refresh" }),
  });
  const requested = await accepted.json() as { id: string; status: string };
  expect(requested.status).toBe("requested");
  await until(() => frames.some((frame) => frame.kind === "command" && frame.command?.kind === "cozyapp_action"));
  const command = frames.find((frame) => frame.kind === "command" && frame.command?.kind === "cozyapp_action");
  // Byte identical to the pre-2 command: the v1 peer sees no new member at all.
  expect(Object.keys(command.command).sort()).toEqual(["actionId", "actionRequestId", "appId", "kind"]);

  const receipts = async () => ((await (await fetch(`${gateway.url}/cozyapps/${appId}/receipts`, { headers: auth })).json()) as { receipts: Array<{ status: string }> }).receipts;
  expect((await receipts())[0]?.status).toBe("queued");
  plugin.send(JSON.stringify({ kind: "ack", channel: "command", sequence: command.sequence, id: command.commandId }));
  await until(async () => (await receipts())[0]?.status === "running");

  plugin.send(JSON.stringify({
    kind: "event", sequence: 3, eventId: "status-1",
    event: { kind: "cozyapp_action_status", appId, actionId: "refresh", actionRequestId: requested.id, status: "completed" },
  }));
  await until(async () => (await receipts())[0]?.status === "completed");
});

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startGateway, type RunningGateway } from "../src/server.ts";
import type { GatewayConfig } from "../src/config.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const BOT = "delete-fixture", KEEP = "keep-fixture";
const gateways: RunningGateway[] = [], servers: FakeHermesServer[] = [], directories: string[] = [];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const key of ["DELETE_TEST_CONTROL", "DELETE_TEST_ATTACH", "DELETE_TEST_KEEP", "DELETE_TEST_SECOND"]) delete process.env[key];
});
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function attachStatus(gateway: RunningGateway, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: `Bearer ${token}` } });
    socket.on("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    socket.on("open", () => socket.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "fixture", capabilities: ["draft"], resume: { eventSequence: 0, commandSequence: 0 } })));
    socket.on("message", (data) => {
      if ((JSON.parse(String(data)) as { kind: string }).kind === "hello_ack") { resolve(101); socket.close(); }
    });
    socket.on("close", (code) => resolve(code));
    socket.on("error", reject);
  });
}

describe("deletion survives the real gateway restart with stale host configuration", () => {
  it.each([false, true])("blocks placeholder and token resurrection (federated=%s)", async (federated) => {
    let absent = false;
    let allowCreate = false;
    const staleProfiles = () => ({ profiles: [BOT, KEEP].map((name) => ({ name, description: "", has_avatar: false })), bot_mode_protocol: true });
    const first = await startFakeHermesServer({
      // Simulate delayed host/roster cleanup even AFTER its delete endpoint confirmed success.
      methods: { "profiles.list": staleProfiles, "profiles.create": () => {
        if (!allowCreate) throw { code: 4062, message: "already exists" };
        absent = false;
        return { name: BOT };
      } },
      dashboard: (request) => {
        if (request.method === "DELETE") {
          const status = absent ? 404 : 200; absent = true;
          return { status, body: { ok: status === 200 } };
        }
        return { body: {} };
      },
    }); servers.push(first);
    const second = federated ? await startFakeHermesServer({ methods: { "profiles.list": () => ({ profiles: [{ name: BOT, description: "", has_avatar: false }], bot_mode_protocol: true }) } }) : undefined;
    if (second) servers.push(second);
    Object.assign(process.env, { DELETE_TEST_CONTROL: "control", DELETE_TEST_ATTACH: "old-attach", DELETE_TEST_KEEP: "keep-attach", DELETE_TEST_SECOND: "second-attach" });
    const directory = mkdtempSync(join(tmpdir(), "gateway-delete-restart-")); directories.push(directory);
    const config: GatewayConfig = {
      name: "deletion fixture", port: 0, dbPath: join(directory, "gateway.sqlite"), turnTimeoutSeconds: 0,
      hermesEndpoints: [
        { id: federated ? "home" : "default", url: first.url, tokenEnv: "DELETE_TEST_CONTROL", profiles: { [BOT]: { tokenEnv: "DELETE_TEST_ATTACH" }, [KEEP]: { tokenEnv: "DELETE_TEST_KEEP" } } },
        ...(second ? [{ id: "studio", url: second.url, tokenEnv: "DELETE_TEST_CONTROL", profiles: { [BOT]: { tokenEnv: "DELETE_TEST_SECOND" } } }] : []),
      ],
    };
    const name = federated ? `home:${BOT}` : BOT;
    let gateway = await startGateway(config, { profileProvisioner: null, traceLog: () => {} }); gateways.push(gateway);
    const pair = await fetch(`${gateway.url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "fixture" }) });
    const { deviceToken } = await pair.json() as { deviceToken: string };
    const authed = (path: string, init?: RequestInit) => fetch(`${gateway.url}${path}`, { ...init, headers: { ...init?.headers, authorization: `Bearer ${deviceToken}` } });
    const roster = async () => (await (await authed("/bots")).json() as { bots: { name: string }[] }).bots.map((bot) => bot.name).sort();
    await until(async () => (await roster()).includes(name));
    expect(gateway.storage.nativeBotSessions(name, 100).length).toBeGreaterThan(0);
    const pendingHello = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: "Bearer old-attach" } });
    await once(pendingHello, "open");
    expect((await authed(`/bots/${name}`, { method: "DELETE" })).status).toBe(200);
    const closed = once(pendingHello, "close");
    pendingHello.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "late", capabilities: ["draft"], resume: { eventSequence: 0, commandSequence: 0 } }));
    expect((await closed)[0]).toBe(1008);
    expect(await roster()).not.toContain(name);
    expect(await attachStatus(gateway, "old-attach")).toBe(1008);
    expect(gateway.storage.nativeBotSessions(name, 100)).toEqual([]);
    await gateway.close(); gateways.splice(gateways.indexOf(gateway), 1);
    // Exact same stale config and environment; the DB fence must be enough by itself.
    gateway = await startGateway(config, { profileProvisioner: null, traceLog: () => {} }); gateways.push(gateway);
    const expected = federated ? [`home:${KEEP}`, `studio:${BOT}`].sort() : [KEEP];
    await until(async () => JSON.stringify(await roster()) === JSON.stringify(expected));
    expect(gateway.storage.agentById(name)).toBeUndefined();
    expect(gateway.storage.nativeBotSessions(name, 100)).toEqual([]);
    expect(await attachStatus(gateway, "old-attach")).toBe(1008);
    expect(await attachStatus(gateway, "keep-attach")).toBe(101);
    if (federated) expect(await attachStatus(gateway, "second-attach")).toBe(101);
    expect((await authed(`/bots/${name}`, { method: "DELETE" })).status).toBe(404);
    expect(gateway.storage.purgeBot(name)).toEqual({});
    if (!federated) {
      const failedCreate = await authed("/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: BOT }) });
      expect(failedCreate.status).toBe(409);
      expect(gateway.storage.isBotDeleted(name)).toBe(true);
      expect(await attachStatus(gateway, "old-attach")).toBe(1008);
    }
    // A successful name recreation is NOT permission to reauthorize that incarnation's token.
    // Exercise the vulnerable window before the installer rotates the old config/env binding.
    allowCreate = true;
    const recreated = await authed("/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    expect(recreated.status).toBe(201);
    expect(gateway.storage.isBotDeleted(name)).toBe(false);
    expect(gateway.storage.isAttachCredentialRevoked("old-attach")).toBe(true);
    await gateway.close(); gateways.splice(gateways.indexOf(gateway), 1);
    gateway = await startGateway(config, { profileProvisioner: null, traceLog: () => {} }); gateways.push(gateway);
    await until(async () => (await roster()).includes(name));
    expect(await attachStatus(gateway, "old-attach")).toBe(1008);
    expect((await fetch(`${gateway.url}/attach/v1/deliveries/fixture`, { headers: { authorization: "Bearer old-attach" } })).status).toBe(401);
    expect(await attachStatus(gateway, "keep-attach")).toBe(101);
    if (federated) expect(await attachStatus(gateway, "second-attach")).toBe(101);
    // When provisioning eventually installs a fresh token, that new incarnation can attach.
    process.env["DELETE_TEST_ATTACH"] = "fresh-attach";
    await gateway.close(); gateways.splice(gateways.indexOf(gateway), 1);
    gateway = await startGateway(config, { profileProvisioner: null, traceLog: () => {} }); gateways.push(gateway);
    expect(await attachStatus(gateway, "fresh-attach")).toBe(101);
    expect(await attachStatus(gateway, "old-attach")).toBe(1008);
    if (federated) expect(await attachStatus(gateway, "second-attach")).toBe(101);
  });
});

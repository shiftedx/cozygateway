import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { loadConfig } from "../src/config.ts";
import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

async function until(check: () => boolean | Promise<boolean>, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met");
}

describe("federated Hermes endpoints", () => {
  const gateways: RunningGateway[] = [];
  const servers: FakeHermesServer[] = [];
  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
    await Promise.all(servers.splice(0).map((server) => server.close()));
    for (const key of ["HOME_HERMES", "STUDIO_HERMES", "HOME_SAGE", "STUDIO_SAGE"]) delete process.env[key];
  });

  it("consolidates duplicate profile ids, routes them by stable namespace, and retains roster on partial failure", async () => {
    const profile = (title: string) => ({ profiles: [{ name: "sage", description: title, has_avatar: false }], bot_mode_protocol: true });
    const home = await startFakeHermesServer({ methods: { "profiles.list": () => profile("home") } });
    const studio = await startFakeHermesServer({ methods: { "profiles.list": () => profile("studio") } });
    servers.push(home, studio);
    Object.assign(process.env, { HOME_HERMES: "h", STUDIO_HERMES: "s", HOME_SAGE: "ha", STUDIO_SAGE: "sa" });
    const path = join(mkdtempSync(join(tmpdir(), "cozygateway-federated-")), "config.json");
    writeFileSync(path, JSON.stringify({
      name: "Federated",
      port: 8787,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [
        { id: "home", label: "Home", url: home.url, tokenEnv: "HOME_HERMES", profiles: { sage: { tokenEnv: "HOME_SAGE" } } },
        { id: "studio", label: "Studio", url: studio.url, tokenEnv: "STUDIO_HERMES", profiles: { sage: { tokenEnv: "STUDIO_SAGE" } } },
      ],
    }));
    const config = loadConfig(path);
    config.port = 0;
    const gateway = await startGateway(config, { configPath: path });
    gateways.push(gateway);
    const setupCode = gateway.issueSetupCode();
    const pair = await fetch(`${gateway.url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode, deviceName: "phone" }) });
    const token = ((await pair.json()) as { deviceToken: string }).deviceToken;
    expect(((await (await fetch(`${gateway.url}/health`)).json()) as { capabilities: Record<string, number> }).capabilities["com.cozylabs.gateway-management"]).toBe(1);
    expect((await fetch(`${gateway.url}/gateway/settings`)).status).toBe(401);
    const settingsResponse = await fetch(`${gateway.url}/gateway/settings`, { headers: { authorization: `Bearer ${token}` } });
    expect(settingsResponse.status).toBe(200);
    const settingsText = await settingsResponse.text();
    expect(JSON.parse(settingsText)).toMatchObject({ name: "Federated", hermesEndpoints: [{ id: "home", label: "Home" }, { id: "studio", label: "Studio" }] });
    expect(settingsText).not.toContain('"token":');
    expect(settingsText).not.toContain('"password":');
    const roster = async (): Promise<string[]> => {
      const response = await fetch(`${gateway.url}/bots`, { headers: { authorization: `Bearer ${token}` } });
      return ((await response.json()) as { bots: Array<{ name: string }> }).bots.map((bot) => bot.name).sort();
    };
    await until(async () => (await roster()).length === 2);
    expect(await roster()).toEqual(["home:sage", "studio:sage"]);

    const attach = async (secret: string): Promise<{ ws: WebSocket; frames: any[] }> => {
      const frames: any[] = [];
      const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: `Bearer ${secret}` } });
      ws.on("message", (data) => frames.push(JSON.parse(String(data))));
      await once(ws, "open");
      ws.send(JSON.stringify({ kind: "hello", version: 2, instanceId: secret, capabilities: ["draft"], resume: { eventSequence: 0, commandSequence: 0 } }));
      await until(() => frames.some((frame) => frame.kind === "hello_ack"));
      return { ws, frames };
    };
    const homeAttach = await attach("ha");
    const studioAttach = await attach("sa");
    const send = await fetch(`${gateway.url}/bots/studio%3Asage/chat/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "studio only", clientId: "federated-turn" }),
    });
    expect(send.status).toBe(202);
    await until(() => studioAttach.frames.some((frame) => frame.kind === "command"));
    expect(studioAttach.frames.find((frame) => frame.kind === "command")?.command.text).toBe("studio only");
    expect(homeAttach.frames.some((frame) => frame.kind === "command")).toBe(false);
    homeAttach.ws.close();
    studioAttach.ws.close();

    await studio.close();
    servers.splice(servers.indexOf(studio), 1);
    await until(async () => (await fetch(`${gateway.url}/ready`)).status === 503);
    expect(await roster()).toEqual(["home:sage", "studio:sage"]);
  });
});

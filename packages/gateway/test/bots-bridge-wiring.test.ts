import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayInfo, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { applyEnvOverrides } from "../src/config.ts";
import { parseHermesOptions } from "../src/hermes-bridge/config.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const gateways: RunningGateway[] = [];
const servers: FakeHermesServer[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await server.close();
});

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("hermes bridge options", () => {
  it("resolves the credential from the environment and never names its value in an error", () => {
    expect(
      parseHermesOptions({ url: "ws://h/api/ws", tokenEnv: "HERMES_TOKEN" }, { HERMES_TOKEN: "s3cret" }),
    ).toEqual({
      url: "ws://h/api/ws",
      auth: { mode: "token", token: "s3cret", param: "token" },
      hideBotChats: true,
    });

    expect(() => parseHermesOptions({ url: "ws://h/api/ws", tokenEnv: "HERMES_TOKEN" }, {})).toThrow(
      /HERMES_TOKEN/,
    );
  });

  it("resolves the gated password shape, deriving the dashboard origin from the ws URL", () => {
    expect(
      parseHermesOptions(
        {
          url: "ws://homelab:9119/api/ws",
          authMode: "password",
          username: "cozybridge",
          passwordEnv: "HERMES_DASH_PASSWORD",
        },
        { HERMES_DASH_PASSWORD: "s3cret" },
      ),
    ).toEqual({
      url: "ws://homelab:9119/api/ws",
      auth: {
        mode: "password",
        baseUrl: "http://homelab:9119",
        username: "cozybridge",
        password: "s3cret",
        provider: "basic",
      },
      hideBotChats: true,
    });
  });

  it("defaults the dashboard auth provider to basic and passes a configured one through", () => {
    const parsed = parseHermesOptions(
      {
        url: "ws://homelab:9119/api/ws",
        authMode: "password",
        username: "cozybridge",
        passwordEnv: "HERMES_DASH_PASSWORD",
        provider: "ldap",
      },
      { HERMES_DASH_PASSWORD: "s3cret" },
    );
    expect(parsed.auth).toMatchObject({ provider: "ldap" });
  });

  it("rejects a URL that is unparseable or not a WebSocket scheme, in both auth modes", () => {
    // The killer typo: `new URL("homelab:8790/api/ws")` PARSES, so only a scheme check catches it,
    // and unvalidated it reaches `new WebSocket()` inside the connect path where it throws with
    // no reconnect behind it.
    expect(() =>
      parseHermesOptions({ url: "homelab:8790/api/ws", tokenEnv: "HERMES_TOKEN" }, { HERMES_TOKEN: "s3cret" }),
    ).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() =>
      parseHermesOptions({ url: "http://homelab:8790", tokenEnv: "HERMES_TOKEN" }, { HERMES_TOKEN: "s3cret" }),
    ).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() =>
      parseHermesOptions({ url: "not a url", tokenEnv: "HERMES_TOKEN" }, { HERMES_TOKEN: "s3cret" }),
    ).toThrow(/is not a valid URL/);
    expect(() =>
      parseHermesOptions(
        {
          url: "homelab:9119",
          authMode: "password",
          username: "cozybridge",
          passwordEnv: "HERMES_DASH_PASSWORD",
        },
        { HERMES_DASH_PASSWORD: "s3cret" },
      ),
    ).toThrow(/ws:\/\/ or wss:\/\//);
  });

  it("fills in the gateway path for an origin-only URL and honours an explicit baseUrl", () => {
    const parsed = parseHermesOptions(
      {
        url: "wss://homelab.example",
        authMode: "password",
        username: "cozybridge",
        passwordEnv: "HERMES_DASH_PASSWORD",
        baseUrl: "https://dash.example",
      },
      { HERMES_DASH_PASSWORD: "s3cret" },
    );
    expect(parsed.url).toBe("wss://homelab.example/api/ws");
    expect(parsed.auth).toEqual({
      mode: "password",
      baseUrl: "https://dash.example",
      username: "cozybridge",
      password: "s3cret",
      provider: "basic",
    });
  });

  it("fails closed on an incomplete password config, naming only the env var", () => {
    const config = {
      url: "ws://h/api/ws",
      authMode: "password" as const,
      username: "cozybridge",
      passwordEnv: "HERMES_DASH_PASSWORD",
    };
    expect(() => parseHermesOptions(config, {})).toThrow(/HERMES_DASH_PASSWORD/);
    expect(() => parseHermesOptions({ ...config, username: undefined }, { HERMES_DASH_PASSWORD: "x" })).toThrow(
      /username/,
    );
    expect(() =>
      parseHermesOptions({ ...config, passwordEnv: undefined }, { HERMES_DASH_PASSWORD: "x" }),
    ).toThrow(/passwordEnv/);
    expect(() => parseHermesOptions({ url: "ws://h/api/ws" }, { HERMES_TOKEN: "x" })).toThrow(/tokenEnv/);
  });

  it("lets the environment retarget the bridge URL, but only when a bridge is configured", () => {
    const base = {
      name: "g",
      port: 8787,
      dbPath: "db",
      turnTimeoutSeconds: 0,
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
    };
    const withBridge = applyEnvOverrides(
      { ...base, hermes: { url: "ws://old/api/ws", tokenEnv: "HERMES_TOKEN" } },
      { COZYGATEWAY_HERMES_URL: "ws://new/api/ws" },
    );
    expect(withBridge.hermes?.url).toBe("ws://new/api/ws");
    expect(applyEnvOverrides(base, { COZYGATEWAY_HERMES_URL: "ws://new/api/ws" }).hermes).toBeUndefined();
  });
});

describe("startGateway with a hermes bridge", () => {
  it("advertises the bots capability and broadcasts roster frames over the existing hub", async () => {
    const hermes = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({
          profiles: [
            {
              name: "scout",
              description: "watches CI",
              has_avatar: false,
              last_session: { last_active: Math.round(Date.now() / 1000) - 3, preview: "all green" },
              ui_meta: { "hermes-bots": { title: "Scout" } },
            },
          ],
          bot_mode_protocol: true,
        }),
      },
    });
    servers.push(hermes);

    process.env["TEST_HERMES_TOKEN"] = "test-token";
    const gateway = await startGateway({
      name: "e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
      hermes: { url: hermes.url, tokenEnv: "TEST_HERMES_TOKEN" },
    });
    gateways.push(gateway);

    const info = (await (await fetch(`${gateway.url}/health`)).json()) as GatewayInfo;
    expect(info.capabilities?.["com.cozylabs.bots"]).toBe(2);

    const code = gateway.issueSetupCode();
    const pairRes = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
    });
    const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

    const seen: ServerFrame[] = [];
    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: deviceToken }));
    await until(() => seen.some((frame) => frame.type === "ready"));

    // A change broadcast from Hermes drives a refresh with no polling involved.
    hermes.sendEvent("sessions.changed", {});
    await until(() => seen.some((frame) => frame.type === "bot_roster"));
    const roster = seen.find((frame) => frame.type === "bot_roster");
    expect(roster).toMatchObject({ type: "bot_roster" });

    const bots = (await (
      await fetch(`${gateway.url}/bots`, { headers: { authorization: `Bearer ${deviceToken}` } })
    ).json()) as { bots: Array<{ name: string; active: boolean }> };
    expect(bots.bots.map((bot) => bot.name)).toEqual(["scout"]);
    expect(bots.bots[0]!.active).toBe(true);

    ws.close();
    delete process.env["TEST_HERMES_TOKEN"];
  });

  it("does not advertise the capability when no bridge is configured", async () => {
    const gateway = await startGateway({
      name: "e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
    });
    gateways.push(gateway);
    const info = (await (await fetch(`${gateway.url}/health`)).json()) as GatewayInfo;
    expect(info.capabilities?.["com.cozylabs.bots"]).toBeUndefined();
  });

  it("fails startup when the bridge credential is missing, before the port is bound", async () => {
    delete process.env["MISSING_HERMES_TOKEN"];
    await expect(
      startGateway({
        name: "e2e",
        port: 0,
        dbPath: ":memory:",
        turnTimeoutSeconds: 0,
        agents: [{ id: "mock", name: "Mock", backend: "mock" }],
        hermes: { url: "ws://127.0.0.1:1/api/ws", tokenEnv: "MISSING_HERMES_TOKEN" },
      }),
    ).rejects.toThrow(/MISSING_HERMES_TOKEN/);
  });

  it("fails startup on a malformed bridge URL instead of advertising a dead bridge", async () => {
    process.env["TEST_HERMES_TOKEN"] = "test-token";
    await expect(
      startGateway({
        name: "e2e",
        port: 0,
        dbPath: ":memory:",
        turnTimeoutSeconds: 0,
        agents: [{ id: "mock", name: "Mock", backend: "mock" }],
        hermes: { url: "homelab:8790/api/ws", tokenEnv: "TEST_HERMES_TOKEN" },
      }),
    ).rejects.toThrow(/ws:\/\/ or wss:\/\//);
    delete process.env["TEST_HERMES_TOKEN"];
  });
});

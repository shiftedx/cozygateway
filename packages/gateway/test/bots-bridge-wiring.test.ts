import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { BOTS_CAPABILITY_VERSION, type GatewayInfo, type ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { applyEnvOverrides, type HermesBridgeConfig } from "../src/config.ts";
const DEFAULT_CHAT_SUGGESTION = "Hey, tell me about yourself!";
import { parseHermesOptions as parseConfiguredHermesOptions } from "../src/hermes-bridge/config.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const gateways: RunningGateway[] = [];
const servers: FakeHermesServer[] = [];
const profiles = { sage: { tokenEnv: "TEST_ATTACH_TOKEN", name: "Sage" } };

function parseHermesOptions(
  config: Omit<HermesBridgeConfig, "profiles">,
  env: Record<string, string | undefined>,
) {
  return parseConfiguredHermesOptions({ ...config, profiles }, env);
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await server.close();
});

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
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
      hiddenProfiles: [],
      // Defaulted ON: a gateway that seeds nothing is a gateway whose new bots inherit Hermes'
      // broad platform defaults, which is the thing the blank slate exists to stop.
      seedBlankSlateBots: true,
      // Empty, and that is the floor doing its job: skills are an OFF-list with no allowlist
      // behind it, so a blank slate names every installed one and keeps none.
      blankSlateSkillsOn: [],
      // Defaulted, not absent: an operator who configures nothing still gets the opener offered as a
      // suggestion, which is the whole of what capability 11 left of the old auto-submitted kickoff.
      chatSuggestion: DEFAULT_CHAT_SUGGESTION,
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
      hiddenProfiles: [],
      // Defaulted ON: a gateway that seeds nothing is a gateway whose new bots inherit Hermes'
      // broad platform defaults, which is the thing the blank slate exists to stop.
      seedBlankSlateBots: true,
      // Empty, and that is the floor doing its job: skills are an OFF-list with no allowlist
      // behind it, so a blank slate names every installed one and keeps none.
      blankSlateSkillsOn: [],
      // Defaulted, not absent: an operator who configures nothing still gets the opener offered as a
      // suggestion, which is the whole of what capability 11 left of the old auto-submitted kickoff.
      chatSuggestion: DEFAULT_CHAT_SUGGESTION,
    });
  });

  it("takes the operator's seedBlankSlateBots opt-out literally, and only a literal false", () => {
    const base = { url: "ws://h/api/ws", tokenEnv: "T", profiles: {} } as const;
    const env = { T: "s3cret" };
    expect(parseHermesOptions({ ...base, seedBlankSlateBots: false }, env).seedBlankSlateBots).toBe(false);
    expect(parseHermesOptions({ ...base, seedBlankSlateBots: true }, env).seedBlankSlateBots).toBe(true);
    expect(parseHermesOptions(base, env).seedBlankSlateBots).toBe(true);
  });

  it("normalizes the skills floor: trimmed, blanks dropped, duplicates collapsed, case KEPT", () => {
    const base = { url: "ws://h/api/ws", tokenEnv: "T", profiles: {} } as const;
    const env = { T: "s3cret" };
    expect(parseHermesOptions(base, env).blankSlateSkillsOn).toEqual([]);
    expect(
      parseHermesOptions({ ...base, blankSlateSkillsOn: [" tdd ", "tdd", "PDF-Forms"] }, env)
        .blankSlateSkillsOn,
      // NOT lowercased, unlike the hide list: upstream matches a disabled name against the skills
      // directory verbatim, so folding case would keep the wrong skill off.
    ).toEqual(["tdd", "PDF-Forms"]);
  });

  it("normalizes the roster hide list: trimmed, lowercased, blanks dropped, duplicates collapsed", () => {
    const parsed = parseHermesOptions(
      {
        url: "ws://h/api/ws",
        tokenEnv: "HERMES_TOKEN",
        hiddenProfiles: ["Ops-Runner", "  ops-runner ", "   ", "sweeper"],
      },
      { HERMES_TOKEN: "s3cret" },
    );
    expect(parsed.hiddenProfiles).toEqual(["ops-runner", "sweeper"]);
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
      hermesEndpoints: [{ id: "default", url: "ws://old/api/ws", tokenEnv: "HERMES_TOKEN", profiles }],
    };
    const withBridge = applyEnvOverrides(
      base,
      { COZYGATEWAY_HERMES_URL: "ws://new/api/ws" },
    );
    expect(withBridge.hermesEndpoints[0]?.url).toBe("ws://new/api/ws");
  });
});

describe("startGateway with a hermes bridge", () => {
  it("advertises the bots capability and broadcasts roster frames over the existing hub", async () => {
    const hermes = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({
          profiles: [
            {
              name: "sage",
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
    process.env["TEST_ATTACH_TOKEN"] = "attach-token";
    const gateway = await startGateway({
      name: "e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", url: hermes.url, tokenEnv: "TEST_HERMES_TOKEN", profiles }],
    });
    gateways.push(gateway);

    const info = (await (await fetch(`${gateway.url}/health`)).json()) as GatewayInfo;
    expect(info.capabilities?.["com.cozylabs.bots"]).toBe(BOTS_CAPABILITY_VERSION);

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
    await until(() => seen.some((frame) => frame.type === "bot_roster" && frame.bots.some((bot) => bot.name === "sage")));
    const roster = seen.find((frame) => frame.type === "bot_roster" && frame.bots.some((bot) => bot.name === "sage"));
    expect(roster).toMatchObject({ type: "bot_roster" });

    const bots = (await (
      await fetch(`${gateway.url}/bots`, { headers: { authorization: `Bearer ${deviceToken}` } })
    ).json()) as { bots: Array<{ name: string; active: boolean }> };
    expect(bots.bots.map((bot) => bot.name)).toEqual(["sage"]);
    expect(bots.bots[0]!.active).toBe(true);

    ws.close();
    delete process.env["TEST_HERMES_TOKEN"];
    delete process.env["TEST_ATTACH_TOKEN"];
  });


  // Issue #63: GET /health kept advertising com.cozylabs.bots for hours with the hermes link
  // dead behind it, so a monitor watching only `capabilities` stayed green through a full outage.
  // `bridges.hermes` is the added liveness signal; these two prove it tracks the real socket, not
  // a value frozen at startup.
  it("reports the hermes bridge online in /health once the link is up", async () => {
    const hermes = await startFakeHermesServer({
      methods: { "profiles.list": () => ({ profiles: [], bot_mode_protocol: true }) },
    });
    servers.push(hermes);
    process.env["TEST_HERMES_TOKEN"] = "test-token";
    process.env["TEST_ATTACH_TOKEN"] = "attach-token";
    const gateway = await startGateway({
      name: "e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", url: hermes.url, tokenEnv: "TEST_HERMES_TOKEN", profiles }],
    });
    gateways.push(gateway);

    const readHealth = async (): Promise<GatewayInfo> =>
      (await (await fetch(`${gateway.url}/health`)).json()) as GatewayInfo;

    await until(async () => (await readHealth()).bridges?.["hermes"]?.online === true);
    const info = await readHealth();
    expect(info.bridges?.["hermes"]).toMatchObject({ online: true, reconnectAttempt: 0 });
    expect(typeof info.bridges?.["hermes"]?.since).toBe("number");

    delete process.env["TEST_HERMES_TOKEN"];
    delete process.env["TEST_ATTACH_TOKEN"];
  });

  it("flips the hermes bridge offline in /health, with a growing reconnectAttempt, once the link drops", async () => {
    const hermes = await startFakeHermesServer({
      methods: { "profiles.list": () => ({ profiles: [], bot_mode_protocol: true }) },
    });
    servers.push(hermes);
    process.env["TEST_HERMES_TOKEN"] = "test-token";
    process.env["TEST_ATTACH_TOKEN"] = "attach-token";
    const gateway = await startGateway({
      name: "e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", url: hermes.url, tokenEnv: "TEST_HERMES_TOKEN", profiles }],
    });
    gateways.push(gateway);

    const readHealth = async (): Promise<GatewayInfo> =>
      (await (await fetch(`${gateway.url}/health`)).json()) as GatewayInfo;

    await until(async () => (await readHealth()).bridges?.["hermes"]?.online === true);

    // Kill the fake hermes host out from under the bridge, exactly what a dead dashboard looks
    // like from the gateway's side: the reconnect loop keeps retrying a socket nobody answers.
    await hermes.close();
    servers.splice(servers.indexOf(hermes), 1);

    await until(async () => (await readHealth()).bridges?.["hermes"]?.online === false);
    const first = await readHealth();
    expect(first.bridges?.["hermes"]?.online).toBe(false);
    expect(first.bridges?.["hermes"]?.reconnectAttempt).toBeGreaterThanOrEqual(1);
    // capabilities.["com.cozylabs.bots"] is exactly the field issue #63 filed against: it must
    // still be advertised while offline (a client's feature-detection contract does not change),
    // with `bridges` as the ADDED signal a monitor reads instead.
    expect(first.capabilities?.["com.cozylabs.bots"]).toBe(BOTS_CAPABILITY_VERSION);

    await until(async () => {
      const attempt = (await readHealth()).bridges?.["hermes"]?.reconnectAttempt ?? 0;
      return attempt > (first.bridges?.["hermes"]?.reconnectAttempt ?? 0);
    });

    delete process.env["TEST_HERMES_TOKEN"];
    delete process.env["TEST_ATTACH_TOKEN"];
  });

  // Follow-up to issue #63 (tracked separately): /health kept a bridge outage invisible behind a
  // green process-liveness check; /ready is the signal a router or monitor should actually alarm
  // or de-route on, so it has to track the same live bridge state /health does, not a value
  // frozen at startup.
  it("reports /ready 200 while the hermes bridge is online, then 503 naming it once the link dies", async () => {
    const hermes = await startFakeHermesServer({
      methods: { "profiles.list": () => ({ profiles: [], bot_mode_protocol: true }) },
    });
    servers.push(hermes);
    process.env["TEST_HERMES_TOKEN"] = "test-token";
    process.env["TEST_ATTACH_TOKEN"] = "attach-token";
    const gateway = await startGateway({
      name: "e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", url: hermes.url, tokenEnv: "TEST_HERMES_TOKEN", profiles }],
    });
    gateways.push(gateway);

    type ReadyBody = { ready: boolean; bridges?: Record<string, { online: boolean; reconnectAttempt: number }> };
    const readReady = async (): Promise<{ status: number; body: ReadyBody }> => {
      const res = await fetch(`${gateway.url}/ready`);
      return { status: res.status, body: (await res.json()) as ReadyBody };
    };

    await until(async () => (await readReady()).body.bridges?.["hermes"]?.online === true);
    const up = await readReady();
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ ready: true, bridges: { hermes: { online: true } } });

    // Kill the fake hermes host out from under the bridge, exactly what a dead dashboard looks
    // like from the gateway's side.
    await hermes.close();
    servers.splice(servers.indexOf(hermes), 1);

    await until(async () => (await readReady()).status === 503);
    const down = await readReady();
    expect(down.status).toBe(503);
    expect(down.body.ready).toBe(false);
    expect(down.body.bridges?.["hermes"]?.online).toBe(false);
    expect(down.body.bridges?.["hermes"]?.reconnectAttempt).toBeGreaterThanOrEqual(1);

    delete process.env["TEST_HERMES_TOKEN"];
    delete process.env["TEST_ATTACH_TOKEN"];
  });


  it("fails startup when the bridge credential is missing, before the port is bound", async () => {
    delete process.env["MISSING_HERMES_TOKEN"];
    await expect(
      startGateway({
        name: "e2e",
        port: 0,
        dbPath: ":memory:",
        turnTimeoutSeconds: 0,
        hermesEndpoints: [{ id: "default", url: "ws://127.0.0.1:1/api/ws", tokenEnv: "MISSING_HERMES_TOKEN", profiles }],
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
        hermesEndpoints: [{ id: "default", url: "homelab:8790/api/ws", tokenEnv: "TEST_HERMES_TOKEN", profiles }],
      }),
    ).rejects.toThrow(/ws:\/\/ or wss:\/\//);
    delete process.env["TEST_HERMES_TOKEN"];
  });

  it("authenticates a native runtime bot's attach-v1 peer as its configured bot id", async () => {
    const hermes = await startFakeHermesServer({
      methods: { "profiles.list": () => ({ profiles: [], bot_mode_protocol: true }) },
    });
    servers.push(hermes);
    process.env["TEST_HERMES_TOKEN"] = "test-token";
    process.env["TEST_ATTACH_TOKEN"] = "attach-token";
    process.env["COZYGATEWAY_ATTACH_TOKEN_COZY"] = "cozy-token";
    const gateway = await startGateway({
      name: "e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", url: hermes.url, tokenEnv: "TEST_HERMES_TOKEN", profiles }],
      bots: [{ id: "cozy", tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_COZY", runtime: "cozyagents" }],
    });
    gateways.push(gateway);

    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, {
      headers: { authorization: "Bearer cozy-token" },
    });
    const frames: Array<{ kind: string; agentId?: string }> = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as { kind: string; agentId?: string }));
    await once(ws, "open");
    ws.send(JSON.stringify({
      kind: "hello",
      version: 2,
      instanceId: "cozy-plugin",
      capabilities: ["draft", "tools"],
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => frames.some((frame) => frame.kind === "hello_ack"));
    const ack = frames.find((frame) => frame.kind === "hello_ack");
    expect(ack).toMatchObject({ kind: "hello_ack", agentId: "cozy" });

    ws.close();
    delete process.env["TEST_HERMES_TOKEN"];
    delete process.env["TEST_ATTACH_TOKEN"];
    delete process.env["COZYGATEWAY_ATTACH_TOKEN_COZY"];
  });

  it("lets a native runtime bot use the attach-v1 media side channel like a Hermes profile", async () => {
    const hermes = await startFakeHermesServer({
      methods: { "profiles.list": () => ({ profiles: [], bot_mode_protocol: true }) },
    });
    servers.push(hermes);
    process.env["TEST_HERMES_TOKEN"] = "test-token";
    process.env["TEST_ATTACH_TOKEN"] = "attach-token";
    process.env["COZYGATEWAY_ATTACH_TOKEN_COZY"] = "cozy-token";
    const gateway = await startGateway({
      name: "e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", url: hermes.url, tokenEnv: "TEST_HERMES_TOKEN", profiles }],
      bots: [{ id: "cozy", tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_COZY", runtime: "cozyagents" }],
    });
    gateways.push(gateway);

    // A runtime bot (capability 45+, `nativeBots(config)`) negotiating `media` must clear the same
    // rollout gate a Hermes profile does: `allowedAttachMedia` used to be built from Hermes profiles
    // only, so this request answered 403 instead of reaching the "no such media" 404.
    const botMedia = await fetch(`${gateway.url}/attach/v1/media/does-not-exist`, {
      headers: { authorization: "Bearer cozy-token" },
    });
    expect(botMedia.status).toBe(404);

    // Unchanged: an unrecognized attach identity (not a Hermes profile, not a runtime bot) still
    // gets 401, and a real Hermes profile's own unknown-media request still 404s, not 403.
    const unknownIdentity = await fetch(`${gateway.url}/attach/v1/media/does-not-exist`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(unknownIdentity.status).toBe(401);

    const hermesMedia = await fetch(`${gateway.url}/attach/v1/media/does-not-exist`, {
      headers: { authorization: "Bearer attach-token" },
    });
    expect(hermesMedia.status).toBe(404);

    delete process.env["TEST_HERMES_TOKEN"];
    delete process.env["TEST_ATTACH_TOKEN"];
    delete process.env["COZYGATEWAY_ATTACH_TOKEN_COZY"];
  });

  it("fails startup when a native bot id collides with a Hermes profile id", async () => {
    process.env["TEST_HERMES_TOKEN"] = "test-token";
    process.env["TEST_ATTACH_TOKEN"] = "attach-token";
    process.env["COZYGATEWAY_ATTACH_TOKEN_SAGE"] = "sage-token";
    await expect(
      startGateway({
        name: "e2e",
        port: 0,
        dbPath: ":memory:",
        turnTimeoutSeconds: 0,
        // `profiles` (defined above) already declares Hermes profile "sage"; this bot reuses that
        // same id, so two distinct tokens would otherwise resolve to one agentId silently.
        hermesEndpoints: [{ id: "default", url: "ws://127.0.0.1:1/api/ws", tokenEnv: "TEST_HERMES_TOKEN", profiles }],
        bots: [{ id: "sage", tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_SAGE", runtime: "cozyagents" }],
      }),
    ).rejects.toThrow(/bot "sage": id collides with a Hermes profile id/);

    delete process.env["TEST_HERMES_TOKEN"];
    delete process.env["TEST_ATTACH_TOKEN"];
    delete process.env["COZYGATEWAY_ATTACH_TOKEN_SAGE"];
  });

  it("fails startup with bot-scoped wording when a native bot's token env var is unset", async () => {
    process.env["TEST_HERMES_TOKEN"] = "test-token";
    process.env["TEST_ATTACH_TOKEN"] = "attach-token";
    delete process.env["COZYGATEWAY_ATTACH_TOKEN_MISSING"];
    await expect(
      startGateway({
        name: "e2e",
        port: 0,
        dbPath: ":memory:",
        turnTimeoutSeconds: 0,
        hermesEndpoints: [{ id: "default", url: "ws://127.0.0.1:1/api/ws", tokenEnv: "TEST_HERMES_TOKEN", profiles }],
        bots: [{ id: "cozy", tokenEnv: "COZYGATEWAY_ATTACH_TOKEN_MISSING", runtime: "cozyagents" }],
      }),
      // The unset var belongs to a *bot*, not a Hermes profile, so the error must not misname it.
    ).rejects.toThrow(/^bot "cozy": environment variable "COZYGATEWAY_ATTACH_TOKEN_MISSING" is not set/);

    delete process.env["TEST_HERMES_TOKEN"];
    delete process.env["TEST_ATTACH_TOKEN"];
  });
});

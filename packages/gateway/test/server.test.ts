import { createServer } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayInfo, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";

let gateway: RunningGateway;

beforeEach(async () => {
  gateway = await startGateway({
    name: "e2e",
    port: 0,
    dbPath: ":memory:",
    agents: [{ id: "mock", name: "Mock", backend: "mock" }],
  });
});

afterEach(async () => {
  await gateway.close();
});

describe("startGateway end to end", () => {
  it("pairs, creates a thread, sends, and observes the stream on WS", async () => {
    const code = gateway.issueSetupCode();
    const pairRes = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "e2e phone" }),
    });
    expect(pairRes.status).toBe(200);
    const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

    const seen: ServerFrame[] = [];
    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: deviceToken }));

    const authed = { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };
    const threadRes = await fetch(`${gateway.url}/threads`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ agentId: "mock" }),
    });
    const thread = (await threadRes.json()) as { id: string };

    const sendRes = await fetch(`${gateway.url}/threads/${thread.id}/messages`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "round trip" }] }),
    });
    expect(sendRes.status).toBe(200);

    const start = Date.now();
    while (!seen.some((f) => f.type === "done")) {
      if (Date.now() - start > 5_000) throw new Error(`timeout; saw ${JSON.stringify(seen)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen.filter((f) => f.type === "draft").length).toBeGreaterThanOrEqual(1);
    const commits = seen.filter((f) => f.type === "committed");
    expect(commits.map((f) => (f.type === "committed" ? f.message.role : ""))).toEqual(["user", "agent"]);
    ws.close();
  });
});

// Issue #16: GatewayInfo.capabilities travels through GET /health, the pair response, and the
// ready frame -- one shared object, so wiring it once in startGateway covers all three.
describe("GatewayInfo.capabilities wiring", () => {
  it("defaults to an empty map when the config sets no capabilities", async () => {
    const gw = await startGateway({
      name: "no-caps",
      port: 0,
      dbPath: ":memory:",
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities).toEqual({});
    } finally {
      await gw.close();
    }
  });

  it("surfaces a configured com.cozylabs.* vendor capability identically in health, pair, and ready", async () => {
    const gw = await startGateway({
      name: "with-caps",
      port: 0,
      dbPath: ":memory:",
      agents: [{ id: "mock", name: "Mock", backend: "mock" }],
      capabilities: { "com.cozylabs.test": 1, "com.cozylabs.some-unrecognized-thing": 7 },
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities).toEqual({ "com.cozylabs.test": 1, "com.cozylabs.some-unrecognized-thing": 7 });

      const code = gw.issueSetupCode();
      const pairRes = await fetch(`${gw.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupCode: code, deviceName: "caps phone" }),
      });
      const paired = (await pairRes.json()) as { deviceToken: string; gateway: GatewayInfo };
      expect(paired.gateway.capabilities).toEqual(health.capabilities);

      const frames: ServerFrame[] = [];
      const ws = new WebSocket(`${gw.url.replace("http", "ws")}/ws`);
      ws.on("message", (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", token: paired.deviceToken }));
      const start = Date.now();
      while (!frames.some((f) => f.type === "ready")) {
        if (Date.now() - start > 5_000) throw new Error(`timeout; saw ${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      ws.close();
      const ready = frames.find((f) => f.type === "ready");
      expect(ready?.type === "ready" ? ready.gateway.capabilities : undefined).toEqual(health.capabilities);
    } finally {
      await gw.close();
    }
  });
});

/** A `ws://` URL guaranteed to refuse connections: binds an ephemeral TCP server, reads its
 *  port, then closes it immediately so nothing is listening there when the openclaw client
 *  dials out. Deterministic and fast (an immediate ECONNREFUSED), unlike guessing at an
 *  unassigned port a test environment could coincidentally have something else listening on.
 *  The openclaw client's own reconnect loop never has to reach a live handshake for this test:
 *  it only needs to observe that startup succeeds and presence settles to something other than
 *  "unknown" (see `createOpenClawAdapter.presence`, which reports "absent" for any non-"online"
 *  client state, including "connecting"). */
async function unreachableWsUrl(): Promise<string> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const addr = probe.address();
  if (addr === null || typeof addr !== "object") throw new Error("no probe address");
  const port = addr.port;
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  return `ws://127.0.0.1:${port}`;
}

describe("openclaw wiring", () => {
  const TOKEN_ENV = "SERVER_TEST_OPENCLAW_TOKEN";

  afterEach(() => {
    delete process.env[TOKEN_ENV];
  });

  it("fails closed before binding when the token env var is unset (no open port)", async () => {
    delete process.env[TOKEN_ENV];
    const url = await unreachableWsUrl();
    await expect(
      startGateway({
        name: "openclaw-fail-closed",
        port: 0,
        dbPath: ":memory:",
        agents: [
          { id: "oc1", name: "OC1", backend: "openclaw", options: { url, tokenEnv: TOKEN_ENV } },
        ],
      }),
    ).rejects.toThrow(new RegExp(TOKEN_ENV));
  });

  it("logs a root-token caveat naming the agent and token env at startup, without the token value", async () => {
    const secretToken = "super-secret-root-token-value";
    process.env[TOKEN_ENV] = secretToken;
    const url = await unreachableWsUrl();
    const lines: string[] = [];
    const oc = await startGateway(
      {
        name: "openclaw-caveat",
        port: 0,
        dbPath: ":memory:",
        agents: [{ id: "oc1", name: "OC1", backend: "openclaw", options: { url, tokenEnv: TOKEN_ENV } }],
      },
      { openclawLog: (message) => lines.push(message) },
    );
    try {
      const caveat = lines.find((l) => l.includes('agent "oc1"'));
      expect(caveat).toBeDefined();
      expect(caveat).toMatch(/ROOT/);
      expect(caveat).toContain(TOKEN_ENV);
      // The caveat names the env var, never the token value.
      expect(lines.join("\n")).not.toContain(secretToken);
    } finally {
      await oc.close();
    }
  });

  it("starts with an unreachable url and reports presence as online or absent, never unknown", async () => {
    process.env[TOKEN_ENV] = "server-test-openclaw-token";
    const url = await unreachableWsUrl();
    const oc = await startGateway({
      name: "openclaw-unreachable",
      port: 0,
      dbPath: ":memory:",
      agents: [
        { id: "oc1", name: "OC1", backend: "openclaw", options: { url, tokenEnv: TOKEN_ENV } },
      ],
    });
    try {
      const code = oc.issueSetupCode();
      const pairRes = await fetch(`${oc.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupCode: code, deviceName: "openclaw test phone" }),
      });
      expect(pairRes.status).toBe(200);
      const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

      const agentsRes = await fetch(`${oc.url}/agents`, {
        headers: { authorization: `Bearer ${deviceToken}` },
      });
      expect(agentsRes.status).toBe(200);
      const agentsBody = (await agentsRes.json()) as Array<{ id: string; presence: string }>;
      const oc1 = agentsBody.find((a) => a.id === "oc1");
      expect(oc1).toBeDefined();
      expect(["online", "absent"]).toContain(oc1?.presence);
    } finally {
      await oc.close();
    }
  });
});

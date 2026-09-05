import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  check,
  RunnerSchema,
  RunnersResponseSchema,
  RunnerSelfSchema,
  RunnerPairCodeResponseSchema,
  RunnerPairResponseSchema,
  type BotCreateResponse,
} from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";

/** Capability 52, controller ruling 1: a gateway with NO Hermes endpoint is a supported
 *  configuration, not a half-configured one. `hermesEndpoints` was `minItems: 1`, so this gateway
 *  could not be described at all before 52, which is why every assertion here is about a shape that
 *  simply did not exist rather than one that changed.
 *
 *  The whole assembly is real: `startGateway` wires the roster, the lane, the runtime bot service
 *  and the routes exactly as production does, and a hole in that wiring is invisible to a test that
 *  builds its own closures. */

const gateways: RunningGateway[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const gateway of gateways.splice(0)) await gateway.close();
  delete process.env["COZYGATEWAY_RUNNER_TOKEN"];
});

interface Live {
  gateway: RunningGateway;
  authed: (path: string, init?: RequestInit) => Promise<Response>;
}

async function live(): Promise<Live> {
  const gateway = await startGateway({
    name: "cozyagents-only",
    port: 0,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    // No `hermesEndpoints` at all. This is the whole point.
  });
  gateways.push(gateway);
  const code = gateway.issueSetupCode();
  const paired = (await (
    await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
    })
  ).json()) as { deviceToken: string };
  return {
    gateway,
    authed: (path, init) =>
      fetch(`${gateway.url}${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${paired.deviceToken}` },
      }),
  };
}

describe("a gateway configured with no Hermes endpoint", () => {
  it("starts, pairs a phone, and advertises the bots capability without the Hermes-shaped ones", async () => {
    const l = await live();
    const health = (await (await fetch(`${l.gateway.url}/health`)).json()) as {
      capabilities: Record<string, number>;
      bridges?: { hermes: unknown };
    };
    expect(health.capabilities["com.cozylabs.bots"]).toBeGreaterThanOrEqual(52);
    expect(health.capabilities["com.cozylabs.hermes-desktop-sessions"]).toBeUndefined();
    expect(health.capabilities["com.cozylabs.harness-settings"]).toBe(1);
    expect(health.capabilities["com.cozylabs.provider-connections"]).toBe(1);
    expect(health.capabilities["com.cozylabs.chat-configuration"]).toBe(1);
    expect(health.bridges).toEqual({ hermes: "absent" });
  });

  it("reports readiness rather than a degraded bridge nobody configured", async () => {
    const l = await live();
    const response = await fetch(`${l.gateway.url}/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ready: true, bridges: { hermes: "absent" } });
  });

  it("serves its roster from runtime bots alone", async () => {
    const l = await live();
    const empty = (await (await l.authed("/bots")).json()) as { bots: unknown[] };
    expect(empty.bots).toEqual([]);

    // Capability 54. A create needs a computer to put the bot on, and this gateway has none yet:
    // the answer is the sentence the app turns into "Add a computer first", not a bot nothing can
    // ever run.
    const homeless = await l.authed("/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sage", runtime: "cozyagents" }),
    });
    expect(homeless.status).toBe(409);
    expect(await homeless.json()).toMatchObject({ error: { code: "no_runner_paired" } });

    const runner = await pairRunner(l, "kyle-mbp");
    const created = await l.authed("/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sage", runtime: "cozyagents" }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as BotCreateResponse).bot).toMatchObject({
      name: "sage",
      runtime: "cozyagents",
      runnerId: runner.runner.id,
      runnerName: "kyle-mbp",
    });

    const roster = (await (await l.authed("/bots")).json()) as { bots: Array<{ name: string; runtime?: string }> };
    expect(roster.bots.map((bot) => bot.name)).toEqual(["sage"]);
    // The bot waits honestly for a runner rather than being invented into progress.
    const runtime = (await (await l.authed("/bots/sage/runtime")).json()) as { stage: string };
    expect(runtime.stage).toBe("waiting_for_runner");
  });

  it("mints a runner code from the app that names the port it is actually listening on", async () => {
    const l = await live();
    const minted = await l.authed("/runners/pair-code", { method: "POST" });
    expect(minted.status).toBe(200);
    const mintedBody: unknown = await minted.json();
    // The published schema against the REAL bytes: a route that drifts from the contract fails
    // here rather than on a phone.
    expect(check(RunnerPairCodeResponseSchema, mintedBody)).toBe(true);
    const code = mintedBody as { setupCode: string; expiresAt: number; gatewayUrl: string };
    // Port 0 was requested, so a `gatewayUrl` built from the CONFIG would name a port nothing serves.
    expect(new URL(code.gatewayUrl).port).toBe(String(l.gateway.port));
    expect(code.expiresAt).toBeGreaterThan(Date.now());

    const paired = await fetch(`${l.gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code.setupCode, deviceName: "kyle-mbp", kind: "runner" }),
    });
    expect(paired.status).toBe(200);
    const pairedBody: unknown = await paired.json();
    expect(check(RunnerPairResponseSchema, pairedBody)).toBe(true);
    const body = pairedBody as { runnerToken: string; runner: { id: string } };

    // The installer's health check, over the real route: paired but not yet attached.
    const self = await fetch(`${l.gateway.url}/runners/self`, {
      headers: { authorization: `Bearer ${body.runnerToken}` },
    });
    expect(self.status).toBe(200);
    const selfBody: unknown = await self.json();
    expect(check(RunnerSelfSchema, selfBody)).toBe(true);
    expect(selfBody).toEqual({
      id: body.runner.id,
      name: "kyle-mbp",
      platform: null,
      default: true,
      lastSeenAt: null,
      attached: false,
      online: false,
      // Capability 55: unrenamed, since nobody has set a display name here.
      renamed: false,
    });
  });

  it("pairs a runner and hands it the work that was waiting, with no shared token anywhere", async () => {
    expect(process.env["COZYGATEWAY_RUNNER_TOKEN"]).toBeUndefined();
    const l = await live();
    // The same code flow the CLI's `pair --kind runner` drives, over the real route. It comes
    // FIRST from capability 54: a create names the computer it runs on, so there has to be one.
    const paired = await pairRunner(l, "kyle-mbp");
    expect(paired.runner).toMatchObject({ name: "kyle-mbp", default: true });
    // Still created while nothing is attached: the operation waits for that machine to dial in.
    await l.authed("/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sage", runtime: "cozyagents" }),
    });

    // `/runner/v1` is registered even though no `COZYGATEWAY_RUNNER_TOKEN` was ever placed.
    const ws = new WebSocket(`${l.gateway.url.replace("http", "ws")}/runner/v1`, {
      headers: { authorization: `Bearer ${paired.runnerToken}` },
    });
    sockets.push(ws);
    const frames: Array<{ kind: string; command?: string; payload?: { botId?: string } }> = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as { kind: string }));
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        kind: "hello",
        version: 1,
        runnerId: paired.runner.id,
        name: "kyle-mbp",
        platform: { os: "darwin", arch: "arm64", release: "24.5.0" },
        agentVersion: "0.1.0",
        backends: ["process"],
      }),
    );
    await until(() => frames.some((frame) => frame.kind === "hello_ack"));
    await until(() => frames.some((frame) => frame.command === "create_runtime"));
    expect(frames.find((frame) => frame.command === "create_runtime")?.payload?.botId).toBe("sage");

    const self = (await (
      await fetch(`${l.gateway.url}/runners/self`, {
        headers: { authorization: `Bearer ${paired.runnerToken}` },
      })
    ).json()) as { attached: boolean; platform: string | null; lastSeenAt: number | null };
    expect(self.attached).toBe(true);
    expect(self.platform).toBe("darwin/arm64/24.5.0");
    expect(self.lastSeenAt).not.toBeNull();

    const rosterBody: unknown = await (await l.authed("/runners")).json();
    expect(check(RunnersResponseSchema, rosterBody)).toBe(true);
    const roster = rosterBody as {
      runners: Array<{ id: string; name: string; platform: string | null; version: string | null; online: boolean; default: boolean; lastSeenAt: number | null }>;
    };
    expect(check(RunnerSchema, roster.runners[0])).toBe(true);
    expect(roster.runners).toHaveLength(1);
    expect(roster.runners[0]).toMatchObject({
      id: paired.runner.id,
      name: "kyle-mbp",
      platform: "darwin/arm64/24.5.0",
      version: "0.1.0",
      online: true,
      default: true,
    });
    expect(roster.runners[0]!.lastSeenAt).not.toBeNull();

    // Revoking it closes the socket, and the same token is refused on a reconnect.
    const deleted = await l.authed(`/runners/${paired.runner.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    await until(() => ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING);
    const refused = new WebSocket(`${l.gateway.url.replace("http", "ws")}/runner/v1`, {
      headers: { authorization: `Bearer ${paired.runnerToken}` },
    });
    sockets.push(refused);
    const closed: { code: number | undefined } = { code: undefined };
    refused.on("close", (code) => {
      closed.code = code;
    });
    await until(() => closed.code !== undefined);
    expect(closed.code).toBe(1008);
    expect(((await (await l.authed("/runners")).json()) as { runners: unknown[] }).runners).toEqual([]);
    const afterRevoke = await fetch(`${l.gateway.url}/runners/self`, {
      headers: { authorization: `Bearer ${paired.runnerToken}` },
    });
    expect(afterRevoke.status).toBe(401);
  });
});

/** Pairs one computer over the real `POST /pair {kind: "runner"}` route, which is what a create
 *  needs from capability 54 onward. */
async function pairRunner(
  l: { gateway: { url: string; storage: { createSetupCode: (code: string, expiresAt: number, kind: "runner") => void } } },
  name: string,
): Promise<{ runnerToken: string; runner: { id: string; name: string; default: boolean } }> {
  const code = `RUNNER-CODE-${name}`;
  l.gateway.storage.createSetupCode(code, Date.now() + 60_000, "runner");
  const response = await fetch(`${l.gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: name, kind: "runner" }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    runnerToken: string;
    runner: { id: string; name: string; default: boolean };
  };
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

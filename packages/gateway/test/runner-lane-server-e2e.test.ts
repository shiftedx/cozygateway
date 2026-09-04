import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { BotCreateResponse, BotRuntimeProjection } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 49 through the REAL assembly: `startGateway` wires the runtime bot service, the
 *  native plane, the routes and the `/runner/v1` upgrade itself, and a hole in that wiring is
 *  invisible to a test that builds its own closures. The unit test around the service proved the
 *  service honours `force`; this proves the assembled gateway actually hands it over, which it did
 *  not until this test existed.
 *
 *  Everything else here is the same end-to-end path a phone takes: pair, create a runtime bot, read
 *  its runtime projection, and watch a runner attached to the real upgrade route receive the
 *  operation. */

const gateways: RunningGateway[] = [];
const servers: FakeHermesServer[] = [];
const sockets: WebSocket[] = [];
const RUNNER_TOKEN = "e2e-runner-secret";

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await server.close();
  delete process.env["TEST_HERMES_TOKEN"];
  delete process.env["COZYGATEWAY_RUNNER_TOKEN"];
});

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Live {
  gateway: RunningGateway;
  authed: (path: string, init?: RequestInit) => Promise<Response>;
}

async function live(): Promise<Live> {
  const hermes = await startFakeHermesServer({
    methods: { "profiles.list": () => ({ profiles: [], bot_mode_protocol: true }) },
  });
  servers.push(hermes);
  process.env["TEST_HERMES_TOKEN"] = "test-token";
  process.env["COZYGATEWAY_RUNNER_TOKEN"] = RUNNER_TOKEN;
  const gateway = await startGateway({
    name: "runner-e2e",
    port: 0,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    // No `profiles`: this gateway serves nothing but the runtime bot the test creates, which is the
    // shape a CozyAgents-only box has.
    hermesEndpoints: [{ id: "default", url: hermes.url, tokenEnv: "TEST_HERMES_TOKEN", profiles: {} }],
  });
  gateways.push(gateway);
  const code = gateway.issueSetupCode();
  const paired = await fetch(`${gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await paired.json()) as { deviceToken: string };
  return {
    gateway,
    authed: (path, init) =>
      fetch(`${gateway.url}${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
      }),
  };
}

async function createSage(l: Live): Promise<BotCreateResponse> {
  const response = await l.authed("/bots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "sage", runtime: "cozyagents" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as BotCreateResponse;
}

describe("capability 49 through the assembled gateway", () => {
  it("forwards force to the runtime delete, so a bot with a stuck turn is still removable", async () => {
    const l = await live();
    await createSage(l);

    // A turn that never settled. Without `force` reaching the service this bot is undeletable, and
    // the gateway's own wiring is the only place that can drop the flag.
    const chat = l.gateway.storage.nativeBotChat("sage", Date.now());
    l.gateway.storage.setNativeBotTurn("sage", chat.sessionId, "turn-stuck", Date.now());

    const refused = await l.authed("/bots/sage", { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("turn-stuck");
    expect(l.gateway.storage.runtimeBot("sage")).toBeDefined();

    const forced = await l.authed("/bots/sage?force=1", { method: "DELETE" });
    expect(forced.status).toBe(200);
    expect(l.gateway.storage.runtimeBot("sage")).toBeUndefined();
    // The cleanup stays watchable through the same wiring.
    const projection = (await (await l.authed("/bots/sage/runtime")).json()) as BotRuntimeProjection;
    expect(projection.stage).toBe("deletion_pending");
  });

  it("creates a bot the app can see and hands its operation to a runner on the real upgrade route", async () => {
    const l = await live();
    const created = await createSage(l);
    expect(created.bot).toMatchObject({ name: "sage", runtime: "cozyagents" });

    const roster = (await (await l.authed("/bots")).json()) as { bots: Array<{ name: string }> };
    expect(roster.bots.map((bot) => bot.name)).toEqual(["sage"]);
    const waiting = (await (await l.authed("/bots/sage/runtime")).json()) as BotRuntimeProjection;
    expect(waiting.stage).toBe("waiting_for_runner");

    const ws = new WebSocket(`${l.gateway.url.replace("http", "ws")}/runner/v1`, {
      headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
    });
    sockets.push(ws);
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    await once(ws, "open");
    ws.send(JSON.stringify({ kind: "hello", version: 1, runnerId: "e2e", backends: ["process"] }));
    await until(() => frames.some((frame) => frame["kind"] === "command"));

    const command = frames.find((frame) => frame["kind"] === "command") as {
      command: string;
      payload: { botId: string; operationId: string; attachToken: string };
    };
    expect(command.command).toBe("create_runtime");
    expect(command.payload.botId).toBe("sage");
    // The credential on the frame is the one the bot's own attach identity authenticates with.
    expect(command.payload.attachToken).toBe(l.gateway.storage.runtimeBot("sage")!.token);

    ws.send(
      JSON.stringify({
        kind: "receipt",
        operationId: command.payload.operationId,
        botId: "sage",
        specGeneration: 1,
        stage: "ready",
        at: Date.now(),
      }),
    );
    await until(
      () => l.gateway.storage.runnerOperation(command.payload.operationId)?.stage === "ready",
    );
    const ready = (await (await l.authed("/bots/sage/runtime")).json()) as BotRuntimeProjection;
    expect(ready).toMatchObject({ stage: "ready", specGeneration: 1, observedGeneration: 1 });
  });

  it("accepts one authenticated exact recovery through the assembled control plane", async () => {
    const l = await live();
    await createSage(l);
    const ws = new WebSocket(`${l.gateway.url.replace("http", "ws")}/runner/v1`, {
      headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
    });
    sockets.push(ws);
    const frames: Array<{ kind: string; command?: string; payload?: { botId: string; operationId: string; attachToken: string } }> = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as (typeof frames)[number]));
    await once(ws, "open");
    ws.send(JSON.stringify({ kind: "hello", version: 1, runnerId: "e2e", backends: ["process"] }));
    await until(() => frames.some((frame) => frame.command === "create_runtime"));
    const first = frames.find((frame) => frame.command === "create_runtime")!.payload!;
    ws.send(JSON.stringify({
      kind: "receipt",
      operationId: first.operationId,
      botId: "sage",
      specGeneration: 1,
      stage: "needs_attention",
      code: "restart_budget_exhausted",
      at: Date.now(),
    }));
    await until(() => l.gateway.storage.runnerOperation(first.operationId)?.stage === "needs_attention");

    const recovered = await l.authed("/bots/sage/runtime/recover", { method: "POST" });
    expect(recovered.status).toBe(202);
    const body = (await recovered.json()) as { operationId: string; runtime: BotRuntimeProjection };
    expect(body).toMatchObject({ runtime: { stage: "waiting_for_runner", specGeneration: 1 } });
    await until(() => frames.filter((frame) => frame.command === "create_runtime").length === 2);
    const second = frames.filter((frame) => frame.command === "create_runtime")[1]!.payload!;
    expect(second).toMatchObject({
      botId: "sage",
      operationId: body.operationId,
      attachToken: first.attachToken,
    });
    expect(second.operationId).not.toBe(first.operationId);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { BotCreateResponse, BotDeleteResponse, BotRuntimeProjection } from "cozygateway-contract";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { resolveAttachBearer, revokeAttachTokens } from "../src/adapters/attach/token-auth.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";
import { RunnerLane } from "../src/runner/lane.ts";
import { RuntimeBotService } from "../src/runner/runtime-bots.ts";
import type { RunnerServerFrame } from "../src/runner/protocol.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/** Capability 49, the gateway half of CozyRunner. The promises under test are the ones a user can
 *  feel from the app: a create answers at once and waits honestly when nobody can serve it, a
 *  runner that connects later is handed exactly the work it missed, its receipts are what the
 *  runtime route projects, the credential minted during the create can authenticate a peer the
 *  moment the 201 lands, and a delete kills that credential.
 *
 *  The whole assembly is real: a real storage, a real native plane, real routes, a real
 *  attach ingress and a real runner socket over one http server, exactly as `startGateway` wires
 *  them. Only Hermes is a stub, because a runtime bot never reaches it. */

const NOW = 1_800_000_000_000;
const RUNNER_TOKEN = "runner-secret";

interface Harness {
  storage: Storage;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  attachTokens: Map<string, string>;
  port: number;
  lane: RunnerLane;
  /** Everything the create/delete path logged, for the "no secrets in logs" assertion. */
  logs: string[];
  close: () => Promise<void>;
}

async function setup(): Promise<Harness> {
  const storage = openStorage(":memory:");
  const attachTokens = new Map<string, string>();
  const logs: string[] = [];
  const ingress = new AttachV1Ingress({
    tokens: attachTokens,
    storage,
    events: { onEvent: () => true, onPresence: () => undefined },
    now: () => NOW,
  });
  const lane = new RunnerLane({
    token: RUNNER_TOKEN,
    storage,
    attachTokenFor: (botId) => storage.runtimeBot(botId)?.token,
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  const control = {
    roster: () => ({ bots: [], updatedAt: NOW, stale: false }),
    refreshSoon: () => {},
    createBot: () => Promise.reject(new Error("a runtime create must never reach Hermes")),
    deleteBot: () => Promise.reject(new Error("a runtime delete must never reach Hermes")),
  } as unknown as BotsSurface;
  let service: RuntimeBotService | undefined;
  const plane = new NativeBotDataPlane({
    control,
    storage,
    ingress,
    nativeBots: [],
    chatSuggestion: "",
    broadcast: () => {},
    now: () => NOW,
    runtimeLifecycle: {
      owns: (id) => service?.owns(id) === true,
      create: (input, row) => service!.create(input, row),
      delete: (name) => service!.delete(name),
      projection: (name) => service!.projection(name),
    },
  });
  service = new RuntimeBotService({
    storage,
    lane,
    spec: { image: "ghcr.io/example/cozyagents@sha256:abc", resources: { cpus: 2, memoryMb: 2048 } },
    now: () => NOW,
    log: (line) => logs.push(line),
    register: (bot) => {
      attachTokens.set(bot.token, bot.id);
      plane.addRuntimeBot({ id: bot.id, name: bot.name, avatar: bot.avatar, runtime: bot.runtime });
    },
    unregister: (id) => {
      const revoked = revokeAttachTokens(attachTokens, id);
      ingress.disconnectAgent(id);
      plane.removeRuntimeBot(id);
      return revoked;
    },
  });

  const app = new Hono();
  const requireDevice: MiddlewareHandler = async (c, next) => {
    c.set("deviceId", "device-1");
    await next();
  };
  registerBotRoutes(app as never, requireDevice as never, plane.surface());

  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/runner/v1") lane.handleUpgrade(req, socket, head);
    else if (path === "/attach/v1") ingress.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    storage,
    request: async (path, init) => app.request(path, init),
    attachTokens,
    port,
    lane,
    logs,
    close: async () => {
      lane.close();
      ingress.close();
      plane.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      storage.close();
    },
  };
}

const harnesses: Harness[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function harness(): Promise<Harness> {
  const built = await setup();
  harnesses.push(built);
  return built;
}

async function createRuntimeBot(h: Harness, name = "sage"): Promise<BotCreateResponse> {
  const response = await h.request("/bots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, runtime: "cozyagents" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as BotCreateResponse;
}

/** A runner exactly as CozyAgents will build one: outbound socket, bearer token, hello, then
 *  receipts. It records the commands the gateway hands it. */
async function fakeRunner(
  h: Harness,
  opts: { token?: string; backends?: string[] } = {},
): Promise<{ ws: WebSocket; frames: RunnerServerFrame[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/runner/v1`, {
    headers: { authorization: `Bearer ${opts.token ?? RUNNER_TOKEN}` },
  });
  sockets.push(ws);
  const frames: RunnerServerFrame[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as RunnerServerFrame));
  await once(ws, "open");
  ws.send(
    JSON.stringify({
      kind: "hello",
      version: 1,
      runnerId: "runner-1",
      backends: opts.backends ?? ["docker"],
    }),
  );
  await until(() => frames.some((frame) => frame.kind === "hello_ack"));
  return { ws, frames };
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function projection(h: Harness, name: string): Promise<BotRuntimeProjection> {
  const response = await h.request(`/bots/${name}/runtime`);
  expect(response.status).toBe(200);
  return (await response.json()) as BotRuntimeProjection;
}

describe("runtime bot creation without a runner", () => {
  it("answers 201 with the runtime row and leaves the operation waiting for a runner", async () => {
    const h = await harness();
    const created = await createRuntimeBot(h);

    expect(created.bot).toMatchObject({ name: "sage", runtime: "cozyagents", syncState: "starting" });
    expect(created.warnings?.[0]).toMatch(/no runner is connected/);
    expect(await projection(h, "sage")).toEqual({
      stage: "waiting_for_runner",
      specGeneration: 1,
      observedGeneration: null,
      lastRunnerContactAt: null,
    });
    // The roster shows it immediately, with no restart and no Hermes profile behind it.
    const roster = (await (await h.request("/bots")).json()) as { bots: Array<{ name: string; runtime?: string }> };
    expect(roster.bots.map((bot) => bot.name)).toContain("sage");
    expect(h.storage.runtimeBot("sage")?.specGeneration).toBe(1);
  });

  it("refuses a second bot with the same name", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const again = await h.request("/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sage", runtime: "cozyagents" }),
    });
    expect(again.status).toBe(409);
  });

  it("never writes the minted credential into a log line or the operation row", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const token = h.storage.runtimeBot("sage")!.token;
    expect(token.length).toBeGreaterThan(32);
    expect(h.logs.join("\n")).not.toContain(token);
    const operation = h.storage.latestRunnerOperationForBot("sage")!;
    expect(JSON.stringify(operation.payload)).not.toContain(token);
  });
});

describe("the runner lane", () => {
  it("refuses a socket without the runner token", async () => {
    const h = await harness();
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/runner/v1`, {
      headers: { authorization: "Bearer wrong" },
    });
    sockets.push(ws);
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(1008);
  });

  it("hands a waiting operation to a runner that connects later and projects its receipts", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const runner = await fakeRunner(h);

    await until(() => runner.frames.some((frame) => frame.kind === "command"));
    const command = runner.frames.find((frame) => frame.kind === "command")!;
    expect(command).toMatchObject({
      command: "create_runtime",
      payload: {
        botId: "sage",
        specGeneration: 1,
        image: "ghcr.io/example/cozyagents@sha256:abc",
        resources: { cpus: 2, memoryMb: 2048 },
      },
    });
    // The attach credential rides this frame and nowhere else.
    const payload = command.payload as { operationId: string; attachToken: string };
    expect(payload.attachToken).toBe(h.storage.runtimeBot("sage")!.token);

    for (const stage of ["pulling_image", "creating", "starting", "ready"] as const) {
      runner.ws.send(
        JSON.stringify({
          kind: "receipt",
          operationId: payload.operationId,
          botId: "sage",
          specGeneration: 1,
          stage,
          at: NOW + 1,
        }),
      );
      await until(() => h.storage.runnerOperation(payload.operationId)?.stage === stage);
    }

    expect(await projection(h, "sage")).toEqual({
      stage: "ready",
      specGeneration: 1,
      observedGeneration: 1,
      lastRunnerContactAt: NOW + 1,
    });
  });

  it("projects a needs_attention receipt with its safe code", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const runner = await fakeRunner(h, { backends: ["process"] });
    await until(() => runner.frames.some((frame) => frame.kind === "command"));
    const payload = (runner.frames.find((frame) => frame.kind === "command")!.payload as { operationId: string });
    runner.ws.send(
      JSON.stringify({
        kind: "receipt",
        operationId: payload.operationId,
        botId: "sage",
        specGeneration: 1,
        stage: "needs_attention",
        at: NOW + 5,
        code: "image_unavailable",
      }),
    );
    await until(() => h.storage.runnerOperation(payload.operationId)?.stage === "needs_attention");
    expect(await projection(h, "sage")).toMatchObject({
      stage: "needs_attention",
      code: "image_unavailable",
    });
  });

  it("ignores a receipt for an operation it never issued", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const runner = await fakeRunner(h);
    await until(() => runner.frames.some((frame) => frame.kind === "command"));
    runner.ws.send(
      JSON.stringify({
        kind: "receipt",
        operationId: "op_invented",
        botId: "sage",
        specGeneration: 9,
        stage: "ready",
        at: NOW + 9,
      }),
    );
    await until(() => h.logs.some((line) => line.includes("unknown operation")));
    expect((await projection(h, "sage")).stage).toBe("waiting_for_runner");
  });
});

describe("the credential a create mints", () => {
  it("authenticates an attach peer immediately, with no restart", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const token = h.storage.runtimeBot("sage")!.token;
    expect(resolveAttachBearer(h.attachTokens, `Bearer ${token}`)).toBe("sage");

    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/attach/v1`, {
      headers: { authorization: `Bearer ${token}` },
    });
    sockets.push(ws);
    const frames: Array<{ kind: string }> = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as { kind: string }));
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        kind: "hello",
        version: 2,
        instanceId: "peer-1",
        capabilities: ["draft"],
        resume: { eventSequence: 0, commandSequence: 0 },
      }),
    );
    await until(() => frames.some((frame) => frame.kind === "hello_ack"));
  });
});

describe("deleting a runtime bot", () => {
  it("revokes the credential, purges the rows, and enqueues delete_runtime", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const runner = await fakeRunner(h);
    await until(() => runner.frames.some((frame) => frame.kind === "command"));
    const token = h.storage.runtimeBot("sage")!.token;

    const response = await h.request("/bots/sage", { method: "DELETE" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as BotDeleteResponse;
    expect(body).toMatchObject({ name: "sage", hermesProfile: "already_absent", tokenRevoked: true });

    expect(resolveAttachBearer(h.attachTokens, `Bearer ${token}`)).toBeUndefined();
    expect(h.storage.runtimeBot("sage")).toBeUndefined();
    await until(() =>
      runner.frames.some((frame) => frame.kind === "command" && frame.command === "delete_runtime"),
    );
    const deleteCommand = runner.frames.find(
      (frame) => frame.kind === "command" && frame.command === "delete_runtime",
    )!;
    expect(deleteCommand.payload).toMatchObject({ botId: "sage", specGeneration: 1 });
    expect(JSON.stringify(deleteCommand)).not.toContain(token);

    // The bot is gone from every gateway surface the app can reach.
    const roster = (await (await h.request("/bots")).json()) as { bots: Array<{ name: string }> };
    expect(roster.bots.map((bot) => bot.name)).not.toContain("sage");
    expect((await h.request("/bots/sage/runtime")).status).toBe(409);
  });
});

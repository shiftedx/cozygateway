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
import { check } from "cozygateway-contract";

import {
  RuntimeBotService,
  RuntimeSpecSchema,
  mergeRuntimeBots,
  runtimeSpecDefaults,
  type RuntimeSpecDefaults,
} from "../src/runner/runtime-bots.ts";
import type { RunnerServerFrame } from "../src/runner/protocol.ts";
import { openStorage, regressesRunnerStage, type Storage } from "../src/storage.ts";

/** Capability 49, the gateway half of CozyRunner. The promises under test are the ones a user can
 *  feel from the app: a create answers at once and waits honestly when nobody can serve it, a
 *  runner that connects later is handed exactly the work it missed, its receipts are what the
 *  runtime route projects, the credential minted during the create can authenticate a peer the
 *  moment the 201 lands, and a delete kills that credential while leaving the cleanup watchable.
 *
 *  The whole assembly is real: a real storage, a real native plane, real routes, a real attach
 *  ingress and a real runner socket over one http server, exactly as `startGateway` wires them.
 *  Only Hermes is a stub, because a runtime bot never reaches it. */

const NOW = 1_800_000_000_000;
const RUNNER_TOKEN = "runner-secret";

interface Harness {
  storage: Storage;
  plane: NativeBotDataPlane;
  service: RuntimeBotService;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  attachTokens: Map<string, string>;
  port: number;
  lane: RunnerLane;
  /** Moves the lane's clock, for the heartbeat ceiling. */
  advance: (ms: number) => void;
  /** Everything the create/delete path and the lane logged, for the "no secrets" assertions. */
  logs: string[];
  close: () => Promise<void>;
}

async function setup(
  opts: {
    spec?: () => RuntimeSpecDefaults;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    maxPendingConnections?: number;
  } = {},
): Promise<Harness> {
  const storage = openStorage(":memory:");
  const attachTokens = new Map<string, string>();
  const logs: string[] = [];
  let clock = NOW;
  const ingress = new AttachV1Ingress({
    tokens: attachTokens,
    storage,
    events: { onEvent: () => true, onPresence: () => undefined },
    now: () => clock,
  });
  const lane = new RunnerLane({
    token: RUNNER_TOKEN,
    storage,
    attachTokenFor: (botId) => storage.runtimeBot(botId)?.token,
    now: () => clock,
    log: (line) => logs.push(line),
    ...(opts.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: opts.heartbeatIntervalMs }),
    ...(opts.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: opts.heartbeatTimeoutMs }),
    ...(opts.maxPendingConnections === undefined ? {} : { maxPendingConnections: opts.maxPendingConnections }),
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
    now: () => clock,
    runtimeLifecycle: {
      owns: (id) => service?.owns(id) === true,
      hasRuntime: (id) => service?.hasRuntime(id) === true,
      create: (input, row) => service!.create(input, row),
      delete: (name, deleteOpts) => service!.delete(name, deleteOpts),
      recover: (name) => service!.recover(name),
      projection: (name) => service!.projection(name),
    },
  });
  service = new RuntimeBotService({
    storage,
    lane,
    spec:
      opts.spec ??
      (() => ({ image: "ghcr.io/example/cozyagents@sha256:abc", resources: { cpus: 2, memoryMb: 2048 } })),
    now: () => clock,
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
    plane,
    service,
    request: async (path, init) => app.request(path, init),
    attachTokens,
    port,
    lane,
    advance: (ms) => {
      clock += ms;
    },
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

async function harness(opts: Parameters<typeof setup>[0] = {}): Promise<Harness> {
  const built = await setup(opts);
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
  opts: { token?: string; backends?: string[]; extra?: Record<string, unknown>; awaitAck?: boolean } = {},
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
      ...(opts.extra ?? {}),
    }),
  );
  if (opts.awaitAck !== false) await until(() => frames.some((frame) => frame.kind === "hello_ack"));
  return { ws, frames };
}

async function rejectedRunnerUpgrade(h: Harness): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/runner/v1`, {
    headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
  });
  return await new Promise<number>((resolve, reject) => {
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    ws.once("error", reject);
  });
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

function commands(frames: RunnerServerFrame[]): Array<Extract<RunnerServerFrame, { kind: "command" }>> {
  return frames.filter((frame) => frame.kind === "command") as Array<
    Extract<RunnerServerFrame, { kind: "command" }>
  >;
}

async function receipt(
  ws: WebSocket,
  h: Harness,
  operationId: string,
  stage: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  ws.send(
    JSON.stringify({ kind: "receipt", operationId, botId: "sage", specGeneration: 1, stage, at: NOW + 1, ...extra }),
  );
  await until(() => h.storage.runnerOperation(operationId)?.stage === stage);
}

describe("runtime bot creation without a runner", () => {
  it("releases invalid bearers and rejects a full runner pool before a 101 response", async () => {
    const h = await harness({ maxPendingConnections: 1 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const invalid = new WebSocket(`ws://127.0.0.1:${h.port}/runner/v1`, {
        headers: { authorization: `Bearer invalid-${attempt}` },
      });
      sockets.push(invalid);
      await once(invalid, "open");
      const [code] = (await once(invalid, "close")) as [number];
      expect(code).toBe(1008);
    }
    const held = new WebSocket(`ws://127.0.0.1:${h.port}/runner/v1`, {
      headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
    });
    sockets.push(held);
    await once(held, "open");
    await expect(rejectedRunnerUpgrade(h)).resolves.toBe(503);
    held.close();
    await once(held, "close");
    const valid = await fakeRunner(h);
    valid.ws.close();
  });

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
    const roster = (await (await h.request("/bots")).json()) as { bots: Array<{ name: string }> };
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

  it("refuses a malformed runtime spec with 400 instead of creating a bot on a dropped ceiling", async () => {
    const h = await harness({ spec: () => runtimeSpecDefaults({ COZYGATEWAY_RUNNER_CPUS: "plenty" }) });
    const response = await h.request("/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "sage", runtime: "cozyagents" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/COZYGATEWAY_RUNNER_CPUS/);
    // Nothing was half-created: no row, no credential, no operation.
    expect(h.storage.runtimeBot("sage")).toBeUndefined();
    expect(h.storage.unsentRunnerOperations()).toEqual([]);
  });

  it("puts a created bot into the live runtime set, so it can join a room without a restart", async () => {
    const h = await harness();
    expect(h.plane.runtimeBotNames().has("sage")).toBe(false);
    await createRuntimeBot(h);
    expect(h.plane.runtimeBotNames().has("sage")).toBe(true);
    expect((await h.request("/bots/sage", { method: "DELETE" })).status).toBe(200);
    expect(h.plane.runtimeBotNames().has("sage")).toBe(false);
  });
});

describe("the runtime spec an operator configures", () => {
  it("reads an entrypoint as argv and refuses anything else", () => {
    expect(runtimeSpecDefaults({ COZYGATEWAY_RUNNER_ENTRYPOINT_JSON: '["cozyagents","serve"]' })).toEqual({
      entrypoint: ["cozyagents", "serve"],
    });
    expect(() => runtimeSpecDefaults({ COZYGATEWAY_RUNNER_ENTRYPOINT_JSON: "cozyagents serve" })).toThrow(
      /COZYGATEWAY_RUNNER_ENTRYPOINT_JSON/,
    );
    expect(() => runtimeSpecDefaults({ COZYGATEWAY_RUNNER_ENTRYPOINT_JSON: '"cozyagents"' })).toThrow();
    expect(() => runtimeSpecDefaults({ COZYGATEWAY_RUNNER_MEMORY_MB: "2048.5" })).toThrow();
    expect(runtimeSpecDefaults({})).toEqual({});
    // At most one of the two: a runtime is either an image for the docker backend or an argv for
    // the process backend, and a command carrying both would leave the runner guessing.
    expect(() =>
      runtimeSpecDefaults({
        COZYGATEWAY_RUNNER_IMAGE: "ghcr.io/example/cozyagents@sha256:abc",
        COZYGATEWAY_RUNNER_ENTRYPOINT_JSON: '["cozyagents"]',
      }),
    ).toThrow(/not both/);
    // The invariant is normative, not merely a parse-order accident: a spec supplied
    // programmatically with both is refused by the schema too.
    expect(check(RuntimeSpecSchema, { image: "i", entrypoint: ["e"] })).toBe(false);
    expect(check(RuntimeSpecSchema, { image: "i", resources: { cpus: 1 } })).toBe(true);
    expect(check(RuntimeSpecSchema, { entrypoint: ["e"], resources: { cpus: 1 } })).toBe(true);
    // A model is optional, and its absence means the runner's own default rather than a guess.
    expect(runtimeSpecDefaults({ COZYGATEWAY_RUNNER_MODEL_ID: "m", COZYGATEWAY_RUNNER_MODEL_PROVIDER: "p" })).toEqual({
      model: { id: "m", provider: "p" },
    });
  });

  it("carries configured positive model limits and omits absent limits", () => {
    expect(runtimeSpecDefaults({
      COZYGATEWAY_RUNNER_MODEL_ID: "m",
      COZYGATEWAY_RUNNER_MODEL_PROVIDER: "p",
      COZYGATEWAY_RUNNER_MODEL_CONTEXT_WINDOW: "131072",
      COZYGATEWAY_RUNNER_MODEL_MAX_TOKENS: "8192",
    })).toEqual({
      model: { id: "m", provider: "p", contextWindow: 131072, maxTokens: 8192 },
    });

    expect(JSON.stringify(runtimeSpecDefaults({
      COZYGATEWAY_RUNNER_MODEL_ID: "m",
      COZYGATEWAY_RUNNER_MODEL_PROVIDER: "p",
    }))).toBe('{"model":{"id":"m","provider":"p"}}');
  });

  it("rejects invalid model limits by configuration name", () => {
    const invalid = ["0", "-1", "01", "1.0", "1e3", "+1000", "NaN", "Infinity", "9007199254740992"];
    for (const name of [
      "COZYGATEWAY_RUNNER_MODEL_CONTEXT_WINDOW",
      "COZYGATEWAY_RUNNER_MODEL_MAX_TOKENS",
    ]) {
      for (const value of invalid) {
        expect(() => runtimeSpecDefaults({
          COZYGATEWAY_RUNNER_MODEL_ID: "m",
          COZYGATEWAY_RUNNER_MODEL_PROVIDER: "p",
          [name]: value,
        })).toThrow(name);
      }
    }
  });

  it("lets a storage row win over a config line with the same id", () => {
    const merged = mergeRuntimeBots(
      [
        { id: "sage", name: "Config Sage", runtime: "cozyagents" },
        { id: "pixel", name: "Pixel", runtime: "cozyagents" },
      ],
      [{ id: "sage", name: "Stored Sage", avatar: null, runtime: "cozyagents" }],
    );
    expect(merged.bots.map((bot) => `${bot.id}:${bot.name}`).sort()).toEqual([
      "pixel:Pixel",
      "sage:Stored Sage",
    ]);
    // Only the config bots that survived resolve their tokens from the environment; the stored one
    // carries its own minted credential instead.
    expect(merged.fromConfig).toEqual(["pixel"]);
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

    await until(() => commands(runner.frames).length > 0);
    const command = commands(runner.frames)[0]!;
    expect(command).toMatchObject({
      command: "create_runtime",
      payload: {
        botId: "sage",
        specGeneration: 1,
        image: "ghcr.io/example/cozyagents@sha256:abc",
        resources: { cpus: 2, memoryMb: 2048 },
      },
    });
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

  it("projects configured model limits into the runner command", async () => {
    const h = await harness({
      spec: () => runtimeSpecDefaults({
        COZYGATEWAY_RUNNER_MODEL_ID: "m",
        COZYGATEWAY_RUNNER_MODEL_PROVIDER: "p",
        COZYGATEWAY_RUNNER_MODEL_CONTEXT_WINDOW: "131072",
        COZYGATEWAY_RUNNER_MODEL_MAX_TOKENS: "8192",
      }),
    });
    await createRuntimeBot(h);
    const runner = await fakeRunner(h);

    await until(() => commands(runner.frames).length > 0);
    expect(commands(runner.frames)[0]).toMatchObject({
      command: "create_runtime",
      payload: { model: { id: "m", provider: "p", contextWindow: 131072, maxTokens: 8192 } },
    });
    expect(h.logs.join("\n")).not.toContain("131072");
    expect(h.logs.join("\n")).not.toContain("8192");
  });

  it("projects a needs_attention receipt with its safe code", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const runner = await fakeRunner(h, { backends: ["process"] });
    await until(() => commands(runner.frames).length > 0);
    const payload = commands(runner.frames)[0]!.payload as { operationId: string };
    await receipt(runner.ws, h, payload.operationId, "needs_attention", { code: "image_unavailable" });
    await until(() => h.storage.runnerOperation(payload.operationId)?.stage === "needs_attention");
    expect(await projection(h, "sage")).toMatchObject({
      stage: "needs_attention",
      code: "image_unavailable",
    });
  });

  it("recovers a terminal runtime once by replaying its durable create spec", async () => {
    let allowSpecRead = true;
    const h = await harness({
      spec: () => {
        if (!allowSpecRead) throw new Error("recovery must not reread gateway defaults");
        return {
          image: "ghcr.io/example/cozyagents@sha256:abc",
          resources: { cpus: 2, memoryMb: 2048 },
          model: { id: "original", provider: "local", contextWindow: 131_072 },
        };
      },
    });
    await createRuntimeBot(h);
    const runner = await fakeRunner(h);
    await until(() => commands(runner.frames).length === 1);
    const original = commands(runner.frames)[0]!.payload as unknown as {
      operationId: string;
      attachToken: string;
      [key: string]: unknown;
    };
    await receipt(runner.ws, h, original.operationId, "needs_attention", {
      code: "restart_budget_exhausted",
    });
    const originalRow = h.storage.runnerOperation(original.operationId)!;
    const token = h.storage.runtimeBot("sage")!.token;
    allowSpecRead = false;
    // Wall clocks can move backwards after NTP/VM correction. The accepted retry is newer because
    // it was inserted later, even though its recorded time is deliberately older than the source.
    h.advance(-10_000);

    const accepted = await h.request("/bots/sage/runtime/recover", { method: "POST" });
    expect(accepted.status).toBe(202);
    const recovered = (await accepted.json()) as {
      operationId: string;
      runtime: BotRuntimeProjection;
    };
    expect(recovered.operationId).not.toBe(original.operationId);
    expect(recovered.runtime).toMatchObject({ stage: "waiting_for_runner", specGeneration: 1 });
    const refused = await h.request("/bots/sage/runtime/recover", { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "conflict" } });

    await until(() => commands(runner.frames).length === 2);
    const replayed = commands(runner.frames)[1]!.payload as unknown as {
      operationId: string;
      attachToken: string;
      [key: string]: unknown;
    };
    const replayedRow = h.storage.runnerOperation(recovered.operationId)!;
    expect(replayedRow.createdAt).toBeLessThan(originalRow.createdAt);
    expect(h.storage.latestRunnerOperationForBot("sage")?.operationId).toBe(recovered.operationId);
    // The operation id and injected attach token are deliberately fresh/live transport fields.
    // Every durable create field, including the original model ceiling, is replayed exactly.
    expect(replayedRow).toMatchObject({
      bot: "sage",
      kind: "create_runtime",
      specGeneration: originalRow.specGeneration,
      payload: originalRow.payload,
      runnerId: originalRow.runnerId,
    });
    expect(replayed).toMatchObject({
      ...original,
      operationId: recovered.operationId,
      attachToken: token,
    });
    expect(h.storage.runtimeBot("sage")!.token).toBe(token);
  });

  it("refuses recovery unless the current operation is terminal needs_attention", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const runner = await fakeRunner(h);
    await until(() => commands(runner.frames).length === 1);
    const operationId = (commands(runner.frames)[0]!.payload as { operationId: string }).operationId;

    expect((await h.request("/bots/sage/runtime/recover", { method: "POST" })).status).toBe(409);
    await receipt(runner.ws, h, operationId, "stopped");
    expect((await h.request("/bots/sage/runtime/recover", { method: "POST" })).status).toBe(409);
    expect((await h.request("/bots/missing/runtime/recover", { method: "POST" })).status).toBe(404);
    expect((await h.request("/bots/sage", { method: "DELETE" })).status).toBe(200);
    expect((await h.request("/bots/sage/runtime/recover", { method: "POST" })).status).toBe(404);
  });

  it("ignores a receipt for an operation it never issued", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const runner = await fakeRunner(h);
    await until(() => commands(runner.frames).length > 0);
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

  it("never walks a stage backwards and only observes a generation on ready", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const runner = await fakeRunner(h);
    await until(() => commands(runner.frames).length > 0);
    const payload = commands(runner.frames)[0]!.payload as { operationId: string };

    await receipt(runner.ws, h, payload.operationId, "starting");
    // An in-progress stage says what is being attempted, never what is running.
    expect((await projection(h, "sage")).observedGeneration).toBeNull();
    await receipt(runner.ws, h, payload.operationId, "ready");
    expect((await projection(h, "sage")).observedGeneration).toBe(1);

    // A retried or reordered earlier stage is recorded as contact and nothing else.
    runner.ws.send(
      JSON.stringify({
        kind: "receipt",
        operationId: payload.operationId,
        botId: "sage",
        specGeneration: 1,
        stage: "creating",
        at: NOW + 50,
      }),
    );
    await until(() => h.logs.some((line) => line.includes("stale creating receipt")));
    expect(await projection(h, "sage")).toMatchObject({ stage: "ready", lastRunnerContactAt: NOW + 50 });
    // A real transition out of the progression still lands.
    await receipt(runner.ws, h, payload.operationId, "needs_attention", { code: "readiness_lost" });
    expect((await projection(h, "sage")).stage).toBe("needs_attention");

    expect(regressesRunnerStage("ready", "creating")).toBe(true);
    expect(regressesRunnerStage("ready", "needs_attention")).toBe(false);
    expect(regressesRunnerStage("creating", "ready")).toBe(false);
  });

  it("accepts additive fields and ignores a frame kind it has never heard of", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    // A hello carrying fields this gateway does not know, plus an inventory entry that does the
    // same, must not close the socket.
    const runner = await fakeRunner(h, {
      extra: {
        hostArch: "arm64",
        inventory: [{ botId: "sage", specGeneration: 1, stage: "ready", imageDigest: "sha256:..." }],
      },
    });
    await until(() => commands(runner.frames).length > 0);
    const payload = commands(runner.frames)[0]!.payload as { operationId: string };

    runner.ws.send(JSON.stringify({ kind: "inventory_update", bots: [] }));
    await until(() => h.logs.some((line) => line.includes("unknown runner-v1 frame kind inventory_update")));
    expect(runner.ws.readyState).toBe(WebSocket.OPEN);

    // An additive field on a receipt is ignored, and the receipt still lands.
    await receipt(runner.ws, h, payload.operationId, "ready", { measuredIsolation: "docker" });
    expect((await projection(h, "sage")).stage).toBe("ready");
    expect(runner.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("resends an unreceipted operation to a reconnecting runner, and never a receipted one", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const first = await fakeRunner(h);
    await until(() => commands(first.frames).length > 0);
    const payload = commands(first.frames)[0]!.payload as { operationId: string };

    first.ws.close();
    await once(first.ws, "close");
    const second = await fakeRunner(h);
    await until(() => commands(second.frames).length > 0);
    expect((commands(second.frames)[0]!.payload as { operationId: string }).operationId).toBe(
      payload.operationId,
    );

    // Once it has been receipted, retry is the runner's job and the gateway stops resending it.
    await receipt(second.ws, h, payload.operationId, "creating");
    second.ws.close();
    await once(second.ws, "close");
    const third = await fakeRunner(h);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commands(third.frames)).toEqual([]);
  });

  it("supersedes a first runner when a second one attaches", async () => {
    const h = await harness();
    const first = await fakeRunner(h);
    const closed = once(first.ws, "close");
    await fakeRunner(h);
    const [code] = (await closed) as [number];
    expect(code).toBe(4000);
  });

  it("terminates a runner that goes silent past the heartbeat ceiling", async () => {
    const h = await harness({ heartbeatIntervalMs: 15, heartbeatTimeoutMs: 40 });
    const runner = await fakeRunner(h);
    const closed = once(runner.ws, "close");
    h.advance(1_000);
    await closed;
    expect(h.logs.some((line) => line.includes("silent past the heartbeat ceiling"))).toBe(true);
    await until(() => !h.lane.connected());
  });

  it("drops a create for a bot deleted before the operation could be sent", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    expect((await h.request("/bots/sage", { method: "DELETE" })).status).toBe(200);

    const runner = await fakeRunner(h);
    await until(() => commands(runner.frames).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commands(runner.frames).map((frame) => frame.command)).toEqual(["delete_runtime"]);
    expect(h.logs.some((line) => line.includes("no longer exists"))).toBe(true);
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
  it("revokes the credential, purges the rows, and keeps the cleanup watchable until deleted", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const runner = await fakeRunner(h);
    await until(() => commands(runner.frames).length > 0);
    const token = h.storage.runtimeBot("sage")!.token;

    const response = await h.request("/bots/sage", { method: "DELETE" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as BotDeleteResponse;
    expect(body).toMatchObject({ name: "sage", hermesProfile: "already_absent", tokenRevoked: true });

    expect(resolveAttachBearer(h.attachTokens, `Bearer ${token}`)).toBeUndefined();
    expect(h.storage.runtimeBot("sage")).toBeUndefined();
    await until(() => commands(runner.frames).some((frame) => frame.command === "delete_runtime"));
    const deleteCommand = commands(runner.frames).find((frame) => frame.command === "delete_runtime")!;
    expect(deleteCommand.payload).toMatchObject({ botId: "sage", specGeneration: 1 });
    expect(JSON.stringify(deleteCommand)).not.toContain(token);

    const roster = (await (await h.request("/bots")).json()) as { bots: Array<{ name: string }> };
    expect(roster.bots.map((bot) => bot.name)).not.toContain("sage");

    // The bot is gone, and the cleanup it left behind is still readable.
    expect((await projection(h, "sage")).stage).toBe("deletion_pending");
    const operationId = (deleteCommand.payload as { operationId: string }).operationId;
    await receipt(runner.ws, h, operationId, "deleting");
    expect((await projection(h, "sage")).stage).toBe("deleting");
    await receipt(runner.ws, h, operationId, "deleted");
    // Terminal: nothing is left to project, so the route stops answering for the name.
    expect((await h.request("/bots/sage/runtime")).status).toBe(404);
  });

  it("refuses a bot with a turn in flight unless force is set, and never a reserved name", async () => {
    const h = await harness();
    await createRuntimeBot(h);
    const chat = h.storage.nativeBotChat("sage", NOW);
    h.storage.setNativeBotTurn("sage", chat.sessionId, "turn-1", NOW);

    const refused = await h.request("/bots/sage", { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("turn-1");
    expect(h.storage.runtimeBot("sage")).toBeDefined();

    expect((await h.request("/bots/sage?force=1", { method: "DELETE" })).status).toBe(200);
    expect(h.storage.runtimeBot("sage")).toBeUndefined();

    // A reserved name can never reach a runtime delete through the route (it cannot be created in
    // the first place), so the refusal is pinned where it lives.
    expect(() => h.service.delete("default")).toThrow(/reserved/);
  });

  it("answers 409 for a bot that has no gateway-owned runtime", async () => {
    const h = await harness();
    expect((await h.request("/bots/scout/runtime")).status).toBe(409);
  });
});

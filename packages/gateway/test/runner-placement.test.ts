import { createServer } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { WebSocket } from "ws";
import { check } from "cozygateway-contract";
import type {
  BotCreateResponse,
  BotRuntimeProjection,
  BotSummary,
  RunnerChoiceRequiredBody,
} from "cozygateway-contract";
import { RunnerChoiceRequiredBodySchema } from "cozygateway-contract";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { revokeAttachTokens } from "../src/adapters/attach/token-auth.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";
import { RunnerLane } from "../src/runner/lane.ts";
import {
  LEGACY_RUNNER_ID,
  LEGACY_RUNNER_NAME,
  RunnerRoster,
  createRunnerResolver,
} from "../src/runner/roster.ts";
import { RuntimeBotService } from "../src/runner/runtime-bots.ts";
import type { RunnerServerFrame } from "../src/runner/protocol.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/** Capability 54. A create picks the computer it runs on, and every operation for that bot goes to
 *  that computer and to no other. What a person feels is that the bot they made on the laptop is on
 *  the laptop, that deleting it cleans up there rather than on the desktop, and that a gateway with
 *  no computer at all says so in a sentence they can act on instead of accepting a bot nothing can
 *  ever run.
 *
 *  The assembly is real: real storage, a real roster, a real lane over one http server, the real
 *  create route. Only Hermes is a stub, because a runtime create never reaches it. */

const NOW = 1_800_000_000_000;
const LEGACY_TOKEN = "legacy-shared-secret";

interface Harness {
  storage: Storage;
  roster: RunnerRoster;
  lane: RunnerLane;
  plane: NativeBotDataPlane;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  port: number;
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function harness(opts: { legacyToken?: string; placement?: boolean } = {}): Promise<Harness> {
  const storage = openStorage(":memory:");
  const attachTokens = new Map<string, string>();
  const roster = new RunnerRoster({ storage, now: () => NOW });
  const ingress = new AttachV1Ingress({
    tokens: attachTokens,
    storage,
    events: { onEvent: () => true, onPresence: () => undefined },
    now: () => NOW,
  });
  const lane = new RunnerLane({
    ...(opts.legacyToken === undefined ? {} : { token: opts.legacyToken }),
    roster,
    storage,
    attachTokenFor: (botId) => storage.runtimeBot(botId)?.token,
    now: () => NOW,
    log: () => {},
  });
  const control = {
    roster: () => ({ bots: [], updatedAt: NOW, stale: false }),
    refreshSoon: () => {},
    createBot: () => Promise.reject(new Error("a runtime create must never reach Hermes")),
    deleteBot: () => Promise.reject(new Error("a runtime delete must never reach Hermes")),
  } as unknown as BotsSurface;
  let service: RuntimeBotService | undefined;
  const runnerName = (id: string): string | undefined =>
    roster.get(id)?.name
    ?? (id === LEGACY_RUNNER_ID && opts.legacyToken !== undefined ? LEGACY_RUNNER_NAME : undefined);
  const plane = new NativeBotDataPlane({
    control,
    storage,
    ingress,
    nativeBots: [],
    chatSuggestion: "",
    broadcast: () => {},
    now: () => NOW,
    runnerName,
    runtimeLifecycle: {
      owns: (id) => service?.owns(id) === true,
      hasRuntime: (id) => service?.hasRuntime(id) === true,
      create: (input, row) => service!.create(input, row),
      delete: (name, deleteOpts) => service!.delete(name, deleteOpts),
      projection: (name) => service!.projection(name),
    },
  });
  service = new RuntimeBotService({
    storage,
    lane,
    spec: () => ({ image: "ghcr.io/example/cozyagents@sha256:abc" }),
    now: () => NOW,
    log: () => {},
    runnerName,
    // A harness without placement is a pre-54 gateway: no resolver, so no create records a runner.
    ...(opts.placement === false
      ? {}
      : {
          resolveRunner: createRunnerResolver({
            roster,
            legacyConfigured: () => opts.legacyToken !== undefined,
          }),
        }),
    register: (bot) => {
      attachTokens.set(bot.token, bot.id);
      plane.addRuntimeBot({
        id: bot.id,
        name: bot.name,
        avatar: bot.avatar,
        runtime: bot.runtime,
        ...(bot.runnerId === undefined || bot.runnerId === null ? {} : { runnerId: bot.runnerId }),
      });
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
  const built: Harness = {
    storage,
    roster,
    lane,
    plane,
    request: async (path, init) => app.request(path, init),
    port: typeof address === "object" && address !== null ? address.port : 0,
    close: async () => {
      lane.close();
      ingress.close();
      plane.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      storage.close();
    },
  };
  harnesses.push(built);
  return built;
}

interface Runner {
  ws: WebSocket;
  frames: RunnerServerFrame[];
}

async function connect(h: Harness, token: string, runnerId: string): Promise<Runner> {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/runner/v1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  sockets.push(ws);
  const frames: RunnerServerFrame[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as RunnerServerFrame));
  await once(ws, "open");
  ws.send(JSON.stringify({ kind: "hello", version: 1, runnerId, backends: ["docker"] }));
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

function commands(runner: Runner): Array<Extract<RunnerServerFrame, { kind: "command" }>> {
  return runner.frames.filter((frame) => frame.kind === "command") as Array<
    Extract<RunnerServerFrame, { kind: "command" }>
  >;
}

async function create(
  h: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await h.request("/bots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runtime: "cozyagents", ...body }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Three pairs, the default moved to the first, then the first revoked: two rows, neither flagged,
 *  which is the ambiguity a single account really reaches when it takes its old laptop away. */
function twoRunnersWithNoDefault(h: Harness): Array<{ id: string; name: string; token: string }> {
  const first = h.roster.pair({ name: "old-laptop" });
  const second = h.roster.pair({ name: "kyle-mbp" });
  const third = h.roster.pair({ name: "studio" });
  h.roster.setDefault(first.runner.id);
  h.roster.remove(first.runner.id);
  expect(h.roster.defaultRunner()).toBeUndefined();
  return [second, third].map((paired) => ({
    id: paired.runner.id,
    name: paired.runner.name,
    token: paired.token,
  }));
}

describe("a create picks a computer", () => {
  it("picks the only paired runner when the request names none", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" });

    const created = await create(h, { name: "sage" });
    expect(created.status).toBe(201);
    expect((created.body as { bot: BotSummary }).bot).toMatchObject({
      name: "sage",
      runtime: "cozyagents",
      runnerId: paired.runner.id,
      runnerName: "kyle-mbp",
    });
    // The choice is durable on both rows, which is what makes a later delete or upgrade land on the
    // same machine rather than on whichever socket happens to be attached.
    expect(h.storage.runtimeBot("sage")?.runnerId).toBe(paired.runner.id);
    expect(h.storage.latestRunnerOperationForBot("sage")?.runnerId).toBe(paired.runner.id);
  });

  it("picks the account default when there are several", async () => {
    const h = await harness();
    h.roster.pair({ name: "old-laptop" });
    const chosen = h.roster.pair({ name: "studio" });
    h.roster.setDefault(chosen.runner.id);

    const created = await create(h, { name: "sage" });
    expect(created.status).toBe(201);
    expect(h.storage.runtimeBot("sage")?.runnerId).toBe(chosen.runner.id);
  });

  it("answers 409 no_runner_paired when the account has no computer at all", async () => {
    const h = await harness();
    const created = await create(h, { name: "sage" });
    expect(created.status).toBe(409);
    expect(created.body).toMatchObject({ error: { code: "no_runner_paired" } });
    expect(String((created.body as { error: { message: string } }).error.message)).toContain("computer");
    // Nothing was written: a bot no computer can ever run is not a bot.
    expect(h.storage.runtimeBot("sage")).toBeUndefined();
    expect(h.storage.unsentRunnerOperations()).toEqual([]);
  });

  it("answers 409 runner_choice_required, naming the candidates, when several and none is default", async () => {
    const h = await harness();
    const [second, third] = twoRunnersWithNoDefault(h);

    const created = await create(h, { name: "sage" });
    expect(created.status).toBe(409);
    expect(created.body).toMatchObject({ error: { code: "runner_choice_required" } });
    const message = (created.body as { error: { message: string } }).error.message;
    // The app shows a chooser, so the sentence has to carry what there is to choose between.
    expect(message).toContain(second!.name);
    expect(message).toContain(third!.name);
    // And the body has to carry the ids, because a name is not what a follow-up create sends. The
    // published schema against the real bytes, so a drift fails here rather than on a phone.
    expect(check(RunnerChoiceRequiredBodySchema, created.body)).toBe(true);
    expect((created.body as RunnerChoiceRequiredBody).runners).toEqual([
      { id: second!.id, name: second!.name, isDefault: false },
      { id: third!.id, name: third!.name, isDefault: false },
    ]);
    expect(h.storage.runtimeBot("sage")).toBeUndefined();

    // Naming one of them is all it takes.
    const named = await create(h, { name: "sage", runnerId: third!.id });
    expect(named.status).toBe(201);
    expect(h.storage.runtimeBot("sage")?.runnerId).toBe(third!.id);
  });

  it("answers 400 naming runnerId when the request names a computer this gateway does not have", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" });
    const created = await create(h, { name: "sage", runnerId: "no-such-runner" });
    expect(created.status).toBe(400);
    expect(created.body).toMatchObject({ error: { code: "invalid_request" } });
    expect((created.body as { error: { message: string } }).error.message).toContain("runnerId");
    expect(h.storage.runtimeBot("sage")).toBeUndefined();

    // A revoked runner is the same client bug rather than a fallback to the survivor.
    const revoked = h.roster.pair({ name: "gone" });
    h.roster.remove(revoked.runner.id);
    const stale = await create(h, { name: "luna", runnerId: revoked.runner.id });
    expect(stale.status).toBe(400);
    expect(h.storage.runtimeBot("luna")).toBeUndefined();
    expect(h.roster.get(paired.runner.id)).toBeDefined();
  });

  it("accepts a pre-54 create body unchanged and answers a byte-compatible row", async () => {
    // A gateway with no roster resolver at all is the pre-54 build; its create body and its
    // response are the baseline every client below 54 already reads.
    const before = await harness({ legacyToken: LEGACY_TOKEN, placement: false });
    const baseline = await create(before, { name: "sage" });
    expect(baseline.status).toBe(201);
    const baselineBot = (baseline.body as { bot: Record<string, unknown> }).bot;
    expect(baselineBot["runnerId"]).toBeUndefined();
    expect(baselineBot["runnerName"]).toBeUndefined();

    const after = await harness();
    after.roster.pair({ name: "kyle-mbp" });
    const created = await create(after, { name: "sage" });
    expect(created.status).toBe(201);
    const bot = (created.body as { bot: Record<string, unknown> }).bot;
    // Every key a client below 54 reads carries exactly the value it carried, and the two new ones
    // are additive beside them.
    for (const [key, value] of Object.entries(baselineBot)) {
      // The canonical chat id is a fresh uuid per gateway, so its SHAPE is the invariant, not its
      // bytes.
      if (key === "chatSessionId") {
        expect(String(bot[key]).startsWith("native:sage:")).toBe(true);
        continue;
      }
      expect(bot[key]).toEqual(value);
    }
    expect(Object.keys(bot).filter((key) => !(key in baselineBot)).sort()).toEqual([
      "runnerId",
      "runnerName",
    ]);
  });

  it("carries the computer on the roster row and the runtime projection, and never backfills", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" });
    await create(h, { name: "sage" });

    const roster = (await (await h.request("/bots")).json()) as { bots: BotSummary[] };
    expect(roster.bots.find((row) => row.name === "sage")).toMatchObject({
      runnerId: paired.runner.id,
      runnerName: "kyle-mbp",
    });
    const projection = (await (await h.request("/bots/sage/runtime")).json()) as BotRuntimeProjection;
    expect(projection).toMatchObject({ runnerId: paired.runner.id, runnerName: "kyle-mbp" });

    // A bot written before 54 names nobody, and nothing invents one for it.
    h.storage.insertRuntimeBot({
      id: "luna", name: "luna", avatar: null, token: "t".repeat(64),
      runtime: "cozyagents", specGeneration: 1, createdAt: NOW,
    });
    expect(h.storage.runtimeBot("luna")?.runnerId).toBeNull();
    h.plane.addRuntimeBot({ id: "luna", name: "luna", avatar: null, runtime: "cozyagents" });
    const withOld = (await (await h.request("/bots")).json()) as { bots: Array<Record<string, unknown>> };
    const old = withOld.bots.find((row) => row["name"] === "luna")!;
    expect("runnerId" in old).toBe(false);
    expect("runnerName" in old).toBe(false);

    // A revoked computer leaves the id it was given standing with no name to render.
    h.roster.remove(paired.runner.id);
    const orphaned = (await (await h.request("/bots/sage/runtime")).json()) as Record<string, unknown>;
    expect(orphaned["runnerId"]).toBe(paired.runner.id);
    expect("runnerName" in orphaned).toBe(false);
  });
});

describe("a revoked computer", () => {
  it("addresses a later delete to nobody rather than to a runner that can never collect it", async () => {
    const h = await harness();
    const gone = h.roster.pair({ name: "gone" });
    const survivor = h.roster.pair({ name: "kyle-mbp" });
    expect((await create(h, { name: "sage", runnerId: gone.runner.id })).status).toBe(201);
    h.roster.remove(gone.runner.id);
    h.roster.setDefault(survivor.runner.id);

    // The bot's row still names the machine it was placed on: revoking a computer is not a
    // rewrite of history. Its CLEANUP, though, has to be collectable by somebody.
    expect((await h.request("/bots/sage", { method: "DELETE" })).status).toBe(200);
    expect(h.storage.latestRunnerOperationForBot("sage")).toMatchObject({
      kind: "delete_runtime",
      runnerId: null,
    });
    const runner = await connect(h, survivor.token, survivor.runner.id);
    await until(() => commands(runner).length === 1);
    expect(commands(runner)[0]).toMatchObject({ command: "delete_runtime", payload: { botId: "sage" } });
  });
});

describe("the per-runner operation queue", () => {
  it("hands a create only to the runner it names, and never to the other", async () => {
    const h = await harness();
    const mine = h.roster.pair({ name: "kyle-mbp" });
    const theirs = h.roster.pair({ name: "studio" });
    const runnerOne = await connect(h, mine.token, mine.runner.id);
    const runnerTwo = await connect(h, theirs.token, theirs.runner.id);

    expect((await create(h, { name: "sage", runnerId: theirs.runner.id })).status).toBe(201);
    await until(() => commands(runnerTwo).length === 1);
    expect(commands(runnerTwo)[0]).toMatchObject({ command: "create_runtime", payload: { botId: "sage" } });
    expect(commands(runnerOne)).toEqual([]);

    // The delete follows the create to the same machine: the containers and volumes are there.
    expect((await h.request("/bots/sage", { method: "DELETE" })).status).toBe(200);
    await until(() => commands(runnerTwo).length === 2);
    expect(commands(runnerTwo)[1]).toMatchObject({ command: "delete_runtime", payload: { botId: "sage" } });
    expect(commands(runnerOne)).toEqual([]);
  });

  it("holds an operation for a runner that is not connected rather than giving it to one that is", async () => {
    const h = await harness();
    const here = h.roster.pair({ name: "kyle-mbp" });
    const away = h.roster.pair({ name: "studio" });
    const connected = await connect(h, here.token, here.runner.id);

    expect((await create(h, { name: "sage", runnerId: away.runner.id })).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commands(connected)).toEqual([]);
    expect(h.storage.unsentRunnerOperations()).toHaveLength(1);

    // It reconciles the moment that machine dials in, exactly as an offline create always has.
    const late = await connect(h, away.token, away.runner.id);
    await until(() => commands(late).length === 1);
    expect(commands(late)[0]).toMatchObject({ payload: { botId: "sage" } });
    expect(commands(connected)).toEqual([]);
  });

  it("sends a row written before 54 to the account default, and to nothing without one", async () => {
    const h = await harness();
    const [second, third] = twoRunnersWithNoDefault(h);
    // Exactly the row a pre-54 gateway left behind: a bot and an operation naming no runner.
    h.storage.insertRuntimeBot({
      id: "sage", name: "sage", avatar: null, token: "t".repeat(64),
      runtime: "cozyagents", specGeneration: 1, createdAt: NOW,
    });
    h.storage.enqueueRunnerOperation({
      operationId: "op_legacy", bot: "sage", kind: "create_runtime",
      specGeneration: 1, payload: {}, at: NOW,
    });

    const one = await connect(h, second!.token, second!.id);
    const two = await connect(h, third!.token, third!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // No default: an unaddressed row waits rather than being handed to an arbitrary machine.
    expect(commands(one)).toEqual([]);
    expect(commands(two)).toEqual([]);

    h.roster.setDefault(third!.id);
    h.lane.dispatchPending();
    await until(() => commands(two).length === 1);
    expect(commands(two)[0]).toMatchObject({ payload: { botId: "sage", operationId: "op_legacy" } });
    expect(commands(one)).toEqual([]);
  });

  it("never re-sends one runner's in-flight operation because another runner reconnected", async () => {
    const h = await harness();
    const idle = h.roster.pair({ name: "kyle-mbp" });
    const busy = h.roster.pair({ name: "studio" });
    const idleRunner = await connect(h, idle.token, idle.runner.id);
    let busyRunner = await connect(h, busy.token, busy.runner.id);

    expect((await create(h, { name: "sage", runnerId: busy.runner.id })).status).toBe(201);
    await until(() => commands(busyRunner).length === 1);

    // The other machine, which has nothing to do with that bot, drops and comes back. Its hello
    // rewinds ITS own unreceipted work and nobody else's.
    idleRunner.ws.close();
    await until(() => h.lane.connectedRunners().length === 1);
    const reconnected = await connect(h, idle.token, idle.runner.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commands(busyRunner)).toHaveLength(1);
    expect(commands(reconnected)).toEqual([]);
    expect(h.storage.runnerOperation(commands(busyRunner)[0]!.payload.operationId)?.sentAt).not.toBeNull();

    // The runner that actually owns the operation still gets it again on ITS own reconnect, which
    // is the resume rule capability 49 defined and 54 did not change.
    busyRunner.ws.close();
    await until(() => h.lane.connectedRunners().length === 1);
    busyRunner = await connect(h, busy.token, busy.runner.id);
    await until(() => commands(busyRunner).length === 1);
    expect(commands(busyRunner)[0]).toMatchObject({ payload: { botId: "sage" } });
  });

  it("keeps a legacy single-runner deployment moving with no migration step", async () => {
    // No paired rows at all, one operator-placed shared credential: the create resolves to it, and
    // the rows a pre-54 build wrote go to the same socket.
    const h = await harness({ legacyToken: LEGACY_TOKEN });
    const legacy = await connect(h, LEGACY_TOKEN, "runner-1");
    h.storage.insertRuntimeBot({
      id: "luna", name: "luna", avatar: null, token: "t".repeat(64),
      runtime: "cozyagents", specGeneration: 1, createdAt: NOW,
    });
    h.storage.enqueueRunnerOperation({
      operationId: "op_legacy", bot: "luna", kind: "create_runtime",
      specGeneration: 1, payload: {}, at: NOW,
    });
    h.lane.dispatchPending();
    await until(() => commands(legacy).length === 1);

    expect((await create(h, { name: "sage" })).status).toBe(201);
    expect(h.storage.runtimeBot("sage")?.runnerId).toBe(LEGACY_RUNNER_ID);
    await until(() => commands(legacy).length === 2);
    expect(commands(legacy).map((frame) => frame.payload.botId).sort()).toEqual(["luna", "sage"]);
  });
});

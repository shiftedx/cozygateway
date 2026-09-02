import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRoutine } from "cozygateway-contract";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1ConfigRequest, AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import { AttachConfigSurface } from "../src/hermes-bridge/bot-config.ts";
import { NativeBotDataPlane, type RunRoutineSurface } from "../src/hermes-bridge/native-data-plane.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";
import { RoutineNotFound } from "../src/hermes-bridge/routines.ts";
import { BackendUnavailable, UnsupportedForRuntime } from "../src/errors.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";

const routine: BotRoutine = {
  id: "job-1",
  title: "Morning brief",
  schedule: { raw: "0 9 * * *", human: "Daily" },
  enabled: true,
  lastRun: null,
  nextRun: null,
};

describe("POST /bots/:name/routines/:id/run, over an attached peer", () => {
  let server: Server;
  let port: number;
  let storage: Storage;
  let ingress: AttachV1Ingress;
  let config: AttachConfigSurface;
  let plane: NativeBotDataPlane;

  const sage = { id: "sage", name: "Sage", avatar: null, runtime: "cozyagents" } as const;

  beforeEach(async () => {
    storage = openStorage(":memory:");
    ingress = new AttachV1Ingress({
      tokens: new Map([["secret", "sage"]]),
      storage,
      events: {
        onEvent: () => true,
        onPresence: () => undefined,
        onConfigResult: (agentId, frame) => {
          config.handle(agentId, frame);
        },
      },
    });
    config = new AttachConfigSurface(ingress);
    plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {} as never,
      nativeBots: ["sage"],
      runtimeBots: [sage],
      chatSuggestion: "",
      broadcast: () => undefined,
      botConfig: config,
    });
    server = createServer();
    server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    plane.close();
    config.close();
    ingress.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  });

  /** A peer that answers every `config_request` with the reply the table names for its operation,
   *  falling back to `not_found` so an unlisted id reads as a routine this bot's namespace does
   *  not have. */
  async function dial(
    replies: Partial<Record<AttachV1ConfigRequest["operation"], unknown>>,
  ): Promise<{ ws: WebSocket; requests: AttachV1ConfigRequest[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, {
      headers: { authorization: "Bearer secret" },
    });
    const requests: AttachV1ConfigRequest[] = [];
    let acked = false;
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as AttachV1ServerFrame;
      if (frame.kind === "hello_ack") { acked = true; return; }
      if (frame.kind !== "config_request") return;
      requests.push(frame);
      const result = replies[frame.operation];
      ws.send(JSON.stringify(
        result === undefined
          ? { kind: "config_result", requestId: frame.requestId, status: "not_found", message: "no such routine" }
          : { kind: "config_result", requestId: frame.requestId, status: "ok", result },
      ));
    });
    await once(ws, "open");
    ws.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "peer", capabilities: ["bot_config"],
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => acked);
    return { ws, requests };
  }

  it("reaches the peer as routines.run and answers with the routine and when the ack landed", async () => {
    const peer = await dial({
      "routines.run": { ok: true },
      "routines.list": { name: "sage", routines: [routine], updatedAt: 5 },
    });
    const app = appFor(plane.runRoutineSurface());

    const before = Date.now();
    const response = await app.request("/bots/SAGE/routines/job-1/run", { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ routine });
    expect(typeof (body as { startedAt: unknown }).startedAt).toBe("number");
    expect((body as { startedAt: number }).startedAt).toBeGreaterThanOrEqual(before);

    expect(peer.requests.map((r) => r.operation)).toEqual(["routines.run", "routines.list"]);
    expect(peer.requests[0]).toMatchObject({ input: { id: "job-1" } });
    peer.ws.close();
  });

  it("answers 404 for a routine id this bot's namespace does not have", async () => {
    await dial({});
    const app = appFor(plane.runRoutineSurface());
    const response = await app.request("/bots/sage/routines/unknown-id/run", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers 503 when the peer is offline", async () => {
    // No peer dials in. The gateway knows the bot but has no live socket to send routines.run on.
    const app = appFor(plane.runRoutineSurface());
    const response = await app.request("/bots/sage/routines/job-1/run", { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "backend_unavailable" } });
  });
});

describe("POST /bots/:name/routines/:id/run, routing rules", () => {
  it("answers 409 unsupported_for_runtime for a Hermes bot", async () => {
    const run = vi.fn(async () => {
      throw new UnsupportedForRuntime("cleo", "routinesRun", "hermes");
    });
    const app = appFor({ run });
    const response = await app.request("/bots/cleo/routines/job-1/run", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_for_runtime" }, runtime: "hermes", feature: "routinesRun",
    });
  });

  it("answers 503 when the peer is offline, mapped from BackendUnavailable", async () => {
    const run = vi.fn(async () => {
      throw new BackendUnavailable("this bot's peer is not attached right now");
    });
    const app = appFor({ run });
    const response = await app.request("/bots/sage/routines/job-1/run", { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "backend_unavailable" } });
  });

  it("answers 404 for an unknown routine id, mapped from RoutineNotFound", async () => {
    const run = vi.fn(async () => {
      throw new RoutineNotFound("nope");
    });
    const app = appFor({ run });
    const response = await app.request("/bots/sage/routines/nope/run", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("calls the surface with the normalized bot name and the routine id", async () => {
    const run = vi.fn(async () => ({ routine, startedAt: 1 }));
    const app = appFor({ run });
    await app.request("/bots/SAGE/routines/job-1/run", { method: "POST" });
    expect(run).toHaveBeenCalledWith("sage", "job-1");
  });

  it("registers nothing at all when no config lane is wired, so the route answers 404", async () => {
    const app = new Hono<Env>();
    const requireDevice: MiddlewareHandler<Env> = async (c, next) => { c.set("deviceId", "d"); await next(); };
    registerBotRoutes(app, requireDevice, {} as BotsSurface, {}, {}, undefined, {}, undefined, undefined);
    const response = await app.request("/bots/sage/routines/job-1/run", { method: "POST" });
    expect(response.status).toBe(404);
  });
});

type Env = { Variables: { deviceId: string } };

function appFor(runRoutine: RunRoutineSurface | undefined) {
  const app = new Hono<Env>();
  const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
    c.set("deviceId", "device");
    await next();
  };
  registerBotRoutes(app, requireDevice, {} as BotsSurface, {}, {}, undefined, {}, undefined, runRoutine);
  return app;
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

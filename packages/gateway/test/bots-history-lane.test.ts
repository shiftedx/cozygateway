import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotHistoryCheckpoint } from "cozygateway-contract";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1HistoryRequest, AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import {
  AttachHistorySurface,
  HistoryConflict,
  HistoryInvalidRequest,
  HistoryNotFound,
  HistoryNotNegotiated,
  createHistoryRateLimiter,
  type HistorySurface,
} from "../src/hermes-bridge/bot-history.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";
import { BotNotFound } from "../src/hermes-bridge/crud.ts";
import { BackendUnavailable, UnsupportedForRuntime } from "../src/errors.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";

const checkpoint: BotHistoryCheckpoint = {
  id: "c1",
  at: 1_700_000_000_000,
  summary: "Add the sign-in page",
  checks: "passed",
  turnId: "turn-1",
  messageId: "msg-1",
  epoch: 7,
};

/** The reply each operation gets in the round-trip test. Every one of the seven is named, so a
 *  later operation added without an answer here fails loudly instead of falling through. */
const REPLIES: Record<AttachV1HistoryRequest["operation"], unknown> = {
  list: { checkpoints: [checkpoint] },
  diff: { files: [{ path: "src/app.ts", added: 12, removed: 3, status: "modified" }] },
  restore: { checkpoint: "c9", restoredFrom: "c1" },
  "try.start": { tryId: "try-1", base: "c1" },
  "try.keep": { merged: true },
  "try.discard": { kept: false },
  resolve: { merged: true },
};

describe("attach-v1 history lane", () => {
  let server: Server;
  let port: number;
  let storage: Storage;
  let ingress: AttachV1Ingress;
  let history: AttachHistorySurface;

  beforeEach(async () => {
    storage = openStorage(":memory:");
    ingress = new AttachV1Ingress({
      tokens: new Map([["secret", "sage"]]),
      storage,
      events: {
        onEvent: () => true,
        onPresence: () => undefined,
        onHistoryResult: (agentId, frame) => {
          history.handle(agentId, frame);
        },
      },
    });
    history = new AttachHistorySurface(ingress);
    server = createServer();
    server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    history.close();
    ingress.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  });

  /** A peer that answers every `history_request` with whatever the responder returns for it. */
  async function dial(
    reply: (request: AttachV1HistoryRequest) => Record<string, unknown>,
    capabilities: string[] = ["bot_history"],
  ): Promise<{ ws: WebSocket; requests: AttachV1HistoryRequest[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, {
      headers: { authorization: "Bearer secret" },
    });
    const requests: AttachV1HistoryRequest[] = [];
    let acked = false;
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as AttachV1ServerFrame;
      if (frame.kind === "hello_ack") { acked = true; return; }
      if (frame.kind !== "history_request") return;
      requests.push(frame);
      ws.send(JSON.stringify({ kind: "history_result", requestId: frame.requestId, ...reply(frame) }));
    });
    await once(ws, "open");
    ws.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "peer", capabilities,
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => acked);
    return { ws, requests };
  }

  it("round-trips every history operation through an attached peer", async () => {
    const peer = await dial((request) => ({ status: "ok", result: REPLIES[request.operation] }));

    await expect(history.list("sage", { since: 5, limit: 10 })).resolves.toEqual({ checkpoints: [checkpoint] });
    await expect(history.diff("sage", "c1")).resolves.toEqual({
      files: [{ path: "src/app.ts", added: 12, removed: 3, status: "modified" }],
    });
    await expect(history.restore("sage", "c1")).resolves.toEqual({ checkpoint: "c9", restoredFrom: "c1" });
    await expect(history.tryStart("sage", "darker theme")).resolves.toEqual({ tryId: "try-1", base: "c1" });
    await expect(history.tryKeep("sage")).resolves.toEqual({ merged: true });
    await expect(history.tryDiscard("sage")).resolves.toEqual({ kept: false });
    await expect(history.resolve("sage", [{ path: "src/app.ts", pick: "ours" }])).resolves.toEqual({ merged: true });

    expect(peer.requests.map((request) => request.operation)).toEqual([
      "list", "diff", "restore", "try.start", "try.keep", "try.discard", "resolve",
    ]);
    // The bounds and the choices reach the peer as sent; a `diff` with no `to` omits the key
    // rather than sending an explicit undefined the peer's closed schema would refuse.
    expect(peer.requests[0]?.input).toEqual({ since: 5, limit: 10 });
    expect(peer.requests[1]?.input).toEqual({ from: "c1" });
    expect(peer.requests[6]?.input).toEqual({ choices: [{ path: "src/app.ts", pick: "ours" }] });
    // The lane is live only: nothing it carried becomes a durable command or event.
    expect(storage.attachCommandCursor("sage")).toBe(0);
    expect(storage.attachEventCursor("sage")).toBe(0);
    peer.ws.close();
  });

  it("carries the per-file choices on a conflict rather than reporting a failure", async () => {
    const conflicts = [
      { path: "src/app.ts", ours: "Sage's version", theirs: "the other change" },
      { path: "README.md", ours: "Sage rewrote the intro", theirs: "you edited the intro" },
    ];
    const peer = await dial(() => ({
      status: "conflict",
      result: { merged: false, conflicts },
      message: "the working version changed while this was being tried",
    }));
    const pending = history.tryKeep("sage");
    await expect(pending).rejects.toBeInstanceOf(HistoryConflict);
    await expect(pending).rejects.toMatchObject({ conflicts });
    peer.ws.close();
  });

  // A per-file choice with no files is a dialog with no buttons, so it is refused rather than
  // shown: the peer said the work is intact but named nothing to choose between.
  it("refuses a conflict that names no files", async () => {
    const peer = await dial(() => ({ status: "conflict", result: { merged: false } }));
    await expect(history.tryKeep("sage")).rejects.toThrow("without saying which files");
    peer.ws.close();
  });

  it("separates a checkpoint that is not there from an offline peer", async () => {
    const sent: AttachV1HistoryRequest[] = [];
    const surface = new AttachHistorySurface({
      sendHistoryRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = surface.restore("sage", "c404");
    surface.handle("sage", { kind: "history_result", requestId: sent[0]!.requestId, status: "not_found" });
    await expect(pending).rejects.toBeInstanceOf(HistoryNotFound);
    // `BotNotFound` is the class the bots routes answer 404 `not_found` on.
    await expect(pending).rejects.toBeInstanceOf(BotNotFound);
    await expect(pending).rejects.toThrow("no such checkpoint to go back to");
    surface.close();
  });

  // An empty history is an empty list, not an absence: a bot that has simply not changed anything
  // yet must not answer 404 and hide the whole surface.
  it("keeps a refused list on backend_unavailable", async () => {
    const sent: AttachV1HistoryRequest[] = [];
    const surface = new AttachHistorySurface({
      sendHistoryRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = surface.list("sage", {});
    surface.handle("sage", { kind: "history_result", requestId: sent[0]!.requestId, status: "not_found" });
    await expect(pending).rejects.toBeInstanceOf(BackendUnavailable);
    surface.close();
  });

  it("reports a refused resolve as invalid input in the peer's own words", async () => {
    const sent: AttachV1HistoryRequest[] = [];
    const surface = new AttachHistorySurface({
      sendHistoryRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = surface.resolve("sage", [{ path: "nope.ts", pick: "ours" }]);
    surface.handle("sage", {
      kind: "history_result", requestId: sent[0]!.requestId, status: "invalid_request",
      message: "\"nope.ts\" is not one of the files waiting on a choice",
    });
    await expect(pending).rejects.toBeInstanceOf(HistoryInvalidRequest);
    await expect(pending).rejects.toThrow("waiting on a choice");
    surface.close();
  });

  it("maps a silent peer to unavailable instead of waiting forever", async () => {
    const surface = new AttachHistorySurface({ sendHistoryRequest: () => "sent" }, 1);
    const pending = surface.list("sage", {});
    await expect(pending).rejects.toBeInstanceOf(BackendUnavailable);
    await expect(pending).rejects.toThrow("bot history reply timed out");
    surface.close();
  });

  it("separates a peer that never negotiated bot_history from one that is offline", async () => {
    const notNegotiated = new AttachHistorySurface({ sendHistoryRequest: () => "capability_not_negotiated" });
    await expect(notNegotiated.list("sage", {})).rejects.toBeInstanceOf(HistoryNotNegotiated);
    const offline = new AttachHistorySurface({ sendHistoryRequest: () => "not_attached" });
    await expect(offline.list("sage", {})).rejects.toBeInstanceOf(BackendUnavailable);
    notNegotiated.close();
    offline.close();
  });

  // A peer that negotiated everything else but not this one is refused at the ingress rather than
  // silently served, which is what keeps the 409 honest at the other end.
  it("never reaches a peer that did not negotiate the lane", async () => {
    const peer = await dial(() => ({ status: "ok", result: REPLIES.list }), ["bot_config"]);
    await expect(history.list("sage", {})).rejects.toBeInstanceOf(HistoryNotNegotiated);
    expect(peer.requests).toEqual([]);
    peer.ws.close();
  });

  it("spends a bounded budget so a looping client is stopped at the gateway", async () => {
    let now = 0;
    const surface = new AttachHistorySurface(
      { sendHistoryRequest: () => "sent" },
      12_000,
      undefined,
      { rateLimiter: createHistoryRateLimiter({ capacity: 1, refillMs: 1_000 }), now: () => now },
    );
    void surface.list("sage", {}).catch(() => undefined);
    await expect(surface.list("sage", {})).rejects.toThrow("too many bot history requests");
    now = 1_000;
    void surface.list("sage", {}).catch(() => undefined);
    surface.close();
  });

  it("drops a reply for a request another profile made", async () => {
    const sent: AttachV1HistoryRequest[] = [];
    const surface = new AttachHistorySurface({
      sendHistoryRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = surface.list("sage", {});
    const frame = {
      kind: "history_result" as const, requestId: sent[0]!.requestId, status: "ok" as const,
      result: { checkpoints: [checkpoint] },
    };
    expect(surface.handle("cleo", frame)).toBe(false);
    expect(surface.handle("sage", frame)).toBe(true);
    await expect(pending).resolves.toEqual({ checkpoints: [checkpoint] });
    expect(surface.handle("sage", frame)).toBe(false);
    surface.close();
  });

  it("refuses a reply whose shape does not answer the operation that was asked", async () => {
    const sent: AttachV1HistoryRequest[] = [];
    const surface = new AttachHistorySurface({
      sendHistoryRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = surface.diff("sage", "c1");
    expect(surface.handle("sage", {
      kind: "history_result", requestId: sent[0]!.requestId, status: "ok",
      result: { checkpoints: [checkpoint] },
    })).toBe(true);
    await expect(pending).rejects.toThrow("bot history returned an invalid reply");
    surface.close();
  });
});

describe("native runtime bot history routing", () => {
  const sage = { id: "sage", name: "Sage", avatar: null, runtime: "cozyagents" } as const;

  function planeWith(botHistory: HistorySurface | undefined) {
    const storage = openStorage(":memory:");
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface,
      storage,
      ingress: {} as never,
      nativeBots: ["sage"],
      runtimeBots: [sage],
      chatSuggestion: "",
      broadcast: () => undefined,
      ...(botHistory === undefined ? {} : { botHistory }),
    });
    return { plane, storage };
  }

  function laneStub(overrides: Partial<HistorySurface> = {}): HistorySurface {
    return {
      list: vi.fn(async () => ({ checkpoints: [checkpoint] })),
      diff: vi.fn(async () => ({ files: [] })),
      restore: vi.fn(async () => ({ checkpoint: "c9", restoredFrom: "c1" })),
      tryStart: vi.fn(async () => ({ tryId: "try-1", base: "c1" })),
      tryKeep: vi.fn(async () => ({ merged: true })),
      tryDiscard: vi.fn(async () => ({ kept: false })),
      resolve: vi.fn(async () => ({ merged: true })),
      ...overrides,
    };
  }

  it("serves a runtime bot from the lane, under its canonical name", async () => {
    const lane = laneStub();
    const { plane, storage } = planeWith(lane);
    await expect(plane.historySurface()?.list("SAGE", { limit: 5 })).resolves.toEqual({ checkpoints: [checkpoint] });
    expect(lane.list).toHaveBeenCalledWith("sage", { limit: 5 });
    plane.close();
    storage.close();
  });

  // A Hermes profile has no checkpointed workspace behind it and never did, so this is a fact
  // about the bot's kind rather than a missing bot or an unreachable peer.
  it("refuses a Hermes bot with 409 unsupported_for_runtime and never asks the peer", async () => {
    const lane = laneStub();
    const { plane, storage } = planeWith(lane);
    const surface = plane.historySurface();
    await expect(surface?.list("cleo", {})).rejects.toBeInstanceOf(UnsupportedForRuntime);
    await expect(surface?.restore("cleo", "c1")).rejects.toMatchObject({ runtime: "hermes", feature: "botHistoryRestore" });
    expect(lane.list).not.toHaveBeenCalled();
    expect(lane.restore).not.toHaveBeenCalled();
    plane.close();
    storage.close();
  });

  // Same answer for a runtime bot whose peer holds no history: the section is absent, not
  // temporarily unreachable, so a 503 would offer a retry that can never succeed.
  it("turns a peer that did not negotiate bot_history into the same 409", async () => {
    const lane = laneStub({
      tryKeep: vi.fn(async () => { throw new HistoryNotNegotiated("sage"); }),
    });
    const { plane, storage } = planeWith(lane);
    const pending = plane.historySurface()?.tryKeep("sage");
    await expect(pending).rejects.toBeInstanceOf(UnsupportedForRuntime);
    await expect(pending).rejects.toMatchObject({ runtime: "cozyagents", feature: "botHistoryTry" });
    plane.close();
    storage.close();
  });

  it("leaves an offline peer on backend_unavailable", async () => {
    const lane = laneStub({
      list: vi.fn(async () => { throw new BackendUnavailable("bot history is unavailable for this bot"); }),
    });
    const { plane, storage } = planeWith(lane);
    await expect(plane.historySurface()?.list("sage", {})).rejects.toBeInstanceOf(BackendUnavailable);
    plane.close();
    storage.close();
  });

  it("offers no surface at all when no lane is wired", () => {
    const { plane, storage } = planeWith(undefined);
    expect(plane.historySurface()).toBeUndefined();
    plane.close();
    storage.close();
  });
});

type Env = { Variables: { deviceId: string } };

describe("capability-50 bot history routes", () => {
  function appFor(history: Partial<HistorySurface>) {
    const app = new Hono<Env>();
    const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
      c.set("deviceId", "device");
      await next();
    };
    registerBotRoutes(app, requireDevice, {} as BotsSurface, {}, {}, undefined, {}, history as HistorySurface);
    return app;
  }

  const json = (body: unknown) => ({
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("reads the Changes list with its bounded query", async () => {
    const list = vi.fn(async () => ({ checkpoints: [checkpoint] }));
    const response = await appFor({ list }).request("/bots/SAGE/history?since=100&limit=20");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ checkpoints: [checkpoint] });
    expect(list).toHaveBeenCalledWith("sage", { since: 100, limit: 20 });
  });

  // A client that sent `limit=lots` asked for something; answering the default would hide the bug
  // behind a plausible page.
  it("refuses an unparseable or out-of-range bound instead of silently defaulting", async () => {
    const list = vi.fn(async () => ({ checkpoints: [] }));
    const app = appFor({ list });
    for (const query of ["?limit=lots", "?limit=0", "?limit=201", "?since=-1"]) {
      const response = await app.request(`/bots/sage/history${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("compares one checkpoint against the working version, or against a named one", async () => {
    const files = [{ path: "src/app.ts", added: 12, removed: 3, status: "modified" as const }];
    const diff = vi.fn(async () => ({ files }));
    const app = appFor({ diff });
    expect(await (await app.request("/bots/sage/history/c1/diff")).json()).toEqual({ files });
    await app.request("/bots/sage/history/c1/diff?to=c2");
    expect(diff.mock.calls).toEqual([["sage", "c1", undefined], ["sage", "c1", "c2"]]);
  });

  it("restores and answers with both the new checkpoint and the one it came from", async () => {
    const restore = vi.fn(async () => ({ checkpoint: "c9", restoredFrom: "c1" }));
    const response = await appFor({ restore }).request("/bots/sage/history/restore", json({ checkpoint: "c1" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ checkpoint: "c9", restoredFrom: "c1" });
    expect(restore).toHaveBeenCalledWith("sage", "c1");
  });

  it("routes the three try actions to their three surface calls", async () => {
    const surface = {
      tryStart: vi.fn(async () => ({ tryId: "try-1", base: "c1" })),
      tryKeep: vi.fn(async () => ({ merged: true })),
      tryDiscard: vi.fn(async () => ({ kept: false })),
    };
    const app = appFor(surface);
    expect(await (await app.request("/bots/sage/history/try", json({ action: "start", label: "darker theme" }))).json())
      .toEqual({ tryId: "try-1", base: "c1" });
    expect(await (await app.request("/bots/sage/history/try", json({ action: "keep" }))).json()).toEqual({ merged: true });
    expect(await (await app.request("/bots/sage/history/try", json({ action: "discard" }))).json()).toEqual({ kept: false });
    expect(surface.tryStart).toHaveBeenCalledWith("sage", "darker theme");
    expect(surface.tryKeep).toHaveBeenCalledWith("sage");
    expect(surface.tryDiscard).toHaveBeenCalledWith("sage");
  });

  it("requires a label to start a try and refuses one that would be ignored", async () => {
    const surface = { tryStart: vi.fn(), tryKeep: vi.fn(), tryDiscard: vi.fn() };
    const app = appFor(surface);
    for (const body of [{ action: "start" }, { action: "keep", label: "x" }, { action: "discard", label: "x" }]) {
      const response = await app.request("/bots/sage/history/try", json(body));
      expect(response.status).toBe(400);
    }
    expect(surface.tryStart).not.toHaveBeenCalled();
    expect(surface.tryKeep).not.toHaveBeenCalled();
  });

  it("refuses a body carrying a field the schema does not know", async () => {
    const surface = { restore: vi.fn(), tryStart: vi.fn(), resolve: vi.fn() };
    const app = appFor(surface);
    const cases: [string, unknown][] = [
      ["/bots/sage/history/restore", { checkpoint: "c1", hard: true }],
      ["/bots/sage/history/try", { action: "start", label: "x", branch: "main" }],
      ["/bots/sage/history/resolve", { choices: [{ path: "a.ts", pick: "ours", content: "x" }] }],
    ];
    for (const [path, body] of cases) {
      const response = await app.request(path, json(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(surface.restore).not.toHaveBeenCalled();
    expect(surface.tryStart).not.toHaveBeenCalled();
    expect(surface.resolve).not.toHaveBeenCalled();
  });

  // The one case: nothing is lost and nothing failed, and the answer carries the question the
  // person is about to be asked rather than a diagnosis.
  it("answers a keep-time conflict with the per-file choices", async () => {
    const conflicts = [{ path: "src/app.ts", ours: "Sage's version", theirs: "the other change" }];
    const tryKeep = vi.fn(async () => { throw new HistoryConflict("the working version changed", conflicts); });
    const response = await appFor({ tryKeep }).request("/bots/sage/history/try", json({ action: "keep" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "conflict", message: "the working version changed" }, conflicts,
    });
  });

  it("sends the per-file answer back and reports the merge", async () => {
    const resolve = vi.fn(async () => ({ merged: true }));
    const choices = [{ path: "src/app.ts", pick: "ours" }, { path: "README.md", pick: "theirs" }];
    const response = await appFor({ resolve }).request("/bots/sage/history/resolve", json({ choices }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ merged: true });
    expect(resolve).toHaveBeenCalledWith("sage", choices);
  });

  it("passes a wrong-kind bot's 409 through as unsupported_for_runtime", async () => {
    const list = vi.fn(async () => { throw new UnsupportedForRuntime("cleo", "botHistory", "hermes"); });
    const response = await appFor({ list }).request("/bots/cleo/history");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "unsupported_for_runtime" }, runtime: "hermes", feature: "botHistory",
    });
  });

  it("reports an offline peer as backend_unavailable, which is a retry worth offering", async () => {
    const list = vi.fn(async () => { throw new BackendUnavailable("this bot's peer is not attached right now"); });
    const response = await appFor({ list }).request("/bots/sage/history");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "backend_unavailable" } });
  });

  it("registers nothing at all when no history lane is wired", async () => {
    const app = new Hono<Env>();
    const requireDevice: MiddlewareHandler<Env> = async (c, next) => { c.set("deviceId", "d"); await next(); };
    registerBotRoutes(app, requireDevice, {} as BotsSurface, {}, {}, undefined, {}, undefined);
    expect((await app.request("/bots/sage/history")).status).toBe(404);
  });
});

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the peer");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

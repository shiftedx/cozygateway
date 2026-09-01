import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotModelConfig, BotProfile, BotRoutine } from "cozygateway-contract";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1ConfigRequest, AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import {
  AttachConfigSurface,
  ConfigInvalidRequest,
  ConfigNotFound,
  ConfigNotNegotiated,
  createConfigRateLimiter,
  type ConfigSurface,
} from "../src/hermes-bridge/bot-config.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { BotNotFound } from "../src/hermes-bridge/crud.ts";
import { RoutineNotFound } from "../src/hermes-bridge/routines.ts";
import { BackendUnavailable, UnsupportedForRuntime } from "../src/errors.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";

const profile: BotProfile = {
  name: "sage",
  description: "",
  soul: "# Sage",
  skills: [],
  toolsets: [],
  toolsetsPinned: false,
  mcpServers: [],
  model: { provider: "anthropic", default: "opus" },
  runtimeInert: [],
};

const modelConfig: BotModelConfig = {
  model: "opus",
  effort: "high",
  catalog: [],
  efforts: ["low", "high"],
};

const routine: BotRoutine = {
  id: "job-1",
  title: "Morning brief",
  schedule: { raw: "0 9 * * *", human: "Daily" },
  enabled: true,
  lastRun: null,
  nextRun: null,
};

describe("attach-v1 config lane", () => {
  let server: Server;
  let port: number;
  let storage: Storage;
  let ingress: AttachV1Ingress;
  let config: AttachConfigSurface;

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
    server = createServer();
    server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    config.close();
    ingress.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  });

  /** A peer that answers every `config_request` with the reply the table names for its operation. */
  async function dial(
    replies: Partial<Record<AttachV1ConfigRequest["operation"], unknown>>,
    capabilities: string[] = ["bot_config"],
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
          ? { kind: "config_result", requestId: frame.requestId, status: "not_found", message: "no such thing" }
          : { kind: "config_result", requestId: frame.requestId, status: "ok", result },
      ));
    });
    await once(ws, "open");
    ws.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "peer", capabilities,
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => acked);
    return { ws, requests };
  }

  it("round-trips every config operation through an attached peer", async () => {
    const peer = await dial({
      "profile.read": profile,
      "profile.write": { name: "sage", outcome: "applied", ok: true, applied: { soul: true }, requested: ["soul"] },
      "model.read": modelConfig,
      "model.write": modelConfig,
      "routines.list": { name: "sage", routines: [routine], updatedAt: 5 },
      "routines.create": { name: "sage", routine },
      "routines.update": { name: "sage", routine, replacedId: "job-0" },
      "routines.delete": { ok: true },
      "routines.run": { ok: true },
    });

    await expect(config.botProfile("sage")).resolves.toEqual(profile);
    await expect(config.configureProfile("sage", { soul: "# new" })).resolves.toEqual({
      outcome: "applied", ok: true, applied: { soul: true }, requested: ["soul"],
    });
    await expect(config.modelConfig("sage")).resolves.toEqual(modelConfig);
    await expect(config.configureModel("sage", { model: "opus" })).resolves.toEqual(modelConfig);
    await expect(config.routines("sage")).resolves.toEqual({ name: "sage", routines: [routine], updatedAt: 5 });
    await expect(config.createRoutine("sage", { title: "t", schedule: "30m", prompt: "p" })).resolves.toEqual({ routine });
    await expect(config.patchRoutine("sage", "job-0", { enabled: false })).resolves.toEqual({ routine, replacedId: "job-0" });
    await expect(config.deleteRoutine("sage", "job-1")).resolves.toBeUndefined();
    await expect(config.runRoutine("sage", "job-1")).resolves.toBeUndefined();

    expect(peer.requests.map((request) => request.operation)).toEqual([
      "profile.read", "profile.write", "model.read", "model.write",
      "routines.list", "routines.create", "routines.update", "routines.delete", "routines.run",
    ]);
    // The lane is live only: nothing it carried becomes a durable command or event.
    expect(storage.attachCommandCursor("sage")).toBe(0);
    expect(storage.attachEventCursor("sage")).toBe(0);
    peer.ws.close();
  });

  it("rejects per status rather than collapsing every refusal into one failure", async () => {
    const peer = await dial({ "profile.read": profile });
    await expect(config.routines("sage")).rejects.toBeInstanceOf(BackendUnavailable);
    await expect(config.deleteRoutine("sage", "job-9")).rejects.toBeInstanceOf(RoutineNotFound);
    peer.ws.close();
  });

  // The bot is on the roster and its chat lane works, so "nothing is stored here" cannot be told
  // as "this bot is unreachable": that is a retry a client would offer forever.
  it("separates an empty profile from an offline peer", async () => {
    const sent: AttachV1ConfigRequest[] = [];
    const surface = new AttachConfigSurface({
      sendConfigRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = surface.botProfile("sage");
    surface.handle("sage", { kind: "config_result", requestId: sent[0]!.requestId, status: "not_found" });
    // `BotNotFound` is the class the bots routes answer 404 `not_found` on.
    await expect(pending).rejects.toBeInstanceOf(ConfigNotFound);
    await expect(pending).rejects.toBeInstanceOf(BotNotFound);
    await expect(pending).rejects.toThrow('bot "sage" has no stored profile');
    surface.close();
  });

  it("separates an empty model config from an offline peer", async () => {
    const sent: AttachV1ConfigRequest[] = [];
    const surface = new AttachConfigSurface({
      sendConfigRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = surface.modelConfig("sage");
    surface.handle("sage", { kind: "config_result", requestId: sent[0]!.requestId, status: "not_found" });
    await expect(pending).rejects.toBeInstanceOf(ConfigNotFound);
    await expect(pending).rejects.toThrow('bot "sage" has no stored model config');
    surface.close();
  });

  // A write, a list, and a create have no "nothing stored" answer to give: the peer failing one of
  // those is a backend failure, and a 404 there would tell a client the bot went away.
  it("keeps a refused write and a refused list on backend_unavailable", async () => {
    const sent: AttachV1ConfigRequest[] = [];
    const surface = new AttachConfigSurface({
      sendConfigRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const write = surface.configureProfile("sage", { soul: "# new" });
    surface.handle("sage", { kind: "config_result", requestId: sent[0]!.requestId, status: "not_found" });
    await expect(write).rejects.toBeInstanceOf(BackendUnavailable);
    const list = surface.routines("sage");
    surface.handle("sage", { kind: "config_result", requestId: sent[1]!.requestId, status: "not_found" });
    await expect(list).rejects.toBeInstanceOf(BackendUnavailable);
    surface.close();
  });

  it("reports a refused write as invalid input in the peer's own words", async () => {
    const sent: AttachV1ConfigRequest[] = [];
    const surface = new AttachConfigSurface({
      sendConfigRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = surface.createRoutine("sage", { title: "t", schedule: "nonsense", prompt: "p" });
    surface.handle("sage", {
      kind: "config_result", requestId: sent[0]!.requestId, status: "invalid_request",
      message: "schedule \"nonsense\" is not a schedule this runtime can keep",
    });
    await expect(pending).rejects.toBeInstanceOf(ConfigInvalidRequest);
    await expect(pending).rejects.toThrow("is not a schedule this runtime can keep");
    surface.close();
  });

  it("maps a silent peer to unavailable instead of waiting forever", async () => {
    const surface = new AttachConfigSurface({ sendConfigRequest: () => "sent" }, 1);
    await expect(surface.botProfile("sage")).rejects.toThrow("bot config reply timed out");
    surface.close();
  });

  it("separates a peer that never negotiated bot_config from one that is offline", async () => {
    const notNegotiated = new AttachConfigSurface({ sendConfigRequest: () => "capability_not_negotiated" });
    await expect(notNegotiated.botProfile("sage")).rejects.toBeInstanceOf(ConfigNotNegotiated);
    const offline = new AttachConfigSurface({ sendConfigRequest: () => "not_attached" });
    await expect(offline.botProfile("sage")).rejects.toBeInstanceOf(BackendUnavailable);
    notNegotiated.close();
    offline.close();
  });

  it("spends a bounded budget so a looping client is stopped at the gateway", async () => {
    let now = 0;
    const surface = new AttachConfigSurface(
      { sendConfigRequest: () => "sent" },
      12_000,
      undefined,
      { rateLimiter: createConfigRateLimiter({ capacity: 1, refillMs: 1_000 }), now: () => now },
    );
    void surface.botProfile("sage").catch(() => undefined);
    await expect(surface.botProfile("sage")).rejects.toThrow("too many bot config requests");
    now = 1_000;
    void surface.botProfile("sage").catch(() => undefined);
    surface.close();
  });

  it("drops a reply for a request another profile made", async () => {
    const sent: AttachV1ConfigRequest[] = [];
    const surface = new AttachConfigSurface({
      sendConfigRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = surface.botProfile("sage");
    const frame = { kind: "config_result" as const, requestId: sent[0]!.requestId, status: "ok" as const, result: profile };
    expect(surface.handle("cleo", frame)).toBe(false);
    expect(surface.handle("sage", frame)).toBe(true);
    await expect(pending).resolves.toEqual(profile);
    expect(surface.handle("sage", frame)).toBe(false);
    surface.close();
  });

  it("refuses a reply whose shape does not answer the operation that was asked", async () => {
    const sent: AttachV1ConfigRequest[] = [];
    const surface = new AttachConfigSurface({
      sendConfigRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = surface.modelConfig("sage");
    expect(surface.handle("sage", {
      kind: "config_result", requestId: sent[0]!.requestId, status: "ok", result: profile,
    })).toBe(true);
    await expect(pending).rejects.toThrow("bot config returned an invalid reply");
    surface.close();
  });
});

describe("native runtime bot config routing", () => {
  const sage = { id: "sage", name: "Sage", avatar: null, runtime: "cozyagents" } as const;

  function planeWith(botConfig: ConfigSurface | undefined, control: Partial<BotsSurface>) {
    const storage = openStorage(":memory:");
    const plane = new NativeBotDataPlane({
      control: control as BotsSurface,
      storage,
      ingress: {} as never,
      nativeBots: ["sage"],
      runtimeBots: [sage],
      chatSuggestion: "",
      broadcast: () => undefined,
      ...(botConfig === undefined ? {} : { botConfig }),
    });
    return { plane, storage };
  }

  it("routes the Dashboard-backed config surfaces to the peer for a runtime bot", async () => {
    const botProfile = vi.fn();
    const routines = vi.fn();
    const surface = {
      botProfile: vi.fn(async () => profile),
      routines: vi.fn(async () => ({ name: "sage", routines: [routine], updatedAt: 5 })),
      configureProfile: vi.fn(),
      modelConfig: vi.fn(),
      configureModel: vi.fn(),
      createRoutine: vi.fn(),
      patchRoutine: vi.fn(),
      deleteRoutine: vi.fn(),
      runRoutine: vi.fn(),
    };
    const { plane, storage } = planeWith(surface as unknown as ConfigSurface, { botProfile, routines } as unknown as Partial<BotsSurface>);

    await expect(plane.surface().botProfile("SAGE")).resolves.toEqual(profile);
    await expect(plane.surface().routines("sage")).resolves.toMatchObject({ routines: [routine] });
    expect(surface.botProfile).toHaveBeenCalledWith("sage");
    expect(botProfile).not.toHaveBeenCalled();
    expect(routines).not.toHaveBeenCalled();

    plane.close();
    storage.close();
  });

  it("keeps the 409 for delete, provider setup, and desktop transcripts", async () => {
    const surface = { botProfile: vi.fn(async () => profile) };
    const { plane, storage } = planeWith(surface as unknown as ConfigSurface, {
      deleteBot: vi.fn(), modelProviders: vi.fn(), desktopSessionTranscript: vi.fn(),
    } as Partial<BotsSurface>);

    await expect(plane.surface().deleteBot("sage")).rejects.toBeInstanceOf(UnsupportedForRuntime);
    await expect(plane.surface().modelProviders("sage")).rejects.toMatchObject({ feature: "modelProviders" });
    await expect(plane.surface().desktopSessionTranscript("sage", "x")).rejects.toMatchObject({
      feature: "desktopSessionTranscript",
    });

    plane.close();
    storage.close();
  });

  it("still answers 409 when the peer never negotiated bot_config", async () => {
    const surface = {
      botProfile: vi.fn(async () => {
        throw new ConfigNotNegotiated("sage");
      }),
    };
    const { plane, storage } = planeWith(surface as unknown as ConfigSurface, { botProfile: vi.fn() } as unknown as Partial<BotsSurface>);

    await expect(plane.surface().botProfile("sage")).rejects.toBeInstanceOf(UnsupportedForRuntime);
    await expect(plane.surface().botProfile("sage")).rejects.toMatchObject({
      feature: "botProfile", runtime: "cozyagents",
    });

    plane.close();
    storage.close();
  });

  it("keeps the 409 for every config surface when no config lane is wired at all", async () => {
    const { plane, storage } = planeWith(undefined, { botProfile: vi.fn(), routines: vi.fn() } as Partial<BotsSurface>);
    await expect(plane.surface().botProfile("sage")).rejects.toBeInstanceOf(UnsupportedForRuntime);
    await expect(plane.surface().routines("sage")).rejects.toBeInstanceOf(UnsupportedForRuntime);
    plane.close();
    storage.close();
  });
});

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

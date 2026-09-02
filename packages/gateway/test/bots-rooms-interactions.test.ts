import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BotApprovalPendingFrame,
  BotClarifyPendingFrame,
  BotGroupStateFrame,
  BotSummary,
  BotToolActivityFrame,
  ServerFrame,
} from "cozygateway-contract";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import { HermesBridge, type BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 51: a room member turn can ASK.
 *
 *  Below 51 a room acknowledged and dropped every approval, clarify and tool event on a member
 *  turn, which is why a runtime peer had to run room turns with read-only tools: a bot that cannot
 *  ask for permission must never need it. These tests pin the four facts that lift that rule.
 *
 *  The load-bearing design choice is that a room interaction is stored as an ORDINARY interaction
 *  row -- same table, keyed by the member bot and the attach id -- with the gateway-owned member
 *  thread as its session. So nothing about the inbox, the resolve routes, or the `resolve_approval`
 *  command had to learn what a room is, and these tests assert exactly that by resolving a room
 *  approval through the unchanged 1:1 route and watching the unchanged command reach the peer. */

const NOW = 1_800_000_000_000;

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: Storage[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
});

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The one Hermes profile this gateway serves; `sage` is the runtime bot, absent from it. */
const scoutRow = { name: "scout", description: "watches CI", has_avatar: false };
/** A second Hermes profile, so a room of Hermes members only can exist. */
const lunaRow = { name: "luna", description: "reads the docs", has_avatar: false };

const sageRow: BotSummary = {
  name: "sage",
  displayName: "Sage",
  handle: "sage",
  description: null,
  hasAvatar: false,
  group: null,
  pinned: false,
  active: true,
  meta: null,
  runtime: "cozyagents",
  chatSessionId: null,
  lastActiveAt: null,
  preview: { kind: "empty", text: "No conversations yet, say hi" },
  syncState: "ready",
};

interface Harness {
  bridge: HermesBridge;
  storage: Storage;
  client: HermesClient;
  /** Every attach turn command the room handed to the transport, in dispatch order. */
  commands: Array<{ agentId: string; threadId: string; turnId: string }>;
  frames: ServerFrame[];
  /** Pushes one attach event at the room, answering whether the room accepted it. A `false` here
   *  is a DEAD LETTER: the ingress would retry it and then block the member's whole stream. */
  push: (agentId: string, event: Record<string, unknown>) => boolean;
}

/** A bridge whose rooms speak to a transport that HOLDS the turn: nothing settles until the test
 *  says so, which is the only way to observe a turn that is blocked on a human. */
async function setup(
  opts: { runtimeBotNames?: readonly string[]; hermesProfiles?: readonly unknown[] } = {},
): Promise<Harness> {
  const profiles = opts.hermesProfiles ?? [scoutRow];
  const server = await startFakeHermesServer({
    methods: { "profiles.list": () => ({ profiles, bot_mode_protocol: true }) },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const frames: ServerFrame[] = [];
  const runtime = new Set(opts.runtimeBotNames ?? ["sage"]);
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => NOW,
    logSink: () => {},
    runtimeBotNames: () => runtime,
  });
  bridges.push(bridge);
  bridge.setRosterOverlay((bots) => [...bots, sageRow]);

  const commands: Harness["commands"] = [];
  let sequence = 0;
  bridge.setGroupNativeTurns({
    canQueue: () => true,
    sendNativeTurn: (agentId, command) => {
      commands.push({ agentId, threadId: command.threadId, turnId: command.turnId });
      return true;
    },
  });
  bridge.start();
  await until(() => client.state() === "online");
  return {
    bridge,
    storage,
    client,
    commands,
    frames,
    push: (agentId, event) => {
      sequence += 1;
      return bridge.handleGroupAttachEvent(agentId, {
        kind: "event",
        sequence,
        eventId: `event-${sequence}`,
        event: event as never,
      });
    },
  };
}

/** The other half of the gateway: the plane that owns the interaction inbox and the resolve
 *  routes, plus a real attach socket standing in for the runtime peer. Both read the SAME storage
 *  the rooms wrote to, which is the whole point of storing a room approval as an ordinary row. */
async function peer(storage: Storage): Promise<{
  app: Hono<{ Variables: { deviceId: string } }>;
  received: AttachV1ServerFrame[];
}> {
  const ingress = new AttachV1Ingress({
    tokens: new Map([["secret", "sage"]]),
    storage,
    events: { onEvent: () => true, onPresence: () => {} },
    now: () => NOW,
  });
  const server: Server = createServer();
  server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, {
    headers: { authorization: "Bearer secret" },
  });
  const received: AttachV1ServerFrame[] = [];
  ws.on("message", (data) => received.push(JSON.parse(String(data)) as AttachV1ServerFrame));
  await once(ws, "open");
  ws.send(JSON.stringify({
    kind: "hello", version: 2, instanceId: "peer",
    capabilities: ["draft", "tools", "approvals", "clarify"],
    resume: { eventSequence: 0, commandSequence: 0 },
  }));
  await until(() => received.some((frame) => frame.kind === "hello_ack"));

  const plane = new NativeBotDataPlane({
    control: {} as BotsSurface,
    storage,
    ingress,
    nativeBots: ["sage"],
    chatSuggestion: "",
    broadcast: () => undefined,
    now: () => NOW,
    log: () => {},
  });
  const app = new Hono<{ Variables: { deviceId: string } }>();
  const requireDevice: MiddlewareHandler<{ Variables: { deviceId: string } }> = async (c, next) => {
    c.set("deviceId", "device-1");
    await next();
  };
  registerBotRoutes(app, requireDevice, plane.surface());

  closers.push(async () => {
    ws.close();
    plane.close();
    ingress.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { app, received };
}

/** Drives a room to the point where `sage` holds an open member turn. */
async function blockedTurn(h: Harness): Promise<{ threadId: string; turnId: string }> {
  await h.bridge.createGroup("Launch", ["sage", "scout"]);
  h.bridge.sendGroupMessage("Launch", "ship it @sage");
  await until(() => h.commands.some((command) => command.agentId === "sage"));
  const command = h.commands.find((entry) => entry.agentId === "sage")!;
  expect(command.threadId).toBe("group:launch:sage");
  return { threadId: command.threadId, turnId: command.turnId };
}

describe("capability 51: approvals and clarifications on a room turn", () => {
  it("lands a runtime member's room approval in the inbox and resolves it through the unchanged route", async () => {
    const h = await setup();
    const turn = await blockedTurn(h);

    expect(h.push("sage", {
      kind: "approval", threadId: turn.threadId, turnId: turn.turnId,
      approvalId: "approval-1", callId: "call-1", name: "terminal:rm", status: "pending",
    })).toBe(true);

    // The inbox is the 1:1 inbox: one row, keyed by the member bot and the attach approval id,
    // carrying the room key facts a client needs to render the card above the right transcript.
    const inbox = h.storage.pendingNativeApprovals(["sage"], 100);
    expect(inbox).toEqual([{
      bot: "sage",
      sessionId: "group:launch:sage",
      turnId: turn.turnId,
      toolCallId: "approval-1",
      ruleName: "terminal:rm",
      createdAt: NOW,
      room: "Launch",
    }]);

    // The live frame carries the same room, so a client watching the room sees the card at once.
    const pending = h.frames.find((frame) => frame.type === "bot_approval_pending") as BotApprovalPendingFrame;
    expect(pending).toMatchObject({
      bot: "sage", sessionId: "group:launch:sage", turnId: turn.turnId,
      toolCallId: "approval-1", name: "terminal:rm", room: "Launch",
    });

    // And the room advertises what it is blocked on, so the rooms list can badge without the app
    // having to join the inbox to a room itself.
    expect(h.bridge.groups()[0]?.pendingInteractions).toEqual([
      { member: "sage", kind: "approval", id: "approval-1", turnId: turn.turnId },
    ]);
    const state = [...h.frames].reverse().find((frame) => frame.type === "bot_group_state") as BotGroupStateFrame;
    expect(state.pendingInteractions).toEqual([
      { member: "sage", kind: "approval", id: "approval-1", turnId: turn.turnId },
    ]);

    // The existing 1:1 route resolves it, unchanged, and the peer gets the command it always got.
    const { app, received } = await peer(h.storage);
    const response = await app.request("/bots/sage/approvals/approval-1/approve", { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "requested" });

    await until(() => received.some((frame) => frame.kind === "command" && frame.command.kind === "resolve_approval"));
    const command = received.find((frame) => frame.kind === "command" && frame.command.kind === "resolve_approval")!;
    expect(command).toMatchObject({
      command: {
        kind: "resolve_approval",
        threadId: "group:launch:sage",
        turnId: turn.turnId,
        approvalId: "approval-1",
        decision: "approve",
      },
    });
  });

  it("lands a runtime member's room clarification in the inbox and resolves it through the unchanged route", async () => {
    const h = await setup();
    const turn = await blockedTurn(h);

    expect(h.push("sage", {
      kind: "clarify", threadId: turn.threadId, turnId: turn.turnId, clarifyId: "clarify-1",
      prompt: "Which environment?", options: [{ id: "staging", label: "Staging" }, { id: "prod", label: "Production" }],
      status: "pending",
    })).toBe(true);

    expect(h.storage.pendingNativeClarifications(["sage"], 100)).toEqual([{
      bot: "sage",
      sessionId: "group:launch:sage",
      turnId: turn.turnId,
      clarifyId: "clarify-1",
      prompt: "Which environment?",
      options: [{ id: "staging", label: "Staging" }, { id: "prod", label: "Production" }],
      room: "Launch",
    }]);
    const pending = h.frames.find((frame) => frame.type === "bot_clarify_pending") as BotClarifyPendingFrame;
    expect(pending).toMatchObject({
      bot: "sage", sessionId: "group:launch:sage", turnId: turn.turnId,
      clarifyId: "clarify-1", room: "Launch",
    });
    expect(h.bridge.groups()[0]?.pendingInteractions).toEqual([
      { member: "sage", kind: "clarify", id: "clarify-1", turnId: turn.turnId },
    ]);

    const { app, received } = await peer(h.storage);
    const response = await app.request("/bots/sage/clarifications/clarify-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "staging" }),
    });
    expect(response.status).toBe(202);

    await until(() => received.some((frame) => frame.kind === "command" && frame.command.kind === "resolve_clarify"));
    const command = received.find((frame) => frame.kind === "command" && frame.command.kind === "resolve_clarify")!;
    expect(command).toMatchObject({
      command: {
        kind: "resolve_clarify",
        threadId: "group:launch:sage",
        turnId: turn.turnId,
        clarifyId: "clarify-1",
        optionId: "staging",
      },
    });
  });

  it("projects a room turn's tool steps as an ephemeral activity card and never dead-letters one", async () => {
    const h = await setup();
    const turn = await blockedTurn(h);

    expect(h.push("sage", {
      kind: "tool", threadId: turn.threadId, turnId: turn.turnId, callId: "call-1",
      name: "read_file", status: "running", detail: "reading the plan",
    })).toBe(true);
    expect(h.push("sage", {
      kind: "tool", threadId: turn.threadId, turnId: turn.turnId, callId: "call-1",
      name: "read_file", status: "ok",
    })).toBe(true);

    const activity = h.frames.filter((frame) => frame.type === "bot_tool_activity") as BotToolActivityFrame[];
    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({
      bot: "sage", sessionId: "group:launch:sage", turnId: turn.turnId, room: "Launch", seq: 1,
    });
    // Name and status only. The plugin sent a `detail` and the room does not carry it: a room is a
    // place several bots and a human read each other's activity, so this projection stays at the
    // narrowest thing that is still useful. Arguments and results were never on this wire.
    expect(activity[0]?.steps).toEqual([
      { stepId: "call-1", seq: 1, name: "read_file", status: "running", startedAt: NOW },
    ]);
    expect(activity[1]?.steps).toEqual([
      { stepId: "call-1", seq: 1, name: "read_file", status: "ok", startedAt: NOW, endedAt: NOW },
    ]);

    // EPHEMERAL: the room transcript gains nothing and no step is persisted anywhere.
    expect(h.storage.botChatToolSteps("group:launch:sage", 0)).toEqual([]);

    // The turn settles and the gateway closes the card it opened.
    expect(h.push("sage", {
      kind: "commit", threadId: turn.threadId, turnId: turn.turnId, messageId: "m-1",
      blocks: [{ type: "paragraph", text: "read it, shipping" }],
    })).toBe(true);
    await until(() => h.frames.some((frame) => frame.type === "bot_tool_activity" && frame.done === true));

    // A replayed tool event for the settled turn is still ACKNOWLEDGED: an at-least-once stream
    // must never be blocked behind rendering state (issue #193).
    expect(h.push("sage", {
      kind: "tool", threadId: turn.threadId, turnId: turn.turnId, callId: "call-1",
      name: "read_file", status: "ok",
    })).toBe(true);
    expect(h.storage.attachProjectionDeadLetters()).toEqual([]);
  });

  it("expires a room interaction its member turn left behind", async () => {
    const h = await setup();
    const turn = await blockedTurn(h);
    h.push("sage", {
      kind: "approval", threadId: turn.threadId, turnId: turn.turnId,
      approvalId: "approval-1", callId: "call-1", name: "terminal:rm", status: "pending",
    });
    expect(h.storage.pendingNativeApprovals(["sage"], 100)).toHaveLength(1);

    // The member answered without waiting. A card the user could still tap would resolve into a
    // turn that is over, so the gateway closes it the way the 1:1 lane closes its own.
    h.push("sage", {
      kind: "commit", threadId: turn.threadId, turnId: turn.turnId, messageId: "m-1",
      blocks: [{ type: "paragraph", text: "never mind" }],
    });
    expect(h.storage.pendingNativeApprovals(["sage"], 100)).toEqual([]);
    expect(h.frames.some((frame) =>
      frame.type === "bot_approval_resolved" && frame.outcome === "expired" && frame.room === "Launch",
    )).toBe(true);
    expect(h.bridge.groups()[0]?.pendingInteractions).toBeUndefined();
  });

  it("leaves a Hermes member's room turn exactly as it was", async () => {
    // No runtime members at all: `scout` is a Hermes profile, and the Hermes plugin has never been
    // asked to raise an approval inside a room. Its events stay acknowledged and unprojected.
    const h = await setup({ runtimeBotNames: [], hermesProfiles: [scoutRow, lunaRow] });
    await h.bridge.createGroup("Launch", ["scout", "luna"]);
    h.bridge.sendGroupMessage("Launch", "status @scout");
    await until(() => h.commands.some((command) => command.agentId === "scout"));
    const turn = h.commands.find((command) => command.agentId === "scout")!;

    for (const event of [
      { kind: "approval", threadId: turn.threadId, turnId: turn.turnId, approvalId: "a-1", callId: "c-1", name: "terminal:rm", status: "pending" },
      { kind: "clarify", threadId: turn.threadId, turnId: turn.turnId, clarifyId: "cl-1", prompt: "Which?", options: [{ id: "a", label: "A" }], status: "pending" },
      { kind: "tool", threadId: turn.threadId, turnId: turn.turnId, callId: "c-1", name: "read_file", status: "running" },
    ]) {
      // Acknowledged, exactly as before: a dropped projection must never dead-letter the stream.
      expect(h.push("scout", event)).toBe(true);
    }

    expect(h.storage.pendingNativeApprovals(["scout"], 100)).toEqual([]);
    expect(h.storage.pendingNativeClarifications(["scout"], 100)).toEqual([]);
    expect(h.frames.some((frame) =>
      frame.type === "bot_approval_pending" || frame.type === "bot_clarify_pending" || frame.type === "bot_tool_activity",
    )).toBe(false);
    expect(h.bridge.groups()[0]?.pendingInteractions).toBeUndefined();
  });
});

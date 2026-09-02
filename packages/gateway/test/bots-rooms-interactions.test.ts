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
 *  ask for permission must never need it. These tests pin the facts that lift that rule.
 *
 *  The load-bearing design choice is that a room interaction is stored as an ORDINARY interaction
 *  row -- same table, keyed by the member bot and the attach id -- with the gateway-owned member
 *  thread as its session. So nothing about the inbox, the deadline wheel, the resolve routes, or
 *  the `resolve_approval` command had to learn what a room is, and these tests assert exactly that
 *  by resolving a room interaction through the unchanged 1:1 route and watching the unchanged
 *  command reach the peer that raised it. */

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

/** The Hermes profiles this gateway serves. Runtime bots are deliberately absent from every one of
 *  these lists: a runtime bot never appears in `profiles.list`. */
const scoutRow = { name: "scout", description: "watches CI", has_avatar: false };
const lunaRow = { name: "luna", description: "reads the docs", has_avatar: false };

/** The roster row a runtime bot gets, in the shape `NativeBotDataPlane.rosterBots` appends. */
function runtimeRow(name: string): BotSummary {
  return {
    name,
    displayName: name[0]!.toUpperCase() + name.slice(1),
    handle: name,
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
}

interface Harness {
  bridge: HermesBridge;
  storage: Storage;
  client: HermesClient;
  /** Every attach turn command the rooms handed to the transport, in dispatch order. */
  commands: Array<{ agentId: string; threadId: string; turnId: string }>;
  frames: ServerFrame[];
  /** Pushes one attach event at the room, answering whether the room accepted it. A `false` here
   *  is a DEAD LETTER: the ingress would retry it and then block the member's whole stream. */
  push: (agentId: string, event: Record<string, unknown>) => boolean;
  /** The bots routes, mounted over the native plane's surface: the real 1:1 resolve routes. */
  app: Hono<{ Variables: { deviceId: string } }>;
  /** What each runtime peer's own attach socket received, by bot name. */
  received: Map<string, AttachV1ServerFrame[]>;
  /** One peer's `resolve_*` commands, in arrival order. */
  resolutions: (bot: string) => Array<Record<string, unknown>>;
}

/** The whole gateway both halves of this feature need: rooms that HOLD a member turn (nothing
 *  settles until a test says so, which is the only way to observe a turn blocked on a human), the
 *  native data plane that owns the interaction inbox and the resolve routes, and one real attach
 *  socket per runtime bot. All three read the same storage, which is the point. */
async function setup(
  opts: { runtimeBots?: readonly string[]; hermesProfiles?: readonly unknown[] } = {},
): Promise<Harness> {
  const runtimeBots = opts.runtimeBots ?? ["sage"];
  const profiles = opts.hermesProfiles ?? [scoutRow];
  const server = await startFakeHermesServer({
    methods: { "profiles.list": () => ({ profiles, bot_mode_protocol: true }) },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);

  const ingress = new AttachV1Ingress({
    tokens: new Map(runtimeBots.map((bot) => [`secret:${bot}`, bot])),
    storage,
    events: { onEvent: () => true, onPresence: () => {} },
    now: () => NOW,
  });
  const attachServer: Server = createServer();
  attachServer.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => attachServer.listen(0, "127.0.0.1", resolve));
  const address = attachServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  // ONE broadcast sink for both halves, exactly as `server.ts` wires it: the plane and the rooms
  // publish to the same hub, so a terminal frame the plane emits for a room interaction lands on
  // the same wire the room's own frames do.
  const frames: ServerFrame[] = [];

  const received = new Map<string, AttachV1ServerFrame[]>();
  const sockets: WebSocket[] = [];
  for (const bot of runtimeBots) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, {
      headers: { authorization: `Bearer secret:${bot}` },
    });
    const inbox: AttachV1ServerFrame[] = [];
    received.set(bot, inbox);
    sockets.push(ws);
    ws.on("message", (data) => inbox.push(JSON.parse(String(data)) as AttachV1ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: `peer:${bot}`,
      capabilities: ["draft", "tools", "approvals", "clarify"],
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => inbox.some((frame) => frame.kind === "hello_ack"));
  }

  const plane = new NativeBotDataPlane({
    control: {} as BotsSurface,
    storage,
    ingress,
    nativeBots: runtimeBots,
    chatSuggestion: "",
    broadcast: (frame) => frames.push(frame),
    now: () => NOW,
    log: () => {},
  });

  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const runtime = new Set(runtimeBots);
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => NOW,
    logSink: () => {},
    runtimeBotNames: () => runtime,
  });
  bridges.push(bridge);
  bridge.setRosterOverlay((bots) => [...bots, ...runtimeBots.map(runtimeRow)]);
  // Production wiring, exactly as `server.ts` does it once the plane exists.
  bridge.setGroupInteractionExpiry(plane.groupInteractions());

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

  const app = new Hono<{ Variables: { deviceId: string } }>();
  const requireDevice: MiddlewareHandler<{ Variables: { deviceId: string } }> = async (c, next) => {
    c.set("deviceId", "device-1");
    await next();
  };
  registerBotRoutes(app, requireDevice, plane.surface());

  closers.push(async () => {
    for (const ws of sockets) ws.close();
    plane.close();
    ingress.close();
    await new Promise<void>((resolve) => attachServer.close(() => resolve()));
  });

  return {
    bridge,
    storage,
    client,
    commands,
    frames,
    app,
    received,
    resolutions: (bot) =>
      (received.get(bot) ?? [])
        .filter((frame) => frame.kind === "command" && frame.command.kind.startsWith("resolve_"))
        .map((frame) => (frame as { command: Record<string, unknown> }).command),
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

/** Drives a room to the point where its first member holds an open turn. */
async function blockedTurn(h: Harness, members: string[]): Promise<{ agentId: string; threadId: string; turnId: string }> {
  await h.bridge.createGroup("Launch", members);
  h.bridge.sendGroupMessage("Launch", `ship it ${members.map((name) => `@${name}`).join(" ")}`);
  await until(() => h.commands.length > 0);
  return h.commands[0]!;
}

describe("capability 51: approvals and clarifications on a room turn", () => {
  it("lands a runtime member's room approval in the inbox and resolves it through the unchanged route", async () => {
    const h = await setup();
    const turn = await blockedTurn(h, ["sage", "scout"]);
    expect(turn.agentId).toBe("sage");
    expect(turn.threadId).toBe("group:launch:sage");

    expect(h.push("sage", {
      kind: "approval", threadId: turn.threadId, turnId: turn.turnId,
      approvalId: "approval-1", callId: "call-1", name: "terminal:rm", status: "pending",
    })).toBe(true);

    // The inbox is the 1:1 inbox: one row, keyed by the member bot and the attach approval id,
    // carrying the room facts a client needs to render the card above the right transcript.
    expect(h.storage.pendingNativeApprovals(["sage"], 100)).toEqual([{
      bot: "sage",
      sessionId: "group:launch:sage",
      turnId: turn.turnId,
      toolCallId: "approval-1",
      ruleName: "terminal:rm",
      createdAt: NOW,
      room: "Launch",
    }]);

    const pending = h.frames.find((frame) => frame.type === "bot_approval_pending") as BotApprovalPendingFrame;
    expect(pending).toMatchObject({
      bot: "sage", sessionId: "group:launch:sage", turnId: turn.turnId,
      toolCallId: "approval-1", name: "terminal:rm", room: "Launch",
    });

    // The room advertises what it is blocked on, so the rooms list can badge without joining the
    // inbox to a room itself -- and the badge frame reports the round the drive is ACTUALLY on.
    const blocked = [{ member: "sage", kind: "approval", id: "approval-1", turnId: turn.turnId }];
    expect(h.bridge.groups()[0]?.pendingInteractions).toEqual(blocked);
    const state = [...h.frames].reverse().find((frame) => frame.type === "bot_group_state") as BotGroupStateFrame;
    expect(state).toMatchObject({ state: "running", round: 0, pendingInteractions: blocked });

    // The existing 1:1 route resolves it, unchanged, and the peer gets the command it always got.
    const response = await h.app.request("/bots/sage/approvals/approval-1/approve", { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "requested" });

    await until(() => h.resolutions("sage").length > 0);
    expect(h.resolutions("sage")).toEqual([{
      kind: "resolve_approval",
      threadId: "group:launch:sage",
      turnId: turn.turnId,
      approvalId: "approval-1",
      decision: "approve",
    }]);
  });

  it("capability 56: carries a sanitized approval detail on a room turn, and omits it when absent", async () => {
    const h = await setup();
    const turn = await blockedTurn(h, ["sage", "scout"]);

    // With detail: sanitized and carried on both the live frame and the durable row, so a room
    // card reads exactly like a 1:1 card would.
    expect(h.push("sage", {
      kind: "approval", threadId: turn.threadId, turnId: turn.turnId,
      approvalId: "approval-detail", callId: "call-1", name: "my_browser_open", status: "pending",
      // \u0000 (NUL, C0), \u0007 (BEL, C0), \u200b (zero-width space, Unicode Format/Cf).
      detail: "Would drive Chrome\u0000 (Work\u200bprofile)\u0007.",
    })).toBe(true);

    const pendingWithDetail = h.frames.find(
      (frame) => frame.type === "bot_approval_pending" && (frame as BotApprovalPendingFrame).toolCallId === "approval-detail",
    ) as BotApprovalPendingFrame;
    expect(pendingWithDetail).toMatchObject({
      bot: "sage", room: "Launch", name: "my_browser_open", detail: "Would drive Chrome (Workprofile).",
    });
    expect(h.storage.nativeInteraction("sage", "approval", "approval-detail")?.payload).toMatchObject({
      name: "my_browser_open",
      detail: "Would drive Chrome (Workprofile).",
      room: { name: "Launch" },
    });

    // Without detail: byte-identical to today, on both surfaces.
    expect(h.push("sage", {
      kind: "approval", threadId: turn.threadId, turnId: turn.turnId,
      approvalId: "approval-no-detail", callId: "call-2", name: "terminal:rm", status: "pending",
    })).toBe(true);
    const pendingNoDetail = h.frames.find(
      (frame) => frame.type === "bot_approval_pending" && (frame as BotApprovalPendingFrame).toolCallId === "approval-no-detail",
    ) as BotApprovalPendingFrame;
    expect(pendingNoDetail).not.toHaveProperty("detail");
    expect(h.storage.nativeInteraction("sage", "approval", "approval-no-detail")?.payload).not.toHaveProperty("detail");
  });

  it("lands a runtime member's room clarification in the inbox and resolves it through the unchanged route", async () => {
    const h = await setup();
    const turn = await blockedTurn(h, ["sage", "scout"]);

    expect(h.push("sage", {
      kind: "clarify", threadId: turn.threadId, turnId: turn.turnId, clarifyId: "clarify-1",
      prompt: "Which environment?",
      options: [{ id: "staging", label: "Staging" }, { id: "prod", label: "Production" }],
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

    const response = await h.app.request("/bots/sage/clarifications/clarify-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ optionId: "staging" }),
    });
    expect(response.status).toBe(202);

    await until(() => h.resolutions("sage").length > 0);
    expect(h.resolutions("sage")).toEqual([{
      kind: "resolve_clarify",
      threadId: "group:launch:sage",
      turnId: turn.turnId,
      clarifyId: "clarify-1",
      optionId: "staging",
    }]);
  });

  it("routes each of two runtime members' room approvals back to the peer that raised it", async () => {
    const h = await setup({ runtimeBots: ["sage", "nova"] });
    const first = await blockedTurn(h, ["sage", "nova"]);

    h.push(first.agentId, {
      kind: "approval", threadId: first.threadId, turnId: first.turnId,
      approvalId: "approval-first", callId: "call-1", name: "terminal:rm", status: "pending",
    });
    expect(h.bridge.groups()[0]?.pendingInteractions).toEqual([
      { member: first.agentId, kind: "approval", id: "approval-first", turnId: first.turnId },
    ]);
    expect(await (await h.app.request(`/bots/${first.agentId}/approvals/approval-first/approve`, { method: "POST" })).json())
      .toEqual({ status: "requested" });
    await until(() => h.resolutions(first.agentId).length > 0);

    // Member turns are SERIAL in a room, so the second member is asked only once the first settles.
    h.push(first.agentId, {
      kind: "commit", threadId: first.threadId, turnId: first.turnId, messageId: "m-1",
      blocks: [{ type: "paragraph", text: "done my half" }],
    });
    await until(() => h.commands.some((command) => command.agentId !== first.agentId));
    const second = h.commands.find((command) => command.agentId !== first.agentId)!;

    h.push(second.agentId, {
      kind: "approval", threadId: second.threadId, turnId: second.turnId,
      approvalId: "approval-second", callId: "call-2", name: "workspace:write", status: "pending",
    });
    expect(h.storage.pendingNativeApprovals([second.agentId], 100)).toMatchObject([
      { bot: second.agentId, sessionId: second.threadId, toolCallId: "approval-second", room: "Launch" },
    ]);
    expect(h.bridge.groups()[0]?.pendingInteractions).toEqual([
      { member: second.agentId, kind: "approval", id: "approval-second", turnId: second.turnId },
    ]);
    expect(await (await h.app.request(`/bots/${second.agentId}/approvals/approval-second/deny`, { method: "POST" })).json())
      .toEqual({ status: "requested" });
    await until(() => h.resolutions(second.agentId).length > 0);

    // Each peer got its OWN decision on its OWN member thread, and neither saw the other's. The
    // routes never learned about rooms; the durable row's `bot` did all the addressing.
    expect(h.resolutions(first.agentId)).toEqual([{
      kind: "resolve_approval", threadId: first.threadId, turnId: first.turnId,
      approvalId: "approval-first", decision: "approve",
    }]);
    expect(h.resolutions(second.agentId)).toEqual([{
      kind: "resolve_approval", threadId: second.threadId, turnId: second.turnId,
      approvalId: "approval-second", decision: "deny",
    }]);
    expect(first.threadId).not.toBe(second.threadId);
  });

  it("projects a room turn's tool steps as an ephemeral activity card and never dead-letters one", async () => {
    const h = await setup();
    const turn = await blockedTurn(h, ["sage", "scout"]);

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

  it("expires a room clarification on its own deadline, without waiting for the turn to seal", async () => {
    const h = await setup();
    const turn = await blockedTurn(h, ["sage", "scout"]);

    h.push("sage", {
      kind: "clarify", threadId: turn.threadId, turnId: turn.turnId, clarifyId: "clarify-1",
      prompt: "Which environment?", options: [{ id: "staging", label: "Staging" }],
      status: "pending", expiresAt: NOW + 20,
    });
    expect(h.storage.pendingNativeClarifications(["sage"], 100)).toHaveLength(1);

    // The room borrows the 1:1 lane's deadline wheel, so the card dies on its own clock. The
    // member turn is still wide open throughout: nothing here waits on a settlement.
    await until(() => h.frames.some((frame) =>
      frame.type === "bot_clarify_resolved" && frame.outcome === "expired" && frame.room === "Launch",
    ));
    expect(h.storage.pendingNativeClarifications(["sage"], 100)).toEqual([]);
    expect(h.commands).toHaveLength(1);
    expect(h.storage.botGroupTurn("launch", turn.turnId)?.state).toBe("pending");
  });

  it("expires a room interaction its member turn left behind", async () => {
    const h = await setup();
    const turn = await blockedTurn(h, ["sage", "scout"]);
    h.push("sage", {
      kind: "approval", threadId: turn.threadId, turnId: turn.turnId,
      approvalId: "approval-1", callId: "call-1", name: "terminal:rm", status: "pending",
    });
    expect(h.storage.pendingNativeApprovals(["sage"], 100)).toHaveLength(1);

    // The member answered without waiting. A card the user could still tap would resolve into a
    // turn that is over, so the gateway closes it through the native plane's own rule.
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
    // No runtime members at all: `scout` and `luna` are Hermes profiles, and the Hermes plugin has
    // never been asked to raise an approval inside a room. Its events stay acknowledged and
    // unprojected.
    const h = await setup({ runtimeBots: [], hermesProfiles: [scoutRow, lunaRow] });
    const turn = await blockedTurn(h, ["scout", "luna"]);

    for (const event of [
      { kind: "approval", threadId: turn.threadId, turnId: turn.turnId, approvalId: "a-1", callId: "c-1", name: "terminal:rm", status: "pending" },
      { kind: "clarify", threadId: turn.threadId, turnId: turn.turnId, clarifyId: "cl-1", prompt: "Which?", options: [{ id: "a", label: "A" }], status: "pending" },
      { kind: "tool", threadId: turn.threadId, turnId: turn.turnId, callId: "c-1", name: "read_file", status: "running" },
    ]) {
      // Acknowledged, exactly as before: a dropped projection must never dead-letter the stream.
      expect(h.push(turn.agentId, event)).toBe(true);
    }

    expect(h.storage.pendingNativeApprovals([turn.agentId], 100)).toEqual([]);
    expect(h.storage.pendingNativeClarifications([turn.agentId], 100)).toEqual([]);
    expect(h.frames.some((frame) =>
      frame.type === "bot_approval_pending" || frame.type === "bot_clarify_pending" || frame.type === "bot_tool_activity",
    )).toBe(false);
    expect(h.bridge.groups()[0]?.pendingInteractions).toBeUndefined();
  });
});

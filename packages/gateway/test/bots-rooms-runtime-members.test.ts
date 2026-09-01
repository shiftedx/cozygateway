import { afterEach, describe, expect, it } from "vitest";
import type { BotChatDeltaFrame, BotSummary, ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { GroupRooms } from "../src/hermes-bridge/group-rooms.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 46: a config-declared runtime bot is a first-class room member. Nothing about a room
 *  needs the Hermes Dashboard once membership stops being resolved there: the member turn is a
 *  plain attach-v1 command on a gateway-owned `group:<room>:<member>` thread, which a runtime peer
 *  answers exactly as a Hermes-backed profile does.
 *
 *  These tests pin the two facts that make that true, and the third the wire needed: membership is
 *  answered from the runtime set with no RPC, the reply lands as a room message under the runtime
 *  row's display name, and a room-turn draft reaches clients as `bot_chat_delta` carrying `room`. */

const NOW = 1_800_000_000_000;

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: Storage[] = [];

afterEach(async () => {
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

/** The one Hermes profile this gateway serves. `sage` is deliberately absent: a runtime bot never
 *  appears in `profiles.list`, which is the whole reason membership had to stop being asked there. */
const scoutRow = { name: "scout", description: "watches CI", has_avatar: false };

/** The roster row a runtime bot gets, in the shape `NativeBotDataPlane.rosterBots` appends. The
 *  bridge learns a runtime member's display name and handle from exactly this row. */
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
  server: FakeHermesServer;
  bridge: HermesBridge;
  storage: Storage;
  client: HermesClient;
  /** Every attach turn command the rooms handed to the transport, in dispatch order. */
  commands: Array<{ agentId: string; threadId: string; turnId: string; messageId: string; text: string }>;
  frames: ServerFrame[];
}

/** A bridge whose rooms speak to a fake attach transport. Every member replies with `reply`, so a
 *  runtime member and a Hermes member are distinguished only by which one Hermes has ever heard
 *  of. */
async function setup(
  opts: { runtimeBotNames?: readonly string[]; reply?: (agentId: string) => string } = {},
): Promise<Harness> {
  const server = await startFakeHermesServer({
    methods: { "profiles.list": () => ({ profiles: [scoutRow], bot_mode_protocol: true }) },
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
  // Production wiring: the native data plane hands its overlay back, and that overlay is where a
  // runtime bot's row exists at all.
  bridge.setRosterOverlay((bots) => [...bots, sageRow]);

  const commands: Harness["commands"] = [];
  const reply = opts.reply ?? ((agentId: string) => `${agentId} is ready.`);
  bridge.setGroupNativeTurns({
    canQueue: () => true,
    sendNativeTurn: (agentId, command) => {
      commands.push({ agentId, ...command });
      queueMicrotask(() => {
        bridge.handleGroupAttachEvent(agentId, {
          kind: "event",
          sequence: commands.length,
          eventId: `commit:${command.turnId}`,
          event: {
            kind: "commit",
            threadId: command.threadId,
            turnId: command.turnId,
            messageId: `reply:${command.turnId}`,
            blocks: [{ type: "paragraph", text: reply(agentId) }],
          },
        });
      });
      return true;
    },
  });
  bridge.start();
  await until(() => client.state() === "online");
  return { server, bridge, storage, client, commands, frames };
}

describe("rooms with runtime bot members", () => {
  it("admits a runtime bot beside a Hermes member and lands its reply as a room message", async () => {
    const { bridge, storage, commands } = await setup();

    const room = await bridge.createGroup("Launch", ["scout", "sage"]);
    expect(room.members).toEqual(["scout", "sage"]);

    bridge.sendGroupMessage("Launch", "plan the launch @scout @sage");
    await until(() => storage.botGroupLog("launch").length >= 3);

    // The runtime member is dispatched over the same gateway-owned group thread a Hermes member
    // gets: no Dashboard session, no separate lane.
    // The first round only: both members spoke, so the protocol runs a second one and the room is
    // still going. What this pins is the first pass over the membership.
    expect(commands.slice(0, 2).map((command) => [command.agentId, command.threadId])).toEqual([
      ["scout", "group:launch:scout"],
      ["sage", "group:launch:sage"],
    ]);
    expect(
      storage.botGroupLog("launch").slice(0, 3).map((entry) => [entry.name, entry.displayName, entry.text]),
    ).toEqual([
      ["You", "You", "plan the launch @scout @sage"],
      ["scout", "Scout", "scout is ready."],
      // The display name comes from the runtime row, not from the profile name it does not have.
      ["sage", "Sage", "sage is ready."],
    ]);
  });

  it("creates a room of only runtime bots without asking Hermes who its members are", async () => {
    const { bridge, server, storage } = await setup({ runtimeBotNames: ["sage", "pixel"] });

    const before = server.callsOf("profiles.list").length;
    const room = await bridge.createGroup("Studio", ["sage", "pixel"]);
    expect(room.members).toEqual(["sage", "pixel"]);
    // Membership was answered entirely from the runtime set. A gateway with no Hermes at all can
    // still run this room, which is the point of the capability.
    expect(server.callsOf("profiles.list").length).toBe(before);

    bridge.sendGroupMessage("Studio", "kick off @sage @pixel");
    await until(() => storage.botGroupLog("studio").length >= 3);
    expect(storage.botGroupLog("studio").slice(0, 3).map((entry) => entry.name)).toEqual([
      "You",
      "sage",
      "pixel",
    ]);
    // The "no longer a bot here" branch must never fire for a runtime member: it is not in the
    // roster cache Hermes fills, and the runtime set is what keeps it present.
    expect(storage.botGroupLog("studio").some((entry) => entry.text.includes("no longer a bot"))).toBe(false);
  });

  it("still refuses a room naming a bot that is neither a Hermes profile nor a runtime bot", async () => {
    const { bridge } = await setup();
    await expect(bridge.createGroup("Ghosts", ["scout", "nobody"])).rejects.toThrow(
      /not a bot on this gateway: nobody/,
    );
  });
});

describe("room turn drafts", () => {
  it("projects a member draft as a bot_chat_delta carrying the room", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const frames: ServerFrame[] = [];
    let rooms: GroupRooms;
    rooms = new GroupRooms({
      storage,
      now: () => NOW,
      broadcast: (frame) => frames.push(frame),
      memberInfo: (name) => ({ name, handle: name, displayName: name }),
      missingMembers: async () => [],
      nativeTurns: {
        canQueue: () => true,
        sendNativeTurn: (agentId, command) => {
          queueMicrotask(() => {
            for (const [index, text] of ["Loo", "Looks good"].entries()) {
              rooms.handleAttachEvent(agentId, {
                kind: "event",
                sequence: index + 1,
                eventId: `draft:${command.turnId}:${index}`,
                event: {
                  kind: "draft",
                  threadId: command.threadId,
                  turnId: command.turnId,
                  blocks: [{ type: "paragraph", text }],
                },
              });
            }
            rooms.handleAttachEvent(agentId, {
              kind: "event",
              sequence: 3,
              eventId: `commit:${command.turnId}`,
              event: {
                kind: "commit",
                threadId: command.threadId,
                turnId: command.turnId,
                messageId: `reply:${command.turnId}`,
                blocks: [{ type: "paragraph", text: "Looks good" }],
              },
            });
          });
          return true;
        },
      },
      pollMs: 1,
      turnTimeoutMs: 500,
      chainDelayMs: 0,
    });

    await rooms.create("Launch", ["scout", "luna"]);
    rooms.send("Launch", "status please @scout");
    await rooms.settled("Launch");

    const deltas = frames.filter((frame): frame is BotChatDeltaFrame => frame.type === "bot_chat_delta");
    expect(deltas.map((delta) => [delta.bot, delta.room, delta.sessionId, delta.text, delta.seq])).toEqual([
      ["scout", "Launch", "group:launch:scout", "Loo", 1],
      ["scout", "Launch", "group:launch:scout", "Looks good", 2],
    ]);
    // One turn id for both, so a client accumulates them into one live bubble.
    expect(new Set(deltas.map((delta) => delta.turnId)).size).toBe(1);

    await rooms.close();
  });

  it("keeps tool and thinking events on a room turn off the wire", async () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    const frames: ServerFrame[] = [];
    let rooms: GroupRooms;
    rooms = new GroupRooms({
      storage,
      now: () => NOW,
      broadcast: (frame) => frames.push(frame),
      memberInfo: (name) => ({ name, handle: name, displayName: name }),
      missingMembers: async () => [],
      nativeTurns: {
        canQueue: () => true,
        sendNativeTurn: (agentId, command) => {
          queueMicrotask(() => {
            // Accepted (the turn owns it) but not projected: room-turn tool and thinking
            // projection is deliberately out of this capability.
            expect(
              rooms.handleAttachEvent(agentId, {
                kind: "event",
                sequence: 1,
                eventId: `thinking:${command.turnId}`,
                event: {
                  kind: "thinking",
                  threadId: command.threadId,
                  turnId: command.turnId,
                  seq: 1,
                  text: "weighing options",
                  lastActiveAt: NOW,
                },
              }),
            ).toBe(true);
            rooms.handleAttachEvent(agentId, {
              kind: "event",
              sequence: 2,
              eventId: `commit:${command.turnId}`,
              event: {
                kind: "commit",
                threadId: command.threadId,
                turnId: command.turnId,
                messageId: `reply:${command.turnId}`,
                blocks: [{ type: "paragraph", text: "Done." }],
              },
            });
          });
          return true;
        },
      },
      pollMs: 1,
      turnTimeoutMs: 500,
      chainDelayMs: 0,
    });

    await rooms.create("Launch", ["scout", "luna"]);
    rooms.send("Launch", "status please @scout");
    await rooms.settled("Launch");

    expect(frames.some((frame) => frame.type === "bot_thinking_activity")).toBe(false);
    expect(frames.some((frame) => frame.type === "bot_chat_delta")).toBe(false);

    await rooms.close();
  });
});

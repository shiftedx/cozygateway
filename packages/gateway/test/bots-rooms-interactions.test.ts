import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** A Hermes member's room turn drops approval, clarify and tool events.
 *
 *  The Hermes plugin has never been asked to raise an approval inside a room, so a room
 *  acknowledges those events and projects nothing: a dropped projection must never dead-letter the
 *  member's stream. */

const NOW = 1_800_000_000_000;

const scoutRow = { name: "scout", description: "watches CI", has_avatar: false };
const lunaRow = { name: "luna", description: "reads the docs", has_avatar: false };

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
}

/** Rooms that HOLD a member turn: nothing settles until a test says so. */
async function setup(): Promise<Harness> {
  const server = await startFakeHermesServer({
    methods: { "profiles.list": () => ({ profiles: [scoutRow, lunaRow], bot_mode_protocol: true }) },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const frames: ServerFrame[] = [];
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => { frames.push(frame); },
    now: () => NOW,
    logSink: () => {},
  });
  bridges.push(bridge);
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

describe("a Hermes member's room turn", () => {
  it("is left exactly as it was", async () => {
    const h = await setup();
    await h.bridge.createGroup("Launch", ["scout", "luna"]);
    h.bridge.sendGroupMessage("Launch", "ship it @scout @luna");
    await until(() => h.commands.length > 0);
    const turn = h.commands[0]!;

    for (const event of [
      { kind: "approval", threadId: turn.threadId, turnId: turn.turnId, approvalId: "a-1", callId: "c-1", name: "terminal:rm", status: "pending" },
      { kind: "clarify", threadId: turn.threadId, turnId: turn.turnId, clarifyId: "cl-1", prompt: "Which?", options: [{ id: "a", label: "A" }], status: "pending" },
      { kind: "tool", threadId: turn.threadId, turnId: turn.turnId, callId: "c-1", name: "read_file", status: "running" },
    ]) {
      // Acknowledged: a dropped projection must never dead-letter the stream.
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

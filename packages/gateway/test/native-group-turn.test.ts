import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStorage } from "../src/storage.ts";
import { GroupRooms } from "../src/hermes-bridge/group-rooms.ts";

describe("native group turns", () => {
  it("uses a durable gateway thread and accepts the matching attach commit", async () => {
    const storage = openStorage(":memory:");
    let rooms: GroupRooms;
    const commands: Array<{ agentId: string; threadId: string; turnId: string; messageId: string; text: string }> = [];
    rooms = new GroupRooms({
      storage,
      now: () => Date.now(),
      broadcast: () => undefined,
      memberInfo: (name) => ({ name, handle: name, displayName: name }),
      missingMembers: async () => [],
      nativeTurns: {
        canQueue: () => true,
        sendNativeTurn: (agentId, command) => {
          commands.push({ agentId, ...command });
          setTimeout(() => rooms.handleAttachEvent(agentId, {
            kind: "event", sequence: 1, eventId: `commit:${command.turnId}`,
            event: { kind: "commit", threadId: command.threadId, turnId: command.turnId,
              messageId: `reply:${command.turnId}`, blocks: [{ type: "paragraph", text: "I can take this." }] },
          }), 0);
          return true;
        },
      },
      pollMs: 1,
      turnTimeoutMs: 100,
    });
    await rooms.create("Launch", ["scout", "luna"]);
    rooms.send("Launch", "Please decide @scout");
    await rooms.settled("Launch");

    expect(commands[0]?.threadId).toBe("group:launch:scout");
    expect(storage.botGroupLog("launch").some((entry) => entry.text === "I can take this.")).toBe(true);
    await rooms.close();
    storage.close();
  });

  it("keeps deleted-turn ownership as a tombstone, so a late replay is acknowledged", async () => {
    const storage = openStorage(":memory:");
    let command: { agentId: string; threadId: string; turnId: string; messageId: string } | undefined;
    const rooms = new GroupRooms({
      storage, now: () => Date.now(), broadcast: () => undefined,
      memberInfo: (name) => ({ name, handle: name, displayName: name }), missingMembers: async () => [],
      nativeTurns: { canQueue: () => true, sendNativeTurn: (agentId, turn) => { command = { agentId, ...turn }; return true; } },
      pollMs: 1, turnTimeoutMs: 100, chainDelayMs: 0,
    });
    await rooms.create("Launch", ["scout", "luna"]);
    rooms.send("Launch", "@scout please answer");
    await new Promise((resolve) => setTimeout(resolve, 5));
    rooms.remove("Launch");
    expect(command).toBeDefined();
    const late = command!;
    expect(rooms.handleAttachEvent(late.agentId, {
      kind: "event", sequence: 1, eventId: "late", event: {
        kind: "commit", threadId: late.threadId, turnId: late.turnId, messageId: "late-message",
        blocks: [{ type: "paragraph", text: "too late" }],
      },
    })).toBe(true);
    await rooms.close();
    storage.close();
  });

  it("runs each addressed member over attach, persists their replies, and omits passes", async () => {
    const storage = openStorage(":memory:");
    let rooms: GroupRooms;
    const commands: Array<{ agentId: string; threadId: string; turnId: string; text: string }> = [];
    rooms = new GroupRooms({
      storage,
      now: () => Date.now(),
      broadcast: () => undefined,
      memberInfo: (name) => ({ name, handle: name, displayName: name }),
      missingMembers: async () => [],
      nativeTurns: {
        canQueue: () => true,
        sendNativeTurn: (agentId, command) => {
          commands.push({ agentId, ...command });
          const text = agentId === "scout" ? "CI is green." : "(pass)";
          queueMicrotask(() => rooms.handleAttachEvent(agentId, {
            kind: "event",
            sequence: commands.length,
            eventId: `commit:${command.turnId}`,
            event: {
              kind: "commit",
              threadId: command.threadId,
              turnId: command.turnId,
              messageId: `reply:${command.turnId}`,
              blocks: [{ type: "paragraph", text }],
            },
          }));
          return true;
        },
      },
      pollMs: 1,
      turnTimeoutMs: 100,
      chainDelayMs: 0,
    });

    await rooms.create("Release", ["scout", "luna"]);
    rooms.send("Release", "Please check @scout and @luna");
    await rooms.settled("Release");

    expect(commands.map((command) => command.agentId)).toEqual(["scout", "luna"]);
    expect(commands.map((command) => command.threadId)).toEqual(["group:release:scout", "group:release:luna"]);
    expect(storage.botGroupLog("release").map((entry) => [entry.name, entry.text])).toEqual([
      ["You", "Please check @scout and @luna"],
      ["scout", "CI is green."],
    ]);
    await rooms.close();
    storage.close();
  });

  it("keeps the gateway-local room transcript across a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "native-group-restart-")), "gateway.sqlite");
    let storage = openStorage(path);
    let rooms: GroupRooms;
    rooms = new GroupRooms({
      storage, now: () => Date.now(), broadcast: () => undefined,
      memberInfo: (name) => ({ name, handle: name, displayName: name }), missingMembers: async () => [],
      nativeTurns: {
        canQueue: () => true,
        sendNativeTurn: (agentId, command) => {
          queueMicrotask(() => rooms.handleAttachEvent(agentId, {
            kind: "event", sequence: 1, eventId: "commit", event: {
              kind: "commit", threadId: command.threadId, turnId: command.turnId,
              messageId: "reply", blocks: [{ type: "paragraph", text: "Ready." }],
            },
          }));
          return true;
        },
      },
      pollMs: 1, turnTimeoutMs: 100, chainDelayMs: 0,
    });
    await rooms.create("Launch", ["sage", "pixel"]);
    rooms.send("Launch", "Are we ready @sage?");
    await rooms.settled("Launch");
    await rooms.close();
    storage.close();

    storage = openStorage(path);
    expect(storage.botGroup("launch")?.members).toEqual(["sage", "pixel"]);
    expect(storage.botGroupLog("launch").map((entry) => entry.text)).toEqual(["Are we ready @sage?", "Ready."]);
    storage.close();
  });
});

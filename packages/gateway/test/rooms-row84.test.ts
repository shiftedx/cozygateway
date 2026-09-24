import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { BotGroupStateFrame, ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { GroupBusy, GroupExists, GroupInvalid, GroupRooms } from "../src/hermes-bridge/group-rooms.ts";
import {
  applyHoldDirective,
  classifyHoldDirective,
  heldSeqs,
  isSlashCommand,
} from "../src/hermes-bridge/group-protocol.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";

/** Capability 84: rooms reach Desktop parity. */

interface Command { agentId: string; threadId: string; turnId: string; text: string }

/** A room whose members answer from `reply`, synchronously on a microtask unless `manual`. */
function harness(opts: { reply?: (agentId: string, text: string) => string; manual?: boolean } = {}) {
  const storage: Storage = openStorage(":memory:");
  const frames: ServerFrame[] = [];
  const commands: Command[] = [];
  const interrupts: Array<{ agentId: string; threadId: string; turnId: string }> = [];
  let rooms: GroupRooms;
  const commit = (command: Command, text: string): void => {
    rooms.handleAttachEvent(command.agentId, {
      kind: "event", sequence: commands.length, eventId: `commit:${command.turnId}`,
      event: { kind: "commit", threadId: command.threadId, turnId: command.turnId, messageId: `reply:${command.turnId}`,
        blocks: [{ type: "paragraph", text }] },
    });
  };
  rooms = new GroupRooms({
    storage,
    now: () => Date.now(),
    broadcast: (frame) => frames.push(frame),
    memberInfo: (name) => ({ name, handle: name, displayName: name }),
    missingMembers: async (names) => names.filter((name) => name === "ghost"),
    nativeTurns: {
      canQueue: () => true,
      sendNativeTurn: (agentId, command) => {
        const recorded = { agentId, ...command };
        commands.push(recorded);
        if (opts.manual !== true) queueMicrotask(() => commit(recorded, opts.reply?.(agentId, command.text) ?? "(pass)"));
        return true;
      },
      sendInterrupt: (agentId, input) => { interrupts.push({ agentId, ...input }); return true; },
    },
    pollMs: 1, turnTimeoutMs: 500, chainDelayMs: 0,
  });
  const states = (): BotGroupStateFrame[] => frames.filter((frame): frame is BotGroupStateFrame => frame.type === "bot_group_state");
  return { storage, rooms, frames, states, commands, interrupts, commit };
}

describe("row 84 protocol", () => {
  it("classifies stop directives next to mentions and ignores quoted or coded stops", () => {
    expect(classifyHoldDirective("stop @luna", ["luna"], false)).toMatchObject({ hold: ["luna"] });
    expect(classifyHoldDirective("@luna please halt", ["luna"], false)).toMatchObject({ hold: ["luna"] });
    expect(classifyHoldDirective("@all pause", [], true)).toMatchObject({ holdAll: true });
    // Distant stop word: neutral.
    expect(classifyHoldDirective("@luna go on, this is a test that we will not stop", ["luna"], false))
      .toEqual({ hold: [], holdAll: false, release: [], releaseAll: false });
    expect(classifyHoldDirective("@luna resume", ["luna"], false)).toMatchObject({ release: ["luna"] });
    expect(classifyHoldDirective("@all carry on", [], true)).toMatchObject({ releaseAll: true });
    expect(classifyHoldDirective("@luna see `stop`", ["luna"], false)).toMatchObject({ hold: [], release: ["luna"] });
    expect(classifyHoldDirective('@luna the sign says "stop"', ["luna"], false).hold).toEqual([]);
    expect(classifyHoldDirective("@luna\n> stop\nthanks", ["luna"], false).hold).toEqual([]);
    expect(classifyHoldDirective("@luna\n```\nstop\n```", ["luna"], false).hold).toEqual([]);
  });

  it("applies holds, keeps the object when nothing changes, and bounds held replay", () => {
    const none = {};
    expect(applyHoldDirective(none, { everyone: false, members: new Set() }, "hi", { at: 1 }, ["a"])).toBe(none);
    const held = applyHoldDirective(none, { everyone: true, members: new Set() }, "@all stop", { at: 1 }, ["a", "b"]);
    expect(Object.keys(held)).toEqual(["a", "b"]);
    expect(applyHoldDirective(held, { everyone: false, members: new Set(["a"]) }, "@a go", { at: 2 }, ["a", "b"]))
      .toEqual({ b: { at: 1 } });
    const seqs = heldSeqs([], Array.from({ length: 40 }, (_, index) => index + 1));
    expect(seqs).toHaveLength(24);
    expect(seqs[0]).toBe(1);
    expect(seqs.at(-1)).toBe(40);
  });

  it("recognizes slash commands but not paths", () => {
    expect(isSlashCommand("/compress")).toBe(true);
    expect(isSlashCommand("/new please")).toBe(true);
    expect(isSlashCommand("/etc/hosts is broken")).toBe(false);
  });
});

describe("row 84 rooms engine", () => {
  it("threads: a root send starts its own thread, members answer in it, a reply joins it", async () => {
    const h = harness({ reply: (agent, text) => (agent === "scout" && !text.includes("(you)") ? "on it" : "(pass)") });
    await h.rooms.create("Launch", ["scout", "luna"]);
    const root = h.rooms.send("Launch", "Plan it @scout");
    expect(root.threadId).toBe(root.messageId);
    await h.rooms.settled("Launch");
    const reply = h.storage.botGroupLog("launch").find((row) => row.name === "scout")!;
    expect(reply.threadId).toBe(root.threadId);
    const other = h.rooms.send("Launch", "Unrelated @luna");
    await h.rooms.settled("Launch");
    // Luna's prompt in the new thread carries none of the first thread.
    const luna = h.commands.filter((command) => command.agentId === "luna").at(-1)!;
    expect(luna.text).toContain("Unrelated @luna");
    expect(luna.text).not.toContain("Plan it");
    const threaded = h.rooms.send("Launch", "And the budget? @scout", { threadId: root.threadId! });
    expect(threaded.threadId).toBe(root.threadId);
    expect(other.threadId).not.toBe(root.threadId);
    await h.rooms.settled("Launch");
    const state = h.states();
    expect(state.some((frame) => frame.activity?.kind === "working" && frame.activity.member === "scout")).toBe(true);
    expect(state.some((frame) => frame.activity?.kind === "replied")).toBe(true);
    expect(state.some((frame) => frame.activity?.kind === "passed")).toBe(true);
    await h.rooms.close();
    h.storage.close();
  });

  it("holds a member told to stop, skips it, and replays what it missed once released", async () => {
    const h = harness({ reply: () => "(pass)" });
    await h.rooms.create("Launch", ["scout", "luna"]);
    h.rooms.send("Launch", "stop @luna");
    await h.rooms.settled("Launch");
    expect(h.rooms.list()[0]?.holds).toEqual(["luna"]);
    expect(h.states().some((frame) => frame.room?.holds?.includes("luna") === true)).toBe(true);
    h.rooms.send("Launch", "Missed this one");
    await h.rooms.settled("Launch");
    expect(h.commands.filter((command) => command.agentId === "luna")).toHaveLength(0);
    expect(h.states().filter((frame) => frame.activity?.kind === "held" && frame.activity.member === "luna")).toHaveLength(1);
    h.rooms.send("Launch", "@luna you can talk now");
    await h.rooms.settled("Launch");
    expect(h.rooms.list()[0]?.holds).toBeUndefined();
    const luna = h.commands.find((command) => command.agentId === "luna")!;
    expect(luna.text).toContain("Missed this one");
    expect(luna.text).toContain("you can talk now");
    await h.rooms.close();
    h.storage.close();
  });

  it("refuses slash commands", async () => {
    const h = harness();
    await h.rooms.create("Launch", ["scout", "luna"]);
    expect(() => h.rooms.send("Launch", "/new")).toThrow(GroupInvalid);
    h.rooms.send("Launch", "/etc/hosts looks odd");
    await h.rooms.settled("Launch");
    await h.rooms.close();
    h.storage.close();
  });

  it("stop interrupts the member on turn, holds everyone, and leaves no failure note", async () => {
    const h = harness({ manual: true });
    await h.rooms.create("Launch", ["scout", "luna"]);
    h.rooms.send("Launch", "Think hard @scout");
    await expect.poll(() => h.commands.length).toBe(1);
    const stopped = h.rooms.stop("Launch");
    expect(stopped.holds).toEqual(["scout", "luna"]);
    expect(h.interrupts).toEqual([{ agentId: "scout", threadId: h.commands[0]!.threadId, turnId: h.commands[0]!.turnId }]);
    await h.rooms.settled("Launch");
    expect(h.states().some((frame) => frame.activity?.kind === "stopped" && frame.activity.member === "You")).toBe(true);
    expect(h.states().some((frame) => frame.note?.reason === "failed")).toBe(false);
    expect(h.rooms.running("Launch")).toBe(false);
    // A late terminal for the cancelled turn posts nothing.
    h.commit(h.commands[0]!, "too late");
    expect(h.storage.botGroupLog("launch").map((row) => row.text)).toEqual(["Think hard @scout"]);
    await h.rooms.close();
    h.storage.close();
  });

  it("renames without moving the room, frees the old name, and edits members, picture and detection", async () => {
    const h = harness();
    await h.rooms.create("Launch", ["scout", "luna"]);
    await h.rooms.create("Other", ["scout", "luna"]);
    await expect(h.rooms.update("Launch", { name: "other" })).rejects.toBeInstanceOf(GroupExists);
    const renamed = await h.rooms.update("Launch", { name: "Release" });
    expect(renamed.name).toBe("Release");
    // The identity a client keys order and sections on survives the rename.
    expect(renamed.id).toBe("launch");
    expect(h.states().at(-1)).toMatchObject({ group: "Release", renamedFrom: "Launch", room: { name: "Release" } });
    expect(h.rooms.detail("release").name).toBe("Release");
    const again = await h.rooms.create("Launch", ["scout", "luna"]);
    expect(again.name).toBe("Launch");
    expect(h.storage.botGroup("launch~2")?.name).toBe("Launch");
    await expect(h.rooms.update("Release", { members: ["scout", "ghost"] })).rejects.toBeInstanceOf(GroupInvalid);
    expect((await h.rooms.update("Release", { members: ["scout", "luna", "sage"] })).members).toEqual(["scout", "luna", "sage"]);
    await expect(h.rooms.update("Release", { picture: "data:text/html;base64,AAAA" })).rejects.toBeInstanceOf(GroupInvalid);
    expect((await h.rooms.update("Release", { picture: "data:image/png;base64,iVBORw0KGgo=" })).picture).toContain("data:image/png");
    expect((await h.rooms.update("Release", { picture: null })).picture).toBeUndefined();
    h.rooms.send("Release", "stop @sage");
    await h.rooms.settled("Release");
    const off = await h.rooms.update("Release", { holdDetection: false });
    expect(off.holdDetection).toBe(false);
    expect(off.holds).toBeUndefined();
    await h.rooms.close();
    h.storage.close();
  });

  it("compresses one member's room thread without posting into the room, and refuses while running", async () => {
    const h = harness({ reply: (_agent, text) => (text === "/compress" ? "Compressed 40 → 6 messages" : "(pass)") });
    await h.rooms.create("Launch", ["scout", "luna"]);
    const done = await h.rooms.compress("Launch", "scout");
    expect(done).toEqual({ member: "scout", text: "Compressed 40 → 6 messages" });
    expect(h.commands[0]).toMatchObject({ agentId: "scout", threadId: "group:launch:scout", text: "/compress" });
    expect(h.storage.botGroupLog("launch")).toEqual([]);
    const busy = harness({ manual: true });
    await busy.rooms.create("Busy", ["scout", "luna"]);
    busy.rooms.send("Busy", "hi @scout");
    await expect(busy.rooms.compress("Busy", "scout")).rejects.toBeInstanceOf(GroupBusy);
    busy.rooms.stop("Busy");
    await busy.rooms.close();
    busy.storage.close();
    await h.rooms.close();
    h.storage.close();
  });

  it("mirrors a member's external write on its room thread once", async () => {
    const h = harness({ reply: () => "hello" });
    await h.rooms.create("Launch", ["scout", "luna"]);
    const root = h.rooms.send("Launch", "hi @scout");
    await h.rooms.settled("Launch");
    const frame = {
      kind: "event" as const, sequence: 99, eventId: "cron",
      event: { kind: "commit" as const, threadId: "group:launch:scout", turnId: "cron-turn", messageId: "cron-msg",
        blocks: [{ type: "paragraph" as const, text: "Nightly report: all green" }] },
    };
    expect(h.rooms.canAcceptAttachEvent("scout", frame)).toBe(true);
    expect(h.rooms.canAcceptAttachEvent("luna", frame)).toBe(false);
    expect(h.rooms.handleAttachEvent("scout", frame)).toBe(true);
    expect(h.rooms.handleAttachEvent("scout", frame)).toBe(true);
    const mirrored = h.rooms.detail("Launch").messages.filter((message) => message.external === true);
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]).toMatchObject({ text: "Nightly report: all green", threadId: root.threadId, from: { name: "scout" } });
    await h.rooms.close();
    h.storage.close();
  });
});

describe("row 84 routes", () => {
  it("queues a send made during compress and drives it once compress settles", async () => {
    const h = harness({ manual: true });
    await h.rooms.create("Launch", ["scout", "luna"]);
    const compressing = h.rooms.compress("Launch", "scout");
    await expect.poll(() => h.commands.length).toBe(1);
    h.rooms.send("Launch", "anyone there?");
    // Nothing is handed over while the compress turn holds the room.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.commands.map((command) => command.text)).toEqual(["/compress"]);
    h.commit(h.commands[0]!, "Compressed.");
    await compressing;
    await expect.poll(() => h.commands.length).toBeGreaterThan(1);
    for (const command of h.commands.slice(1)) h.commit(command, "(pass)");
    await expect.poll(() => h.commands.length).toBe(3);
    h.commit(h.commands[2]!, "(pass)");
    await h.rooms.settled("Launch");
    expect(h.states().some((frame) => frame.note?.detail.includes("already pending"))).toBe(false);
    expect(h.commands.slice(1).map((command) => command.agentId).sort()).toEqual(["luna", "scout"]);
  });

  it("keeps a queued thread across a restart and drives it on recovery", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "rooms-row84-restart-")), "gateway.sqlite");
    let storage = openStorage(path);
    const first = new GroupRooms({
      storage, now: () => Date.now(), broadcast: () => undefined,
      memberInfo: (name) => ({ name, handle: name, displayName: name }), missingMembers: async () => [],
      nativeTurns: { canQueue: () => true, sendNativeTurn: () => true },
      pollMs: 1, turnTimeoutMs: 60_000, chainDelayMs: 0,
    });
    await first.create("Launch", ["scout", "luna"]);
    first.send("Launch", "first @scout");
    await new Promise((resolve) => setTimeout(resolve, 10));
    first.send("Launch", "queued @luna");
    await first.close();
    storage.close();

    storage = openStorage(path);
    const commands: Command[] = [];
    let second: GroupRooms;
    second = new GroupRooms({
      storage, now: () => Date.now(), broadcast: () => undefined,
      memberInfo: (name) => ({ name, handle: name, displayName: name }), missingMembers: async () => [],
      nativeTurns: {
        canQueue: () => true,
        sendNativeTurn: (agentId, command) => {
          commands.push({ agentId, ...command });
          queueMicrotask(() => second.handleAttachEvent(agentId, {
            kind: "event", sequence: commands.length, eventId: `c:${command.turnId}`,
            event: { kind: "commit", threadId: command.threadId, turnId: command.turnId, messageId: `r:${command.turnId}`,
              blocks: [{ type: "paragraph", text: "(pass)" }] },
          }));
          return true;
        },
      },
      pollMs: 1, turnTimeoutMs: 500, chainDelayMs: 0,
    });
    // The first turn's late commit arrives after the restart and recovery resumes the room.
    const pending = storage.pendingBotGroupTurns()[0]!;
    second.handleAttachEvent(pending.agentId, {
      kind: "event", sequence: 1, eventId: "late", event: { kind: "commit", threadId: pending.threadId,
        turnId: pending.turnId, messageId: "late", blocks: [{ type: "paragraph", text: "(pass)" }] },
    });
    await expect.poll(() => commands.some((command) => command.agentId === "luna")).toBe(true);
    await second.settled("Launch");
    await second.close();
    storage.close();
  });

  it("checks rename uniqueness after the members await, case-folded in JavaScript", async () => {
    const h = harness();
    await h.rooms.create("Launch", ["scout", "luna"]);
    await h.rooms.create("Other", ["scout", "luna"]);
    const renaming = h.rooms.update("Launch", { name: "Release", members: ["scout", "luna"] });
    await h.rooms.update("Other", { name: "RELEASE" });
    await expect(renaming).rejects.toBeInstanceOf(GroupExists);
    // SQLite's lower() folds ASCII only; the room key folds in JavaScript.
    await h.rooms.create("Émile", ["scout", "luna"]);
    await expect(h.rooms.create("émile", ["scout", "luna"])).rejects.toBeInstanceOf(GroupExists);
    await expect(h.rooms.update("Other", { name: "ÉMILE" })).rejects.toBeInstanceOf(GroupExists);
  });

  it("serves PATCH, stop, compress and picture with the room error mapping", async () => {
    const h = harness({ reply: () => "done" });
    await h.rooms.create("Launch", ["scout", "luna"]);
    const surface = {
      updateGroup: (name: string, patch: Parameters<GroupRooms["update"]>[1]) => h.rooms.update(name, patch),
      stopGroup: (name: string) => h.rooms.stop(name),
      compressGroupMember: (name: string, member: string) => h.rooms.compress(name, member),
      generateGroupPicture: async (prompt: string) => `data:image/png;base64,${Buffer.from(prompt).toString("base64")}`,
    } as unknown as BotsSurface;
    const app = new Hono();
    const allow: MiddlewareHandler = async (_c, next) => { await next(); };
    registerBotRoutes(app as never, allow as never, surface);
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

    const patched = await call("PATCH", "/bots/groups/Launch", { name: "Release", holdDetection: false });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ group: { name: "Release", holdDetection: false } });
    expect((await call("PATCH", "/bots/groups/Release", {})).status).toBe(400);
    expect((await call("PATCH", "/bots/groups/Nope", { name: "x" })).status).toBe(404);
    expect((await call("POST", "/bots/groups/Release/stop", {})).status).toBe(200);
    const compressed = await call("POST", "/bots/groups/Release/compress", { member: "scout" });
    expect(compressed.status).toBe(200);
    expect(await compressed.json()).toEqual({ member: "scout", text: "done" });
    const picture = await call("POST", "/bots/groups/picture", { prompt: "team" });
    expect(await picture.json()).toEqual({ image: "data:image/png;base64,dGVhbQ==" });
    await h.rooms.close();
    h.storage.close();
  });
});

describe("a member renamed while its room is talking", () => {
  const until = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  it("never hands the stale name a turn and seats the new name next round", async () => {
    const h = harness({ manual: true });
    await h.rooms.create("Crew", ["scout", "luna"]);
    h.rooms.send("Crew", "morning everyone");
    await until(() => h.commands.length === 1);
    // Another member's turn is running when the rename lands.
    const first = h.commands[0]!;
    const renamed = first.agentId === "scout" ? "luna" : "scout";
    h.rooms.beginMemberRename(renamed);
    h.rooms.announceRooms(h.storage.renameBotState(renamed, "owl"));
    h.rooms.endMemberRename(renamed);
    const started = Date.now();
    h.commit(first, "hello");
    // Everyone after that passes; the owl gets its turn in the next round.
    let answered = 1;
    const drive = h.rooms.settled("Crew");
    const pump = setInterval(() => {
      while (answered < h.commands.length) h.commit(h.commands[answered++]!, "(pass)");
    }, 1);
    await drive;
    clearInterval(pump);
    // No turn for the stale name, no turn timeout, and no row written back under it.
    expect(h.commands.some((command) => command.agentId === renamed)).toBe(false);
    expect(h.commands.some((command) => command.agentId === "owl")).toBe(true);
    expect(Date.now() - started).toBeLessThan(400);
    expect(h.storage.botGroupMembers("crew").has(renamed)).toBe(false);
    expect(h.storage.botGroup("crew")?.members).toContain("owl");
    await h.rooms.close();
    h.storage.close();
  });

  it("a fenced member is skipped without a turn", async () => {
    const h = harness({ reply: () => "(pass)" });
    await h.rooms.create("Crew", ["scout", "luna"]);
    h.rooms.beginMemberRename("luna");
    h.rooms.send("Crew", "anyone?");
    await h.rooms.settled("Crew");
    expect(h.commands.map((command) => command.agentId)).toEqual(["scout"]);
    h.rooms.endMemberRename("luna");
    await h.rooms.close();
    h.storage.close();
  });

  it("a new bot given a renamed member's old name keeps its own thread ownership", async () => {
    const h = harness({ reply: () => "(pass)" });
    await h.rooms.create("Crew", ["scout", "luna"]);
    const thread = h.storage.ensureBotGroupThread("crew", "scout");
    h.storage.renameBotState("scout", "owl");
    // A fresh bot named `scout` joins and derives the very same thread id.
    h.storage.setBotGroupMembers("crew", ["owl", "luna", "scout"]);
    expect(h.storage.ensureBotGroupThread("crew", "scout")).toBe(thread);
    expect(h.storage.botGroupMemberBySession(thread, "owl")).toEqual({ key: "crew", member: "owl" });
    expect(h.storage.botGroupMemberBySession(thread, "scout")).toEqual({ key: "crew", member: "scout" });
    // An external commit on the new scout's thread mirrors as scout, never as owl.
    h.rooms.handleAttachEvent("scout", {
      kind: "event", sequence: 1, eventId: "ext-1",
      event: { kind: "commit", threadId: thread, turnId: "t-ext", messageId: "m-ext", blocks: [{ type: "paragraph", text: "from the new scout" }] },
    });
    const mirrored = h.storage.botGroupLog("crew").find((row) => row.external === true);
    expect(mirrored?.name).toBe("scout");
    await h.rooms.close();
    h.storage.close();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { BotInboxActivityFrame, ServerFrame } from "cozygateway-contract";

import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import { AssignmentRefused, AssignmentRooms } from "../src/hermes-bridge/assignments.ts";
import { openStorage, type Storage } from "../src/storage.ts";

const storages: Storage[] = [];
const rooms: AssignmentRooms[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.close();
  for (const storage of storages.splice(0)) storage.close();
});

const BOTS = ["lead", "scout", "sage", ...Array.from({ length: 9 }, (_, i) => `r${i}`)];
const REPLY = "Green.\nResult:\nstatus: done\nCI is green.\nartifacts: ci/log.txt";

/** A fake attach peer over the real durable journals: the command is enqueued (which admits the
 * Task) and acknowledged, and the reply is admitted to the event inbox (which moves the Task)
 * before the assignment reads it, in the order the ingress uses. */
function harness(opts: { reply?: string; silent?: boolean; attached?: (bot: string) => boolean } = {}) {
  let now = 1_000;
  const storage = openStorage(":memory:");
  storages.push(storage);
  storage.tasks.clock(() => now);
  const frames: ServerFrame[] = [];
  const commands: Array<{ agentId: string; threadId: string; turnId: string; text: string; context?: unknown }> = [];
  const sequences = new Map<string, number>();
  const room = new AssignmentRooms({
    storage, broadcast: (frame) => frames.push(frame), now: () => now,
    displayName: (name) => name[0]!.toUpperCase() + name.slice(1),
    knownBot: (name) => BOTS.includes(name),
    isAttached: opts.attached ?? (() => true),
    formatDeadline: () => "soon",
  });
  rooms.push(room);
  const event = (agentId: string, body: AttachV1EventFrame["event"]): void => {
    const sequence = (sequences.get(agentId) ?? 0) + 1;
    sequences.set(agentId, sequence);
    const frame = { kind: "event", sequence, eventId: `e-${agentId}-${sequence}`, event: body } as AttachV1EventFrame;
    expect(room.canAcceptAttachEvent(agentId, frame)).toBe(true);
    storage.acceptAttachEvent(agentId, frame, now);
    expect(room.handleAttachEvent(agentId, frame)).toBe(true);
  };
  room.setNativeTurns({
    sendNativeTurn: (agentId, input) => {
      commands.push({ agentId, threadId: input.threadId, turnId: input.turnId, text: input.text, context: input.context });
      const command = storage.enqueueAttachCommand(agentId, `cmd-${input.turnId}`, { kind: "turn", ...input }, now);
      queueMicrotask(() => {
        storage.ackAttachCommand(agentId, command.sequence, command.commandId, now);
        if (opts.silent !== true)
          event(agentId, { kind: "commit", threadId: input.threadId, turnId: input.turnId, messageId: `reply:${input.turnId}`, blocks: [{ type: "paragraph", text: opts.reply ?? REPLY }] });
      });
      return true;
    },
  });
  storage.setBotTeam({ bot: "lead", role: "leader", reports: ["scout", "sage"], updatedAt: now });
  return { storage, room, frames, commands, event, tick: (ms: number) => { now += ms; } };
}

const request = { to: "scout", brief: "Check CI", doneCriteria: "main is green" };
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("assign", () => {
  it("queues one turn on assignment:<taskId> with the prompt and task context, then verifies on the reply", async () => {
    const h = harness();
    const view = h.room.assign("lead", request);
    expect(view).toMatchObject({ leader: "lead", assignee: "scout", state: "queued", threadId: `assignment:${view.taskId}` });
    // One id: the assignment IS its Task.
    expect(h.storage.tasks.read(view.taskId)?.view).toMatchObject({ bot: "scout", sessionId: view.threadId });
    expect(h.commands[0]!.text.startsWith("[Task from Lead] Check CI\nDone when: main is green")).toBe(true);
    expect(h.commands[0]!.context).toMatchObject({ task: { id: view.taskId, assignedBy: "lead", deadlineAt: 1_000 + 30 * 60_000 } });
    await settle();
    expect(h.room.view(view.taskId)).toMatchObject({
      state: "verifying", finalText: expect.stringContaining("Green."),
      result: { status: "done", summary: "CI is green.", artifacts: ["ci/log.txt"] },
    });
    expect(h.room.inboxMessages("lead", view.threadId)!.map((message) => message.from.name)).toEqual(["lead", "scout"]);
    expect(h.room.inboxMessages("sage", view.threadId)).toBeUndefined();
    expect(h.room.inboxThreads("scout")).toEqual([expect.objectContaining({ id: view.threadId, peers: ["lead", "scout"], messageCount: 2 })]);
    const activity = h.frames.filter((frame): frame is BotInboxActivityFrame => frame.type === "bot_inbox_activity");
    expect(activity.map((frame) => frame.bot)).toEqual(expect.arrayContaining(["lead", "scout"]));
    expect(activity.at(-1)).toMatchObject({ taskId: view.taskId, state: "verifying" });
  });

  it("records a reply without a Result: block as missing, never invented", async () => {
    const h = harness({ reply: "It looks fine to me." });
    const view = h.room.assign("lead", request);
    await settle();
    const read = h.room.view(view.taskId)!;
    expect(read.state).toBe("verifying");
    expect(read.finalText).toBe("It looks fine to me.");
    expect(read.result).toBeUndefined();
  });

  it("refuses with typed reasons and creates nothing", () => {
    const h = harness({ attached: (bot) => bot !== "sage", silent: true });
    expect(() => h.room.assign("scout", request)).toThrow(expect.objectContaining({ reason: "not_leader" }));
    expect(() => h.room.assign("lead", { ...request, to: "nobody" })).toThrow(expect.objectContaining({ reason: "not_a_report" }));
    expect(() => h.room.assign("lead", { ...request, to: "sage" })).toThrow(expect.objectContaining({ reason: "assignee_unavailable" }));
    expect(h.storage.botAssignments()).toHaveLength(0);
    expect(h.room.assign("lead", request).state).toBe("queued");
    expect(() => h.room.assign("lead", request)).toThrow(AssignmentRefused);
    expect(() => h.room.assign("lead", request)).toThrow(expect.objectContaining({ reason: "assignee_busy" }));
  });

  it("leaves nothing behind when the attach transport refuses the turn", () => {
    const h = harness({ silent: true });
    h.room.setNativeTurns({ sendNativeTurn: () => false });
    expect(() => h.room.assign("lead", request)).toThrow(expect.objectContaining({ reason: "assignee_unavailable" }));
    expect(h.storage.botAssignments()).toHaveLength(0);
    expect(h.storage.tasks.list()).toHaveLength(0);
  });

  it("answers a repeated delivery with the same Task", () => {
    const h = harness({ silent: true });
    const first = h.room.assign("lead", { ...request, idempotencyKey: "k1" });
    expect(h.room.assign("lead", { ...request, idempotencyKey: "k1" }).taskId).toBe(first.taskId);
    expect(h.commands).toHaveLength(1);
    expect(() => h.room.assign("lead", { ...request, brief: "Other", idempotencyKey: "k1" })).toThrow(/idempotencyKey/);
  });

  it("caps a leader at eight open assignments", () => {
    const h = harness({ silent: true });
    h.storage.setBotTeam({ bot: "lead", role: "leader", reports: Array.from({ length: 9 }, (_, i) => `r${i}`), updatedAt: 1 });
    for (let i = 0; i < 8; i++) h.room.assign("lead", { ...request, to: `r${i}` });
    expect(() => h.room.assign("lead", { ...request, to: "r8" })).toThrow(expect.objectContaining({ reason: "leader_task_cap" }));
  });
});

describe("deadline, failure, cancel, acknowledge", () => {
  it("fails a silent assignee at the deadline and cancels its Task", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", { ...request, deadlineMs: 60_000 });
    await settle();
    expect(h.room.view(view.taskId)?.state).toBe("running");
    h.tick(60_000);
    // A read never shows a live state past the deadline, even before the sweep runs.
    expect(h.room.view(view.taskId)?.state).toBe("failed");
    h.room.reconcile();
    expect(h.room.view(view.taskId)).toMatchObject({ state: "failed", failure: "deadline" });
    expect(h.storage.tasks.read(view.taskId)?.view.pendingIntent?.command).toBe("cancel");
    // The peer honours the interrupt; the Task settles and the assignment still reads failed.
    h.event("scout", { kind: "interrupted", threadId: view.threadId, turnId: h.commands[0]!.turnId, messageId: "m" });
    expect(h.storage.tasks.read(view.taskId)?.view.state).toBe("cancelled");
    expect(h.room.view(view.taskId)?.state).toBe("failed");
  });

  it("fails on the assignee turn's own failure and settles the Task", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", request);
    await settle();
    h.event("scout", { kind: "failed", threadId: view.threadId, turnId: h.commands[0]!.turnId, messageId: "m", message: "model unavailable" });
    expect(h.room.view(view.taskId)).toMatchObject({ state: "failed", failure: "model unavailable" });
    expect(h.storage.tasks.read(view.taskId)?.view.state).toBe("cancelled");
  });

  it("cancels through the Task and reads cancelled only once the turn settles", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", request);
    await settle();
    expect(h.room.cancel(view.taskId, "leader")).toMatchObject({ state: "running", cancelledBy: "leader" });
    expect(h.storage.tasks.read(view.taskId)?.view.pendingIntent?.command).toBe("cancel");
    h.event("scout", { kind: "cancelled", threadId: view.threadId, turnId: h.commands[0]!.turnId, messageId: "m" });
    expect(h.room.view(view.taskId)?.state).toBe("cancelled");
    // The report is free again.
    expect(h.room.assign("lead", request).state).toBe("queued");
  });

  it("only the leader acknowledges, only from verifying, and 24 h auto-completes", async () => {
    const h = harness();
    const view = h.room.assign("lead", request);
    await settle();
    expect(h.room.view(view.taskId)?.state).toBe("verifying");
    expect(() => h.room.acknowledge(view.taskId, "scout", "completed")).toThrow(/only lead/);
    expect(h.room.acknowledge(view.taskId, { device: true }, "failed")).toMatchObject({ state: "failed", acknowledgedAt: expect.any(Number) });
    expect(() => h.room.acknowledge(view.taskId, "lead", "completed")).toThrow(expect.objectContaining({ reason: "not_verifying" }));
    expect(() => h.room.acknowledge("no-such-task", "lead", "completed")).toThrow(/no assignment/);

    const second = h.room.assign("lead", { ...request, to: "sage" });
    await settle();
    expect(h.room.acknowledge(second.taskId, "lead", "completed").state).toBe("completed");
    const third = h.room.assign("lead", request);
    await settle();
    h.tick(24 * 60 * 60_000);
    const before = h.frames.length;
    h.room.reconcile();
    expect(h.room.view(third.taskId)?.state).toBe("completed");
    expect(h.frames.slice(before)).toContainEqual(expect.objectContaining({ type: "bot_inbox_activity", taskId: third.taskId, state: "completed" }));
  });
});

describe("retry", () => {
  it("a retried Task runs again on the assignment thread and its reply answers the assignment", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", request);
    await settle();
    h.event("scout", { kind: "interrupted", threadId: view.threadId, turnId: h.commands[0]!.turnId, messageId: "m" });
    expect(h.room.view(view.taskId)?.state).toBe("blocked");
    expect(h.storage.tasks.command(view.taskId, "retry", { idempotencyKey: "retry-1" }).outcome).toBe("accepted");
    const sent: string[] = [];
    h.storage.tasks.dispatch((peer, id, command) => {
      const queued = h.storage.enqueueTaskCommand(peer, id, command, 2_000);
      if (queued && command.kind === "turn") sent.push(command.turnId);
      return queued;
    });
    expect(sent).toHaveLength(1);
    h.event("scout", { kind: "commit", threadId: view.threadId, turnId: sent[0]!, messageId: "again", blocks: [{ type: "paragraph", text: REPLY }] });
    expect(h.room.view(view.taskId)).toMatchObject({ state: "verifying", result: { status: "done" } });
  });
});

describe("team", () => {
  it("validates reports and cancels a demoted leader's open work", async () => {
    const h = harness({ silent: true });
    expect(() => h.room.setTeam("scout", { reports: ["sage"] })).toThrow(/role: leader/);
    expect(() => h.room.setTeam("scout", { role: "leader", reports: ["scout"] })).toThrow(/itself/);
    expect(() => h.room.setTeam("scout", { role: "leader", reports: ["nobody"] })).toThrow(/not a bot on this gateway: nobody/);
    h.room.setTeam("scout", { role: "leader", reports: ["sage", "sage"] });
    expect(h.room.team("scout")).toEqual({ role: "leader", reports: ["sage"] });

    const view = h.room.assign("lead", request);
    await settle();
    h.room.setTeam("lead", { role: "member" });
    expect(h.room.team("lead")).toEqual({ role: "member", reports: [] });
    expect(h.room.view(view.taskId)?.cancelledBy).toBe("user");
    expect(h.storage.tasks.read(view.taskId)?.view.pendingIntent?.command).toBe("cancel");
  });
});

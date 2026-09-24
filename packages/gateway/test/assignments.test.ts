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
  const interrupts: Array<{ agentId: string; turnId: string }> = [];
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
    sendInterrupt: (agentId, input) => { interrupts.push({ agentId, turnId: input.turnId }); return true; },
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
  return { storage, room, frames, commands, interrupts, event, now: () => now, tick: (ms: number) => { now += ms; } };
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
  it("fails a silent assignee at the deadline as the gateway's timeout, never a person's cancel", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", { ...request, deadlineMs: 60_000 });
    await settle();
    expect(h.room.view(view.taskId)?.state).toBe("running");
    h.tick(60_000);
    // A read never shows a live state past the deadline, even before the sweep runs.
    expect(h.room.view(view.taskId)?.state).toBe("failed");
    h.room.reconcile();
    expect(h.room.view(view.taskId)).toMatchObject({ state: "failed", failure: "deadline" });
    const task = h.storage.tasks.read(view.taskId)!.view;
    expect(task.state).toBe("failed");
    expect(task.lastEvent).toMatchObject({ reason: "run_timed_out", actor: "gateway" });
    expect(task.pendingIntent).toBeUndefined();
    expect(h.storage.tasks.list({ bot: "scout", state: "blocked" })).toEqual([]);
    expect(h.storage.tasks.command(view.taskId, "retry", { idempotencyKey: "r" }).outcome).toBe("conflict");
    expect(h.storage.tasks.events(view.taskId).some((event) => event.actor === "user")).toBe(false);
    expect(h.interrupts).toEqual([{ agentId: "scout", turnId: h.commands[0]!.turnId }]);
    // A late answer after the deadline does not reopen the work.
    h.event("scout", { kind: "commit", threadId: view.threadId, turnId: h.commands[0]!.turnId, messageId: "late", blocks: [{ type: "paragraph", text: REPLY }] });
    expect(h.room.view(view.taskId)).toMatchObject({ state: "failed" });
    expect(h.room.view(view.taskId)?.finalText).toBeUndefined();
  });

  it("fails on the assignee turn's own failure and settles its Task terminally, with no retry", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", request);
    await settle();
    h.event("scout", { kind: "failed", threadId: view.threadId, turnId: h.commands[0]!.turnId, messageId: "m", message: "model unavailable" });
    expect(h.room.view(view.taskId)).toMatchObject({ state: "failed", failure: "model unavailable" });
    const task = h.storage.tasks.read(view.taskId)!.view;
    expect(task.state).toBe("failed");
    expect(task.lastEvent).toMatchObject({ reason: "run_failed", actor: "gateway" });
    expect(h.storage.tasks.events(view.taskId).some((event) => event.actor === "user")).toBe(false);
    expect(h.storage.tasks.list({ bot: "scout", state: "blocked" })).toEqual([]);
    expect(h.storage.tasks.command(view.taskId, "retry", { idempotencyKey: "r" }).outcome).toBe("conflict");
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
    expect(() => h.room.acknowledge(view.taskId, "scout", "completed")).toThrow(/only the leader/);
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

describe("a failed assignment is over", () => {
  it("refuses to run a retry on a failed assignment's thread even if its Task could retry", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", request);
    await settle();
    h.event("scout", { kind: "interrupted", threadId: view.threadId, turnId: h.commands[0]!.turnId, messageId: "m" });
    h.storage.updateBotAssignment(view.taskId, { failure: "deadline", updatedAt: h.now() });
    expect(h.storage.tasks.command(view.taskId, "retry", { idempotencyKey: "r" }).outcome).toBe("accepted");
    const sent: string[] = [];
    h.storage.tasks.dispatch((peer, id, command) => {
      const queued = h.storage.enqueueTaskCommand(peer, id, command, h.now());
      if (queued && command.kind === "turn") sent.push(command.turnId);
      return queued;
    });
    expect(sent).toEqual([]);
  });

  it("reads failed when the Task completed only after the deadline, before any sweep", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", { ...request, deadlineMs: 60_000 });
    await settle();
    h.tick(60_000);
    expect(h.room.view(view.taskId)?.state).toBe("failed");
    h.event("scout", { kind: "commit", threadId: view.threadId, turnId: h.commands[0]!.turnId, messageId: "late", blocks: [{ type: "paragraph", text: REPLY }] });
    expect(h.storage.tasks.read(view.taskId)?.view.state).toBe("completed");
    expect(h.room.view(view.taskId)?.state).toBe("failed");
  });
});

describe("team", () => {
  it("validates reports and cancels a demoted leader's open work", async () => {
    const h = harness({ silent: true });
    expect(() => h.room.setTeam("scout", { reports: ["sage"] })).toThrow(/role: leader/);
    expect(() => h.room.setTeam("scout", { role: "leader", reports: ["scout"] })).toThrow(/itself/);
    expect(() => h.room.setTeam("scout", { role: "leader", reports: ["nobody"] })).toThrow(/not a bot on this gateway: nobody/);
    h.room.setTeam("r0", { role: "leader", reports: ["R1 ", "r1", "r2"] });
    expect(h.room.team("r0")).toEqual({ role: "leader", reports: ["r1", "r2"] });
    expect(() => h.room.setTeam("r3", { role: "leader", reports: Array.from({ length: 17 }, (_, i) => `x${i}`) })).toThrow(/at most 16/);

    const view = h.room.assign("lead", request);
    await settle();
    h.room.setTeam("lead", { role: "member" });
    expect(h.room.team("lead")).toEqual({ role: "member", reports: [] });
    expect(h.room.view(view.taskId)?.cancelledBy).toBe("user");
    expect(h.storage.tasks.read(view.taskId)?.view.pendingIntent?.command).toBe("cancel");
  });

  it("refuses nested delegation both ways", () => {
    const h = harness({ silent: true });
    // lead's reports are scout and sage: neither may lead, and a leader may not be a report.
    expect(() => h.room.setTeam("scout", { role: "leader", reports: ["r0"] })).toThrow(/scout reports to lead and cannot lead/);
    expect(() => h.room.setTeam("scout", { role: "leader" })).toThrow(/cannot lead/);
    h.room.setTeam("r0", { role: "leader", reports: ["r1"] });
    expect(() => h.room.setTeam("r2", { role: "leader", reports: ["r0"] })).toThrow(/cannot report to another leader: r0/);
    expect(() => h.storage.setBotTeam({ bot: "x", role: "member", reports: [], updatedAt: 1 })).not.toThrow();
  });
});

describe("races, windows and restarts", () => {
  it("a cancel that lost the race to a delivered reply leaves the work acknowledgeable", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", request);
    await settle();
    h.room.cancel(view.taskId, "leader");
    h.event("scout", { kind: "commit", threadId: view.threadId, turnId: h.commands[0]!.turnId, messageId: "r", blocks: [{ type: "paragraph", text: REPLY }] });
    expect(h.storage.tasks.read(view.taskId)?.view.state).toBe("completed");
    expect(h.room.view(view.taskId)?.state).toBe("verifying");
    expect(h.room.acknowledge(view.taskId, "lead", "completed").state).toBe("completed");
  });

  it("closes an unacknowledged blocked result as failed, not completed", async () => {
    const h = harness({ reply: "Stuck.\nResult:\nstatus: blocked\nNo access." });
    const view = h.room.assign("lead", request);
    await settle();
    h.tick(24 * 60 * 60_000);
    expect(h.room.view(view.taskId)?.state).toBe("failed");
  });

  it("announces a verifying window that lapsed while the gateway was down, once", async () => {
    const h = harness();
    const view = h.room.assign("lead", request);
    await settle();
    h.room.close();
    h.tick(25 * 60 * 60_000);
    // The restarted orchestrator over the same durable store.
    const frames: ServerFrame[] = [];
    const restarted = new AssignmentRooms({
      storage: h.storage, broadcast: (frame) => frames.push(frame), now: h.now,
      displayName: (name) => name, knownBot: (name) => BOTS.includes(name), isAttached: () => true,
    });
    rooms.push(restarted);
    restarted.reconcile();
    expect(frames).toEqual([
      expect.objectContaining({ type: "bot_inbox_activity", bot: "lead", taskId: view.taskId, state: "completed" }),
      expect.objectContaining({ type: "bot_inbox_activity", bot: "scout", taskId: view.taskId, state: "completed" }),
    ]);
    restarted.reconcile();
    expect(frames).toHaveLength(2);
  });

  it("stamps the frame with the row's own updatedAt", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", request);
    h.tick(500);
    h.room.cancel(view.taskId, "leader");
    const last = h.frames.at(-1) as BotInboxActivityFrame;
    expect(last.updatedAt).toBe(h.storage.botAssignment(view.taskId)!.updatedAt);
    expect(last.updatedAt).toBe(1_500);
  });

  it("compares the whole request under an idempotency key and matches names case-insensitively", () => {
    const h = harness({ silent: true });
    const first = h.room.assign("lead", { ...request, to: " Scout ", idempotencyKey: "k" });
    expect(first.assignee).toBe("scout");
    expect(h.room.assign("lead", { ...request, idempotencyKey: "k" }).taskId).toBe(first.taskId);
    expect(() => h.room.assign("lead", { ...request, deadlineMs: 60_000, idempotencyKey: "k" })).toThrow(/idempotencyKey/);
    expect(() => h.room.assign("lead", { ...request, outputFormat: "JSON", idempotencyKey: "k" })).toThrow(/idempotencyKey/);
  });
});

describe("deleted bots", () => {
  it("a deleted assignee leaves its leader a readable cancelled view, and a same-name bot inherits nothing", async () => {
    const h = harness({ silent: true });
    const view = h.room.assign("lead", request);
    await settle();
    h.storage.tasks.ownerDeleted("scout", h.now());
    h.room.botDeleted("scout");
    h.storage.purgeBot("scout");
    expect(h.room.view(view.taskId)).toMatchObject({ state: "cancelled", failure: "assignee deleted" });
    expect(h.room.list({ leader: "lead" }).map((row) => row.taskId)).toEqual([view.taskId]);
    expect(h.room.team("lead")?.reports).toEqual(["sage"]);
    // A recreated scout sees none of it.
    expect(h.room.list({ participant: "scout" })).toEqual([]);
    expect(h.room.partyOf(view.taskId, "scout")).toBeUndefined();
    expect(h.room.inboxMessages("scout", view.threadId)).toBeUndefined();
    expect(h.room.inboxMessages("lead", view.threadId)).toHaveLength(1);
  });

  it("keeps delivered work a deleted assignee finished for its leader", async () => {
    const h = harness();
    const view = h.room.assign("lead", request);
    await settle();
    h.storage.tasks.ownerDeleted("scout", h.now());
    h.room.botDeleted("scout");
    h.storage.purgeBot("scout");
    expect(h.room.view(view.taskId)).toMatchObject({ state: "completed", result: { status: "done" } });
  });

  it("history that already finished keeps its outcome when the assignee is deleted", async () => {
    const h = harness();
    const view = h.room.assign("lead", request);
    await settle();
    h.tick(30 * 60 * 60_000);
    expect(h.room.view(view.taskId)?.state).toBe("completed");
    h.storage.purgeBot("scout");
    expect(h.room.view(view.taskId)?.state).toBe("completed");
  });

  it("a same-name leader can reuse an idempotency key its deleted namesake held", async () => {
    const h = harness({ silent: true });
    const first = h.room.assign("lead", { ...request, idempotencyKey: "k" });
    h.room.botDeleted("lead");
    h.storage.purgeBot("lead");
    h.storage.setBotTeam({ bot: "lead", role: "leader", reports: ["sage"], updatedAt: h.now() });
    const again = h.room.assign("lead", { ...request, to: "sage", idempotencyKey: "k" });
    expect(again.taskId).not.toBe(first.taskId);
    expect(again.assignee).toBe("sage");
  });

  it("a rename onto a name whose deleted rows held the same key, or whose live rows do, still commits", async () => {
    const h = harness({ silent: true });
    h.room.assign("lead", { ...request, idempotencyKey: "k" });
    h.room.botDeleted("lead");
    h.storage.purgeBot("lead");
    h.storage.setBotTeam({ bot: "r0", role: "leader", reports: ["sage"], updatedAt: h.now() });
    const moved = h.room.assign("r0", { ...request, to: "sage", idempotencyKey: "k" });
    expect(() => h.storage.renameBotState("r0", "lead")).not.toThrow();
    expect(h.storage.botAssignment(moved.taskId)?.leader).toBe("lead");
    // Both live under one name with the same key: the moved row gives its key up.
    h.storage.setBotTeam({ bot: "r1", role: "leader", reports: ["r2"], updatedAt: h.now() });
    const other = h.room.assign("r1", { ...request, to: "r2", idempotencyKey: "k" });
    expect(() => h.storage.renameBotState("r1", "lead")).not.toThrow();
    expect(h.storage.botAssignment(other.taskId)).toMatchObject({ leader: "lead" });
    expect(h.storage.botAssignment(other.taskId)?.idempotencyKey).toBeUndefined();
    expect(h.storage.botAssignmentByKey("lead", "k")?.taskId).toBe(moved.taskId);
  });

  it("a deleted leader's work is cancelled and a same-name bot can neither read nor acknowledge it", async () => {
    const h = harness();
    const view = h.room.assign("lead", request);
    await settle();
    expect(h.room.view(view.taskId)?.state).toBe("verifying");
    h.room.botDeleted("lead");
    h.storage.purgeBot("lead");
    expect(h.room.team("lead")).toBeUndefined();
    expect(h.room.list({ participant: "lead" })).toEqual([]);
    expect(h.room.inboxMessages("lead", view.threadId)).toBeUndefined();
    expect(() => h.room.acknowledge(view.taskId, "lead", "completed")).toThrow(/only the leader/);
    // The assignee still reads the work it did.
    expect(h.room.inboxMessages("scout", view.threadId)).toHaveLength(2);
  });
});

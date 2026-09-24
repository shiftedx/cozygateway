import { afterEach, describe, expect, it } from "vitest";

import { openStorage, type Storage } from "../src/storage.ts";

const storages: Storage[] = [];
afterEach(() => { for (const storage of storages.splice(0)) storage.close(); });
function open(): Storage { const storage = openStorage(":memory:"); storages.push(storage); return storage; }

const assignment = { taskId: "t1", leader: "lead", assignee: "scout", threadId: "assignment:t1", brief: "Check CI", doneCriteria: "green", deadlineAt: 1_800_000, createdAt: 1 };

describe("bot_team", () => {
  it("stores role and reports per bot", () => {
    const storage = open();
    storage.setBotTeam({ bot: "lead", role: "leader", reports: ["scout", "sage"], updatedAt: 1 });
    expect(storage.botTeam("lead")).toEqual({ bot: "lead", role: "leader", reports: ["scout", "sage"], updatedAt: 1 });
    expect(storage.botTeam("scout")).toBeUndefined();
    storage.setBotTeam({ bot: "lead", role: "member", reports: [], updatedAt: 3 });
    expect(storage.botTeam("lead")).toEqual({ bot: "lead", role: "member", reports: [], updatedAt: 3 });
  });
});

describe("bot_assignments", () => {
  it("admits the assignee's turn as the Task the assignment already names", () => {
    const storage = open();
    storage.tasks.clock(() => 0);
    storage.createBotAssignment(assignment);
    expect(storage.botAssignmentByThread("assignment:t1")?.assignee).toBe("scout");
    storage.enqueueAttachCommand("scout", "cmd", { kind: "turn", threadId: "assignment:t1", turnId: "run", messageId: "run:assignment", text: "[Task from Lead] Check CI" }, 2);
    const task = storage.tasks.read("t1")?.view;
    expect(task).toMatchObject({ taskId: "t1", bot: "scout", sessionId: "assignment:t1", state: "queued", goal: "[Task from Lead] Check CI" });
    expect(task?.room).toBeUndefined();
    // Only the assignee's own identity is admitted on the thread, and a second turn is not a
    // second Task.
    storage.enqueueAttachCommand("lead", "cmd-2", { kind: "turn", threadId: "assignment:t1", turnId: "other", messageId: "m", text: "x" }, 3);
    storage.enqueueAttachCommand("scout", "cmd-3", { kind: "turn", threadId: "assignment:t1", turnId: "run-2", messageId: "m2", text: "y" }, 3);
    expect(storage.tasks.list().map((view) => view.taskId)).toEqual(["t1"]);
  });

  it("records the reply and the leader's facts, and finds the row by key", () => {
    const storage = open();
    storage.createBotAssignment({ ...assignment, idempotencyKey: "k1", outputFormat: "JSON" });
    expect(storage.botAssignment("t1")).toMatchObject({ outputFormat: "JSON", idempotencyKey: "k1" });
    expect(storage.botAssignment("t1")).not.toHaveProperty("finalText");
    storage.updateBotAssignment("t1", { finalText: "Done.", finalAt: 5, finalTurnId: "run", resultJson: "{}", updatedAt: 6 });
    storage.updateBotAssignment("t1", { cancelledBy: "leader", updatedAt: 7 });
    expect(storage.botAssignment("t1")).toMatchObject({ finalText: "Done.", finalAt: 5, finalTurnId: "run", cancelledBy: "leader", updatedAt: 7 });
    expect(storage.botAssignmentByKey("lead", "k1")?.taskId).toBe("t1");
    expect(storage.botAssignmentByKey("other", "k1")).toBeUndefined();
  });

  it("lists newest first by leader, assignee, or either side", () => {
    const storage = open();
    storage.createBotAssignment(assignment);
    storage.createBotAssignment({ ...assignment, taskId: "t2", assignee: "sage", threadId: "assignment:t2", createdAt: 2 });
    expect(storage.botAssignments({ leader: "lead" }).map((row) => row.taskId)).toEqual(["t2", "t1"]);
    expect(storage.botAssignments({ assignee: "sage" }).map((row) => row.taskId)).toEqual(["t2"]);
    expect(storage.botAssignments({ participant: "scout" }).map((row) => row.taskId)).toEqual(["t1"]);
    expect(storage.botAssignments({ participant: "lead" })).toHaveLength(2);
  });

  it("purges a deleted bot's team row and its place in other teams, and tombstones its side of assignments", () => {
    const storage = open();
    storage.setBotTeam({ bot: "scout", role: "leader", reports: ["sage"], updatedAt: 1 });
    storage.setBotTeam({ bot: "lead", role: "leader", reports: ["scout", "sage"], updatedAt: 1 });
    storage.createBotAssignment(assignment);
    storage.createBotAssignment({ ...assignment, taskId: "t2", leader: "scout", assignee: "sage", threadId: "assignment:t2" });
    const purged = storage.purgeBot("scout");
    expect(purged).toMatchObject({ team: 1, teamReports: 1, assignmentsAnswered: 1, assignmentsLed: 1 });
    expect(storage.botTeam("scout")).toBeUndefined();
    expect(storage.botTeam("lead")?.reports).toEqual(["sage"]);
    expect(storage.botAssignment("t1")).toMatchObject({ frozenState: "cancelled", failure: "assignee deleted", assigneeDeletedAt: expect.any(Number) });
    expect(storage.botAssignments({ participant: "scout" })).toEqual([]);
    expect(storage.botAssignments({ participant: "lead" }).map((row) => row.taskId)).toEqual(["t1"]);
    expect(storage.botAssignments({ participant: "sage" }).map((row) => row.taskId)).toEqual(["t2"]);
    expect(storage.purgeBot("scout")).toEqual({});
  });

  it("moves team rows, reports and both sides of assignments on a rename", () => {
    const storage = open();
    storage.setBotTeam({ bot: "lead", role: "leader", reports: ["scout", "sage"], updatedAt: 1 });
    storage.setBotTeam({ bot: "boss", role: "leader", reports: ["lead"], updatedAt: 1 });
    storage.createBotAssignment(assignment);
    storage.renameBotState("lead", "chief");
    storage.renameBotState("scout", "ranger");
    expect(storage.botTeam("lead")).toBeUndefined();
    expect(storage.botTeam("chief")).toMatchObject({ role: "leader", reports: ["ranger", "sage"] });
    expect(storage.botTeam("boss")?.reports).toEqual(["chief"]);
    expect(storage.botAssignment("t1")).toMatchObject({ leader: "chief", assignee: "ranger" });
    expect(storage.botAssignments({ participant: "lead" })).toEqual([]);
    expect(storage.botTeamNames().sort()).toEqual(["boss", "chief", "ranger", "sage"]);
  });

  it("the previous_names re-link keeps the live bot's own team row", () => {
    const storage = open();
    storage.setBotTeam({ bot: "old", role: "leader", reports: ["sage"], updatedAt: 1 });
    storage.setBotTeam({ bot: "new", role: "member", reports: [], updatedAt: 2 });
    storage.renameBotState("old", "new", "to");
    expect(storage.botTeam("old")).toBeUndefined();
    expect(storage.botTeam("new")).toMatchObject({ role: "member" });
  });
});

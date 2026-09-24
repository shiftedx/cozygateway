import { describe, expect, it } from "vitest";

import {
  ASSIGNMENT_REFUSALS,
  ASSIGNMENT_STATES,
  AssignmentAcknowledgeRequestSchema,
  AssignmentCreateRequestSchema,
  AssignmentRefusalBodySchema,
  AssignmentResultSchema,
  AssignmentViewSchema,
  BotInboxActivityFrameSchema,
  BotInboxThreadSchema,
  BotTeamSchema,
  ServerFrameSchema,
  check,
} from "../src/index.ts";

describe("agent-inbox 1 assignment boundary", () => {
  it("declares nine closed states and six closed refusals", () => {
    expect(ASSIGNMENT_STATES).toHaveLength(9);
    expect(ASSIGNMENT_STATES).not.toContain("in_progress");
    expect(ASSIGNMENT_REFUSALS).toEqual(["not_leader", "not_a_report", "assignee_busy", "assignee_unavailable", "leader_task_cap", "not_verifying"]);
    expect(check(AssignmentAcknowledgeRequestSchema, { outcome: "completed" })).toBe(true);
    expect(check(AssignmentAcknowledgeRequestSchema, { outcome: "verifying" })).toBe(false);
  });

  it("bounds the create request: deadline between 1 minute and 4 hours, closed shape", () => {
    const body = { to: "scout", brief: "Check CI", doneCriteria: "CI is green on main" };
    expect(check(AssignmentCreateRequestSchema, body)).toBe(true);
    expect(check(AssignmentCreateRequestSchema, { ...body, deadlineMs: 60_000, idempotencyKey: "k1" })).toBe(true);
    expect(check(AssignmentCreateRequestSchema, { ...body, deadlineMs: 59_999 })).toBe(false);
    expect(check(AssignmentCreateRequestSchema, { ...body, deadlineMs: 14_400_001 })).toBe(false);
    expect(check(AssignmentCreateRequestSchema, { ...body, brief: "" })).toBe(false);
    expect(check(AssignmentCreateRequestSchema, { ...body, brief: "  " })).toBe(false);
    expect(check(AssignmentCreateRequestSchema, { ...body, assignmentId: "x" })).toBe(false);
  });

  it("names the work by one Task id and round-trips a view with and without a result", () => {
    const view = { taskId: "t1", leader: "lead", assignee: "scout", brief: "Check CI", doneCriteria: "green", deadlineAt: 10, createdAt: 1, updatedAt: 2, state: "queued", threadId: "assignment:t1" };
    expect(check(AssignmentViewSchema, view)).toBe(true);
    expect(check(AssignmentViewSchema, { ...view, state: "verifying", result: { status: "done", summary: "green", artifacts: ["ci/log.txt"] } })).toBe(true);
    const { taskId: _taskId, ...withoutTask } = view;
    expect(check(AssignmentViewSchema, withoutTask)).toBe(false);
    expect(check(AssignmentResultSchema, { status: "unsure", summary: "", artifacts: [] })).toBe(false);
  });

  it("types the refusal body and the inbox activity frame, which the ws union carries", () => {
    expect(check(AssignmentRefusalBodySchema, { error: { code: "assignment_refused", message: "x" }, reason: "not_leader" })).toBe(true);
    expect(check(AssignmentRefusalBodySchema, { error: { code: "assignment_refused", message: "x" }, reason: "busy" })).toBe(false);
    const frame = { type: "bot_inbox_activity", bot: "lead", threadId: "assignment:t1", updatedAt: 5, taskId: "t1", state: "running" };
    expect(check(BotInboxActivityFrameSchema, frame)).toBe(true);
    expect(check(ServerFrameSchema, frame)).toBe(true);
    expect(check(BotInboxThreadSchema, { id: "assignment:t1", peers: ["lead", "scout"], startedAt: 1, lastActiveAt: 2, preview: "Check CI", messageCount: 2 })).toBe(true);
    expect(check(BotInboxThreadSchema, { id: "assignment:t1", peers: ["lead"], startedAt: 1, lastActiveAt: 2, preview: "", messageCount: 0 })).toBe(false);
  });

  it("publishes the team read: role plus at most sixteen reports", () => {
    expect(check(BotTeamSchema, { role: "leader", reports: ["scout"] })).toBe(true);
    expect(check(BotTeamSchema, { role: "member", reports: [] })).toBe(true);
    expect(check(BotTeamSchema, { role: "boss", reports: [] })).toBe(false);
    expect(check(BotTeamSchema, { role: "leader", reports: Array.from({ length: 17 }, (_, i) => `b${i}`) })).toBe(false);
  });
});

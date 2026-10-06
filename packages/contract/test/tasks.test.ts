import { describe, expect, it } from "vitest";
import { TaskEventSchema, TaskStateSchema, TASK_REASONS, check } from "../src/index.ts";

describe("capability 64 durable Task boundary", () => {
  it("declares ten closed states and 45 closed transition reasons", () => {
    expect(TaskStateSchema.anyOf).toHaveLength(10);
    expect(TASK_REASONS).toHaveLength(45);
    expect(check(TaskStateSchema, "cancelling")).toBe(false);
  });
  it("accepts a source reference but refuses invented transition reasons", () => {
    const event = { taskId: "task-1", seq: 1, at: 100, from: null, to: "queued", reason: "task_created", actor: "gateway", ref: { kind: "turn", id: "turn-1" } };
    expect(check(TaskEventSchema, event)).toBe(true);
    expect(check(TaskEventSchema, { ...event, reason: "looks_done" })).toBe(false);
    expect(check(TaskEventSchema, { ...event, actor: "runner" })).toBe(false);
  });
});

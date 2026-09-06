import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertValid, check, TASK_REASONS, TASK_STATES, TaskEventSchema, TaskViewSchema, TaskReadSchema, TaskUpdatedFrameSchema } from "cozygateway-contract";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/durable-task-v1.json", import.meta.url), "utf8")) as { capability: number; event: Record<string, unknown>; view: Record<string, unknown> };

/** Portable decoder evidence for row 64. Lifecycle authority is exercised separately through
 * authenticated gateway ingress and HTTP tests; this fixture does not simulate an executor. */
describe("durable Task v1 portable client fixture", () => {
  it("pins row 64 and keeps read and full replacement frame shapes consistent", () => {
    expect(fixture.capability).toBe(64);
    assertValid(TaskEventSchema, fixture.event);
    assertValid(TaskViewSchema, fixture.view);
    assertValid(TaskReadSchema, { view: fixture.view, events: [fixture.event] });
    assertValid(TaskUpdatedFrameSchema, { type: "bot_task_updated", event: fixture.event, view: fixture.view });
    expect(fixture.view.lastEvent).toEqual(fixture.event);
  });
  it("closes ten states and the 45 authoritative reason spellings", () => {
    expect(TASK_STATES).toHaveLength(10);
    expect(TASK_REASONS).toHaveLength(45);
    for (const state of TASK_STATES) expect(check(TaskViewSchema, { ...fixture.view, state })).toBe(true);
    for (const reason of TASK_REASONS) expect(check(TaskEventSchema, { ...fixture.event, reason })).toBe(true);
    expect(check(TaskViewSchema, { ...fixture.view, state: "in_progress" })).toBe(false);
    expect(check(TaskEventSchema, { ...fixture.event, reason: "unknown_reason" })).toBe(false);
    expect(check(TaskEventSchema, { ...fixture.event, actor: "model" })).toBe(false);
  });
  it("does not put conversation payload or device identity in the transition", () => {
    expect(Object.keys(fixture.event).sort()).toEqual(["actor", "at", "from", "reason", "ref", "seq", "taskId", "to"]);
    expect(JSON.stringify(fixture.event)).not.toMatch(/deviceId|toolArguments|transcript|\/Users\//);
  });
});

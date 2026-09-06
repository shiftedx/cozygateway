import { describe, expect, it } from "vitest";
import { openStorage } from "../src/storage.ts";

describe("durable Tasks on actual attach storage admission", () => {
  it("creates the Task with a direct turn, starts on ack and completes once on its final proof", () => {
    const storage = openStorage(":memory:");
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const command = storage.enqueueAttachCommand("sage", "command", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "Check the build" }, 2);
    const task = storage.tasks.list({ bot: "sage" })[0]!;
    expect(task).toMatchObject({ bot: "sage", state: "queued", goal: "Check the build", currentRun: { runId: "run" } });
    storage.ackAttachCommand("sage", command.sequence, command.commandId, 3);
    expect(storage.tasks.read(task.taskId)?.view.state).toBe("running");
    const final = { kind: "event" as const, sequence: 1, eventId: "final", event: { kind: "commit" as const, threadId: sessionId, turnId: "run", messageId: "reply", blocks: [{ type: "paragraph" as const, text: "Verified" }] } };
    storage.acceptAttachEvent("sage", final, 4);
    storage.acceptAttachEvent("sage", final, 5);
    expect(storage.tasks.read(task.taskId)).toMatchObject({ view: { state: "completed", notification: { taskId: task.taskId, createdAt: 4 } }, events: [{ reason: "task_created" }, { reason: "run_started" }, { reason: "run_completed" }] });
    storage.close();
  });
});

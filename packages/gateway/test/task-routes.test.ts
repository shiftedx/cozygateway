import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { openStorage } from "../src/storage.ts";

const stores: ReturnType<typeof openStorage>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function setup() {
  const storage = openStorage(":memory:"); stores.push(storage);
  storage.tasks.clock(() => 100);
  const app = createApp({ storage,
    config: { name: "test", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0 },
    gatewayInfo: { name: "test", version: "test", contract: "v1", capabilities: { "com.cozylabs.bots": 64 } },
    presenceOf: () => "online", submitUserMessage: () => { throw new Error("not used"); }, interruptThread: () => "idle", resolveApproval: async () => "unknown", onDeviceRevoked: () => {}, now: () => 100,
    flushTaskCommands: () => storage.tasks.dispatch((peer, id, command) => storage.enqueueTaskCommand(peer, id, command, 100)),
  });
  storage.createSetupCode("task-pair", 1000);
  const pair = await app.request("/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: "task-pair", deviceName: "phone" }) });
  const { deviceToken } = await pair.json() as { deviceToken: string };
  const request = (path: string, body?: object) => app.request(path, { headers: { authorization: `Bearer ${deviceToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  const sessionId = storage.nativeBotChat("sage", 100).sessionId;
  storage.enqueueAttachCommand("sage", "turn", { kind: "turn", threadId: sessionId, turnId: "run", messageId: "user", text: "work" }, 100);
  const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
  return { storage, app, request, taskId };
}

describe("authenticated Task public routes", () => {
  it("requires paired-device auth on every read and command route", async () => {
    const { app, taskId } = await setup();
    for (const path of ["/bots/sage/tasks", "/bots/groups/room/tasks", `/tasks/${taskId}`]) expect((await app.request(path)).status).toBe(401);
    for (const action of ["pause", "cancel", "scope", "retry", "resume"]) expect((await app.request(`/tasks/${taskId}/${action}`, { method: "POST", body: "{}" })).status).toBe(401);
  });
  it("returns the same derived view in list, paged read and full-replace frame", async () => {
    const { storage, request, taskId } = await setup();
    const frames: unknown[] = [];
    storage.tasks.observe((frame) => frames.push(frame));
    const accepted = await request(`/tasks/${taskId}/scope`, { idempotencyKey: "scope", goal: "changed" });
    expect(accepted.status).toBe(200);
    await Promise.resolve();
    const view = await accepted.json();
    expect(frames.at(-1)).toMatchObject({ type: "bot_task_updated", view });
    expect(await (await request("/bots/sage/tasks?state=queued")).json()).toMatchObject({ tasks: [view] });
    expect(await (await request(`/tasks/${taskId}?cursor=0&limit=1`)).json()).toMatchObject({ view, events: [{ seq: 1 }], nextCursor: 1 });
    expect(await (await request(`/tasks/${taskId}?cursor=1`)).json()).toMatchObject({ events: [{ seq: 2, reason: "scope_changed" }] });
    expect((await request(`/tasks/${taskId}?cursor=-1`)).status).toBe(400);
  });
  it("rejects whitespace scope as malformed without omitting required conflict fields", async () => {
    const { request, taskId } = await setup();
    expect((await request(`/tasks/${taskId}/scope`, { idempotencyKey: "blank", goal: "   " })).status).toBe(400);
  });
  it.each(["completed", "failed", "cancelled"] as const)("enforces every terminal command rule for %s", async (state) => {
    const { storage, request, taskId } = await setup();
    const run = storage.tasks.read(taskId)!.view.currentRun.runId;
    const sessionId = storage.tasks.read(taskId)!.view.sessionId;
    const event = state === "completed" ? { kind: "commit" as const, threadId: sessionId, turnId: run, messageId: "final", blocks: [] } : { kind: state === "cancelled" ? "cancelled" as const : "failed" as const, threadId: sessionId, turnId: run, messageId: "final" };
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "final", event }, 100);
    if (state === "failed") storage.tasks.recoveryDecisions(() => ({ taskId, runId: run, issuer: "test-policy", decisionId: "decision", reason: "Explicit recovery closure" }));
    expect(storage.tasks.read(taskId)?.view.state).toBe(state);
    for (const action of ["cancel", "pause", "resume", "retry", "scope"]) {
      const response = await request(`/tasks/${taskId}/${action}`, { idempotencyKey: action, ...(action === "scope" ? { goal: "new" } : {}) });
      expect(response.status).toBe(state === "cancelled" && action === "cancel" ? 200 : 409);
      if (response.status === 409) expect(await response.json()).toMatchObject({ state, view: { taskId, state } });
    }
  });
  it.each(["queued", "running", "verifying", "approval", "clarification", "device", "blocked", "paused"] as const)("enforces the nonterminal command class %s", async (state) => {
    for (const action of ["cancel", "pause", "resume", "retry", "scope"] as const) {
      const { storage, request, taskId } = await setup();
      const view = storage.tasks.read(taskId)!.view;
      const threadId = view.sessionId; const turnId = view.currentRun.runId;
      const command = storage.pendingAttachCommands("sage", 0, 10)[0]!;
      if (state !== "queued") storage.ackAttachCommand("sage", command.sequence, command.commandId, 100);
      if (state === "verifying") {
        storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "mutation", event: { kind: "tool", threadId, turnId, callId: "mutation", name: "write", status: "running", role: "mutation" } }, 100);
        storage.acceptAttachEvent("sage", { kind: "event", sequence: 2, eventId: "verification", event: { kind: "tool", threadId, turnId, callId: "verification", name: "check", status: "running", role: "verification" } }, 100);
      }
      if (state === "approval" || state === "clarification") storage.recordNativeInteraction({ bot: "sage", kind: state === "approval" ? "approval" : "clarify", interactionId: "wait", sessionId: threadId, turnId, status: "pending", expiresAt: 1000, payload: {}, updatedAt: 100 });
      if (state === "device") storage.tasks.device({ agentId: "sage", threadId, turnId, requestId: "wait", expiresAt: 1000, status: "pending" }, 100);
      if (state === "blocked") storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "failure", event: { kind: "failed", threadId, turnId, messageId: "failure" } }, 100);
      if (state === "paused") {
        storage.tasks.command(taskId, "pause", { idempotencyKey: "initial-pause" }, 100);
        storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "pause", event: { kind: "interrupted", threadId, turnId, messageId: "pause" } }, 100);
      }
      const allowed = action === "cancel" || action === "scope" || (action === "pause" && ["queued", "running", "verifying", "approval", "device"].includes(state)) || (action === "resume" && state === "paused") || (action === "retry" && state === "blocked");
      const response = await request(`/tasks/${taskId}/${action}`, { idempotencyKey: action, ...(action === "scope" ? { goal: "changed" } : {}) });
      expect(response.status, `${state}/${action}`).toBe(allowed ? 200 : 409);
      if (!allowed) expect(await response.json()).toMatchObject({ error: { code: "conflict" }, view: { taskId } });
    }
  });
  it("omits Task update observation below the server capability floor", async () => {
    const { storage, request, taskId } = await setup();
    const frames: unknown[] = [];
    storage.tasks.observe((frame) => frames.push(frame), 63);
    await request(`/tasks/${taskId}/scope`, { idempotencyKey: "old", goal: "first" });
    await Promise.resolve();
    expect(frames).toEqual([]);
    storage.tasks.observe((frame) => frames.push(frame), 64);
    await request(`/tasks/${taskId}/scope`, { idempotencyKey: "new", goal: "second" });
    await Promise.resolve();
    expect(frames).toHaveLength(1);
  });
  it("binds command idempotency to action and payload and refuses invalid command states", async () => {
    const { request, taskId } = await setup();
    const original = await (await request(`/tasks/${taskId}/scope`, { idempotencyKey: "key", goal: "changed" })).json();
    expect(await (await request(`/tasks/${taskId}/scope`, { idempotencyKey: "key", goal: "changed" })).json()).toEqual(original);
    for (const [action, body] of [["scope", { idempotencyKey: "key", goal: "different" }], ["cancel", { idempotencyKey: "key" }], ["resume", { idempotencyKey: "resume" }], ["retry", { idempotencyKey: "retry" }]] as const) {
      const response = await request(`/tasks/${taskId}/${action}`, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "conflict" }, state: "queued" });
    }
  });
});

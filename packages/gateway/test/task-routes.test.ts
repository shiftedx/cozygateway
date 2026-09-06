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

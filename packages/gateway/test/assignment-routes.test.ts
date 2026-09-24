import { afterEach, describe, expect, it } from "vitest";

import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import { AssignmentRooms } from "../src/hermes-bridge/assignments.ts";
import { createApp } from "../src/http.ts";
import { openStorage, type Storage } from "../src/storage.ts";

const JSON_HEADERS = { "content-type": "application/json" };
const TOKENS = new Map([["tok-lead", "lead"], ["tok-scout", "scout"], ["tok-sage", "sage"]]);
const REPLY = "Green.\nResult:\nstatus: done\nCI is green.\nartifacts: ci/log.txt";

const storages: Storage[] = [];
const rooms: AssignmentRooms[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.close();
  for (const storage of storages.splice(0)) storage.close();
});

/** The HTTP surface over a real AssignmentRooms. The fake peer answers every turn with a commit
 * admitted through the durable inbox, in the order the ingress uses. */
async function setup(opts: { silent?: boolean } = {}) {
  const now = 1_000;
  const storage = openStorage(":memory:");
  storages.push(storage);
  storage.tasks.clock(() => now);
  const sequences = new Map<string, number>();
  const pending: Array<() => void> = [];
  const assignments = new AssignmentRooms({
    storage, broadcast: () => {}, now: () => now,
    displayName: (name) => name, knownBot: (name) => [...TOKENS.values()].includes(name), isAttached: () => true,
  });
  rooms.push(assignments);
  assignments.setNativeTurns({
    sendNativeTurn: (agentId, input) => {
      storage.enqueueAttachCommand(agentId, `cmd-${input.turnId}`, { kind: "turn", ...input }, now);
      const reply = (): void => {
        const sequence = (sequences.get(agentId) ?? 0) + 1;
        sequences.set(agentId, sequence);
        const frame = { kind: "event", sequence, eventId: `e-${sequence}`, event: { kind: "commit", threadId: input.threadId, turnId: input.turnId, messageId: `reply:${input.turnId}`, blocks: [{ type: "paragraph", text: REPLY }] } } as AttachV1EventFrame;
        storage.acceptAttachEvent(agentId, frame, now);
        assignments.handleAttachEvent(agentId, frame);
      };
      if (opts.silent === true) pending.push(reply); else queueMicrotask(reply);
      return true;
    },
  });
  storage.setBotTeam({ bot: "lead", role: "leader", reports: ["scout", "sage"], updatedAt: now });
  const app = createApp({
    storage, config: { name: "test", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0 },
    gatewayInfo: { name: "test", version: "test", contract: "v1", capabilities: {} },
    attachTokens: TOKENS, assignments,
    presenceOf: () => "online", submitUserMessage: () => { throw new Error("not used"); },
    interruptThread: () => "idle", resolveApproval: async () => "unknown", onDeviceRevoked: () => {},
    now: () => now,
  });
  storage.createSetupCode("assignment-pair", 10_000);
  const paired = await app.request("/pair", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ setupCode: "assignment-pair", deviceName: "phone" }) });
  const { deviceToken } = await paired.json() as { deviceToken: string };
  const device = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...JSON_HEADERS, authorization: `Bearer ${deviceToken}`, ...(init.headers ?? {}) } });
  const peer = (agent: string, path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...JSON_HEADERS, authorization: `Bearer tok-${agent}`, ...(init.headers ?? {}) } });
  return { storage, app, device, peer, reply: () => { for (const answer of pending.splice(0)) answer(); } };
}

const request = { to: "scout", brief: "Check CI", doneCriteria: "main is green" };
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("assignment routes", () => {
  it("a leader assigns with its attach bearer and a device reads the assignment and the inbox", async () => {
    const h = await setup();
    const res = await h.peer("lead", "/bots/lead/assignments", post(request));
    expect(res.status).toBe(201);
    const created = await res.json() as { taskId: string; threadId: string; state: string };
    expect(created).toMatchObject({ threadId: `assignment:${created.taskId}`, state: "queued" });
    // The same id reads the Task itself.
    expect((await h.device(`/tasks/${created.taskId}`)).status).toBe(200);
    await settle();
    expect(await (await h.device(`/assignments/${created.taskId}`)).json()).toMatchObject({ state: "verifying", result: { status: "done" } });
    expect(await (await h.peer("scout", "/bots/scout/assignments")).json()).toMatchObject({ assignments: [{ taskId: created.taskId }] });
    const inbox = await (await h.device("/bots/lead/inbox")).json() as { threads: Array<{ id: string; peers: string[] }> };
    expect(inbox.threads[0]).toMatchObject({ id: created.threadId, peers: ["lead", "scout"] });
    const messages = await (await h.device(`/bots/lead/inbox/${created.threadId}/messages`)).json() as { messages: unknown[] };
    expect(messages.messages).toHaveLength(2);
    expect((await h.device(`/bots/sage/inbox/${created.threadId}/messages`)).status).toBe(404);
  });

  it("refusals are typed, and a peer acts only as itself", async () => {
    const h = await setup();
    const res = await h.peer("scout", "/bots/scout/assignments", post({ ...request, to: "lead" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "assignment_refused" }, reason: "not_leader" });
    expect((await h.peer("scout", "/bots/lead/assignments", post(request))).status).toBe(403);
    expect((await h.app.request("/bots/lead/assignments", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(request) })).status).toBe(401);
    // A device token is never a leader's credential.
    expect((await h.device("/bots/lead/assignments", post(request))).status).toBe(401);
    expect((await h.peer("lead", "/bots/lead/assignments", post({ ...request, brief: "" }))).status).toBe(400);
    expect((await h.peer("sage", "/bots/lead/assignments")).status).toBe(403);
    // Not a party reads exactly like no such Task.
    const created = await (await h.peer("lead", "/bots/lead/assignments", post(request))).json() as { taskId: string };
    const notMine = await h.peer("sage", `/assignments/${created.taskId}`);
    const missing = await h.peer("sage", "/assignments/no-such");
    expect(notMine.status).toBe(404);
    expect(await notMine.json()).toEqual(await missing.json());
    expect((await h.app.request("/bots/lead/inbox", { headers: { authorization: "Bearer tok-lead" } })).status).toBe(401);
  });

  it("acknowledges from verifying only, by the leader or a device; a device may cancel", async () => {
    const h = await setup({ silent: true });
    const created = await (await h.peer("lead", "/bots/lead/assignments", post(request))).json() as { taskId: string };
    const early = await h.peer("lead", `/assignments/${created.taskId}/acknowledge`, post({ outcome: "completed" }));
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: { code: "assignment_refused" }, reason: "not_verifying" });
    h.reply();
    expect((await h.peer("scout", `/assignments/${created.taskId}/acknowledge`, post({ outcome: "completed" }))).status).toBe(403);
    const ok = await h.peer("lead", `/assignments/${created.taskId}/acknowledge`, post({ outcome: "completed" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: "completed", taskId: created.taskId });
    expect((await h.peer("lead", "/assignments/no-such/acknowledge", post({ outcome: "completed" }))).status).toBe(404);
    expect((await h.peer("lead", `/assignments/${created.taskId}/acknowledge`, post({ outcome: "maybe" }))).status).toBe(400);
  });

  it("cancels as the leader or the user, never as the assignee", async () => {
    const h = await setup({ silent: true });
    const first = await (await h.peer("lead", "/bots/lead/assignments", post(request))).json() as { taskId: string };
    expect((await h.peer("scout", `/assignments/${first.taskId}/cancel`, post({}))).status).toBe(403);
    expect(await (await h.peer("lead", `/assignments/${first.taskId}/cancel`, { method: "POST" })).json()).toMatchObject({ cancelledBy: "leader" });
    const second = await (await h.peer("lead", "/bots/lead/assignments", post({ ...request, to: "sage" }))).json() as { taskId: string };
    // The cancel is recorded, but the read does not say cancelled before the Task settles.
    expect(await (await h.device(`/assignments/${second.taskId}/cancel`, post({ reason: "changed plans" }))).json()).toMatchObject({ state: "queued", cancelledBy: "user" });
    expect((await h.device("/assignments/no-such/cancel", post({}))).status).toBe(404);
  });

  it("answers a bot its own team over its attach bearer, and a member with an empty team", async () => {
    const h = await setup();
    expect(await (await h.peer("lead", "/bots/lead/team")).json()).toEqual({ role: "leader", reports: ["scout", "sage"] });
    expect(await (await h.peer("scout", "/bots/scout/team")).json()).toEqual({ role: "member", reports: [] });
    const other = await h.peer("scout", "/bots/lead/team");
    expect(other.status).toBe(403);
    const body = await other.json() as { error: { message: string } };
    expect(body.error.message).not.toMatch(/assignment/i);
    expect(body.error.message).toMatch(/team/i);
    expect((await h.device("/bots/lead/team")).status).toBe(200);
    expect((await h.app.request("/bots/lead/team")).status).toBe(401);
    // An unknown or revoked bearer is neither a live peer nor a paired device.
    expect((await h.app.request("/bots/lead/team", { headers: { authorization: "Bearer tok-ghost" } })).status).toBe(401);
  });
});

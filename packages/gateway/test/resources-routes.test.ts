import { describe, expect, it } from "vitest";
import type { Message, RichBlock } from "cozygateway-contract";

import { openStorage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { BackendUnavailable } from "../src/errors.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  agents: [{ id: "mock", name: "Mock", backend: "mock" }],
};

async function setup(opts?: { backendDown?: boolean }) {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "mock", name: "Mock", avatar: null, backend: "mock" });
  const app = createApp({
    storage,
    config,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1" },
    presenceOf: () => "online",
    submitUserMessage: (threadId: string, blocks: RichBlock[]): Message => {
      if (opts?.backendDown === true) throw new BackendUnavailable("backend down");
      return storage.appendMessage(threadId, { role: "user", blocks }, 500);
    },
    interruptThread: () => "idle",
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
  const pairRes = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await pairRes.json()) as { deviceToken: string };
  const authed = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
    });
  return { app, storage, authed };
}

describe("agents", () => {
  it("lists agents with presence", async () => {
    const { authed } = await setup();
    const res = await authed("/agents");
    expect(res.status).toBe(200);
    const agents = (await res.json()) as Array<{ id: string; presence: string }>;
    expect(agents).toEqual([
      { id: "mock", name: "Mock", backend: "mock", presence: "online" },
    ]);
  });
});

describe("threads", () => {
  it("creates with default title, renames, archives", async () => {
    const { authed } = await setup();
    const created = await authed("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "mock" }),
    });
    expect(created.status).toBe(200);
    const thread = (await created.json()) as { id: string; title: string };
    expect(thread.title).toBe("New thread");

    const renamed = await authed(`/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Project X" }),
    });
    expect(((await renamed.json()) as { title: string }).title).toBe("Project X");

    expect((await authed(`/threads/${thread.id}`, { method: "DELETE" })).status).toBe(200);
    const list = (await (await authed("/threads")).json()) as unknown[];
    expect(list).toHaveLength(0);
  });

  it("404s creating a thread for an unknown agent", async () => {
    const { authed } = await setup();
    const res = await authed("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "ghost" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("messages", () => {
  async function withThread() {
    const ctx = await setup();
    const created = await ctx.authed("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "mock", title: "T" }),
    });
    const thread = (await created.json()) as { id: string };
    return { ...ctx, threadId: thread.id };
  }

  it("sends a message and reads it back with pagination", async () => {
    const { authed, threadId } = await withThread();
    const sent = await authed(`/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "hello" }] }),
    });
    expect(sent.status).toBe(200);
    const { message } = (await sent.json()) as { message: { seq: number } };
    expect(message.seq).toBe(1);

    const page = await authed(`/threads/${threadId}/messages?limit=10`);
    const body = (await page.json()) as { messages: Array<{ seq: number }> };
    expect(body.messages.map((m) => m.seq)).toEqual([1]);
  });

  it("rejects empty blocks and unknown block types", async () => {
    const { authed, threadId } = await withThread();
    expect(
      (
        await authed(`/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ blocks: [] }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await authed(`/threads/${threadId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ blocks: [{ type: "html", html: "<b>" }] }),
        })
      ).status,
    ).toBe(400);
  });

  it("409s on an archived thread and 503s when the backend is unavailable", async () => {
    const { authed, threadId } = await withThread();
    await authed(`/threads/${threadId}`, { method: "DELETE" });
    const archived = await authed(`/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "x" }] }),
    });
    expect(archived.status).toBe(409);

    const down = await setup({ backendDown: true });
    const created = await down.authed("/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "mock" }),
    });
    const thread = (await created.json()) as { id: string };
    const res = await down.authed(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "x" }] }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("backend_unavailable");
  });
});

describe("push registration", () => {
  it("stores a registration", async () => {
    const { authed } = await setup();
    const res = await authed("/push/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pushId: "p1", relayUrl: "https://relay.example", pushKey: "k" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("unexpected faults", () => {
  it("404s an unknown route with an ErrorBody, even with valid auth", async () => {
    const { authed } = await setup();
    const res = await authed("/no/such/route");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(typeof body.error.message).toBe("string");
  });

  it("500s a thrown, unclassified error as an internal ErrorBody", async () => {
    const storage = openStorage(":memory:");
    storage.upsertAgent({ id: "mock", name: "Mock", avatar: null, backend: "mock" });
    const app = createApp({
      storage,
      config,
      gatewayInfo: { name: "g", version: "0.1.0", contract: "v1" },
      presenceOf: () => "online",
      submitUserMessage: (): Message => {
        throw new Error("boom");
      },
      interruptThread: () => "idle",
      onDeviceRevoked: () => {},
      now: () => 1_000,
    });
    const code = newSetupCode();
    storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
    const pairRes = await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
    });
    const { deviceToken } = (await pairRes.json()) as { deviceToken: string };
    const created = await app.request("/threads", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ agentId: "mock" }),
    });
    const thread = (await created.json()) as { id: string };
    const res = await app.request(`/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "x" }] }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal");
    expect(typeof body.error.message).toBe("string");
  });
});

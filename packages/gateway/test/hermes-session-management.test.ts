import { describe, expect, it, vi } from "vitest";
import type { GatewayHarness, Message, RichBlock } from "cozygateway-contract";

import { hashToken } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import type { HermesClient } from "../src/hermes-bridge/client.ts";
import {
  GatewayHermesSessionManagement,
  HermesSessionManagementAdapter,
} from "../src/hermes-bridge/session-management.ts";
import { openStorage } from "../src/storage.ts";

const TOKEN = "paired-session-admin-token";
const HARNESS: GatewayHarness = {
  id: "home",
  vendor: { id: "hermes-agent", name: "Hermes Agent", logoAsset: "hermes-agent" },
  scopes: [{ id: "sage", name: "Sage" }, { id: "luna", name: "Luna" }],
};
const CONFIG: GatewayConfig = {
  name: "session-management-test",
  port: 0,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermes: {
    url: "ws://127.0.0.1:1/api/ws",
    tokenEnv: "TEST_HERMES_CONTROL_TOKEN",
    profiles: {
      sage: { tokenEnv: "TEST_ATTACH_TOKEN" },
      luna: { tokenEnv: "TEST_ATTACH_TOKEN_2" },
    },
  },
};

type ResponseHandler = (
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal },
) => Response | Promise<Response>;

function json(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
  });
}

function client(handler: ResponseHandler): HermesClient {
  return {
    dashboardResponse: (path, init = {}) => handler(path, init),
  } as HermesClient;
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "hermes-1",
    _lineage_root_id: "lineage-root",
    title: "Release notes",
    started_at: 1_700_000_000,
    last_active: 1_700_000_100,
    message_count: 4,
    archived: false,
    pinned: true,
    ...overrides,
  };
}

function surface(handler: ResponseHandler, opts: ConstructorParameters<typeof HermesSessionManagementAdapter>[2] = {}) {
  const adapter = new HermesSessionManagementAdapter(client(handler), HARNESS, opts);
  return { adapter, gateway: new GatewayHermesSessionManagement([adapter]) };
}

function appFor(handler: ResponseHandler) {
  const storage = openStorage(":memory:");
  storage.createDevice({ id: "device", name: "Phone", tokenHash: hashToken(TOKEN), createdAt: 1 });
  const sessions = surface(handler).gateway;
  const app = createApp({
    storage,
    config: CONFIG,
    gatewayInfo: { name: "g", version: "test", contract: "v1" },
    hermesSessions: sessions,
    presenceOf: () => "online",
    submitUserMessage: (_threadId: string, blocks: RichBlock[]): Message => ({
      threadId: "t", seq: 1, role: "user", blocks, createdAt: 1,
    }),
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1,
  });
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { app, request };
}

const BASE = "/gateway/harnesses/home/scopes/sage/sessions";

describe("paired scope and bounds", () => {
  it("requires device auth and an exact visible harness/profile", async () => {
    const calls = vi.fn();
    const { app, request } = appFor((path) => { calls(path); return json({ sessions: [], total: 0 }); });
    expect((await app.request(BASE)).status).toBe(401);
    expect((await request("/gateway/harnesses/other/scopes/sage/sessions")).status).toBe(404);
    expect((await request("/gateway/harnesses/home/scopes/hidden/sessions")).status).toBe(404);
    expect(calls).not.toHaveBeenCalled();
  });

  it("rejects out-of-range list/search/message requests before Hermes", async () => {
    const calls = vi.fn();
    const { request } = appFor((path) => { calls(path); return json({}); });
    expect((await request(`${BASE}?limit=101`)).status).toBe(400);
    expect((await request(`${BASE}?offset=100001`)).status).toBe(400);
    expect((await request(`${BASE}/search?q=${"x".repeat(257)}`)).status).toBe(400);
    expect((await request(`${BASE}/hermes-1/messages?limit=201`)).status).toBe(400);
    expect((await request(`${BASE}/hermes-1/messages?order=random`)).status).toBe(400);
    expect(calls).not.toHaveBeenCalled();
  });

  it("does not expose ordinary upstream errors", async () => {
    const { request } = appFor(() => {
      throw new Error("database failed at /Users/operator/private/state.db with token SECRET");
    });
    const response = await request(BASE);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).toBe(
      '{"error":{"code":"backend_unavailable","message":"Hermes session upstream is unavailable"}}',
    );
  });
});

describe("privacy projection", () => {
  it("list exposes only approved fields and redacts host paths", async () => {
    const { request } = appFor(() => json({
      sessions: [row({
        title: "Work at /Users/operator/private/repo",
        cwd: "/Users/operator/private/repo",
        system_prompt: "SECRET SYSTEM PROMPT",
        model_config: { api_key: "secret" },
        preview: "tool result: password",
      })],
      total: 1,
    }));
    const response = await request(BASE);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessions[0]).toEqual({
      hermesSessionId: "hermes-1",
      hermesLineageId: "lineage-root",
      title: "Work at <path>",
      startedAt: 1_700_000_000_000,
      lastActiveAt: 1_700_000_100_000,
      messageCount: 4,
      archived: false,
      pinned: true,
    });
    expect(JSON.stringify(body)).not.toMatch(/operator|SECRET|api_key|password|cwd|model_config/);
    expect(JSON.stringify(body)).not.toContain('"sessionId"');
  });

  it("messages drop system/tool rows, arguments, results, reasoning, and path directives", async () => {
    const { request } = appFor((path) => path.includes("/messages?")
      ? json({
          session_id: "hermes-1",
          messages: [
            { id: 1, role: "system", content: "SECRET SYSTEM PROMPT" },
            { id: 2, role: "tool", content: "SECRET TOOL RESULT", args: { token: "secret" } },
            { id: 3, role: "user", content: "hello\n@image:/Users/operator/.hermes/upload.png", timestamp: 1_700_000_002 },
            { id: 4, role: "assistant", content: "saved at /Users/operator/private/out.txt", reasoning: "hidden" },
            { id: 5, role: "assistant", content: [{ type: "tool_use", input: { command: "rm -rf /" } }] },
            { id: 6, role: "assistant", content: [{ type: "tool_result", content: "SECRET NESTED RESULT" }] },
          ],
        })
      : json(row()));
    const response = await request(`${BASE}/hermes-1/messages?limit=20&order=oldest`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toEqual([
      { role: "user", text: "hello", hermesMessageId: "3", createdAt: 1_700_000_002_000 },
      { role: "assistant", text: "saved at <path>", hermesMessageId: "4" },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/SECRET|reasoning|command|operator|tool/);
  });
});

describe("search lineage", () => {
  it("keeps the compression root, rereads the tip, and excludes hidden-role hits", async () => {
    const { request } = appFor((path) => path.includes("/search?")
      ? json({ results: [
          row({
            id: "compression-tip",
            lineage_root: "compression-root",
            role: "user",
            snippet: "match in /Users/operator/private/file.txt",
            pinned: undefined,
          }),
          row({ id: "private-hit", lineage_root: "private-root", role: "system", snippet: "SECRET" }),
        ] })
      : json(row({ id: "compression-tip", pinned: true })));
    const response = await request(`${BASE}/search?q=match&limit=10`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      hermesSessionId: "compression-tip",
      hermesLineageId: "compression-root",
      snippet: "Matching user message",
      matchedRole: "user",
      pinned: true,
    });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });
});

describe("serialized authoritative mutations", () => {
  it("serializes writes per profile and rereads after each PATCH", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const events: string[] = [];
    let state = row({ title: "Before", archived: false, pinned: false });
    let patches = 0;
    const { adapter } = surface(async (path, init) => {
      if (init.method === "PATCH") {
        patches += 1;
        events.push(`PATCH:${patches}`);
        if (patches === 1) await firstGate;
        state = { ...state, ...(init.body as Record<string, unknown>) };
        return json({ ok: true });
      }
      events.push("GET");
      return json(state);
    });

    const first = adapter.patch("sage", "hermes-1", { archived: true });
    const second = adapter.patch("sage", "hermes-1", { pinned: true });
    await vi.waitFor(() => expect(patches).toBe(1));
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a.session.archived).toBe(true);
    expect(b.session).toMatchObject({ archived: true, pinned: true });
    expect(events).toEqual(["GET", "PATCH:1", "GET", "GET", "PATCH:2", "GET"]);
  });

  it("marks a timed-out mutation ambiguous and never returns the upstream path", async () => {
    const { request } = appFor((_path, init) => {
      if (init.method === "PATCH")
        throw new DOMException("timed out at /Users/operator/private/state.db", "TimeoutError");
      return json(row());
    });
    const response = await request(`${BASE}/hermes-1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: false }),
    });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.refreshRequired).toBe(true);
    expect(JSON.stringify(body)).not.toContain("/Users/");
  });

  it("keeps DELETE idempotent and rereads absence after a real delete", async () => {
    let exists = false;
    let deletes = 0;
    const { request } = appFor((_path, init) => {
      if (init.method === "DELETE") { deletes += 1; exists = false; return json({ ok: true }); }
      return exists ? json(row()) : json({ detail: "Session not found" }, 404);
    });
    expect((await request(`${BASE}/hermes-1`, { method: "DELETE" })).status).toBe(204);
    expect(deletes).toBe(0);
    exists = true;
    expect((await request(`${BASE}/hermes-1`, { method: "DELETE" })).status).toBe(204);
    expect(deletes).toBe(1);
  });
});

describe("streamed export", () => {
  it("serves a private JSON attachment containing only projected rows", async () => {
    const { request } = appFor((path) => path.includes("/messages?")
      ? json({ session_id: "hermes-1", messages: [
          { role: "system", content: "SECRET" },
          { role: "assistant", content: "done" },
        ] })
      : json(row()));
    const response = await request(`${BASE}/hermes-1/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.messages).toEqual([{ role: "assistant", text: "done" }]);
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("propagates cancellation into the active upstream page", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let upstreamAborted = false;
    const { adapter } = surface((path, init) => {
      if (!path.includes("/messages?")) return json(row());
      upstreamSignal = init.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener("abort", () => {
            upstreamAborted = true;
            controller.error(new DOMException("cancelled", "AbortError"));
          }, { once: true });
        },
      }));
    });
    const exported = await adapter.export("sage", "hermes-1", new AbortController().signal);
    const reader = exported.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"session"');
    const pending = reader.read().catch(() => undefined);
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    await reader.cancel("test cancellation");
    await pending;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstreamAborted).toBe(true);
  });

  it("fails the stream once projected JSON exceeds the export size cap", async () => {
    const { adapter } = surface((path) => path.includes("/messages?")
      ? json({ session_id: "hermes-1", messages: [] })
      : json(row()), { exportMaxBytes: 32 });
    const exported = await adapter.export("sage", "hermes-1", new AbortController().signal);
    const reader = exported.body.getReader();
    await expect(reader.read()).rejects.toThrow(/size cap/i);
  });
});

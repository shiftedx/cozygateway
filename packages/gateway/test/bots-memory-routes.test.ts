import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { AttachMemorySurface, MemoryConflict, type MemorySurface } from "../src/hermes-bridge/memory.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";

type Env = { Variables: { deviceId: string } };
const item = { id: "fact:1", sourceId: "holographic", kind: "fact" as const, title: "Cleo", snippet: "Cleo likes concise reports", createdAt: 1, updatedAt: 2, timestampKind: "created" as const, revision: "r1", category: "user_pref", tags: ["cleo"], trustScore: 0.9 };

function appFor(memory: Partial<MemorySurface>) {
  const app = new Hono<Env>();
  const requireDevice: MiddlewareHandler<Env> = async (c, next) => { c.set("deviceId", "device"); await next(); };
  registerBotRoutes(app, requireDevice, {} as BotsSurface, {}, {}, memory as MemorySurface);
  return app;
}

describe("capability-30 bot memory routes", () => {
  it("keeps source labels and bounded query filters on the attached management surface", async () => {
    const items = vi.fn(async () => ({ items: [item], sources: [] }));
    const app = appFor({ overview: async () => ({ sources: [] }), items, graph: async () => ({ nodes: [], edges: [] }) });
    const response = await app.request("/bots/CLEO/memory/items?q=reports&source=holographic&kind=fact&since=1&until=2&limit=20");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [item], sources: [] });
    expect(items).toHaveBeenCalledWith("cleo", { q: "reports", sourceId: "holographic", kind: "fact", since: 1, until: 2, limit: 20 });
    expect((await app.request("/bots/cleo/memory/items?limit=101")).status).toBe(400);
  });

  it("requires an expected revision and returns the current item for a conflict", async () => {
    const update = vi.fn(async () => { throw new MemoryConflict(item); });
    const app = appFor({ update, overview: async () => ({ sources: [] }) });
    const missing = await app.request("/bots/cleo/memory/sources/holographic/items/fact:1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "new" }) });
    expect(missing.status).toBe(400);
    const conflict = await app.request("/bots/cleo/memory/sources/holographic/items/fact:1", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "new", expectedRevision: "r0" }) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "conflict", message: "memory item changed; refresh and try again" }, current: item });
  });

  it("correlates an ephemeral attach reply without accepting a late duplicate", async () => {
    const sent: Array<{ requestId: string }> = [];
    const memory = new AttachMemorySurface({ sendMemoryRequest: (_agent, command) => { sent.push(command); return true; } });
    const pending = memory.overview("cleo");
    expect(sent).toHaveLength(1);
    const frame = { kind: "memory_result" as const, requestId: sent[0]!.requestId, status: "ok" as const, result: { sources: [] } };
    expect(memory.handle("cleo", frame)).toBe(true);
    await expect(pending).resolves.toEqual({ sources: [] });
    expect(memory.handle("cleo", frame)).toBe(false);
  });
});

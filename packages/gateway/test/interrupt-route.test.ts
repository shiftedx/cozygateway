import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";

let gateway: RunningGateway;

beforeEach(async () => {
  gateway = await startGateway({
    name: "interrupt-e2e",
    port: 0,
    dbPath: ":memory:",
    agents: [
      { id: "echo", name: "Echo", backend: "mock" },
      { id: "steer", name: "Steer", backend: "mock-steer" },
    ],
  });
});

afterEach(async () => {
  await gateway.close();
});

async function pair(): Promise<string> {
  const res = await fetch(`${gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
  });
  return ((await res.json()) as { deviceToken: string }).deviceToken;
}

async function thread(token: string, agentId: string): Promise<string> {
  const res = await fetch(`${gateway.url}/threads`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  return ((await res.json()) as { id: string }).id;
}

async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3_000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("POST /threads/:id/interrupt", () => {
  it("401 without a token", async () => {
    const res = await fetch(`${gateway.url}/threads/anything/interrupt`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("404 for an unknown thread", async () => {
    const token = await pair();
    const res = await fetch(`${gateway.url}/threads/no-such/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("204 with no body when the thread is idle", async () => {
    const token = await pair();
    const id = await thread(token, "echo");
    const res = await fetch(`${gateway.url}/threads/${id}/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("202 {status:interrupting} for a steer-capable in-flight turn, then turn.interrupted + done", async () => {
    const token = await pair();
    const id = await thread(token, "steer");
    const frames: ServerFrame[] = [];
    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    ws.on("message", (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token }));
    await until(() => frames.some((f) => f.type === "ready"));

    await fetch(`${gateway.url}/threads/${id}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "long task" }] }),
    });
    await until(() => frames.some((f) => f.type === "draft"));

    const res = await fetch(`${gateway.url}/threads/${id}/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "interrupting" });

    await until(() => frames.some((f) => f.type === "done"));
    const committed = frames.filter(
      (f): f is Extract<ServerFrame, { type: "committed" }> => f.type === "committed",
    );
    const sys: Message | undefined = committed.map((f) => f.message).find((m) => m.role === "system");
    expect(sys?.marker).toBe("turn.interrupted");
    expect(frames.some((f) => f.type === "error")).toBe(false);
    ws.close();
  });
});

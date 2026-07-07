import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";

let gateway: RunningGateway;

beforeEach(async () => {
  gateway = await startGateway({
    name: "e2e",
    port: 0,
    dbPath: ":memory:",
    agents: [{ id: "mock", name: "Mock", backend: "mock" }],
  });
});

afterEach(async () => {
  await gateway.close();
});

describe("startGateway end to end", () => {
  it("pairs, creates a thread, sends, and observes the stream on WS", async () => {
    const code = gateway.issueSetupCode();
    const pairRes = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "e2e phone" }),
    });
    expect(pairRes.status).toBe(200);
    const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

    const seen: ServerFrame[] = [];
    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: deviceToken }));

    const authed = { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };
    const threadRes = await fetch(`${gateway.url}/threads`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ agentId: "mock" }),
    });
    const thread = (await threadRes.json()) as { id: string };

    const sendRes = await fetch(`${gateway.url}/threads/${thread.id}/messages`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "round trip" }] }),
    });
    expect(sendRes.status).toBe(200);

    const start = Date.now();
    while (!seen.some((f) => f.type === "done")) {
      if (Date.now() - start > 5_000) throw new Error(`timeout; saw ${JSON.stringify(seen)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen.filter((f) => f.type === "draft").length).toBeGreaterThanOrEqual(1);
    const commits = seen.filter((f) => f.type === "committed");
    expect(commits.map((f) => (f.type === "committed" ? f.message.role : ""))).toEqual(["user", "agent"]);
    ws.close();
  });
});

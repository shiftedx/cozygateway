import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message, ServerFrame } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { buildAdapters } from "../src/adapters/registry.ts";

const TOKEN_ENV = "E2E_ATTACH_TOKEN";
const TOKEN = "e2e-attach-token";

let gateway: RunningGateway;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  process.env[TOKEN_ENV] = TOKEN;
  gateway = await startGateway({
    name: "attach-e2e",
    port: 0,
    dbPath: ":memory:",
    agents: [
      {
        id: "helper",
        name: "Helper",
        backend: "attach",
        options: { tokenEnv: TOKEN_ENV, turnTimeoutSeconds: 5 },
      },
    ],
  });
});

afterEach(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  sockets.length = 0;
  await gateway.close();
  delete process.env[TOKEN_ENV];
});

function track(socket: WebSocket): WebSocket {
  sockets.push(socket);
  return socket;
}

async function pairDevice(): Promise<string> {
  const code = gateway.issueSetupCode();
  const res = await fetch(`${gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "e2e phone" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { deviceToken: string };
  return body.deviceToken;
}

async function createThread(deviceToken: string): Promise<string> {
  const res = await fetch(`${gateway.url}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({ agentId: "helper", title: "e2e" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function openClientWs(deviceToken: string, frames: ServerFrame[]): Promise<WebSocket> {
  const ws = track(new WebSocket(`${gateway.url.replace("http", "ws")}/ws`));
  await once(ws, "open");
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
  ws.send(JSON.stringify({ type: "auth", token: deviceToken }));
  await until(() => frames.some((f) => f.type === "ready"));
  return ws;
}

/** A scripted fake harness: dials /attach and answers every turn frame with two drafts (the
 *  second carrying a tool chip) and done. */
async function attachFakeHarness(): Promise<WebSocket> {
  const ws = track(
    new WebSocket(`${gateway.url.replace("http", "ws")}/attach`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  await once(ws, "open");
  ws.on("message", (data) => {
    const frame = JSON.parse(String(data)) as { threadId: string; turnId: string; text: string };
    const send = (update: unknown) => ws.send(JSON.stringify({ threadId: frame.threadId, update }));
    send({ kind: "draft", turnId: frame.turnId, blocks: [{ type: "paragraph", text: "Thinking" }] });
    send({
      kind: "draft",
      turnId: frame.turnId,
      blocks: [{ type: "paragraph", text: `You said: ${frame.text}` }],
      toolCalls: [{ id: "lookup#1", name: "lookup", status: "ok" }],
    });
    send({ kind: "done", turnId: frame.turnId });
  });
  return ws;
}

async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3_000) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("attach backend end to end", () => {
  it("streams a live turn from an attached harness through to the client", async () => {
    const deviceToken = await pairDevice();
    const frames: ServerFrame[] = [];
    await openClientWs(deviceToken, frames);

    // Before the harness attaches: absent, and a send fails as a turn.failed marker.
    const agentsBefore = await fetch(`${gateway.url}/agents`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const listBefore = (await agentsBefore.json()) as Array<{ id: string; presence: string }>;
    expect(listBefore[0]?.presence).toBe("absent");

    const threadId = await createThread(deviceToken);
    const failedSend = await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "anyone home?" }] }),
    });
    expect(failedSend.status).toBe(200); // the user message commits; the TURN fails
    await until(() => frames.some((f) => f.type === "error" && f.code === "turn_failed"));

    // Harness attaches: presence flips online (frame + REST agree).
    await attachFakeHarness();
    await until(() => frames.some((f) => f.type === "presence" && f.state === "online"));
    const agentsAfter = await fetch(`${gateway.url}/agents`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const listAfter = (await agentsAfter.json()) as Array<{ presence: string }>;
    expect(listAfter[0]?.presence).toBe("online");

    // A live turn: drafts stream (tool chip included), the reply commits, done arrives.
    const sendRes = await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "hello agent" }] }),
    });
    expect(sendRes.status).toBe(200);
    await until(() => frames.some((f) => f.type === "done"));

    const drafts = frames.filter(
      (f): f is Extract<ServerFrame, { type: "draft" }> => f.type === "draft",
    );
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts[drafts.length - 1]?.toolCalls).toEqual([
      { id: "lookup#1", name: "lookup", status: "ok" },
    ]);
    const committed = frames.filter(
      (f): f is Extract<ServerFrame, { type: "committed" }> => f.type === "committed",
    );
    const agentReply: Message | undefined = committed
      .map((f) => f.message)
      .find((m) => m.role === "agent");
    expect(agentReply?.blocks).toEqual([{ type: "paragraph", text: "You said: hello agent" }]);
  });

  it("fails the in-flight turn and flips presence when the harness drops mid-turn", async () => {
    const deviceToken = await pairDevice();
    const frames: ServerFrame[] = [];
    await openClientWs(deviceToken, frames);
    const threadId = await createThread(deviceToken);

    // A harness that answers with one draft and then hangs (never done).
    const harness = track(
      new WebSocket(`${gateway.url.replace("http", "ws")}/attach`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    );
    await once(harness, "open");
    harness.on("message", (data) => {
      const frame = JSON.parse(String(data)) as { threadId: string; turnId: string };
      harness.send(
        JSON.stringify({
          threadId: frame.threadId,
          update: {
            kind: "draft",
            turnId: frame.turnId,
            blocks: [{ type: "paragraph", text: "partial" }],
          },
        }),
      );
    });
    await until(() => frames.some((f) => f.type === "presence" && f.state === "online"));

    await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "hi" }] }),
    });
    await until(() => frames.some((f) => f.type === "draft"));

    harness.close();
    await until(() => frames.some((f) => f.type === "error" && f.code === "turn_failed"));
    await until(() => frames.some((f) => f.type === "presence" && f.state === "absent"));

    // The failed turn left a turn.failed marker, not a committed agent reply.
    const history = await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const body = (await history.json()) as { messages: Message[] };
    expect(body.messages.some((m) => m.marker === "turn.failed")).toBe(true);
    expect(body.messages.some((m) => m.role === "agent")).toBe(false);
  });

  it("rejects an upgrade to an unknown path with an HTTP error instead of hanging", async () => {
    const ws = track(new WebSocket(`${gateway.url.replace("http", "ws")}/nope`));
    const [err] = (await once(ws, "error")) as [Error];
    expect(err.message).toMatch(/Unexpected server response: 404/);
  });

  it("serves /ws and /attach concurrently on the same server without cross-corruption", async () => {
    const deviceToken = await pairDevice();
    const clientFrames: ServerFrame[] = [];

    // Dial both endpoints at the same time: this is exactly the race the shared noServer
    // dispatcher has to get right (two WebSocketServer instances on one http.Server).
    const [clientWs, harnessWs] = await Promise.all([
      openClientWs(deviceToken, clientFrames),
      attachFakeHarness(),
    ]);
    expect(clientWs.readyState).toBe(WebSocket.OPEN);
    expect(harnessWs.readyState).toBe(WebSocket.OPEN);
    // Poll presence via REST rather than the client's frame stream: since both sockets dial
    // concurrently, the presence broadcast can fire before the client finishes authenticating,
    // and a broadcast only reaches already-authenticated clients.
    const start = Date.now();
    for (;;) {
      const res = await fetch(`${gateway.url}/agents`, {
        headers: { authorization: `Bearer ${deviceToken}` },
      });
      const agents = (await res.json()) as Array<{ id: string; presence: string }>;
      if (agents.find((a) => a.id === "helper")?.presence === "online") break;
      if (Date.now() - start > 3_000) throw new Error("timeout waiting for presence online");
      await new Promise((r) => setTimeout(r, 10));
    }

    const threadId = await createThread(deviceToken);
    const sendRes = await fetch(`${gateway.url}/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "concurrent dial" }] }),
    });
    expect(sendRes.status).toBe(200);
    await until(() => clientFrames.some((f) => f.type === "done"));
    expect(clientFrames.some((f) => f.type === "draft")).toBe(true);
  });

  it("startGateway fails closed when the token env var is missing", async () => {
    delete process.env[TOKEN_ENV];
    await expect(
      startGateway({
        name: "bad",
        port: 0,
        dbPath: ":memory:",
        agents: [{ id: "x", name: "X", backend: "attach", options: { tokenEnv: TOKEN_ENV } }],
      }),
    ).rejects.toThrow(new RegExp(TOKEN_ENV));
  });
});

describe("buildAdapters attach branch", () => {
  it("requires the attach wiring", () => {
    expect(() =>
      buildAdapters([{ id: "a1", name: "A", backend: "attach", options: { tokenEnv: "X" } }]),
    ).toThrow(/attach/);
  });
});

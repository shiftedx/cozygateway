/** POST /threads/:id/approvals/:toolCallId/{approve,deny} end to end through the real HTTP + WS
 *  stack (issue #19, core lane), driven by the mock-approval backend. */
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";
import { ApprovalPendingFrameSchema, ApprovalResolveResponseSchema, assertValid } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";

let gateway: RunningGateway;
const auditLines: string[] = [];

beforeEach(async () => {
  auditLines.length = 0;
  gateway = await startGateway(
    {
      name: "approvals-e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      agents: [
        { id: "echo", name: "Echo", backend: "mock" },
        { id: "approver", name: "Approver", backend: "mock-approval" },
        // Same backend with a deliberately tiny approval window: the only way to drive the third
        // terminal state (expired) without waiting on a real approval timeout.
        { id: "expirer", name: "Expirer", backend: "mock-approval", options: { expiryMs: 40 } },
      ],
    },
    { approvalLog: (line) => auditLines.push(line) },
  );
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

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3_000) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function socket(token: string): Promise<{ ws: WebSocket; frames: ServerFrame[] }> {
  const frames: ServerFrame[] = [];
  const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
  ws.on("error", () => {});
  ws.on("message", (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", token }));
  await until(() => frames.some((f) => f.type === "ready"), "ready");
  return { ws, frames };
}

/** Send into an approval-capable thread and wait for the pending frame it raises. */
async function pending(
  token: string,
  threadId: string,
  frames: ServerFrame[],
  text = "delete things",
): Promise<{ toolCallId: string; turnId: string }> {
  await fetch(`${gateway.url}/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ blocks: [{ type: "paragraph", text }] }),
  });
  await until(() => frames.some((f) => f.type === "approval_pending"), "approval_pending");
  const frame = frames.find((f) => f.type === "approval_pending");
  const valid = assertValid(ApprovalPendingFrameSchema, frame);
  return { toolCallId: valid.toolCallId, turnId: valid.turnId };
}

function resolve(
  token: string,
  threadId: string,
  toolCallId: string,
  verb: "approve" | "deny",
): Promise<Response> {
  return fetch(`${gateway.url}/threads/${threadId}/approvals/${toolCallId}/${verb}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("approval verbs", () => {
  it("401 without a token, on both verbs", async () => {
    for (const verb of ["approve", "deny"] as const) {
      const res = await fetch(`${gateway.url}/threads/anything/approvals/call_1/${verb}`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    }
  });

  it("404 for an unknown thread", async () => {
    const token = await pair();
    const res = await resolve(token, "no-such-thread", "call_1", "approve");
    expect(res.status).toBe(404);
  });

  it("404 for a toolCallId this gateway never issued", async () => {
    const token = await pair();
    const id = await thread(token, "approver");
    const res = await resolve(token, id, "call_never", "approve");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("approves: 202 {status:approved}, one approval_resolved frame, one audit line", async () => {
    const token = await pair();
    const id = await thread(token, "approver");
    const { ws, frames } = await socket(token);
    try {
      const { toolCallId, turnId } = await pending(token, id, frames);
      const res = await resolve(token, id, toolCallId, "approve");
      expect(res.status).toBe(202);
      expect(assertValid(ApprovalResolveResponseSchema, await res.json()).status).toBe("approved");

      await until(() => frames.some((f) => f.type === "approval_resolved"), "approval_resolved");
      const resolved = frames.filter((f) => f.type === "approval_resolved");
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ threadId: id, turnId, toolCallId, outcome: "approved" });

      // The turn then finishes normally: the approval unblocked it.
      await until(() => frames.some((f) => f.type === "done"), "done");
      expect(auditLines).toHaveLength(1);
      expect(auditLines[0]).toContain(`toolCall=${toolCallId}`);
      expect(auditLines[0]).toContain("approved");
    } finally {
      ws.close();
    }
  });

  it("denies: 202 {status:denied} and an approval_resolved(denied)", async () => {
    const token = await pair();
    const id = await thread(token, "approver");
    const { ws, frames } = await socket(token);
    try {
      const { toolCallId } = await pending(token, id, frames);
      const res = await resolve(token, id, toolCallId, "deny");
      expect(res.status).toBe(202);
      expect(assertValid(ApprovalResolveResponseSchema, await res.json()).status).toBe("denied");
      await until(() => frames.some((f) => f.type === "approval_resolved"), "approval_resolved");
      expect(frames.find((f) => f.type === "approval_resolved")).toMatchObject({ outcome: "denied" });
    } finally {
      ws.close();
    }
  });

  it("409 approval_not_pending when the same approval is resolved twice", async () => {
    const token = await pair();
    const id = await thread(token, "approver");
    const { ws, frames } = await socket(token);
    try {
      const { toolCallId } = await pending(token, id, frames);
      expect((await resolve(token, id, toolCallId, "approve")).status).toBe(202);
      const second = await resolve(token, id, toolCallId, "deny");
      expect(second.status).toBe(409);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe(
        "approval_not_pending",
      );
      expect(frames.filter((f) => f.type === "approval_resolved")).toHaveLength(1);
    } finally {
      ws.close();
    }
  });

  it("409 approval_expired after the backend's own timeout lapsed, never 'denied'", async () => {
    const token = await pair();
    const id = await thread(token, "expirer");
    const { ws, frames } = await socket(token);
    try {
      const { toolCallId } = await pending(token, id, frames);
      await until(() => frames.some((f) => f.type === "approval_resolved"), "approval_resolved");
      expect(frames.find((f) => f.type === "approval_resolved")).toMatchObject({
        outcome: "expired",
      });

      const late = await resolve(token, id, toolCallId, "approve");
      expect(late.status).toBe(409);
      expect(((await late.json()) as { error: { code: string } }).error.code).toBe(
        "approval_expired",
      );
    } finally {
      ws.close();
    }
  });

  it("advertises the approvals capability so a client can feature-gate the verbs", async () => {
    const info = (await (await fetch(`${gateway.url}/health`)).json()) as {
      capabilities?: Record<string, number>;
    };
    expect(info.capabilities?.["approvals"]).toBe(1);
  });
});

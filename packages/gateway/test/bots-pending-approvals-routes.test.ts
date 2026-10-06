import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { PENDING_APPROVALS_LIMIT, registerBotRoutes } from "../src/hermes-bridge/routes.ts";

type Env = { Variables: { deviceId: string } };

describe("capability-27 pending approval inbox", () => {
  it("returns the bounded durable snapshot and accepts only pending state", async () => {
    const app = new Hono<Env>();
    const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
      c.set("deviceId", "device-1");
      await next();
    };
    const pendingApprovals = vi.fn(() => Array.from({ length: PENDING_APPROVALS_LIMIT + 1 }, (_, index) => ({
      bot: "sage", sessionId: "session-1", turnId: `turn-${index}`, toolCallId: `call-${index}`,
      ruleName: "workspace.write", createdAt: index,
    })));
    registerBotRoutes(app, requireDevice, { pendingApprovals } as unknown as BotsSurface);

    const response = await app.request("/bots/approvals?state=pending");

    expect(response.status).toBe(200);
    expect(pendingApprovals).toHaveBeenCalledOnce();
    expect((await response.json() as { approvals: unknown[] }).approvals).toHaveLength(PENDING_APPROVALS_LIMIT);
    expect((await app.request("/bots/approvals?state=resolved")).status).toBe(400);
  });

  it("includes bounded clarification and terminal settlement recovery without treating a request as confirmation", async () => {
    const app = new Hono<Env>();
    const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
      c.set("deviceId", "device-1");
      await next();
    };
    registerBotRoutes(app, requireDevice, {
      pendingApprovals: () => [],
      pendingClarifications: () => [{
        bot: "sage", sessionId: "session-1", turnId: "turn-1", clarifyId: "clarify-1",
        prompt: "Pick one", options: [{ id: "a", label: "A" }],
        resolutionRequestedAt: 7,
      }],
      terminalSettlements: () => [{
        bot: "sage", kind: "approval", interactionId: "approval-1", sessionId: "session-1",
        turnId: "turn-1", outcome: "approved", settledAt: 8,
      }],
    } as unknown as BotsSurface);

    expect(await (await app.request("/bots/approvals?state=pending")).json()).toEqual({
      approvals: [],
      clarifications: [{
        bot: "sage", sessionId: "session-1", turnId: "turn-1", clarifyId: "clarify-1",
        prompt: "Pick one", options: [{ id: "a", label: "A" }], resolutionRequestedAt: 7,
      }],
      settlements: [{
        bot: "sage", kind: "approval", interactionId: "approval-1", sessionId: "session-1",
        turnId: "turn-1", outcome: "approved", settledAt: 8,
      }],
    });
  });

  it("reports command admission as requested and rejects a conflicting pending choice", async () => {
    const app = new Hono<Env>();
    const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
      c.set("deviceId", "device-1");
      await next();
    };
    const resolveApproval = vi.fn(async () => "requested" as const);
    const resolveClarify = vi.fn(async () => "resolution_pending" as const);
    registerBotRoutes(app, requireDevice, { resolveApproval, resolveClarify } as unknown as BotsSurface);

    const approval = await app.request("/bots/sage/approvals/call-1/approve", { method: "POST" });
    expect(approval.status).toBe(202);
    expect(await approval.json()).toEqual({ status: "requested" });
    expect(resolveApproval).toHaveBeenCalledWith("sage", "call-1", "approve", "device-1");

    const clarify = await app.request("/bots/sage/clarifications/clarify-1", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ optionId: "b" }),
    });
    expect(clarify.status).toBe(409);
    expect(await clarify.json()).toEqual({ error: { code: "approval_resolution_pending", message: "a different selection is already awaiting confirmation" } });
  });
});

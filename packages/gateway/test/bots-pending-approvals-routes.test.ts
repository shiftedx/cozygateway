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
});

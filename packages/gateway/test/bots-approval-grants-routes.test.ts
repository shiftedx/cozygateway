/** Capability 66 at the ROUTE seam (contract/ext-bots-v1.md row 66). A decision may ask for a
 *  standing grant, an always-require action refuses one, and the revocation view lists and ends
 *  the grants a bot holds. A client below 66 sends no body at all, and that request must reach the
 *  surface exactly as it did before this row existed. */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";

type Env = { Variables: { deviceId: string } };

function mount(surface: Partial<BotsSurface>): Hono<Env> {
  const app = new Hono<Env>();
  const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
    c.set("deviceId", "device-1");
    await next();
  };
  registerBotRoutes(app, requireDevice, surface as unknown as BotsSurface);
  return app;
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("capability-66 scoped approval decisions and grants", () => {
  it("passes no grant request at all for a body-less approve, exactly as a client below 66 sends it", async () => {
    const resolveApproval = vi.fn(async () => "requested" as const);
    const response = await mount({ resolveApproval }).request(
      "/bots/sage/approvals/call-1/approve",
      { method: "POST" },
    );

    expect(response.status).toBe(202);
    expect(resolveApproval).toHaveBeenCalledWith("sage", "call-1", "approve", "device-1");
  });

  it("carries a category grant request with its bound to the surface", async () => {
    const resolveApproval = vi.fn(async () => "requested" as const);
    const response = await mount({ resolveApproval }).request(
      "/bots/sage/approvals/call-1/approve",
      json({ grant: "category", expiresAt: 9_000_000 }),
    );

    expect(response.status).toBe(202);
    expect(resolveApproval).toHaveBeenCalledWith("sage", "call-1", "approve", "device-1", {
      grant: "category",
      expiresAt: 9_000_000,
    });
  });

  it("refuses a body that names a bound without a category, a category without a bound, or an unknown field", async () => {
    const app = mount({ resolveApproval: vi.fn(async () => "requested" as const) });

    for (const body of [
      { expiresAt: 9_000_000 },
      { grant: "category" },
      { grant: "category", expiresAt: 9_000_000, note: "please" },
      { grant: "forever" },
    ]) {
      const response = await app.request("/bots/sage/approvals/call-1/approve", json(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("answers 409 for an always-require action and for an approval with nothing to bound a grant by", async () => {
    const forbidden = await mount({ resolveApproval: async () => "category_forbidden" as const })
      .request("/bots/sage/approvals/call-1/approve", json({ grant: "category", expiresAt: 9_000_000 }));
    expect(forbidden.status).toBe(409);
    expect(await forbidden.json()).toEqual({
      error: {
        code: "approval_category_forbidden",
        message: "this action requires approval on every invocation and cannot be granted a category",
      },
    });

    const missing = await mount({ resolveApproval: async () => "scope_required" as const })
      .request("/bots/sage/approvals/call-1/approve", json({ grant: "category", expiresAt: 9_000_000 }));
    expect(missing.status).toBe(409);
    expect((await missing.json() as { error: { code: string } }).error.code)
      .toBe("approval_scope_required");

    const bound = await mount({ resolveApproval: async () => "invalid_grant" as const })
      .request("/bots/sage/approvals/call-1/approve", json({ grant: "category", expiresAt: 1 }));
    expect(bound.status).toBe(400);
  });

  it("answers 409 rather than success when the decision stands but the grant was not created", async () => {
    const response = await mount({ resolveApproval: async () => "grant_not_recorded" as const })
      .request("/bots/sage/approvals/call-1/approve", json({ grant: "once" }));

    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe("approval_grant_not_recorded");
  });

  it("never reads a body on a deny, so a denial stays the pre-66 request", async () => {
    const resolveApproval = vi.fn(async () => "requested" as const);
    const response = await mount({ resolveApproval }).request(
      "/bots/sage/approvals/call-1/deny",
      json({ grant: "category", expiresAt: 9_000_000 }),
    );

    expect(response.status).toBe(202);
    expect(resolveApproval).toHaveBeenCalledWith("sage", "call-1", "deny", "device-1");
  });

  it("lists the standing grants and revokes one, answering 404 for a grant it does not hold", async () => {
    const grant = {
      grantId: "grant:sage:approval-1",
      scope: "category" as const,
      action: "workspace.write",
      category: "other" as const,
      system: "workspace",
      resource: "repo/notes.md",
      sessionId: "session-1",
      expiresAt: 9_000_000,
      createdAt: 1_000,
    };
    const revokeApprovalGrant = vi.fn(
      (_name: string, grantId: string) => grantId === grant.grantId ? "revoked" as const : "unknown" as const,
    );
    const app = mount({ approvalGrants: () => [grant], revokeApprovalGrant });

    expect(await (await app.request("/bots/sage/approvals/grants")).json()).toEqual({ grants: [grant] });

    const revoked = await app.request(`/bots/sage/approvals/grants/${grant.grantId}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ status: "revoked" });

    const missing = await app.request("/bots/sage/approvals/grants/grant:sage:nope", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });

  it("answers an empty view and a 404 revoke on a gateway whose surface holds no grants", async () => {
    const app = mount({});
    expect(await (await app.request("/bots/sage/approvals/grants")).json()).toEqual({ grants: [] });
    expect((await app.request("/bots/sage/approvals/grants/g1", { method: "DELETE" })).status).toBe(404);
  });
});

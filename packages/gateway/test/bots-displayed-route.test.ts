import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { BotSessionNotFound } from "../src/hermes-bridge/bridge.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";

type Env = { Variables: { deviceId: string } };

/** Capability 31's app-facing route. It is a REPORT, not a request: the interesting behavior is
 *  what it refuses to turn into an error. */
describe("capability-31 displayed route", () => {
  function harness(recordDisplayed: BotsSurface["recordDisplayed"]) {
    const app = new Hono<Env>();
    const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
      const token = c.req.header("authorization");
      if (token !== "Bearer device-token") return c.json({ error: { code: "unauthorized", message: "no device" } }, 401);
      c.set("deviceId", "device-1");
      await next();
    };
    registerBotRoutes(app, requireDevice, { recordDisplayed } as unknown as BotsSurface);
    return app;
  }

  const post = (app: Hono<Env>, body: unknown, authenticated = true) =>
    app.request("/bots/SAGE/chat/messages/displayed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { authorization: "Bearer device-token" } : {}),
      },
      body: JSON.stringify(body),
    });

  it("records the batch against the canonical bot name and the calling device", async () => {
    const recordDisplayed = vi.fn(() => ({ recorded: 2 }));
    const response = await post(harness(recordDisplayed), { messageIds: ["m1", "m2"] });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ recorded: 2 });
    expect(recordDisplayed).toHaveBeenCalledWith("sage", ["m1", "m2"], "device-1");
  });

  it("answers zero rather than an error when nothing was new", async () => {
    const response = await post(harness(() => ({ recorded: 0 })), { messageIds: ["already", "ghost"] });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ recorded: 0 });
  });

  it("requires device authentication", async () => {
    const recordDisplayed = vi.fn(() => ({ recorded: 1 }));
    const response = await post(harness(recordDisplayed), { messageIds: ["m1"] }, false);
    expect(response.status).toBe(401);
    expect(recordDisplayed).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a bounded batch of ids", async () => {
    const recordDisplayed = vi.fn(() => ({ recorded: 0 }));
    const app = harness(recordDisplayed);
    for (const body of [
      {},
      { messageIds: [] },
      { messageIds: ["m1", 2] },
      { messageIds: [""] },
      { messageIds: ["x".repeat(129)] },
      { messageIds: Array.from({ length: 65 }, (_, index) => `m${index}`) },
    ]) {
      const response = await post(app, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(recordDisplayed).not.toHaveBeenCalled();
  });

  it("is 404 for a name this gateway does not run as a native bot", async () => {
    const response = await post(
      harness(() => { throw new BotSessionNotFound("sage"); }),
      { messageIds: ["m1"] },
    );
    expect(response.status).toBe(404);
  });
});

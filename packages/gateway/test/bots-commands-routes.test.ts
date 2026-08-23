import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";

type Env = { Variables: { deviceId: string } };

describe("capability-25 bot slash-command route", () => {
  it("returns the selected profile's canonical commands without rewriting invocations", async () => {
    const app = new Hono<Env>();
    const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
      c.set("deviceId", "device-1");
      await next();
    };
    const commands = vi.fn(() => [
      { name: "/status", description: "Show session status", category: "Session" },
      { name: "/queue", description: "Queue the next prompt", argsHint: "<prompt>" },
      { name: "/research-paper", description: "Run the installed skill", category: "Skills" },
    ]);
    registerBotRoutes(app, requireDevice, { commands } as unknown as BotsSurface);

    const response = await app.request("/bots/SAGE/commands");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "sage", commands: commands.mock.results[0]?.value });
    expect(commands).toHaveBeenCalledWith("sage");
  });
});

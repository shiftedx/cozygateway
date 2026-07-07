import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import {
  type ErrorBody,
  type ErrorCode,
  type GatewayInfo,
  type Message,
  type PresenceState,
  type RichBlock,
  ContractViolation,
  PairRequestSchema,
  assertValid,
} from "cozygateway-contract";

import type { GatewayConfig } from "./config.ts";
import type { Storage } from "./storage.ts";
import { hashToken, mintDeviceToken } from "./auth.ts";

export interface AppDeps {
  storage: Storage;
  config: GatewayConfig;
  gatewayInfo: GatewayInfo;
  presenceOf: (agentId: string) => PresenceState;
  submitUserMessage: (threadId: string, blocks: RichBlock[]) => Message;
  onDeviceRevoked: (deviceId: string) => void;
  now: () => number;
}

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

type Env = { Variables: { deviceId: string } };

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();

  const requireDevice = createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const device = token === "" ? undefined : deps.storage.deviceByTokenHash(hashToken(token));
    if (device === undefined) {
      return c.json(errorBody("unauthorized", "missing or unknown device token"), 401);
    }
    deps.storage.touchDevice(device.id, deps.now());
    c.set("deviceId", device.id);
    await next();
  });

  const readBody = async (c: Context<Env>): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  app.get("/health", (c) => c.json(deps.gatewayInfo));

  app.post("/pair", async (c) => {
    const body = await readBody(c);
    let pairRequest;
    try {
      pairRequest = assertValid(PairRequestSchema, body);
    } catch (err) {
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return c.json(errorBody("invalid_request", detail), 400);
    }
    if (deps.storage.consumeSetupCode(pairRequest.setupCode, deps.now()) !== "ok") {
      return c.json(errorBody("setup_code_invalid", "setup code is unknown, used, or expired"), 401);
    }
    const { token, tokenHash } = mintDeviceToken();
    const device = {
      id: randomUUID(),
      name: pairRequest.deviceName,
      tokenHash,
      createdAt: deps.now(),
    };
    deps.storage.createDevice(device);
    return c.json({
      deviceToken: token,
      device: { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: null },
      gateway: deps.gatewayInfo,
    });
  });

  app.get("/devices", requireDevice, (c) => c.json(deps.storage.listDevices()));

  app.delete("/devices/:id", requireDevice, (c) => {
    const id = c.req.param("id");
    if (!deps.storage.deleteDevice(id)) {
      return c.json(errorBody("not_found", "no such device"), 404);
    }
    deps.onDeviceRevoked(id);
    return c.json({ ok: true });
  });

  return app;
}

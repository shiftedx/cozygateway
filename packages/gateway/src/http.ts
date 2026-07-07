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
  CreateThreadRequestSchema,
  PairRequestSchema,
  PushRegisterRequestSchema,
  RenameThreadRequestSchema,
  SendMessageRequestSchema,
  assertValid,
} from "cozygateway-contract";

import type { GatewayConfig } from "./config.ts";
import type { Storage, ThreadRow } from "./storage.ts";
import { hashToken, mintDeviceToken } from "./auth.ts";
import { BackendUnavailable } from "./errors.ts";

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

  const parseOr400 = <S extends Parameters<typeof assertValid>[0]>(
    c: Context<Env>,
    schema: S,
    body: unknown,
  ) => {
    try {
      return { ok: true as const, value: assertValid(schema, body) };
    } catch (err) {
      const detail = err instanceof ContractViolation ? err.message : "malformed body";
      return { ok: false as const, response: c.json(errorBody("invalid_request", detail), 400) };
    }
  };

  const threadToWire = (t: ThreadRow) => ({
    id: t.id,
    agentId: t.agentId,
    title: t.title,
    createdAt: t.createdAt,
    lastMessageAt: t.lastMessageAt,
  });

  app.get("/agents", requireDevice, (c) =>
    c.json(
      deps.storage.listAgents().map((a) => ({
        id: a.id,
        name: a.name,
        ...(a.avatar === null ? {} : { avatar: a.avatar }),
        backend: a.backend,
        presence: deps.presenceOf(a.id),
      })),
    ),
  );

  app.get("/threads", requireDevice, (c) => c.json(deps.storage.listThreads().map(threadToWire)));

  app.post("/threads", requireDevice, async (c) => {
    const parsed = parseOr400(c, CreateThreadRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    if (deps.storage.agentById(parsed.value.agentId) === undefined) {
      return c.json(errorBody("not_found", "no such agent"), 404);
    }
    const thread = {
      id: randomUUID(),
      agentId: parsed.value.agentId,
      title: parsed.value.title ?? "New thread",
      createdAt: deps.now(),
    };
    deps.storage.createThread(thread);
    return c.json({ ...thread, lastMessageAt: null });
  });

  app.patch("/threads/:id", requireDevice, async (c) => {
    const parsed = parseOr400(c, RenameThreadRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    if (!deps.storage.renameThread(c.req.param("id"), parsed.value.title)) {
      return c.json(errorBody("not_found", "no such thread"), 404);
    }
    const thread = deps.storage.threadById(c.req.param("id"));
    return thread === undefined
      ? c.json(errorBody("not_found", "no such thread"), 404)
      : c.json(threadToWire(thread));
  });

  app.delete("/threads/:id", requireDevice, (c) => {
    if (!deps.storage.archiveThread(c.req.param("id"))) {
      return c.json(errorBody("not_found", "no such thread or already archived"), 404);
    }
    return c.json({ ok: true });
  });

  app.get("/threads/:id/messages", requireDevice, (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined) return c.json(errorBody("not_found", "no such thread"), 404);
    const beforeRaw = c.req.query("before");
    const limitRaw = c.req.query("limit");
    const before = beforeRaw === undefined ? null : Number.parseInt(beforeRaw, 10);
    const limit = Math.min(limitRaw === undefined ? 50 : Number.parseInt(limitRaw, 10), 200);
    if ((before !== null && (Number.isNaN(before) || before < 1)) || Number.isNaN(limit) || limit < 1) {
      return c.json(errorBody("invalid_request", "bad before/limit"), 400);
    }
    return c.json({ messages: deps.storage.messagesBefore(thread.id, before, limit) });
  });

  app.post("/threads/:id/messages", requireDevice, async (c) => {
    const thread = deps.storage.threadById(c.req.param("id"));
    if (thread === undefined) return c.json(errorBody("not_found", "no such thread"), 404);
    if (thread.archivedAt !== null) {
      return c.json(errorBody("thread_archived", "thread is archived"), 409);
    }
    const parsed = parseOr400(c, SendMessageRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    try {
      const message = deps.submitUserMessage(thread.id, parsed.value.blocks);
      return c.json({ message });
    } catch (err) {
      if (err instanceof BackendUnavailable) {
        return c.json(errorBody("backend_unavailable", err.message), 503);
      }
      throw err;
    }
  });

  app.post("/push/register", requireDevice, async (c) => {
    const parsed = parseOr400(c, PushRegisterRequestSchema, await readBody(c));
    if (!parsed.ok) return parsed.response;
    deps.storage.savePushRegistration(c.get("deviceId"), parsed.value);
    return c.json({ ok: true });
  });

  return app;
}

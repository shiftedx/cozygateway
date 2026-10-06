import type { Context, Hono, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import {
  AssignmentAcknowledgeRequestSchema, AssignmentCancelRequestSchema, AssignmentCreateRequestSchema, check,
} from "cozygateway-contract";

import {
  AssignmentConflict, AssignmentForbidden, AssignmentNotFound, AssignmentRefused, type AssignmentRooms,
} from "./hermes-bridge/assignments.ts";
import { canonicalName } from "./hermes-bridge/routes.ts";

type Env = { Variables: { deviceId: string } };

/** agent-inbox 1. The peer lane authenticates with the calling bot's own attach bearer, never a
 * device token; the device lane is the paired phone. "Either" routes accept both, and a peer may
 * only act as the party it is. */
export function registerAssignmentRoutes(
  app: Hono<Env>,
  requireDevice: MiddlewareHandler<Env>,
  /** The attach identity behind this request's bearer, if it carries one. */
  peerOf: (c: Context<Env>) => string | undefined,
  assignments: AssignmentRooms,
): void {
  const either = createMiddleware<Env>(async (c, next) => {
    if (peerOf(c) !== undefined) return next();
    return requireDevice(c, next);
  });
  const error = (c: Context<Env>, status: 400 | 401 | 403 | 404 | 409, code: string, message: string) =>
    c.json({ error: { code, message } }, status);
  const forbidden = (c: Context<Env>) => error(c, 403, "unauthorized", "this bot is not a party to that assignment");
  const failure = (c: Context<Env>, err: unknown) => {
    if (err instanceof AssignmentRefused) return c.json({ error: { code: "assignment_refused", message: err.message }, reason: err.reason }, 409);
    if (err instanceof AssignmentConflict) return error(c, 409, "conflict", err.message);
    if (err instanceof AssignmentForbidden) return error(c, 403, "unauthorized", err.message);
    if (err instanceof AssignmentNotFound) return error(c, 404, "not_found", err.message);
    throw err;
  };
  /** An absent or empty body is `{}`; a present one must parse. */
  const body = async (c: Context<Env>): Promise<unknown> => {
    const text = await c.req.text();
    if (text.trim().length === 0) return {};
    try { return JSON.parse(text) as unknown; } catch { return undefined; }
  };

  app.post("/bots/:name/assignments", async (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const agent = peerOf(c);
    if (agent === undefined) return error(c, 401, "unauthorized", "missing or unknown attach token");
    if (agent !== resolved.name) return error(c, 403, "unauthorized", "a bot may only assign as itself");
    const request = await body(c);
    if (!check(AssignmentCreateRequestSchema, request)) return error(c, 400, "invalid_request", "invalid assignment");
    try {
      return c.json(assignments.assign(agent, request), 201);
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/bots/:name/assignments", either, (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const agent = peerOf(c);
    if (agent !== undefined && agent !== resolved.name) return forbidden(c);
    return c.json({ assignments: assignments.list({ participant: resolved.name }) });
  });

  // The one read a runtime peer needs to know whether it leads: the config lane never carries
  // role or reports (they are gateway-owned), so a peer asks here with its own bearer.
  app.get("/bots/:name/team", either, (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const agent = peerOf(c);
    if (agent !== undefined && agent !== resolved.name)
      return error(c, 403, "unauthorized", "a bot may only read its own team");
    return c.json(assignments.team(resolved.name) ?? { role: "member", reports: [] });
  });

  // A bot that is not a party gets the same answer as for a Task that does not exist, so the
  // route cannot be used to probe other teams' Task ids.
  app.get("/assignments/:taskId", either, (c) => {
    const taskId = c.req.param("taskId");
    const agent = peerOf(c);
    const view = agent !== undefined && assignments.partyOf(taskId, agent) === undefined ? undefined : assignments.view(taskId);
    return view === undefined ? error(c, 404, "not_found", "no such assignment") : c.json(view);
  });

  app.post("/assignments/:taskId/cancel", either, async (c) => {
    const view = assignments.view(c.req.param("taskId"));
    if (view === undefined) return error(c, 404, "not_found", "no such assignment");
    const agent = peerOf(c);
    if (agent !== undefined && assignments.partyOf(view.taskId, agent) !== "leader") return forbidden(c);
    if (!check(AssignmentCancelRequestSchema, await body(c))) return error(c, 400, "invalid_request", "invalid cancel");
    try {
      return c.json(assignments.cancel(view.taskId, agent === undefined ? "user" : "leader"));
    } catch (err) {
      return failure(c, err);
    }
  });

  app.post("/assignments/:taskId/acknowledge", either, async (c) => {
    const request = await body(c);
    if (!check(AssignmentAcknowledgeRequestSchema, request)) return error(c, 400, "invalid_request", "invalid acknowledgement");
    const agent = peerOf(c);
    try {
      return c.json(assignments.acknowledge(c.req.param("taskId"), agent ?? { device: true }, request.outcome));
    } catch (err) {
      return failure(c, err);
    }
  });

  app.get("/bots/:name/inbox", requireDevice, (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    return c.json({ threads: assignments.inboxThreads(resolved.name) });
  });

  app.get("/bots/:name/inbox/:threadId/messages", requireDevice, (c) => {
    const resolved = canonicalName(c);
    if ("response" in resolved) return resolved.response;
    const messages = assignments.inboxMessages(resolved.name, c.req.param("threadId"));
    return messages === undefined ? error(c, 404, "not_found", "no such inbox thread") : c.json({ messages });
  });
}

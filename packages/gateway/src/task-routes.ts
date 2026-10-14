import type { Hono, MiddlewareHandler } from "hono";
import { check, TaskCommandSchema, TaskScopeCommandSchema, TaskStateSchema } from "cozygateway-contract";
import type { Storage } from "./storage.ts";

type Env = { Variables: { deviceId: string } };
export function registerTaskRoutes(app: Hono<Env>, auth: MiddlewareHandler<Env>, storage: Storage, now: () => number, dispatch: () => void): void {
  app.get("/bots/:name/tasks", auth, (c) => {
    const state = c.req.query("state");
    if (state !== undefined && !check(TaskStateSchema, state)) return c.json({ error: { code: "invalid_request", message: "invalid Task state" } }, 400);
    return c.json({ tasks: storage.tasks.list({ bot: c.req.param("name"), ...(state === undefined ? {} : { state }) }) });
  });
  app.get("/bots/groups/:name/tasks", auth, (c) => {
    const state = c.req.query("state");
    if (state !== undefined && !check(TaskStateSchema, state)) return c.json({ error: { code: "invalid_request", message: "invalid Task state" } }, 400);
    const room = storage.botGroups().find((row) => row.name === c.req.param("name") || row.key === c.req.param("name"));
    if (room === undefined) return c.json({ error: { code: "not_found", message: "room not found" } }, 404);
    return c.json({ tasks: storage.tasks.list({ room: room.key, ...(state === undefined ? {} : { state }) }) });
  });
  app.get("/tasks/:taskId", auth, (c) => {
    const cursor = Number(c.req.query("cursor") ?? 0);
    const limit = Number(c.req.query("limit") ?? 100);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) return c.json({ error: { code: "invalid_request", message: "invalid Task cursor or limit" } }, 400);
    const result = storage.tasks.read(c.req.param("taskId"), cursor, limit);
    return result === undefined ? c.json({ error: { code: "not_found", message: "Task not found" } }, 404) : c.json(result);
  });
  for (const action of ["cancel", "pause", "resume", "retry", "scope"] as const) {
    app.post(`/tasks/:taskId/${action}`, auth, async (c) => {
      let body: unknown;
      try { body = await c.req.json(); } catch { return c.json({ error: { code: "invalid_request", message: "invalid Task command" } }, 400); }
      if (!check(action === "scope" ? TaskScopeCommandSchema : TaskCommandSchema, body)) return c.json({ error: { code: "invalid_request", message: "invalid Task command" } }, 400);
      if ("goal" in body && typeof body.goal === "string" && body.goal.trim().length === 0) return c.json({ error: { code: "invalid_request", message: "Task goal must contain text" } }, 400);
      const taskId = c.req.param("taskId");
      if (storage.tasks.read(taskId) === undefined) return c.json({ error: { code: "not_found", message: "Task not found" } }, 404);
      const result = storage.tasks.command(taskId, action, body, now());
      if (result.outcome === "conflict") return c.json({ error: { code: "conflict", message: "Task command conflicts with its current state or idempotency payload" }, state: result.view?.state, view: result.view }, 409);
      dispatch();
      return c.json(result.view);
    });
  }
}

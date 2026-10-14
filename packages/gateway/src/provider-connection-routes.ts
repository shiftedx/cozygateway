import { Hono, type Context, type MiddlewareHandler } from "hono";
import { Value } from "@sinclair/typebox/value";
import {
  ModelProviderConnectionIdSchema,
  ModelProviderConnectionInputSchema,
} from "cozygateway-contract";
import type { GatewayProviderConnections } from "./provider-connections.ts";

type Env = { Variables: { deviceId: string } };

export function providerConnectionRoutes(options: {
  service: GatewayProviderConnections;
  requireDevice: MiddlewareHandler<Env>;
  attachIdentity: (authorization: string | undefined) => string | undefined;
}): Hono<Env> {
  const app = new Hono<Env>();
  const { service, requireDevice } = options;
  const failure = (context: Context<Env>) => context.json({
    error: { code: "provider_setup_unavailable", message: "Could not update this provider. Check the computer’s connection and try again." },
  }, 503);
  const invalid = (context: Context<Env>) => context.json({
    error: { code: "invalid_request", message: "Check the provider name, endpoint, and model settings." },
  }, 400);

  app.get("/attach/v1/provider-handoffs/:id", (context) => {
    const bot = options.attachIdentity(context.req.header("authorization"));
    if (!bot) return context.json({ error: { code: "unauthorized", message: "Attach authentication required." } }, 401);
    const input = service.handoffs.consume(bot, context.req.param("id"));
    if (!input) return context.json({ error: { code: "not_found", message: "Provider setup expired. Save again." } }, 404);
    context.header("Cache-Control", "no-store");
    context.header("Pragma", "no-cache");
    return context.json(input);
  });

  app.post("/attach/v1/provider-transfers/:executionId", async (context) => {
    const source = options.attachIdentity(context.req.header("authorization"));
    if (!source) return context.json({ error: { code: "unauthorized", message: "Attach authentication required." } }, 401);
    let input: unknown;
    try { input = await boundedBody(context); } catch { return invalid(context); }
    if (!Value.Check(ModelProviderConnectionInputSchema, input) || !input.id) return invalid(context);
    try {
      const handoffId = service.stageTransfer(source, context.req.param("executionId"), input);
      context.header("Cache-Control", "no-store");
      return context.json({ handoffId });
    } catch { return context.json({ error: { code: "invalid_request", message: "This chat execution does not belong to the authenticated bot." } }, 403); }
  });

  for (const base of ["/gateway/harnesses/:harnessId/scopes/:scopeId/provider-connections", "/bots/:name/provider-connections"]) {
    const bot = (context: Context<Env>): string => base.startsWith("/bots/")
      ? service.bot(context.req.param("name") ?? "")
      : service.scope(context.req.param("harnessId") ?? "", context.req.param("scopeId") ?? "");

    app.get(base, requireDevice, async (context) => {
      try { return context.json(await service.list(bot(context))); }
      catch { return failure(context); }
    });

    const save = async (context: Context<Env>) => {
      let input: unknown;
      try { input = await boundedBody(context); }
      catch (error) {
        if (error instanceof Error && error.message === "body_too_large") return context.json({
          error: { code: "invalid_request", message: "Provider settings are too large." },
        }, 413);
        return invalid(context);
      }
      try {
        if (!Value.Check(ModelProviderConnectionInputSchema, input)) return invalid(context);
        const id = context.req.param("id");
        if (id && (!Value.Check(ModelProviderConnectionIdSchema, id) || (input.id && input.id !== id))) return invalid(context);
        if (!id && input.id !== undefined) return invalid(context);
        return context.json(await service.save(bot(context), { ...input, ...(id ? { id } : {}) }));
      } catch { return failure(context); }
    };
    app.post(base, requireDevice, save);
    app.put(`${base}/:id`, requireDevice, save);

    app.post(`${base}/:id/test`, requireDevice, async (context) => {
      if (!Value.Check(ModelProviderConnectionIdSchema, context.req.param("id"))) return invalid(context);
      try { return context.json(await service.test(bot(context), context.req.param("id"))); }
      catch { return failure(context); }
    });

    app.delete(`${base}/:id`, requireDevice, async (context) => {
      if (!Value.Check(ModelProviderConnectionIdSchema, context.req.param("id"))) return invalid(context);
      try { return context.json(await service.remove(bot(context), context.req.param("id"))); }
      catch { return failure(context); }
    });
  }
  return app;
}

async function boundedBody(context: Context<Env>): Promise<unknown> {
  const stream = context.req.raw.body;
  if (!stream) throw new Error("missing_body");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 32 * 1024) throw new Error("body_too_large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  ArtifactCommitRequestSchema, ArtifactDeclareRequestSchema, ArtifactDeliverySettleRequestSchema,
  check, type ArtifactDeclareRequest,
} from "cozygateway-contract";
import { attachmentDisposition } from "./hermes-bridge/documents.ts";
import type { Storage } from "./storage.ts";

type Env = { Variables: { deviceId: string } };
const ID = /^[A-Za-z0-9_.:-]{1,256}$/;

/** Capability 65. Two authenticated surfaces over one record: the attach peer that produced an
 * Artifact declares and commits it and reports the platform delivery fact, and the paired device
 * lists, reads, downloads and explicitly deletes it. Discovery never needs the chat message the
 * Artifact was mentioned in, and delivery is retried without touching the Task that made it. */
export function registerArtifactRoutes(
  app: Hono<Env>,
  requireDevice: MiddlewareHandler<Env>,
  storage: Storage,
  now: () => number,
  producer?: { auth: MiddlewareHandler<Env>; agentOf: (c: Context<Env>) => string; botOf: (agentId: string) => string },
): void {
  const invalid = (c: Context<Env>, message: string) => c.json({ error: { code: "invalid_request", message } }, 400);
  const missing = (c: Context<Env>) => c.json({ error: { code: "not_found", message: "no such artifact" } }, 404);

  app.get("/bots/:name/artifacts", requireDevice, (c) =>
    c.json({ artifacts: storage.artifacts.list({ bot: c.req.param("name") }) }));

  app.get("/bots/groups/:name/artifacts", requireDevice, (c) => {
    const room = storage.botGroups().find((row) => row.name === c.req.param("name") || row.key === c.req.param("name"));
    if (room === undefined) return c.json({ error: { code: "not_found", message: "room not found" } }, 404);
    return c.json({ artifacts: storage.artifacts.list({ room: room.key }) });
  });

  app.get("/artifacts/:artifactId", requireDevice, (c) => {
    const record = storage.artifacts.get(c.req.param("artifactId"));
    return record === undefined ? missing(c) : c.json(record);
  });

  app.get("/artifacts/:artifactId/latest", requireDevice, (c) => {
    const record = storage.artifacts.latest(c.req.param("artifactId"));
    return record === undefined ? missing(c) : c.json(record);
  });

  /** The original bytes, served from the store that already validated them. Reaching them under
   * a paired device's own credential IS the acknowledgement; it is not a claim anyone read it. */
  app.get("/artifacts/:artifactId/content", requireDevice, (c) => {
    const artifactId = c.req.param("artifactId");
    const record = storage.artifacts.get(artifactId);
    if (record === undefined) return missing(c);
    const original = storage.artifacts.original(artifactId);
    if (original === undefined)
      return record.state === "deleted"
        ? c.json({ error: { code: "not_found", message: "artifact was deleted" } }, 410)
        : c.json({ error: { code: "not_found", message: "artifact has no committed bytes" } }, 404);
    const bytes = storage.attachMediaSlice(original.agentId, original.mediaId, 0, original.sizeBytes, now());
    if (bytes === undefined) return missing(c);
    storage.artifacts.acknowledge(artifactId, now());
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": original.mediaType,
        "content-length": String(bytes.byteLength),
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
        // The one sanitizer every other download route in this gateway uses. A producer-supplied
        // filename is display metadata: it never builds a header of its own, and a name this
        // encoder cannot represent falls back rather than making the artifact undownloadable.
        "content-disposition": attachmentDisposition(original.filename),
      },
    });
  });

  app.delete("/artifacts/:artifactId", requireDevice, (c) =>
    storage.deleteArtifact(c.req.param("artifactId"), now()) === "deleted" ? c.body(null, 204) : missing(c));

  if (producer === undefined) return;
  const { auth, agentOf, botOf } = producer;

  app.post("/attach/v1/artifacts", auth, async (c) => {
    const body = await readJson(c);
    if (!check(ArtifactDeclareRequestSchema, body)) return invalid(c, "invalid artifact declaration");
    const declaration = body as ArtifactDeclareRequest;
    if (!ID.test(declaration.artifactId)) return invalid(c, "invalid artifact id");
    const agentId = agentOf(c);
    const bot = botOf(agentId);
    // `bot` and `createdBy` come from the authenticated identity, so `room` is the one identity a
    // producer supplies. A bot may only file a record against a room it is actually a member of;
    // an unknown room and a room it does not belong to are the same refusal.
    if (declaration.room !== undefined && !(storage.botGroup(declaration.room)?.members ?? []).includes(bot))
      return c.json({ error: { code: "forbidden", message: "bot is not a member of that room" } }, 403);
    const result = storage.artifacts.declare({ ...declaration, createdBy: agentId, bot }, now());
    if (result.outcome === "conflict")
      return c.json({ error: { code: "conflict", message: "artifact id already names a different declaration" } }, 409);
    return c.json(result.record, result.outcome === "created" ? 201 : 200);
  });

  app.get("/attach/v1/artifacts/:artifactId", auth, (c) => {
    const record = storage.artifacts.ofPeer(agentOf(c), c.req.param("artifactId"));
    return record === undefined ? missing(c) : c.json(record);
  });

  app.post("/attach/v1/artifacts/:artifactId/commit", auth, async (c) => {
    const body = await readJson(c);
    if (!check(ArtifactCommitRequestSchema, body)) return invalid(c, "invalid artifact commit");
    const result = storage.artifacts.commit(agentOf(c), c.req.param("artifactId"), (body as { mediaId: string }).mediaId, now());
    if (result.outcome === "not_found") return missing(c);
    // A refused commitment answers with the record that says why, never with metadata alone.
    return result.outcome === "committed" || result.outcome === "replayed" ? c.json(result.record) : c.json(result.record, 409);
  });

  app.post("/attach/v1/artifacts/:artifactId/deliveries", auth, async (c) => {
    const body = await readJson(c);
    const deliveryId = (body as { deliveryId?: unknown } | undefined)?.deliveryId;
    if (typeof deliveryId !== "string" || !ID.test(deliveryId)) return invalid(c, "invalid delivery id");
    const result = storage.artifacts.retryDelivery(agentOf(c), c.req.param("artifactId"), deliveryId, now());
    if (result.outcome === "not_found") return missing(c);
    return result.outcome === "queued" ? c.json(result.record, 201) : c.json(result.record ?? {}, 409);
  });

  app.post("/attach/v1/artifacts/:artifactId/deliveries/:deliveryId", auth, async (c) => {
    const body = await readJson(c);
    if (!check(ArtifactDeliverySettleRequestSchema, body)) return invalid(c, "invalid delivery settlement");
    const settlement = body as { state: "delivered" | "failed"; reason?: string };
    const result = storage.artifacts.settleDelivery(
      agentOf(c), c.req.param("artifactId"), c.req.param("deliveryId"), settlement.state, now(), settlement.reason,
    );
    if (result.outcome === "not_found") return missing(c);
    return result.outcome === "conflict" || result.outcome === "not_committed"
      ? c.json(result.record ?? {}, 409)
      : c.json(result.record);
  });
}

async function readJson(c: Context<Env>): Promise<unknown> {
  try { return await c.req.json(); } catch { return undefined; }
}

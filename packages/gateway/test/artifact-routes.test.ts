import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/http.ts";
import { openStorage, type Storage } from "../src/storage.ts";

const BYTES = new TextEncoder().encode("%PDF-1.7\nreport\n");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const JSON_HEADERS = { "content-type": "application/json" };
const stores: Storage[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function setup() {
  const storage = openStorage(":memory:");
  stores.push(storage);
  let now = 100;
  const app = createApp({
    storage, config: { name: "test", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0 },
    gatewayInfo: { name: "test", version: "test", contract: "v1", capabilities: { "com.cozylabs.bots": 65 } },
    attachTokens: new Map([["peer-secret", "sage"], ["other-secret", "luna"]]),
    presenceOf: () => "online", submitUserMessage: () => { throw new Error("not used"); },
    interruptThread: () => "idle", resolveApproval: async () => "unknown", onDeviceRevoked: () => {},
    now: () => now,
  });
  storage.createSetupCode("artifact-pair", 10_000);
  const paired = await app.request("/pair", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ setupCode: "artifact-pair", deviceName: "phone" }) });
  const { deviceToken } = await paired.json() as { deviceToken: string };
  const sessionId = storage.nativeBotChat("sage", now).sessionId;
  const device = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: `Bearer ${deviceToken}`, ...(init.headers ?? {}) } });
  const peer = (path: string, init: RequestInit = {}, token = "peer-secret") => app.request(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const upload = async (mediaId: string, token = "peer-secret") => peer(`/attach/v1/media/${mediaId}`, {
    method: "POST", body: BYTES,
    headers: { "content-type": "application/pdf", "x-attach-filename": "report.pdf", "x-attach-sha256": SHA },
  }, token);
  const declare = (body: object, token = "peer-secret") => peer("/attach/v1/artifacts", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }, token);
  const peerless = createApp({
    storage: openStorage(":memory:"), config: { name: "test", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0 },
    gatewayInfo: { name: "test", version: "test", contract: "v1", capabilities: { "com.cozylabs.bots": 65 } },
    presenceOf: () => "online", submitUserMessage: () => { throw new Error("not used"); },
    interruptThread: () => "idle", resolveApproval: async () => "unknown", onDeviceRevoked: () => {},
    now: () => now,
  });
  return { storage, app, device, peer, upload, declare, sessionId, peerless, setNow: (value: number) => { now = value; } };
}

const DECLARATION = {
  artifactId: "artifact-1", filename: "report.pdf", mediaType: "application/pdf",
  sizeBytes: BYTES.byteLength, sha256: SHA, mark: "final" as const,
};

describe("Artifact public routes", () => {
  it("requires authentication on every producer and consumer route", async () => {
    const { app } = await setup();
    for (const path of ["/bots/sage/artifacts", "/bots/groups/room-1/artifacts", "/artifacts/artifact-1", "/artifacts/artifact-1/content"])
      expect((await app.request(path)).status).toBe(401);
    expect((await app.request("/attach/v1/artifacts", { method: "POST", headers: JSON_HEADERS, body: "{}" })).status).toBe(401);
    expect((await app.request("/attach/v1/artifacts/artifact-1/commit", { method: "POST", headers: JSON_HEADERS, body: "{}" })).status).toBe(401);
    expect((await app.request("/artifacts/artifact-1", { method: "DELETE" })).status).toBe(401);
  });

  it("declares, commits against stored bytes, and serves the original without the originating message", async () => {
    const { device, declare, upload, peer, sessionId } = await setup();
    expect((await upload("media-1")).status).toBe(201);
    expect((await declare({ ...DECLARATION, sessionId, taskId: "task-1", runId: "run-1" })).status).toBe(201);

    const listedBeforeCommit = await (await device("/bots/sage/artifacts")).json() as { artifacts: { state: string }[] };
    expect(listedBeforeCommit.artifacts).toMatchObject([{ state: "declared", validation: "unvalidated" }]);

    const wrongBytes = await peer("/attach/v1/artifacts/artifact-1/commit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mediaId: "media-absent" }) });
    expect(wrongBytes.status).toBe(409);
    expect(await wrongBytes.json()).toMatchObject({ state: "commit_failed", failureReason: "missing_bytes" });

    await declare({ ...DECLARATION, artifactId: "artifact-2", sessionId });
    const commit = await peer("/attach/v1/artifacts/artifact-2/commit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mediaId: "media-1" }) });
    expect(commit.status).toBe(200);
    expect(await commit.json()).toMatchObject({ state: "committed", validation: "verified", delivery: { state: "queued" }, location: "/artifacts/artifact-2/content" });

    const content = await device("/artifacts/artifact-2/content");
    expect(content.status).toBe(200);
    expect(content.headers.get("content-disposition")).toContain("report.pdf");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(BYTES);
    // The reference a large-file alternate delivery hands out is this gateway-relative location,
    // never a host path and never a credential.
    const record = await (await device("/artifacts/artifact-2")).json() as { location: string };
    expect(record.location).toBe("/artifacts/artifact-2/content");
    expect(JSON.stringify(record)).not.toMatch(/\/Users\/|\/home\/|Bearer |peer-secret/);
    // Download by an authenticated client is the acknowledgement, and repeating it updates once.
    const acknowledged = await (await device("/artifacts/artifact-2")).json() as { delivery: { state: string; acknowledgedAt: number } };
    expect(acknowledged.delivery).toMatchObject({ state: "acknowledged", acknowledgedAt: 100 });
    expect((await device("/artifacts/artifact-2/content")).status).toBe(200);
    expect((await (await device("/artifacts/artifact-2")).json() as { delivery: { acknowledgedAt: number } }).delivery.acknowledgedAt).toBe(100);
  });

  it("refuses a foreign peer and a guessed identifier without telling them apart", async () => {
    const { device, declare, upload, peer, sessionId } = await setup();
    await upload("media-1");
    await declare({ ...DECLARATION, sessionId });
    expect((await peer("/attach/v1/artifacts/artifact-1/commit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mediaId: "media-1" }) }, "other-secret")).status).toBe(404);
    expect((await peer("/attach/v1/artifacts/artifact-guessed", {}, "peer-secret")).status).toBe(404);
    expect((await peer("/attach/v1/artifacts/artifact-1", {}, "other-secret")).status).toBe(404);
    expect((await peer("/attach/v1/artifacts/artifact-1", {}, "peer-secret")).status).toBe(200);
    expect((await device("/artifacts/artifact-guessed")).status).toBe(404);
    expect((await device("/artifacts/artifact-guessed/content")).status).toBe(404);
    // A room list answers only for that room, and an unknown room is a 404 rather than a leak.
    expect((await device("/bots/groups/room-unknown/artifacts")).status).toBe(404);
    expect(await (await device("/bots/luna/artifacts")).json()).toEqual({ artifacts: [] });
  });

  it("retries delivery against the same committed Artifact and refuses a receipt before commitment", async () => {
    const { device, declare, upload, peer, sessionId } = await setup();
    await upload("media-1");
    await declare({ ...DECLARATION, sessionId });
    const settle = (deliveryId: string, body: object) => peer(`/attach/v1/artifacts/artifact-1/deliveries/${deliveryId}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    expect((await settle("delivery-1", { state: "delivered" })).status).toBe(409);

    const commit = await peer("/attach/v1/artifacts/artifact-1/commit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mediaId: "media-1" }) });
    expect(commit.status).toBe(200);
    const first = (await commit.json() as { delivery: { deliveryId: string } }).delivery.deliveryId;
    expect((await settle(first, { state: "failed", reason: "platform refused" })).status).toBe(200);

    const retry = await peer("/attach/v1/artifacts/artifact-1/deliveries", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ deliveryId: "delivery-2" }) });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ artifactId: "artifact-1", committedAt: 100, delivery: { deliveryId: "delivery-2", attempt: 2, state: "queued" } });
    // A second retry while the new attempt is live is a conflict, not a third delivery.
    expect((await peer("/attach/v1/artifacts/artifact-1/deliveries", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ deliveryId: "delivery-3" }) })).status).toBe(409);
    // A pending delivery is not received, so a client cannot read it as delivered.
    expect(await (await device("/artifacts/artifact-1")).json()).toMatchObject({ delivery: { state: "queued" } });
  });

  it("tombstones an explicitly deleted Artifact without exposing its bytes", async () => {
    const { device, declare, upload, peer, sessionId } = await setup();
    await upload("media-1");
    // A `taskId` a peer states is dropped: the Task is joined from the Run, gateway-side.
    await declare({ ...DECLARATION, sessionId, taskId: "task-1" });
    await peer("/attach/v1/artifacts/artifact-1/commit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mediaId: "media-1" }) });
    expect((await device("/artifacts/artifact-1", { method: "DELETE" })).status).toBe(204);
    const tombstone = await (await device("/artifacts/artifact-1")).json() as { state: string; taskId?: string; location?: string };
    expect(tombstone).toMatchObject({ state: "deleted", sha256: SHA });
    expect(tombstone.taskId).toBeUndefined();
    expect(tombstone.location).toBeUndefined();
    expect((await device("/artifacts/artifact-1/content")).status).toBe(410);
    expect((await device("/artifacts/artifact-1", { method: "DELETE" })).status).toBe(404);
  });

  it("answers supersession and version lookup on the stable reference", async () => {
    const { device, declare, upload, peer, sessionId } = await setup();
    await upload("media-1");
    await upload("media-2");
    await declare({ ...DECLARATION, sessionId });
    await peer("/attach/v1/artifacts/artifact-1/commit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mediaId: "media-1" }) });
    await declare({ ...DECLARATION, artifactId: "artifact-2", sessionId, supersedesArtifactId: "artifact-1" });
    await peer("/attach/v1/artifacts/artifact-2/commit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mediaId: "media-2" }) });
    expect(await (await device("/artifacts/artifact-1")).json()).toMatchObject({ version: 1, supersededByArtifactId: "artifact-2" });
    expect(await (await device("/artifacts/artifact-2")).json()).toMatchObject({ version: 2, supersedesArtifactId: "artifact-1" });
    expect(await (await device("/artifacts/artifact-1/latest")).json()).toMatchObject({ artifactId: "artifact-2", version: 2 });
  });

  it("serves a filename carrying header control characters through the shared sanitizer", async () => {
    const { device, declare, peer, upload, sessionId } = await setup();
    await upload("media-1");
    // A producer-supplied filename is display metadata. A CR or LF in it must not be able to
    // build a header, and must not make the artifact permanently undownloadable either.
    expect((await declare({ ...DECLARATION, sessionId, filename: "a\r\nX-Evil: 1.pdf" })).status).toBe(201);
    await peer("/attach/v1/artifacts/artifact-1/commit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mediaId: "media-1" }) });
    const content = await device("/artifacts/artifact-1/content");
    expect(content.status).toBe(200);
    const disposition = content.headers.get("content-disposition") ?? "";
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain("filename*=UTF-8''");
    expect(content.headers.get("x-evil")).toBeNull();
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(BYTES);
  });

  it("refuses a room the producing bot is not a member of", async () => {
    const { device, declare, storage, sessionId } = await setup();
    storage.createBotGroup({ key: "room-1", name: "Room One", members: ["luna"], createdAt: 100 });
    // `sage` is authenticated but is not in room-1, so it cannot inject a record into the list a
    // paired device browses for that room.
    const refused = await declare({ ...DECLARATION, sessionId, room: "room-1" });
    expect(refused.status).toBe(403);
    expect(await (await device("/bots/groups/room-1/artifacts")).json()).toEqual({ artifacts: [] });
    expect((await declare({ ...DECLARATION, sessionId, room: "room-unknown" })).status).toBe(403);

    storage.createBotGroup({ key: "room-2", name: "Room Two", members: ["sage"], createdAt: 100 });
    expect((await declare({ ...DECLARATION, artifactId: "artifact-room", sessionId, room: "room-2" })).status).toBe(201);
    const listed = await (await device("/bots/groups/room-2/artifacts")).json() as { artifacts: { artifactId: string }[] };
    expect(listed.artifacts.map((record) => record.artifactId)).toEqual(["artifact-room"]);
  });

  it("registers the producer half on a gateway that has no attach peer configured", async () => {
    const { peerless } = await setup();
    // /health advertises 65 unconditionally, so the producer routes must exist unconditionally
    // too: an unauthenticated caller is refused by the route, not by its absence.
    for (const path of ["/attach/v1/artifacts", "/attach/v1/artifacts/artifact-1/commit", "/attach/v1/artifacts/artifact-1/deliveries"])
      expect((await peerless.request(path, { method: "POST", headers: JSON_HEADERS, body: "{}" })).status).toBe(401);
    expect((await peerless.request("/attach/v1/artifacts/artifact-1")).status).toBe(401);
    expect((await peerless.request("/attach/v1/artifacts", { method: "POST", headers: { ...JSON_HEADERS, authorization: "Bearer nope" }, body: "{}" })).status).toBe(401);
  });

  it("rejects malformed producer bodies at the boundary", async () => {
    const { declare, peer, sessionId } = await setup();
    expect((await declare({ ...DECLARATION, sessionId, sha256: "short" })).status).toBe(400);
    expect((await declare({ ...DECLARATION, sessionId, mark: "published" })).status).toBe(400);
    expect((await peer("/attach/v1/artifacts", { method: "POST", headers: JSON_HEADERS, body: "not json" })).status).toBe(400);
    expect((await peer("/attach/v1/artifacts/artifact-1/commit", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({}) })).status).toBe(400);
  });
});


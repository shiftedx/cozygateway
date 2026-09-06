import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/http.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");
const JSON_HEADERS = { "content-type": "application/json" };

const stores: Storage[] = [];
const planes: NativeBotDataPlane[] = [];
afterEach(() => {
  for (const plane of planes.splice(0)) plane.close();
  for (const store of stores.splice(0)) store.close();
});

function seedMedia(storage: Storage, mediaId: string, expiresAt?: number): void {
  storage.saveAttachMedia("sage", {
    mediaId, mimeType: "image/png", byteCount: PNG.byteLength, sha256: PNG_SHA,
    filename: "chart.png", family: "image", ...(expiresAt === undefined ? {} : { expiresAt }),
  }, PNG, 1);
}

/** The Hermes shape: a peer that knows nothing about capability 65 uploads media through the
 * existing attach route and commits a turn reply that names it. No declaration is ever made. */
function plane(storage: Storage) {
  const sent: Array<Record<string, unknown>> = [];
  let now = 10;
  const instance = new NativeBotDataPlane({
    control: {} as BotsSurface,
    storage,
    ingress: {
      sendDeliveryReceipt: vi.fn(() => true),
      sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
        sent.push(input);
        storage.enqueueAttachCommand(bot, `turn-${sent.length}`, { kind: "turn", ...input } as never, now);
        return true;
      },
    } as unknown as AttachV1Ingress,
    nativeBots: ["sage"],
    chatSuggestion: "",
    broadcast: () => undefined,
    now: () => now++,
  });
  planes.push(instance);
  return { instance, sent };
}

function open(): Storage {
  const storage = openStorage(":memory:");
  stores.push(storage);
  return storage;
}

async function deliver(
  fixture: ReturnType<typeof plane>,
  messageId: string,
  mediaIds: string[],
): Promise<{ sessionId: string; turnId: string }> {
  const accepted = await fixture.instance.surface().sendChatMessage("sage", "chart it", { clientId: `ask-${messageId}` });
  const turnId = String(fixture.sent.at(-1)?.turnId);
  const commit: AttachV1EventFrame = {
    kind: "event", sequence: 1, eventId: `commit-${messageId}`,
    event: {
      kind: "commit", threadId: accepted.sessionId, turnId, messageId,
      blocks: [{ type: "paragraph", text: "Here it is." }],
      ...(mediaIds.length === 0 ? {} : { mediaIds }),
    },
  };
  expect(fixture.instance.handle("sage", commit)).toBe(true);
  return { sessionId: accepted.sessionId, turnId };
}

describe("derived Artifacts from legacy attachment deliveries", () => {
  it("derives exactly one truthful record for an attachment a peer never declared", async () => {
    const storage = open();
    const fixture = plane(storage);
    seedMedia(storage, "media_chart", 5_000);
    const { sessionId } = await deliver(fixture, "answer", ["media_chart"]);

    const derived = storage.artifacts.list({ bot: "sage" });
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      origin: "derived", bot: "sage", createdBy: "sage", sessionId,
      sourceMessageId: "answer", filename: "chart.png", mediaType: "image/png",
      sizeBytes: PNG.byteLength, state: "committed", validation: "unvalidated", version: 1,
      delivery: { state: "delivered", attempt: 1 },
    });
    // Nothing was declared, so nothing may claim a checksum, a mark or Task provenance.
    expect(derived[0]?.sha256).toBeUndefined();
    expect(derived[0]?.mark).toBeUndefined();
    expect(derived[0]?.taskId).toBeUndefined();
    expect(derived[0]?.runId).toBeUndefined();

    // Capability 31's receipt is the acknowledgement, and a duplicate one keeps the first fact.
    expect(fixture.instance.surface().recordDisplayed("sage", ["answer"], "device-1")).toEqual({ recorded: 1 });
    const acknowledged = storage.artifacts.get(derived[0]!.artifactId);
    expect(acknowledged?.delivery).toMatchObject({ state: "acknowledged" });
    fixture.instance.surface().recordDisplayed("sage", ["answer"], "device-2");
    expect(storage.artifacts.get(derived[0]!.artifactId)?.delivery?.acknowledgedAt)
      .toBe(acknowledged?.delivery?.acknowledgedAt);
    expect(storage.artifacts.list({ bot: "sage" })).toHaveLength(1);
  });

  it("keeps one record when the same media is delivered again and when the event is replayed", async () => {
    const storage = open();
    const fixture = plane(storage);
    seedMedia(storage, "media_chart");
    await deliver(fixture, "answer", ["media_chart"]);
    await deliver(fixture, "answer-again", ["media_chart"]);
    expect(storage.artifacts.list({ bot: "sage" })).toHaveLength(1);
    // An unknown media id names no stored bytes, so it derives nothing at all.
    await deliver(fixture, "ghost", ["media_never_stored"]);
    expect(storage.artifacts.list({ bot: "sage" })).toHaveLength(1);
  });

  it("leaves a capable peer's declaration alone and upgrades a derived record in place", async () => {
    const storage = open();
    const fixture = plane(storage);
    seedMedia(storage, "media_declared");
    storage.artifacts.declare({
      artifactId: "artifact-declared", bot: "sage", sessionId: "session-1", createdBy: "sage",
      taskId: "task-1", runId: "run-1", filename: "chart.png", mediaType: "image/png",
      sizeBytes: PNG.byteLength, sha256: PNG_SHA, mark: "final",
    }, 50);
    expect(storage.artifacts.commit("sage", "artifact-declared", "media_declared", 60).outcome).toBe("committed");
    await deliver(fixture, "declared-answer", ["media_declared"]);
    const afterDelivery = storage.artifacts.list({ bot: "sage" });
    expect(afterDelivery).toHaveLength(1);
    expect(afterDelivery[0]).toMatchObject({ artifactId: "artifact-declared", origin: "declared" });

    // The other order: the attachment was delivered first, and the declaration arrives later.
    seedMedia(storage, "media_late");
    await deliver(fixture, "late-answer", ["media_late"]);
    const derived = storage.artifacts.list({ bot: "sage" }).find((record) => record.origin === "derived");
    expect(derived).toBeDefined();
    storage.artifacts.declare({
      artifactId: "artifact-late", bot: "sage", sessionId: "session-1", createdBy: "sage",
      taskId: "task-2", runId: "run-2", filename: "chart.png", mediaType: "image/png",
      sizeBytes: PNG.byteLength, sha256: PNG_SHA, mark: "review_copy",
    }, 70);
    const committed = storage.artifacts.commit("sage", "artifact-late", "media_late", 80);
    expect(committed.outcome).toBe("committed");
    // One record for the media, still under the identity clients already discovered.
    expect(storage.artifacts.list({ bot: "sage" })).toHaveLength(2);
    expect(committed.record?.artifactId).toBe(derived!.artifactId);
    expect(storage.artifacts.get(derived!.artifactId)).toMatchObject({
      origin: "declared", sha256: PNG_SHA, mark: "review_copy", taskId: "task-2", runId: "run-2",
      state: "committed", validation: "verified",
    });
    expect(storage.artifacts.get("artifact-late")).toBeUndefined();
  });

  it("counts media shared by two records once against the operator capacity", () => {
    const storage = open();
    seedMedia(storage, "media_shared");
    storage.artifacts.capacity(PNG.byteLength);
    for (const artifactId of ["artifact-a", "artifact-b"]) {
      storage.artifacts.declare({
        artifactId, bot: "sage", sessionId: "session-1", createdBy: "sage",
        filename: "chart.png", mediaType: "image/png", sizeBytes: PNG.byteLength,
        sha256: PNG_SHA, mark: "final",
      }, 50);
      expect(storage.artifacts.commit("sage", artifactId, "media_shared", 60).outcome).toBe("committed");
    }
    // A second record over the SAME bytes retains nothing new, so it cannot exhaust the ceiling.
    expect(storage.artifacts.get("artifact-b")).toMatchObject({ state: "committed" });
  });

  it("lists, downloads, deletes and retains a derived record the way a declared one behaves", async () => {
    const storage = open();
    const fixture = plane(storage);
    let now = 100;
    const app = createApp({
      storage, config: { name: "test", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0 },
      gatewayInfo: { name: "test", version: "test", contract: "v1", capabilities: { "com.cozylabs.bots": 65 } },
      presenceOf: () => "online", submitUserMessage: () => { throw new Error("not used"); },
      interruptThread: () => "idle", resolveApproval: async () => "unknown", onDeviceRevoked: () => {},
      now: () => now,
    });
    storage.createSetupCode("derived-pair", 10_000);
    const paired = await app.request("/pair", {
      method: "POST", headers: JSON_HEADERS,
      body: JSON.stringify({ setupCode: "derived-pair", deviceName: "phone" }),
    });
    const { deviceToken } = await paired.json() as { deviceToken: string };
    const device = (path: string, init: RequestInit = {}) =>
      app.request(path, { ...init, headers: { authorization: `Bearer ${deviceToken}`, ...(init.headers ?? {}) } });

    seedMedia(storage, "media_chart", 5_000);
    const { sessionId } = await deliver(fixture, "answer", ["media_chart"]);
    const listed = await (await device("/bots/sage/artifacts")).json() as { artifacts: Array<{ artifactId: string; origin: string }> };
    expect(listed.artifacts).toHaveLength(1);
    expect(listed.artifacts[0]?.origin).toBe("derived");
    const artifactId = listed.artifacts[0]!.artifactId;

    const content = await device(`/artifacts/${artifactId}/content`);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(PNG);
    expect(content.headers.get("content-disposition")).toContain("chart.png");

    // The staging deadline no longer applies to a retained original, and deleting the
    // conversation the attachment was delivered in does not remove it either.
    expect(storage.pruneExpiredAttachMedia(1_000_000)).toBe(0);
    storage.deleteNativeBotSession({ bot: "sage", sessionId, deletedAt: 200, enqueue: false });
    expect(storage.attachMediaInfo("sage", "media_chart", 1_000_000)).toBeDefined();
    expect((await device(`/artifacts/${artifactId}`)).status).toBe(200);

    // Explicit Artifact deletion is the one authority that stops offering the bytes.
    expect((await device(`/artifacts/${artifactId}`, { method: "DELETE" })).status).toBe(204);
    expect((await device(`/artifacts/${artifactId}/content`)).status).toBe(410);
    expect(storage.artifacts.get(artifactId)).toMatchObject({ state: "deleted", origin: "derived" });
    // A replayed receipt for the deleted record's message never resurrects it.
    fixture.instance.surface().recordDisplayed("sage", ["answer"], "device-1");
    expect(storage.artifacts.list({ bot: "sage" })).toHaveLength(1);
  });
});

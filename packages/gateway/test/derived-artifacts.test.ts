import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/http.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import { DEFAULT_ARTIFACT_STORE_BYTES } from "../src/artifacts.ts";
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
  const frames: Array<Record<string, unknown>> = [];
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
    broadcast: (frame: Record<string, unknown>) => { frames.push(frame); },
    now: () => now++,
  });
  planes.push(instance);
  return { instance, sent, frames };
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

    // A client below 65 is byte identical to its pre-65 self: the transcript row it receives
    // carries the same attachment block and no frame announces the derived record.
    const delivered = fixture.frames.filter((frame) => frame["type"] === "bot_chat")
      .flatMap((frame) => (frame["messages"] as Array<Record<string, unknown>>))
      .find((message) => message["id"] === "answer");
    expect(delivered?.["attachments"]).toEqual([{
      type: "attachment", fileId: "media_chart", name: "chart.png", mimeType: "image/png",
      size: PNG.byteLength, mediaKind: "image",
    }]);
    expect(fixture.frames.some((frame) => JSON.stringify(frame).includes("artifact"))).toBe(false);

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

  it("acknowledges a redelivered attachment from the later message's receipt", async () => {
    const storage = open();
    const fixture = plane(storage);
    seedMedia(storage, "media_chart");
    await deliver(fixture, "morning", ["media_chart"]);
    await deliver(fixture, "evening", ["media_chart"]);
    const [record] = storage.artifacts.list({ bot: "sage" });
    expect(record?.delivery).toMatchObject({ state: "delivered" });

    // The phone was offline for the first message and displayed only the second. The bytes still
    // reached an authenticated client, so the record must not stay delivered forever.
    expect(fixture.instance.surface().recordDisplayed("sage", ["evening"], "device-1")).toEqual({ recorded: 1 });
    expect(storage.artifacts.get(record!.artifactId)?.delivery).toMatchObject({ state: "acknowledged" });
    const acknowledgedAt = storage.artifacts.get(record!.artifactId)?.delivery?.acknowledgedAt;
    // The earlier message's receipt is the same fact arriving late, and keeps the first one.
    fixture.instance.surface().recordDisplayed("sage", ["morning"], "device-1");
    expect(storage.artifacts.get(record!.artifactId)?.delivery?.acknowledgedAt).toBe(acknowledgedAt);
  });

  it("bounds retained artifact bytes by a conservative default when the operator sets none", () => {
    const storage = open();
    // No `capacity` call: this is the ceiling an existing deployment gets after upgrading.
    expect(DEFAULT_ARTIFACT_STORE_BYTES).toBe(2_147_483_648);
    const refused = storage.artifacts.derive({
      createdBy: "sage", bot: "sage", sessionId: "session-1", sourceMessageId: "message-1",
      mediaId: "media_huge", filename: "big.bin", mediaType: "application/octet-stream",
      sizeBytes: DEFAULT_ARTIFACT_STORE_BYTES + 1,
    }, 100);
    expect(refused.outcome).toBe("refused");
    expect(refused.record).toMatchObject({
      origin: "derived", state: "commit_failed", failureReason: "capacity",
    });
    expect(refused.record?.location).toBeUndefined();
  });

  it("refuses a producer declaration that claims a derived identity", () => {
    const storage = open();
    const declared = storage.artifacts.declare({
      artifactId: "derived-0123456789abcdef0123456789abcdef", bot: "sage", sessionId: "session-1",
      createdBy: "sage", filename: "chart.png", mediaType: "image/png", sizeBytes: PNG.byteLength,
      sha256: PNG_SHA, mark: "final",
    }, 50);
    expect(declared.outcome).toBe("reserved");
    expect(storage.artifacts.get("derived-0123456789abcdef0123456789abcdef")).toBeUndefined();
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
    // Nothing is left pointing at the id the upgrade retired, and nothing supersedes itself.
    expect(storage.artifacts.get(derived!.artifactId)?.supersedesArtifactId).toBeUndefined();
    expect(storage.artifacts.get(derived!.artifactId)?.supersededByArtifactId).toBeUndefined();
  });

  it("never leaves a dangling or self-referencing supersession when it upgrades", async () => {
    const storage = open();
    const fixture = plane(storage);
    seedMedia(storage, "media_first");
    await deliver(fixture, "first-answer", ["media_first"]);
    const derived = storage.artifacts.list({ bot: "sage" })[0]!;

    // A peer declares over the same media and names the derived record as the one it replaces.
    storage.artifacts.declare({
      artifactId: "artifact-v2", bot: "sage", sessionId: "session-1", createdBy: "sage",
      filename: "chart.png", mediaType: "image/png", sizeBytes: PNG.byteLength,
      sha256: PNG_SHA, mark: "final", supersedesArtifactId: derived.artifactId,
    }, 70);
    expect(storage.artifacts.commit("sage", "artifact-v2", "media_first", 80).outcome).toBe("committed");
    const upgraded = storage.artifacts.get(derived.artifactId)!;
    expect(upgraded.supersedesArtifactId).toBeUndefined();
    expect(upgraded.supersededByArtifactId).toBeUndefined();
    expect(storage.artifacts.latest(derived.artifactId)?.artifactId).toBe(derived.artifactId);

    // A record that named the retired declaration follows the upgrade instead of dangling.
    seedMedia(storage, "media_second");
    await deliver(fixture, "second-answer", ["media_second"]);
    const secondDerived = storage.artifacts.list({ bot: "sage" }).find((row) => row.sourceMessageId === "second-answer")!;
    storage.artifacts.declare({
      artifactId: "artifact-v3", bot: "sage", sessionId: "session-1", createdBy: "sage",
      filename: "chart.png", mediaType: "image/png", sizeBytes: PNG.byteLength,
      sha256: PNG_SHA, mark: "final",
    }, 90);
    storage.artifacts.declare({
      artifactId: "artifact-v4", bot: "sage", sessionId: "session-1", createdBy: "sage",
      filename: "chart.png", mediaType: "image/png", sizeBytes: PNG.byteLength,
      sha256: PNG_SHA, mark: "final", supersedesArtifactId: "artifact-v3",
    }, 91);
    expect(storage.artifacts.commit("sage", "artifact-v3", "media_second", 95).outcome).toBe("committed");
    expect(storage.artifacts.get("artifact-v4")?.supersedesArtifactId).toBe(secondDerived.artifactId);
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

  it("records a visible refusal instead of retaining derived bytes over the operator ceiling", async () => {
    const storage = open();
    const fixture = plane(storage);
    storage.artifacts.capacity(PNG.byteLength - 1);
    seedMedia(storage, "media_chart", 5_000);
    await deliver(fixture, "answer", ["media_chart"]);

    const [record] = storage.artifacts.list({ bot: "sage" });
    expect(record).toMatchObject({ origin: "derived", state: "commit_failed", failureReason: "capacity" });
    expect(record?.location).toBeUndefined();
    expect(record?.delivery).toBeUndefined();
    // The refusal changes nothing about the attachment: its bytes keep the retention they had.
    expect(storage.attachMediaInfo("sage", "media_chart", 4_000)).toBeDefined();
    expect(storage.pruneExpiredAttachMedia(6_000)).toBe(1);

    // Raising the ceiling is enough: the next delivery of that attachment retains it for real.
    storage.artifacts.capacity(PNG.byteLength);
    seedMedia(storage, "media_chart", 9_000);
    await deliver(fixture, "answer-again", ["media_chart"]);
    expect(storage.artifacts.list({ bot: "sage" })).toHaveLength(1);
    expect(storage.artifacts.list({ bot: "sage" })[0]).toMatchObject({
      origin: "derived", state: "committed", sourceMessageId: "answer-again",
      delivery: { state: "delivered" },
    });
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

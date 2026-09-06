import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openStorage, type Storage } from "../src/storage.ts";

const BYTES = new TextEncoder().encode("%PDF-1.7\nreport\n");
const SHA = createHash("sha256").update(BYTES).digest("hex");
const stores: Storage[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(path = ":memory:"): Storage {
  const storage = openStorage(path);
  stores.push(storage);
  return storage;
}

function scratchDb(): string {
  const directory = mkdtempSync(join(tmpdir(), "cozygateway-artifacts-"));
  directories.push(directory);
  return join(directory, "gateway.db");
}

function upload(storage: Storage, agentId: string, mediaId: string, bytes = BYTES): void {
  storage.saveAttachMedia(agentId, {
    mediaId, mimeType: "application/pdf", byteCount: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"), filename: "report.pdf", family: "file",
  }, bytes, 100);
}

function declaration(overrides: Partial<Parameters<Storage["artifacts"]["declare"]>[0]> = {}) {
  return {
    artifactId: "artifact-1", bot: "sage", sessionId: "session-1", createdBy: "sage",
    taskId: "task-1", runId: "run-1", filename: "report.pdf", mediaType: "application/pdf",
    sizeBytes: BYTES.byteLength, sha256: SHA, mark: "final" as const, ...overrides,
  };
}

describe("durable Artifact records", () => {
  it("commits only against stored original bytes and records a mismatch truthfully", () => {
    const storage = open();
    upload(storage, "sage", "media-1");
    expect(storage.artifacts.declare(declaration(), 100).outcome).toBe("created");
    expect(storage.artifacts.get("artifact-1")).toMatchObject({ state: "declared", validation: "unvalidated", version: 1 });

    // A declaration whose digest does not describe the stored bytes is refused, not stored as a
    // commitment. The original bytes stay exactly where they were.
    expect(storage.artifacts.declare(declaration({ artifactId: "artifact-bad", sha256: "b".repeat(64) }), 100).outcome).toBe("created");
    const mismatch = storage.artifacts.commit("sage", "artifact-bad", "media-1", 110);
    expect(mismatch.outcome).toBe("mismatch");
    expect(storage.artifacts.get("artifact-bad")).toMatchObject({ state: "commit_failed", validation: "mismatch", failureReason: "checksum" });

    expect(storage.artifacts.declare(declaration({ artifactId: "artifact-size", sizeBytes: BYTES.byteLength + 1 }), 100).outcome).toBe("created");
    expect(storage.artifacts.commit("sage", "artifact-size", "media-1", 110).outcome).toBe("mismatch");
    expect(storage.artifacts.get("artifact-size")).toMatchObject({ failureReason: "size", state: "commit_failed" });

    const committed = storage.artifacts.commit("sage", "artifact-1", "media-1", 120);
    expect(committed.outcome).toBe("committed");
    expect(committed.record).toMatchObject({
      state: "committed", validation: "verified", committedAt: 120,
      location: "/artifacts/artifact-1/content", delivery: { state: "queued", attempt: 1 },
    });
    expect(storage.artifacts.original("artifact-1")).toMatchObject({ agentId: "sage", mediaId: "media-1" });
  });

  it("refuses commitment when the declared bytes were never stored and when the store is full", () => {
    const storage = open();
    storage.artifacts.declare(declaration({ artifactId: "artifact-missing" }), 100);
    expect(storage.artifacts.commit("sage", "artifact-missing", "media-absent", 110).outcome).toBe("missing_bytes");
    expect(storage.artifacts.get("artifact-missing")).toMatchObject({ state: "commit_failed", failureReason: "missing_bytes" });

    upload(storage, "sage", "media-1");
    storage.artifacts.capacity(BYTES.byteLength - 1);
    storage.artifacts.declare(declaration(), 100);
    expect(storage.artifacts.commit("sage", "artifact-1", "media-1", 110).outcome).toBe("capacity");
    // Visible, not silent: the record says why, and the original bytes are still served.
    expect(storage.artifacts.get("artifact-1")).toMatchObject({ state: "commit_failed", failureReason: "capacity" });
    expect(storage.attachMediaInfo("sage", "media-1", 200)).toBeDefined();
  });

  it("refuses foreign and guessed identities on every producer path", () => {
    const storage = open();
    upload(storage, "sage", "media-1");
    storage.artifacts.declare(declaration(), 100);
    expect(storage.artifacts.commit("other-bot", "artifact-1", "media-1", 110).outcome).toBe("not_found");
    expect(storage.artifacts.commit("sage", "artifact-guessed", "media-1", 110).outcome).toBe("not_found");
    expect(storage.artifacts.ofPeer("other-bot", "artifact-1")).toBeUndefined();
    expect(storage.artifacts.ofPeer("sage", "artifact-1")).toBeDefined();
    // A second peer cannot claim an id that already exists, and an identical replay is not a
    // conflict.
    expect(storage.artifacts.declare(declaration({ createdBy: "other-bot" }), 100).outcome).toBe("conflict");
    expect(storage.artifacts.declare(declaration(), 100).outcome).toBe("replayed");
    expect(storage.artifacts.declare(declaration({ filename: "other.pdf" }), 100).outcome).toBe("conflict");
  });

  it("keeps delivery a separate retryable object that never re-admits the Task or Run", () => {
    const storage = open();
    upload(storage, "sage", "media-1");
    storage.artifacts.declare(declaration(), 100);

    // Receipt before commitment is refused: there is nothing committed to have delivered.
    expect(storage.artifacts.settleDelivery("sage", "artifact-1", "delivery-1", "delivered", 105).outcome).toBe("not_committed");
    const committed = storage.artifacts.commit("sage", "artifact-1", "media-1", 110).record!;
    const first = committed.delivery!.deliveryId;

    expect(storage.artifacts.settleDelivery("sage", "artifact-1", first, "failed", 120, "platform refused").outcome).toBe("settled");
    expect(storage.artifacts.get("artifact-1")?.delivery).toMatchObject({ state: "failed", failedAt: 120, reason: "platform refused", attempt: 1 });
    // Duplicate settlement updates once and keeps the first fact.
    expect(storage.artifacts.settleDelivery("sage", "artifact-1", first, "failed", 130, "second try").outcome).toBe("replayed");
    expect(storage.artifacts.get("artifact-1")?.delivery).toMatchObject({ failedAt: 120, reason: "platform refused" });

    const retried = storage.artifacts.retryDelivery("sage", "artifact-1", "delivery-2", 140);
    expect(retried.outcome).toBe("queued");
    expect(retried.record?.delivery).toMatchObject({ deliveryId: "delivery-2", artifactId: "artifact-1", attempt: 2, state: "queued" });
    // The same committed Artifact, and no new work of any kind for the generating peer.
    expect(retried.record).toMatchObject({ state: "committed", committedAt: 110, sha256: SHA });
    expect(storage.pendingAttachCommands("sage", 0, 10)).toHaveLength(0);

    expect(storage.artifacts.settleDelivery("sage", "artifact-1", "delivery-2", "delivered", 150).outcome).toBe("settled");
    expect(storage.artifacts.get("artifact-1")?.delivery).toMatchObject({ state: "delivered", deliveredAt: 150 });
    // Delivered is platform commitment, not receipt, so it is not acknowledged yet.
    expect(storage.artifacts.get("artifact-1")?.delivery?.acknowledgedAt).toBeUndefined();
    expect(storage.artifacts.acknowledge("artifact-1", 160)).toBe(true);
    expect(storage.artifacts.get("artifact-1")?.delivery).toMatchObject({ state: "acknowledged", acknowledgedAt: 160 });
    // A reconnecting client that downloads again updates once.
    expect(storage.artifacts.acknowledge("artifact-1", 170)).toBe(false);
    expect(storage.artifacts.get("artifact-1")?.delivery?.acknowledgedAt).toBe(160);
  });

  it("refuses every invalid delivery transition", () => {
    const storage = open();
    upload(storage, "sage", "media-1");
    storage.artifacts.declare(declaration(), 100);
    const first = storage.artifacts.commit("sage", "artifact-1", "media-1", 110).record!.delivery!.deliveryId;
    // A retry while the current attempt is still live would be a second delivery of one artifact.
    expect(storage.artifacts.retryDelivery("sage", "artifact-1", "delivery-2", 120).outcome).toBe("conflict");
    expect(storage.artifacts.settleDelivery("sage", "artifact-1", first, "delivered", 130).outcome).toBe("settled");
    expect(storage.artifacts.settleDelivery("sage", "artifact-1", first, "failed", 140).outcome).toBe("conflict");
    expect(storage.artifacts.acknowledge("artifact-1", 145)).toBe(true);
    // A failed attempt is not acknowledgeable: it has to be retried into a new identity first.
    expect(storage.artifacts.acknowledge("artifact-1", 146)).toBe(false);
    expect(storage.artifacts.retryDelivery("sage", "artifact-1", "delivery-2", 150).outcome).toBe("conflict");
    expect(storage.artifacts.settleDelivery("other-bot", "artifact-1", first, "failed", 150).outcome).toBe("not_found");
    expect(storage.artifacts.settleDelivery("sage", "artifact-1", "delivery-guessed", "failed", 150).outcome).toBe("not_found");
  });

  it("survives process restart at the commitment and delivery boundaries", () => {
    const path = scratchDb();
    const first = open(path);
    upload(first, "sage", "media-1");
    first.artifacts.declare(declaration(), 100);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const second = open(path);
    expect(second.artifacts.get("artifact-1")).toMatchObject({ state: "declared" });
    const deliveryId = second.artifacts.commit("sage", "artifact-1", "media-1", 110).record!.delivery!.deliveryId;
    second.artifacts.settleDelivery("sage", "artifact-1", deliveryId, "delivered", 120);
    second.close();
    stores.splice(stores.indexOf(second), 1);

    const third = open(path);
    expect(third.artifacts.get("artifact-1")).toMatchObject({ state: "committed", validation: "verified", delivery: { state: "delivered", deliveredAt: 120 } });
    // A replayed commit after restart is the original answer, never a second commitment.
    expect(third.artifacts.commit("sage", "artifact-1", "media-1", 200).outcome).toBe("replayed");
    expect(third.artifacts.get("artifact-1")?.committedAt).toBe(110);
  });

  it("retains originals across cleanup and expiry, and only an explicit deletion removes bytes", () => {
    const storage = open();
    storage.saveAttachMedia("sage", {
      mediaId: "media-1", mimeType: "application/pdf", byteCount: BYTES.byteLength, sha256: SHA,
      filename: "report.pdf", family: "file", expiresAt: 150,
    }, BYTES, 100);
    const older = storage.nativeBotChat("sage", 100).sessionId;
    storage.appendNativeBotMessage({ bot: "sage", sessionId: older, messageId: "answer", role: "assistant", text: "report", at: 100, attachments: [{ type: "attachment", fileId: "media-1", name: "report.pdf", mimeType: "application/pdf", size: BYTES.byteLength, mediaKind: "file" }] });
    storage.resetNativeBotChat("sage", 105);
    storage.artifacts.declare(declaration({ sessionId: older }), 100);
    storage.artifacts.commit("sage", "artifact-1", "media-1", 110);

    // Age, storage cleanup and session deletion are not deletion authorities for an original.
    expect(storage.pruneExpiredAttachMedia(200)).toBe(0);
    expect(storage.deleteUnreferencedAttachMedia("sage", "media-1")).toBe("referenced");
    expect(storage.deleteNativeBotSession({ bot: "sage", sessionId: older, deletedAt: 210, enqueue: false }).outcome).toBe("deleted");
    expect(storage.artifacts.original("artifact-1")).toBeDefined();
    expect(storage.attachMediaInfo("sage", "media-1", 220)).toBeDefined();

    // Explicit deletion is the one authority. Provenance survives; bytes do not.
    expect(storage.deleteArtifact("artifact-1", 220)).toBe("deleted");
    const tombstone = storage.artifacts.get("artifact-1");
    expect(tombstone).toMatchObject({ state: "deleted", deletedAt: 220, bot: "sage", taskId: "task-1", runId: "run-1", sha256: SHA, version: 1 });
    expect(tombstone?.location).toBeUndefined();
    expect(storage.artifacts.original("artifact-1")).toBeUndefined();
    expect(storage.attachMediaInfo("sage", "media-1", 230)).toBeUndefined();
    expect(storage.deleteArtifact("artifact-1", 240)).toBe("absent");
  });

  it("supersedes a version without rewriting the record it replaces", () => {
    const storage = open();
    upload(storage, "sage", "media-1");
    upload(storage, "sage", "media-2");
    storage.artifacts.declare(declaration(), 100);
    storage.artifacts.commit("sage", "artifact-1", "media-1", 110);
    storage.artifacts.declare(declaration({ artifactId: "artifact-2", supersedesArtifactId: "artifact-1" }), 120);
    // Supersession lands on commitment, not on the declaration alone.
    expect(storage.artifacts.get("artifact-1")?.supersededByArtifactId).toBeUndefined();
    expect(storage.artifacts.commit("sage", "artifact-2", "media-2", 130).record).toMatchObject({ version: 2, supersedesArtifactId: "artifact-1" });
    expect(storage.artifacts.get("artifact-1")).toMatchObject({ version: 1, state: "committed", supersededByArtifactId: "artifact-2" });
    expect(storage.artifacts.latest("artifact-1")?.artifactId).toBe("artifact-2");
    expect(storage.artifacts.list({ bot: "sage" }).map((record) => record.artifactId)).toEqual(["artifact-2", "artifact-1"]);
  });

  it("lists only the asked-for bot and room, and finds an artifact without its message", () => {
    const storage = open();
    upload(storage, "sage", "media-1");
    upload(storage, "luna", "media-2");
    storage.artifacts.declare(declaration(), 100);
    storage.artifacts.declare(declaration({ artifactId: "artifact-room", bot: "luna", createdBy: "luna", room: "room-1", taskId: "task-2" }), 100);
    expect(storage.artifacts.list({ bot: "sage" }).map((record) => record.artifactId)).toEqual(["artifact-1"]);
    expect(storage.artifacts.list({ bot: "luna" }).map((record) => record.artifactId)).toEqual(["artifact-room"]);
    expect(storage.artifacts.list({ room: "room-1" }).map((record) => record.artifactId)).toEqual(["artifact-room"]);
    expect(storage.artifacts.list({ room: "room-2" })).toEqual([]);
    // Discovery does not depend on the originating chat message existing at all.
    expect(storage.artifacts.list({ taskId: "task-1" }).map((record) => record.artifactId)).toEqual(["artifact-1"]);
  });
});

describe("Artifact commitment as the canonical Task reference producer", () => {
  it("keeps a Task verifying until its declared Artifact commits, and completes it once committed", () => {
    const storage = open();
    const sessionId = storage.nativeBotChat("sage", 100).sessionId;
    storage.enqueueAttachCommand("sage", "turn", { kind: "turn", threadId: sessionId, turnId: "run-1", messageId: "user", text: "make the report" }, 100);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    upload(storage, "sage", "media-1");
    storage.artifacts.declare(declaration({ taskId, runId: "run-1", sessionId }), 100);

    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "final", event: { kind: "commit", threadId: sessionId, turnId: "run-1", messageId: "answer", blocks: [] } }, 110);
    expect(storage.tasks.read(taskId)?.view.state).toBe("verifying");
    expect(storage.tasks.read(taskId)?.view.artifacts).toEqual([{ artifactId: "artifact-1" }]);

    storage.artifacts.commit("sage", "artifact-1", "media-1", 120);
    expect(storage.tasks.read(taskId)?.view.state).toBe("completed");
  });

  it("blocks the Task on a failed commitment but leaves a completed Task completed when delivery fails", () => {
    const storage = open();
    const sessionId = storage.nativeBotChat("sage", 100).sessionId;
    storage.enqueueAttachCommand("sage", "turn", { kind: "turn", threadId: sessionId, turnId: "run-1", messageId: "user", text: "make the report" }, 100);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    upload(storage, "sage", "media-1");
    storage.artifacts.declare(declaration({ artifactId: "artifact-bad", taskId, runId: "run-1", sessionId, sha256: "c".repeat(64) }), 100);
    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "final", event: { kind: "commit", threadId: sessionId, turnId: "run-1", messageId: "answer", blocks: [] } }, 110);
    storage.artifacts.commit("sage", "artifact-bad", "media-1", 120);
    expect(storage.tasks.read(taskId)?.view.state).toBe("blocked");
    expect(storage.tasks.read(taskId)?.view.lastEvent.reason).toBe("artifact_commit_failed");

    const good = open();
    const goodSession = good.nativeBotChat("sage", 100).sessionId;
    good.enqueueAttachCommand("sage", "turn", { kind: "turn", threadId: goodSession, turnId: "run-1", messageId: "user", text: "make the report" }, 100);
    const goodTask = good.tasks.list({ bot: "sage" })[0]!.taskId;
    upload(good, "sage", "media-1");
    good.artifacts.declare(declaration({ taskId: goodTask, runId: "run-1", sessionId: goodSession }), 100);
    good.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "final", event: { kind: "commit", threadId: goodSession, turnId: "run-1", messageId: "answer", blocks: [] } }, 110);
    const deliveryId = good.artifacts.commit("sage", "artifact-1", "media-1", 120).record!.delivery!.deliveryId;
    expect(good.tasks.read(goodTask)?.view.state).toBe("completed");
    const eventsBefore = good.tasks.read(goodTask)!.events.length;
    const commandsBefore = good.pendingAttachCommands("sage", 0, 10).length;

    good.artifacts.settleDelivery("sage", "artifact-1", deliveryId, "failed", 130, "platform refused");
    good.artifacts.retryDelivery("sage", "artifact-1", "delivery-2", 140);
    expect(good.tasks.read(goodTask)?.view.state).toBe("completed");
    expect(good.tasks.read(goodTask)!.events).toHaveLength(eventsBefore);
    expect(good.pendingAttachCommands("sage", 0, 10)).toHaveLength(commandsBefore);
  });
});

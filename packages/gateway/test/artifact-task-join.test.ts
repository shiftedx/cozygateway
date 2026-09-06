import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openStorage, type Storage } from "../src/storage.ts";

const BYTES = new TextEncoder().encode("%PDF-1.7\njoined\n");
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
  const directory = mkdtempSync(join(tmpdir(), "cozygateway-artifact-join-"));
  directories.push(directory);
  return join(directory, "gateway.db");
}

function upload(storage: Storage, agentId: string, mediaId: string): void {
  storage.saveAttachMedia(agentId, {
    mediaId, mimeType: "application/pdf", byteCount: BYTES.byteLength,
    sha256: SHA, filename: "report.pdf", family: "file",
  }, BYTES, 100);
}

/** One admitted turn, which is one Task whose Run is the attach turn identity of row 64. */
function admit(storage: Storage, bot: string, runId: string, peer = bot): { taskId: string; sessionId: string } {
  const sessionId = storage.nativeBotChat(bot, 100).sessionId;
  storage.enqueueAttachCommand(peer, `turn:${runId}`, { kind: "turn", threadId: sessionId, turnId: runId, messageId: `${runId}:user`, text: "make the report" }, 100);
  const taskId = storage.tasks.list({ bot }).find((view) => view.currentRun.runId === runId)!.taskId;
  return { taskId, sessionId };
}

function declaration(overrides: Partial<Parameters<Storage["artifacts"]["declare"]>[0]> = {}) {
  return {
    artifactId: "artifact-1", bot: "sage", sessionId: "session-1", createdBy: "sage",
    runId: "run-1", filename: "report.pdf", mediaType: "application/pdf",
    sizeBytes: BYTES.byteLength, sha256: SHA, mark: "final" as const, ...overrides,
  };
}

describe("Artifact to Task join by Run identity", () => {
  it("resolves the owning Task from the Run the producer named and shows it on the Task", () => {
    const storage = open();
    const { taskId, sessionId } = admit(storage, "sage", "run-1");
    upload(storage, "sage", "media-1");

    // The producer never names a Task: the id is minted gateway-side and no attach-v1 frame
    // carries it. It names the Run it is executing, which is what row 64 already gave it.
    const declared = storage.artifacts.declare(declaration({ sessionId }), 100);
    expect(declared.outcome).toBe("created");
    expect(declared.record?.taskId).toBe(taskId);
    expect(declared.record?.runId).toBe("run-1");

    storage.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "final", event: { kind: "commit", threadId: sessionId, turnId: "run-1", messageId: "answer", blocks: [] } }, 110);
    expect(storage.tasks.read(taskId)?.view.state).toBe("verifying");
    expect(storage.tasks.read(taskId)?.view.artifacts).toEqual([{ artifactId: "artifact-1" }]);

    const committed = storage.artifacts.commit("sage", "artifact-1", "media-1", 120);
    expect(committed.record?.taskId).toBe(taskId);
    expect(storage.artifacts.list({ taskId }).map((record) => record.artifactId)).toEqual(["artifact-1"]);
    expect(storage.tasks.read(taskId)?.view.state).toBe("completed");
  });

  it("joins at commit time when the Run only became mappable after the declaration", () => {
    const storage = open();
    const sessionId = storage.nativeBotChat("sage", 100).sessionId;
    upload(storage, "sage", "media-1");
    // Declared before the turn was admitted: there is no Task to resolve yet, so none is claimed.
    expect(storage.artifacts.declare(declaration({ sessionId }), 100).record?.taskId).toBeUndefined();

    storage.enqueueAttachCommand("sage", "turn", { kind: "turn", threadId: sessionId, turnId: "run-1", messageId: "user", text: "make the report" }, 105);
    const taskId = storage.tasks.list({ bot: "sage" })[0]!.taskId;
    expect(storage.artifacts.commit("sage", "artifact-1", "media-1", 110).record?.taskId).toBe(taskId);
    expect(storage.tasks.read(taskId)?.view.artifacts).toEqual([{ artifactId: "artifact-1" }]);
  });

  it("records absent Task provenance for a Run it cannot map, and never guesses one", () => {
    const storage = open();
    const { taskId, sessionId } = admit(storage, "sage", "run-1");
    upload(storage, "sage", "media-1");

    // A Run this gateway has no record of. The declaration is kept with the Run the producer
    // stated and no Task at all, which is visibly different from naming no Run.
    const unmapped = storage.artifacts.declare(declaration({ artifactId: "artifact-unmapped", sessionId, runId: "run-elsewhere" }), 100);
    expect(unmapped.record?.runId).toBe("run-elsewhere");
    expect(unmapped.record?.taskId).toBeUndefined();
    expect(storage.artifacts.commit("sage", "artifact-unmapped", "media-1", 110).record?.taskId).toBeUndefined();

    // A declaration naming no Run at all keeps both absent.
    const runless = storage.artifacts.declare(declaration({ artifactId: "artifact-runless", sessionId, runId: undefined }), 100);
    expect(runless.record?.runId).toBeUndefined();
    expect(runless.record?.taskId).toBeUndefined();

    // Neither reaches the real Task, and neither blocks it.
    expect(storage.tasks.read(taskId)?.view.artifacts).toEqual([]);
    expect(storage.artifacts.list({ taskId })).toEqual([]);
  });

  it("refuses to join a Run whose Task belongs to another bot, or whose session differs", () => {
    const storage = open();
    // One peer serving two bots: the Task admitted on luna's session belongs to luna, and the
    // record this peer files is sage's. A Run may only join the Task of its own Bot.
    const luna = admit(storage, "luna", "run-luna", "sage");
    upload(storage, "sage", "media-1");
    const foreign = storage.artifacts.declare(declaration({ artifactId: "artifact-foreign", sessionId: luna.sessionId, runId: "run-luna" }), 100);
    expect(foreign.record?.taskId).toBeUndefined();
    expect(storage.artifacts.commit("sage", "artifact-foreign", "media-1", 110).record?.taskId).toBeUndefined();
    expect(storage.tasks.read(luna.taskId)?.view.artifacts).toEqual([]);

    // A Run belongs to the peer that owns it: another peer naming it maps to nothing.
    const sage = admit(storage, "sage", "run-1");
    upload(storage, "luna", "media-2");
    const otherPeer = storage.artifacts.declare(declaration({ artifactId: "artifact-other-peer", bot: "luna", createdBy: "luna", sessionId: sage.sessionId, runId: "run-1" }), 100);
    expect(otherPeer.record?.taskId).toBeUndefined();

    // The session must be the Run's own session, not another conversation of the same bot.
    const elsewhere = storage.resetNativeBotChat("sage", 100);
    const wrongSession = storage.artifacts.declare(declaration({ artifactId: "artifact-wrong-session", sessionId: elsewhere, runId: "run-1" }), 100);
    expect(wrongSession.record?.taskId).toBeUndefined();
    expect(storage.tasks.read(sage.taskId)?.view.artifacts).toEqual([]);
  });

  it("keeps the join idempotent across a restart between the commit and its replay", () => {
    const path = scratchDb();
    const first = open(path);
    const { taskId, sessionId } = admit(first, "sage", "run-1");
    upload(first, "sage", "media-1");
    first.artifacts.declare(declaration({ sessionId }), 100);
    first.acceptAttachEvent("sage", { kind: "event", sequence: 1, eventId: "final", event: { kind: "commit", threadId: sessionId, turnId: "run-1", messageId: "answer", blocks: [] } }, 110);
    expect(first.artifacts.commit("sage", "artifact-1", "media-1", 120).record?.taskId).toBe(taskId);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = open(path);
    const replay = reopened.artifacts.commit("sage", "artifact-1", "media-1", 200);
    expect(replay.outcome).toBe("replayed");
    // Same Task, same commitment moment: a replay after a restart re-records nothing.
    expect(replay.record).toMatchObject({ taskId, committedAt: 120, state: "committed" });
    expect(reopened.tasks.read(taskId)?.view.artifacts).toEqual([{ artifactId: "artifact-1" }]);
    expect(reopened.artifacts.list({ taskId })).toHaveLength(1);
  });

  it("stores and reports a declared record with no mark as unstated, never as draft", () => {
    const storage = open();
    const { sessionId } = admit(storage, "sage", "run-1");
    upload(storage, "sage", "media-1");
    const declared = storage.artifacts.declare(declaration({ mark: undefined, sessionId }), 100);
    expect(declared.outcome).toBe("created");
    expect(declared.record?.mark).toBeUndefined();
    // Replaying the same unstated declaration is a replay, not a conflict against a default.
    expect(storage.artifacts.declare(declaration({ mark: undefined, sessionId }), 100).outcome).toBe("replayed");
    expect(storage.artifacts.declare(declaration({ mark: "draft", sessionId }), 100).outcome).toBe("conflict");

    const committed = storage.artifacts.commit("sage", "artifact-1", "media-1", 110);
    expect(committed.record?.mark).toBeUndefined();
    expect(storage.artifacts.list({ bot: "sage" })[0]?.mark).toBeUndefined();
    expect(storage.artifacts.get("artifact-1")?.mark).toBeUndefined();
  });
});

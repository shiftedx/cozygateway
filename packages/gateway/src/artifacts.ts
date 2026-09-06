import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Artifact, ArtifactDelivery, ArtifactFailureReason, ArtifactMark } from "cozygateway-contract";
import type { TaskArtifactReference } from "./tasks.ts";

/** Capability 65. The gateway-owned Artifact record and its independent delivery lifecycle.
 *
 * Bytes are NOT stored again here. An Artifact points at the object the existing attach media
 * route already validated and stored, and commitment is the act of recomputing the digest and the
 * byte count over those stored bytes and finding them equal to what was declared. Metadata never
 * commits anything on its own.
 *
 * Delivery is a separate object with its own identity, so a failed delivery leaves a completed
 * Task completed, and a retry names the same committed Artifact rather than the Run that made it. */
export interface ArtifactDeclaration {
  artifactId: string; bot: string; sessionId: string; room?: string;
  taskId?: string; runId?: string; createdBy: string;
  filename: string; mediaType: string; sizeBytes: number; sha256: string;
  mark: ArtifactMark; supersedesArtifactId?: string;
}

interface ArtifactRow {
  artifactId: string; bot: string; sessionId: string; room: string | null;
  taskId: string | null; runId: string | null; createdBy: string;
  filename: string; mediaType: string; sizeBytes: number; sha256: string;
  state: Artifact["state"]; mark: ArtifactMark; validation: Artifact["validation"];
  version: number; supersedes: string | null; supersededBy: string | null;
  createdAt: number; committedAt: number | null; deletedAt: number | null;
  failureReason: ArtifactFailureReason | null; mediaId: string | null;
}
interface DeliveryRow {
  deliveryId: string; artifactId: string; attempt: number; state: ArtifactDelivery["state"];
  queuedAt: number; deliveredAt: number | null; acknowledgedAt: number | null;
  failedAt: number | null; reason: string | null;
}

const SELECT = `SELECT artifact_id AS artifactId, bot, session_id AS sessionId, room, task_id AS taskId,
  run_id AS runId, created_by AS createdBy, filename, media_type AS mediaType, size_bytes AS sizeBytes,
  sha256, state, mark, validation, version, supersedes, superseded_by AS supersededBy,
  created_at AS createdAt, committed_at AS committedAt, deleted_at AS deletedAt,
  failure_reason AS failureReason, media_id AS mediaId FROM artifacts`;
const DELIVERY_SELECT = `SELECT delivery_id AS deliveryId, artifact_id AS artifactId, attempt, state,
  queued_at AS queuedAt, delivered_at AS deliveredAt, acknowledged_at AS acknowledgedAt,
  failed_at AS failedAt, reason FROM artifact_deliveries`;

export class Artifacts {
  readonly #db: DatabaseSync;
  #capacityBytes = Number.POSITIVE_INFINITY;
  #committed: ((taskId: string, runId: string, at: number) => void) | undefined;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY, bot TEXT NOT NULL, session_id TEXT NOT NULL, room TEXT,
        task_id TEXT, run_id TEXT, created_by TEXT NOT NULL, filename TEXT NOT NULL,
        media_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
        state TEXT NOT NULL, mark TEXT NOT NULL, validation TEXT NOT NULL, version INTEGER NOT NULL,
        supersedes TEXT, superseded_by TEXT, created_at INTEGER NOT NULL, committed_at INTEGER,
        deleted_at INTEGER, failure_reason TEXT, media_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS artifacts_bot ON artifacts (bot, created_at DESC);
      CREATE INDEX IF NOT EXISTS artifacts_source ON artifacts (task_id, run_id);
      CREATE TABLE IF NOT EXISTS artifact_deliveries (
        delivery_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
        attempt INTEGER NOT NULL, state TEXT NOT NULL, queued_at INTEGER NOT NULL,
        delivered_at INTEGER, acknowledged_at INTEGER, failed_at INTEGER, reason TEXT,
        UNIQUE (artifact_id, attempt)
      ) STRICT;
    `);
  }

  /** Operator ceiling on retained original bytes. Exceeding it fails a commit visibly; it never
   * reclaims an original that is already committed. */
  capacity(bytes: number): void { this.#capacityBytes = bytes; }

  /** Called after a commitment moves, so the durable Task can re-run its own settlement. The
   * Task remains derived from its own event stream; this only says when to look again. */
  onCommitment(notify: (taskId: string, runId: string, at: number) => void): void { this.#committed = notify; }

  declare(input: ArtifactDeclaration, at: number): { outcome: "created" | "replayed" | "conflict"; record?: Artifact } {
    const existing = this.#row(input.artifactId);
    if (existing !== undefined) {
      return this.#sameDeclaration(existing, input)
        ? { outcome: "replayed", record: this.#record(existing) }
        : { outcome: "conflict", record: this.#record(existing) };
    }
    let version = 1;
    if (input.supersedesArtifactId !== undefined) {
      const prior = this.#row(input.supersedesArtifactId);
      if (prior === undefined) return { outcome: "conflict" };
      version = prior.version + 1;
    }
    this.#db.prepare(
      `INSERT INTO artifacts (artifact_id, bot, session_id, room, task_id, run_id, created_by, filename,
         media_type, size_bytes, sha256, state, mark, validation, version, supersedes, superseded_by,
         created_at, committed_at, deleted_at, failure_reason, media_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'declared', ?, 'unvalidated', ?, ?, NULL, ?, NULL, NULL, NULL, NULL)`,
    ).run(input.artifactId, input.bot, input.sessionId, input.room ?? null, input.taskId ?? null,
      input.runId ?? null, input.createdBy, input.filename, input.mediaType, input.sizeBytes,
      input.sha256, input.mark, version, input.supersedesArtifactId ?? null, at);
    return { outcome: "created", record: this.#record(this.#row(input.artifactId)!) };
  }

  /** Commitment reads the bytes the attach media route stored and proves they are the declared
   * ones. A refusal is recorded on the record rather than thrown away, because a producer and a
   * person both need to see why an output did not become an Artifact. */
  commit(createdBy: string, artifactId: string, mediaId: string, at: number): {
    outcome: "committed" | "replayed" | "mismatch" | "capacity" | "missing_bytes" | "not_found" | "conflict";
    record?: Artifact;
  } {
    const row = this.#row(artifactId);
    if (row === undefined || row.createdBy !== createdBy) return { outcome: "not_found" };
    if (row.state === "deleted") return { outcome: "conflict", record: this.#record(row) };
    if (row.state === "committed") {
      return row.mediaId === mediaId
        ? { outcome: "replayed", record: this.#record(row) }
        : { outcome: "conflict", record: this.#record(row) };
    }
    const stored = this.#db.prepare("SELECT bytes FROM attach_media WHERE agent_id = ? AND media_id = ?")
      .get(createdBy, mediaId) as { bytes: Uint8Array } | undefined;
    if (stored === undefined) return { outcome: "missing_bytes", record: this.#fail(artifactId, "missing_bytes", at) };
    if (createHash("sha256").update(stored.bytes).digest("hex") !== row.sha256)
      return { outcome: "mismatch", record: this.#fail(artifactId, "checksum", at) };
    if (stored.bytes.byteLength !== row.sizeBytes)
      return { outcome: "mismatch", record: this.#fail(artifactId, "size", at) };
    const retained = this.#db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM artifacts WHERE state = 'committed'")
      .get() as { bytes: number };
    if (retained.bytes + row.sizeBytes > this.#capacityBytes)
      return { outcome: "capacity", record: this.#fail(artifactId, "capacity", at) };

    this.#db.exec("SAVEPOINT artifact_commit");
    try {
      this.#db.prepare(
        `UPDATE artifacts SET state = 'committed', validation = 'verified', committed_at = ?,
         failure_reason = NULL, media_id = ? WHERE artifact_id = ?`,
      ).run(at, mediaId, artifactId);
      // A committed original is retained until an explicit deletion, so the producer's temporary
      // staging deadline no longer applies to these bytes.
      this.#db.prepare("UPDATE attach_media SET expires_at = NULL WHERE agent_id = ? AND media_id = ?").run(createdBy, mediaId);
      if (row.supersedes !== null)
        this.#db.prepare("UPDATE artifacts SET superseded_by = ? WHERE artifact_id = ?").run(artifactId, row.supersedes);
      this.#queue(artifactId, randomUUID().replaceAll("-", ""), 1, at);
      this.#db.exec("RELEASE artifact_commit");
    } catch (error) {
      this.#db.exec("ROLLBACK TO artifact_commit; RELEASE artifact_commit");
      throw error;
    }
    this.#notify(row, at);
    return { outcome: "committed", record: this.#record(this.#row(artifactId)!) };
  }

  get(artifactId: string): Artifact | undefined {
    const row = this.#row(artifactId);
    return row === undefined ? undefined : this.#record(row);
  }

  /** The producer surface is scoped to the authenticated peer, so a foreign or guessed identity
   * is the same absent answer. */
  ofPeer(createdBy: string, artifactId: string): Artifact | undefined {
    const row = this.#row(artifactId);
    return row === undefined || row.createdBy !== createdBy ? undefined : this.#record(row);
  }

  list(filter: { bot?: string; room?: string; taskId?: string }): Artifact[] {
    const where: string[] = [];
    const values: string[] = [];
    if (filter.bot !== undefined) { where.push("bot = ?"); values.push(filter.bot); }
    if (filter.room !== undefined) { where.push("room = ?"); values.push(filter.room); }
    if (filter.taskId !== undefined) { where.push("task_id = ?"); values.push(filter.taskId); }
    const rows = this.#db.prepare(`${SELECT}${where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`} ORDER BY created_at DESC, version DESC, artifact_id DESC`)
      .all(...values) as unknown as ArtifactRow[];
    return rows.map((row) => this.#record(row));
  }

  /** Follow the supersession chain from any version to the one that replaced it. */
  latest(artifactId: string): Artifact | undefined {
    let row = this.#row(artifactId);
    const seen = new Set<string>();
    while (row?.supersededBy != null && !seen.has(row.artifactId)) {
      seen.add(row.artifactId);
      const next = this.#row(row.supersededBy);
      if (next === undefined) break;
      row = next;
    }
    return row === undefined ? undefined : this.#record(row);
  }

  /** Where the committed original lives, for the authenticated download route. A tombstone has
   * no binding, which is how deleted bytes stop being reachable. */
  original(artifactId: string): { agentId: string; mediaId: string; filename: string; mediaType: string; sizeBytes: number } | undefined {
    const row = this.#row(artifactId);
    if (row === undefined || row.mediaId === null || row.state !== "committed") return undefined;
    return { agentId: row.createdBy, mediaId: row.mediaId, filename: row.filename, mediaType: row.mediaType, sizeBytes: row.sizeBytes };
  }

  /** Explicit deletion is the only authority that removes an original. Provenance survives as a
   * tombstone; the byte binding does not. The caller reclaims the bytes themselves, through the
   * existing unreferenced-media rule, so an object still reachable as an attachment is kept. */
  forget(artifactId: string, at: number): { outcome: "deleted" | "absent"; media?: { agentId: string; mediaId: string } } {
    const row = this.#row(artifactId);
    if (row === undefined || row.state === "deleted") return { outcome: "absent" };
    this.#db.prepare("UPDATE artifacts SET state = 'deleted', deleted_at = ?, media_id = NULL WHERE artifact_id = ?").run(at, artifactId);
    return { outcome: "deleted", ...(row.mediaId === null ? {} : { media: { agentId: row.createdBy, mediaId: row.mediaId } }) };
  }

  /** The producer reports the one platform fact it owns. Delivered is platform commitment, not
   * receipt. A duplicate report keeps the first fact. */
  settleDelivery(createdBy: string, artifactId: string, deliveryId: string, state: "delivered" | "failed", at: number, reason?: string): {
    outcome: "settled" | "replayed" | "conflict" | "not_found" | "not_committed"; record?: Artifact;
  } {
    const row = this.#row(artifactId);
    if (row === undefined || row.createdBy !== createdBy) return { outcome: "not_found" };
    if (row.state !== "committed") return { outcome: "not_committed", record: this.#record(row) };
    const delivery = this.#db.prepare(`${DELIVERY_SELECT} WHERE delivery_id = ? AND artifact_id = ?`)
      .get(deliveryId, artifactId) as DeliveryRow | undefined;
    if (delivery === undefined) return { outcome: "not_found" };
    if (delivery.state === state) return { outcome: "replayed", record: this.#record(row) };
    if (delivery.state !== "queued") return { outcome: "conflict", record: this.#record(row) };
    if (state === "delivered")
      this.#db.prepare("UPDATE artifact_deliveries SET state = 'delivered', delivered_at = ? WHERE delivery_id = ?").run(at, deliveryId);
    else
      this.#db.prepare("UPDATE artifact_deliveries SET state = 'failed', failed_at = ?, reason = ? WHERE delivery_id = ?").run(at, reason ?? null, deliveryId);
    return { outcome: "settled", record: this.#record(row) };
  }

  /** A retry is a new delivery identity against the same committed Artifact. It never re-admits
   * the generating Task or Run, and it is only available once the current attempt has failed. */
  retryDelivery(createdBy: string, artifactId: string, deliveryId: string, at: number): {
    outcome: "queued" | "conflict" | "not_found" | "not_committed"; record?: Artifact;
  } {
    const row = this.#row(artifactId);
    if (row === undefined || row.createdBy !== createdBy) return { outcome: "not_found" };
    if (row.state !== "committed") return { outcome: "not_committed", record: this.#record(row) };
    const current = this.#delivery(artifactId);
    if (current === undefined || current.state !== "failed") return { outcome: "conflict", record: this.#record(row) };
    if (this.#db.prepare("SELECT 1 FROM artifact_deliveries WHERE delivery_id = ?").get(deliveryId) !== undefined)
      return { outcome: "conflict", record: this.#record(row) };
    this.#queue(artifactId, deliveryId, current.attempt + 1, at);
    return { outcome: "queued", record: this.#record(row) };
  }

  /** Acknowledgement is an authenticated client actually receiving the bytes. It is never a claim
   * that a person read the Artifact, and a second download updates nothing.
   *
   * A download served by this gateway is also the platform commitment for that attempt, so a
   * still-queued delivery records both facts at once. A failed attempt records neither: it must
   * be retried into a new delivery identity first. */
  acknowledge(artifactId: string, at: number): boolean {
    const delivery = this.#delivery(artifactId);
    if (delivery === undefined || delivery.state === "acknowledged" || delivery.state === "failed") return false;
    this.#db.prepare(
      "UPDATE artifact_deliveries SET state = 'acknowledged', delivered_at = COALESCE(delivered_at, ?), acknowledged_at = ? WHERE delivery_id = ?",
    ).run(at, at, delivery.deliveryId);
    return true;
  }

  /** Capability 64's source-bound reader, answered by the canonical producer. Only explicit
   * declarations bound to exactly this Task, Bot, peer, session and Run are reported, and only
   * their real commitment status. */
  taskReferences(source: { taskId: string; bot: string; peer: string; sessionId: string; runId: string }): TaskArtifactReference[] {
    const rows = this.#db.prepare(
      `${SELECT} WHERE task_id = ? AND bot = ? AND created_by = ? AND session_id = ? AND run_id = ?`,
    ).all(source.taskId, source.bot, source.peer, source.sessionId, source.runId) as unknown as ArtifactRow[];
    return rows.map((row) => ({
      artifactId: row.artifactId,
      status: row.committedAt !== null ? "committed" : row.state === "commit_failed" ? "failed" : "pending",
    }));
  }

  #queue(artifactId: string, deliveryId: string, attempt: number, at: number): void {
    this.#db.prepare(
      "INSERT INTO artifact_deliveries (delivery_id, artifact_id, attempt, state, queued_at) VALUES (?, ?, ?, 'queued', ?)",
    ).run(deliveryId, artifactId, attempt, at);
  }

  #fail(artifactId: string, reason: ArtifactFailureReason, at: number): Artifact {
    this.#db.prepare(
      "UPDATE artifacts SET state = 'commit_failed', validation = 'mismatch', failure_reason = ?, committed_at = NULL WHERE artifact_id = ?",
    ).run(reason, artifactId);
    const row = this.#row(artifactId)!;
    this.#notify(row, at);
    return this.#record(row);
  }

  #notify(row: ArtifactRow, at: number): void {
    if (row.taskId !== null && row.runId !== null) this.#committed?.(row.taskId, row.runId, at);
  }

  #delivery(artifactId: string): DeliveryRow | undefined {
    return this.#db.prepare(`${DELIVERY_SELECT} WHERE artifact_id = ? ORDER BY attempt DESC LIMIT 1`)
      .get(artifactId) as DeliveryRow | undefined;
  }

  #row(artifactId: string): ArtifactRow | undefined {
    return this.#db.prepare(`${SELECT} WHERE artifact_id = ?`).get(artifactId) as ArtifactRow | undefined;
  }

  #sameDeclaration(row: ArtifactRow, input: ArtifactDeclaration): boolean {
    return row.createdBy === input.createdBy && row.bot === input.bot && row.sessionId === input.sessionId
      && row.room === (input.room ?? null) && row.taskId === (input.taskId ?? null)
      && row.runId === (input.runId ?? null) && row.filename === input.filename
      && row.mediaType === input.mediaType && row.sizeBytes === input.sizeBytes
      && row.sha256 === input.sha256 && row.mark === input.mark
      && row.supersedes === (input.supersedesArtifactId ?? null);
  }

  #record(row: ArtifactRow): Artifact {
    const delivery = this.#delivery(row.artifactId);
    return {
      artifactId: row.artifactId, bot: row.bot, sessionId: row.sessionId, createdBy: row.createdBy,
      filename: row.filename, mediaType: row.mediaType, sizeBytes: row.sizeBytes, sha256: row.sha256,
      state: row.state, mark: row.mark, validation: row.validation, version: row.version,
      createdAt: row.createdAt,
      ...(row.room === null ? {} : { room: row.room }),
      ...(row.taskId === null ? {} : { taskId: row.taskId }),
      ...(row.runId === null ? {} : { runId: row.runId }),
      ...(row.supersedes === null ? {} : { supersedesArtifactId: row.supersedes }),
      ...(row.supersededBy === null ? {} : { supersededByArtifactId: row.supersededBy }),
      ...(row.committedAt === null ? {} : { committedAt: row.committedAt }),
      ...(row.deletedAt === null ? {} : { deletedAt: row.deletedAt }),
      ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
      ...(row.state === "committed" ? { location: `/artifacts/${encodeURIComponent(row.artifactId)}/content` } : {}),
      ...(delivery === undefined ? {} : { delivery: {
        deliveryId: delivery.deliveryId, artifactId: delivery.artifactId, attempt: delivery.attempt,
        state: delivery.state, queuedAt: delivery.queuedAt,
        ...(delivery.deliveredAt === null ? {} : { deliveredAt: delivery.deliveredAt }),
        ...(delivery.acknowledgedAt === null ? {} : { acknowledgedAt: delivery.acknowledgedAt }),
        ...(delivery.failedAt === null ? {} : { failedAt: delivery.failedAt }),
        ...(delivery.reason === null ? {} : { reason: delivery.reason }),
      } }),
    };
  }
}

import { type Static, Type } from "@sinclair/typebox";

/** Capability 65. The gateway-owned Artifact record and its independent delivery lifecycle.
 *
 * An Artifact is a declared Task output with a stable identity, provenance to the Bot, the
 * authenticated producer, the Task and the Run, and evidence that its committed bytes are the
 * bytes that were stored. Metadata alone is never commitment: a commit recomputes the digest and
 * the byte count over the stored original and refuses anything else.
 *
 * Delivery is a separate object with its own identity and states, so a delivery that fails leaves
 * a completed Task completed and a retry references the same committed Artifact instead of
 * re-admitting the generating Task or Run. */
const Id = Type.String({ minLength: 1, maxLength: 256 });
const At = Type.Integer({ minimum: 0 });

export const ARTIFACT_STATES = ["declared", "committed", "commit_failed", "deleted"] as const;
export const ArtifactStateSchema = Type.Union(ARTIFACT_STATES.map((value) => Type.Literal(value)));
export type ArtifactState = Static<typeof ArtifactStateSchema>;

/** Draft, a copy circulated for review, or the final output. The producer declares it; the
 * gateway stores and reports it and never infers it. There is deliberately no value for "the
 * producer did not say": that is absence, and a client renders it as no mark. */
export const ARTIFACT_MARKS = ["draft", "review_copy", "final"] as const;
export const ArtifactMarkSchema = Type.Union(ARTIFACT_MARKS.map((value) => Type.Literal(value)));
export type ArtifactMark = Static<typeof ArtifactMarkSchema>;

/** `verified` is only ever written by a commit whose recomputed digest and byte count over the
 * stored original equalled the declaration. `mismatch` records the refusal. */
export const ARTIFACT_VALIDATIONS = ["unvalidated", "verified", "mismatch"] as const;
export const ArtifactValidationSchema = Type.Union(ARTIFACT_VALIDATIONS.map((value) => Type.Literal(value)));
export type ArtifactValidation = Static<typeof ArtifactValidationSchema>;

/** `queued` is not received. `delivered` is platform commitment. `acknowledged` is authenticated
 * client receipt or download, never proof a person read the artifact. */
export const ARTIFACT_DELIVERY_STATES = ["queued", "delivered", "acknowledged", "failed"] as const;
export const ArtifactDeliveryStateSchema = Type.Union(ARTIFACT_DELIVERY_STATES.map((value) => Type.Literal(value)));
export type ArtifactDeliveryState = Static<typeof ArtifactDeliveryStateSchema>;

/** Where the record came from. `declared` is a peer that used the capability 65 producer routes.
 * `derived` is the gateway's own minimal record for an attachment a peer delivered without ever
 * declaring one, so a Hermes bot's files are discoverable with no change to the peer. The field is
 * optional on the wire and a record that omits it reads as `declared`, which is what every record
 * written before this field existed is. */
export const ARTIFACT_ORIGINS = ["declared", "derived"] as const;
export const ArtifactOriginSchema = Type.Union(ARTIFACT_ORIGINS.map((value) => Type.Literal(value)));
export type ArtifactOrigin = Static<typeof ArtifactOriginSchema>;

export const ARTIFACT_FAILURE_REASONS = ["checksum", "size", "capacity", "missing_bytes"] as const;
export const ArtifactFailureReasonSchema = Type.Union(ARTIFACT_FAILURE_REASONS.map((value) => Type.Literal(value)));
export type ArtifactFailureReason = Static<typeof ArtifactFailureReasonSchema>;

export const ArtifactDeliverySchema = Type.Object({
  deliveryId: Id, artifactId: Id, attempt: Type.Integer({ minimum: 1 }),
  state: ArtifactDeliveryStateSchema, queuedAt: At,
  deliveredAt: Type.Optional(At), acknowledgedAt: Type.Optional(At), failedAt: Type.Optional(At),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});
export type ArtifactDelivery = Static<typeof ArtifactDeliverySchema>;

export const ArtifactSchema = Type.Object({
  artifactId: Id, bot: Id, sessionId: Id, room: Type.Optional(Id),
  /** `runId` is what the producer stated: the attach turn identity capability 64 made the Run
   * identity. `taskId` is the gateway's own join from that Run, never a producer claim, and it is
   * absent when this gateway cannot map the Run to a Task of this Bot. */
  taskId: Type.Optional(Id), runId: Type.Optional(Id), createdBy: Id,
  filename: Type.String({ minLength: 1, maxLength: 255 }), mediaType: Type.String({ minLength: 1, maxLength: 255 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  /** The declared digest, proved against the stored bytes by a commit. Absent on a `derived`
   * record: nothing was declared there, so no checksum may be claimed. */
  sha256: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
  state: ArtifactStateSchema,
  /** The producer's own mark. Absent on a `derived` record for the same reason, and absent on a
   * `declared` one whose producer did not state a mark. Absence is unstated, never `draft`. */
  mark: Type.Optional(ArtifactMarkSchema),
  validation: ArtifactValidationSchema,
  origin: Type.Optional(ArtifactOriginSchema),
  /** The chat message the attachment was delivered in, on a `derived` record. Discovery still
   * never needs it; it is the provenance a derived record has instead of a Task. */
  sourceMessageId: Type.Optional(Id),
  version: Type.Integer({ minimum: 1 }),
  supersedesArtifactId: Type.Optional(Id), supersededByArtifactId: Type.Optional(Id),
  createdAt: At, committedAt: Type.Optional(At), deletedAt: Type.Optional(At),
  failureReason: Type.Optional(ArtifactFailureReasonSchema),
  /** Gateway-relative download location. Never a host path and never a credential. Absent once
   * the record is a tombstone, because deleted bytes are not offered. */
  location: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  delivery: Type.Optional(ArtifactDeliverySchema),
});
export type Artifact = Static<typeof ArtifactSchema>;

export const ArtifactListSchema = Type.Object({ artifacts: Type.Array(ArtifactSchema) });

export const ArtifactDeclareRequestSchema = Type.Object({
  artifactId: Id, sessionId: Id, room: Type.Optional(Id),
  /** The Run the producer is executing, which is its own attach turn identity. The gateway joins
   * the owning Task from it. `taskId` is accepted for compatibility with the first row 65 clients
   * and IGNORED: the Task id is minted gateway-side and reaches a peer on no frame, so a peer
   * learns its own Task id only by reading `taskId` back off the record it just declared. */
  taskId: Type.Optional(Id), runId: Type.Optional(Id),
  filename: Type.String({ minLength: 1, maxLength: 255 }), mediaType: Type.String({ minLength: 1, maxLength: 255 }),
  sizeBytes: Type.Integer({ minimum: 0 }), sha256: Type.String({ minLength: 64, maxLength: 64 }),
  /** Optional: a producer that did not say leaves it out and the record reports no mark. */
  mark: Type.Optional(ArtifactMarkSchema), supersedesArtifactId: Type.Optional(Id),
});
export type ArtifactDeclareRequest = Static<typeof ArtifactDeclareRequestSchema>;

/** The bytes are already in the existing attach media store under this id. There is no second
 * upload authority: commit points at what that route stored and verifies it. */
export const ArtifactCommitRequestSchema = Type.Object({ mediaId: Id });

/** The producer reports the one platform fact it owns. Acknowledgement is never reportable here:
 * it is written by an authenticated client actually receiving the bytes. */
export const ArtifactDeliverySettleRequestSchema = Type.Object({
  state: Type.Union([Type.Literal("delivered"), Type.Literal("failed")]),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

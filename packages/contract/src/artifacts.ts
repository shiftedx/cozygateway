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
 * gateway stores and reports it and never infers it. */
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
  taskId: Type.Optional(Id), runId: Type.Optional(Id), createdBy: Id,
  filename: Type.String({ minLength: 1, maxLength: 255 }), mediaType: Type.String({ minLength: 1, maxLength: 255 }),
  sizeBytes: Type.Integer({ minimum: 0 }), sha256: Type.String({ minLength: 64, maxLength: 64 }),
  state: ArtifactStateSchema, mark: ArtifactMarkSchema, validation: ArtifactValidationSchema,
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
  taskId: Type.Optional(Id), runId: Type.Optional(Id),
  filename: Type.String({ minLength: 1, maxLength: 255 }), mediaType: Type.String({ minLength: 1, maxLength: 255 }),
  sizeBytes: Type.Integer({ minimum: 0 }), sha256: Type.String({ minLength: 64, maxLength: 64 }),
  mark: ArtifactMarkSchema, supersedesArtifactId: Type.Optional(Id),
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

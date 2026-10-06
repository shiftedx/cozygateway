import { type Static, Type } from "@sinclair/typebox";

/** Read-only, locked-root Hermes workspace browsing. This capability is independent of harness
 * settings: a gateway advertises it only after Hermes proves that its managed-files root is locked. */
export const HARNESS_WORKSPACE_CAPABILITY_ID = "com.cozylabs.harness-workspace";
export const HARNESS_WORKSPACE_CAPABILITY_VERSION = 1;

export const WORKSPACE_PATH_MAX_BYTES = 4096;
export const WORKSPACE_SEGMENT_MAX_BYTES = 255;
export const WORKSPACE_LIST_MAX_ENTRIES = 1000;
export const WORKSPACE_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const WORKSPACE_RANGE_MAX_BYTES = 16 * 1024 * 1024;

export const HarnessWorkspaceEntrySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: WORKSPACE_SEGMENT_MAX_BYTES }),
  /** Canonical slash-separated path relative to the locked root. Never an upstream/host path. */
  path: Type.String({ minLength: 1, maxLength: WORKSPACE_PATH_MAX_BYTES }),
  kind: Type.Union([Type.Literal("directory"), Type.Literal("file")]),
  size: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  modifiedAt: Type.Integer({ minimum: 0 }),
  mimeType: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
}, { additionalProperties: false });
export type HarnessWorkspaceEntry = Static<typeof HarnessWorkspaceEntrySchema>;

export const HarnessWorkspaceListSchema = Type.Object({
  /** Empty string names the locked root. */
  path: Type.String({ maxLength: WORKSPACE_PATH_MAX_BYTES }),
  parent: Type.Union([
    Type.String({ maxLength: WORKSPACE_PATH_MAX_BYTES }),
    Type.Null(),
  ]),
  entries: Type.Array(HarnessWorkspaceEntrySchema, { maxItems: WORKSPACE_LIST_MAX_ENTRIES }),
}, { additionalProperties: false });
export type HarnessWorkspaceList = Static<typeof HarnessWorkspaceListSchema>;

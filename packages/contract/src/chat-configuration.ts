import { type Static, Type } from "@sinclair/typebox";

/** Per-conversation execution choices. This extension is deliberately separate from harness
 * provider administration: it never carries a credential, endpoint, host path, or provider
 * configuration value. */
export const CHAT_CONFIGURATION_CAPABILITY_ID = "com.cozylabs.chat-configuration";
export const CHAT_CONFIGURATION_CAPABILITY_VERSION = 1;

const OpaqueId = Type.String({ minLength: 1, maxLength: 256 });

export const ChatWorkspaceSelectionSchema = Type.Object({
  computerId: OpaqueId,
  projectId: OpaqueId,
  mode: Type.Union([Type.Literal("direct"), Type.Literal("worktree")]),
  branch: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
}, { additionalProperties: false });
export type ChatWorkspaceSelection = Static<typeof ChatWorkspaceSelectionSchema>;

export const ChatModelSelectionSchema = Type.Object({
  providerId: OpaqueId,
  modelId: OpaqueId,
  effort: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });
export type ChatModelSelection = Static<typeof ChatModelSelectionSchema>;

export const ChatSessionConfigurationSchema = Type.Object({
  sessionId: OpaqueId,
  workspace: Type.Union([ChatWorkspaceSelectionSchema, Type.Null()]),
  model: Type.Union([ChatModelSelectionSchema, Type.Null()]),
}, { additionalProperties: false });
export type ChatSessionConfiguration = Static<typeof ChatSessionConfigurationSchema>;

/** A PUT is an intent patch. Omitted leaves that override unchanged; null explicitly clears it. */
export const ChatSessionConfigurationPatchSchema = Type.Object({
  sessionId: OpaqueId,
  workspace: Type.Optional(Type.Union([ChatWorkspaceSelectionSchema, Type.Null()])),
  model: Type.Optional(Type.Union([ChatModelSelectionSchema, Type.Null()])),
}, { additionalProperties: false });
export type ChatSessionConfigurationPatch = Static<typeof ChatSessionConfigurationPatchSchema>;

/** The runner owns the meaning of these opaque ids. Host paths and credentials never cross this
 * app-facing contract. */
export const ChatComputerSchema = Type.Object({
  id: OpaqueId,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  isAvailable: Type.Boolean(),
}, { additionalProperties: false });
export type ChatComputer = Static<typeof ChatComputerSchema>;

export const ChatProjectSchema = Type.Object({
  id: OpaqueId,
  name: Type.String({ minLength: 1, maxLength: 240 }),
  displayPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  isGitRepository: Type.Boolean(),
  currentBranch: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
}, { additionalProperties: false });
export type ChatProject = Static<typeof ChatProjectSchema>;

export const ChatBranchSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 512 }),
  isCurrent: Type.Boolean(),
}, { additionalProperties: false });
export type ChatBranch = Static<typeof ChatBranchSchema>;

export const ChatProjectListSchema = Type.Object({
  projects: Type.Array(ChatProjectSchema, { maxItems: 2_000 }),
}, { additionalProperties: false });
export type ChatProjectList = Static<typeof ChatProjectListSchema>;

export const ChatBranchListSchema = Type.Object({
  branches: Type.Array(ChatBranchSchema, { maxItems: 2_000 }),
}, { additionalProperties: false });
export type ChatBranchList = Static<typeof ChatBranchListSchema>;

export const ChatSessionConfigurationSnapshotSchema = Type.Object({
  configuration: ChatSessionConfigurationSchema,
  defaults: Type.Object({
    /** The bot's last successfully prepared workspace, used only to prefill a new session. */
    workspace: Type.Union([ChatWorkspaceSelectionSchema, Type.Null()]),
  }, { additionalProperties: false }),
  computers: Type.Array(ChatComputerSchema, { maxItems: 256 }),
  /** Both facts belong only to this selected conversation. */
  canChangeWorkspace: Type.Boolean(),
  canChangeModel: Type.Boolean(),
  unavailableReason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
}, { additionalProperties: false });
export type ChatSessionConfigurationSnapshot = Static<typeof ChatSessionConfigurationSnapshotSchema>;

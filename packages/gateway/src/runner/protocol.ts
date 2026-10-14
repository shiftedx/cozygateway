import { type Static, Type } from "@sinclair/typebox";
import { ChatBranchSchema, ChatProjectSchema, type ChatWorkspaceSelection } from "cozygateway-contract";

export const ChatExecutionStageSchema = Type.Union([
  Type.Literal("starting"), Type.Literal("ready"), Type.Literal("deleted"), Type.Literal("failed"),
]);
const ChatExecutionIdentity = {
  executionId: Type.String({ pattern: "^chatx_[0-9a-f]{32}$" }),
  botId: Type.String({ minLength: 1, maxLength: 64 }),
  sessionId: Type.String({ minLength: 1, maxLength: 200 }),
  stage: ChatExecutionStageSchema,
};
export const RunnerChatExecutionReceiptSchema = Type.Object({
  kind: Type.Literal("chat_execution_receipt"),
  operationId: Type.String({ minLength: 1, maxLength: 120 }),
  ...ChatExecutionIdentity,
  code: Type.Optional(Type.String({ pattern: "^[a-z0-9_]{1,120}$" })),
}, { additionalProperties: false });
export type RunnerChatExecutionReceipt = Static<typeof RunnerChatExecutionReceiptSchema>;
export const RunnerChatWorkspaceResultSchema = Type.Object({
  kind: Type.Literal("chat_workspace_result"),
  requestId: Type.String({ minLength: 1, maxLength: 120 }),
  result: Type.Optional(Type.Union([
    Type.Object({ projects: Type.Array(ChatProjectSchema, { maxItems: 1024 }) }, { additionalProperties: false }),
    Type.Object({ branches: Type.Array(ChatBranchSchema, { maxItems: 4096 }) }, { additionalProperties: false }),
  ])),
  error: Type.Optional(Type.Object({ code: Type.String({ pattern: "^[a-z0-9_]{1,120}$" }) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type RunnerChatWorkspaceResult = Static<typeof RunnerChatWorkspaceResultSchema>;
export type RunnerChatFrame = RunnerChatExecutionReceipt | RunnerChatWorkspaceResult;

export interface RunnerCreateChatExecutionPayload {
  operationId: string;
  executionId: string;
  botId: string;
  sessionId: string;
  attachToken: string;
  model?: { provider?: string; endpoint?: string; id: string; contextWindow?: number; maxTokens?: number };
  credentialMode?: "transfer_required";
  harness: "hermes";
  workspace: ChatWorkspaceSelection;
  sourceProfile?: { soul?: string; disabledSkills?: string[]; enabledSkills?: string[]; enabledToolsets?: string[]; enabledMcpServers?: string[]; guardrailLevel?: string };
}
export type RunnerChatCommandFrame =
  | { kind: "command"; command: "create_chat_execution"; payload: RunnerCreateChatExecutionPayload }
  | { kind: "command"; command: "delete_chat_execution"; payload: { operationId: string; executionId: string } }
  | { kind: "command"; command: "list_chat_projects"; payload: { requestId: string } }
  | { kind: "command"; command: "list_chat_branches"; payload: { requestId: string; projectId: string } };

/** The private, Hermes-computer control protocol. It is separate from the app-facing contract. */
export const RUNNER_V1_VERSION = 1;
export const RUNNER_V1_HEARTBEAT_INTERVAL_MS = 15_000;
export const RUNNER_V1_HEARTBEAT_TIMEOUT_MS = 45_000;
export const RunnerHelloSchema = Type.Object({
  kind: Type.Literal("hello"), version: Type.Integer({ minimum: 1, maximum: 1 }),
  runnerId: Type.String({ minLength: 1, maxLength: 120 }),
  backends: Type.Array(Type.Union([Type.Literal("docker"), Type.Literal("process")]), { minItems: 1, maxItems: 4 }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  platform: Type.Optional(Type.Object({ os: Type.String({ minLength: 1, maxLength: 40 }), arch: Type.String({ minLength: 1, maxLength: 20 }), release: Type.Optional(Type.String({ maxLength: 60 })) })),
  agentVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  capabilities: Type.Optional(Type.Object({ chat_execution: Type.Optional(Type.Literal(1)) })),
  chatExecutionHarnesses: Type.Optional(Type.Array(Type.Union([Type.Literal("cozyagents"), Type.Literal("hermes")]), { maxItems: 2, uniqueItems: true })),
  executionInventory: Type.Optional(Type.Array(Type.Object(ChatExecutionIdentity), { maxItems: 256 })),
});
export type RunnerHello = Static<typeof RunnerHelloSchema>;
export const RunnerHeartbeatSchema = Type.Object({ kind: Type.Literal("heartbeat"), sentAt: Type.Optional(Type.Integer({ minimum: 0 })) });
export const RunnerClientFrameSchema = Type.Union([RunnerHelloSchema, RunnerHeartbeatSchema, RunnerChatExecutionReceiptSchema, RunnerChatWorkspaceResultSchema]);
export type RunnerClientFrame = Static<typeof RunnerClientFrameSchema>;
export const RUNNER_CLIENT_FRAME_KINDS: ReadonlySet<string> = new Set(["hello", "heartbeat", "chat_execution_receipt", "chat_workspace_result"]);
export type RunnerServerFrame = { kind: "hello_ack"; version: number; capabilities: readonly string[]; heartbeatIntervalMs: number } | { kind: "heartbeat"; sentAt: number } | RunnerChatCommandFrame;
export function platformLabel(platform: { os: string; arch: string; release?: string } | undefined): string | undefined {
  if (platform === undefined) return undefined;
  return [platform.os, platform.arch, ...(platform.release === undefined ? [] : [platform.release])].join("/").slice(0, 120);
}

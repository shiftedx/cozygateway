import { afterEach, expect, it, vi } from "vitest";
import type { BotProfile } from "cozygateway-contract";
import { RunnerChatExecutionDriver } from "../src/runner/chat-executions.ts";
import { openStorage } from "../src/storage.ts";
import type { RunnerChatCommandFrame, RunnerChatFrame, RunnerHello } from "../src/runner/protocol.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const workspace = { computerId: "remote", projectId: "app", mode: "worktree" as const, branch: "main" };
const profile: BotProfile = {
  name: "Sage", description: "", soul: "Help with this project.", skills: [], toolsets: [], toolsetsPinned: false,
  mcpServers: [], model: { provider: "openai", default: "example" }, runtimeInert: [],
};

function setup(custom = false) {
  const storage = openStorage(":memory:");
  cleanups.push(() => storage.close());
  const commands: RunnerChatCommandFrame[] = [];
  let onFrame: ((runner: string, frame: RunnerChatFrame) => void) | undefined;
  let onConnection: ((runner: string, hello: RunnerHello | undefined) => void) | undefined;
  const provider = custom ? "custom-11111111-1111-4111-8111-111111111111" : "openai";
  const tokens = new Map<string, string>();
  const prepareProvider = vi.fn(async () => undefined);
  const prepareChatConfiguration = vi.fn(async (_peer, configuration) => ({ configuration }));
  const modelConfig = vi.fn(async () => ({ model: `${provider}:example`, effort: "medium", efforts: [], catalog: [], ...(custom ? { providers: [{ slug: provider, name: "Studio", baseUrl: "http://localhost:1234/v1", authenticated: true, modelCount: 1 }] } : {}) }));
  const driver = new RunnerChatExecutionDriver({
    storage, tokens, prepareProvider, runtimeBot: () => true, name: () => "Work Mac", isAttached: () => true, disconnect: vi.fn(),
    lane: {
      chatCapableRunners: () => ["remote"],
      onChatFrame: (listener) => { onFrame = listener; return () => undefined; },
      onChatConnection: (listener) => { onConnection = listener; return () => undefined; },
      sendChatCommand: (_id, frame) => { commands.push(frame); return true; },
    },
    surface: {
      botProfile: async () => profile,
      modelConfig,
      providerConnections: async () => ({ connections: [] }),
      prepareChatConfiguration,
    },
    local: {
      availability: async () => ({ available: true }), computers: async () => [{ id: "home", name: "Home", isAvailable: true }],
      projects: async () => [], branches: async () => [], prepareContext: async () => ({ workspacePrepared: false }),
    },
  });
  cleanups.push(() => driver.close());
  return { storage, driver, commands, tokens, prepareProvider, prepareChatConfiguration, modelConfig, frame: (runner: string, frame: RunnerChatFrame) => onFrame?.(runner, frame), connection: (runner: string, hello: RunnerHello | undefined) => onConnection?.(runner, hello) };
}

it("returns to the current bot default after a chat override without replacing the execution", async () => {
  const test = setup();
  const sessionId = test.storage.nativeBotChat("sage", 1).sessionId;
  await test.driver.prepareContext({ bot: "sage", sessionId, workspace, model: { providerId: "openai", modelId: "override" } });
  const executionId = test.storage.chatExecution("sage", sessionId)!.executionId;
  test.modelConfig.mockResolvedValueOnce({ model: "openai:new-default", effort: "high", efforts: [], catalog: [] });
  await expect(test.driver.prepareContext({ bot: "sage", sessionId, workspace, model: null }))
    .resolves.toEqual({ workspacePrepared: true, effectiveModel: { providerId: "openai", modelId: "new-default", effort: "high" } });
  expect(test.storage.chatExecution("sage", sessionId)!.executionId).toBe(executionId);
  expect(test.prepareChatConfiguration).toHaveBeenLastCalledWith(executionId, { sessionId, workspace,
    model: { providerId: "openai", modelId: "new-default", effort: "high" } });
});

it("retires a failed pre-turn execution when the user returns to the bot workspace", async () => {
  const test = setup();
  const sessionId = test.storage.nativeBotChat("sage", 1).sessionId;
  test.prepareChatConfiguration.mockRejectedValueOnce(new Error("preparation failed"));
  await expect(test.driver.prepareContext({ bot: "sage", sessionId, workspace, model: null })).rejects.toThrow("preparation failed");
  const row = test.storage.chatExecution("sage", sessionId)!;
  await test.driver.prepareContext({ bot: "sage", sessionId, workspace: null, model: null });
  expect(test.storage.chatExecution("sage", sessionId)).toBeUndefined();
  expect(test.storage.chatExecutionById(row.executionId)?.stage).toBe("deleted");
  expect(test.tokens.has(row.token)).toBe(false);
  expect(test.commands.at(-1)?.command).toBe("delete_chat_execution");
});

it("creates one session peer without moving the source bot or its other chat", async () => {
  const test = setup();
  const previous = test.storage.nativeBotChat("sage", 1).sessionId;
  const sessionId = test.storage.resetNativeBotChat("sage", 2);
  const prepared = await test.driver.prepareContext({ bot: "sage", sessionId, workspace, model: null });
  const row = test.storage.chatExecution("sage", sessionId)!;
  expect(prepared).toEqual({ workspacePrepared: true, effectiveModel: { providerId: "openai", modelId: "example", effort: "medium" } });
  expect(row.stage).toBe("ready");
  expect(test.storage.chatExecution("sage", previous)).toBeUndefined();
  expect(test.storage.runtimeBots()).toEqual([]);
  expect(test.tokens.get(row.token)).toBe(row.executionId);
  expect(test.prepareChatConfiguration).toHaveBeenCalledWith(row.executionId, { sessionId, workspace, model: prepared.effectiveModel });
  await test.driver.prepareContext({ bot: "sage", sessionId, workspace, model: null });
  expect(test.storage.chatExecutions()).toHaveLength(1);
  expect(test.commands.filter((frame) => frame.command === "create_chat_execution").map((frame) => frame.payload.executionId)).toEqual([row.executionId, row.executionId]);
});

it("transfers a custom provider only into the bound child, with no key on runner commands", async () => {
  const test = setup(true);
  const sessionId = test.storage.nativeBotChat("sage", 1).sessionId;
  await test.driver.prepareContext({ bot: "sage", sessionId, workspace, model: null });
  const row = test.storage.chatExecution("sage", sessionId)!;
  const command = test.commands.find((frame) => frame.command === "create_chat_execution")!;
  expect(command.payload).toMatchObject({ credentialMode: "transfer_required", model: { id: "example", endpoint: "http://localhost:1234/v1" }, sourceProfile: { soul: profile.soul } });
  expect(command.payload).not.toHaveProperty("apiKey");
  expect(command.payload.model).not.toHaveProperty("apiKey");
  expect(test.prepareProvider).toHaveBeenCalledWith("sage", row.executionId, row.model);
});

it("correlates workspace replies to the authenticated computer", async () => {
  const test = setup();
  const pending = test.driver.projects("sage", "remote");
  const command = test.commands.find((frame) => frame.command === "list_chat_projects")!;
  const result = { kind: "chat_workspace_result" as const, requestId: command.payload.requestId, result: { projects: [{ id: "app", name: "App", isGitRepository: true }] } };
  test.frame("intruder", result);
  test.frame("remote", result);
  await expect(pending).resolves.toEqual(result.result.projects);
});

it("rejects forged lifecycle receipts and does not restore deleted source sessions", async () => {
  const test = setup();
  const sessionId = test.storage.nativeBotChat("sage", 1).sessionId;
  await test.driver.prepareContext({ bot: "sage", sessionId, workspace, model: null });
  const row = test.storage.chatExecution("sage", sessionId)!;
  const receipt = { kind: "chat_execution_receipt" as const, operationId: row.operationId, executionId: row.executionId, botId: row.bot, sessionId, stage: "failed" as const };
  test.frame("intruder", receipt);
  expect(test.storage.chatExecutionById(row.executionId)?.stage).toBe("ready");
  test.storage.purgeBot("sage");
  test.connection("remote", { kind: "hello", version: 1, runnerId: "remote", backends: ["process"] });
  expect(test.tokens.has(row.token)).toBe(false);
  expect(test.commands.at(-1)?.command).toBe("delete_chat_execution");
});

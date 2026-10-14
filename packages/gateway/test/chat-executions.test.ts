import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

const workspace = { computerId: "computer", projectId: "project", mode: "worktree" as const, branch: "main" };

describe("chat execution persistence", () => {
  it("keeps historical identities and chooses the newest non-deleted execution for one session", () => {
    const storage = openStorage(":memory:");
    storage.saveChatExecution({
      executionId: "execution-1", bot: "sage", sessionId: "session", runnerId: "runner-a",
      token: "private-token-a", operationId: "operation-a", workspace,
      model: { providerId: "custom-provider", modelId: "model" },
      sourceProfile: { soul: "Profile prompt" },
      launchModel: { provider: "custom-provider", endpoint: "https://example.test/v1", id: "model" },
      stage: "failed", createdAt: 1,
    });
    storage.saveChatExecution({
      executionId: "execution-2", bot: "sage", sessionId: "session", runnerId: "runner-b",
      token: "private-token-b", operationId: "operation-b", workspace, stage: "starting", createdAt: 2,
    });
    expect(storage.chatExecution("sage", "session")).toMatchObject({ executionId: "execution-2", stage: "starting" });
    storage.setChatExecutionStage("execution-2", "deleted");
    expect(storage.chatExecution("sage", "session")).toMatchObject({ executionId: "execution-1", stage: "failed" });
    expect(storage.chatExecutionById("execution-2")).toMatchObject({ token: "private-token-b", stage: "deleted" });
    expect(storage.chatExecutionById("execution-1")).toMatchObject({
      model: { providerId: "custom-provider", modelId: "model" },
      launchModel: { provider: "custom-provider", endpoint: "https://example.test/v1", id: "model" },
    });
    storage.close();
  });

  it("does not mutate an existing execution identity when a duplicate save arrives", () => {
    const storage = openStorage(":memory:");
    storage.saveChatExecution({
      executionId: "execution", bot: "sage", sessionId: "session", runnerId: "runner-a",
      token: "token-a", operationId: "operation-a", workspace, stage: "starting", createdAt: 1,
    });
    storage.saveChatExecution({
      executionId: "execution", bot: "luna", sessionId: "other", runnerId: "runner-b",
      token: "token-b", operationId: "operation-b", workspace: { ...workspace, mode: "direct" }, stage: "ready", createdAt: 2,
    });
    expect(storage.chatExecutionById("execution")).toMatchObject({
      bot: "sage", sessionId: "session", runnerId: "runner-a", token: "token-a", operationId: "operation-a", stage: "starting",
    });
    storage.close();
  });
});

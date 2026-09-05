import { describe, expect, it } from "vitest";
import type { ChatConfigurationDriver } from "../src/chat-configuration.ts";

import {
  ChatConfigurationStaleSession,
  ChatConfigurationTurnActive,
  ChatConfigurationWorkspaceLocked,
  GatewayChatConfiguration,
} from "../src/chat-configuration.ts";
import { openStorage } from "../src/storage.ts";

const workspace = { computerId: "mac", projectId: "cozychat", mode: "worktree" as const, branch: "codex/chat" };
const driver: ChatConfigurationDriver = {
  availability: async () => ({ available: true }),
  computers: async () => [{ id: "mac", name: "Kyle's Mac", isAvailable: true }],
  projects: async () => [{ id: "cozychat", name: "CozyChat", isGitRepository: true, currentBranch: "main" }],
  branches: async () => [{ name: "main", isCurrent: true }],
  prepareContext: async () => ({ workspacePrepared: true }),
};

describe("chat configuration session persistence", () => {
  it("skips untouched legacy chats but prepares an explicit return to defaults", async () => {
    const storage = openStorage(":memory:");
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    const prepared: unknown[] = [];
    const service = new GatewayChatConfiguration({ storage, driver: { ...driver, prepareContext: async (input) => {
      prepared.push(input); return { workspacePrepared: false };
    } } });
    await service.prepareContext("sage", sessionId);
    service.recordAcceptedTurn("sage", sessionId);
    await service.prepareContext("sage", sessionId);
    expect(prepared).toEqual([]);
    await service.configure("sage", { sessionId, model: { providerId: "openai", modelId: "override" } });
    await service.prepareContext("sage", sessionId);
    await service.configure("sage", { sessionId, model: null });
    await service.prepareContext("sage", sessionId);
    expect(prepared).toHaveLength(2);
    expect(prepared.at(-1)).toEqual({ bot: "sage", sessionId, workspace: null, model: null });
    storage.close();
  });
  it("refuses a preparation completed after reset even when the old session is retained", async () => {
    const storage = openStorage(":memory:");
    const first = storage.nativeBotChat("sage", 1).sessionId;
    const service = new GatewayChatConfiguration({ storage, driver: { ...driver, prepareContext: async () => {
      storage.resetNativeBotChat("sage", 3);
      return { workspacePrepared: true };
    } } });
    await service.configure("sage", { sessionId: first, workspace });
    await expect(service.prepareContext("sage", first)).rejects.toBeInstanceOf(ChatConfigurationStaleSession);
    expect(storage.nativeChatWorkspaceDefault("sage")).toBeNull();
    storage.close();
  });
  it("stores choices per selected session and rejects a stale-session write atomically", async () => {
    const storage = openStorage(":memory:");
    const first = storage.nativeBotChat("sage", 1).sessionId;
    const service = new GatewayChatConfiguration({ storage, driver, now: () => 2 });

    await service.configure("sage", { sessionId: first, workspace, model: { providerId: "openai", modelId: "gpt" } });
    const second = storage.resetNativeBotChat("sage", 3);
    await expect(service.configure("sage", { sessionId: first, model: null })).rejects.toBeInstanceOf(ChatConfigurationStaleSession);
    expect(storage.nativeChatConfiguration("sage", first)?.model).toEqual({ providerId: "openai", modelId: "gpt" });
    expect((await service.snapshot("sage")).configuration).toEqual({ sessionId: second, workspace: null, model: null });
    storage.close();
  });

  it("locks only the accepted session's workspace, while an idle model remains mutable", async () => {
    const storage = openStorage(":memory:");
    const session = storage.nativeBotChat("sage", 1).sessionId;
    const service = new GatewayChatConfiguration({ storage, driver, now: () => 2 });
    await service.configure("sage", { sessionId: session, workspace, model: { providerId: "openai", modelId: "gpt" } });
    service.recordAcceptedTurn("sage", session);
    await expect(service.configure("sage", { sessionId: session, workspace: { ...workspace, mode: "direct" } }))
      .rejects.toBeInstanceOf(ChatConfigurationWorkspaceLocked);
    await expect(service.configure("sage", { sessionId: session, model: { providerId: "openai", modelId: "gpt-next" } }))
      .resolves.toMatchObject({ canChangeWorkspace: false, canChangeModel: true });
    storage.setNativeBotTurn("sage", session, "turn", 3);
    await expect(service.configure("sage", { sessionId: session, model: null })).rejects.toBeInstanceOf(ChatConfigurationTurnActive);
    storage.close();
  });

  it("copies only a successfully prepared workspace into each new session", async () => {
    const storage = openStorage(":memory:");
    const first = storage.nativeBotChat("sage", 1).sessionId;
    const service = new GatewayChatConfiguration({ storage, driver, now: () => 2 });
    await service.configure("sage", { sessionId: first, workspace });
    await service.prepareContext("sage", first);
    const second = storage.resetNativeBotChat("sage", 3);
    expect(storage.nativeChatConfiguration("sage", second)?.workspace).toEqual(workspace);
    expect((await service.snapshot("sage")).defaults.workspace).toEqual(workspace);
    storage.close();
  });
});

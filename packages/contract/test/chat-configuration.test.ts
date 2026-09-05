import { describe, expect, it } from "vitest";

import {
  CHAT_CONFIGURATION_CAPABILITY_ID,
  CHAT_CONFIGURATION_CAPABILITY_VERSION,
  ChatSessionConfigurationPatchSchema,
  ChatSessionConfigurationSnapshotSchema,
  check,
} from "../src/index.ts";

describe("chat configuration contract", () => {
  it("pins the independent capability", () => {
    expect(CHAT_CONFIGURATION_CAPABILITY_ID).toBe("com.cozylabs.chat-configuration");
    expect(CHAT_CONFIGURATION_CAPABILITY_VERSION).toBe(1);
  });

  it("accepts a bounded credential-free session snapshot", () => {
    expect(check(ChatSessionConfigurationSnapshotSchema, {
      configuration: { sessionId: "native:sage:1", workspace: null, model: { providerId: "openai", modelId: "gpt" } },
      defaults: { workspace: { computerId: "mac", projectId: "cozychat", mode: "worktree", branch: "codex/chat" } },
      canChangeWorkspace: true,
      canChangeModel: true,
      computers: [{ id: "mac", name: "Kyle's Mac", isAvailable: true }],
    })).toBe(true);
    expect(check(ChatSessionConfigurationSnapshotSchema, {
      configuration: { sessionId: "s", workspace: null, model: null }, defaults: { workspace: null },
      canChangeWorkspace: true, canChangeModel: true, computers: [], path: "/private",
    })).toBe(false);
  });

  it("distinguishes an omitted patch field from an explicit clear", () => {
    expect(check(ChatSessionConfigurationPatchSchema, { sessionId: "s", model: null })).toBe(true);
    expect(check(ChatSessionConfigurationPatchSchema, { sessionId: "s", workspace: { computerId: "c", projectId: "p", mode: "direct", extra: true } })).toBe(false);
  });
});

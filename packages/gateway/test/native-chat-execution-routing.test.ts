import { describe, expect, it, vi } from "vitest";

import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame } from "../src/adapters/attach/protocol-v1.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import { openStorage } from "../src/storage.ts";

describe("native chat execution peer routing", () => {
  it("sends a bound session only to its execution peer and refuses both cross-session and source-peer events", async () => {
    const storage = openStorage(":memory:");
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    storage.saveChatExecution({
      executionId: "execution", bot: "sage", sessionId, runnerId: "runner", token: "private",
      operationId: "operation", workspace: { computerId: "computer", projectId: "project", mode: "direct" }, stage: "ready", createdAt: 2,
    });
    const sendNativeTurn = vi.fn(() => true);
    const ingress = { sendNativeTurn, sendNativeSteer: vi.fn(() => true) } as unknown as AttachV1Ingress;
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage, ingress, nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined, now: () => 3,
    });
    await plane.surface().sendChatMessage("sage", "hello");
    expect(sendNativeTurn).toHaveBeenCalledWith("execution", expect.objectContaining({ threadId: sessionId }));
    const matching = { kind: "event", sequence: 1, eventId: "one", event: { kind: "failed", threadId: sessionId, turnId: "turn", messageId: "message", reason: "x" } } as unknown as AttachV1EventFrame;
    const other = { ...matching, event: { ...matching.event, threadId: "other" } } as AttachV1EventFrame;
    expect(plane.canAccept("execution", matching)).toBe(true);
    expect(plane.canAccept("execution", other)).toBe(false);
    expect(plane.canAccept("sage", matching)).toBe(false);
    plane.close(); storage.close();
  });

  it("keeps the execution peer for mobile transport while projecting the source bot to the app", async () => {
    const storage = openStorage(":memory:");
    const sessionId = storage.nativeBotChat("sage", 1).sessionId;
    storage.saveChatExecution({
      executionId: "execution", bot: "sage", sessionId, runnerId: "runner", token: "private",
      operationId: "operation", workspace: { computerId: "computer", projectId: "project", mode: "direct" }, stage: "ready", createdAt: 2,
    });
    const invoked = vi.fn();
    const plane = new NativeBotDataPlane({
      control: {} as BotsSurface, storage,
      ingress: { sendNativeTurn: () => true, sendNativeSteer: () => true } as unknown as AttachV1Ingress,
      nativeBots: ["sage"], chatSuggestion: "", broadcast: () => undefined,
      mobileNode: { invoke: invoked, reject: vi.fn() } as never, now: () => 3,
    });
    await plane.surface().sendChatMessage("sage", "hello");
    const turnId = storage.nativeBotChat("sage", 4).activeTurnId;
    if (turnId === undefined) throw new Error("expected active turn");
    plane.mobileRequest("execution", { kind: "mobile_request", requestId: "request", command: "device.status", threadId: sessionId, turnId, expiresAt: 100, purpose: "status" });
    expect(invoked).toHaveBeenCalledWith(expect.objectContaining({ bot: "sage", agentId: "execution" }));
    plane.close(); storage.close();
  });
});

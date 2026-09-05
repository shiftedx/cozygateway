/** Capability 62: `ApprovalEvent.repair` on attach-v1 (contract/ext-bots-v1.md row 62). A runtime
 *  peer that wants to reconnect one MCP server asks as an approval carrying one typed block. The
 *  gateway validates the block and carries it, unchanged, on the Bot Mode `bot_approval_pending`
 *  frame, the durable interaction row, the `GET /bots/approvals` inbox row, and the rebroadcast a
 *  reconnecting app gets; a block that fails validation is dropped while the approval is kept, and
 *  an approval that carries none is byte identical to its pre-62 self. */
import { describe, expect, it } from "vitest";
import type { BotApprovalPendingFrame, BotApprovalRepair, ServerFrame } from "cozygateway-contract";

import { NativeBotDataPlane } from "../src/hermes-bridge/native-data-plane.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import type { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

interface Harness {
  storage: Storage;
  plane: NativeBotDataPlane;
  frames: ServerFrame[];
  sessionId: string;
  turnId: string;
  close: () => void;
}

async function startTurn(): Promise<Harness> {
  const storage = openStorage(":memory:");
  const frames: ServerFrame[] = [];
  let now = 1_000;
  let sent: Record<string, unknown> | undefined;
  const ingress = {
    sendNativeTurn: (bot: string, input: Record<string, unknown>) => {
      sent = input;
      storage.enqueueAttachCommand(bot, "turn-command", { kind: "turn", ...input } as never, now);
      return true;
    },
    sendNativeInterrupt: () => true,
    sendApprovalResolution: () => true,
  } as unknown as AttachV1Ingress;
  const plane = new NativeBotDataPlane({
    control: {} as BotsSurface,
    storage,
    ingress,
    nativeBots: ["sage"],
    chatSuggestion: "",
    broadcast: (frame) => frames.push(frame),
    now: () => now++,
  });
  const accepted = await plane.surface().sendChatMessage("sage", "search my issues", {
    clientId: "client-1",
  });
  return {
    storage,
    plane,
    frames,
    sessionId: accepted.sessionId,
    turnId: String(sent?.turnId),
    close: () => {
      plane.close();
      storage.close();
    },
  };
}

function approvalEvent(
  sessionId: string,
  turnId: string,
  approvalId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    kind: "event" as const,
    sequence: 1,
    eventId: approvalId,
    event: {
      kind: "approval" as const,
      threadId: sessionId,
      turnId,
      approvalId,
      callId: "call-1",
      name: "mcp_reconnect",
      status: "pending" as const,
      ...extra,
    },
  };
}

function pendingFrames(frames: ServerFrame[]): BotApprovalPendingFrame[] {
  return frames.filter(
    (frame): frame is BotApprovalPendingFrame => frame.type === "bot_approval_pending",
  );
}

const repair: BotApprovalRepair = {
  kind: "mcp_reconnect",
  server: "github",
  impact: ["github_search_issues", "github_create_issue"],
  scope: "server",
  fingerprint: { previous: "sha256:1f3a", current: "sha256:9c0e" },
  reason: "stale_tool",
  policy: "approve_once",
};

describe("approval repair proposal (capability 62)", () => {
  it("reaches the live frame, the durable row, and the inbox row byte for byte", async () => {
    const harness = await startTurn();
    const { plane, storage, sessionId, turnId } = harness;

    expect(plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { repair }))).toBe(true);

    const pending = pendingFrames(harness.frames);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toolCallId: "approval-1", name: "mcp_reconnect" });
    expect(JSON.stringify(pending[0]!.repair)).toBe(JSON.stringify(repair));

    const row = storage.nativeInteraction("sage", "approval", "approval-1");
    expect(JSON.stringify((row?.payload as { repair?: unknown }).repair)).toBe(JSON.stringify(repair));

    const inbox = plane.surface().pendingApprovals();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ toolCallId: "approval-1", ruleName: "mcp_reconnect" });
    expect(JSON.stringify(inbox[0]!.repair)).toBe(JSON.stringify(repair));
    harness.close();
  });

  it("is carried on the rebroadcast so a reconnecting app sees what the live app saw", async () => {
    const harness = await startTurn();
    const { plane, sessionId, turnId } = harness;

    expect(plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1", { repair }))).toBe(true);
    const firstCount = pendingFrames(harness.frames).length;
    expect(firstCount).toBe(1);

    // A reconnecting app re-reads the chat, which rebroadcasts every still-pending interaction.
    await plane.surface().chatHistory("sage");

    const rebroadcast = pendingFrames(harness.frames).slice(firstCount);
    expect(rebroadcast).toHaveLength(1);
    expect(rebroadcast[0]!.toolCallId).toBe("approval-1");
    expect(JSON.stringify(rebroadcast[0]!.repair)).toBe(JSON.stringify(repair));
    harness.close();
  });

  it("drops an invalid block and keeps the approval: oversize impact entry, control character in server, unknown kind", async () => {
    const harness = await startTurn();
    const { plane, storage, sessionId, turnId } = harness;

    const invalid: Record<string, unknown> = {
      "approval-oversize": { ...repair, impact: ["t".repeat(129)] },
      // \u0000 (NUL, C0) inside the configured server name.
      "approval-control": { ...repair, server: "git\u0000hub" },
      "approval-kind": { ...repair, kind: "restart" },
    };
    for (const [approvalId, block] of Object.entries(invalid)) {
      expect(plane.handle("sage", approvalEvent(sessionId, turnId, approvalId, { repair: block }))).toBe(true);
    }

    const pending = pendingFrames(harness.frames);
    expect(pending.map((frame) => frame.toolCallId).sort()).toEqual(Object.keys(invalid).sort());
    for (const frame of pending) expect(frame).not.toHaveProperty("repair");
    for (const approvalId of Object.keys(invalid)) {
      expect(storage.nativeInteraction("sage", "approval", approvalId)?.payload).not.toHaveProperty("repair");
    }
    for (const row of plane.surface().pendingApprovals()) expect(row).not.toHaveProperty("repair");
    harness.close();
  });

  it("an approval that is not a repair proposal is byte identical to its pre-62 self everywhere", async () => {
    const harness = await startTurn();
    const { plane, storage, sessionId, turnId } = harness;

    expect(plane.handle("sage", approvalEvent(sessionId, turnId, "approval-1"))).toBe(true);
    await plane.surface().chatHistory("sage");

    const pending = pendingFrames(harness.frames);
    expect(pending).toHaveLength(2);
    for (const frame of pending) {
      expect(Object.keys(frame).sort()).toEqual(
        ["bot", "sessionId", "toolCallId", "turnId", "type", "name", "updatedAt"].sort(),
      );
    }
    expect(storage.nativeInteraction("sage", "approval", "approval-1")?.payload).toEqual({ name: "mcp_reconnect" });
    expect(Object.keys(plane.surface().pendingApprovals()[0]!).sort()).toEqual(
      ["bot", "sessionId", "turnId", "toolCallId", "ruleName", "createdAt"].sort(),
    );
    harness.close();
  });
});

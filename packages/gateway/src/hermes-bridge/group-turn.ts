import { randomUUID } from "node:crypto";

import type { BotGroupTurnRow, Storage } from "../storage.ts";

/** Existing attach-v1 `turn` command, narrowed to what a group room needs. Group code owns the
 * thread id; the adapter owns transport sequencing and replay. */
export interface NativeGroupTurnEndpoint {
  canQueue(agentId: string): boolean;
  sendNativeTurn(agentId: string, input: { threadId: string; turnId: string; messageId: string; text: string }): boolean;
}

export type GroupTurnResult =
  | { outcome: "spoke"; text: string }
  | { outcome: "pass" }
  | { outcome: "gone" }
  | { outcome: "timeout"; detail: string }
  | { outcome: "failed"; detail: string };

export interface StartNativeMemberTurn {
  storage: Storage;
  endpoint: NativeGroupTurnEndpoint;
  key: string;
  member: string;
  agentId: string;
  threadId: string;
  epoch: number;
  watermark: number;
  prompt: string;
  now: () => number;
}

/** Persists ownership BEFORE putting the command in the attach outbox. That ordering makes fast
 * events, reconnect replay, and a gateway restart address the same durable row. */
export function startNativeMemberTurn(input: StartNativeMemberTurn): { turnId: string; messageId: string } | GroupTurnResult {
  if (!input.endpoint.canQueue(input.agentId)) {
    return { outcome: "failed", detail: `native attach-v1 profile \"${input.agentId}\" is unavailable` };
  }
  const turnId = randomUUID();
  const messageId = `${turnId}:group`;
  if (!input.storage.beginBotGroupTurn({
    key: input.key, turnId, member: input.member, agentId: input.agentId, threadId: input.threadId,
    messageId, epoch: input.epoch, watermark: input.watermark, createdAt: input.now(),
  })) return { outcome: "failed", detail: "another member turn is already pending" };
  if (!input.endpoint.sendNativeTurn(input.agentId, { threadId: input.threadId, turnId, messageId, text: input.prompt })) {
    input.storage.completeBotGroupTurn(input.agentId, input.threadId, turnId, "failed", undefined, "native attach-v1 profile is unavailable", input.now());
    return { outcome: "failed", detail: "native attach-v1 profile is unavailable" };
  }
  return { turnId, messageId };
}

export function settledGroupTurn(row: BotGroupTurnRow): GroupTurnResult | undefined {
  switch (row.state) {
    case "pending": return undefined;
    case "commit": {
      const text = row.text?.trim() ?? "";
      return text.length === 0 ? { outcome: "pass" } : { outcome: "spoke", text };
    }
    case "timeout": return { outcome: "timeout", detail: row.detail ?? "no reply before deadline" };
    default: return { outcome: "failed", detail: row.detail ?? `member turn ${row.state}` };
  }
}

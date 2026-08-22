import type { BotGroupMessage, BotInboxThread } from "cozygateway-contract";

import type { SessionRow } from "./sessions.ts";
import type { ChatSnapshot } from "./chat-messages.ts";
import { classifyPreview } from "./roster.ts";

/** The shared session classifier already recognized the a2a prefix before this projection extracts
 * the counterpart and display text. */
export function inboxPeerAndPreview(preview: string | null): { peers: string[]; preview: string } {
  const classified = classifyPreview(preview, null);
  if (classified.kind !== "a2a") return { peers: [], preview: preview?.trim() ?? "" };
  return {
    peers: classified.sender === undefined ? [] : [classified.sender],
    preview: classified.text,
  };
}

export function inboxThread(row: SessionRow, messageCount: number): BotInboxThread {
  const projected = inboxPeerAndPreview(row.preview);
  return {
    id: row.id,
    peers: projected.peers,
    startedAt: row.startedAt,
    lastActiveAt: row.lastActiveAt,
    preview: projected.preview,
    messageCount,
  };
}

/** Projects a Hermes transcript into the group-room wire shape. An assistant row is the addressed
 *  bot speaking. An inbound user row carries Hermes' `Message from ...:` a2a prefix, whose sender
 *  becomes the member and whose protocol prefix is removed from the displayed text. */
export function inboxMessages(
  snapshot: ChatSnapshot,
  bot: string,
  displayNameOf: (name: string) => string,
): BotGroupMessage[] {
  return snapshot.messages.map((message, index) => {
    const delivery = message.role === "user" ? classifyPreview(message.text, null) : undefined;
    const peer = delivery?.kind === "a2a" ? delivery.sender : undefined;
    const speaker = peer ?? bot;
    const text = delivery?.kind === "a2a" ? delivery.text : message.text;
    return {
      seq: index + 1,
      from: { kind: "member", name: speaker, displayName: displayNameOf(speaker) },
      text,
      at: message.at ?? 0,
    };
  });
}

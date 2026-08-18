import type { BotChatMessage } from "cozygateway-contract";

/** Decoding one `session.resume` reply into a stable wire shape, defensively.
 *
 *  Hermes message shape drifts between builds and between the paths that wrote the message (a CLI
 *  turn, a cron run, a bot-to-bot delivery). The dissection (section 9.7) already documents three
 *  content shapes the desktop has to cope with, so everything here is tolerant by construction:
 *  an unrecognized field is ignored, an unrecognized message is dropped rather than thrown on, and
 *  a response missing `messages` entirely reads as "no messages", never as an error.
 *
 *  UNITS: everything leaving this module is MILLISECONDS. Hermes stamps messages in seconds on
 *  some builds, milliseconds on others, and not at all on the rest; `normalizeTimestamp` picks by
 *  magnitude, which is unambiguous for any date this century. */

/** Anything at or below this is read as seconds since the epoch, anything above as milliseconds.
 *  10^11 seconds is the year 5138, and 10^11 milliseconds is 1973, so no real stamp is ambiguous. */
const SECONDS_CEILING = 100_000_000_000;

export interface ChatSnapshot {
  /** The RUNTIME session id `prompt.submit` must be addressed to, when the reply carried one. */
  runtimeId: string | undefined;
  messages: BotChatMessage[];
  /** `message_count` when the reply carried one, else the decoded message count. */
  messageCount: number;
  running: boolean;
  inflight: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Milliseconds, or null when the message carries nothing usable. Accepts the field names Hermes
 *  builds have used (`at`, `ts`, `timestamp`, `time`, `created_at`, `created`) and numeric strings,
 *  because a JSON encoder somewhere upstream stringifies large integers. */
export function normalizeTimestamp(value: unknown): number | null {
  let raw: number | undefined;
  if (typeof value === "number") raw = value;
  else if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) raw = parsed;
    else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) return date;
    }
  }
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw <= SECONDS_CEILING ? raw * 1000 : raw);
}

const TIME_FIELDS = ["at", "ts", "timestamp", "time", "created_at", "created"] as const;

function messageTimestamp(message: Record<string, unknown>): number | null {
  for (const field of TIME_FIELDS) {
    const value = normalizeTimestamp(message[field]);
    if (value !== null) return value;
  }
  return null;
}

/** Flattens message content, per dissection 9.7: content may be a plain string, an array of parts
 *  (each a string, or an object carrying `text`/`content`), or absent with the text living on
 *  `msg.text`. Tool-call parts and other non-textual parts contribute nothing rather than
 *  `[object Object]`. */
export function extractMessageText(message: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length > 0) parts.push(value);
      return;
    }
    const record = asRecord(value);
    if (record === undefined) return;
    const text = record["text"] ?? record["content"] ?? record["value"];
    if (typeof text === "string" && text.length > 0) parts.push(text);
  };

  const content = message["content"];
  if (Array.isArray(content)) for (const part of content) push(part);
  else push(content);

  if (parts.length === 0) push(message["text"]);
  return parts.join("").trim();
}

/** Maps one raw message. Returns undefined for anything with neither a role nor any text, which is
 *  how a control record slipped into `messages` gets dropped instead of rendered as a blank
 *  bubble. `sessionId` and `index` only feed the synthesized id. */
export function mapChatMessage(
  raw: unknown,
  sessionId: string,
  index: number,
): BotChatMessage | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const role = typeof record["role"] === "string" && record["role"].length > 0 ? record["role"] : "assistant";
  const text = extractMessageText(record);
  const id = asId(record["id"]) ?? asId(record["message_id"]) ?? `${sessionId}#${index}`;
  if (text.length === 0 && record["role"] === undefined) return undefined;
  return { id, role, text, at: messageTimestamp(record) };
}

/** Decodes a `session.resume` reply. Never throws: a reply that is not an object at all reads as
 *  an empty, idle session, which is exactly what a lazily-created chat looks like before its first
 *  prompt lands. */
export function parseChatSnapshot(result: unknown, sessionId: string): ChatSnapshot {
  const record = asRecord(result);
  const rawMessages = Array.isArray(record?.["messages"]) ? (record["messages"] as unknown[]) : [];
  const messages: BotChatMessage[] = [];
  rawMessages.forEach((raw, index) => {
    const mapped = mapChatMessage(raw, sessionId, index);
    if (mapped !== undefined) messages.push(mapped);
  });
  const rawCount = record?.["message_count"];
  return {
    runtimeId: asId(record?.["session_id"]),
    messages,
    // The count is the gateway's own, when it sends one: `omit_messages: true` replies carry the
    // count and no messages, and that is the cheap baseline a turn poll diffs against.
    messageCount:
      typeof rawCount === "number" && Number.isFinite(rawCount) ? Math.max(0, Math.round(rawCount)) : rawMessages.length,
    running: record?.["running"] === true,
    inflight: record?.["inflight"] === true,
  };
}

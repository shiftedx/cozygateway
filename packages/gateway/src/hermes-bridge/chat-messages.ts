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

/** The lines hermes writes into its OWN persisted user row when an image is attached to a turn, and
 *  which must never reach a device.
 *
 *  Proven live on 0.20.4: after `image.attach_bytes` plus `prompt.submit`, `session.resume` hands
 *  back a user row whose text is the caption followed by
 *  `@image:/Users/<operator>/.hermes/profiles/<bot>/images/upload_....png` and a `[screenshot]`
 *  marker. Those are directives for hermes' own re-read of the transcript, not conversation, and
 *  shipping them raw would put an absolute path on the operator's machine into every paired device's
 *  chat history: ugly, and a small standing disclosure of the box's filesystem layout and the
 *  operator's account name.
 *
 *  `[Image attached at: <path>]` and `[User attached image: <name>]` are the same class of artifact
 *  produced by the other two paths that can write an image into a turn (the native content-parts
 *  builder's text hint, and the attach RPC's own confirmation text), so they go the same way.
 *
 *  The strip is deliberately anchored to whole lines and to these exact prefixes. A looser rule (any
 *  line mentioning a path, say) would eat conversation, and conversation is the thing this module
 *  exists to preserve. */
const IMAGE_DIRECTIVE_RE =
  /^(?:@image:.*|\[screenshot\]|\[Image attached at: .*\]|\[User attached image: .*\])$/;

/** Removes those lines and nothing else. Exported because it is the whole of the "no host path may
 *  ever reach a device" guarantee, and a guarantee that can only be exercised through a socket is one
 *  that does not get tested. */
export function stripImageDirectives(text: string): string {
  if (!text.includes("@image:") && !text.includes("[screenshot]") && !text.includes("[Image attached at:") && !text.includes("[User attached image:")) {
    return text;
  }
  return text
    .split("\n")
    .filter((line) => !IMAGE_DIRECTIVE_RE.test(line.trim()))
    .join("\n")
    .trim();
}

/** The only two roles that reach a chat bubble. Everything else in a Hermes transcript is turn
 *  machinery: a `system` prompt, a `tool` result, and an assistant message whose content is a bare
 *  `tool_use` part all belong to the turn, not to the conversation. The desktop consumer this is
 *  modelled on walks back to the last `role === "assistant"` message precisely so that chatter
 *  never surfaces (dissection 9.7), and the phone has no other filter in front of it. */
const RENDERED_ROLES = new Set(["user", "assistant"]);

/** Maps one raw message, or drops it. A row is dropped when it is not an object, when its role is
 *  not one a chat renders, or when it has no text at all (a tool-call-only assistant turn), which
 *  is what keeps tool chatter and blank bubbles out of the app entirely. `sessionId` and `index`
 *  only feed the synthesized id, and `index` is the raw index so ids stay stable across polls even
 *  though rows in between are dropped. */
export function mapChatMessage(
  raw: unknown,
  sessionId: string,
  index: number,
): BotChatMessage | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const rawRole = typeof record["role"] === "string" ? record["role"].trim().toLowerCase() : "";
  const role = rawRole.length > 0 ? rawRole : "assistant";
  if (!RENDERED_ROLES.has(role)) return undefined;
  // User rows only, and that scoping matters. These directives are written by hermes into the row it
  // persists for a turn the USER sent, so a user row carrying one is machinery. An assistant that
  // writes `/Users/kyle/out.png` into its reply is writing prose about a file it made, which is the
  // very thing `GET /bots/:name/media` refuses to fetch and the app renders as a chip, and editing it
  // out of the bot's own words would be rewriting the conversation.
  const flattened = extractMessageText(record);
  const text = role === "user" ? stripImageDirectives(flattened) : flattened;
  if (text.length === 0) return undefined;
  // `row_id` is what a live 0.20.4 dashboard actually stamps on a transcript row (rows there carry
  // `role`, `text`, `timestamp` and `row_id`, and no `id` at all). Reading it is worth more than
  // tidiness: it is a REAL identity, so the anchors that ride on message ids survive a compaction,
  // where the synthesized `<session>#<index>` fallback is renumbered by one.
  const id =
    asId(record["id"]) ?? asId(record["message_id"]) ?? asId(record["row_id"]) ?? `${sessionId}#${index}`;
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
    // Compared against `true` rather than coerced: a live 0.20.4 dashboard sends `inflight: null`
    // on an idle session and omits the key entirely on an `omit_messages` reply, and both of those
    // mean "not in flight".
    running: record?.["running"] === true,
    inflight: record?.["inflight"] === true,
  };
}

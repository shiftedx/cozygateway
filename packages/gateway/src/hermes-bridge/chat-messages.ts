import type { BotChatMessage } from "cozygateway-contract";

import { chatRowFingerprint, syntheticChatId } from "./chat-identity.ts";

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

/** The one-line replacement for Hermes context-management rows. The marker is deliberately plain
 *  text and needs no capability bump: old clients render one short line, while clients that know
 *  the convention may render it as a compact chip. */
export const CONTEXT_COMPACTION_MARKER = "[[context: compacted]]";

const CONTEXT_COMPACTION_HEADER_RE =
  /^\[CONTEXT COMPACTION [-\u2013\u2014] REFERENCE ONLY\]$/;
const PRIOR_CONTEXT_HEADER_RE =
  /^\[PRIOR CONTEXT [-\u2013\u2014] for reference only; not a new message\]$/;
const PRIOR_CONTEXT_SUMMARY_RE =
  /^\[END OF PRIOR CONTEXT [-\u2013\u2014] COMPACTION SUMMARY BELOW\]$/;
const CONTEXT_SUMMARY_BEGIN_RE = /^--- BEGIN(?: OF)? CONTEXT SUMMARY(?: ---)?$/;
const CONTEXT_SUMMARY_END_RE = /^--- END(?: OF)? CONTEXT SUMMARY(?: ---)?$/;
const SKILL_PRUNED_RE =
  /^\[SKILL_PRUNED: content lost in compression; reload with skill_view\(name=[^)]+\)\]$/;

/** Recognizes only whole Hermes context-management rows from the live corpus. A marker pasted
 *  after ordinary prose is not a match, nor is a bare SKILL_PRUNED line: shapes without a complete
 *  sentinel boundary pass through because conversation wins when the evidence is ambiguous. */
export function isContextCompactionText(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const first = lines[0] ?? "";
  const nextNonEmpty = lines.slice(1).find((line) => line.trim().length > 0)?.trim() ?? "";
  const last = lines.at(-1) ?? "";
  if (CONTEXT_COMPACTION_HEADER_RE.test(first)) return true;
  if (PRIOR_CONTEXT_HEADER_RE.test(first) && PRIOR_CONTEXT_SUMMARY_RE.test(nextNonEmpty)) return true;
  const closedSummary = CONTEXT_SUMMARY_END_RE.test(last);
  if (CONTEXT_SUMMARY_BEGIN_RE.test(first) && closedSummary) return true;
  return SKILL_PRUNED_RE.test(first) && closedSummary;
}

export function isContextCompactionMarker(message: Pick<BotChatMessage, "text">): boolean {
  return message.text === CONTEXT_COMPACTION_MARKER;
}

/** The only two roles that reach a chat bubble. Everything else in a Hermes transcript is turn
 *  machinery: a `system` prompt, a `tool` result, and an assistant message whose content is a bare
 *  `tool_use` part all belong to the turn, not to the conversation. The desktop consumer this is
 *  modelled on walks back to the last `role === "assistant"` message precisely so that chatter
 *  never surfaces (dissection 9.7), and the phone has no other filter in front of it. */
const RENDERED_ROLES = new Set(["user", "assistant"]);

/** One decoded row, before it has been given an identity. A row the backend named carries that name
 *  in `id`; a row it did not carries `undefined`, and the caller mints one. */
interface DecodedRow {
  id: string | undefined;
  role: string;
  text: string;
  at: number | null;
}

/** Decodes one raw message, or drops it. A row is dropped when it is not an object, when its role is
 *  not one a chat renders, or when it has no text at all (a tool-call-only assistant turn), which
 *  is what keeps tool chatter and blank bubbles out of the app entirely. */
function decodeChatRow(raw: unknown): DecodedRow | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const rawRole = typeof record["role"] === "string" ? record["role"].trim().toLowerCase() : "";
  const role = rawRole.length > 0 ? rawRole : "assistant";
  const flattened = extractMessageText(record);
  const compaction =
    (role === "user" || role === "assistant" || role === "system") &&
    isContextCompactionText(flattened);
  if (!compaction && !RENDERED_ROLES.has(role)) return undefined;
  // User rows only, and that scoping matters. These directives are written by hermes into the row it
  // persists for a turn the USER sent, so a user row carrying one is machinery. An assistant that
  // writes `/Users/kyle/out.png` into its reply is writing prose about a file it made, which is the
  // very thing `GET /bots/:name/media` refuses to fetch and the app renders as a chip, and editing it
  // out of the bot's own words would be rewriting the conversation.
  const renderedRole = role === "system" ? "assistant" : role;
  const text = compaction
    ? CONTEXT_COMPACTION_MARKER
    : renderedRole === "user"
      ? stripImageDirectives(flattened)
      : flattened;
  if (text.length === 0) return undefined;
  // `row_id` is what a live 0.20.4 dashboard actually stamps on a transcript row (rows there carry
  // `role`, `text`, `timestamp` and `row_id`, and no `id` at all).
  const id = asId(record["id"]) ?? asId(record["message_id"]) ?? asId(record["row_id"]);
  return { id, role: renderedRole, text, at: messageTimestamp(record) };
}

/** Maps one raw message, or drops it. The single-row form of `parseChatSnapshot`'s decode, so a row
 *  with no id of its own is given the FIRST synthesized identity for its content. Used where one raw
 *  row is decoded on its own; a whole transcript goes through `parseChatSnapshot`, which counts
 *  repeated content and is the only thing that can number it. */
export function mapChatMessage(raw: unknown, sessionId: string): BotChatMessage | undefined {
  const row = decodeChatRow(raw);
  if (row === undefined) return undefined;
  return {
    id: row.id ?? syntheticChatId(sessionId, row.role, row.text, 0),
    role: row.role,
    text: row.text,
    at: row.at,
  };
}

/** Gives an identity to a decoded transcript, in order.
 *
 *  A row the backend named keeps that name. A row it did not is given a CONTENT-derived id
 *  (cozygateway#87): the raw index it used to carry moves under it the moment a compaction trims the
 *  head of the transcript, and a renamed row is a row every client re-renders as a second bubble.
 *  Repeated content is numbered by how many earlier unnamed rows carry the same words, so two
 *  identical lines are still two identities. */
function identify(rows: DecodedRow[], sessionId: string): BotChatMessage[] {
  const ordinals = new Map<string, number>();
  return rows.map((row) => {
    if (row.id !== undefined) return { id: row.id, role: row.role, text: row.text, at: row.at };
    const key = chatRowFingerprint(row.role, row.text);
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    return {
      id: syntheticChatId(sessionId, row.role, row.text, ordinal),
      role: row.role,
      text: row.text,
      at: row.at,
    };
  });
}

/** Decodes a `session.resume` reply. Never throws: a reply that is not an object at all reads as
 *  an empty, idle session, which is exactly what a lazily-created chat looks like before its first
 *  prompt lands.
 *
 *  `identity`, when a caller passes one, is what makes an id survive a transcript the backend
 *  RE-BASED under it: the ledger hands back the id each row was first delivered under. A caller that
 *  passes none gets the content-derived ids, which already survive everything but a compaction that
 *  trims one copy of a repeated line. */
export function parseChatSnapshot(
  result: unknown,
  sessionId: string,
  identity?: { assign(sessionId: string, messages: BotChatMessage[]): BotChatMessage[] },
): ChatSnapshot {
  const record = asRecord(result);
  const rawMessages = Array.isArray(record?.["messages"]) ? (record["messages"] as unknown[]) : [];
  const rows: DecodedRow[] = [];
  for (const raw of rawMessages) {
    const decoded = decodeChatRow(raw);
    if (decoded !== undefined) rows.push(decoded);
  }
  const identified = identify(rows, sessionId);
  const messages = identity === undefined ? identified : identity.assign(sessionId, identified);
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

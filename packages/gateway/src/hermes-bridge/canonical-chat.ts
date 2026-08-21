/** The canonical "Bot Chat": every bot has ONE forever chat, pinned by stored-session id, and
 *  opening a bot always lands there (dissection section 5). This module reimplements the desktop
 *  plugin's resolve-or-create and its three pin-adoption paths server-side, so every device sees
 *  the same chat and a phone that never ran the desktop still lands in the right session.
 *
 *  One byte-compatible convention that must not drift: the title is exactly `Bot Chat`.
 *
 *  A new chat is born EMPTY, and nothing is ever submitted into it on the user's behalf (ext-bots
 *  capability 11, issue #59). Up to capability 10 the mint submitted a canned opener -- the desktop's
 *  "kickoff prompt" -- which the app then rendered as a message the USER had sent, and which the bot
 *  answered before the user had typed anything. The user's own input is the only thing this gateway
 *  ever submits in a conversation; the opener survives as `DEFAULT_CHAT_SUGGESTION`, offered to the
 *  client as text it MAY show and the user MAY choose to send.
 *
 *  The cost of that, paid deliberately: `session.create` persists NO database row until the first
 *  prompt (dissection 14.5), so a chat nobody has written to is invisible to `session.list` and
 *  cannot be resumed -- indefinitely, not for the couple of seconds a kickoff used to take. Two
 *  things carry the gateway across that gap and both are durable rather than in-memory: the pin
 *  (`bot_chat_pins.session_id`), which is why an empty session list never means "this bot has no
 *  chat", and the RUNTIME id (`bot_chat_pins.runtime_id`), which is the only id `prompt.submit`
 *  accepts for a session that has no row yet. See `Storage.setBotChatRuntimeId`.
 *
 *  The pin FOLLOWS the bot's latest conversational session (issue #88). It is not a one-time
 *  adoption: when a newer conversation than the pinned one shows up in `session.list`, the pin moves
 *  to it and the caller announces the move. See `isConversationalSession` for what "conversation"
 *  means here and `resolvePin` for the guards. */

import { A2A_RE } from "./roster.ts";
import { effectiveChatPin, followLatestChatPin } from "./chat-pin.ts";

/** The session title the Hermes prompt builder gates its bot-mode protocol injection on. Exact
 *  match, including case. */
export const CANONICAL_CHAT_TITLE = "Bot Chat";

/** The opener an empty bot chat OFFERS. Word for word the message the desktop plugin (and this
 *  gateway, up to capability 10) used to submit by itself, kept identical so a returning user is
 *  offered the line they recognize.
 *
 *  Presentation only. Nothing in this package submits it: a client may show it, the user may send it
 *  as their own message, and until they do it is not part of the conversation. */
export const DEFAULT_CHAT_SUGGESTION = "Hey, tell me about yourself!";

/** How the returned session id was arrived at. Surfaced for observability and tests, and cheap
 *  for the app to ignore. */
export type ChatAdoption =
  /** The existing pin was still valid. */
  | "pin"
  /** First open of a bot with history: adopted the session carrying the canonical title. */
  | "title"
  /** The newest CONVERSATIONAL session. Two ways to arrive here, and they are the same rule seen at
   *  two moments: the first open of a bot with history and no canonical title, and a later open
   *  where a newer conversation than the pinned one has appeared (issue #88), which RE-ADOPTS. */
  | "latest"
  /** The pinned id vanished (compaction rewrote the lineage): re-pinned the newest session. */
  | "recovery"
  /** No sessions existed: created one. It is EMPTY, and stays empty until the user writes to it. */
  | "created";

export interface CanonicalChatResult {
  sessionId: string;
  adoption: ChatAdoption;
  /** The RUNTIME session id, when this call is the one that created the chat. `prompt.submit` only
   *  accepts the runtime id (dissection 1.2 row 11) and it is a DIFFERENT value from the stored id
   *  that gets pinned; a chat with no persisted row cannot be resumed, so this is the only way to
   *  learn it. Absent for every adoption path other than `created`. */
  runtimeId?: string;
  /** The session the pin pointed at immediately before this call MOVED it, present ONLY on a
   *  re-adoption (issue #88): a pin that already resolved, and that a newer conversational session
   *  outran. The caller announces the move on the socket so paired devices rebind and re-read.
   *
   *  Deliberately not set on the first-adoption paths (`title`, `latest` from no pin, `recovery`,
   *  `created`). Those answer "which session IS this bot's chat" for a client that did not have one;
   *  a re-adoption answers "the chat you are holding is no longer it", which is the only case where
   *  a device already on screen has to be told something. */
  previousSessionId?: string;
}

export interface HermesRpc {
  /** `opts.timeoutMs` bounds this one call, overriding the client-wide default. */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/** The local pin store. Backed by SQLite in production; a plain map in tests. */
export interface PinStore {
  get(name: string): string | undefined;
  set(name: string, sessionId: string): void;
  /** The durable local pin metadata used by capability 16. `manualSince` is the instant a user
   *  explicitly selected this session. It applies only while the local and effective pins agree. */
  entry?(name: string): { sessionId: string; manual: boolean; updatedAt: number } | undefined;
  clear(name: string): void;
}

export interface SessionRow {
  id: string;
  title: string;
  preview: string | null;
  source: string | null;
  /** Milliseconds. Zero means the Hermes build did not expose this timestamp. */
  startedAt: number;
  /** Milliseconds. Zero means the Hermes build did not expose this timestamp. */
  lastActiveAt: number;
  /** Hermes' session-list count, normalized to a non-negative integer. */
  messageCount?: number;
}

export type BotSessionKind = "conversation" | "cron" | "routine" | "group" | "a2a";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Hermes timestamps have appeared as seconds, milliseconds, and numeric strings. Capability 16
 *  normalizes every usable form to integer milliseconds and uses zero when an older Hermes omits
 *  the field entirely. */
function sessionTime(item: Record<string, unknown>, fields: readonly string[]): number {
  for (const field of fields) {
    const raw = item[field];
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < 0) continue;
    return Math.round(value < 1_000_000_000_000 ? value * 1000 : value);
  }
  return 0;
}

function sessionMessageCount(item: Record<string, unknown>): number {
  const raw = item["message_count"];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/** Decodes a `session.list` response tolerantly. Rows without a usable id are dropped; the order
 *  the gateway returned (newest first, by convention) is preserved, since the adoption rules index
 *  into it.
 *
 *  "Newest first" remains a convention this gateway observes and cannot verify. Newer Hermes
 *  builds also expose creation and activity stamps; older builds do not, so their normalized value
 *  is zero rather than an invented time. */
export function parseSessionList(result: unknown): SessionRow[] {
  const record = asRecord(result);
  const rows = Array.isArray(record?.["sessions"]) ? (record["sessions"] as unknown[]) : [];
  const parsed: SessionRow[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (item === undefined) continue;
    const rawId = item["id"];
    if (typeof rawId !== "string" && typeof rawId !== "number") continue;
    const id = String(rawId);
    if (id.length === 0) continue;
    parsed.push({
      id,
      title: typeof item["title"] === "string" ? item["title"] : "",
      preview: typeof item["preview"] === "string" ? item["preview"] : null,
      source: typeof item["source"] === "string" ? item["source"] : null,
      startedAt: sessionTime(item, ["started_at", "created_at", "started", "created"]),
      lastActiveAt: sessionTime(item, [
        "last_active",
        "last_active_at",
        "updated_at",
        "lastActiveAt",
        "updated",
      ]),
      messageCount: sessionMessageCount(item),
    });
  }
  return parsed;
}

/** Titles that name a session belonging to a machine, not to the user's conversation with this bot.
 *  Both are conventions this gateway and the desktop write themselves, so matching on them is
 *  matching on our own output rather than guessing at a user's title. */
const ROUTINE_TITLE_PREFIX = "Routine: ";
const GROUP_TITLE_PREFIX = "Group: ";

/** Whether a session is one the ROSTER PREVIEW would present as a conversation, which is exactly
 *  the set the canonical chat may follow (issue #88). One rule, four exclusions, and each exclusion
 *  is a session kind whose transcript would be wrong to open when the user taps the bot:
 *
 *  - **cron**, by `source` and by the `cron_<job_id>_<timestamp>` id shape. Every routine fire mints
 *    its own session DELIBERATELY (contract/ext-bots-v1.md, "Where a routine's runs land"), so a
 *    bot with an hourly routine would otherwise re-adopt away from the user's conversation once an
 *    hour and hand them a machine transcript. The id shape is checked as well as the source because
 *    `source` is `string | null` on this wire and a hermes that omits it must not defeat the rule.
 *  - **delegated routine runs**, titled `Routine: <title>`. Same fires, different delivery: when the
 *    routine's bot is not the profile the gateway's own hermes runs as, the run is delegated with
 *    `hermes -p <bot> chat -c "Routine: <title>"`, which lands in the bot's own history with source
 *    `cli` rather than `cron`. Excluding only `source: cron` would have caught one half of routines
 *    and missed the other.
 *  - **group rooms**, titled `Group: <name>`. A room member's session is the room's half of a
 *    multi-bot conversation, and re-adopting it would splice room traffic (other members' lines,
 *    the room protocol prompt) into the 1:1 chat the user opened.
 *  - **bot-to-bot deliveries**, recognized on the preview by the same regex the roster classifies
 *    them with. The preview renders these as `kind: "a2a"` and not as plain conversation, so by the
 *    rule above they cannot move the pin.
 *
 *  Everything else counts, including a session with no title and no source: the point of the rule is
 *  that a conversation held from a SECOND DEVICE (a desktop, the CLI) becomes the bot's chat, and
 *  those sessions carry whatever title that client gave them. The exclusions are the closed list;
 *  conversation is the default. */
export function sessionKind(row: SessionRow): BotSessionKind {
  const source = row.source?.trim().toLowerCase();
  if (source === "cron" || row.id.startsWith("cron_")) return "cron";
  if (row.title.startsWith(ROUTINE_TITLE_PREFIX)) return "routine";
  if (row.title.startsWith(GROUP_TITLE_PREFIX)) return "group";
  if (row.preview !== null && A2A_RE.test(row.preview.trim())) return "a2a";
  return "conversation";
}

export function isConversationalSession(row: SessionRow): boolean {
  return sessionKind(row) === "conversation";
}

/** The settled-message push gate: the id must still name a listed conversational session. Using
 *  the shared classifier here keeps cron, routine, group and a2a exclusions identical to pin
 *  adoption and roster preview behavior. */
export function isConversationalSessionId(rows: readonly SessionRow[], sessionId: string): boolean {
  const row = rows.find((candidate) => candidate.id === sessionId);
  return row !== undefined && isConversationalSession(row);
}

export interface CanonicalChatDeps {
  rpc: HermesRpc;
  pins: PinStore;
  /** New canonical chats are born hidden so they do not clutter the global Sessions list. The
   *  desktop defaults this to true; older gateways ignore the unknown param harmlessly. */
  hideBotChats: boolean;
  /** The pin the server's own `ui_meta` carries for this bot. Three-valued, and the difference
   *  matters: a string is the server's pin, `null` is the server saying the pin is CLEARED (the
   *  desktop's `saveBotMeta(name, {chat: null})`, dissection 3.2), and `undefined` is the server
   *  knowing nothing at all. Only `undefined` falls back to the local pin; a `null` clear is
   *  authoritative and must not be resurrected from cache. */
  serverPin?: string | null;
  /** Pushes the resolved pin into the server's `ui_meta`, the desktop's `saveBotMeta(name, {chat})`
   *  (dissection 3.1). Called only when the resolved pin differs from what the server already
   *  carries, and NEVER allowed to fail the resolve: a gateway too old to store `ui_meta` still
   *  gets a working chat, it just keeps the pin gateway-local. Without this writeback the server
   *  never learns the phone's chat, and every later open has to re-derive it, which is how a
   *  duplicate chat gets minted for a chat that has no listable row yet. */
  saveServerPin?: (sessionId: string) => Promise<void>;
  /** Throws when `name` is no longer a profile on this gateway, checked FRESH. Called on one path
   *  only: immediately before a chat is MINTED, because `session.create` is where an unknown name
   *  stops being a 404 and starts being a new profile (Hermes 0.20.x auto-creates one). The caller's
   *  own unknown-bot guard is cache-first by design, which is right for a read but is a snapshot,
   *  and a snapshot is exactly what a bot deleted seconds ago is still in.
   *
   *  Nothing to check on the adopt paths: those resolve a session that already exists. */
  assertStillExists?: () => Promise<void>;
  /** True when `sessionId` is a chat a RESET already retired for this bot, and therefore a session
   *  the user asked to leave behind.
   *
   *  Passed in rather than read from storage here on purpose: this module speaks to `rpc` and `pins`
   *  and nothing else, and that narrowness is what makes it testable with two plain objects. The
   *  bridge owns the durable set (`Storage.botChatRetired`).
   *
   *  It exists because a reset mints the replacement chat with the SAME title as the one it retires,
   *  which is deliberate (a reset chat has to be byte-compatible with a resolved one) and which makes
   *  the two adoption heuristics below ambiguous by construction: after N resets a bot has N+1
   *  sessions titled `Bot Chat` and only the pin says which is live. Lose the pin, which is reachable
   *  because `saveServerPin` is allowed to fail silently, and adoption would pick one by title or by
   *  position and could hand the user back the very conversation they cleared. A retired id is
   *  therefore never a candidate, wherever it sorts.
   *
   *  Defaults to "nothing is retired", which is the correct answer for a caller that has never reset
   *  a chat and keeps every existing test honest. */
  isRetired?: (sessionId: string) => boolean;
  /** True when `sessionId` is the current gateway-minted chat whose first prompt has not persisted
   *  yet. Such a chat has no `session.list` row, even when older sessions do, so a missing pin is
   *  not compaction evidence. The pin holds until a conversational session with a creation time
   *  after the pin appears, which preserves follow-latest for genuinely new conversations. */
  isUnwritten?: (sessionId: string) => boolean;
  /** How many sessions to consider when adopting. The desktop uses 100. */
  listLimit?: number;
}

export async function listBotSessions(rpc: HermesRpc, name: string, limit: number): Promise<SessionRow[]> {
  return parseSessionList(await rpc.request("session.list", { profile: name, limit }));
}

/** Creates the canonical chat: check the bot is still there, `session.create` for the ids, pin the
 *  STORED one, and stop. Nothing is submitted (capability 11), so the caller receives an empty chat
 *  and the RUNTIME id it will need to address the user's first message, because a session with no
 *  persisted row cannot be resumed and `prompt.submit` accepts nothing else.
 *
 *  The caller MUST record that runtime id durably (`HermesBridge.#rememberUnwritten`). This function
 *  cannot do it: it speaks to `rpc` and `pins` and nothing else, which is what keeps it testable with
 *  two plain objects.
 *
 *  Exported because there are TWO ways a chat gets minted, and they must mint it identically or a
 *  reset chat would not be byte-compatible with a resolved one: `resolveCanonicalChat` below, which
 *  mints only when a bot has no chat at all, and the RESET path in the bridge
 *  (`HermesBridge.resetChat`), which retires the current pin and mints a replacement on purpose.
 *  Keeping one implementation is what guarantees both are born with the exact title, the hidden
 *  flag, and -- since capability 11 -- an empty transcript on both. */
export async function mintCanonicalChat(
  name: string,
  deps: CanonicalChatDeps,
): Promise<{ storedId: string; runtimeId: string }> {
  await deps.assertStillExists?.();
  const created = asRecord(
    await deps.rpc.request("session.create", {
      profile: name,
      title: CANONICAL_CHAT_TITLE,
      ...(deps.hideBotChats ? { hidden: true } : {}),
    }),
  );
  const storedRaw = created?.["stored_session_id"];
  const runtimeRaw = created?.["session_id"];
  const storedId =
    typeof storedRaw === "string" || typeof storedRaw === "number" ? String(storedRaw) : undefined;
  const runtimeId =
    typeof runtimeRaw === "string" || typeof runtimeRaw === "number" ? String(runtimeRaw) : undefined;
  if (storedId === undefined || runtimeId === undefined) {
    throw new Error("hermes session.create returned no session ids");
  }

  deps.pins.set(name, storedId);
  return { storedId, runtimeId };
}

/** Resolve-or-create, per dissection 5.2. Single-flight is the caller's job (see the bridge):
 *  two concurrent calls for the same bot would otherwise mint two chats. */
export async function resolveCanonicalChat(
  name: string,
  deps: CanonicalChatDeps,
): Promise<CanonicalChatResult> {
  const result = await resolvePin(name, deps);
  // The server is told about a pin it does not already carry, so the next open (from this phone,
  // another device, or the desktop) reads it back rather than re-deriving it.
  if (result.sessionId !== deps.serverPin) await deps.saveServerPin?.(result.sessionId);
  return result;
}

async function resolvePin(name: string, deps: CanonicalChatDeps): Promise<CanonicalChatResult> {
  const limit = deps.listLimit ?? 100;
  // `??` would be wrong here: it collapses an explicit server clear (null) back onto the local
  // pin, which is exactly the resurrection dissection 3.2 forbids.
  const localEntry = deps.pins.entry?.(name);
  const localId = localEntry?.sessionId ?? deps.pins.get(name);
  // A MANUAL restore is the user's explicit choice, and `#saveServerPin` swallows its own
  // failures by design, so a server pin that still names the pre-restore chat is stale
  // evidence, not a countermand. The durable manual record is the only witness of the choice
  // and it wins here; it stops winning the moment a conversation CREATED after it appears
  // (the manualSince rule below) or the local record is rewritten by any automatic adoption,
  // including the reset path, which always writes manual=false.
  // The same rule extends to an UNWRITTEN local pin (capability 19 sessions/new): the fresh empty
  // chat is invisible to session.list and the server-pin write may have been swallowed, so a stale
  // server pin naming the replaced conversation must not outrank the chat the user just started.
  let pin = effectiveChatPin(
    deps.serverPin,
    localId === undefined
      ? undefined
      : {
          sessionId: localId,
          updatedAt: localEntry?.updatedAt ?? 0,
          manual: localEntry?.manual === true,
          unwritten: deps.isUnwritten?.(localId) === true,
        },
  );
  const manualSince =
    localEntry?.manual === true && localEntry.sessionId === pin ? localEntry.updatedAt : undefined;
  const rows = await listBotSessions(deps.rpc, name, limit);

  if (rows.length === 0) {
    // An empty list does NOT prove the bot has no chat. `session.create` persists no row until the
    // first prompt lands (dissection 5.1), so a chat the user has not written in yet is invisible to
    // `session.list`. Creating again here is what minted a second canonical chat on every fast
    // second open: two "created" answers, two session ids, and a roster preview pointing at a chat
    // the app was not showing. A pin we hold is therefore believed over an empty list; only a bot
    // with no pin at all gets a new chat.
    //
    // Since capability 11 this is not a few-second race but the ordinary resting state of a chat
    // nobody has typed into: the gateway submits nothing on the user's behalf, so an untouched chat
    // stays unlisted for as long as it stays untouched. The rule was already right; what changed is
    // how long it has to hold.
    if (typeof pin === "string" && pin.length > 0) {
      // Rewriting an automatic pin refreshes its timestamp. Keep a minted chat's original creation
      // boundary so a later conversational session can release it even if Hermes briefly reports
      // an empty list while that later row is becoming visible.
      if (deps.isUnwritten?.(pin) === true) return { sessionId: pin, adoption: "pin" };
      deps.pins.set(name, pin);
      return { sessionId: pin, adoption: "pin" };
    }
    // No pin and no history: the pin, if any, points at nothing. Clear it before creating so a
    // failed creation cannot leave a stale pointer behind.
    deps.pins.clear(name);
    const created = await mintCanonicalChat(name, deps);
    return { sessionId: created.storedId, adoption: "created", runtimeId: created.runtimeId };
  }

  // Retired sessions are removed from consideration BEFORE either heuristic runs, not filtered out
  // of their answer afterwards, so "the canonical title" and "the newest row" both mean "the newest
  // one the user has not already cleared". See `CanonicalChatDeps.isRetired`.
  const isRetired = deps.isRetired ?? (() => false);
  const candidates = rows.filter((row) => !isRetired(row.id));

  if (pin === undefined || pin === null) {
    // Grandfather path: a bot that already has history (from the CLI, a cron run, or a bot-to-bot
    // exchange) adopts the session carrying the canonical title, else the first row, which is the
    // newest by the ordering convention `parseSessionList` documents and cannot verify.
    const titled = candidates.find((row) => row.title === CANONICAL_CHAT_TITLE);
    const adopted = titled ?? candidates[0];
    if (adopted !== undefined) {
      deps.pins.set(name, adopted.id);
      return { sessionId: adopted.id, adoption: titled === undefined ? "latest" : "title" };
    }
    // Every session this bot has was retired and there is no pin left to point at the replacement.
    // Adopting one anyway is the one outcome that is never acceptable (it is the cleared conversation
    // coming back), so mint instead: the user ends up with a working chat, which is the promise this
    // function actually makes. This cannot become a mint-per-open loop, because minting sets the pin,
    // and the pin paths below never mint.
    deps.pins.clear(name);
    const created = await mintCanonicalChat(name, deps);
    return { sessionId: created.storedId, adoption: "created", runtimeId: created.runtimeId };
  }

  if (!rows.some((row) => row.id === pin)) {
    // A freshly minted empty chat is absent from `session.list` until its first prompt persists.
    // Older unretired sessions may still be listed, especially after capability-19 new session, so
    // treating the missing pin as compaction would immediately re-adopt the conversation the user
    // just left. Hold the durable unwritten pin unless a genuinely later conversational session
    // has appeared. That later row is capability-14 follow-latest resuming at the right boundary.
    if (deps.isUnwritten?.(pin) === true) {
      const pinSince = localEntry?.sessionId === pin ? localEntry.updatedAt : undefined;
      const newer = candidates.find(
        (row) =>
          isConversationalSession(row) &&
          pinSince !== undefined &&
          row.startedAt !== 0 &&
          row.startedAt > pinSince,
      );
      if (newer !== undefined) {
        deps.pins.set(name, newer.id);
        return { sessionId: newer.id, adoption: "latest", previousSessionId: pin };
      }
      return { sessionId: pin, adoption: "pin" };
    }

    // Recovery path: compaction rewrote the lineage and the pinned id no longer exists. The
    // desktop re-pins the newest session outright, so this does too, minus anything retired.
    const newest = candidates[0];
    if (newest !== undefined) {
      deps.pins.set(name, newest.id);
      return { sessionId: newest.id, adoption: "recovery" };
    }
    // A pin that names nothing listed, and nothing listed worth adopting. Keeping the pin is right
    // and minting here would be wrong: the commonest way to reach this is a chat minted after a
    // reset and not yet written in (the same unlisted state the empty-list branch above reasons
    // about), where the pin is the only pointer to the new chat and every listed session is one that
    // reset retired. Minting would spawn a fresh chat on EVERY open until the user finally typed.
    deps.pins.set(name, pin);
    return { sessionId: pin, adoption: "pin" };
  }

  // The pin itself gets the same retired check the heuristics got. Reachable with no exotic
  // failure: `saveServerPin` may fail silently after a reset, the server pin then still names the
  // retired session, and the server pin is preferred over the local one - honoring it here is the
  // cleared conversation coming back. The listed-but-retired pin re-resolves among the candidates.
  if (isRetired(pin)) {
    const titled = candidates.find((row) => row.title === CANONICAL_CHAT_TITLE);
    const adopted = titled ?? candidates[0];
    if (adopted !== undefined) {
      deps.pins.set(name, adopted.id);
      return { sessionId: adopted.id, adoption: "recovery" };
    }
    deps.pins.clear(name);
    const created = await mintCanonicalChat(name, deps);
    return { sessionId: created.storedId, adoption: "created", runtimeId: created.runtimeId };
  }

  // RE-ADOPTION (issue #88). The pin resolves, but the pin is not automatically the bot's
  // conversation any more: a chat held from a second device mints a session of its own, and up to
  // now the roster preview followed that session while the canonical chat stayed on the pin. The two
  // surfaces then described different conversations, and the messages the preview was quoting were
  // absent from the transcript the app opened. The pin FOLLOWS the latest conversational session.
  //
  // "Newer" is list POSITION, which `parseSessionList` documents as a convention this wire cannot
  // verify. It is used the same way every other heuristic here uses it -- as a preference, never as
  // a fact -- and the guards around it are what make a wrong guess harmless: nothing retired is a
  // candidate (a reset's conversation never comes back), and nothing a machine wrote is a candidate
  // (`isConversationalSession`), so the worst a mis-ordered list can do is prefer one conversation
  // the user actually held over another.
  //
  // Resets cannot be outrun by this, and the ordering is worth stating because it is the race the
  // cozychat work surfaced: a reset retires the outgoing session and pins a freshly minted one, and
  // that replacement has NO row in `session.list` until the user writes in it. A just-reset bot is
  // therefore resolved by the pin-not-listed branch above and never reaches this one, and once the
  // replacement does become listed it is the newest row, so there is nothing above it to re-adopt.
  // The retired session, meanwhile, is not a candidate at any point.
  const followedPin = followLatestChatPin(pin, rows, {
    isConversational: isConversationalSession,
    isRetired,
    // A manual choice ignores conversations that already existed above it. Its pin resumes
    // following only when a conversation CREATED after the choice appears. An older Hermes row
    // without a creation stamp cannot prove that, so it does not override a manual choice.
    manualSince,
  });
  if (followedPin !== pin) {
    deps.pins.set(name, followedPin);
    return { sessionId: followedPin, adoption: "latest", previousSessionId: pin };
  }

  deps.pins.set(name, pin);
  return { sessionId: pin, adoption: "pin" };
}

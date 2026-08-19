/** The canonical "Bot Chat": every bot has ONE forever chat, pinned by stored-session id, and
 *  opening a bot always lands there (dissection section 5). This module reimplements the desktop
 *  plugin's resolve-or-create and its three pin-adoption paths server-side, so every device sees
 *  the same chat and a phone that never ran the desktop still lands in the right session.
 *
 *  Byte-compatible conventions that must not drift: the title is exactly `Bot Chat`, and a new
 *  chat is born with a kickoff prompt because `session.create` persists NO database row until the
 *  first prompt (dissection 14.5), so a pre-created empty chat cannot be listed, hidden, or
 *  resumed. */

/** The session title the Hermes prompt builder gates its bot-mode protocol injection on. Exact
 *  match, including case. */
export const CANONICAL_CHAT_TITLE = "Bot Chat";

/** The desktop's kickoff message, kept identical so a chat created from the phone reads the same
 *  as one created from the desktop. */
export const KICKOFF_PROMPT = "Hey, tell me about yourself!";

/** How the returned session id was arrived at. Surfaced for observability and tests, and cheap
 *  for the app to ignore. */
export type ChatAdoption =
  /** The existing pin was still valid. */
  | "pin"
  /** First open of a bot with history: adopted the session carrying the canonical title. */
  | "title"
  /** First open of a bot with history and no canonical title: adopted the newest session. */
  | "latest"
  /** The pinned id vanished (compaction rewrote the lineage): re-pinned the newest session. */
  | "recovery"
  /** No sessions existed: created one and sent the kickoff prompt. */
  | "created";

export interface CanonicalChatResult {
  sessionId: string;
  adoption: ChatAdoption;
  /** The RUNTIME session id, when this call is the one that created the chat. `prompt.submit` only
   *  accepts the runtime id (dissection 1.2 row 11) and it is a DIFFERENT value from the stored id
   *  that gets pinned; a chat whose kickoff has not persisted yet cannot be resumed, so this is the
   *  only way to learn it. Absent for every adoption path other than `created`. */
  runtimeId?: string;
}

export interface HermesRpc {
  /** `opts.timeoutMs` bounds this one call, overriding the client-wide default. */
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/** The local pin store. Backed by SQLite in production; a plain map in tests. */
export interface PinStore {
  get(name: string): string | undefined;
  set(name: string, sessionId: string): void;
  clear(name: string): void;
}

export interface SessionRow {
  id: string;
  title: string;
  preview: string | null;
  source: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Decodes a `session.list` response tolerantly. Rows without a usable id are dropped; the order
 *  the gateway returned (newest first, by convention) is preserved, since the adoption rules index
 *  into it.
 *
 *  Worth stating rather than implying: `session.list` rows carry NO timestamp on this surface (id,
 *  title, preview, source, and that is the whole of it, see `GET /bots/:name/sessions` in
 *  contract/ext-bots-v1.md). "Newest first" is therefore a convention this gateway observes and
 *  cannot verify, so nothing here may treat position as a fact. It is used as a preference, never as
 *  a guarantee, and the retired-session guard below is what keeps a wrong guess from being harmful.
 *  Do not synthesize a recency field to paper over this: an invented timestamp would read as
 *  authority the wire never gave. */
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
    });
  }
  return parsed;
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
   *  duplicate chat gets minted while the first one's kickoff is still in flight. */
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
  /** How many sessions to consider when adopting. The desktop uses 100. */
  listLimit?: number;
}

export async function listBotSessions(rpc: HermesRpc, name: string, limit: number): Promise<SessionRow[]> {
  return parseSessionList(await rpc.request("session.list", { profile: name, limit }));
}

/** Creates the canonical chat: check the bot is still there, `session.create` for the ids, pin it,
 *  then submit the kickoff
 *  prompt against the RUNTIME id (the stored id is what gets pinned; they are different values).
 *  A failed submit rolls the pin back, exactly as the desktop does, so a half-created chat never
 *  becomes the permanent pointer.
 *
 *  Exported because there are now TWO ways a chat gets minted, and they must mint it identically or
 *  a reset chat would not be byte-compatible with a resolved one: `resolveCanonicalChat` below,
 *  which mints only when a bot has no chat at all, and the RESET path in the bridge
 *  (`HermesBridge.resetChat`), which retires the current pin and mints a replacement on purpose.
 *  Keeping one implementation is what guarantees both are born with the exact title, the hidden
 *  flag, and the kickoff prompt that makes the session persist at all. */
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
  try {
    await deps.rpc.request("prompt.submit", { session_id: runtimeId, text: KICKOFF_PROMPT });
  } catch (err) {
    deps.pins.clear(name);
    throw err;
  }
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
  const pin = deps.serverPin !== undefined ? deps.serverPin : deps.pins.get(name);
  const rows = await listBotSessions(deps.rpc, name, limit);

  if (rows.length === 0) {
    // An empty list does NOT prove the bot has no chat. `session.create` persists no row until the
    // first prompt lands (dissection 5.1), so a chat created moments ago is invisible to
    // `session.list` while its kickoff is still in flight. Creating again here is what minted a
    // second canonical chat on every fast second open: two "created" answers, two session ids, and
    // a roster preview pointing at a chat the app was not showing. A pin we hold is therefore
    // believed over an empty list; only a bot with no pin at all gets a new chat.
    if (typeof pin === "string" && pin.length > 0) {
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
    // Recovery path: compaction rewrote the lineage and the pinned id no longer exists. The
    // desktop re-pins the newest session outright, so this does too, minus anything retired.
    const newest = candidates[0];
    if (newest !== undefined) {
      deps.pins.set(name, newest.id);
      return { sessionId: newest.id, adoption: "recovery" };
    }
    // A pin that names nothing listed, and nothing listed worth adopting. Keeping the pin is right
    // and minting here would be wrong: the commonest way to reach this is a chat minted seconds ago
    // whose kickoff has not persisted yet (the same lazy window the empty-list branch above reasons
    // about), where the pin is the only pointer to the new chat and every listed session is one a
    // reset just retired. Minting would spawn a fresh chat on EVERY open until the kickoff lands.
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
  deps.pins.set(name, pin);
  return { sessionId: pin, adoption: "pin" };
}

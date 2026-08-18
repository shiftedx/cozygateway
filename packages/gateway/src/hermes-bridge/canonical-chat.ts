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
 *  the gateway returned (newest first) is preserved, since the adoption rules index into it. */
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
 *  becomes the permanent pointer. */
async function createCanonicalChat(
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
    const created = await createCanonicalChat(name, deps);
    return { sessionId: created.storedId, adoption: "created", runtimeId: created.runtimeId };
  }

  if (pin === undefined || pin === null) {
    // Grandfather path: a bot that already has history (from the CLI, a cron run, or a bot-to-bot
    // exchange) adopts the session carrying the canonical title, else the newest one.
    const titled = rows.find((row) => row.title === CANONICAL_CHAT_TITLE);
    const adopted = titled ?? rows[0]!;
    deps.pins.set(name, adopted.id);
    return { sessionId: adopted.id, adoption: titled === undefined ? "latest" : "title" };
  }

  if (!rows.some((row) => row.id === pin)) {
    // Recovery path: compaction rewrote the lineage and the pinned id no longer exists. The
    // desktop re-pins the newest session outright, so this does too.
    const newest = rows[0]!;
    deps.pins.set(name, newest.id);
    return { sessionId: newest.id, adoption: "recovery" };
  }

  deps.pins.set(name, pin);
  return { sessionId: pin, adoption: "pin" };
}

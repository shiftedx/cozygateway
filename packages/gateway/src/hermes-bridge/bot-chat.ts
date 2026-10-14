import { BackendUnavailable } from "../errors.ts";
import { asRecord, asString, type HermesRpc } from "./rpc.ts";
import { UI_META_KEY } from "./roster.ts";

/** Capability 86: the canonical Bot Chat, as upstream Hermes Desktop defines it
 *  (`apps/desktop/src/plugins/hermes-bots/canonical-chat.ts`). Each bot has ONE forever chat,
 *  identified by NAME: the profile's session titled exactly `Bot Chat`. Hermes keeps a
 *  UNIQUE(title) index, injects the bot-to-bot protocol and `message_agent` only into a session with
 *  that title, and retires a deliberately archived HIDDEN one when a replacement takes the title.
 *
 *  These are control-plane calls only: the registry lookup, the one-time registry row, and the
 *  Bot-Mode marker. The chat itself still rides attach-v1; the gateway binds its current chat to
 *  this session through the capability-4 desktop resume proof. */

export const CANONICAL_BOT_CHAT_TITLE = "Bot Chat";

/** Upper bound for the exact-title scan, the same one upstream uses. */
const SESSION_LIST_LIMIT = 200;

export interface CanonicalBotChat {
  /** The durable registry row. */
  hermesSessionId: string;
  /** The compression-lineage tip, when the lookup followed one. */
  resolvedId?: string;
}

/** THE identity lookup. FAILS CLOSED: a failed RPC never reads as "no Bot Chat", because minting on
 *  a transient failure is the one remaining way to fork a bot's forever chat. */
export async function findCanonicalBotChat(rpc: HermesRpc, profile: string): Promise<CanonicalBotChat | null> {
  let result: unknown;
  try {
    result = await rpc.request("session.list", {
      profile,
      title: CANONICAL_BOT_CHAT_TITLE,
      include_hidden: true,
      limit: SESSION_LIST_LIMIT,
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
    throw new BackendUnavailable(`could not check ${profile}'s Bot Chat registry${detail}; not starting a new chat`);
  }
  const rows = asRecord(result)?.["sessions"];
  if (!Array.isArray(rows)) throw new BackendUnavailable(`hermes answered session.list for ${profile} without sessions`);
  for (const raw of rows) {
    const row = asRecord(raw);
    const id = asString(row?.["id"]);
    const rootTitle = asString(row?.["root_title"])?.trim();
    const title = asString(row?.["title"])?.trim();
    if (id === undefined || id.length === 0) continue;
    if (rootTitle === CANONICAL_BOT_CHAT_TITLE || (rootTitle === undefined && title === CANONICAL_BOT_CHAT_TITLE)) {
      const resolved = asString(row?.["resolved_id"]);
      return { hermesSessionId: id, ...(resolved && resolved !== id ? { resolvedId: resolved } : {}) };
    }
  }
  return null;
}

/** Mint the registry row: hidden, sourced `desktop` (so the attach plugin's interactive-session
 *  resume accepts it), following the profile's own model. `session.title` materializes the lazy
 *  row now and records the title before anyone can race it. A title refusal means another writer
 *  won between our lookup and this write: the winner is adopted, never a second forever chat. */
export async function createCanonicalBotChat(rpc: HermesRpc, profile: string): Promise<CanonicalBotChat> {
  const created = asRecord(await rpc.request("session.create", {
    profile,
    title: CANONICAL_BOT_CHAT_TITLE,
    hidden: true,
    follow_profile_config: true,
    source: "desktop",
  }));
  const runtime = asString(created?.["session_id"]);
  const stored = asString(created?.["stored_session_id"]);
  if (runtime === undefined || stored === undefined)
    throw new BackendUnavailable(`hermes did not create ${profile}'s Bot Chat`);
  try {
    await rpc.request("session.title", { session_id: runtime, title: CANONICAL_BOT_CHAT_TITLE });
  } catch (error) {
    if (error instanceof Error && /already in use/i.test(error.message)) {
      const winner = await findCanonicalBotChat(rpc, profile);
      if (winner !== null) return winner;
    }
    throw error;
  }
  return { hermesSessionId: stored };
}

/** The other Bot Mode precondition (`tools/bot_mode_probe.py`): SOME profile on the install carries
 *  a `ui_meta["hermes-bots"]` block; an empty one is enough. Writes `{}` onto `profile` only when no
 *  profile has one, under revision 0, so it can never overwrite a blob another client wrote.
 *  Answers whether it wrote. */
export async function ensureBotModeMarker(rpc: HermesRpc, profile: string): Promise<boolean> {
  const rows = asRecord(await rpc.request("profiles.list", { include_sessions: false }))?.["profiles"];
  if (!Array.isArray(rows)) return false;
  if (rows.some((row) => asRecord(asRecord(asRecord(row)?.["ui_meta"])?.[UI_META_KEY]) !== undefined)) return false;
  if (!rows.some((row) => asRecord(row)?.["name"] === profile)) return false;
  const applied = asRecord(asRecord(await rpc.request("profiles.configure", {
    name: profile,
    ui_meta: { [UI_META_KEY]: {} },
    ui_meta_expected_revisions: { [UI_META_KEY]: 0 },
  }))?.["applied"]);
  return applied?.["ui_meta"] === true;
}

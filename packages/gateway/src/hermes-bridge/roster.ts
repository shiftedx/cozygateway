import type { BotPreview, BotSummary } from "cozygateway-contract";

/** Pure roster construction: everything the bridge derives from a `profiles.list` response, with
 *  no sockets, no clock of its own, and no storage. Kept pure so the desktop conventions it
 *  reimplements (dissection sections 2, 3 and 7) are directly unit-testable.
 *
 *  UNIT TRAP, load-bearing: `last_session.last_active` is UNIX SECONDS, while `meta.created` is
 *  MILLISECONDS. Everything leaving this module is milliseconds. */

/** The `ui_meta` namespace key the Hermes desktop plugin owns. Byte-compatibility with it is the
 *  whole point: a different key means the two clients cannot see each other's bots. */
export const UI_META_KEY = "hermes-bots";

/** Presence liveness window, in seconds (dissection 7.1). Strict less-than. */
export const ACTIVE_WINDOW_S = 90;

/** A bot-to-bot delivery preview, and the prefix stripped off it for display. Both are copied
 *  from the desktop plugin verbatim so the same previews classify the same way. */
const A2A_RE = /^Message from (?:agent '([^']+)'|🤖\s*([^\s(@]+))/i;
const A2A_PREFIX_RE = /^Message from (?:agent '[^']+'|🤖[^:]+):\s*/i;

/** One `profiles.list` row, after tolerant decoding. Unknown fields on the wire are ignored;
 *  a row without a usable `name` is dropped entirely. */
export interface ParsedProfile {
  name: string;
  description: string | null;
  hasAvatar: boolean;
  /** The `ui_meta["hermes-bots"]` blob, or null when the profile carries none. */
  meta: Record<string, unknown> | null;
  /** Milliseconds, converted from the wire's seconds. Null when the profile has no session. */
  lastActiveAt: number | null;
  preview: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Pulls the bot blob out of a profile's `ui_meta`. Three shapes are accepted:
 *  - the current one: `ui_meta["hermes-bots"]` is an object;
 *  - absent: no `ui_meta`, or no bot namespace inside it, which yields null;
 *  - legacy: a `ui_meta` written before the namespace existed, carrying the bot fields flat at the
 *    top level. Recognized by any of the fields the plugin owns being present, and adopted as-is
 *    so an older profile keeps its title, look, group, and canonical-chat pin. */
export function extractBotMeta(uiMeta: unknown): Record<string, unknown> | null {
  return readBotMeta(uiMeta).meta;
}

/** Fields the desktop plugin owns inside its namespace. Used to decide what may be carried over
 *  from a LEGACY (pre-namespace) `ui_meta`, which is the whole record and may contain another
 *  plugin's keys. */
const BOT_META_FIELDS = ["shape", "color", "title", "chat", "pinned", "group", "created", "custom", "pet"];

/** Fields that must never be written back into `ui_meta` (dissection 3.1): `image` and `pet` are
 *  data URLs and `custom` is a custom-avatar payload. `ui_meta` is capped at 64 KB and rides EVERY
 *  `profiles.list`, so an avatar parked there costs every roster poll and can push the blob past
 *  the cap, at which point the write fails and the pin stays gateway-local. */
export const BOT_META_ASSET_FIELDS = ["image", "pet", "custom"] as const;

/** The gateway-side cap on one profile's `ui_meta` payload, in bytes (dissection 3.1). */
export const UI_META_MAX_BYTES = 64 * 1024;

/** `extractBotMeta` plus the shape it came from. `legacy` means the fields were found flat at the
 *  top of `ui_meta`, so the record also carries whatever else lived there. */
export function readBotMeta(uiMeta: unknown): { meta: Record<string, unknown> | null; legacy: boolean } {
  const record = asRecord(uiMeta);
  if (record === undefined) return { meta: null, legacy: false };
  const namespaced = asRecord(record[UI_META_KEY]);
  if (namespaced !== undefined) return { meta: namespaced, legacy: false };
  const hasLegacyField = BOT_META_FIELDS.some((field) => field in record);
  return hasLegacyField ? { meta: record, legacy: true } : { meta: null, legacy: false };
}

/** The blob to push back under `ui_meta["hermes-bots"]`, given what the profile carries today.
 *
 *  Two rules, both load-bearing:
 *  - a LEGACY blob is the whole `ui_meta` record, so only the fields the plugin owns are carried
 *    over. Re-nesting the record wholesale would push another plugin's namespace (and possibly a
 *    data-URL avatar) under `hermes-bots`, on every chat open, forever.
 *  - `image`, `pet` and `custom` are stripped either way, exactly as the desktop's `saveBotMeta`
 *    strips them.
 *
 *  The result is capped: anything past `UI_META_MAX_BYTES` is reduced to the compact fields, and a
 *  blob still over the cap after that is refused (null) so the caller keeps the pin gateway-local
 *  rather than firing a write the gateway will reject. */
export function botMetaForWriteback(
  uiMeta: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  const { meta, legacy } = readBotMeta(uiMeta);
  const source = meta ?? {};
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if ((BOT_META_ASSET_FIELDS as readonly string[]).includes(key)) continue;
    if (legacy && !BOT_META_FIELDS.includes(key)) continue;
    base[key] = value;
  }
  const merged = { ...base, ...patch };
  if (uiMetaBytes(merged) <= UI_META_MAX_BYTES) return merged;

  // Over the cap: keep only what the plugin actually syncs, then give up rather than write junk.
  const compact: Record<string, unknown> = {};
  for (const field of BOT_META_FIELDS) {
    if ((BOT_META_ASSET_FIELDS as readonly string[]).includes(field)) continue;
    if (field in merged) compact[field] = merged[field];
  }
  Object.assign(compact, patch);
  return uiMetaBytes(compact) <= UI_META_MAX_BYTES ? compact : null;
}

/** Bytes the blob costs on the wire, namespace wrapper included. */
export function uiMetaBytes(meta: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify({ [UI_META_KEY]: meta }), "utf8");
}

/** The canonical-chat pin a bot's blob implies, three-valued and shared by `GET /bots` and
 *  `GET /bots/:name/chat` so the two can never disagree about it (they did: the roster mapped an
 *  absent `chat` key to null while the chat route fell back to a fresh local pin, and the roster
 *  then showed "no conversation" for a chat the app was sitting in).
 *
 *  - a string is the server's pin;
 *  - `null` is an authoritative CLEAR: a blob that carries no `chat` key means the pin is gone
 *    (dissection 3.2), and it must not be resurrected from the local record;
 *  - `undefined` is "the server knows nothing", which is the only case the local record fills.
 *
 *  The clear is only authoritative about state the snapshot could have seen. A pin THIS gateway
 *  wrote after the snapshot was taken is newer than the server's answer, not contradicted by it,
 *  so it reads as `undefined` and the local record wins. */
export function resolveChatPin(
  meta: Record<string, unknown> | null,
  localPin: { sessionId: string; updatedAt: number } | undefined,
  snapshotAt: number | null,
): string | null | undefined {
  if (meta === null) return undefined;
  const chat = asString(meta["chat"]);
  if (chat !== undefined && chat.length > 0) return chat;
  if (localPin !== undefined && (snapshotAt === null || localPin.updatedAt > snapshotAt)) return undefined;
  return null;
}

export function parseProfileRow(row: unknown): ParsedProfile | undefined {
  const record = asRecord(row);
  if (record === undefined) return undefined;
  const name = asString(record["name"]);
  if (name === undefined || name.length === 0) return undefined;

  const lastSession = asRecord(record["last_session"]);
  const lastActiveSeconds = typeof lastSession?.["last_active"] === "number" ? lastSession["last_active"] : undefined;

  return {
    name,
    description: asString(record["description"]) ?? null,
    hasAvatar: record["has_avatar"] === true,
    meta: extractBotMeta(record["ui_meta"]),
    lastActiveAt:
      lastActiveSeconds === undefined || !Number.isFinite(lastActiveSeconds)
        ? null
        : Math.round(lastActiveSeconds * 1000),
    preview: asString(lastSession?.["preview"]) ?? null,
  };
}

/** `profiles.list` returns `{ profiles: [...], bot_mode_protocol: true }`. Both fields are read
 *  tolerantly: a response without `profiles` yields an empty roster rather than throwing. */
export function parseProfilesList(result: unknown): {
  profiles: ParsedProfile[];
  botModeProtocol: boolean;
} {
  const record = asRecord(result);
  const rows = Array.isArray(record?.["profiles"]) ? (record["profiles"] as unknown[]) : [];
  const profiles: ParsedProfile[] = [];
  for (const row of rows) {
    const parsed = parseProfileRow(row);
    if (parsed !== undefined) profiles.push(parsed);
  }
  return { profiles, botModeProtocol: record?.["bot_mode_protocol"] === true };
}

/** `default` is addressed as `@hermes` everywhere in Bot Mode (dissection 2.4). */
export function botHandle(name: string): string {
  return name === "default" ? "hermes" : name;
}

/** Display name priority (dissection 2.4), minus the multi-connection cases that are out of scope
 *  for v1: meta.title, then the fixed `Hermes` label for the primary profile, then the profile
 *  name with `-`/`_` runs turned into spaces and title cased. */
export function botDisplayName(name: string, meta: Record<string, unknown> | null): string {
  const title = asString(meta?.["title"])?.trim();
  if (title !== undefined && title.length > 0) return title;
  if (name === "default") return "Hermes";
  return name
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Classifies the roster preview line the way the desktop row does (dissection 2.7): a bot-to-bot
 *  delivery renders with its prefix stripped plus the sender handle; anything else is the plain
 *  preview, falling back to the description and then to the empty state. */
export function classifyPreview(preview: string | null, description: string | null): BotPreview {
  const text = preview?.trim() ?? "";
  if (text.length > 0) {
    const match = A2A_RE.exec(text);
    if (match !== null) {
      const sender = match[1] ?? match[2] ?? "";
      const stripped = text.replace(A2A_PREFIX_RE, "");
      return sender.length > 0
        ? { kind: "a2a", text: stripped, sender }
        : { kind: "a2a", text: stripped };
    }
    return { kind: "plain", text };
  }
  const fallback = description?.trim() ?? "";
  if (fallback.length > 0) return { kind: "plain", text: fallback };
  return { kind: "empty", text: "No conversations yet, say hi" };
}

/** The state the presence rule needs from the live bridge. `routedProfile` is the profile the
 *  Hermes gateway is currently routed to; `gatewayState` is that socket's own state, where
 *  `busy` means "the routed backend is mid-turn" (dissection 7.3). */
export interface PresenceContext {
  routedProfile: string | null;
  gatewayState: "idle" | "connecting" | "open" | "busy";
  /** Milliseconds. */
  now: number;
}

/** Presence, exactly per dissection 7.1: gateway-busy on the routed profile, OR the liveness
 *  window. The window is strict less-than 90 SECONDS against `last_active`, which is why the
 *  comparison happens in seconds even though the stored value is milliseconds. */
export function isBotActive(
  bot: { name: string; lastActiveAt: number | null },
  ctx: PresenceContext,
): boolean {
  const busyTurn = ctx.gatewayState === "busy" && ctx.routedProfile === bot.name;
  if (busyTurn) return true;
  if (bot.lastActiveAt === null || bot.lastActiveAt <= 0) return false;
  return ctx.now / 1000 - bot.lastActiveAt / 1000 < ACTIVE_WINDOW_S;
}

/** Roster sort key (dissection 2.5): most recent of the bot's creation stamp and its last
 *  session activity. Both are milliseconds by the time they reach here. */
export function botActivityAt(profile: ParsedProfile): number {
  const created = typeof profile.meta?.["created"] === "number" ? (profile.meta["created"] as number) : 0;
  return Math.max(Number.isFinite(created) ? created : 0, profile.lastActiveAt ?? 0);
}

export interface RosterBuildOptions extends PresenceContext {
  /** Canonical-chat pins the gateway holds locally, by profile name, each with the stamp of the
   *  write that made it. Consulted through `resolveChatPin`, so `GET /bots` reports exactly the
   *  pin `GET /bots/:name/chat` would resolve: a profile with no bot blob falls back to the local
   *  record, a blob without `chat` is an authoritative clear (dissection 3.2), and a local pin
   *  written AFTER this snapshot was taken outlives that clear because the snapshot cannot have
   *  seen it.
   *
   *  `now` doubles as the snapshot stamp, so the caller must pass the moment it asked Hermes for
   *  this data and stamp the cached roster with the same value. */
  pins: ReadonlyMap<string, { sessionId: string; updatedAt: number }>;
  /** Profile names the operator has hidden (`hiddenProfiles` in the bridge config). They stay REAL
   *  profiles Hermes-side and every by-name route still addresses them; they are simply left off
   *  the roster this gateway serves, which is how a box whose Hermes also runs automation profiles
   *  shows a phone only the bots that belong on it. The filter lives here, in the single function
   *  that builds a roster, so `GET /bots` and the `bot_roster` frame cannot disagree about what is
   *  on it. Names are compared already-normalized (lowercase), as Hermes stores them. */
  hidden?: ReadonlySet<string>;
}

/** Builds the merged roster: profiles plus their `ui_meta` blob, preview classification, presence
 *  flag, and the canonical-chat pointer, sorted pinned-first then most-recently-active. Search
 *  never re-ranks, so this is the one ordering the app renders. */
export function buildRoster(profiles: ParsedProfile[], opts: RosterBuildOptions): BotSummary[] {
  const visible = opts.hidden === undefined ? profiles : profiles.filter((p) => !opts.hidden?.has(p.name));
  const rows = visible.map((profile) => {
    const meta = profile.meta;
    // One rule, shared with the chat route (`resolveChatPin`): a server blob is the whole truth
    // about `chat` unless this gateway wrote a newer pin than the snapshot could have seen.
    const local = opts.pins.get(profile.name);
    const resolved = resolveChatPin(meta, local, opts.now);
    const chatSessionId = resolved === undefined ? (local?.sessionId ?? null) : resolved;
    const group = asString(meta?.["group"])?.trim();
    const summary: BotSummary = {
      name: profile.name,
      displayName: botDisplayName(profile.name, meta),
      handle: botHandle(profile.name),
      description: profile.description,
      hasAvatar: profile.hasAvatar,
      group: group === undefined || group.length === 0 ? null : group,
      pinned: meta?.["pinned"] === true,
      active: isBotActive(profile, opts),
      lastActiveAt: profile.lastActiveAt,
      chatSessionId,
      preview: classifyPreview(profile.preview, profile.description),
      meta,
    };
    return { summary, activityAt: botActivityAt(profile) };
  });

  rows.sort((a, b) => {
    if (a.summary.pinned !== b.summary.pinned) return a.summary.pinned ? -1 : 1;
    return b.activityAt - a.activityAt;
  });
  return rows.map((row) => row.summary);
}

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

/** Pulls the bot blob out of the current `ui_meta["hermes-bots"]` namespace. */
export function extractBotMeta(uiMeta: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(uiMeta)?.[UI_META_KEY]) ?? null;
}

/** Fields the desktop plugin owns inside its namespace. */
const BOT_META_FIELDS = ["shape", "color", "title", "chat", "pinned", "group", "created", "custom", "pet"];

/** Fields that must never be written back into `ui_meta` (dissection 3.1): `image` and `pet` are
 *  data URLs and `custom` is a custom-avatar payload. `ui_meta` is capped at 64 KB and rides EVERY
 *  `profiles.list`, so an avatar parked there costs every roster poll and can push the blob past
 *  the cap, at which point the write fails and the pin stays gateway-local. */
export const BOT_META_ASSET_FIELDS = ["image", "pet", "custom"] as const;

/** The gateway-side cap on one profile's `ui_meta` payload, in bytes (dissection 3.1). */
export const UI_META_MAX_BYTES = 64 * 1024;

/** The blob to push back under `ui_meta["hermes-bots"]`, given what the profile carries today.
 *
 *  `image`, `pet` and `custom` are stripped, exactly as the desktop's `saveBotMeta` strips them.
 *
 *  The result is capped: anything past `UI_META_MAX_BYTES` is reduced to the compact fields, and a
 *  blob still over the cap after that is refused (null) so the caller keeps the pin gateway-local
 *  rather than firing a write the gateway will reject. */
export function botMetaForWriteback(
  uiMeta: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> | null {
  const source = extractBotMeta(uiMeta) ?? {};
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if ((BOT_META_ASSET_FIELDS as readonly string[]).includes(key)) continue;
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

/** Projects ordinary display text without inferring its provenance. Transcript text cannot prove
 *  a bot-to-bot sender, so even a `Message from ...` prefix remains plain text. */
export function classifyPreview(preview: string | null, description: string | null): BotPreview {
  const text = preview?.trim() ?? "";
  if (text.length > 0) return { kind: "plain", text };
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
  /** Profile names the operator has hidden (`hiddenProfiles` in the bridge config). They stay REAL
   *  profiles Hermes-side and every by-name route still addresses them; they are simply left off
   *  the roster this gateway serves, which is how a box whose Hermes also runs automation profiles
   *  shows a phone only the bots that belong on it. The filter lives here, in the single function
   *  that builds a roster, so `GET /bots` and the `bot_roster` frame cannot disagree about what is
   *  on it. Names are compared already-normalized (lowercase), as Hermes stores them. */
  hidden?: ReadonlySet<string>;
}

/** Builds the dashboard control-plane roster. The native attach-v1 plane overlays each configured
 * bot's local conversation identity, activity, and preview. */
export function buildRoster(profiles: ParsedProfile[], opts: RosterBuildOptions): BotSummary[] {
  const visible = opts.hidden === undefined ? profiles : profiles.filter((p) => !opts.hidden?.has(p.name));
  const rows = visible.map((profile) => {
    const meta = profile.meta;
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
      chatSessionId: null,
      preview: classifyPreview(profile.preview, profile.description),
      syncState: "setup_required",
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

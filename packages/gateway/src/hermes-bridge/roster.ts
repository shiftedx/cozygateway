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
  const record = asRecord(uiMeta);
  if (record === undefined) return null;
  const namespaced = asRecord(record[UI_META_KEY]);
  if (namespaced !== undefined) return namespaced;
  const LEGACY_FIELDS = ["shape", "color", "title", "chat", "pinned", "group", "created", "custom", "pet"];
  const hasLegacyField = LEGACY_FIELDS.some((field) => field in record);
  return hasLegacyField ? record : null;
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
  /** Canonical-chat pins the gateway holds locally, by profile name. A local pin wins over
   *  `meta.chat` only when the server blob carries none: an omitted `chat` on the server side is
   *  an authoritative deletion (dissection 3.2), so it must not be resurrected from cache. */
  pins: ReadonlyMap<string, string>;
}

/** Builds the merged roster: profiles plus their `ui_meta` blob, preview classification, presence
 *  flag, and the canonical-chat pointer, sorted pinned-first then most-recently-active. Search
 *  never re-ranks, so this is the one ordering the app renders. */
export function buildRoster(profiles: ParsedProfile[], opts: RosterBuildOptions): BotSummary[] {
  const rows = profiles.map((profile) => {
    const meta = profile.meta;
    const serverChat = asString(meta?.["chat"]);
    const hasChatKey = meta !== null && "chat" in meta;
    const chatSessionId = serverChat ?? (hasChatKey ? null : (opts.pins.get(profile.name) ?? null));
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

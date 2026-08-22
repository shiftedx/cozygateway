import { describe, expect, it } from "vitest";
import {
  ACTIVE_WINDOW_S, botActivityAt, botDisplayName, botHandle, botMetaForWriteback,
  buildRoster, classifyPreview, extractBotMeta, isBotActive, parseProfilesList,
  uiMetaBytes, UI_META_MAX_BYTES,
} from "../src/hermes-bridge/roster.ts";

const NOW = 1_800_000_000_000;
const idle = { routedProfile: null, gatewayState: "open" as const, now: NOW };
const profileRow = (over: Record<string, unknown> = {}) =>
  ({ name: "scout", description: "a helpful bot", has_avatar: false, ...over });
const lastSession = (secondsAgo: number, preview?: string) =>
  ({ last_active: Math.round(NOW / 1000) - secondsAgo, ...(preview === undefined ? {} : { preview }) });

describe("Hermes roster", () => {
  it("decodes profile metadata and seconds timestamps", () => {
    const { profiles } = parseProfilesList({
      profiles: [profileRow({ last_session: lastSession(10), ui_meta: { "hermes-bots": { created: NOW - 5_000 } } })],
      bot_mode_protocol: true,
    });
    expect(profiles[0]).toMatchObject({ lastActiveAt: NOW - 10_000, meta: { created: NOW - 5_000 } });
    expect(parseProfilesList({}).profiles).toEqual([]);
  });

  it("uses profile state until the native plane overlays its chat", () => {
    const [bot] = buildRoster(parseProfilesList({
      profiles: [profileRow({ last_session: lastSession(5, "ready"), ui_meta: { "hermes-bots": { title: "Scout", group: "Ops", pinned: true } } })],
    }).profiles, idle);
    expect(bot).toMatchObject({
      name: "scout", displayName: "Scout", group: "Ops", pinned: true,
      active: true, lastActiveAt: NOW - 5_000, chatSessionId: null,
      preview: { kind: "plain", text: "ready" },
    });
  });

  it("classifies a2a previews and uses stable display names", () => {
    expect(classifyPreview("Message from 🤖 luna (@luna): done", null)).toEqual({ kind: "a2a", text: "done", sender: "luna" });
    expect(botHandle("default")).toBe("hermes");
    expect(botDisplayName("night_owl-scout", null)).toBe("Night Owl Scout");
    expect(extractBotMeta({ "hermes-bots": { title: "Scout" } })).toEqual({ title: "Scout" });
  });

  it("keeps the strict activity window and pinned sort", () => {
    expect(ACTIVE_WINDOW_S).toBe(90);
    expect(isBotActive({ name: "scout", lastActiveAt: NOW - 89_000 }, idle)).toBe(true);
    expect(isBotActive({ name: "scout", lastActiveAt: NOW - 90_000 }, idle)).toBe(false);
    const roster = buildRoster(parseProfilesList({ profiles: [
      profileRow({ name: "stale", last_session: lastSession(3_000) }),
      profileRow({ name: "fresh", last_session: lastSession(2) }),
      profileRow({ name: "pinned-old", last_session: lastSession(9_000), ui_meta: { "hermes-bots": { pinned: true } } }),
    ] }).profiles, idle);
    expect(roster.map((bot) => bot.name)).toEqual(["pinned-old", "fresh", "stale"]);
    expect(botActivityAt(parseProfilesList({ profiles: [profileRow({ ui_meta: { "hermes-bots": { created: NOW - 1_000 } } })] }).profiles[0]!)).toBe(NOW - 1_000);
  });

  it("preserves compact UI metadata writes", () => {
    const meta = botMetaForWriteback({ "hermes-bots": { title: "Scout", image: "data:image/png;base64,AAAA" } }, { group: "Ops" });
    expect(meta).toEqual({ title: "Scout", group: "Ops" });
    expect(uiMetaBytes(meta!)).toBeLessThanOrEqual(UI_META_MAX_BYTES);
    expect(botMetaForWriteback({ "hermes-bots": { title: "x".repeat(UI_META_MAX_BYTES) } }, { group: "Ops" })).toBeNull();
  });
});

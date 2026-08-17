import { describe, expect, it } from "vitest";

import {
  ACTIVE_WINDOW_S,
  botActivityAt,
  botDisplayName,
  botHandle,
  buildRoster,
  classifyPreview,
  extractBotMeta,
  isBotActive,
  parseProfilesList,
} from "../src/hermes-bridge/roster.ts";

const NOW = 1_800_000_000_000; // milliseconds

function profileRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "scout",
    description: "a helpful bot",
    has_avatar: false,
    ...over,
  };
}

/** Builds a last_session block whose last_active is `secondsAgo` in the past. The wire value is
 *  SECONDS, which is the whole point of these fixtures. */
function lastSession(secondsAgo: number, preview?: string): Record<string, unknown> {
  return {
    last_active: Math.round(NOW / 1000) - secondsAgo,
    ...(preview === undefined ? {} : { preview }),
  };
}

const idle = { routedProfile: null, gatewayState: "open" as const, now: NOW, pins: new Map<string, string>() };

describe("profiles.list decoding", () => {
  it("converts last_active seconds to milliseconds and keeps meta.created in milliseconds", () => {
    const { profiles } = parseProfilesList({
      profiles: [profileRow({ last_session: lastSession(10), ui_meta: { "hermes-bots": { created: NOW - 5_000 } } })],
      bot_mode_protocol: true,
    });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.lastActiveAt).toBe(NOW - 10_000);
    expect(profiles[0]!.meta).toEqual({ created: NOW - 5_000 });
  });

  it("drops unusable rows and tolerates a response with no profiles array", () => {
    expect(parseProfilesList({ profiles: [{ nope: true }, 7, null] }).profiles).toEqual([]);
    expect(parseProfilesList({}).profiles).toEqual([]);
    expect(parseProfilesList(undefined).botModeProtocol).toBe(false);
  });
});

describe("ui_meta extraction", () => {
  it("reads the namespaced blob when present", () => {
    expect(extractBotMeta({ "hermes-bots": { title: "Scout" }, other: { x: 1 } })).toEqual({ title: "Scout" });
  });

  it("returns null when ui_meta is absent or carries no bot fields", () => {
    expect(extractBotMeta(undefined)).toBeNull();
    expect(extractBotMeta({})).toBeNull();
    expect(extractBotMeta({ "some-other-plugin": { a: 1 } })).toBeNull();
  });

  it("adopts a legacy flat ui_meta written before the namespace existed", () => {
    expect(extractBotMeta({ title: "Old Scout", chat: "sess-1", shape: "cloud" })).toEqual({
      title: "Old Scout",
      chat: "sess-1",
      shape: "cloud",
    });
  });
});

describe("handles and display names", () => {
  it("maps the default profile to @hermes and the Hermes label", () => {
    expect(botHandle("default")).toBe("hermes");
    expect(botDisplayName("default", null)).toBe("Hermes");
    expect(botDisplayName("default", { title: "Home Base" })).toBe("Home Base");
  });

  it("title cases a profile name with separators", () => {
    expect(botDisplayName("night_owl-scout", null)).toBe("Night Owl Scout");
    expect(botHandle("night_owl")).toBe("night_owl");
  });
});

describe("preview classification", () => {
  it("strips the bot-to-bot prefix and keeps the sender", () => {
    const preview = classifyPreview("Message from 🤖 luna (@luna): the build is green", null);
    expect(preview).toEqual({ kind: "a2a", text: "the build is green", sender: "luna" });
  });

  it("handles the agent-quoted form", () => {
    expect(classifyPreview("Message from agent 'pip': done", null)).toEqual({
      kind: "a2a",
      text: "done",
      sender: "pip",
    });
  });

  it("falls back to the description, then to the empty state", () => {
    expect(classifyPreview(null, "keeps an eye on CI")).toEqual({ kind: "plain", text: "keeps an eye on CI" });
    expect(classifyPreview(null, null).kind).toBe("empty");
  });
});

describe("presence rule", () => {
  const bot = (secondsAgo: number | null) => ({
    name: "scout",
    lastActiveAt: secondsAgo === null ? null : NOW - secondsAgo * 1000,
  });

  it("is active just inside the 90 second window and inactive just outside it", () => {
    expect(ACTIVE_WINDOW_S).toBe(90);
    expect(isBotActive(bot(89), { routedProfile: null, gatewayState: "open", now: NOW })).toBe(true);
    expect(isBotActive(bot(91), { routedProfile: null, gatewayState: "open", now: NOW })).toBe(false);
  });

  it("treats exactly 90 seconds as inactive, since the comparison is strict", () => {
    expect(isBotActive(bot(90), { routedProfile: null, gatewayState: "open", now: NOW })).toBe(false);
  });

  it("is active when the gateway is busy on this bot's own profile, however old the session is", () => {
    expect(isBotActive(bot(10_000), { routedProfile: "scout", gatewayState: "busy", now: NOW })).toBe(true);
  });

  it("is not active when the gateway is busy on a DIFFERENT profile", () => {
    expect(isBotActive(bot(10_000), { routedProfile: "luna", gatewayState: "busy", now: NOW })).toBe(false);
  });

  it("is not active with no session at all", () => {
    expect(isBotActive(bot(null), { routedProfile: null, gatewayState: "open", now: NOW })).toBe(false);
  });
});

describe("roster build", () => {
  it("merges ui_meta, preview, presence and the chat pin", () => {
    const { profiles } = parseProfilesList({
      profiles: [
        profileRow({
          name: "scout",
          has_avatar: true,
          last_session: lastSession(5, "Message from 🤖 luna (@luna): ping"),
          ui_meta: { "hermes-bots": { title: "Scout", group: "Ops", pinned: true, chat: "sess-9" } },
        }),
      ],
    });
    const [bot] = buildRoster(profiles, idle);
    expect(bot).toMatchObject({
      name: "scout",
      displayName: "Scout",
      handle: "scout",
      hasAvatar: true,
      group: "Ops",
      pinned: true,
      active: true,
      chatSessionId: "sess-9",
      preview: { kind: "a2a", text: "ping", sender: "luna" },
    });
  });

  it("uses the local pin only when the server blob carries no chat key at all", () => {
    const pins = new Map([
      ["nopin", "local-1"],
      ["cleared", "local-2"],
    ]);
    const { profiles } = parseProfilesList({
      profiles: [
        profileRow({ name: "nopin", ui_meta: { "hermes-bots": { title: "No Pin" } } }),
        profileRow({ name: "cleared", ui_meta: { "hermes-bots": { chat: null } } }),
      ],
    });
    const roster = buildRoster(profiles, { ...idle, pins });
    const byName = new Map(roster.map((bot) => [bot.name, bot]));
    expect(byName.get("nopin")!.chatSessionId).toBe("local-1");
    // An omitted chat on the server is an authoritative deletion: the cache must not resurrect it.
    expect(byName.get("cleared")!.chatSessionId).toBeNull();
  });

  it("orders pinned bots first, then by most recent activity", () => {
    const { profiles } = parseProfilesList({
      profiles: [
        profileRow({ name: "stale", last_session: lastSession(3_000) }),
        profileRow({ name: "fresh", last_session: lastSession(2) }),
        profileRow({
          name: "pinned-old",
          last_session: lastSession(9_000),
          ui_meta: { "hermes-bots": { pinned: true } },
        }),
        profileRow({ name: "brandnew", ui_meta: { "hermes-bots": { created: NOW - 1_000 } } }),
      ],
    });
    expect(buildRoster(profiles, idle).map((bot) => bot.name)).toEqual([
      "pinned-old",
      "brandnew",
      "fresh",
      "stale",
    ]);
  });

  it("ranks a freshly created bot by meta.created, in milliseconds", () => {
    const { profiles } = parseProfilesList({
      profiles: [profileRow({ ui_meta: { "hermes-bots": { created: NOW - 1_000 } }, last_session: lastSession(500) })],
    });
    expect(botActivityAt(profiles[0]!)).toBe(NOW - 1_000);
  });

  it("handles a roster with no ui_meta anywhere", () => {
    const { profiles } = parseProfilesList({ profiles: [profileRow({ name: "bare" })] });
    const [bot] = buildRoster(profiles, idle);
    expect(bot).toMatchObject({ meta: null, group: null, pinned: false, chatSessionId: null });
  });
});

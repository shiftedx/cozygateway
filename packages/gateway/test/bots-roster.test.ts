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
  botMetaForWriteback,
  resolveChatPin,
  uiMetaBytes,
  UI_META_MAX_BYTES,
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

type PinEntries = Map<string, { sessionId: string; updatedAt: number }>;

/** Local pins as the storage hands them over: a session id plus the stamp of the write. `OLD_PIN`
 *  is older than the snapshot `idle` describes, so an authoritative clear outranks it. */
const OLD_PIN = NOW - 10_000;
const pinEntries = (entries: Record<string, string>, updatedAt = OLD_PIN): PinEntries =>
  new Map(Object.entries(entries).map(([name, sessionId]) => [name, { sessionId, updatedAt }]));

const idle = {
  routedProfile: null,
  gatewayState: "open" as const,
  now: NOW,
  pins: new Map() as PinEntries,
  canonicalSessions: new Map(),
};

function canonicalSession(
  name: string,
  row: {
    id: string;
    kind?: "conversation" | "cron" | "routine" | "group" | "a2a";
    lastActiveAt?: number;
    preview?: string | null;
  },
): Map<
  string,
  Array<{
    id: string;
    kind: "conversation" | "cron" | "routine" | "group" | "a2a";
    lastActiveAt: number;
    preview: string | null;
  }>
> {
  return new Map([
    [
      name,
      [
        {
          id: row.id,
          kind: row.kind ?? "conversation",
          lastActiveAt: row.lastActiveAt ?? NOW - 30_000,
          preview: row.preview ?? null,
        },
      ],
    ],
  ]);
}

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
          last_session: lastSession(5, "newer machine output"),
          ui_meta: { "hermes-bots": { title: "Scout", group: "Ops", pinned: true, chat: "sess-9" } },
        }),
      ],
    });
    const [bot] = buildRoster(profiles, {
      ...idle,
      canonicalSessions: canonicalSession("scout", { id: "sess-9", preview: "canonical reply" }),
    });
    expect(bot).toMatchObject({
      name: "scout",
      displayName: "Scout",
      handle: "scout",
      hasAvatar: true,
      group: "Ops",
      pinned: true,
      active: true,
      chatSessionId: "sess-9",
      lastActiveAt: NOW - 30_000,
      preview: { kind: "plain", text: "canonical reply" },
    });
  });

  it("uses only the pinned conversational session for preview and display time", () => {
    const { profiles } = parseProfilesList({
      profiles: [
        profileRow({
          description: "watches CI",
          last_session: lastSession(1, "Both zones are 79F. Tie rotation applied."),
          ui_meta: { "hermes-bots": { chat: "chat-1" } },
        }),
      ],
    });
    const [bot] = buildRoster(profiles, {
      ...idle,
      canonicalSessions: canonicalSession("scout", {
        id: "chat-1",
        preview: "the canonical reply",
        lastActiveAt: NOW - 60_000,
      }),
    });
    expect(bot).toMatchObject({
      active: true,
      lastActiveAt: NOW - 60_000,
      preview: { kind: "plain", text: "the canonical reply" },
    });
  });

  it("keeps an unlisted canonical chat empty instead of borrowing profile activity or description", () => {
    const { profiles } = parseProfilesList({
      profiles: [
        profileRow({
          description: "watches CI",
          last_session: lastSession(1, "cron output"),
          ui_meta: { "hermes-bots": { chat: "empty-chat" } },
        }),
      ],
    });
    const bot = buildRoster(profiles, idle)[0]!;
    expect(bot.active).toBe(true);
    expect(bot.lastActiveAt).toBeNull();
    expect(bot.preview.kind).toBe("empty");
    expect(bot.preview.text).not.toContain("cron output");
    expect(bot.preview.text).not.toContain("watches CI");
  });

  it.each(["cron", "routine", "group", "a2a"] as const)(
    "keeps a pinned %s session out of the roster preview",
    (kind) => {
      const { profiles } = parseProfilesList({
        profiles: [
          profileRow({
            last_session: lastSession(1, "machine output"),
            ui_meta: { "hermes-bots": { chat: "machine-session" } },
          }),
        ],
      });
      const bot = buildRoster(profiles, {
        ...idle,
        canonicalSessions: canonicalSession("scout", {
          id: "machine-session",
          kind,
          preview: "machine output",
        }),
      })[0]!;
      expect(bot.lastActiveAt).toBeNull();
      expect(bot.preview.kind).toBe("empty");
    },
  );

  it("uses the local pin only for a profile the server carries no bot blob for", () => {
    const pins = pinEntries({ blobless: "local-1", keyless: "local-2", cleared: "local-3" });
    const { profiles } = parseProfilesList({
      profiles: [
        profileRow({ name: "blobless" }),
        profileRow({ name: "keyless", ui_meta: { "hermes-bots": { title: "No Pin" } } }),
        profileRow({ name: "cleared", ui_meta: { "hermes-bots": { chat: null } } }),
      ],
    });
    const roster = buildRoster(profiles, { ...idle, pins });
    const byName = new Map(roster.map((bot) => [bot.name, bot]));
    expect(byName.get("blobless")!.chatSessionId).toBe("local-1");
    // The merge is a key-wise replace of the whole bot blob (dissection 3.2): with a blob present,
    // an absent `chat` key and an explicit `chat: null` are the same authoritative absence, and
    // neither may be resurrected from the cache.
    expect(byName.get("keyless")!.chatSessionId).toBeNull();
    expect(byName.get("cleared")!.chatSessionId).toBeNull();
  });

  it("keeps a pin written after the snapshot, so the roster agrees with the chat route", () => {
    // The chat route treats an absent `chat` key as authoritative ONLY about state the snapshot
    // could have seen; a pin this gateway wrote afterwards is newer, not contradicted. The roster
    // used to map that same blob to null, so `GET /bots` reported "no conversation" for the very
    // chat `GET /bots/:name/chat` was handing the app.
    const fresh = pinEntries({ scout: "stored-1" }, NOW + 1);
    const { profiles } = parseProfilesList({
      profiles: [profileRow({ name: "scout", ui_meta: { "hermes-bots": { title: "Scout" } } })],
    });
    expect(buildRoster(profiles, { ...idle, pins: fresh })[0]!.chatSessionId).toBe("stored-1");
    expect(resolveChatPin({ title: "Scout" }, { sessionId: "stored-1", updatedAt: NOW + 1 }, NOW)).toBeUndefined();
    // Older than the snapshot: the clear wins, and both surfaces say so.
    expect(resolveChatPin({ title: "Scout" }, { sessionId: "stored-1", updatedAt: OLD_PIN }, NOW)).toBeNull();
  });

  it("keeps a pin written after a snapshot that names a DIFFERENT session", () => {
    // Same rule, the case it used to miss (issue #88). A snapshot naming another session is exactly
    // as old as one naming none, and it beat the newer local pin every time: a reset repointed the
    // pin, the app read back inside the refresh debounce, and the cached blob handed it the session
    // the reset had just retired. Adoption then refused that retired chat and minted a third one,
    // throwing away the replacement the reset had made. Both surfaces must read the newer write.
    const fresh = pinEntries({ scout: "stored-2" }, NOW + 1);
    const { profiles } = parseProfilesList({
      profiles: [profileRow({ name: "scout", ui_meta: { "hermes-bots": { title: "Scout", chat: "stored-1" } } })],
    });
    expect(buildRoster(profiles, { ...idle, pins: fresh })[0]!.chatSessionId).toBe("stored-2");
    expect(
      resolveChatPin({ title: "Scout", chat: "stored-1" }, { sessionId: "stored-2", updatedAt: NOW + 1 }, NOW),
    ).toBeUndefined();
    // Older than the snapshot: the server's pin is the newer statement and wins, as it always did.
    expect(
      resolveChatPin({ title: "Scout", chat: "stored-1" }, { sessionId: "stored-2", updatedAt: OLD_PIN }, NOW),
    ).toBe("stored-1");
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

  it("drops hidden profiles, and only exactly those", () => {
    const { profiles } = parseProfilesList({
      profiles: [profileRow({ name: "scout" }), profileRow({ name: "ops-runner" }), profileRow({ name: "ops" })],
    });
    // Hiding is by exact profile name: a prefix match would also swallow `ops`.
    expect(buildRoster(profiles, { ...idle, hidden: new Set(["ops-runner"]) }).map((bot) => bot.name)).toEqual([
      "scout",
      "ops",
    ]);
    // No hide list at all leaves the roster untouched.
    expect(buildRoster(profiles, idle)).toHaveLength(3);
  });

  it("handles a roster with no ui_meta anywhere", () => {
    const { profiles } = parseProfilesList({ profiles: [profileRow({ name: "bare" })] });
    const [bot] = buildRoster(profiles, idle);
    expect(bot).toMatchObject({ meta: null, group: null, pinned: false, chatSessionId: null });
  });
});

describe("botMetaForWriteback", () => {
  it("strips the asset fields the desktop strips", () => {
    const meta = botMetaForWriteback(
      { "hermes-bots": { title: "Scout", group: "Ops", image: "data:image/png;base64,AAAA", pet: "cat", custom: "<svg/>" } },
      { chat: "stored-1" },
    );
    // ui_meta is capped and rides EVERY profiles.list, so data URLs never go there (dissection 3.1).
    expect(meta).toEqual({ title: "Scout", group: "Ops", chat: "stored-1" });
  });

  it("keeps namespaced keys it does not model", () => {
    const meta = botMetaForWriteback({ "hermes-bots": { title: "Scout", somethingNew: 7 } }, { chat: "stored-1" });
    expect(meta).toEqual({ title: "Scout", somethingNew: 7, chat: "stored-1" });
  });

  it("does not re-nest a legacy blob's foreign namespaces", () => {
    // A pre-namespace ui_meta IS the whole record, so a naive merge pushed another plugin's keys
    // (and possibly a data-URL avatar) under hermes-bots on every single chat open.
    const meta = botMetaForWriteback(
      { title: "Legacy", pinned: true, image: "data:image/png;base64,AAAA", "other-plugin": { keep: "out" } },
      { chat: "stored-1" },
    );
    expect(meta).toEqual({ title: "Legacy", pinned: true, chat: "stored-1" });
  });

  it("reduces to the compact fields rather than blowing the 64KB cap", () => {
    const huge = "x".repeat(UI_META_MAX_BYTES);
    const meta = botMetaForWriteback({ "hermes-bots": { title: "Scout", blob: huge } }, { chat: "stored-1" });
    expect(meta).toEqual({ title: "Scout", chat: "stored-1" });
    expect(uiMetaBytes(meta!)).toBeLessThanOrEqual(UI_META_MAX_BYTES);
  });

  it("refuses a blob that is over the cap even compacted", () => {
    const huge = "x".repeat(UI_META_MAX_BYTES);
    expect(botMetaForWriteback({ "hermes-bots": { title: huge } }, { chat: "stored-1" })).toBeNull();
  });
});

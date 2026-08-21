import { describe, expect, it } from "vitest";

import {
  CANONICAL_CHAT_TITLE,
  resolveCanonicalChat,
  type PinStore,
} from "../src/hermes-bridge/canonical-chat.ts";

/** The pin the server's `ui_meta` carries is three-valued, and each value means something
 *  different (dissection 3.2): a string is the pin, `null` is an authoritative CLEAR, and
 *  `undefined` is "the server knows nothing", the only case that may fall back to the local pin.
 *  These are unit tests because the difference is invisible until a desktop clears a pin. */

function pinStore(initial: Record<string, string> = {}): PinStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: (name) => map.get(name),
    set: (name, sessionId) => void map.set(name, sessionId),
    clear: (name) => void map.delete(name),
  };
}

function manualPinStore(sessionId: string, updatedAt: number): PinStore & {
  current: () => { sessionId: string; manual: boolean; updatedAt: number };
} {
  let row = { sessionId, manual: true, updatedAt };
  return {
    get: () => row.sessionId,
    entry: () => row,
    set: (_name, next) => {
      if (next !== row.sessionId) row = { sessionId: next, manual: false, updatedAt: updatedAt + 1 };
    },
    clear: () => {},
    current: () => row,
  };
}

const SESSIONS = {
  sessions: [
    { id: "newest", title: "Debugging the deploy" },
    { id: "canonical", title: CANONICAL_CHAT_TITLE },
    { id: "server-pinned", title: "An older chat" },
    { id: "local-pinned", title: "Older still" },
  ],
};

function rpc(sessions: unknown = SESSIONS): {
  request: (method: string, params?: unknown) => Promise<unknown>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    request: async (method: string) => {
      calls.push(method);
      if (method === "session.list") return sessions;
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe("resolveCanonicalChat serverPin", () => {
  it("prefers the server pin over a different local pin", async () => {
    const pins = pinStore({ scout: "local-pinned" });
    const result = await resolveCanonicalChat("scout", {
      // The server pin is the NEWEST row here, deliberately. Which of two pins wins is the property
      // under test, and since issue #88 a pin that is outrun by a newer conversation is re-adopted
      // away from, which would answer this question with the other rule's answer. Re-adoption has
      // its own tests below.
      rpc: rpc({
        sessions: [
          { id: "server-pinned", title: "An older chat" },
          { id: "canonical", title: CANONICAL_CHAT_TITLE },
          { id: "local-pinned", title: "Older still" },
        ],
      }),
      pins,
      hideBotChats: true,
      serverPin: "server-pinned",
    });
    expect(result).toEqual({ sessionId: "server-pinned", adoption: "pin" });
    expect(pins.map.get("scout")).toBe("server-pinned");
  });

  it("treats a cleared server pin as authoritative and does not fall back to the local pin", async () => {
    const pins = pinStore({ scout: "local-pinned" });
    const result = await resolveCanonicalChat("scout", {
      rpc: rpc(),
      pins,
      hideBotChats: true,
      serverPin: null,
    });
    // A clear sends the bot back down the adoption path, which lands on the canonical title.
    expect(result).toEqual({ sessionId: "canonical", adoption: "title" });
    expect(pins.map.get("scout")).toBe("canonical");
  });

  it("falls back to the local pin only when the server knows nothing", async () => {
    const pins = pinStore({ scout: "local-pinned" });
    const result = await resolveCanonicalChat("scout", {
      // The local pin is the newest row, for the same reason the server-pin test puts its pin
      // first: whether the local record is consulted at all is the question, and re-adoption would
      // otherwise answer a different one.
      rpc: rpc({
        sessions: [
          { id: "local-pinned", title: "Older still" },
          { id: "canonical", title: CANONICAL_CHAT_TITLE },
        ],
      }),
      pins,
      hideBotChats: true,
      serverPin: undefined,
    });
    expect(result).toEqual({ sessionId: "local-pinned", adoption: "pin" });
  });

  it("re-pins the newest session when a cleared server pin meets no canonical title", async () => {
    const pins = pinStore({ scout: "local-pinned" });
    const bare = {
      request: async (method: string) =>
        method === "session.list"
          ? { sessions: [{ id: "newest", title: "x" }, { id: "older", title: "y" }] }
          : Promise.reject(new Error(`unexpected method ${method}`)),
    };
    const result = await resolveCanonicalChat("scout", {
      rpc: bare,
      pins,
      hideBotChats: true,
      serverPin: null,
    });
    expect(result).toEqual({ sessionId: "newest", adoption: "latest" });
  });
});

/** Re-adoption (issue #88): the pin FOLLOWS the bot's latest conversational session. These are unit
 *  tests because the whole rule is a question about one `session.list` page -- which rows count as
 *  conversation, and which of them outranks the pin -- and a fake Hermes cannot make that question
 *  any sharper than four plain objects can. The wire-level half (the socket announcement, the
 *  agreement with `GET /bots`) is in bots-chat-readoption.test.ts. */
describe("resolveCanonicalChat re-adoption", () => {
  const pinned = { id: "pinned", title: CANONICAL_CHAT_TITLE };

  /** Every exclusion is a session kind that a MACHINE wrote into the bot's history. Each row here
   *  sits above the pin, so a rule that fails to exclude it re-adopts it and the test fails loudly
   *  rather than by omission. */
  const excluded: Array<{ what: string; row: Record<string, unknown> }> = [
    { what: "a cron session by source", row: { id: "s-1", title: "Nightly digest · Aug 20 03:00", source: "cron" } },
    { what: "a cron session by id shape when source is missing", row: { id: "cron_job7_1755600000", title: "Nightly digest · Aug 20 03:00" } },
    { what: "a delegated routine run", row: { id: "s-2", title: "Routine: Nightly digest", source: "cli" } },
    { what: "a group room session", row: { id: "s-3", title: "Group: Release Room" } },
    {
      what: "a bot-to-bot delivery",
      row: { id: "s-4", title: "Chat", preview: "Message from agent 'pixel': deploy is green" },
    },
    {
      what: "a bot-to-bot delivery in the emoji spelling",
      row: { id: "s-5", title: "Chat", preview: "Message from 🤖 pixel: deploy is green" },
    },
  ];

  it("re-adopts a newer conversational session and reports what it left", async () => {
    const pins = pinStore({ scout: "pinned" });
    const result = await resolveCanonicalChat("scout", {
      rpc: rpc({ sessions: [{ id: "desktop", title: "Chat with scout" }, pinned] }),
      pins,
      hideBotChats: true,
      serverPin: "pinned",
    });
    // The existing adoption vocabulary, deliberately: "latest" already means "the newest session",
    // and this is that rule applied a second time rather than a new one.
    expect(result).toEqual({ sessionId: "desktop", adoption: "latest", previousSessionId: "pinned" });
    expect(pins.map.get("scout")).toBe("desktop");
  });

  it("holds the pin when it is already the newest conversation", async () => {
    const pins = pinStore({ scout: "pinned" });
    const result = await resolveCanonicalChat("scout", {
      rpc: rpc({ sessions: [pinned, { id: "older", title: "Chat with scout" }] }),
      pins,
      hideBotChats: true,
      serverPin: "pinned",
    });
    expect(result).toEqual({ sessionId: "pinned", adoption: "pin" });
  });

  it("holds a manual selection past existing conversations and resumes for the next new one", async () => {
    const selectedAt = 1_800_000_000_000;
    const pins = manualPinStore("older", selectedAt);
    const existing = { id: "existing", title: "Existing", created_at: selectedAt / 1000 - 1 };
    const selected = { id: "older", title: "Older", created_at: selectedAt / 1000 - 10 };

    expect(
      await resolveCanonicalChat("scout", {
        rpc: rpc({ sessions: [existing, selected] }),
        pins,
        hideBotChats: true,
        serverPin: "older",
      }),
    ).toEqual({ sessionId: "older", adoption: "pin" });
    expect(pins.current()).toMatchObject({ sessionId: "older", manual: true });

    expect(
      await resolveCanonicalChat("scout", {
        rpc: rpc({
          sessions: [
            { id: "next", title: "Next", created_at: selectedAt / 1000 + 1 },
            existing,
            selected,
          ],
        }),
        pins,
        hideBotChats: true,
        serverPin: "older",
      }),
    ).toEqual({ sessionId: "next", adoption: "latest", previousSessionId: "older" });
    expect(pins.current()).toMatchObject({ sessionId: "next", manual: false });
  });

  for (const { what, row } of excluded) {
    it(`never re-adopts ${what}`, async () => {
      const pins = pinStore({ scout: "pinned" });
      const result = await resolveCanonicalChat("scout", {
        rpc: rpc({ sessions: [row, pinned] }),
        pins,
        hideBotChats: true,
        serverPin: "pinned",
      });
      expect(result).toEqual({ sessionId: "pinned", adoption: "pin" });
      expect(pins.map.get("scout")).toBe("pinned");
    });
  }

  it("skips past machine sessions to the newest conversation underneath them", async () => {
    const pins = pinStore({ scout: "pinned" });
    const result = await resolveCanonicalChat("scout", {
      rpc: rpc({
        sessions: [
          { id: "cron_job7_1755600000", title: "Nightly digest · Aug 20 03:00", source: "cron" },
          { id: "desktop", title: "Chat with scout" },
          pinned,
        ],
      }),
      pins,
      hideBotChats: true,
      serverPin: "pinned",
    });
    expect(result).toEqual({ sessionId: "desktop", adoption: "latest", previousSessionId: "pinned" });
  });

  it("never re-adopts a session a reset retired, however new it looks", async () => {
    const pins = pinStore({ scout: "pinned" });
    const result = await resolveCanonicalChat("scout", {
      rpc: rpc({ sessions: [{ id: "cleared", title: CANONICAL_CHAT_TITLE }, pinned] }),
      pins,
      hideBotChats: true,
      serverPin: "pinned",
      isRetired: (id) => id === "cleared",
    });
    expect(result).toEqual({ sessionId: "pinned", adoption: "pin" });
  });

  it("does not re-adopt on behalf of a chat a reset just minted", async () => {
    // The replacement a reset pins has no row in `session.list` until the user writes in it, so the
    // resolve never reaches the re-adoption branch at all: it goes down the pin-not-listed arm,
    // where the retired conversation is not a candidate either. This is the ordering the cozychat
    // work surfaced, asserted as behaviour rather than as a comment.
    const pins = pinStore({ scout: "fresh" });
    const result = await resolveCanonicalChat("scout", {
      rpc: rpc({ sessions: [{ id: "cleared", title: CANONICAL_CHAT_TITLE }] }),
      pins,
      hideBotChats: true,
      serverPin: "fresh",
      isRetired: (id) => id === "cleared",
    });
    expect(result).toEqual({ sessionId: "fresh", adoption: "pin" });
    expect(pins.map.get("scout")).toBe("fresh");
  });
});

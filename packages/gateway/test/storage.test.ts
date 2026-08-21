import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { addColumnIfMissing, openStorage } from "../src/storage.ts";

function seeded() {
  const storage = openStorage(":memory:");
  storage.upsertAgent({ id: "a1", name: "Mock", avatar: null, backend: "mock" });
  storage.createThread({ id: "t1", agentId: "a1", title: "First", createdAt: 100 });
  return storage;
}

describe("setup codes", () => {
  it("consumes a live code exactly once", () => {
    const storage = openStorage(":memory:");
    storage.createSetupCode("CODE", 1_000);
    expect(storage.consumeSetupCode("CODE", 500)).toBe("ok");
    expect(storage.consumeSetupCode("CODE", 501)).toBe("invalid");
  });
  it("rejects expired and unknown codes", () => {
    const storage = openStorage(":memory:");
    storage.createSetupCode("CODE", 1_000);
    expect(storage.consumeSetupCode("CODE", 1_001)).toBe("invalid");
    expect(storage.consumeSetupCode("NOPE", 0)).toBe("invalid");
  });
});

describe("devices", () => {
  it("stores, finds by token hash, and deletes", () => {
    const storage = openStorage(":memory:");
    storage.createDevice({ id: "d1", name: "Phone", tokenHash: "h1", createdAt: 1 });
    expect(storage.deviceByTokenHash("h1")?.id).toBe("d1");
    expect(storage.deleteDevice("d1")).toBe(true);
    expect(storage.deviceByTokenHash("h1")).toBeUndefined();
    expect(storage.deleteDevice("d1")).toBe(false);
  });
});

describe("messages", () => {
  it("allocates gapless per-thread seq starting at 1", () => {
    const storage = seeded();
    const m1 = storage.appendMessage("t1", { role: "user", blocks: [{ type: "paragraph", text: "one" }] }, 200);
    const m2 = storage.appendMessage("t1", { role: "agent", blocks: [{ type: "paragraph", text: "two" }], turnId: "turn-1" }, 300);
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(m2.turnId).toBe("turn-1");
    expect(storage.threadById("t1")?.lastMessageAt).toBe(300);
  });

  it("seq is independent per thread", () => {
    const storage = seeded();
    storage.createThread({ id: "t2", agentId: "a1", title: "Second", createdAt: 100 });
    storage.appendMessage("t1", { role: "user", blocks: [] }, 1);
    const other = storage.appendMessage("t2", { role: "user", blocks: [] }, 2);
    expect(other.seq).toBe(1);
  });

  it("messagesSince replays ascending above the mark", () => {
    const storage = seeded();
    for (let i = 0; i < 5; i++) {
      storage.appendMessage("t1", { role: "user", blocks: [{ type: "paragraph", text: String(i) }] }, i);
    }
    const replay = storage.messagesSince("t1", 2);
    expect(replay.map((m) => m.seq)).toEqual([3, 4, 5]);
  });

  it("messagesBefore pages backwards but returns ascending", () => {
    const storage = seeded();
    for (let i = 0; i < 5; i++) {
      storage.appendMessage("t1", { role: "user", blocks: [] }, i);
    }
    expect(storage.messagesBefore("t1", null, 2).map((m) => m.seq)).toEqual([4, 5]);
    expect(storage.messagesBefore("t1", 4, 2).map((m) => m.seq)).toEqual([2, 3]);
    expect(storage.messagesBefore("t1", 2, 5).map((m) => m.seq)).toEqual([1]);
  });

  it("round-trips marker messages", () => {
    const storage = seeded();
    const marker = storage.appendMessage(
      "t1",
      { role: "system", blocks: [{ type: "paragraph", text: "failed" }], turnId: "turn-9", marker: "turn.failed" },
      50,
    );
    expect(storage.messagesSince("t1", 0)[0]?.marker).toBe("turn.failed");
    expect(marker.marker).toBe("turn.failed");
  });
});

describe("push registrations", () => {
  it("lists and deletes push registrations", () => {
    const storage = openStorage(":memory:");
    storage.createDevice({ id: "d1", name: "phone", tokenHash: "h1", createdAt: 1 });
    storage.createDevice({ id: "d2", name: "tablet", tokenHash: "h2", createdAt: 2 });
    storage.savePushRegistration("d1", { pushId: "p1", relayUrl: "https://r.example", pushKey: "k1" });
    storage.savePushRegistration("d2", { pushId: "p2", relayUrl: "https://r.example/", pushKey: "k2" });
    expect(storage.pushRegistrations()).toEqual([
      { deviceId: "d1", pushId: "p1", relayUrl: "https://r.example", pushKey: "k1" },
      { deviceId: "d2", pushId: "p2", relayUrl: "https://r.example/", pushKey: "k2" },
    ]);
    storage.deletePushRegistration("d1");
    expect(storage.pushRegistrations()).toEqual([
      { deviceId: "d2", pushId: "p2", relayUrl: "https://r.example/", pushKey: "k2" },
    ]);
    storage.deletePushRegistration("d1");
  });
});

describe("threads", () => {
  it("archives out of the list but keeps lookup", () => {
    const storage = seeded();
    expect(storage.archiveThread("t1")).toBe(true);
    expect(storage.listThreads()).toHaveLength(0);
    expect(storage.threadById("t1")?.archivedAt).not.toBeNull();
  });
  it("renames", () => {
    const storage = seeded();
    expect(storage.renameThread("t1", "Renamed")).toBe(true);
    expect(storage.threadById("t1")?.title).toBe("Renamed");
    expect(storage.renameThread("missing", "x")).toBe(false);
  });
});

describe("bots cache", () => {
  const summary = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    displayName: name,
    handle: name,
    description: null,
    hasAvatar: false,
    group: null,
    pinned: false,
    active: false,
    lastActiveAt: null,
    chatSessionId: null,
    preview: { kind: "empty" as const, text: "" },
    meta: null,
    ...over,
  });

  it("stores the roster in build order and fully replaces it on the next refresh", () => {
    const storage = openStorage(":memory:");
    storage.replaceBotRoster(
      [
        { name: "b", summary: summary("b") },
        { name: "a", summary: summary("a") },
      ],
      500,
    );
    expect(storage.botRoster().bots.map((bot) => bot.name)).toEqual(["b", "a"]);
    expect(storage.botRoster().updatedAt).toBe(500);

    // A profile that disappeared from Hermes must disappear from the cache, not linger.
    storage.replaceBotRoster([{ name: "a", summary: summary("a") }], 600);
    expect(storage.botRoster().bots.map((bot) => bot.name)).toEqual(["a"]);
    expect(storage.botRoster().updatedAt).toBe(600);
  });

  it("reports an empty cache with a null stamp", () => {
    const storage = openStorage(":memory:");
    expect(storage.botRoster()).toEqual({ bots: [], updatedAt: null });
  });

  it("keeps canonical chat pins per bot, upserting and clearing", () => {
    const storage = openStorage(":memory:");
    storage.setBotChatPin("scout", "sess-1", 1);
    storage.setBotChatPin("luna", "sess-2", 1);
    storage.setBotChatPin("scout", "sess-3", 2);
    expect(storage.botChatPin("scout")).toBe("sess-3");
    expect([...storage.botChatPins().entries()].sort()).toEqual([
      ["luna", "sess-2"],
      ["scout", "sess-3"],
    ]);
    storage.clearBotChatPin("scout");
    expect(storage.botChatPin("scout")).toBeUndefined();
    storage.clearBotChatPin("scout");
  });

  it("keeps a manual pin boundary until an automatic adoption moves to another session", () => {
    const storage = openStorage(":memory:");
    storage.setBotChatPin("scout", "older", 100, true);
    storage.setBotChatPin("scout", "older", 200);
    expect(storage.botChatPinEntry("scout")).toEqual({
      sessionId: "older",
      updatedAt: 100,
      manual: true,
    });

    storage.setBotChatPin("scout", "next", 300);
    expect(storage.botChatPinEntry("scout")).toEqual({
      sessionId: "next",
      updatedAt: 300,
      manual: false,
    });
  });
});

describe("addColumnIfMissing", () => {
  function columnNames(db: DatabaseSync, table: string): string[] {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  it("adds the column to a fresh table", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE widgets (id TEXT PRIMARY KEY)");
    addColumnIfMissing(db, "widgets", "runtime_id", "TEXT");
    expect(columnNames(db, "widgets")).toContain("runtime_id");
  });

  it("is a no-op when the column is already there", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE widgets (id TEXT PRIMARY KEY, runtime_id TEXT)");
    db.exec("INSERT INTO widgets (id, runtime_id) VALUES ('w1', 'r1')");
    expect(() => addColumnIfMissing(db, "widgets", "runtime_id", "TEXT")).not.toThrow();
    expect(columnNames(db, "widgets")).toEqual(["id", "runtime_id"]);
    const row = db.prepare("SELECT runtime_id FROM widgets WHERE id = 'w1'").get() as { runtime_id: string };
    expect(row.runtime_id).toBe("r1");
  });

  it("propagates a non-duplicate-column ALTER failure instead of swallowing it", () => {
    const fakeDb = {
      exec: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      prepare: () => {
        throw new Error("prepare should not be reached when exec throws a real error");
      },
    } as unknown as DatabaseSync;
    expect(() => addColumnIfMissing(fakeDb, "widgets", "runtime_id", "TEXT")).toThrow(/database is locked/);
  });

  it("fails loudly if the column is still missing after a swallowed duplicate-column error", () => {
    // Simulates a driver that reports "duplicate column name" without the column actually being
    // present. The post-ALTER PRAGMA verification must catch this and refuse to silently continue.
    const fakeDb = {
      exec: () => {
        throw new Error("duplicate column name: runtime_id");
      },
      prepare: () => ({
        all: () => [],
      }),
    } as unknown as DatabaseSync;
    expect(() => addColumnIfMissing(fakeDb, "widgets", "runtime_id", "TEXT")).toThrow(
      /migration failed.*widgets\.runtime_id/,
    );
  });
});

describe("openStorage migrations", () => {
  it("boots a fresh in-memory DB with the migrated columns present", () => {
    const storage = openStorage(":memory:");
    // Surfacing through public behavior: setBotChatPin/botChatPin round-trip via bot_chat_pins,
    // which only works once runtime_id (and the rest of the additive migrations) has landed.
    storage.setBotChatPin("scout", "sess-1", 1);
    expect(storage.botChatPin("scout")).toBe("sess-1");
  });
});

describe("assistant chat attachment storage", () => {
  it("ingests already bound bytes and keeps the consumed-line marker after byte expiry", () => {
    const storage = openStorage(":memory:");
    const ttl = 14 * 24 * 60 * 60 * 1000;
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    storage.putBotChatAttachment(
      {
        fileId: "f".repeat(32),
        bot: "scout",
        sessionId: "canonical",
        messageId: "assistant-41",
        sourceKey: "digest-41",
        mime: "image/png",
        name: "photo.png",
        size: bytes.byteLength,
        bytes,
      },
      1_000,
      ttl,
    );
    expect(storage.botChatAttachmentsFor("canonical", "assistant-41", 0)).toEqual([
      expect.objectContaining({ fileId: "f".repeat(32) }),
    ]);
    expect(storage.botChatAssistantMediaKeys("canonical", "assistant-41")).toEqual(["digest-41"]);

    storage.sweepBotChatAttachments(1_000 + ttl + 1, ttl);
    expect(storage.botChatAttachmentsFor("canonical", "assistant-41", 1_001)).toEqual([]);
    expect(storage.botChatAssistantMediaKeys("canonical", "assistant-41")).toEqual(["digest-41"]);
  });
});

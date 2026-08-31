import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStorage } from "../src/storage.ts";

describe("delegation enrichment migration", () => {
  it("adds nullable enrichment columns to a pre-enrichment database without losing rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-delegation-migration-"));
    const path = join(directory, "gateway.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE bot_chat_delegations (
      bot TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      batch_id TEXT NOT NULL, child_id TEXT NOT NULL, child_index INTEGER NOT NULL,
      batch_count INTEGER NOT NULL, alias_id TEXT, label TEXT, status TEXT NOT NULL,
      current_tool TEXT, api_calls INTEGER, tool_count INTEGER,
      last_active_at INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
      PRIMARY KEY (bot, turn_id, batch_id, child_id)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO bot_chat_delegations VALUES
      ('sage','session','turn','batch','child',0,1,NULL,'work','succeeded',NULL,NULL,NULL,5,4,6);`);
    legacy.close();

    const storage = openStorage(path);
    expect(storage.botChatDelegations("session", 0)[0]).toMatchObject({
      childId: "child", status: "succeeded", costUsd: null, schemaValid: null, durationMs: null,
    });
    storage.upsertBotChatDelegation({
      bot: "sage", sessionId: "session", turnId: "turn", batchId: "batch", childId: "child",
      index: 0, count: 1, status: "succeeded", lastActiveAt: 7, startedAt: 4, endedAt: 6,
      costUsd: 0.25, costStatus: "reported", schemaValidation: { valid: false, retries: 1 }, durationMs: 1250,
    });
    expect(storage.botChatDelegations("session", 0)[0]).toMatchObject({
      costUsd: 0.25, costStatus: "reported", schemaValid: 0, schemaRetries: 1, durationMs: 1250,
    });
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

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

});

describe("routine override metadata", () => {
  it("preserves absent versus null and supports explicit removal", () => {
    const storage = openStorage(":memory:");
    storage.setBotRoutineOverrides("scout", "job-1", { model: null, effort: "low" });
    expect(storage.botRoutineOverrides("scout", "job-1")).toEqual({ model: null, effort: "low" });

    storage.setBotRoutineOverrides("scout", "job-1", { effort: null });
    expect(storage.botRoutineOverrides("scout", "job-1")).toEqual({ effort: null });

    storage.deleteBotRoutineOverrides("scout", "job-1");
    expect(storage.botRoutineOverrides("scout", "job-1")).toBeUndefined();
  });
});

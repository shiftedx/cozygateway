import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CozyAppTree } from "cozygateway-contract";

import { cozyAppPhysicalId, openStorage } from "../src/storage.ts";

describe("setup code lifecycle", () => {
  it("keeps only the latest unpaired code and removes it when consumed", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-setup-code-lifecycle-"));
    const path = join(directory, "gateway.sqlite");
    const storage = openStorage(path);
    const now = Date.now();
    storage.createSetupCode("AAAA-BBBB", now + 60_000);
    storage.createSetupCode("CCCC-DDDD", now + 60_000);

    expect(storage.consumeSetupCode("AAAA-BBBB", now)).toBe("invalid");
    expect(storage.consumeSetupCode("CCCC-DDDD", now)).toBe("ok");
    storage.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM setup_codes").get()).toEqual({ count: 0 });
    raw.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("prunes expired and consumed legacy rows on startup while preserving a live code", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-setup-code-prune-"));
    const path = join(directory, "gateway.sqlite");
    openStorage(path).close();
    const now = Date.now();
    const raw = new DatabaseSync(path);
    raw.prepare("INSERT INTO setup_codes (code, expires_at, used_at) VALUES (?, ?, ?)").run("EXPIRED1", now - 1, null);
    raw.prepare("INSERT INTO setup_codes (code, expires_at, used_at) VALUES (?, ?, ?)").run("USED-CODE", now + 60_000, now - 1);
    raw.prepare("INSERT INTO setup_codes (code, expires_at, used_at) VALUES (?, ?, ?)").run("LIVE-CODE", now + 60_000, null);
    raw.close();

    openStorage(path).close();
    const repaired = new DatabaseSync(path, { readOnly: true });
    expect(repaired.prepare("SELECT code FROM setup_codes ORDER BY code").all()).toEqual([{ code: "LIVE-CODE" }]);
    repaired.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

function delegationWithCost(costUsd: number) {
  return {
    bot: "sage", sessionId: "session", turnId: "turn", batchId: "batch", childId: "child",
    index: 0, count: 1, status: "succeeded", lastActiveAt: 7, startedAt: 4, endedAt: 6,
    costUsd,
  };
}

describe("delegation enrichment migration", () => {
  it("enforces cost bounds in a fresh database", () => {
    const storage = openStorage(":memory:");
    expect(() => storage.upsertBotChatDelegation(delegationWithCost(-1))).toThrow();
    expect(() => storage.upsertBotChatDelegation(delegationWithCost(1_000_001))).toThrow();
    expect(() => storage.upsertBotChatDelegation(delegationWithCost(0))).not.toThrow();
    expect(() => storage.upsertBotChatDelegation(delegationWithCost(1_000_000))).not.toThrow();
    expect(storage.botChatDelegations("session", 0)[0]?.costUsd).toBe(1_000_000);
    storage.close();
  });

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
    expect(() => storage.upsertBotChatDelegation(delegationWithCost(-1))).toThrow();
    expect(() => storage.upsertBotChatDelegation(delegationWithCost(1_000_001))).toThrow();
    expect(() => storage.upsertBotChatDelegation(delegationWithCost(0))).not.toThrow();
    expect(() => storage.upsertBotChatDelegation(delegationWithCost(1_000_000))).not.toThrow();
    expect(storage.botChatDelegations("session", 0)[0]?.costUsd).toBe(1_000_000);
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("native transcript self-echo repair", () => {
  it("removes only legacy CozyGateway echoes paired with a direct desktop row", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-native-echo-repair-"));
    const path = join(directory, "gateway.sqlite");
    let storage = openStorage(path);
    const sessionId = storage.nativeBotChat("cleo", 1).sessionId;
    const append = (messageId: string, role: "user" | "assistant", text: string, at: number) =>
      storage.appendNativeBotMessage({ bot: "cleo", sessionId, messageId, role, text, at });

    append("desktop:cli:direct-user", "user", "Are those TRM jobs still open?", 10_000);
    append("desktop:cozygateway:echo-user", "user", "Are those TRM jobs still open?", 10_500);
    append("desktop:cozygateway:echo-assistant", "assistant", "Eight are still open.", 20_000);
    append("desktop:tui:direct-assistant", "assistant", "Eight are still open.", 20_750);
    append("desktop:cozygateway:echo-only", "assistant", "recover this unmatched row", 30_000);
    append("desktop:desktop:direct-only", "assistant", "keep this direct row", 40_000);
    append("desktop:cozygateway:outside-window", "assistant", "too far apart", 50_000);
    append("desktop:cli:outside-window-direct", "assistant", "too far apart", 51_001);
    storage.close();

    storage = openStorage(path);
    expect(storage.nativeBotMessages("cleo", sessionId).map((message) => message.id)).toEqual([
      "desktop:cli:direct-user",
      "desktop:tui:direct-assistant",
      "desktop:cozygateway:echo-only",
      "desktop:desktop:direct-only",
      "desktop:cozygateway:outside-window",
      "desktop:cli:outside-window-direct",
    ]);
    storage.close();

    // The repair is a startup migration: reopening does not delete unmatched recovery rows or
    // otherwise mutate already-repaired history.
    storage = openStorage(path);
    expect(storage.nativeBotMessages("cleo", sessionId).map((message) => message.id)).toEqual([
      "desktop:cli:direct-user",
      "desktop:tui:direct-assistant",
      "desktop:cozygateway:echo-only",
      "desktop:desktop:direct-only",
      "desktop:cozygateway:outside-window",
      "desktop:cli:outside-window-direct",
    ]);
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

describe("cozy apps", () => {
  const tree: CozyAppTree = { root: { id: "root", kind: "stack", children: [{ id: "go", kind: "button", label: "Go", actionId: "go", role: "primary" }] } };
  it("scopes idempotency by app and preserves a user rename on bot updates", () => {
    const storage = openStorage(":memory:");
    storage.upsertCozyApp({ id: "one", name: "One", creatorBot: "home:cleo", tree, now: 1 });
    storage.upsertCozyApp({ id: "two", name: "Two", creatorBot: "home:cleo", tree, now: 1 });
    storage.renameCozyApp("one", "My One", 2);
    storage.upsertCozyApp({ id: "one", name: "Bot Name", creatorBot: "home:cleo", tree, now: 3 });
    expect(storage.cozyApp("one")?.name).toBe("My One");
    const first = storage.createCozyAppAction({ id: "a1", appId: "one", creatorBot: "home:cleo", actionId: "go", idempotencyKey: "same", now: 3 }).action;
    const second = storage.createCozyAppAction({ id: "a2", appId: "two", creatorBot: "home:cleo", actionId: "go", idempotencyKey: "same", now: 3 }).action;
    expect(first.id).toBe("a1"); expect(second.id).toBe("a2");
    expect(storage.settleCozyAppAction({ id: "a1", appId: "one", creatorBot: "home:cleo", actionId: "go", status: "completed", now: 4 })).toBe(true);
    expect(storage.settleCozyAppAction({ id: "a1", appId: "two", creatorBot: "home:cleo", actionId: "go", status: "failed", now: 4 })).toBe(false);
    expect(storage.settleCozyAppAction({ id: "a1", appId: "one", creatorBot: "other:cleo", actionId: "go", status: "failed", now: 4 })).toBe(false);
    expect(() => storage.upsertCozyApp({ id: "one", name: "Hijack", creatorBot: "other:cleo", tree, now: 5 })).toThrow(/immutable/);
    expect(storage.deleteCozyApp("one")).toBe(true);
    expect(storage.cozyAppsSnapshot().actions.some((action) => action.id === "a1")).toBe(false);
    storage.close();
  });
  it("gives two creators distinct durable apps for the same logical id", () => {
    const storage = openStorage(":memory:");
    const cleo = cozyAppPhysicalId("home:cleo", "cowboys");
    const sage = cozyAppPhysicalId("home:sage", "cowboys");
    expect(cleo).not.toBe(sage);
    expect(cozyAppPhysicalId("home:cleo", cleo)).toBe(cleo);
    storage.upsertCozyApp({ id: cleo, name: "Cleo Cowboys", creatorBot: "home:cleo", tree, now: 1 });
    storage.upsertCozyApp({ id: sage, name: "Sage Cowboys", creatorBot: "home:sage", tree, now: 1 });
    storage.renameCozyApp(cleo, "My Cowboys", 2);
    storage.upsertCozyApp({ id: cleo, name: "ignored", creatorBot: "home:cleo", tree, now: 3 });
    expect(storage.listCozyApps().map((app) => app.id).sort()).toEqual([cleo, sage].sort());
    expect(storage.cozyApp(cleo)?.name).toBe("My Cowboys");
    const cleoAction = storage.createCozyAppAction({ id: "cleo-action", appId: cleo, creatorBot: "home:cleo", actionId: "go", idempotencyKey: "same", now: 4 }).action;
    const sageAction = storage.createCozyAppAction({ id: "sage-action", appId: sage, creatorBot: "home:sage", actionId: "go", idempotencyKey: "same", now: 4 }).action;
    expect(storage.settleCozyAppAction({ id: cleoAction.id, appId: cleoAction.appId, creatorBot: cleoAction.creatorBot, actionId: cleoAction.actionId, status: "completed", now: 5 })).toBe(true);
    expect(storage.settleCozyAppAction({ id: sageAction.id, appId: sageAction.appId, creatorBot: sageAction.creatorBot, actionId: sageAction.actionId, status: "failed", now: 5 })).toBe(true);
    storage.close();
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
    syncState: "setup_required" as const,
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

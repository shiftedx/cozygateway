import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CozyAppTree } from "cozygateway-contract";

import { cozyAppPhysicalId, openStorage } from "../src/storage.ts";

describe("setup code kinds (capability 52)", () => {
  it("migrates a database written before the kind column and reads its codes as device codes", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-setup-code-kind-"));
    const path = join(directory, "gateway.sqlite");
    // A database exactly as a pre-52 gateway left it: the table without the column.
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE setup_codes (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER) STRICT");
    legacy.prepare("INSERT INTO setup_codes (code, expires_at) VALUES (?, ?)").run("OLD1-CODE", Date.now() + 60_000);
    legacy.close();

    const storage = openStorage(path);
    const now = Date.now();
    // A row with no kind is a device code, which is what every code minted before 52 was.
    expect(storage.consumeSetupCode("OLD1-CODE", now, "runner")).toBe("invalid");
    expect(storage.consumeSetupCode("OLD1-CODE", now)).toBe("ok");
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps a runner code and a device code from being spent as each other", () => {
    const storage = openStorage(":memory:");
    const now = Date.now();
    storage.createSetupCode("RUNR-CODE", now + 60_000, "runner");
    expect(storage.consumeSetupCode("RUNR-CODE", now)).toBe("invalid");
    expect(storage.consumeSetupCode("RUNR-CODE", now, "runner")).toBe("ok");
    storage.createSetupCode("DEVC-CODE", now + 60_000);
    expect(storage.consumeSetupCode("DEVC-CODE", now, "runner")).toBe("invalid");
    expect(storage.consumeSetupCode("DEVC-CODE", now)).toBe("ok");
    storage.close();
  });
});

describe("durable gateway maintenance operations", () => {
  const input = (n = 1, requestId = `request-${n}`) => ({
    operationId: `maintenance_${n.toString(16).padStart(32, "0")}`,
    idempotencyKey: requestId,
    fingerprint: `restart:${requestId}`,
    action: "restart" as const,
    step: "gateway" as const,
    priorVersions: { gateway: "0.6.4" },
    now: n,
  });

  it("persists one maintenance operation across reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-maintenance-"));
    const path = join(directory, "gateway.sqlite");
    const storage = openStorage(path);
    const created = storage.createGatewayMaintenanceOperation(input());
    storage.close();
    const reopened = openStorage(path);
    expect(reopened.gatewayMaintenanceOperation(created.operationId)).toEqual(created);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns an existing operation for the same idempotency key", () => {
    const storage = openStorage(":memory:");
    const first = storage.createGatewayMaintenanceOperation(input());
    expect(storage.createGatewayMaintenanceOperation({ ...input(2, "request-1") })).toEqual(first);
    storage.close();
  });

  it("refuses two active maintenance operations", () => {
    const storage = openStorage(":memory:");
    storage.createGatewayMaintenanceOperation(input());
    expect(() => storage.createGatewayMaintenanceOperation(input(2))).toThrow("operation_in_progress");
    storage.close();
  });

  it("compare-and-set prevents a stale worker transition", () => {
    const storage = openStorage(":memory:");
    const operation = storage.createGatewayMaintenanceOperation(input());
    expect(storage.advanceGatewayMaintenanceOperation({
      operationId: operation.operationId,
      from: { status: "running", step: "gateway" },
      to: { status: "succeeded", step: "postflight", nextAction: "wait", completedAt: 3 },
      now: 3,
    })).toBe(false);
    expect(storage.gatewayMaintenanceOperation(operation.operationId)?.status).toBe("pending");
    storage.close();
  });

  it("terminal maintenance receipts retain only the newest 100", () => {
    const storage = openStorage(":memory:");
    for (let n = 1; n <= 102; n += 1) {
      const operation = storage.createGatewayMaintenanceOperation(input(n));
      expect(storage.advanceGatewayMaintenanceOperation({
        operationId: operation.operationId,
        from: { status: "pending", step: "gateway" },
        to: { status: "succeeded", step: "postflight", nextAction: "wait", completedAt: n },
        now: n,
      })).toBe(true);
    }
    expect(storage.gatewayMaintenanceOperation(input(1).operationId)).toBeUndefined();
    expect(storage.gatewayMaintenanceOperation(input(2).operationId)).toBeUndefined();
    expect(storage.gatewayMaintenanceOperation(input(3).operationId)).toBeDefined();
    storage.close();
  });

  it("operation JSON never contains fixture secrets", () => {
    const storage = openStorage(":memory:");
    const operation = storage.createGatewayMaintenanceOperation({
      ...input(), fingerprint: "restart:fixture-secret-token",
    });
    expect(JSON.stringify(operation)).not.toContain("fixture-secret-token");
    storage.close();
  });
});

describe("paired runners (capability 52)", () => {
  it("stores only a hash, keeps the token unique, and survives a restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-runners-"));
    const path = join(directory, "gateway.sqlite");
    const storage = openStorage(path);
    storage.createRunner({ id: "r1", name: "one", tokenHash: "hash-1", createdAt: 10, isDefault: true });
    storage.createRunner({ id: "r2", name: "two", tokenHash: "hash-2", createdAt: 20, isDefault: false });
    expect(() =>
      storage.createRunner({ id: "r3", name: "three", tokenHash: "hash-1", createdAt: 30, isDefault: false }),
    ).toThrow();
    storage.observeRunner("r2", { platform: "linux/x64", version: "0.1.0", backends: ["process"] });
    storage.touchRunner("r2", 99);
    storage.close();

    const reopened = openStorage(path);
    expect(reopened.listRunners().map((row) => row.id)).toEqual(["r1", "r2"]);
    expect(reopened.runner("r2")).toMatchObject({
      platform: "linux/x64", version: "0.1.0", backends: ["process"], lastSeenAt: 99, isDefault: false,
    });
    expect(reopened.runnerByTokenHash("hash-1")?.id).toBe("r1");
    expect(reopened.runnerByTokenHash("hash-missing")).toBeUndefined();

    // Moving the default clears the previous holder in the same transaction.
    expect(reopened.setDefaultRunner("r2")).toBe(true);
    expect(reopened.listRunners().filter((row) => row.isDefault).map((row) => row.id)).toEqual(["r2"]);
    expect(reopened.setDefaultRunner("nobody")).toBe(false);
    expect(reopened.listRunners().filter((row) => row.isDefault).map((row) => row.id)).toEqual(["r2"]);

    expect(reopened.deleteRunner("r1")).toBe(true);
    expect(reopened.deleteRunner("r1")).toBe(false);
    expect(reopened.countRunners()).toBe(1);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("leaves an unreported field alone rather than nulling it on the next hello", () => {
    const storage = openStorage(":memory:");
    storage.createRunner({ id: "r1", name: "one", tokenHash: "hash-1", createdAt: 10, isDefault: true });
    storage.observeRunner("r1", { platform: "darwin/arm64", version: "0.1.0", backends: ["process"] });
    // An older runner reconnecting reports nothing about itself; what it told us before stands.
    storage.observeRunner("r1", {});
    expect(storage.runner("r1")).toMatchObject({ platform: "darwin/arm64", version: "0.1.0", backends: ["process"] });
    storage.close();
  });
});

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

describe("capability 54 runner placement migration", () => {
  it("adds the runner column to a pre-54 database, reads its rows back, and reopens cleanly", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-runner-placement-migration-"));
    const path = join(directory, "gateway.sqlite");
    // The two tables exactly as a pre-54 gateway left them: no runner column anywhere.
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE runtime_bots (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, token TEXT NOT NULL UNIQUE,
      runtime TEXT NOT NULL CHECK (runtime IN ('cozyagents')),
      spec_generation INTEGER NOT NULL CHECK (spec_generation >= 1),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE runner_operations (
      operation_id TEXT PRIMARY KEY, bot TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('create_runtime', 'delete_runtime')),
      spec_generation INTEGER NOT NULL CHECK (spec_generation >= 1),
      payload_json TEXT NOT NULL, stage TEXT NOT NULL, code TEXT,
      observed_generation INTEGER, last_contact_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sent_at INTEGER
    ) STRICT;
    INSERT INTO runtime_bots VALUES ('sage','Sage',NULL,'token-sage','cozyagents',1,5);
    INSERT INTO runner_operations VALUES ('op_1','sage','create_runtime',1,'{}','waiting_for_runner',NULL,NULL,NULL,5,5,NULL);`);
    legacy.close();

    const storage = openStorage(path);
    // Every byte the row had, plus a runner nobody named. Backfilling one would be a guess: the
    // gateway never recorded which computer this bot was on, because it only had the one.
    expect(storage.runtimeBot("sage")).toMatchObject({ id: "sage", name: "Sage", runnerId: null });
    const unsent = storage.unsentRunnerOperations();
    expect(unsent).toHaveLength(1);
    expect(unsent[0]).toMatchObject({ operationId: "op_1", runnerId: null });
    // The unaddressed row is exactly what a named runner's queue does NOT take.
    expect(storage.unsentRunnerOperations({ runnerId: "runner-1" })).toEqual([]);
    expect(storage.unsentRunnerOperations({ runnerId: "runner-1", includeUnassigned: true })).toHaveLength(1);
    storage.close();

    // Idempotent on restart, which is what a container that comes back up does every time.
    const reopened = openStorage(path);
    expect(reopened.runtimeBot("sage")?.runnerId).toBeNull();
    reopened.insertRuntimeBot({
      id: "luna", name: "Luna", avatar: null, token: "token-luna",
      runtime: "cozyagents", specGeneration: 1, createdAt: 6, runnerId: "runner-1",
    });
    expect(reopened.countRuntimeBotsForRunner("runner-1")).toBe(1);
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("capability 55 runner display-name migration", () => {
  it("adds the display_name column to a pre-55 runners table, reads existing rows unrenamed, and reopens cleanly", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-runner-display-name-migration-"));
    const path = join(directory, "gateway.sqlite");
    // The `runners` table exactly as a pre-55 gateway left it: no `display_name` column at all.
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE runners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      platform TEXT,
      version TEXT,
      backends TEXT,
      is_default INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    ) STRICT;
    INSERT INTO runners VALUES ('runner-1','kyle-mbp','hash-1',NULL,NULL,NULL,1,5,NULL);`);
    legacy.close();

    const storage = openStorage(path);
    // Every byte the row had, plus a display name nobody set. Backfilling one would be a guess:
    // the gateway never recorded a person-set name for this row.
    expect(storage.runner("runner-1")).toMatchObject({
      id: "runner-1", name: "kyle-mbp", isDefault: true, displayName: null,
    });
    storage.close();

    // Idempotent on restart, which is what a container that comes back up does every time.
    const reopened = openStorage(path);
    expect(reopened.runner("runner-1")?.displayName).toBeNull();
    expect(reopened.setRunnerDisplayName("runner-1", "Kyle's Laptop")).toBe(true);
    reopened.close();

    // And idempotent again, with the write from the previous open intact.
    const reopenedAgain = openStorage(path);
    expect(reopenedAgain.runner("runner-1")?.displayName).toBe("Kyle's Laptop");
    reopenedAgain.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("capability 47 auditable-id migration", () => {
  it("adds the provenance columns to a pre-47 database and still reads its rows back", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-auditable-ids-migration-"));
    const path = join(directory, "gateway.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE bot_groups (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, members_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, epoch INTEGER NOT NULL, needs_you INTEGER NOT NULL,
      next_seq INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE bot_group_log (
      group_key TEXT NOT NULL, seq INTEGER NOT NULL, from_kind TEXT NOT NULL,
      from_name TEXT NOT NULL, display_name TEXT NOT NULL, text TEXT NOT NULL,
      at INTEGER NOT NULL, client_id TEXT, PRIMARY KEY (group_key, seq)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE bot_native_messages (
      bot TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      message_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER,
      client_id TEXT, attachments_json TEXT, marker TEXT,
      PRIMARY KEY (bot, session_id, seq), UNIQUE (bot, message_id)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO bot_groups VALUES ('launch','Launch','["scout","luna"]',1,1,0,3);
    INSERT INTO bot_group_log VALUES ('launch',1,'user','You','You','ship it?',5,NULL);
    INSERT INTO bot_group_log VALUES ('launch',2,'member','scout','Scout','shipping',6,NULL);
    INSERT INTO bot_native_messages VALUES ('sage','session',1,'old-1','assistant','done',7,NULL,NULL,NULL);`);
    legacy.close();

    const storage = openStorage(path);
    // A row written before 47 keeps every byte it had and simply carries none of the new ids.
    // Backfilling them would be a fabrication: the gateway never recorded them.
    expect(storage.botGroupLog("launch")).toEqual([
      { seq: 1, kind: "user", name: "You", displayName: "You", text: "ship it?", at: 5 },
      { seq: 2, kind: "member", name: "scout", displayName: "Scout", text: "shipping", at: 6 },
    ]);
    expect(storage.nativeBotMessage("sage", "old-1")).toEqual({
      id: "old-1", role: "assistant", text: "done", at: 7,
    });

    // The migrated database accepts the new columns on the very next write.
    const written = storage.appendBotGroupMessage("launch", {
      kind: "member", name: "luna", displayName: "Luna", text: "on it", at: 8,
      messageId: "msg-1", turnId: "turn-1", epoch: 1,
      cause: { kind: "user", seq: 1 },
      attachTurn: { threadId: "group:launch:luna", turnId: "turn-1" },
    });
    expect(written.seq).toBe(3);
    expect(storage.botGroupLog("launch").at(-1)).toMatchObject({
      messageId: "msg-1", turnId: "turn-1", epoch: 1,
      cause: { kind: "user", seq: 1 },
      attachTurn: { threadId: "group:launch:luna", turnId: "turn-1" },
    });
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

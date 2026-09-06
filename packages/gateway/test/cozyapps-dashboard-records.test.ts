import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStorage, type Storage } from "../src/storage.ts";

const stores: Storage[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const tree = { root: { id: "root", kind: "stack" as const, children: [] } };
const document = {
  title: "Market watchlist",
  sections: [{
    id: "main",
    components: [
      { kind: "input" as const, id: "ticker-input", label: "Ticker", valueRef: "ticker", valueType: "string" as const },
      { kind: "metric" as const, id: "quote-metric", label: "Last price", valueRef: "quote" },
    ],
  }],
};

function open(path = ":memory:"): Storage {
  const storage = openStorage(path);
  stores.push(storage);
  return storage;
}

function seed(storage: Storage, id = "sage:market"): string {
  storage.upsertCozyApp({ id, name: "Market", creatorBot: "sage", tree, now: 100 });
  return id;
}

describe("cozyapps v2 saved values", () => {
  it("writes a first value, bumps its own revision, and refuses a stale write with the current value", () => {
    const storage = open();
    const appId = seed(storage);
    const first = storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "AAPL", expectedRevision: 0, idempotencyKey: "tap-1", now: 200 });
    expect(first).toMatchObject({ outcome: "written", value: { appId, valueId: "ticker", type: "string", value: "AAPL", revision: 1, updatedAt: 200 } });
    const second = storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "MSFT", expectedRevision: 1, idempotencyKey: "tap-2", now: 210 });
    expect(second).toMatchObject({ outcome: "written", value: { value: "MSFT", revision: 2 } });
    const stale = storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "NVDA", expectedRevision: 1, idempotencyKey: "tap-3", now: 220 });
    expect(stale.outcome).toBe("conflict");
    expect(stale.value).toMatchObject({ value: "MSFT", revision: 2 });
    expect(storage.cozyAppValues(appId).map((entry) => entry.value)).toEqual(["MSFT"]);
  });

  it("replays an idempotency key with the prior result and writes nothing a second time", () => {
    const storage = open();
    const appId = seed(storage);
    storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "AAPL", expectedRevision: 0, idempotencyKey: "tap-1", now: 200 });
    const replay = storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "AAPL", expectedRevision: 0, idempotencyKey: "tap-1", now: 300 });
    expect(replay.outcome).toBe("replayed");
    expect(replay.value).toMatchObject({ value: "AAPL", revision: 1, updatedAt: 200 });
    // A replay of a key the first write already spent must not advance the revision, even though
    // the observed revision it carries is now stale.
    expect(storage.cozyAppValues(appId)).toHaveLength(1);
    expect(storage.cozyAppValues(appId)[0]).toMatchObject({ revision: 1 });
  });

  it("refuses a value that is not what its declared product field type admits", () => {
    const storage = open();
    const appId = seed(storage);
    expect(storage.writeCozyAppValue({ appId, valueId: "when", type: "date", value: "yesterday", expectedRevision: 0, idempotencyKey: "tap-1", now: 200 }).outcome).toBe("invalid_type");
    expect(storage.cozyAppValues(appId)).toHaveLength(0);
  });
});

describe("cozyapps v2 dashboard envelope", () => {
  it("round-trips the typed document through storage unchanged and revisions it on its own", () => {
    const storage = open();
    const appId = seed(storage);
    expect(storage.writeCozyAppDashboard({ appId, creatorBot: "sage", documentVersion: 1, document, expectedRevision: 0, now: 200 }).outcome).toBe("written");
    const stored = storage.cozyAppDashboard(appId)!;
    expect(JSON.stringify(stored.document)).toBe(JSON.stringify(document));
    expect(stored).toMatchObject({ id: appId, revision: 1, owner: "user", creatorBot: "sage", documentVersion: 1, data: {}, updatedAt: 200 });
    expect(storage.writeCozyAppDashboard({ appId, creatorBot: "sage", documentVersion: 1, document, expectedRevision: 0, now: 210 }).outcome).toBe("conflict");
    expect(storage.writeCozyAppDashboard({ appId, creatorBot: "sage", documentVersion: 1, document, expectedRevision: 1, now: 210 }).outcome).toBe("written");
    expect(storage.cozyAppDashboard(appId)?.revision).toBe(2);
  });

  it("lets only the creator write its own app's envelope", () => {
    const storage = open();
    const appId = seed(storage);
    storage.writeCozyAppDashboard({ appId, creatorBot: "sage", documentVersion: 1, document, expectedRevision: 0, now: 200 });
    expect(storage.writeCozyAppDashboard({ appId, creatorBot: "luna", documentVersion: 1, document, expectedRevision: 1, now: 210 }).outcome).toBe("forbidden");
    expect(storage.cozyAppDashboard(appId)?.creatorBot).toBe("sage");
  });

  it("writes source-attributed data only through the bot's own snapshot write", () => {
    const storage = open();
    const appId = seed(storage);
    storage.writeCozyAppDashboard({ appId, creatorBot: "sage", documentVersion: 1, document, expectedRevision: 0, now: 200 });
    storage.writeCozyAppDashboard({
      appId, creatorBot: "sage", documentVersion: 1, document, expectedRevision: 1, now: 220,
      data: { quote: { source: "quotes.example", asOf: 219, value: "214.35", state: "fresh" } },
    });
    expect(storage.cozyAppDashboard(appId)?.data).toEqual({ quote: { source: "quotes.example", asOf: 219, value: "214.35", state: "fresh" } });
  });
});

describe("cozyapps v2 action receipts", () => {
  it("presents the four public names and keeps the v1 action payload unchanged", () => {
    const storage = open();
    const appId = seed(storage);
    const { action } = storage.createCozyAppAction({
      id: "action-1", appId, creatorBot: "sage", actionId: "refresh", idempotencyKey: "tap-1", now: 200,
      appRevision: 1, valueRevisions: [{ valueId: "ticker", revision: 2 }],
    });
    expect(action.status).toBe("requested");
    expect(action).not.toHaveProperty("appRevision");
    expect(storage.cozyAppReceipts(appId)[0]).toMatchObject({
      id: "action-1", status: "queued", appRevision: 1, valueRevisions: [{ valueId: "ticker", revision: 2 }],
    });
    expect(storage.markCozyAppActionDelivered("action-1", "sage", 210)).toBe(true);
    expect(storage.cozyAppReceipts(appId)[0]).toMatchObject({ status: "running" });
    expect(storage.settleCozyAppAction({ id: "action-1", appId, creatorBot: "sage", actionId: "refresh", status: "completed", now: 220 })).toBe(true);
    expect(storage.cozyAppReceipts(appId)[0]).toMatchObject({ status: "completed" });
  });

  it("records the bot's source-attributed snapshot on the receipt and on no other path", () => {
    const storage = open();
    const appId = seed(storage);
    storage.createCozyAppAction({ id: "action-1", appId, creatorBot: "sage", actionId: "refresh", idempotencyKey: "tap-1", now: 200 });
    expect(storage.cozyAppReceipts(appId)[0]).not.toHaveProperty("data");
    storage.settleCozyAppAction({
      id: "action-1", appId, creatorBot: "sage", actionId: "refresh", status: "completed", now: 220,
      data: { quote: { source: "quotes.example", asOf: 219, value: "214.35", state: "fresh" } },
    });
    expect(storage.cozyAppReceipts(appId)[0]?.data).toEqual({ quote: { source: "quotes.example", asOf: 219, value: "214.35", state: "fresh" } });
  });

  it("keeps every receipt state across a process restart with no lost or duplicated terminal", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozyapps-receipts-"));
    directories.push(directory);
    const path = join(directory, "gateway.db");
    const first = open(path);
    const appId = seed(first);
    for (const [id, key] of [["queued-1", "k1"], ["running-1", "k2"], ["completed-1", "k3"], ["failed-1", "k4"]] as const)
      first.createCozyAppAction({ id, appId, creatorBot: "sage", actionId: "refresh", idempotencyKey: key, now: 200 });
    first.markCozyAppActionDelivered("running-1", "sage", 205);
    first.markCozyAppActionDelivered("completed-1", "sage", 205);
    first.settleCozyAppAction({ id: "completed-1", appId, creatorBot: "sage", actionId: "refresh", status: "completed", now: 210 });
    first.settleCozyAppAction({ id: "failed-1", appId, creatorBot: "sage", actionId: "refresh", status: "failed", now: 210 });
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const second = open(path);
    expect(Object.fromEntries(second.cozyAppReceipts(appId).map((receipt) => [receipt.id, receipt.status]))).toEqual({
      "queued-1": "queued", "running-1": "running", "completed-1": "completed", "failed-1": "failed",
    });
    // A terminal is written once. A duplicate settle after restart changes nothing and says so.
    expect(second.settleCozyAppAction({ id: "completed-1", appId, creatorBot: "sage", actionId: "refresh", status: "failed", now: 300 })).toBe(false);
    expect(second.markCozyAppActionDelivered("completed-1", "sage", 300)).toBe(false);
    expect(second.cozyAppReceipts(appId).find((receipt) => receipt.id === "completed-1")?.status).toBe("completed");
  });
});

describe("cozyapps v2 record cleanup", () => {
  it("purges values and the envelope with the app and with its creator bot", () => {
    const storage = open();
    const appId = seed(storage);
    storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "AAPL", expectedRevision: 0, idempotencyKey: "tap-1", now: 200 });
    storage.writeCozyAppDashboard({ appId, creatorBot: "sage", documentVersion: 1, document, expectedRevision: 0, now: 200 });
    expect(storage.deleteCozyApp(appId)).toBe(true);
    expect(storage.cozyAppValues(appId)).toHaveLength(0);
    expect(storage.cozyAppDashboard(appId)).toBeUndefined();

    const second = seed(storage, "sage:second");
    storage.writeCozyAppValue({ appId: second, valueId: "ticker", type: "string", value: "AAPL", expectedRevision: 0, idempotencyKey: "tap-1", now: 200 });
    storage.writeCozyAppDashboard({ appId: second, creatorBot: "sage", documentVersion: 1, document, expectedRevision: 0, now: 200 });
    storage.purgeBot("sage");
    expect(storage.cozyAppValues(second)).toHaveLength(0);
    expect(storage.cozyAppDashboard(second)).toBeUndefined();
    expect(storage.cozyApp(second)).toBeUndefined();
  });
});

/** Fix round 1, review r0 findings I1, I4 and I5 at the storage seam. */
describe("cozyapps v2 record hardening", () => {
  it("binds an idempotency key to its payload and refuses the same key for a different write", () => {
    const storage = open();
    const appId = seed(storage);
    expect(storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "AAPL", expectedRevision: 0, idempotencyKey: "k1", now: 200 }).outcome).toBe("written");
    // A true replay: same key, same observed revision, same value.
    const replay = storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "AAPL", expectedRevision: 0, idempotencyKey: "k1", now: 300 });
    expect(replay.outcome).toBe("replayed");
    expect(replay.value).toMatchObject({ value: "AAPL", revision: 1 });
    // The same key with a DIFFERENT payload is a conflict, never a silent 200 carrying the old value.
    const reused = storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "MSFT", expectedRevision: 1, idempotencyKey: "k1", now: 310 });
    expect(reused.outcome).toBe("conflict");
    expect(reused.value).toMatchObject({ value: "AAPL", revision: 1 });
    expect(storage.cozyAppValues(appId)[0]).toMatchObject({ value: "AAPL", revision: 1 });
    // A replay of a spent key after an intervening write no longer writes: its observed revision
    // is stale, so the revision check is what answers.
    expect(storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "MSFT", expectedRevision: 1, idempotencyKey: "k2", now: 320 }).outcome).toBe("written");
    expect(storage.writeCozyAppValue({ appId, valueId: "ticker", type: "string", value: "AAPL", expectedRevision: 0, idempotencyKey: "k1", now: 330 }).outcome).toBe("conflict");
    expect(storage.cozyAppValues(appId)[0]).toMatchObject({ value: "MSFT", revision: 2 });
  });

  it("enforces the saved value ceiling instead of letting an over-cap array reach the wire", () => {
    const storage = open();
    const appId = seed(storage);
    for (let index = 0; index < 64; index += 1)
      expect(storage.writeCozyAppValue({ appId, valueId: `v${index}`, type: "number", value: index, expectedRevision: 0, idempotencyKey: `k${index}`, now: 200 }).outcome).toBe("written");
    expect(storage.writeCozyAppValue({ appId, valueId: "v64", type: "number", value: 64, expectedRevision: 0, idempotencyKey: "k64", now: 200 }).outcome).toBe("limit_exceeded");
    expect(storage.cozyAppValues(appId)).toHaveLength(64);
    // An existing value is still writable at the ceiling: the cap is on how many exist, not on edits.
    expect(storage.writeCozyAppValue({ appId, valueId: "v0", type: "number", value: 99, expectedRevision: 1, idempotencyKey: "k0b", now: 210 }).outcome).toBe("written");
  });

  it("lets a bot move only its own action to running", () => {
    const storage = open();
    const mine = seed(storage, "sage:market");
    storage.upsertCozyApp({ id: "luna:other", name: "Other", creatorBot: "luna", tree, now: 100 });
    storage.createCozyAppAction({ id: "action-1", appId: mine, creatorBot: "sage", actionId: "refresh", idempotencyKey: "tap-1", now: 200 });
    expect(storage.markCozyAppActionDelivered("action-1", "luna", 210)).toBe(false);
    expect(storage.cozyAppReceipts(mine)[0]?.status).toBe("queued");
    expect(storage.markCozyAppActionDelivered("action-1", "sage", 210)).toBe(true);
    expect(storage.cozyAppReceipts(mine)[0]?.status).toBe("running");
  });
});

import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

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

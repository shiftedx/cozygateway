import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openStorage } from "../src/storage.ts";

describe("room owner migration", () => {
  it("adds a null owner to a pre-F8b room and permits one deterministic backfill", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-room-owner-"));
    const path = join(directory, "gateway.sqlite");
    let storage: ReturnType<typeof openStorage> | undefined;
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE bot_groups (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        members_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        needs_you INTEGER NOT NULL,
        next_seq INTEGER NOT NULL
      ) STRICT`);
      legacy.prepare("INSERT INTO bot_groups VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("launch", "Launch", JSON.stringify(["home:luna", "home:sage"]), 1, 0, 0, 1);
      legacy.close();

      storage = openStorage(path);
      expect(storage.botGroup("launch")?.owningHost).toBeUndefined();
      storage.backfillBotGroupOwner("launch", "home");
      storage.backfillBotGroupOwner("launch", "studio");
      expect(storage.botGroupOwner("launch")).toBe("home");
    } finally {
      storage?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

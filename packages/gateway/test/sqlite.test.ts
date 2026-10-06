import { expect, it } from "vitest";
import { CachedDatabaseSync } from "../src/sqlite.ts";

it("reuses statements with fresh bindings, schema results, and transaction state", () => {
  const db = new CachedDatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO item VALUES (?, ?)");
    insert.run(1, "one");
    insert.run(2, "two");
    const select = db.prepare("SELECT * FROM item WHERE id = ?");
    expect(db.prepare("SELECT * FROM item WHERE id = ?")).toBe(select);
    expect(select.get(1)).toEqual({ id: 1, value: "one" });
    expect(select.get(2)).toEqual({ id: 2, value: "two" });
    const named = db.prepare("SELECT $a AS a, $b AS b");
    named.get({ a: 1, b: 2 });
    expect(named.get({ a: 3 })).toEqual({ a: 3, b: null });
    db.exec("BEGIN");
    insert.run(3, "rolled back");
    db.exec("ROLLBACK");
    expect(select.get(3)).toBeUndefined();
    db.exec("ALTER TABLE item ADD COLUMN added INTEGER DEFAULT 7");
    expect(select.get(1)).toEqual({ id: 1, value: "one", added: 7 });
    db.exec("DROP TABLE item; CREATE TABLE item (id INTEGER, renamed TEXT); INSERT INTO item VALUES (1, 'new')");
    expect(select.get(1)).toEqual({ id: 1, renamed: "new" });
  } finally { db.close(); }
});

it("bounds retained query shapes and releases them across close and reopen", () => {
  const db = new CachedDatabaseSync(":memory:");
  const first = db.prepare("SELECT ? AS value");
  for (let index = 0; index < 128; index += 1) db.prepare(`SELECT ${index}`);
  expect(db.prepare("SELECT ? AS value")).not.toBe(first);
  expect(first.get("retained by caller")).toEqual({ value: "retained by caller" });
  const beforeClose = db.prepare("SELECT ? AS value");
  db.close();
  expect(() => db.prepare("SELECT ? AS value")).toThrow();
  db.open();
  try {
    expect(db.prepare("SELECT ? AS value") === beforeClose).toBe(false);
    expect(db.prepare("SELECT ? AS value").get("fresh")).toEqual({ value: "fresh" });
  } finally { db.close(); }
});

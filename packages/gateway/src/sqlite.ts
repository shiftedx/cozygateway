import { DatabaseSync, type StatementSync } from "node:sqlite";

/** Connection-local reuse for the stores' synchronous get/all/run calls. Statements must not
 * acquire per-caller options or remain active across an iterator/callback. SQLite automatically
 * recompiles prepared statements after schema changes. */
export class CachedDatabaseSync extends DatabaseSync {
  readonly #statements = new Map<string, StatementSync>();

  override prepare(sql: string): StatementSync {
    const cached = this.#statements.get(sql);
    if (cached !== undefined) return cached;
    const statement = super.prepare(sql);
    // ponytail: bounded FIFO, not an LRU framework; revisit only if measured query churn warrants it.
    if (this.#statements.size >= 128) this.#statements.delete(this.#statements.keys().next().value!);
    this.#statements.set(sql, statement);
    return statement;
  }

  override close(): void {
    this.#statements.clear();
    super.close();
  }
}

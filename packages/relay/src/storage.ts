import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS registrations (
  push_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS notify_counts (
  push_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (push_id, day)
) STRICT, WITHOUT ROWID;
`;

export interface RegistrationRow {
  pushId: string;
  platform: string;
  token: string;
}

/** UTC calendar day, "YYYY-MM-DD". The daily cap rolls over at midnight UTC. */
export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `notify_counts` rows this many UTC days old or older are pruned. The daily cap only
 *  ever consults the current day, so this window is deliberately generous; it exists
 *  purely to bound disk growth (design decision, issue #9). */
export const NOTIFY_COUNT_RETENTION_DAYS = 7;

export class RelayStorage {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Insert a new registration, or refresh an existing one (matched by `pushId`).
   *  `maxRegistrations` bounds the total row count in `registrations`: a genuinely new
   *  `pushId` beyond the cap is refused (returns `false`) and nothing is written.
   *  Refreshing an existing `pushId` is always allowed, even at the cap, since it does
   *  not add a row. Runs synchronously end-to-end on this storage's single sqlite
   *  connection (no `await` between the count check and the write), so there is no race
   *  between two concurrent callers both observing "under cap" and both inserting. */
  saveRegistration(
    reg: { pushId: string; platform: string; token: string; createdAt: number },
    maxRegistrations: number,
  ): boolean {
    if (this.registrationByPushId(reg.pushId) !== undefined) {
      this.#db
        .prepare("UPDATE registrations SET platform = ?, token = ?, created_at = ? WHERE push_id = ?")
        .run(reg.platform, reg.token, reg.createdAt, reg.pushId);
      return true;
    }
    if (this.registrationCount() >= maxRegistrations) return false;
    this.#db
      .prepare("INSERT INTO registrations (push_id, platform, token, created_at) VALUES (?, ?, ?, ?)")
      .run(reg.pushId, reg.platform, reg.token, reg.createdAt);
    return true;
  }

  registrationByPushId(pushId: string): RegistrationRow | undefined {
    return this.#db
      .prepare("SELECT push_id AS pushId, platform, token FROM registrations WHERE push_id = ?")
      .get(pushId) as RegistrationRow | undefined;
  }

  registrationCount(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM registrations").get() as { n: number };
    return row.n;
  }

  deleteRegistration(pushId: string): void {
    this.#db.prepare("DELETE FROM registrations WHERE push_id = ?").run(pushId);
  }

  notifyCount(pushId: string, day: string): number {
    const row = this.#db
      .prepare("SELECT count FROM notify_counts WHERE push_id = ? AND day = ?")
      .get(pushId, day) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  incrementNotifyCount(pushId: string, day: string): void {
    this.#db
      .prepare(
        `INSERT INTO notify_counts (push_id, day, count) VALUES (?, ?, 1)
         ON CONFLICT(push_id, day) DO UPDATE SET count = count + 1`,
      )
      .run(pushId, day);
  }

  /** Deletes `notify_counts` rows for UTC days strictly older than `NOTIFY_COUNT_RETENTION_DAYS`
   *  before `nowMs`. Day strings are "YYYY-MM-DD", which sorts lexicographically identically to
   *  chronological order, so a plain string comparison is exact with no timezone drift. Returns
   *  the number of rows removed. Called lazily from the `/notify` route (no timer, keeps the
   *  relay dependency-free and shutdown-simple; design decision, issue #9). */
  pruneNotifyCounts(nowMs: number): number {
    const cutoff = utcDay(nowMs - NOTIFY_COUNT_RETENTION_DAYS * MS_PER_DAY);
    const result = this.#db.prepare("DELETE FROM notify_counts WHERE day < ?").run(cutoff);
    return Number(result.changes);
  }

  close(): void {
    this.#db.close();
  }
}

export function openRelayStorage(dbPath: string): RelayStorage {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return new RelayStorage(db);
}

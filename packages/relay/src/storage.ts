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

export class RelayStorage {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  saveRegistration(reg: { pushId: string; platform: string; token: string; createdAt: number }): void {
    this.#db
      .prepare("INSERT INTO registrations (push_id, platform, token, created_at) VALUES (?, ?, ?, ?)")
      .run(reg.pushId, reg.platform, reg.token, reg.createdAt);
  }

  registrationByPushId(pushId: string): RegistrationRow | undefined {
    return this.#db
      .prepare("SELECT push_id AS pushId, platform, token FROM registrations WHERE push_id = ?")
      .get(pushId) as RegistrationRow | undefined;
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

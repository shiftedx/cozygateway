import { DatabaseSync } from "node:sqlite";

import type { Message, MessageRole, RichBlock } from "cozygateway-contract";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS setup_codes (
  code TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  backend TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER,
  archived_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS messages (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  turn_id TEXT,
  marker TEXT,
  delivery TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, seq)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS push_registrations (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  push_id TEXT NOT NULL,
  relay_url TEXT NOT NULL,
  push_key TEXT NOT NULL
) STRICT;
`;

export interface DeviceRow {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
}
export interface AgentRow {
  id: string;
  name: string;
  avatar: string | null;
  backend: string;
}
export interface ThreadRow {
  id: string;
  agentId: string;
  title: string;
  createdAt: number;
  lastMessageAt: number | null;
  archivedAt: number | null;
}
export interface PushRegistrationRow {
  deviceId: string;
  pushId: string;
  relayUrl: string;
  pushKey: string;
}

interface MessageDbRow {
  threadId: string;
  seq: number;
  role: string;
  blocksJson: string;
  turnId: string | null;
  marker: string | null;
  delivery: string | null;
  createdAt: number;
}

function toMessage(row: MessageDbRow): Message {
  const message: Message = {
    threadId: row.threadId,
    seq: row.seq,
    role: row.role as MessageRole,
    blocks: JSON.parse(row.blocksJson) as RichBlock[],
    createdAt: row.createdAt,
  };
  if (row.turnId !== null) message.turnId = row.turnId;
  if (row.marker === "turn.failed" || row.marker === "turn.interrupted") message.marker = row.marker;
  if (row.delivery === "turn" || row.delivery === "steer") message.delivery = row.delivery;
  return message;
}

export class Storage {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  createSetupCode(code: string, expiresAt: number): void {
    this.#db.prepare("INSERT INTO setup_codes (code, expires_at) VALUES (?, ?)").run(code, expiresAt);
  }

  consumeSetupCode(code: string, now: number): "ok" | "invalid" {
    const result = this.#db
      .prepare("UPDATE setup_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at >= ?")
      .run(now, code, now);
    return result.changes === 1 ? "ok" : "invalid";
  }

  createDevice(device: { id: string; name: string; tokenHash: string; createdAt: number }): void {
    this.#db
      .prepare("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(device.id, device.name, device.tokenHash, device.createdAt);
  }

  deviceByTokenHash(tokenHash: string): DeviceRow | undefined {
    return this.#db
      .prepare(
        "SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE token_hash = ?",
      )
      .get(tokenHash) as DeviceRow | undefined;
  }

  listDevices(): DeviceRow[] {
    return this.#db
      .prepare(
        "SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices ORDER BY created_at",
      )
      .all() as unknown as DeviceRow[];
  }

  deleteDevice(id: string): boolean {
    return this.#db.prepare("DELETE FROM devices WHERE id = ?").run(id).changes === 1;
  }

  touchDevice(id: string, at: number): void {
    this.#db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  upsertAgent(agent: AgentRow): void {
    this.#db
      .prepare(
        `INSERT INTO agents (id, name, avatar, backend) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, backend = excluded.backend`,
      )
      .run(agent.id, agent.name, agent.avatar, agent.backend);
  }

  listAgents(): AgentRow[] {
    return this.#db
      .prepare("SELECT id, name, avatar, backend FROM agents ORDER BY id")
      .all() as unknown as AgentRow[];
  }

  agentById(id: string): AgentRow | undefined {
    return this.#db.prepare("SELECT id, name, avatar, backend FROM agents WHERE id = ?").get(id) as
      | AgentRow
      | undefined;
  }

  createThread(thread: { id: string; agentId: string; title: string; createdAt: number }): void {
    this.#db
      .prepare("INSERT INTO threads (id, agent_id, title, created_at) VALUES (?, ?, ?, ?)")
      .run(thread.id, thread.agentId, thread.title, thread.createdAt);
  }

  listThreads(): ThreadRow[] {
    return this.#db
      .prepare(
        `SELECT id, agent_id AS agentId, title, created_at AS createdAt,
                last_message_at AS lastMessageAt, archived_at AS archivedAt
         FROM threads WHERE archived_at IS NULL
         ORDER BY last_message_at IS NULL, last_message_at DESC, created_at DESC`,
      )
      .all() as unknown as ThreadRow[];
  }

  threadById(id: string): ThreadRow | undefined {
    return this.#db
      .prepare(
        `SELECT id, agent_id AS agentId, title, created_at AS createdAt,
                last_message_at AS lastMessageAt, archived_at AS archivedAt
         FROM threads WHERE id = ?`,
      )
      .get(id) as ThreadRow | undefined;
  }

  renameThread(id: string, title: string): boolean {
    return this.#db.prepare("UPDATE threads SET title = ? WHERE id = ?").run(title, id).changes === 1;
  }

  archiveThread(id: string): boolean {
    return (
      this.#db
        .prepare("UPDATE threads SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
        .run(Date.now(), id).changes === 1
    );
  }

  appendMessage(
    threadId: string,
    entry: {
      role: MessageRole;
      blocks: RichBlock[];
      turnId?: string;
      marker?: "turn.failed" | "turn.interrupted";
      delivery?: "turn" | "steer";
    },
    createdAt: number,
  ): Message {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE thread_id = ?")
        .get(threadId) as { next: number };
      this.#db
        .prepare(
          `INSERT INTO messages (thread_id, seq, role, blocks_json, turn_id, marker, delivery, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          row.next,
          entry.role,
          JSON.stringify(entry.blocks),
          entry.turnId ?? null,
          entry.marker ?? null,
          entry.delivery ?? null,
          createdAt,
        );
      this.#db.prepare("UPDATE threads SET last_message_at = ? WHERE id = ?").run(createdAt, threadId);
      this.#db.exec("COMMIT");
      const message: Message = {
        threadId,
        seq: row.next,
        role: entry.role,
        blocks: entry.blocks,
        createdAt,
      };
      if (entry.turnId !== undefined) message.turnId = entry.turnId;
      if (entry.marker !== undefined) message.marker = entry.marker;
      if (entry.delivery !== undefined) message.delivery = entry.delivery;
      return message;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  messagesSince(threadId: string, sinceSeq: number): Message[] {
    const rows = this.#db
      .prepare(
        `SELECT thread_id AS threadId, seq, role, blocks_json AS blocksJson, turn_id AS turnId,
                marker, delivery, created_at AS createdAt
         FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq`,
      )
      .all(threadId, sinceSeq) as unknown as MessageDbRow[];
    return rows.map(toMessage);
  }

  messagesBefore(threadId: string, before: number | null, limit: number): Message[] {
    const rows = this.#db
      .prepare(
        `SELECT thread_id AS threadId, seq, role, blocks_json AS blocksJson, turn_id AS turnId,
                marker, delivery, created_at AS createdAt
         FROM messages WHERE thread_id = ? AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(threadId, before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as MessageDbRow[];
    return rows.reverse().map(toMessage);
  }

  savePushRegistration(deviceId: string, reg: { pushId: string; relayUrl: string; pushKey: string }): void {
    this.#db
      .prepare(
        `INSERT INTO push_registrations (device_id, push_id, relay_url, push_key) VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET push_id = excluded.push_id,
           relay_url = excluded.relay_url, push_key = excluded.push_key`,
      )
      .run(deviceId, reg.pushId, reg.relayUrl, reg.pushKey);
  }

  pushRegistrations(): PushRegistrationRow[] {
    return this.#db
      .prepare(
        `SELECT device_id AS deviceId, push_id AS pushId, relay_url AS relayUrl, push_key AS pushKey
         FROM push_registrations ORDER BY device_id`,
      )
      .all() as unknown as PushRegistrationRow[];
  }

  deletePushRegistration(deviceId: string): void {
    this.#db.prepare("DELETE FROM push_registrations WHERE device_id = ?").run(deviceId);
  }

  close(): void {
    this.#db.close();
  }
}

export function openStorage(dbPath: string): Storage {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // Additive migration for a DB created before the delivery column existed. ALTER TABLE ADD
  // COLUMN throws "duplicate column name" on an up-to-date DB, which is the no-op we want.
  try {
    db.exec("ALTER TABLE messages ADD COLUMN delivery TEXT");
  } catch {
    // column already present: nothing to do
  }
  return new Storage(db);
}

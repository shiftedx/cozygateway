import { DatabaseSync } from "node:sqlite";

import type { BotSummary, Message, MessageRole, RichBlock } from "cozygateway-contract";

/** How many retired chat sessions are remembered per bot. Sized against what it has to defend: the
 *  adoption paths only ever see the sessions `session.list` returns (100 rows), and a bot with more
 *  than a handful of resets in that window is already unusual, so 32 is generous while still being a
 *  hard bound on a table nothing else prunes. */
export const BOT_CHAT_RETIRED_LIMIT = 32;

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
-- Bots bridge cache (vendor extension com.cozylabs.bots, contract/ext-bots-v1.md). These three
-- tables are a CACHE of Hermes state, never the source of truth: the roster snapshot lets GET
-- /bots answer a cold app instantly while a refresh runs in the background, and bot_chat_pins
-- holds the canonical "Bot Chat" pointer for profiles whose ui_meta does not carry one yet.
CREATE TABLE IF NOT EXISTS bot_roster (
  name TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL,
  position INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS bot_meta (
  name TEXT PRIMARY KEY,
  meta_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS bot_chat_pins (
  name TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
-- Sessions a chat RESET retired, per bot. Not a cache and not optional bookkeeping: it is the only
-- thing that tells a retired "Bot Chat" apart from the live one. A reset mints the replacement with
-- the exact same title as the chat it retires (that byte-compatibility is deliberate), so after N
-- resets the host holds N+1 sessions all titled "Bot Chat" and nothing but the pin says which one is
-- current. Lose the pin (a gateway restart against a Hermes too old to store ui_meta is enough,
-- because the pin writeback is allowed to fail silently) and the title/position heuristics in
-- canonical-chat.ts would happily adopt a session the user asked to leave behind, handing back the
-- conversation they just cleared. Hence: on disk, so it survives the restart that is the whole
-- hazard, and consulted by every adoption path.
CREATE TABLE IF NOT EXISTS bot_chat_retired (
  name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  retired_at INTEGER NOT NULL,
  PRIMARY KEY (name, session_id)
) STRICT, WITHOUT ROWID;
-- Photos a device sent to a bot (contract/ext-bots-v1.md, capability 9). NOT a cache: these bytes
-- are the gateway's OWN copy of what the device uploaded, and they are the only copy any device can
-- ever be served. The hermes-side file the same upload produced is deliberately unreachable, for the
-- reason GET /bots/:name/media already refuses local paths: serving an arbitrary path on the hermes
-- host from an authenticated route is a file-read primitive over the whole box.
--
-- file_id is opaque, random and gateway-scoped; it is the only handle that ever leaves this process.
-- message_id is NULL until the turn poll (or a history read) sees the user row this photo was sent
-- with and binds the two. That binding is what makes the attachment durable: without it the photo
-- would ride exactly one live frame and vanish from the transcript on the next read, since the match
-- from a send to its persisted row is single-use by design.
CREATE TABLE IF NOT EXISTS bot_chat_attachments (
  file_id TEXT PRIMARY KEY,
  bot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT,
  mime TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS bot_chat_attachments_row
  ON bot_chat_attachments (session_id, message_id);
-- Group chat rooms. Unlike the three tables above these are NOT a cache: this gateway hosts the
-- rooms (spec section 4), so the room, its transcript, each member's watermark and the epoch are
-- the source of truth and must survive a restart. Only the "a round loop is running right now"
-- flag is runtime state, and it is deliberately absent here: a process that died mid-round left no
-- loop behind, so a restored room is settled until the user speaks again.
--
-- The key column is the lowercased room name (rooms are addressed case-insensitively and cannot
-- collide on case); the name column is what the user typed and what renders. Both child tables
-- cascade off the room, so DELETE /bots/groups/:name leaves nothing behind.
CREATE TABLE IF NOT EXISTS bot_groups (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  members_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  needs_you INTEGER NOT NULL,
  next_seq INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS bot_group_log (
  group_key TEXT NOT NULL REFERENCES bot_groups(key) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  from_kind TEXT NOT NULL,
  from_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  client_id TEXT,
  PRIMARY KEY (group_key, seq)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bot_group_members (
  group_key TEXT NOT NULL REFERENCES bot_groups(key) ON DELETE CASCADE,
  member TEXT NOT NULL,
  watermark INTEGER NOT NULL,
  session_id TEXT,
  PRIMARY KEY (group_key, member)
) STRICT, WITHOUT ROWID;
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

/** A group room as it sits on disk. `epoch` and `needsYou` are live protocol state, not metadata:
 *  the epoch supersedes in-flight rounds and `needsYou` is the escalation badge. */
export interface BotGroupRow {
  key: string;
  name: string;
  members: string[];
  createdAt: number;
  epoch: number;
  needsYou: boolean;
  nextSeq: number;
}

/** One transcript entry. `kind` is `user` for the human and `member` for a bot; `name` is the bot's
 *  profile name (or the human's label) and `displayName` is what renders. */
export interface BotGroupLogRow {
  seq: number;
  kind: "user" | "member";
  name: string;
  displayName: string;
  text: string;
  at: number;
  clientId?: string;
}

interface BotGroupDbRow {
  key: string;
  name: string;
  membersJson: string;
  createdAt: number;
  epoch: number;
  needsYou: number;
  nextSeq: number;
}

function toBotGroupRow(row: BotGroupDbRow): BotGroupRow {
  const parsed: unknown = JSON.parse(row.membersJson);
  return {
    key: row.key,
    name: row.name,
    members: Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [],
    createdAt: row.createdAt,
    epoch: row.epoch,
    needsYou: row.needsYou === 1,
    nextSeq: row.nextSeq,
  };
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

  /** Replaces the whole cached roster in one transaction, preserving the order it was built in
   *  (`position`), and mirrors each bot's `ui_meta` blob into `bot_meta`. A full replace, not a
   *  merge: a profile that disappeared from Hermes must disappear from the cache too. */
  replaceBotRoster(bots: Array<{ name: string; summary: BotSummary }>, updatedAt: number): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM bot_roster").run();
      const insert = this.#db.prepare(
        "INSERT INTO bot_roster (name, summary_json, position, updated_at) VALUES (?, ?, ?, ?)",
      );
      const meta = this.#db.prepare(
        `INSERT INTO bot_meta (name, meta_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET meta_json = excluded.meta_json, updated_at = excluded.updated_at`,
      );
      bots.forEach((bot, index) => {
        insert.run(bot.name, JSON.stringify(bot.summary), index, updatedAt);
        if (bot.summary.meta !== null) meta.run(bot.name, JSON.stringify(bot.summary.meta), updatedAt);
      });
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The cached roster in build order, plus the stamp of the refresh that produced it (null when
   *  no refresh has ever landed). */
  botRoster(): { bots: BotSummary[]; updatedAt: number | null } {
    const rows = this.#db
      .prepare("SELECT summary_json AS summaryJson, updated_at AS updatedAt FROM bot_roster ORDER BY position")
      .all() as unknown as Array<{ summaryJson: string; updatedAt: number }>;
    return {
      bots: rows.map((row) => JSON.parse(row.summaryJson) as BotSummary),
      updatedAt: rows.length === 0 ? null : rows[0]!.updatedAt,
    };
  }

  botChatPin(name: string): string | undefined {
    const row = this.#db.prepare("SELECT session_id AS sessionId FROM bot_chat_pins WHERE name = ?").get(name) as
      | { sessionId: string }
      | undefined;
    return row?.sessionId;
  }

  /** The pin plus the stamp of the write that made it. The stamp is what lets the bridge tell a
   *  pin it wrote itself moments ago from one the cached roster has already had a chance to see,
   *  which is the difference between adopting the existing chat and minting a duplicate. */
  botChatPinEntry(name: string): { sessionId: string; updatedAt: number } | undefined {
    return this.#db
      .prepare("SELECT session_id AS sessionId, updated_at AS updatedAt FROM bot_chat_pins WHERE name = ?")
      .get(name) as { sessionId: string; updatedAt: number } | undefined;
  }

  /** Every pin with the stamp of the write that made it. The roster build needs the stamps: a pin
   *  written after the `profiles.list` it is being merged with cannot have been contradicted by
   *  that snapshot, and it is what keeps `GET /bots` agreeing with `GET /bots/:name/chat`. */
  botChatPinEntries(): Map<string, { sessionId: string; updatedAt: number }> {
    const rows = this.#db
      .prepare("SELECT name, session_id AS sessionId, updated_at AS updatedAt FROM bot_chat_pins")
      .all() as unknown as Array<{ name: string; sessionId: string; updatedAt: number }>;
    return new Map(rows.map((row) => [row.name, { sessionId: row.sessionId, updatedAt: row.updatedAt }]));
  }

  botChatPins(): Map<string, string> {
    const rows = this.#db
      .prepare("SELECT name, session_id AS sessionId FROM bot_chat_pins")
      .all() as unknown as Array<{ name: string; sessionId: string }>;
    return new Map(rows.map((row) => [row.name, row.sessionId]));
  }

  setBotChatPin(name: string, sessionId: string, updatedAt: number): void {
    this.#db
      .prepare(
        `INSERT INTO bot_chat_pins (name, session_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(name, sessionId, updatedAt);
  }

  clearBotChatPin(name: string): void {
    this.#db.prepare("DELETE FROM bot_chat_pins WHERE name = ?").run(name);
  }

  /** Every session this gateway has retired for `name`, as a set the adoption paths can test in a
   *  loop. Read once per resolve rather than queried per row: a bot keeps at most
   *  `BOT_CHAT_RETIRED_LIMIT` of these, so the whole set is smaller than the session list it filters. */
  botChatRetired(name: string): Set<string> {
    const rows = this.#db
      .prepare("SELECT session_id AS sessionId FROM bot_chat_retired WHERE name = ?")
      .all(name) as unknown as Array<{ sessionId: string }>;
    return new Set(rows.map((row) => row.sessionId));
  }

  /** Records that `sessionId` was retired for `name`, then trims the bot back to the newest
   *  `BOT_CHAT_RETIRED_LIMIT` entries.
   *
   *  The bound is what keeps this table from being an unbounded log: a bot reset a thousand times
   *  would otherwise carry a thousand rows forever, for a guard that only ever matters against the
   *  sessions `session.list` still returns (100 rows on the adoption path, 200 on the passthrough).
   *  Dropping the OLDEST entries is the right end to lose: an id old enough to have fallen off both
   *  the bound and the list cannot be adopted anyway, and the ids a fresh restart is most likely to
   *  meet are the recent ones. Writing an id that is already there refreshes its stamp rather than
   *  duplicating it, so a repeated retire cannot push the newest entries out. */
  retireBotChat(name: string, sessionId: string, retiredAt: number): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT INTO bot_chat_retired (name, session_id, retired_at) VALUES (?, ?, ?)
           ON CONFLICT(name, session_id) DO UPDATE SET retired_at = excluded.retired_at`,
        )
        .run(name, sessionId, retiredAt);
      this.#db
        .prepare(
          `DELETE FROM bot_chat_retired WHERE name = ? AND session_id NOT IN (
             SELECT session_id FROM bot_chat_retired WHERE name = ?
             ORDER BY retired_at DESC, session_id DESC LIMIT ?
           )`,
        )
        .run(name, name, BOT_CHAT_RETIRED_LIMIT);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- Photos sent to a bot (contract/ext-bots-v1.md, capability 9). -----------------------------

  /** Stores the gateway's own copy of an uploaded photo and sweeps anything past the TTL in the same
   *  transaction.
   *
   *  The sweep rides the insert rather than a timer on purpose: this table only ever grows on an
   *  insert, so that is exactly when it is worth trimming, and a gateway nobody sends photos to costs
   *  nothing to keep tidy. */
  putBotChatAttachment(
    entry: {
      fileId: string;
      bot: string;
      sessionId: string;
      mime: string;
      name: string;
      size: number;
      bytes: Uint8Array;
    },
    createdAt: number,
    ttlMs: number,
  ): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT INTO bot_chat_attachments (file_id, bot, session_id, message_id, mime, name, size, bytes, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.fileId,
          entry.bot,
          entry.sessionId,
          entry.mime,
          entry.name,
          entry.size,
          entry.bytes,
          createdAt,
        );
      this.#db.prepare("DELETE FROM bot_chat_attachments WHERE created_at < ?").run(createdAt - ttlMs);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The bytes behind one `fileId`, scoped to the bot whose route asked for them. The bot scoping is
   *  not decoration: `/bots/:name/chat/attachments/:fileId` promises an answer about THAT bot, and a
   *  lookup by id alone would let any bot's URL serve any other bot's photo to a device that guessed
   *  or kept an id. */
  botChatAttachment(
    bot: string,
    fileId: string,
  ): { mime: string; name: string; size: number; bytes: Uint8Array } | undefined {
    const row = this.#db
      .prepare("SELECT mime, name, size, bytes FROM bot_chat_attachments WHERE bot = ? AND file_id = ?")
      .get(bot, fileId) as { mime: string; name: string; size: number; bytes: Uint8Array } | undefined;
    return row;
  }

  /** The attachment blocks belonging to one transcript row, in insert order. Answers `[]` for the
   *  overwhelming majority of rows, which is why the index is on `(session_id, message_id)`. */
  botChatAttachmentsFor(
    sessionId: string,
    messageId: string,
  ): Array<{ fileId: string; name: string; mime: string; size: number }> {
    return this.#db
      .prepare(
        `SELECT file_id AS fileId, name, mime, size FROM bot_chat_attachments
         WHERE session_id = ? AND message_id = ? ORDER BY created_at, file_id`,
      )
      .all(sessionId, messageId) as unknown as Array<{
      fileId: string;
      name: string;
      mime: string;
      size: number;
    }>;
  }

  /** Binds a stored photo to the transcript row it was sent with, ONCE. The `message_id IS NULL`
   *  guard is what makes it once: the send-to-row match is single-use by design, but a re-bind from a
   *  replayed row would move a photo off the message it belongs to and onto a later one with the same
   *  words, which is the exact collapse the pending-send queue exists to prevent. */
  bindBotChatAttachment(fileId: string, messageId: string): void {
    this.#db
      .prepare("UPDATE bot_chat_attachments SET message_id = ? WHERE file_id = ? AND message_id IS NULL")
      .run(messageId, fileId);
  }

  /** Drops one stored photo. Used when the send it belonged to failed, so a refused or unsubmitted
   *  upload leaves no bytes behind. */
  deleteBotChatAttachment(fileId: string): void {
    this.#db.prepare("DELETE FROM bot_chat_attachments WHERE file_id = ?").run(fileId);
  }

  /** Drops every stored photo older than the TTL. Returns how many went, so a caller can log it. */
  sweepBotChatAttachments(now: number, ttlMs: number): number {
    return this.#db.prepare("DELETE FROM bot_chat_attachments WHERE created_at < ?").run(now - ttlMs).changes as number;
  }

  /** Drops every trace of a bot from the cache: its roster row, its mirrored `ui_meta` blob, its
   *  canonical-chat pin, and the sessions its resets retired. Called when the profile is deleted
   *  Hermes-side, so a name that gets reused later starts clean rather than inheriting a dead pin,
   *  which would send the first open of the new bot into a `session.resume` for a session that no
   *  longer exists. The next roster refresh rewrites `bot_roster` wholesale anyway; the pin, the meta
   *  blob and the retired set are the rows that would otherwise outlive the profile. (The retired set
   *  goes for the same reason as the pin: it is keyed on a name, not on an identity, so a rebuilt bot
   *  reusing the name would inherit refusals aimed at sessions belonging to its predecessor.) */
  forgetBot(name: string): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM bot_roster WHERE name = ?").run(name);
      this.#db.prepare("DELETE FROM bot_meta WHERE name = ?").run(name);
      this.#db.prepare("DELETE FROM bot_chat_pins WHERE name = ?").run(name);
      this.#db.prepare("DELETE FROM bot_chat_retired WHERE name = ?").run(name);
      // The photos too, and for a stronger reason than the rows above: they are BYTES a person
      // uploaded, and a deleted bot is the clearest signal there is that nobody is coming back for
      // them. Keying on a name rather than an identity cuts the same way it does for the retired set:
      // a rebuilt bot reusing the name must not inherit its predecessor's pictures.
      this.#db.prepare("DELETE FROM bot_chat_attachments WHERE bot = ?").run(name);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- Group chat rooms (contract/ext-bots-v1.md section 4, groups). ------------------------------

  /** Creates a room. Returns false when one already exists under the same case-insensitive key,
   *  which the route answers as a 409 rather than silently adopting a different membership. */
  createBotGroup(room: { key: string; name: string; members: string[]; createdAt: number }): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#db.prepare("SELECT key FROM bot_groups WHERE key = ?").get(room.key);
      if (existing !== undefined) {
        this.#db.exec("ROLLBACK");
        return false;
      }
      this.#db
        .prepare(
          `INSERT INTO bot_groups (key, name, members_json, created_at, epoch, needs_you, next_seq)
           VALUES (?, ?, ?, ?, 0, 0, 1)`,
        )
        .run(room.key, room.name, JSON.stringify(room.members), room.createdAt);
      const member = this.#db.prepare(
        "INSERT INTO bot_group_members (group_key, member, watermark, session_id) VALUES (?, ?, 0, NULL)",
      );
      for (const name of room.members) member.run(room.key, name);
      this.#db.exec("COMMIT");
      return true;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  botGroups(): BotGroupRow[] {
    const rows = this.#db
      .prepare(
        `SELECT key, name, members_json AS membersJson, created_at AS createdAt, epoch,
                needs_you AS needsYou, next_seq AS nextSeq
         FROM bot_groups ORDER BY created_at, key`,
      )
      .all() as unknown as BotGroupDbRow[];
    return rows.map(toBotGroupRow);
  }

  botGroup(key: string): BotGroupRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT key, name, members_json AS membersJson, created_at AS createdAt, epoch,
                needs_you AS needsYou, next_seq AS nextSeq
         FROM bot_groups WHERE key = ?`,
      )
      .get(key) as BotGroupDbRow | undefined;
    return row === undefined ? undefined : toBotGroupRow(row);
  }

  /** Drops a room and, by cascade, its transcript and its per-member state. */
  deleteBotGroup(key: string): boolean {
    return this.#db.prepare("DELETE FROM bot_groups WHERE key = ?").run(key).changes === 1;
  }

  /** Appends one entry and hands back the room-local `seq` it was given. The counter lives on the
   *  room rather than being derived from `MAX(seq)`, so a trim that drops the head can never hand a
   *  later entry a seq the room has already used. */
  appendBotGroupMessage(key: string, entry: Omit<BotGroupLogRow, "seq">): BotGroupLogRow {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT next_seq AS nextSeq FROM bot_groups WHERE key = ?").get(key) as
        | { nextSeq: number }
        | undefined;
      if (row === undefined) throw new Error(`no group room "${key}"`);
      const seq = row.nextSeq;
      this.#db
        .prepare(
          `INSERT INTO bot_group_log (group_key, seq, from_kind, from_name, display_name, text, at, client_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(key, seq, entry.kind, entry.name, entry.displayName, entry.text, entry.at, entry.clientId ?? null);
      this.#db.prepare("UPDATE bot_groups SET next_seq = ? WHERE key = ?").run(seq + 1, key);
      this.#db.exec("COMMIT");
      return { ...entry, seq };
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  botGroupLog(key: string): BotGroupLogRow[] {
    const rows = this.#db
      .prepare(
        `SELECT seq, from_kind AS kind, from_name AS name, display_name AS displayName, text, at,
                client_id AS clientId
         FROM bot_group_log WHERE group_key = ? ORDER BY seq`,
      )
      .all(key) as unknown as Array<BotGroupLogRow & { clientId: string | null }>;
    return rows.map((row) => {
      const entry: BotGroupLogRow = {
        seq: row.seq,
        kind: row.kind,
        name: row.name,
        displayName: row.displayName,
        text: row.text,
        at: row.at,
      };
      if (row.clientId !== null) entry.clientId = row.clientId;
      return entry;
    });
  }

  /** Keeps the newest `limit` entries, dropping from the head (the desktop's own retention rule).
   *  Watermarks are seqs, not indices, so nothing else has to move. */
  trimBotGroupLog(key: string, limit: number): void {
    this.#db
      .prepare(
        `DELETE FROM bot_group_log WHERE group_key = ? AND seq NOT IN
           (SELECT seq FROM bot_group_log WHERE group_key = ? ORDER BY seq DESC LIMIT ?)`,
      )
      .run(key, key, limit);
  }

  /** Per-member watermark (highest seq the member has been shown) and room session id. Members are
   *  rowed at create; a member row missing here means the room predates it, which reads as a fresh
   *  member that has seen nothing. */
  botGroupMembers(key: string): Map<string, { watermark: number; sessionId: string | null }> {
    const rows = this.#db
      .prepare("SELECT member, watermark, session_id AS sessionId FROM bot_group_members WHERE group_key = ?")
      .all(key) as unknown as Array<{ member: string; watermark: number; sessionId: string | null }>;
    return new Map(rows.map((row) => [row.member, { watermark: row.watermark, sessionId: row.sessionId }]));
  }

  setBotGroupWatermark(key: string, member: string, watermark: number): void {
    this.#db
      .prepare(
        `INSERT INTO bot_group_members (group_key, member, watermark, session_id) VALUES (?, ?, ?, NULL)
         ON CONFLICT(group_key, member) DO UPDATE SET watermark = excluded.watermark`,
      )
      .run(key, member, watermark);
  }

  setBotGroupSession(key: string, member: string, sessionId: string): void {
    this.#db
      .prepare(
        `INSERT INTO bot_group_members (group_key, member, watermark, session_id) VALUES (?, ?, 0, ?)
         ON CONFLICT(group_key, member) DO UPDATE SET session_id = excluded.session_id`,
      )
      .run(key, member, sessionId);
  }

  /** Bumps and returns the room's epoch. The bump is what supersedes a round loop still running from
   *  the previous user message, so it has to be atomic with respect to concurrent sends. */
  bumpBotGroupEpoch(key: string): number {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT epoch FROM bot_groups WHERE key = ?").get(key) as
        | { epoch: number }
        | undefined;
      if (row === undefined) throw new Error(`no group room "${key}"`);
      const epoch = row.epoch + 1;
      this.#db.prepare("UPDATE bot_groups SET epoch = ? WHERE key = ?").run(epoch, key);
      this.#db.exec("COMMIT");
      return epoch;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  setBotGroupNeedsYou(key: string, needsYou: boolean): void {
    this.#db.prepare("UPDATE bot_groups SET needs_you = ? WHERE key = ?").run(needsYou ? 1 : 0, key);
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

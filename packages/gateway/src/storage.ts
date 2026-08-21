import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import type { AttachmentBlock, BotChatMessage, BotSummary, Message, MessageRole, RichBlock } from "cozygateway-contract";
import type {
  AttachV1Command,
  AttachV1CommandFrame,
  AttachV1EventFrame,
  AttachV1MediaDescriptor,
} from "./adapters/attach/protocol-v1.ts";

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
  external_id TEXT,
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
-- runtime_id is the RUNTIME session id of a pinned chat NOBODY HAS WRITTEN IN YET, and it is NULL
-- for every chat that has a transcript (ext-bots capability 11). Since the gateway stopped
-- submitting an opener on the user's behalf, a freshly minted chat holds no prompt at all, and
-- hermes persists no database row for a session until its first one: the session cannot be listed
-- and cannot be resumed, so the runtime id session.create handed back is the ONLY id
-- prompt.submit will accept for it. Held in memory it was lost on restart, and the first thing the
-- user ever typed into that chat then failed with no way back. That was survivable while the gap was
-- the second or two a kickoff prompt took; it is not survivable now the gap lasts until the user
-- decides to speak. Cleared the moment the session resumes, because from then on the stored id is
-- resolvable and this value is stale.
-- runtime_generation is the HERMES LINK GENERATION the runtime id above was minted under, and it is
-- what bounds a durable runtime id by the lifetime of the hermes process that issued it (issue #66).
-- A runtime session id is meaningful only inside the hermes that created it: hermes restarts, every
-- unwritten session it was holding is gone, and the id this table carries now names nothing. Held in
-- memory (before capability 11) that was self-correcting, because the id died with the gateway
-- process and expired on a 180 s timer; on disk it has no such bound, and submitting against it is
-- worse than failing -- hermes can accept the prompt into a phantom session, the app renders the user
-- bubble, the gateway answers 202, and no reply is ever coming. So the stamp is compared on every
-- read: a runtime id whose generation is not the current one is treated as absent, and the send falls
-- through to the mint-a-replacement path instead.
CREATE TABLE IF NOT EXISTS bot_chat_pins (
  name TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  runtime_id TEXT,
  runtime_generation TEXT,
  manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1))
) STRICT;
-- The hermes link generation this gateway last observed, one row, id always 1. On disk rather than in
-- memory on purpose, and that is the whole point of the table: a GATEWAY restart against a hermes
-- that never went down must NOT invalidate the runtime ids it is holding (that is the win PR #61
-- bought, and losing it would put the first message a user ever types back in the 502 hole), so the
-- generation has to be the same value after the restart as before it. What it cannot do is see a
-- hermes restart that happened while the gateway itself was down; that case is handled the other way,
-- by the send path re-minting a chat whose session hermes no longer knows.
CREATE TABLE IF NOT EXISTS hermes_link (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation TEXT NOT NULL
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
-- Chat images (contract/ext-bots-v1.md, capabilities 9 and 15). NOT a cache: these bytes are the
-- gateway's OWN copy, either uploaded by a device or fetched through Hermes' guarded dashboard read.
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
-- Successful capability-15 assistant directives. Only a digest of line position plus line text is
-- retained, never the Hermes-host path. This marker outlives the attachment bytes so a 14-day byte
-- expiry does not make a previously consumed host path reappear in chat history.
CREATE TABLE IF NOT EXISTS bot_chat_assistant_media (
  bot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id, source_key)
) STRICT, WITHOUT ROWID;
-- Tool steps a bot's turn ran (contract/ext-bots-v1.md, capability 12). A CACHE of nothing: hermes
-- keeps its tool lifecycle on a live event stream and replays none of it, so if these rows are not
-- written here the activity exists for exactly as long as a socket stayed open, and the collapsed
-- "what did it do" strip under a reply in history has nothing to expand.
--
-- Deliberately NOT keyed to a transcript row. A step belongs to a TURN, and the gateway cannot say
-- which assistant row a turn produced without guessing (see the note on BotTurnToolSteps in
-- ext-bots.ts). What it can say honestly is WHEN, so started_at is the join a client uses to
-- place a turn's strip against the message timestamps it already has.
--
-- The name column is the only text here, and it is a tool identifier: never an argument, a command
-- or a path. Nothing else from the hermes tool events is stored, for the same reason nothing else is
-- broadcast: this table would otherwise become the durable copy of exactly the free text the wire
-- refuses to carry.
CREATE TABLE IF NOT EXISTS bot_chat_tool_steps (
  bot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  detail TEXT,
  error_text TEXT,
  PRIMARY KEY (bot, turn_id, step_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bot_chat_tool_steps_session
  ON bot_chat_tool_steps (session_id, started_at);
-- Capability 18 routine model/effort selections. Hermes' surveyed cron RPC cannot persist or
-- apply the pair to one run, so these are deliberately gateway-owned inert contract metadata.
-- JSON preserves the difference between an omitted field and an explicit null (follow profile).
CREATE TABLE IF NOT EXISTS bot_routine_overrides (
  bot TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  overrides_json TEXT NOT NULL,
  PRIMARY KEY (bot, routine_id)
) STRICT, WITHOUT ROWID;
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
-- attach-v1 is an at-least-once transport. Both journals are gateway-owned durability boundaries:
-- commands survive until the plugin ACKs them, and events are ACKed only after the inbox commit.
CREATE TABLE IF NOT EXISTS attach_streams (
  agent_id TEXT PRIMARY KEY,
  next_command_sequence INTEGER NOT NULL DEFAULT 1,
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS attach_command_outbox (
  agent_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  command_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acked_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT,
  PRIMARY KEY (agent_id, sequence),
  UNIQUE (agent_id, command_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attach_event_inbox (
  agent_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  frame_json TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  disposition TEXT NOT NULL,
  applied_at INTEGER,
  projection_attempts INTEGER NOT NULL DEFAULT 0,
  projection_error TEXT,
  dead_lettered_at INTEGER,
  PRIMARY KEY (agent_id, sequence),
  UNIQUE (agent_id, event_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attach_turn_terminals (
  agent_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  terminal_kind TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  PRIMARY KEY (agent_id, turn_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attach_media (
  agent_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (agent_id, media_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attach_scheduled_deliveries (
  agent_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  projected_at INTEGER,
  PRIMARY KEY (agent_id, delivery_id),
  UNIQUE (agent_id, message_id),
  UNIQUE (agent_id, event_id)
) STRICT, WITHOUT ROWID;
-- App-facing Bot Mode projection for profiles whose chat plane is attach-v1. Dashboard JSON-RPC
-- remains management-only for these profiles; the transcript therefore has to be gateway-owned.
CREATE TABLE IF NOT EXISTS bot_native_chats (
  bot TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  active_turn_id TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS bot_native_messages (
  bot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER,
  client_id TEXT,
  attachments_json TEXT,
  PRIMARY KEY (bot, session_id, seq),
  UNIQUE (bot, message_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bot_native_interactions (
  bot TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('approval', 'clarify')),
  interaction_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  selected_option_id TEXT,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot, kind, interaction_id)
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

export interface BotRoutineOverrides {
  model?: string | null;
  effort?: string | null;
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
      /** Stable attach-v1 message id. Replays return the existing row without appending. */
      externalId?: string;
    },
    createdAt: number,
  ): Message {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (entry.externalId !== undefined) {
        const prior = this.#db
          .prepare(
            `SELECT thread_id AS threadId, seq, role, blocks_json AS blocksJson, turn_id AS turnId,
                    marker, delivery, created_at AS createdAt
             FROM messages WHERE thread_id = ? AND external_id = ?`,
          )
          .get(threadId, entry.externalId) as MessageDbRow | undefined;
        if (prior !== undefined) {
          this.#db.exec("COMMIT");
          return toMessage(prior);
        }
      }
      const row = this.#db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE thread_id = ?")
        .get(threadId) as { next: number };
      this.#db
        .prepare(
          `INSERT INTO messages (thread_id, seq, role, blocks_json, turn_id, marker, delivery, external_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          threadId,
          row.next,
          entry.role,
          JSON.stringify(entry.blocks),
          entry.turnId ?? null,
          entry.marker ?? null,
          entry.delivery ?? null,
          entry.externalId ?? null,
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

  messageByExternalId(threadId: string, externalId: string): Message | undefined {
    const row = this.#db
      .prepare(
        `SELECT thread_id AS threadId, seq, role, blocks_json AS blocksJson, turn_id AS turnId,
                marker, delivery, created_at AS createdAt
         FROM messages WHERE thread_id = ? AND external_id = ?`,
      )
      .get(threadId, externalId) as MessageDbRow | undefined;
    return row === undefined ? undefined : toMessage(row);
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
  botChatPinEntry(name: string): { sessionId: string; updatedAt: number; manual: boolean } | undefined {
    const row = this.#db
      .prepare("SELECT session_id AS sessionId, updated_at AS updatedAt, manual FROM bot_chat_pins WHERE name = ?")
      .get(name) as { sessionId: string; updatedAt: number; manual: number } | undefined;
    return row === undefined ? undefined : { ...row, manual: row.manual === 1 };
  }

  /** Every pin with the stamp of the write that made it. The roster build needs the stamps: a pin
   *  written after the `profiles.list` it is being merged with cannot have been contradicted by
   *  that snapshot, and it is what keeps `GET /bots` agreeing with `GET /bots/:name/chat`. */
  botChatPinEntries(): Map<
    string,
    { sessionId: string; updatedAt: number; manual: boolean; unwritten: boolean }
  > {
    const rows = this.#db
      .prepare(
        `SELECT name, session_id AS sessionId, updated_at AS updatedAt, manual,
                runtime_id IS NOT NULL AS unwritten
           FROM bot_chat_pins`,
      )
      .all() as unknown as Array<{
        name: string;
        sessionId: string;
        updatedAt: number;
        manual: number;
        unwritten: number;
      }>;
    return new Map(
      rows.map((row) => [
        row.name,
        {
          sessionId: row.sessionId,
          updatedAt: row.updatedAt,
          manual: row.manual === 1,
          unwritten: row.unwritten === 1,
        },
      ]),
    );
  }

  botChatPins(): Map<string, string> {
    const rows = this.#db
      .prepare("SELECT name, session_id AS sessionId FROM bot_chat_pins")
      .all() as unknown as Array<{ name: string; sessionId: string }>;
    return new Map(rows.map((row) => [row.name, row.sessionId]));
  }

  /** Pins `sessionId` for `name`. Re-pinning the SAME session keeps whatever `runtime_id` the row
   *  carries. It also preserves a manual flag and its original timestamp, so an ordinary resolve
   *  cannot erase or move the boundary that capability 16 waits past. Moving to a DIFFERENT session
   *  drops both pieces of session-specific state. Passing `manual: true` establishes or refreshes
   *  the explicit choice even when the id was already pinned. */
  setBotChatPin(name: string, sessionId: string, updatedAt: number, manual = false): void {
    this.#db
      .prepare(
        `INSERT INTO bot_chat_pins (name, session_id, updated_at, runtime_id, runtime_generation, manual)
           VALUES (?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(name) DO UPDATE SET
           session_id = excluded.session_id,
           updated_at = CASE
             WHEN session_id = excluded.session_id AND manual = 1 AND excluded.manual = 0
               THEN updated_at
             ELSE excluded.updated_at
           END,
           manual = CASE
             WHEN excluded.manual = 1 THEN 1
             WHEN session_id = excluded.session_id THEN manual
             ELSE 0
           END,
           runtime_id = CASE WHEN session_id = excluded.session_id THEN runtime_id ELSE NULL END,
           runtime_generation =
             CASE WHEN session_id = excluded.session_id THEN runtime_generation ELSE NULL END`,
      )
      .run(name, sessionId, updatedAt, manual ? 1 : 0);
  }

  /** The runtime id of `name`'s pinned chat, when that chat has never been written in, the pin still
   *  names `sessionId`, AND the id was minted under `linkGeneration`. `undefined` for every chat with
   *  a transcript, which is the answer that says "resume it, the stored id works".
   *
   *  Two guards, both load-bearing and for the same underlying reason: an id that no longer addresses
   *  the chat the user is looking at must never carry their message. The `session_id` guard covers a
   *  runtime id that outlived its own session (a reset moved the pin); the generation guard covers a
   *  runtime id that outlived its own HERMES (issue #66), which is the case a durable id introduced
   *  and which nothing else can detect: hermes will happily accept a `prompt.submit` against an id it
   *  no longer knows, so a stale one buys a 202 and silence rather than an error. */
  botChatRuntimeId(name: string, sessionId: string, linkGeneration: string): string | undefined {
    const row = this.#db
      .prepare(
        `SELECT runtime_id AS runtimeId FROM bot_chat_pins
           WHERE name = ? AND session_id = ? AND runtime_generation = ?`,
      )
      .get(name, sessionId, linkGeneration) as { runtimeId: string | null } | undefined;
    return row?.runtimeId ?? undefined;
  }

  /** True when `name`'s pinned chat is one this gateway minted and nobody has written in yet,
   *  WHATEVER generation minted it.
   *
   *  Deliberately generation-blind, and the difference from `botChatRuntimeId` is the point. The
   *  generation answers "can this chat still be addressed"; this answers "is this chat empty", and a
   *  chat orphaned by a hermes restart is still empty. Reading a history for it must therefore keep
   *  answering an empty transcript rather than the resume failure: the alternative is that the whole
   *  screen 502s and the user cannot even reach the composer whose first send would heal the chat. */
  botChatUnwritten(name: string, sessionId: string): boolean {
    const row = this.#db
      .prepare("SELECT runtime_id AS runtimeId FROM bot_chat_pins WHERE name = ? AND session_id = ?")
      .get(name, sessionId) as { runtimeId: string | null } | undefined;
    return (row?.runtimeId ?? undefined) !== undefined;
  }

  /** Records the runtime id of a chat this gateway just minted and nobody has written in yet,
   *  stamped with the hermes link generation that minted it. A no-op unless the pin still names
   *  `sessionId`, so a mint that lost a race to a reset cannot write its id over the survivor's. */
  setBotChatRuntimeId(name: string, sessionId: string, runtimeId: string, linkGeneration: string): void {
    this.#db
      .prepare(
        "UPDATE bot_chat_pins SET runtime_id = ?, runtime_generation = ? WHERE name = ? AND session_id = ?",
      )
      .run(runtimeId, linkGeneration, name, sessionId);
  }

  /** Forgets the runtime id of `name`'s pinned chat: the session has a row now, so the stored id
   *  resumes and this value can only go stale. Idempotent, and scoped to `sessionId` for the same
   *  reason the read is. */
  clearBotChatRuntimeId(name: string, sessionId: string): void {
    this.#db
      .prepare(
        "UPDATE bot_chat_pins SET runtime_id = NULL, runtime_generation = NULL WHERE name = ? AND session_id = ?",
      )
      .run(name, sessionId);
  }

  /** The hermes link generation this gateway last wrote down, or `undefined` on a database that has
   *  never seen one. */
  hermesLinkGeneration(): string | undefined {
    const row = this.#db.prepare("SELECT generation FROM hermes_link WHERE id = 1").get() as
      | { generation: string }
      | undefined;
    return row?.generation;
  }

  setHermesLinkGeneration(generation: string): void {
    this.#db
      .prepare(
        `INSERT INTO hermes_link (id, generation) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET generation = excluded.generation`,
      )
      .run(generation);
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

  /** Makes a previously reset session eligible again after the user explicitly restores it. */
  restoreBotChat(name: string, sessionId: string): void {
    this.#db
      .prepare("DELETE FROM bot_chat_retired WHERE name = ? AND session_id = ?")
      .run(name, sessionId);
  }

  // --- Photos sent to a bot (contract/ext-bots-v1.md, capability 9). -----------------------------

  /** Stores the gateway's own copy of a chat image and sweeps anything past the TTL in the same
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
      messageId?: string;
      sourceKey?: string;
    },
    createdAt: number,
    ttlMs: number,
  ): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `INSERT INTO bot_chat_attachments
             (file_id, bot, session_id, message_id, mime, name, size, bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.fileId,
          entry.bot,
          entry.sessionId,
          entry.messageId ?? null,
          entry.mime,
          entry.name,
          entry.size,
          entry.bytes,
          createdAt,
        );
      if (entry.messageId !== undefined && entry.sourceKey !== undefined) {
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO bot_chat_assistant_media (bot, session_id, message_id, source_key)
             VALUES (?, ?, ?, ?)`,
          )
          .run(entry.bot, entry.sessionId, entry.messageId, entry.sourceKey);
      }
      this.#db.prepare("DELETE FROM bot_chat_attachments WHERE created_at < ?").run(createdAt - ttlMs);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The bytes behind one `fileId`, scoped to the bot whose route asked for them, and to the TTL.
   *
   *  The bot scoping is not decoration: `/bots/:name/chat/attachments/:fileId` promises an answer
   *  about THAT bot, and a lookup by id alone would let any bot's URL serve any other bot's photo to
   *  a device that guessed or kept an id.
   *
   *  `notBefore` is what makes the contract's expiry TRUE rather than aspirational. A sweep is a
   *  reclamation of disk and it only runs when something runs it; a household that sends photos for
   *  a week and then stops has nothing left to trigger one, and every one of those photos would go
   *  on being served for years. Expiry has to be a property of the READ, and the sweep is then just
   *  housekeeping behind an answer that is already correct. */
  botChatAttachment(
    bot: string,
    fileId: string,
    notBefore: number,
  ): { mime: string; name: string; size: number; bytes: Uint8Array } | undefined {
    const row = this.#db
      .prepare(
        "SELECT mime, name, size, bytes FROM bot_chat_attachments WHERE bot = ? AND file_id = ? AND created_at >= ?",
      )
      .get(bot, fileId, notBefore) as { mime: string; name: string; size: number; bytes: Uint8Array } | undefined;
    return row;
  }

  /** Metadata-only attachment lookup for HTTP range negotiation. This deliberately leaves the BLOB
   *  out of the SELECT so a 40 MB video HEAD request or rejected range does not materialize it. */
  botChatAttachmentInfo(
    bot: string,
    fileId: string,
    notBefore: number,
  ): { mime: string; name: string; size: number } | undefined {
    return this.#db
      .prepare(
        "SELECT mime, name, size FROM bot_chat_attachments WHERE bot = ? AND file_id = ? AND created_at >= ?",
      )
      .get(bot, fileId, notBefore) as { mime: string; name: string; size: number } | undefined;
  }

  /** Reads one byte slice directly in SQLite. SQLite `substr` is one-indexed for BLOBs, while the
   *  HTTP range passed here is zero-indexed. No full attachment buffer is created for ranged reads. */
  botChatAttachmentSlice(
    bot: string,
    fileId: string,
    notBefore: number,
    offset: number,
    length: number,
  ): Uint8Array | undefined {
    const row = this.#db
      .prepare(
        `SELECT substr(bytes, ?, ?) AS bytes FROM bot_chat_attachments
         WHERE bot = ? AND file_id = ? AND created_at >= ?`,
      )
      .get(offset + 1, length, bot, fileId, notBefore) as { bytes: Uint8Array } | undefined;
    return row?.bytes;
  }

  /** The attachment blocks belonging to one transcript row, in insert order. Answers `[]` for the
   *  overwhelming majority of rows, which is why the index is on `(session_id, message_id)`.
   *
   *  Same `notBefore` cut as the read above, and for the same reason plus one more: a block naming a
   *  file the download route would 404 is worse than no block at all, because a client renders it as
   *  a picture that is coming and then never resolves. The two reads have to expire together. */
  botChatAttachmentsFor(
    sessionId: string,
    messageId: string,
    notBefore: number,
  ): Array<{ fileId: string; name: string; mime: string; size: number }> {
    return this.#db
      .prepare(
        `SELECT file_id AS fileId, name, mime, size FROM bot_chat_attachments
         WHERE session_id = ? AND message_id = ? AND created_at >= ? ORDER BY created_at, file_id`,
      )
      .all(sessionId, messageId, notBefore) as unknown as Array<{
      fileId: string;
      name: string;
      mime: string;
      size: number;
    }>;
  }

  /** Successful assistant directives for one transcript row. These are durable text-rewrite
   *  markers, not attachment-byte rows, so attachment expiry never makes a consumed path visible. */
  botChatAssistantMediaKeys(sessionId: string, messageId: string): string[] {
    const rows = this.#db
      .prepare(
        `SELECT source_key AS sourceKey FROM bot_chat_assistant_media
         WHERE session_id = ? AND message_id = ? ORDER BY source_key`,
      )
      .all(sessionId, messageId) as unknown as Array<{ sourceKey: string }>;
    return rows.map((row) => row.sourceKey);
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

  /** Writes one tool step, or updates the one already there (capability 12). Upsert rather than
   *  insert-then-update because a step is written twice by design -- once when it starts and once
   *  when it ends -- and the end write must not depend on the start write having happened: an event
   *  stream this gateway attached to mid-turn delivers an end with no start, and a step recorded
   *  only at its end is still a true thing that happened.
   *
   *  `seq` and `started_at` are pinned by the FIRST write and never moved, so a step keeps the
   *  position it was first seen in. Status and `ended_at` are the only columns a later write owns. */
  upsertBotChatToolStep(step: {
    bot: string;
    sessionId: string;
    turnId: string;
    stepId: string;
    seq: number;
    name: string;
    status: string;
    startedAt: number;
    endedAt: number | undefined;
    detail?: string | undefined;
    errorText?: string | undefined;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO bot_chat_tool_steps
           (bot, session_id, turn_id, step_id, seq, name, status, started_at, ended_at, detail, error_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot, turn_id, step_id) DO UPDATE SET
           status = excluded.status,
           ended_at = COALESCE(excluded.ended_at, bot_chat_tool_steps.ended_at),
           detail = COALESCE(excluded.detail, bot_chat_tool_steps.detail),
           error_text = COALESCE(excluded.error_text, bot_chat_tool_steps.error_text),
           name = CASE WHEN bot_chat_tool_steps.name = '' THEN excluded.name ELSE bot_chat_tool_steps.name END`,
      )
      .run(
        step.bot,
        step.sessionId,
        step.turnId,
        step.stepId,
        step.seq,
        step.name,
        step.status,
        step.startedAt,
        step.endedAt ?? null,
        step.detail ?? null,
        step.errorText ?? null,
      );
  }

  /** Every tool step recorded for one chat, oldest turn first and in-turn order within it. The
   *  caller groups them; this returns rows because the grouping belongs to the surface that knows
   *  the frame shape, not to the table. */
  botChatToolSteps(
    sessionId: string,
    notBefore: number,
  ): Array<{
    turnId: string;
    stepId: string;
    seq: number;
    name: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    detail: string | null;
    errorText: string | null;
  }> {
    return this.#db
      .prepare(
        `SELECT turn_id AS turnId, step_id AS stepId, seq, name, status,
                started_at AS startedAt, ended_at AS endedAt, detail, error_text AS errorText
         FROM bot_chat_tool_steps
         WHERE session_id = ? AND started_at >= ?
         ORDER BY started_at, seq, step_id`,
      )
      .all(sessionId, notBefore) as unknown as Array<{
      turnId: string;
      stepId: string;
      seq: number;
      name: string;
      status: string;
      startedAt: number;
      endedAt: number | null;
      detail: string | null;
      errorText: string | null;
    }>;
  }

  /** Drops every tool step belonging to one bot. Called wherever a bot's chat stops being the thing
   *  those steps described: a reset, a delete, a re-pin. */
  deleteBotChatToolSteps(bot: string): void {
    this.#db.prepare("DELETE FROM bot_chat_tool_steps WHERE bot = ?").run(bot);
  }

  /** Drops every tool step older than the TTL. Returns how many went, so a caller can log it. */
  sweepBotChatToolSteps(now: number, ttlMs: number): number {
    return this.#db.prepare("DELETE FROM bot_chat_tool_steps WHERE started_at < ?").run(now - ttlMs)
      .changes as number;
  }

  botRoutineOverrides(bot: string, routineId: string): BotRoutineOverrides | undefined {
    const row = this.#db
      .prepare("SELECT overrides_json AS overridesJson FROM bot_routine_overrides WHERE bot = ? AND routine_id = ?")
      .get(bot, routineId) as { overridesJson: string } | undefined;
    if (row === undefined) return undefined;
    const parsed: unknown = JSON.parse(row.overridesJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record["model"] === "string" || record["model"] === null
        ? { model: record["model"] as string | null }
        : {}),
      ...(typeof record["effort"] === "string" || record["effort"] === null
        ? { effort: record["effort"] as string | null }
        : {}),
    };
  }

  setBotRoutineOverrides(bot: string, routineId: string, overrides: BotRoutineOverrides): void {
    if (overrides.model === undefined && overrides.effort === undefined) {
      this.deleteBotRoutineOverrides(bot, routineId);
      return;
    }
    this.#db
      .prepare(
        `INSERT INTO bot_routine_overrides (bot, routine_id, overrides_json) VALUES (?, ?, ?)
         ON CONFLICT(bot, routine_id) DO UPDATE SET overrides_json = excluded.overrides_json`,
      )
      .run(bot, routineId, JSON.stringify(overrides));
  }

  deleteBotRoutineOverrides(bot: string, routineId: string): void {
    this.#db.prepare("DELETE FROM bot_routine_overrides WHERE bot = ? AND routine_id = ?").run(bot, routineId);
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
      // The images and assistant rewrite markers too. A deleted bot is the clearest signal there is
      // that nobody is coming back for them, and a rebuilt bot reusing the name must not inherit its
      // predecessor's pictures or transcript rewrites.
      this.#db.prepare("DELETE FROM bot_chat_attachments WHERE bot = ?").run(name);
      this.#db.prepare("DELETE FROM bot_chat_assistant_media WHERE bot = ?").run(name);
      // The tool steps go with them, same name-keying argument: a rebuilt bot reusing the name must
      // not show a history strip describing what its predecessor did.
      this.#db.prepare("DELETE FROM bot_chat_tool_steps WHERE bot = ?").run(name);
      this.#db.prepare("DELETE FROM bot_routine_overrides WHERE bot = ?").run(name);
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

  /** Durably queues one gateway→plugin command. Reusing commandId is idempotent and returns the
   * original frame, which lets a caller safely retry after an ambiguous local failure. */
  enqueueAttachCommand(
    agentId: string,
    commandId: string,
    command: AttachV1Command,
    createdAt: number,
  ): AttachV1CommandFrame {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.#db
        .prepare(
          `SELECT sequence, command_json AS commandJson FROM attach_command_outbox
           WHERE agent_id = ? AND command_id = ?`,
        )
        .get(agentId, commandId) as { sequence: number; commandJson: string } | undefined;
      if (prior !== undefined) {
        this.#db.exec("COMMIT");
        return { kind: "command", sequence: prior.sequence, commandId, command: JSON.parse(prior.commandJson) as AttachV1Command };
      }
      this.#db
        .prepare(
          `INSERT INTO attach_streams (agent_id, next_command_sequence, last_event_sequence, updated_at)
           VALUES (?, 1, 0, ?) ON CONFLICT(agent_id) DO NOTHING`,
        )
        .run(agentId, createdAt);
      const stream = this.#db
        .prepare("SELECT next_command_sequence AS sequence FROM attach_streams WHERE agent_id = ?")
        .get(agentId) as { sequence: number };
      this.#db
        .prepare(
          `INSERT INTO attach_command_outbox
             (agent_id, sequence, command_id, command_json, created_at, acked_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(agentId, stream.sequence, commandId, JSON.stringify(command), createdAt);
      this.#db
        .prepare("UPDATE attach_streams SET next_command_sequence = ?, updated_at = ? WHERE agent_id = ?")
        .run(stream.sequence + 1, createdAt, agentId);
      this.#db.exec("COMMIT");
      return { kind: "command", sequence: stream.sequence, commandId, command };
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  pendingAttachCommands(agentId: string, afterSequence: number, limit: number): AttachV1CommandFrame[] {
    const rows = this.#db
      .prepare(
        `SELECT sequence, command_id AS commandId, command_json AS commandJson,
                cancelled_at AS cancelledAt, cancel_reason AS cancelReason
         FROM attach_command_outbox
         WHERE agent_id = ? AND sequence > ? AND acked_at IS NULL
         ORDER BY sequence LIMIT ?`,
      )
      .all(agentId, afterSequence, limit) as unknown as Array<{ sequence: number; commandId: string; commandJson: string; cancelledAt: number | null; cancelReason: string | null }>;
    return rows.map((row) => ({
      kind: "command",
      sequence: row.sequence,
      commandId: row.commandId,
      command: row.cancelledAt === null
        ? JSON.parse(row.commandJson) as AttachV1Command
        : {
            kind: "discard" as const,
            originalKind: (JSON.parse(row.commandJson) as AttachV1Command).kind as Exclude<AttachV1Command["kind"], "discard">,
            reason: row.cancelReason ?? "capability no longer negotiated",
          },
    }));
  }

  cancelAttachCommand(agentId: string, sequence: number, commandId: string, reason: string, cancelledAt: number): AttachV1CommandFrame | undefined {
    this.#db
      .prepare(
        `UPDATE attach_command_outbox
         SET cancelled_at = COALESCE(cancelled_at, ?), cancel_reason = COALESCE(cancel_reason, ?)
         WHERE agent_id = ? AND sequence = ? AND command_id = ? AND acked_at IS NULL`,
      )
      .run(cancelledAt, reason.slice(0, 512), agentId, sequence, commandId);
    return this.pendingAttachCommands(agentId, sequence - 1, 1)[0];
  }

  attachCommandCancellation(agentId: string, sequence: number): { reason: string; cancelledAt: number } | undefined {
    const row = this.#db
      .prepare(
        `SELECT cancel_reason AS reason, cancelled_at AS cancelledAt
         FROM attach_command_outbox WHERE agent_id = ? AND sequence = ? AND cancelled_at IS NOT NULL`,
      )
      .get(agentId, sequence) as { reason: string; cancelledAt: number } | undefined;
    return row;
  }

  ackAttachCommand(agentId: string, sequence: number, commandId: string, ackedAt: number): boolean {
    return this.#db
      .prepare(
        `UPDATE attach_command_outbox SET acked_at = COALESCE(acked_at, ?)
         WHERE agent_id = ? AND sequence = ? AND command_id = ?`,
      )
      .run(ackedAt, agentId, sequence, commandId).changes === 1;
  }

  /** Reconciles a plugin's durable contiguous processed-command cursor after an ACK was lost.
   * Refusing cursors beyond the issued tail prevents a corrupt peer from skipping future rows. */
  reconcileAttachCommandResume(agentId: string, processedThrough: number, ackedAt: number): boolean {
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM attach_command_outbox WHERE agent_id = ?")
      .get(agentId) as { sequence: number };
    if (processedThrough < 0 || processedThrough > row.sequence) return false;
    this.#db
      .prepare(
        `UPDATE attach_command_outbox SET acked_at = COALESCE(acked_at, ?)
         WHERE agent_id = ? AND sequence <= ?`,
      )
      .run(ackedAt, agentId, processedThrough);
    return true;
  }

  attachCommandCursor(agentId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(
           MIN(CASE WHEN acked_at IS NULL THEN sequence END) - 1,
           MAX(sequence),
           0
         ) AS sequence
         FROM attach_command_outbox WHERE agent_id = ?`,
      )
      .get(agentId) as { sequence: number };
    return row.sequence;
  }

  attachEventCursor(agentId: string): number {
    const row = this.#db
      .prepare("SELECT last_event_sequence AS sequence FROM attach_streams WHERE agent_id = ?")
      .get(agentId) as { sequence: number } | undefined;
    return row?.sequence ?? 0;
  }

  /** Inbox admission is the ACK boundary. Sequence must be contiguous; duplicates by eventId are
   * harmless; and a terminal transition seals its turn so a late draft is journaled/ACKed but never
   * applied. */
  acceptAttachEvent(
    agentId: string,
    frame: AttachV1EventFrame,
    receivedAt: number,
  ):
    | { status: "accepted" | "duplicate" | "ignored_terminal" | "ignored_delivery"; acknowledgedSequence: number }
    | { status: "gap"; expectedSequence: number; receivedSequence: number }
    | { status: "conflict"; acknowledgedSequence: number } {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.#db
        .prepare("SELECT sequence FROM attach_event_inbox WHERE agent_id = ? AND event_id = ?")
        .get(agentId, frame.eventId) as { sequence: number } | undefined;
      if (duplicate !== undefined) {
        this.#db.exec("COMMIT");
        return duplicate.sequence === frame.sequence
          ? { status: "duplicate", acknowledgedSequence: duplicate.sequence }
          : { status: "conflict", acknowledgedSequence: duplicate.sequence };
      }
      this.#db
        .prepare(
          `INSERT INTO attach_streams (agent_id, next_command_sequence, last_event_sequence, updated_at)
           VALUES (?, 1, 0, ?) ON CONFLICT(agent_id) DO NOTHING`,
        )
        .run(agentId, receivedAt);
      const stream = this.#db
        .prepare("SELECT last_event_sequence AS sequence FROM attach_streams WHERE agent_id = ?")
        .get(agentId) as { sequence: number };
      if (frame.sequence !== stream.sequence + 1) {
        this.#db.exec("COMMIT");
        if (frame.sequence <= stream.sequence) return { status: "conflict", acknowledgedSequence: stream.sequence };
        return { status: "gap", expectedSequence: stream.sequence + 1, receivedSequence: frame.sequence };
      }
      const event = frame.event;
      const turnId = "turnId" in event ? event.turnId : undefined;
      const terminal = event.kind === "commit" || event.kind === "failed" || event.kind === "cancelled" || event.kind === "interrupted";
      const sealed = turnId === undefined
        ? undefined
        : (this.#db.prepare("SELECT event_id AS eventId FROM attach_turn_terminals WHERE agent_id = ? AND turn_id = ?").get(agentId, turnId) as { eventId: string } | undefined);
      let disposition: "accepted" | "ignored_terminal" | "ignored_delivery" =
        sealed === undefined ? "accepted" : "ignored_terminal";
      if (event.kind === "scheduled") {
        const prior = this.#db
          .prepare(
            `SELECT thread_id AS threadId, message_id AS messageId FROM attach_scheduled_deliveries
             WHERE agent_id = ? AND delivery_id = ?`,
          )
          .get(agentId, event.deliveryId) as { threadId: string; messageId: string } | undefined;
        if (prior !== undefined) {
          if (prior.threadId !== event.threadId || prior.messageId !== event.messageId) {
            this.#db.exec("COMMIT");
            return { status: "conflict", acknowledgedSequence: stream.sequence };
          }
          disposition = "ignored_delivery";
        } else {
          this.#db
            .prepare(
              `INSERT INTO attach_scheduled_deliveries
                 (agent_id, delivery_id, thread_id, message_id, event_id, projected_at)
               VALUES (?, ?, ?, ?, ?, NULL)`,
            )
            .run(agentId, event.deliveryId, event.threadId, event.messageId, frame.eventId);
        }
      }
      this.#db
        .prepare(
          `INSERT INTO attach_event_inbox
             (agent_id, sequence, event_id, frame_json, received_at, disposition, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(agentId, frame.sequence, frame.eventId, JSON.stringify(frame), receivedAt, disposition);
      if (terminal && sealed === undefined) {
        this.#db
          .prepare(
            `INSERT INTO attach_turn_terminals
               (agent_id, turn_id, event_id, terminal_kind, message_id, sequence)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(agentId, event.turnId, frame.eventId, event.kind, event.messageId, frame.sequence);
      }
      this.#db
        .prepare("UPDATE attach_streams SET last_event_sequence = ?, updated_at = ? WHERE agent_id = ?")
        .run(frame.sequence, receivedAt, agentId);
      this.#db.exec("COMMIT");
      return { status: disposition, acknowledgedSequence: frame.sequence };
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  markAttachEventApplied(agentId: string, eventId: string, appliedAt: number): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE attach_event_inbox SET applied_at = ? WHERE agent_id = ? AND event_id = ?").run(appliedAt, agentId, eventId);
      this.#db.prepare("UPDATE attach_scheduled_deliveries SET projected_at = COALESCE(projected_at, ?) WHERE agent_id = ? AND event_id = ?").run(appliedAt, agentId, eventId);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  recordAttachProjectionFailure(agentId: string, eventId: string, error: string, failedAt: number, maxAttempts: number): { attempts: number; deadLettered: boolean } {
    this.#db
      .prepare(
        `UPDATE attach_event_inbox
         SET projection_attempts = projection_attempts + 1,
             projection_error = ?,
             dead_lettered_at = CASE WHEN projection_attempts + 1 >= ? THEN COALESCE(dead_lettered_at, ?) ELSE dead_lettered_at END
         WHERE agent_id = ? AND event_id = ? AND applied_at IS NULL`,
      )
      .run(error.slice(0, 512), maxAttempts, failedAt, agentId, eventId);
    const row = this.#db
      .prepare(
        `SELECT projection_attempts AS attempts, dead_lettered_at AS deadLetteredAt
         FROM attach_event_inbox WHERE agent_id = ? AND event_id = ?`,
      )
      .get(agentId, eventId) as { attempts: number; deadLetteredAt: number | null };
    return { attempts: row.attempts, deadLettered: row.deadLetteredAt !== null };
  }

  attachProjectionFailure(agentId: string, eventId: string): { attempts: number; error?: string; deadLetteredAt?: number } | undefined {
    const row = this.#db
      .prepare(
        `SELECT projection_attempts AS attempts, projection_error AS error, dead_lettered_at AS deadLetteredAt
         FROM attach_event_inbox WHERE agent_id = ? AND event_id = ?`,
      )
      .get(agentId, eventId) as { attempts: number; error: string | null; deadLetteredAt: number | null } | undefined;
    if (row === undefined) return undefined;
    return { attempts: row.attempts, ...(row.error === null ? {} : { error: row.error }), ...(row.deadLetteredAt === null ? {} : { deadLetteredAt: row.deadLetteredAt }) };
  }

  releaseAttachProjectionDeadLetter(agentId: string, eventId: string): boolean {
    const earliest = this.#db
      .prepare(
        `SELECT event_id AS eventId FROM attach_event_inbox
         WHERE agent_id = ? AND dead_lettered_at IS NOT NULL ORDER BY sequence LIMIT 1`,
      )
      .get(agentId) as { eventId: string } | undefined;
    if (earliest?.eventId !== eventId) return false;
    return this.#db
      .prepare(
        `UPDATE attach_event_inbox
         SET projection_attempts = 0, projection_error = NULL, dead_lettered_at = NULL
         WHERE agent_id = ? AND event_id = ? AND applied_at IS NULL`,
      )
      .run(agentId, eventId).changes === 1;
  }

  unappliedAttachEvents(agentId: string, limit = 256): AttachV1EventFrame[] {
    const rows = this.#db
      .prepare(
        `SELECT frame_json AS frameJson FROM attach_event_inbox
         WHERE agent_id = ? AND disposition = 'accepted' AND applied_at IS NULL
           AND dead_lettered_at IS NULL
           AND sequence < COALESCE(
             (SELECT MIN(blocked.sequence) FROM attach_event_inbox AS blocked
              WHERE blocked.agent_id = ? AND blocked.dead_lettered_at IS NOT NULL),
             9223372036854775807
           )
         ORDER BY sequence LIMIT ?`,
      )
      .all(agentId, agentId, limit) as unknown as Array<{ frameJson: string }>;
    return rows.map((row) => JSON.parse(row.frameJson) as AttachV1EventFrame);
  }

  attachTurnCommand(agentId: string, turnId: string): { threadId: string; messageId: string } | undefined {
    const rows = this.#db
      .prepare(
        `SELECT command_json AS commandJson, cancelled_at AS cancelledAt FROM attach_command_outbox
         WHERE agent_id = ? ORDER BY sequence DESC`,
      )
      .all(agentId) as unknown as Array<{ commandJson: string; cancelledAt: number | null }>;
    for (const row of rows) {
      if (row.cancelledAt !== null) continue;
      const command = JSON.parse(row.commandJson) as AttachV1Command;
      if (command.kind === "turn" && command.turnId === turnId) return { threadId: command.threadId, messageId: command.messageId };
    }
    return undefined;
  }

  attachScheduledDelivery(agentId: string, deliveryId: string): { threadId: string; messageId: string; projectedAt: number | null } | undefined {
    return this.#db
      .prepare(
        `SELECT thread_id AS threadId, message_id AS messageId, projected_at AS projectedAt
         FROM attach_scheduled_deliveries WHERE agent_id = ? AND delivery_id = ?`,
      )
      .get(agentId, deliveryId) as { threadId: string; messageId: string; projectedAt: number | null } | undefined;
  }

  saveAttachMedia(
    agentId: string,
    descriptor: AttachV1MediaDescriptor,
    bytes: Uint8Array,
    createdAt: number,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO attach_media
           (agent_id, media_id, descriptor_json, mime, size, sha256, bytes, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agentId,
        descriptor.mediaId,
        JSON.stringify(descriptor),
        descriptor.mimeType,
        bytes.byteLength,
        descriptor.sha256,
        bytes,
        createdAt,
        descriptor.expiresAt ?? null,
      );
  }

  attachMediaInfo(
    agentId: string,
    mediaId: string,
    now: number,
  ): { descriptor: AttachV1MediaDescriptor; mime: string; size: number; sha256: string } | undefined {
    const row = this.#db
      .prepare(
        `SELECT descriptor_json AS descriptorJson, mime, size, sha256 FROM attach_media
         WHERE agent_id = ? AND media_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(agentId, mediaId, now) as { descriptorJson: string; mime: string; size: number; sha256: string } | undefined;
    return row === undefined ? undefined : { descriptor: JSON.parse(row.descriptorJson) as AttachV1MediaDescriptor, mime: row.mime, size: row.size, sha256: row.sha256 };
  }

  attachMediaSlice(agentId: string, mediaId: string, start: number, length: number, now: number): Uint8Array | undefined {
    const row = this.#db
      .prepare(
        `SELECT substr(bytes, ?, ?) AS bytes FROM attach_media
         WHERE agent_id = ? AND media_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(start + 1, length, agentId, mediaId, now) as { bytes: Uint8Array } | undefined;
    return row?.bytes;
  }

  nativeBotChat(bot: string, now: number): { sessionId: string; created: boolean; activeTurnId?: string } {
    const prior = this.#db
      .prepare("SELECT session_id AS sessionId, active_turn_id AS activeTurnId FROM bot_native_chats WHERE bot = ?")
      .get(bot) as { sessionId: string; activeTurnId: string | null } | undefined;
    if (prior !== undefined) return { sessionId: prior.sessionId, created: false, ...(prior.activeTurnId === null ? {} : { activeTurnId: prior.activeTurnId }) };
    const sessionId = `native:${bot}:${randomUUID()}`;
    this.#db.prepare("INSERT INTO bot_native_chats (bot, session_id, active_turn_id, updated_at) VALUES (?, ?, NULL, ?)").run(bot, sessionId, now);
    return { sessionId, created: true };
  }

  resetNativeBotChat(bot: string, now: number): string {
    const sessionId = `native:${bot}:${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO bot_native_chats (bot, session_id, active_turn_id, updated_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT(bot) DO UPDATE SET session_id = excluded.session_id, active_turn_id = NULL, updated_at = excluded.updated_at`,
      )
      .run(bot, sessionId, now);
    return sessionId;
  }

  setNativeBotTurn(bot: string, turnId: string | undefined, now: number): void {
    this.#db.prepare("UPDATE bot_native_chats SET active_turn_id = ?, updated_at = ? WHERE bot = ?").run(turnId ?? null, now, bot);
  }

  appendNativeBotMessage(input: {
    bot: string;
    sessionId: string;
    messageId: string;
    role: string;
    text: string;
    at: number;
    clientId?: string;
    attachments?: AttachmentBlock[];
  }): BotChatMessage {
    const prior = this.#db
      .prepare(
        `SELECT message_id AS id, role, text, at, client_id AS clientId, attachments_json AS attachmentsJson
         FROM bot_native_messages WHERE bot = ? AND message_id = ?`,
      )
      .get(input.bot, input.messageId) as { id: string; role: string; text: string; at: number | null; clientId: string | null; attachmentsJson: string | null } | undefined;
    if (prior !== undefined) return nativeBotMessage(prior);
    const next = this.#db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM bot_native_messages WHERE bot = ? AND session_id = ?")
      .get(input.bot, input.sessionId) as { seq: number };
    this.#db
      .prepare(
        `INSERT INTO bot_native_messages
           (bot, session_id, seq, message_id, role, text, at, client_id, attachments_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.bot,
        input.sessionId,
        next.seq,
        input.messageId,
        input.role,
        input.text,
        input.at,
        input.clientId ?? null,
        input.attachments === undefined ? null : JSON.stringify(input.attachments),
      );
    return { id: input.messageId, role: input.role, text: input.text, at: input.at, ...(input.clientId === undefined ? {} : { clientId: input.clientId }), ...(input.attachments === undefined ? {} : { attachments: input.attachments }) };
  }

  nativeBotMessages(bot: string, sessionId: string): BotChatMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT message_id AS id, role, text, at, client_id AS clientId, attachments_json AS attachmentsJson
         FROM bot_native_messages WHERE bot = ? AND session_id = ? ORDER BY seq`,
      )
      .all(bot, sessionId) as unknown as Array<{ id: string; role: string; text: string; at: number | null; clientId: string | null; attachmentsJson: string | null }>;
    return rows.map(nativeBotMessage);
  }

  nativeBotMessage(bot: string, messageId: string): BotChatMessage | undefined {
    const row = this.#db
      .prepare(
        `SELECT message_id AS id, role, text, at, client_id AS clientId, attachments_json AS attachmentsJson
         FROM bot_native_messages WHERE bot = ? AND message_id = ?`,
      )
      .get(bot, messageId) as { id: string; role: string; text: string; at: number | null; clientId: string | null; attachmentsJson: string | null } | undefined;
    return row === undefined ? undefined : nativeBotMessage(row);
  }

  recordNativeInteraction(input: {
    bot: string;
    kind: "approval" | "clarify";
    interactionId: string;
    sessionId: string;
    turnId: string;
    payload: unknown;
    status: string;
    selectedOptionId?: string;
    expiresAt?: number;
    updatedAt: number;
  }): "inserted" | "updated" | "duplicate" {
    const prior = this.nativeInteraction(input.bot, input.kind, input.interactionId);
    if (prior === undefined) {
      this.#db
        .prepare(
          `INSERT INTO bot_native_interactions
             (bot, kind, interaction_id, session_id, turn_id, payload_json, status,
              selected_option_id, expires_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.bot, input.kind, input.interactionId, input.sessionId, input.turnId, JSON.stringify(input.payload), input.status, input.selectedOptionId ?? null, input.expiresAt ?? null, input.updatedAt);
      return "inserted";
    }
    if (prior.status !== "pending") return "duplicate";
    if (input.status === "pending") return "duplicate";
    this.#db
      .prepare(
        `UPDATE bot_native_interactions SET status = ?, selected_option_id = ?, updated_at = ?
         WHERE bot = ? AND kind = ? AND interaction_id = ? AND status = 'pending'`,
      )
      .run(input.status, input.selectedOptionId ?? null, input.updatedAt, input.bot, input.kind, input.interactionId);
    return "updated";
  }

  resolveNativeInteraction(
    bot: string,
    kind: "approval" | "clarify",
    interactionId: string,
    status: string,
    updatedAt: number,
    selectedOptionId?: string,
  ): boolean {
    return this.#db
      .prepare(
        `UPDATE bot_native_interactions SET status = ?, selected_option_id = ?, updated_at = ?
         WHERE bot = ? AND kind = ? AND interaction_id = ? AND status = 'pending'`,
      )
      .run(status, selectedOptionId ?? null, updatedAt, bot, kind, interactionId).changes === 1;
  }

  nativeInteraction(
    bot: string,
    kind: "approval" | "clarify",
    interactionId: string,
  ): { sessionId: string; turnId: string; payload: unknown; status: string; selectedOptionId: string | null; expiresAt: number | null; updatedAt: number } | undefined {
    const row = this.#db
      .prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, payload_json AS payloadJson, status,
                selected_option_id AS selectedOptionId, expires_at AS expiresAt, updated_at AS updatedAt
         FROM bot_native_interactions WHERE bot = ? AND kind = ? AND interaction_id = ?`,
      )
      .get(bot, kind, interactionId) as { sessionId: string; turnId: string; payloadJson: string; status: string; selectedOptionId: string | null; expiresAt: number | null; updatedAt: number } | undefined;
    return row === undefined ? undefined : { ...row, payload: JSON.parse(row.payloadJson) as unknown };
  }

  pendingNativeInteractions(bot?: string): Array<{
    bot: string; kind: "approval" | "clarify"; interactionId: string; sessionId: string; turnId: string;
    payload: unknown; expiresAt: number | null; updatedAt: number;
  }> {
    const rows = this.#db
      .prepare(
        `SELECT bot, kind, interaction_id AS interactionId, session_id AS sessionId, turn_id AS turnId,
                payload_json AS payloadJson, expires_at AS expiresAt, updated_at AS updatedAt
         FROM bot_native_interactions WHERE status = 'pending' AND (? IS NULL OR bot = ?)
         ORDER BY updated_at, interaction_id`,
      )
      .all(bot ?? null, bot ?? null) as unknown as Array<{ bot: string; kind: "approval" | "clarify"; interactionId: string; sessionId: string; turnId: string; payloadJson: string; expiresAt: number | null; updatedAt: number }>;
    return rows.map(({ payloadJson, ...row }) => ({ ...row, payload: JSON.parse(payloadJson) as unknown }));
  }

  close(): void {
    this.#db.close();
  }
}

function nativeBotMessage(row: { id: string; role: string; text: string; at: number | null; clientId: string | null; attachmentsJson: string | null }): BotChatMessage {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    at: row.at,
    ...(row.clientId === null ? {} : { clientId: row.clientId }),
    ...(row.attachmentsJson === null ? {} : { attachments: JSON.parse(row.attachmentsJson) as AttachmentBlock[] }),
  };
}

/** True for the one error ADD COLUMN is expected to throw: the column is already there because
 *  this DB was already migrated. Anything else (locked, busy, read-only, disk full, ...) is a real
 *  failure and must not be swallowed, or every query against the column throws "no such column"
 *  gateway-wide while /health stays green. */
function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && /duplicate column name/i.test(err.message);
}

/** Additive migration: adds `column` to `table` if it is not already there. Safe to run on every
 *  boot. Swallows only the duplicate-column error a re-run produces; anything else propagates.
 *  Verifies the column exists afterward via PRAGMA table_info so a swallowed-but-wrong error (or a
 *  driver that reports success without applying the change) fails loudly instead of leaving the
 *  gateway to discover the missing column mid-query later. */
export function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    if (!isDuplicateColumnError(err)) throw err;
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    throw new Error(`migration failed: "${table}.${column}" missing after ALTER TABLE`);
  }
}

export function openStorage(dbPath: string): Storage {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // Additive migration for a DB created before the delivery column existed.
  addColumnIfMissing(db, "messages", "delivery", "TEXT");
  addColumnIfMissing(db, "messages", "external_id", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS messages_external_id ON messages (thread_id, external_id) WHERE external_id IS NOT NULL");
  // Same shape, for a DB created before ext-bots capability 11 gave an unwritten chat a durable
  // runtime id. NULL on every existing row is exactly right: a pin written by an older gateway
  // points at a chat its kickoff already persisted, so there is nothing to remember for it.
  addColumnIfMissing(db, "bot_chat_pins", "runtime_id", "TEXT");
  // Issue #66: the generation stamp that bounds a durable runtime id by the life of the hermes that
  // issued it. NULL on every existing row is right and is the safe direction: a stamp that matches
  // nothing reads as "this id cannot be trusted", so a pin written before the upgrade falls through
  // to the mint-a-replacement path instead of submitting at a session hermes may have forgotten.
  addColumnIfMissing(db, "bot_chat_pins", "runtime_generation", "TEXT");
  // Capability 16: an explicit session adoption holds until a later conversational session is
  // created. Existing pins are automatic, which is exactly the zero default.
  addColumnIfMissing(db, "bot_chat_pins", "manual", "INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1))");
  // Capability 21: bounded redacted tool detail. Existing rows remain valid and simply have no
  // detail, which keeps older transcript history honest rather than manufacturing descriptions.
  addColumnIfMissing(db, "bot_chat_tool_steps", "detail", "TEXT");
  addColumnIfMissing(db, "bot_chat_tool_steps", "error_text", "TEXT");
  addColumnIfMissing(db, "attach_event_inbox", "projection_attempts", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "attach_event_inbox", "projection_error", "TEXT");
  addColumnIfMissing(db, "attach_event_inbox", "dead_lettered_at", "INTEGER");
  addColumnIfMissing(db, "attach_command_outbox", "cancelled_at", "INTEGER");
  addColumnIfMissing(db, "attach_command_outbox", "cancel_reason", "TEXT");
  return new Storage(db);
}

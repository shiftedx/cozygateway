import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import type {
  AttachmentBlock,
  BotChatAttachment,
  BotChatMessage,
  BotMobileReceipt,
  BotInteractionSettlement,
  BotPendingClarification,
  BotSummary,
  Message,
  MessageRole,
  RichBlock,
} from "cozygateway-contract";
import type {
  AttachV1Command,
  AttachV1CommandFrame,
  AttachV1DiscardReason,
  AttachV1EventFrame,
  AttachV1MediaDescriptor,
  AttachV1Telemetry,
} from "./adapters/attach/protocol-v1.ts";
import { SETUP_CODE_TTL_MS } from "./auth.ts";

/** Result of atomically recording a device decision and enqueueing its attach command. This is
 * deliberately internal: only the bot plane derives the outward REST/frame state. */
export type NativeInteractionResolutionRequest =
  | {
      outcome: "requested" | "already_requested" | "resolution_pending";
      sessionId: string;
      turnId: string;
      fresh: boolean;
    }
  | { outcome: "expired"; sessionId: string; turnId: string }
  | { outcome: "unknown" | "not_pending" };

/** Terminal receipts are reconnect aids, not permanent interaction history. Pending rows are
 * never pruned; retain only the newest bounded terminal proof per profile. */
const NATIVE_INTERACTION_SETTLEMENT_LIMIT = 100;

const BOT_MOBILE_RECEIPT_COLUMNS = `
  request_id TEXT PRIMARY KEY,
  bot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  command TEXT NOT NULL CHECK (command IN (
    'device.status', 'location.current', 'camera.capture', 'file.pick', 'notification.present'
  )),
  shared_description TEXT NOT NULL CHECK (shared_description IN (
    'Device status', 'Approximate location', 'Camera photo', 'Camera video',
    'Selected photo', 'Selected file', 'Notification action'
  )),
  purpose TEXT NOT NULL,
  shared_at INTEGER NOT NULL
`;

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
  used_at INTEGER,
  challenge_id TEXT REFERENCES onboarding_challenges(challenge_id),
  output_state TEXT NOT NULL DEFAULT 'active'
    CHECK (output_state IN ('pending_output', 'active', 'revoked'))
) STRICT;
CREATE TABLE IF NOT EXISTS onboarding_runtime (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  boot_generation TEXT NOT NULL,
  verification_epoch TEXT NOT NULL,
  canonical_origin TEXT NOT NULL,
  durable_fingerprint TEXT NOT NULL,
  started_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  session_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('tailscale', 'lan', 'advanced')),
  canonical_origin TEXT NOT NULL,
  durable_fingerprint TEXT NOT NULL,
  verification_epoch TEXT NOT NULL,
  boot_generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'complete', 'abandoned')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  winning_challenge_id TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_one_active_session
  ON onboarding_sessions ((1)) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS onboarding_challenges (
  challenge_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES onboarding_sessions(session_id),
  capability_hash TEXT NOT NULL UNIQUE,
  phrase TEXT NOT NULL,
  canonical_origin TEXT NOT NULL,
  durable_fingerprint TEXT NOT NULL,
  verification_epoch TEXT NOT NULL,
  boot_generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'ws_probed', 'phone_confirmed', 'consumed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  invalidated_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_one_live_challenge
  ON onboarding_challenges (session_id)
  WHERE state IN ('active', 'ws_probed', 'phone_confirmed');
CREATE TABLE IF NOT EXISTS onboarding_ownership (
  ownership_key TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('tailscale', 'lan', 'advanced')),
  durable_fingerprint TEXT NOT NULL,
  owned_state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS live_activity_registrations (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  bot TEXT NOT NULL,
  push_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL DEFAULT 0,
  last_timestamp INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, activity_id)
) STRICT;
CREATE TABLE IF NOT EXISTS live_activity_relay_deletion_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  push_id TEXT NOT NULL UNIQUE,
  queued_at INTEGER NOT NULL
) STRICT;
-- Hermes Dashboard control-plane roster cache. Bot Mode conversations live in native attach-v1
-- tables below.
CREATE TABLE IF NOT EXISTS bot_roster (
  name TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL,
  position INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
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
-- Capability 34 delegation children. Same shape of honesty as bot_chat_tool_steps: a child
-- belongs to a TURN's batch, keyed by (batch, child) where child_id is the Hermes child session
-- id that joins the spawn and finish legs of one delegation, and the only text here is the
-- bounded display text the wire already carries (a truncated task label, a tool name) -- never
-- a child transcript, summary, or path.
CREATE TABLE IF NOT EXISTS bot_chat_delegations (
  bot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  child_index INTEGER NOT NULL,
  batch_count INTEGER NOT NULL,
  alias_id TEXT,
  label TEXT,
  status TEXT NOT NULL,
  current_tool TEXT,
  api_calls INTEGER,
  tool_count INTEGER,
  last_active_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (bot, turn_id, batch_id, child_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bot_chat_delegations_session
  ON bot_chat_delegations (session_id, started_at);
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
-- A group turn is a durable hand-off to an attach-v1 profile.  It records the one member turn a
-- serial room may have outstanding, so a restart can authenticate its eventual event and resume
-- the room without consulting the Dashboard chat plane.
CREATE TABLE IF NOT EXISTS bot_group_turns (
  -- Intentionally no FK: a late terminal event after DELETE must still be acknowledged rather
  -- than poison the profile's ordered inbox. The row is a harmless ownership tombstone then.
  group_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  member TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  watermark INTEGER NOT NULL,
  state TEXT NOT NULL,
  text TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  consumed_at INTEGER,
  PRIMARY KEY (group_key, turn_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bot_group_turns_target ON bot_group_turns(agent_id, thread_id, turn_id);
-- attach-v1 is an at-least-once transport. Both journals are gateway-owned durability boundaries:
-- commands survive until the plugin ACKs them, and events are ACKed only after the inbox commit.
CREATE TABLE IF NOT EXISTS attach_streams (
  agent_id TEXT PRIMARY KEY,
  next_command_sequence INTEGER NOT NULL DEFAULT 1,
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  plugin_event_outbox_depth INTEGER,
  plugin_oldest_event_age_ms INTEGER,
  plugin_event_ack_cursor INTEGER,
  plugin_last_ack_progress_at INTEGER,
  plugin_command_inbox_depth INTEGER,
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
-- bot_native_chats is deliberately only the active-session pointer. A bot can have more than
-- one local attach conversation, so the durable session rows live separately rather than being
-- overwritten by reset/new-session actions.
CREATE TABLE IF NOT EXISTS bot_native_sessions (
  bot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  active_turn_id TEXT,
  PRIMARY KEY (bot, session_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bot_native_sessions_recent
  ON bot_native_sessions (bot, updated_at DESC, created_at DESC);
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
  marker TEXT,
  PRIMARY KEY (bot, session_id, seq),
  UNIQUE (bot, message_id)
) STRICT, WITHOUT ROWID;
-- Proof a HUMAN saw a row, which no other durable record in this gateway carries: a transcript row
-- proves only that the gateway holds the message, and push is fire-and-forget. First write wins and
-- rows are never deleted, so a receipt outlives the session selection that produced it.
CREATE TABLE IF NOT EXISTS bot_message_receipts (
  bot TEXT NOT NULL,
  message_id TEXT NOT NULL,
  displayed_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (bot, message_id)
) STRICT, WITHOUT ROWID;
-- Capability 39 phone-sharing receipts. The request id is the idempotency key; the remaining
-- columns are chat-visible metadata. Device identity, lease, and shared result are never stored.
CREATE TABLE IF NOT EXISTS bot_mobile_receipts (
${BOT_MOBILE_RECEIPT_COLUMNS}
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bot_mobile_receipts_session
  ON bot_mobile_receipts (bot, session_id, shared_at, request_id);
-- Binds one committed TURN reply that carried attachments to the delivery id its plugin already
-- keyed the media lifecycle under (turn:<turnId>). Scheduled deliveries have
-- attach_scheduled_deliveries for this; a turn had nothing, which is why turn media could never
-- move past 'journaled' no matter how many phones displayed it. First write wins, and the row
-- outlives the session selection so a receipt arriving days later still finds its delivery.
CREATE TABLE IF NOT EXISTS bot_turn_media_deliveries (
  bot TEXT NOT NULL,
  message_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  PRIMARY KEY (bot, message_id)
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
  resolution_command_id TEXT,
  resolution_requested_at INTEGER,
  requested_decision TEXT,
  requested_option_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot, kind, interaction_id)
) STRICT, WITHOUT ROWID;
-- Gateway-originated terminal truth complements attach's terminal journal: the wall-clock bound
-- can settle a durable queued turn before any plugin event exists.
CREATE TABLE IF NOT EXISTS bot_native_turn_terminals (
  bot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL,
  cause TEXT,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (bot, turn_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bot_native_turn_terminals_session
  ON bot_native_turn_terminals (bot, session_id, completed_at DESC);
`;

export interface DeviceRow {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
}

export type OnboardingMode = "tailscale" | "lan" | "advanced";
export type ChallengeState = "active" | "ws_probed" | "phone_confirmed" | "consumed";
export type SetupCodeOutputState = "pending_output" | "active" | "revoked";

export interface GatewayBoot {
  bootGeneration: string;
  verificationEpoch: string;
  canonicalOrigin: string;
  durableFingerprint: string;
  startedAt: number;
}

export interface SetupSessionInput {
  sessionId: string;
  mode: OnboardingMode;
  canonicalOrigin: string;
  durableFingerprint: string;
  verificationEpoch: string;
  bootGeneration: string;
  createdAt: number;
}

export type SetupSessionResult =
  | { outcome: "created" | "existing"; sessionId: string }
  | { outcome: "conflict"; sessionId: string }
  | { outcome: "stale_boot" };

export interface VerificationChallengeInput {
  challengeId: string;
  sessionId: string;
  capabilityHash: string;
  phrase: string;
  canonicalOrigin: string;
  durableFingerprint: string;
  verificationEpoch: string;
  bootGeneration: string;
  createdAt: number;
  expiresAt: number;
}

export type ChallengeResult =
  | { outcome: "created" | "existing"; challengeId: string }
  | { outcome: "conflict"; challengeId: string }
  | { outcome: "invalid_capability" | "invalid_expiry" | "invalid_session" | "stale_boot" };

export interface CapabilityTransition {
  capabilityHash: string;
  canonicalOrigin: string;
  durableFingerprint: string;
  verificationEpoch: string;
  bootGeneration: string;
  now: number;
}

export interface PublishedCode {
  challengeId: string;
  setupCode: string;
  now: number;
}

export type TransitionResult<
  State extends ChallengeState | SetupCodeOutputState = ChallengeState | SetupCodeOutputState,
> =
  | { outcome: "advanced" | "already"; state: State }
  | { outcome: "invalid_state" | "expired" | "invalid_context"; state: State }
  | { outcome: "not_found" };

export interface FinalizeInput {
  sessionId: string;
  challengeId: string;
  setupCode: string;
  setupCodeExpiresAt: number;
  canonicalOrigin: string;
  durableFingerprint: string;
  verificationEpoch: string;
  bootGeneration: string;
  now: number;
}

export type FinalizeResult =
  | { outcome: "published"; setupCode: string }
  | { outcome: "already_published" }
  | {
      outcome:
        | "code_conflict"
        | "expired"
        | "invalid_expiry"
        | "invalid_context"
        | "invalid_state"
        | "not_found";
    };
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
export interface LiveActivityRegistrationRow {
  deviceId: string;
  activityId: string;
  runId: string;
  conversationId: string;
  bot: string;
  pushId: string;
  eventSequence: number;
  lastTimestamp: number;
  createdAt: number;
}

export interface BotRoutineOverrides {
  model?: string | null;
  effort?: string | null;
}

export interface NativeBotAttachmentHistoryItem {
  bot: string;
  sessionId: string;
  messageId: string;
  caption: string;
  at: number | null;
  attachment: AttachmentBlock;
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

/** Durable ownership and settlement of one attach-v1 member turn. `pending` is the only state a
 * room may wait for; completed rows remain so at-least-once event replays stay authorized. */
export interface BotGroupTurnRow {
  key: string;
  turnId: string;
  member: string;
  agentId: string;
  threadId: string;
  messageId: string;
  epoch: number;
  watermark: number;
  state: "pending" | "commit" | "failed" | "cancelled" | "interrupted" | "timeout";
  text?: string;
  detail?: string;
  createdAt: number;
  completedAt?: number;
  consumedAt?: number;
}

/** Gateway-owned truth for an admitted scheduled delivery. `journaled` remains plugin-local and
 * push remains deliberately absent: its fire-and-forget path cannot prove human visibility. */
export interface AttachScheduledDeliveryReceipt {
  deliveryId: string;
  messageId: string;
  target:
    | { kind: "thread"; threadId: string }
    | { kind: "canonical_home"; sessionId: string };
  state: "admitted" | "projected" | "blocked";
  admittedAt: number;
  projectedAt?: number;
  attempts?: number;
  deadLetteredAt?: number;
  /** Capability 31. When a paired device reported the projected row on screen. */
  displayedAt?: number;
  /** Present together only when the admitted scheduled event expected media. These are a bounded
   * read-back of its requested IDs and the committed native row's actual attachment IDs. */
  expectedMediaIds?: string[];
  committedMediaIds?: string[];
  /** True only when projection is durable and the committed native attachment IDs exactly match
   * the expected IDs in order. Display and media upload are deliberately not substitutes. */
  mediaVerified?: boolean;
  /** The one terminal fact about this occurrence, once it has one. `state` above stays the
   * projection-pipeline position it has always been, so an existing reader is untouched. */
  terminal?: {
    state: "displayed" | "failed";
    stage?: "authorization" | "projection";
    reason?: string;
    at: number;
  };
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

function toBotGroupTurnRow(row: Record<string, unknown>): BotGroupTurnRow {
  const state = row["state"];
  if (state !== "pending" && state !== "commit" && state !== "failed" && state !== "cancelled" && state !== "interrupted" && state !== "timeout") {
    throw new Error("invalid stored group turn state");
  }
  const optional = (key: "text" | "detail" | "completedAt" | "consumedAt"): string | number | undefined =>
    row[key] === null || row[key] === undefined ? undefined : row[key] as string | number;
  return {
    key: String(row["key"]), turnId: String(row["turnId"]), member: String(row["member"]),
    agentId: String(row["agentId"]), threadId: String(row["threadId"]), messageId: String(row["messageId"]),
    epoch: Number(row["epoch"]), watermark: Number(row["watermark"]), state,
    ...(typeof optional("text") === "string" ? { text: optional("text") as string } : {}),
    ...(typeof optional("detail") === "string" ? { detail: optional("detail") as string } : {}),
    createdAt: Number(row["createdAt"]),
    ...(typeof optional("completedAt") === "number" ? { completedAt: optional("completedAt") as number } : {}),
    ...(typeof optional("consumedAt") === "number" ? { consumedAt: optional("consumedAt") as number } : {}),
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

  #immediate<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #runtimeMatches(input: {
    bootGeneration: string;
    verificationEpoch: string;
    canonicalOrigin: string;
    durableFingerprint: string;
  }): boolean {
    const runtime = this.#db.prepare(`
      SELECT boot_generation AS bootGeneration, verification_epoch AS verificationEpoch,
        canonical_origin AS canonicalOrigin, durable_fingerprint AS durableFingerprint
      FROM onboarding_runtime WHERE singleton = 1
    `).get() as {
      bootGeneration: string;
      verificationEpoch: string;
      canonicalOrigin: string;
      durableFingerprint: string;
    } | undefined;
    return runtime !== undefined
      && runtime.bootGeneration === input.bootGeneration
      && runtime.verificationEpoch === input.verificationEpoch
      && runtime.canonicalOrigin === input.canonicalOrigin
      && runtime.durableFingerprint === input.durableFingerprint;
  }

  /** Records an actual gateway boot. Merely opening the database is deliberately inert: callers
   * invoke this once from the gateway startup boundary after deriving the current posture. */
  beginGatewayBoot(input: GatewayBoot): void {
    this.#immediate(() => {
      const current = this.#db.prepare(`
        SELECT boot_generation AS bootGeneration, verification_epoch AS verificationEpoch,
          canonical_origin AS canonicalOrigin, durable_fingerprint AS durableFingerprint,
          started_at AS startedAt
        FROM onboarding_runtime WHERE singleton = 1
      `).get() as GatewayBoot | undefined;
      if (current?.bootGeneration === input.bootGeneration) {
        if (
          current.verificationEpoch !== input.verificationEpoch
          || current.canonicalOrigin !== input.canonicalOrigin
          || current.durableFingerprint !== input.durableFingerprint
          || current.startedAt !== input.startedAt
        ) throw new Error("onboarding boot generation was reused with different posture");
        return;
      }
      this.#db.prepare(`
        UPDATE setup_codes SET output_state = 'revoked'
        WHERE output_state = 'pending_output'
      `).run();
      this.#db.prepare(`
        UPDATE onboarding_challenges SET state = 'consumed', invalidated_at = ?
        WHERE state IN ('active', 'ws_probed', 'phone_confirmed')
      `).run(input.startedAt);
      this.#db.prepare(`
        UPDATE onboarding_sessions SET state = 'abandoned'
        WHERE state = 'active'
      `).run();
      this.#db.prepare(`
        INSERT INTO onboarding_runtime
          (singleton, boot_generation, verification_epoch, canonical_origin,
           durable_fingerprint, started_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          boot_generation = excluded.boot_generation,
          verification_epoch = excluded.verification_epoch,
          canonical_origin = excluded.canonical_origin,
          durable_fingerprint = excluded.durable_fingerprint,
          started_at = excluded.started_at
      `).run(
        input.bootGeneration,
        input.verificationEpoch,
        input.canonicalOrigin,
        input.durableFingerprint,
        input.startedAt,
      );
    });
  }

  beginSetupSession(input: SetupSessionInput): SetupSessionResult {
    return this.#immediate(() => {
      if (!this.#runtimeMatches(input)) return { outcome: "stale_boot" };
      const active = this.#db.prepare(`
        SELECT session_id AS sessionId, mode, canonical_origin AS canonicalOrigin,
          durable_fingerprint AS durableFingerprint, verification_epoch AS verificationEpoch,
          boot_generation AS bootGeneration, created_at AS createdAt
        FROM onboarding_sessions WHERE state = 'active'
      `).get() as SetupSessionInput | undefined;
      if (active !== undefined) {
        const same = active.sessionId === input.sessionId
          && active.mode === input.mode
          && active.canonicalOrigin === input.canonicalOrigin
          && active.durableFingerprint === input.durableFingerprint
          && active.verificationEpoch === input.verificationEpoch
          && active.bootGeneration === input.bootGeneration
          && active.createdAt === input.createdAt;
        return same
          ? { outcome: "existing", sessionId: active.sessionId }
          : { outcome: "conflict", sessionId: active.sessionId };
      }
      const reused = this.#db.prepare(
        "SELECT session_id AS sessionId FROM onboarding_sessions WHERE session_id = ?",
      ).get(input.sessionId) as { sessionId: string } | undefined;
      if (reused !== undefined) return { outcome: "conflict", sessionId: reused.sessionId };
      this.#db.prepare(`
        INSERT INTO onboarding_sessions
          (session_id, mode, canonical_origin, durable_fingerprint, verification_epoch,
           boot_generation, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(
        input.sessionId,
        input.mode,
        input.canonicalOrigin,
        input.durableFingerprint,
        input.verificationEpoch,
        input.bootGeneration,
        input.createdAt,
      );
      return { outcome: "created", sessionId: input.sessionId };
    });
  }

  createVerificationChallenge(input: VerificationChallengeInput): ChallengeResult {
    if (!/^[0-9a-f]{64}$/.test(input.capabilityHash))
      return { outcome: "invalid_capability" };
    if (input.expiresAt < input.createdAt || input.expiresAt > input.createdAt + SETUP_CODE_TTL_MS)
      return { outcome: "invalid_expiry" };
    return this.#immediate(() => {
      if (!this.#runtimeMatches(input)) return { outcome: "stale_boot" };
      const owner = this.#db.prepare(`
        SELECT session_id AS sessionId, canonical_origin AS canonicalOrigin,
          durable_fingerprint AS durableFingerprint, verification_epoch AS verificationEpoch,
          boot_generation AS bootGeneration
        FROM onboarding_sessions WHERE session_id = ? AND state = 'active'
      `).get(input.sessionId) as {
        sessionId: string;
        canonicalOrigin: string;
        durableFingerprint: string;
        verificationEpoch: string;
        bootGeneration: string;
      } | undefined;
      if (
        owner === undefined
        || owner.canonicalOrigin !== input.canonicalOrigin
        || owner.durableFingerprint !== input.durableFingerprint
        || owner.verificationEpoch !== input.verificationEpoch
        || owner.bootGeneration !== input.bootGeneration
      ) return { outcome: "invalid_session" };
      const live = this.#db.prepare(`
        SELECT challenge_id AS challengeId, capability_hash AS capabilityHash, phrase,
          created_at AS createdAt, expires_at AS expiresAt
        FROM onboarding_challenges
        WHERE session_id = ? AND state IN ('active', 'ws_probed', 'phone_confirmed')
      `).get(input.sessionId) as {
        challengeId: string;
        capabilityHash: string;
        phrase: string;
        createdAt: number;
        expiresAt: number;
      } | undefined;
      if (live !== undefined) {
        const same = live.challengeId === input.challengeId
          && live.capabilityHash === input.capabilityHash
          && live.phrase === input.phrase
          && live.createdAt === input.createdAt
          && live.expiresAt === input.expiresAt;
        return same
          ? { outcome: "existing", challengeId: live.challengeId }
          : { outcome: "conflict", challengeId: live.challengeId };
      }
      const collision = this.#db.prepare(`
        SELECT challenge_id AS challengeId FROM onboarding_challenges
        WHERE challenge_id = ? OR capability_hash = ? LIMIT 1
      `).get(input.challengeId, input.capabilityHash) as { challengeId: string } | undefined;
      if (collision !== undefined)
        return { outcome: "conflict", challengeId: collision.challengeId };
      this.#db.prepare(`
        INSERT INTO onboarding_challenges
          (challenge_id, session_id, capability_hash, phrase, canonical_origin,
           durable_fingerprint, verification_epoch, boot_generation, state, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        input.challengeId,
        input.sessionId,
        input.capabilityHash,
        input.phrase,
        input.canonicalOrigin,
        input.durableFingerprint,
        input.verificationEpoch,
        input.bootGeneration,
        input.createdAt,
        input.expiresAt,
      );
      return { outcome: "created", challengeId: input.challengeId };
    });
  }

  recordVerificationProbe(input: CapabilityTransition): TransitionResult<ChallengeState> {
    return this.#transitionChallenge(input, "active", "ws_probed");
  }

  recordPhoneConfirmation(input: CapabilityTransition): TransitionResult<ChallengeState> {
    return this.#transitionChallenge(input, "ws_probed", "phone_confirmed");
  }

  #transitionChallenge(
    input: CapabilityTransition,
    expected: "active" | "ws_probed",
    next: "ws_probed" | "phone_confirmed",
  ): TransitionResult<ChallengeState> {
    return this.#immediate(() => {
      const row = this.#db.prepare(`
        SELECT state, expires_at AS expiresAt, canonical_origin AS canonicalOrigin,
          durable_fingerprint AS durableFingerprint, verification_epoch AS verificationEpoch,
          boot_generation AS bootGeneration
        FROM onboarding_challenges WHERE capability_hash = ?
      `).get(input.capabilityHash) as {
        state: ChallengeState;
        expiresAt: number;
        canonicalOrigin: string;
        durableFingerprint: string;
        verificationEpoch: string;
        bootGeneration: string;
      } | undefined;
      if (row === undefined) return { outcome: "not_found" };
      if (input.now > row.expiresAt) return { outcome: "expired", state: row.state };
      if (
        !this.#runtimeMatches(input)
        || row.canonicalOrigin !== input.canonicalOrigin
        || row.durableFingerprint !== input.durableFingerprint
        || row.verificationEpoch !== input.verificationEpoch
        || row.bootGeneration !== input.bootGeneration
      ) return { outcome: "invalid_context", state: row.state };
      if (row.state === next) return { outcome: "already", state: row.state };
      if (row.state !== expected) return { outcome: "invalid_state", state: row.state };
      const changed = this.#db.prepare(`
        UPDATE onboarding_challenges SET state = ?
        WHERE capability_hash = ? AND state = ? AND expires_at >= ?
      `).run(next, input.capabilityHash, expected, input.now).changes;
      return changed === 1
        ? { outcome: "advanced", state: next }
        : { outcome: "invalid_state", state: row.state };
    });
  }

  finalizeVerifiedSetupCode(input: FinalizeInput): FinalizeResult {
    return this.#immediate(() => {
      if (input.setupCodeExpiresAt !== input.now + SETUP_CODE_TTL_MS)
        return { outcome: "invalid_expiry" };
      const challenge = this.#db.prepare(`
        SELECT session_id AS sessionId, state, expires_at AS expiresAt,
          canonical_origin AS canonicalOrigin, durable_fingerprint AS durableFingerprint,
          verification_epoch AS verificationEpoch, boot_generation AS bootGeneration
        FROM onboarding_challenges WHERE challenge_id = ?
      `).get(input.challengeId) as {
        sessionId: string;
        state: ChallengeState;
        expiresAt: number;
        canonicalOrigin: string;
        durableFingerprint: string;
        verificationEpoch: string;
        bootGeneration: string;
      } | undefined;
      if (challenge === undefined) return { outcome: "not_found" };
      if (
        challenge.sessionId !== input.sessionId
        || !this.#runtimeMatches(input)
        || challenge.canonicalOrigin !== input.canonicalOrigin
        || challenge.durableFingerprint !== input.durableFingerprint
        || challenge.verificationEpoch !== input.verificationEpoch
        || challenge.bootGeneration !== input.bootGeneration
      ) return { outcome: "invalid_context" };
      const owner = this.#db.prepare(`
        SELECT state, canonical_origin AS canonicalOrigin,
          durable_fingerprint AS durableFingerprint, verification_epoch AS verificationEpoch,
          boot_generation AS bootGeneration, winning_challenge_id AS winningChallengeId
        FROM onboarding_sessions WHERE session_id = ?
      `).get(input.sessionId) as {
        state: "active" | "complete" | "abandoned";
        canonicalOrigin: string;
        durableFingerprint: string;
        verificationEpoch: string;
        bootGeneration: string;
        winningChallengeId: string | null;
      } | undefined;
      if (
        owner === undefined
        || owner.canonicalOrigin !== input.canonicalOrigin
        || owner.durableFingerprint !== input.durableFingerprint
        || owner.verificationEpoch !== input.verificationEpoch
        || owner.bootGeneration !== input.bootGeneration
      ) return { outcome: "invalid_context" };
      const prior = this.#db.prepare(
        "SELECT code FROM setup_codes WHERE challenge_id = ?",
      ).get(input.challengeId) as { code: string } | undefined;
      if (
        challenge.state === "consumed"
        && owner.state === "complete"
        && owner.winningChallengeId === input.challengeId
        && prior !== undefined
      ) return { outcome: "already_published" };
      if (input.now > challenge.expiresAt || input.setupCodeExpiresAt < input.now)
        return { outcome: "expired" };
      if (challenge.state !== "phone_confirmed" || owner.state !== "active")
        return { outcome: "invalid_state" };
      if (this.#db.prepare("SELECT 1 FROM setup_codes WHERE code = ?").get(input.setupCode) !== undefined)
        return { outcome: "code_conflict" };
      const consumed = this.#db.prepare(`
        UPDATE onboarding_challenges SET state = 'consumed'
        WHERE challenge_id = ? AND session_id = ? AND state = 'phone_confirmed'
          AND expires_at >= ? AND canonical_origin = ? AND durable_fingerprint = ?
          AND verification_epoch = ? AND boot_generation = ?
      `).run(
        input.challengeId,
        input.sessionId,
        input.now,
        input.canonicalOrigin,
        input.durableFingerprint,
        input.verificationEpoch,
        input.bootGeneration,
      ).changes;
      if (consumed !== 1) return { outcome: "invalid_state" };
      this.#db.prepare(`
        INSERT INTO setup_codes (code, expires_at, challenge_id, output_state)
        VALUES (?, ?, ?, 'pending_output')
      `).run(input.setupCode, input.setupCodeExpiresAt, input.challengeId);
      const completed = this.#db.prepare(`
        UPDATE onboarding_sessions
        SET state = 'complete', completed_at = ?, winning_challenge_id = ?
        WHERE session_id = ? AND state = 'active' AND canonical_origin = ?
          AND durable_fingerprint = ? AND verification_epoch = ? AND boot_generation = ?
      `).run(
        input.now,
        input.challengeId,
        input.sessionId,
        input.canonicalOrigin,
        input.durableFingerprint,
        input.verificationEpoch,
        input.bootGeneration,
      ).changes;
      if (completed !== 1) throw new Error("onboarding session changed during finalization");
      return { outcome: "published", setupCode: input.setupCode };
    });
  }

  activatePendingSetupCode(input: PublishedCode): TransitionResult<SetupCodeOutputState> {
    return this.#immediate(() => {
      const row = this.#db.prepare(`
        SELECT output_state AS outputState, expires_at AS expiresAt FROM setup_codes
        WHERE code = ? AND challenge_id = ?
      `).get(input.setupCode, input.challengeId) as {
        outputState: SetupCodeOutputState;
        expiresAt: number;
      } | undefined;
      if (row === undefined) return { outcome: "not_found" };
      if (row.outputState === "active") return { outcome: "already", state: "active" };
      if (row.outputState !== "pending_output")
        return { outcome: "invalid_state", state: row.outputState };
      if (input.now > row.expiresAt) {
        this.#db.prepare(`
          UPDATE setup_codes SET output_state = 'revoked'
          WHERE code = ? AND challenge_id = ? AND output_state = 'pending_output'
        `).run(input.setupCode, input.challengeId);
        return { outcome: "expired", state: "revoked" };
      }
      this.#db.prepare(`
        UPDATE setup_codes SET output_state = 'active'
        WHERE code = ? AND challenge_id = ? AND output_state = 'pending_output'
      `).run(input.setupCode, input.challengeId);
      return { outcome: "advanced", state: "active" };
    });
  }

  revokePendingSetupCode(input: PublishedCode): TransitionResult<SetupCodeOutputState> {
    return this.#immediate(() => {
      const row = this.#db.prepare(`
        SELECT output_state AS outputState FROM setup_codes
        WHERE code = ? AND challenge_id = ?
      `).get(input.setupCode, input.challengeId) as { outputState: SetupCodeOutputState } | undefined;
      if (row === undefined) return { outcome: "not_found" };
      if (row.outputState === "revoked") return { outcome: "already", state: "revoked" };
      if (row.outputState !== "pending_output")
        return { outcome: "invalid_state", state: row.outputState };
      this.#db.prepare(`
        UPDATE setup_codes SET output_state = 'revoked'
        WHERE code = ? AND challenge_id = ? AND output_state = 'pending_output'
      `).run(input.setupCode, input.challengeId);
      return { outcome: "advanced", state: "revoked" };
    });
  }

  createSetupCode(code: string, expiresAt: number): void {
    this.#db.prepare(
      "INSERT INTO setup_codes (code, expires_at, output_state) VALUES (?, ?, 'active')",
    ).run(code, expiresAt);
  }

  consumeSetupCode(code: string, now: number): "ok" | "invalid" {
    const result = this.#db
      .prepare(`
        UPDATE setup_codes SET used_at = ?
        WHERE code = ? AND used_at IS NULL AND expires_at >= ? AND output_state = 'active'
      `)
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

  /** Stores the one ActivityKit card owned by this device conversation and durably queues the
   * superseded relay push ids it returns. The replacement, queueing, and stale-row removal are one
   * transaction so a turn can never observe both the superseded card and its replacement. */
  saveLiveActivityRegistration(
    row: Omit<LiveActivityRegistrationRow, "eventSequence" | "lastTimestamp">,
  ): string[] {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.#db.prepare(
        `SELECT push_id AS pushId FROM live_activity_registrations
         WHERE device_id = ? AND (conversation_id = ? OR activity_id = ?)`,
      ).all(row.deviceId, row.conversationId, row.activityId) as Array<{ pushId: string }>;
      const superseded = [...new Set(
        previous.map(({ pushId }) => pushId).filter((pushId) => pushId !== row.pushId),
      )];
      const enqueue = this.#db.prepare(
        `INSERT OR IGNORE INTO live_activity_relay_deletion_outbox (push_id, queued_at)
         VALUES (?, ?)`,
      );
      for (const pushId of superseded) enqueue.run(pushId, row.createdAt);
      this.#db.prepare(
        `DELETE FROM live_activity_registrations
         WHERE device_id = ? AND conversation_id = ? AND activity_id <> ?`,
      ).run(row.deviceId, row.conversationId, row.activityId);
      this.#db.prepare(
        `INSERT INTO live_activity_registrations
         (device_id, activity_id, run_id, conversation_id, bot, push_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, activity_id) DO UPDATE SET
           run_id = excluded.run_id, conversation_id = excluded.conversation_id,
           bot = excluded.bot, push_id = excluded.push_id, created_at = excluded.created_at`,
      ).run(row.deviceId, row.activityId, row.runId, row.conversationId, row.bot, row.pushId, row.createdAt);
      this.#db.exec("COMMIT");
      return superseded;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  liveActivityRegistration(deviceId: string, activityId: string): LiveActivityRegistrationRow | undefined {
    return this.#db.prepare(
      `SELECT device_id AS deviceId, activity_id AS activityId, run_id AS runId,
       conversation_id AS conversationId, bot, push_id AS pushId,
       event_sequence AS eventSequence, last_timestamp AS lastTimestamp, created_at AS createdAt
       FROM live_activity_registrations WHERE device_id = ? AND activity_id = ?`,
    ).get(deviceId, activityId) as unknown as LiveActivityRegistrationRow | undefined;
  }

  liveActivityRegistrations(bot?: string): LiveActivityRegistrationRow[] {
    const sql = `SELECT device_id AS deviceId, activity_id AS activityId, run_id AS runId,
      conversation_id AS conversationId, bot, push_id AS pushId,
      event_sequence AS eventSequence, last_timestamp AS lastTimestamp, created_at AS createdAt
      FROM live_activity_registrations`;
    return (bot === undefined
      ? this.#db.prepare(`${sql} ORDER BY created_at`).all()
      : this.#db.prepare(`${sql} WHERE bot = ? ORDER BY created_at`).all(bot)) as unknown as LiveActivityRegistrationRow[];
  }

  advanceLiveActivity(deviceId: string, activityId: string, timestamp: number): number {
    this.#db.prepare(
      `UPDATE live_activity_registrations SET event_sequence = event_sequence + 1,
       last_timestamp = ? WHERE device_id = ? AND activity_id = ?`,
    ).run(timestamp, deviceId, activityId);
    return this.liveActivityRegistration(deviceId, activityId)?.eventSequence ?? 0;
  }

  /** Atomically queues and removes the current row. `expectedPushId` makes asynchronous relay
   * responses compare-and-delete, so an old response cannot remove a rotated registration. */
  deleteLiveActivityRegistration(
    deviceId: string,
    activityId: string,
    options: { expectedPushId?: string; queuedAt?: number } = {},
  ): LiveActivityRegistrationRow | undefined {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.liveActivityRegistration(deviceId, activityId);
      if (row !== undefined
        && (options.expectedPushId === undefined || row.pushId === options.expectedPushId)) {
        this.#db.prepare(
          `INSERT OR IGNORE INTO live_activity_relay_deletion_outbox (push_id, queued_at)
           VALUES (?, ?)`,
        ).run(row.pushId, options.queuedAt ?? Date.now());
        this.#db.prepare(
          "DELETE FROM live_activity_registrations WHERE device_id = ? AND activity_id = ?",
        ).run(deviceId, activityId);
      } else if (row !== undefined) {
        this.#db.exec("COMMIT");
        return undefined;
      }
      this.#db.exec("COMMIT");
      return row;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  liveActivityRelayDeletions(limit: number): string[] {
    return (this.#db.prepare(
      `SELECT push_id AS pushId FROM live_activity_relay_deletion_outbox
       ORDER BY queued_at, push_id LIMIT ?`,
    ).all(Math.max(0, limit)) as Array<{ pushId: string }>).map(({ pushId }) => pushId);
  }

  liveActivityRelayDeletionHighWater(): number | undefined {
    const row = this.#db.prepare(
      "SELECT MAX(sequence) AS sequence FROM live_activity_relay_deletion_outbox",
    ).get() as { sequence: number | null };
    return row.sequence ?? undefined;
  }

  liveActivityRelayDeletionPage(
    afterSequence: number,
    throughSequence: number,
    limit: number,
  ): Array<{ pushId: string; sequence: number }> {
    return this.#db.prepare(
      `SELECT push_id AS pushId, sequence FROM live_activity_relay_deletion_outbox
       WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?`,
    ).all(afterSequence, throughSequence, Math.max(0, limit)) as Array<{
      pushId: string;
      sequence: number;
    }>;
  }

  completeLiveActivityRelayDeletion(pushId: string): boolean {
    return this.#db.prepare(
      "DELETE FROM live_activity_relay_deletion_outbox WHERE push_id = ?",
    ).run(pushId).changes === 1;
  }

  /** Replaces the whole cached roster in one transaction, preserving build order. */
  replaceBotRoster(bots: Array<{ name: string; summary: BotSummary }>, updatedAt: number): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("DELETE FROM bot_roster").run();
      const insert = this.#db.prepare(
        "INSERT INTO bot_roster (name, summary_json, position, updated_at) VALUES (?, ?, ?, ?)",
      );
      bots.forEach((bot, index) => {
        insert.run(bot.name, JSON.stringify(bot.summary), index, updatedAt);
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

  /** Upserts one delegation child by (bot, turn, batch, child). `child_index` and `started_at`
   *  are pinned by the FIRST write; a later write owns status/current_tool/last_active_at/
   *  ended_at, `batch_count` only grows, and `label` keeps its first non-null value (a finish
   *  leg without a label must not erase the spawn leg's). */
  upsertBotChatDelegation(child: {
    bot: string;
    sessionId: string;
    turnId: string;
    batchId: string;
    /** Batch-level canonical Hermes alias; keep-first, a null never erases a stored one. */
    aliasId?: string | undefined;
    childId: string;
    index: number;
    count: number;
    status: string;
    lastActiveAt: number;
    startedAt: number;
    endedAt: number | undefined;
    label?: string | undefined;
    currentTool?: string | undefined;
    apiCalls?: number | undefined;
    toolCount?: number | undefined;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO bot_chat_delegations
           (bot, session_id, turn_id, batch_id, alias_id, child_id, child_index, batch_count,
            label, status, current_tool, api_calls, tool_count, last_active_at, started_at,
            ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot, turn_id, batch_id, child_id) DO UPDATE SET
           batch_count = MAX(bot_chat_delegations.batch_count, excluded.batch_count),
           alias_id = COALESCE(bot_chat_delegations.alias_id, excluded.alias_id),
           label = COALESCE(bot_chat_delegations.label, excluded.label),
           status = excluded.status,
           current_tool = excluded.current_tool,
           api_calls = COALESCE(excluded.api_calls, bot_chat_delegations.api_calls),
           tool_count = COALESCE(excluded.tool_count, bot_chat_delegations.tool_count),
           last_active_at = excluded.last_active_at,
           ended_at = COALESCE(excluded.ended_at, bot_chat_delegations.ended_at)`,
      )
      .run(
        child.bot,
        child.sessionId,
        child.turnId,
        child.batchId,
        child.aliasId ?? null,
        child.childId,
        child.index,
        child.count,
        child.label ?? null,
        child.status,
        child.currentTool ?? null,
        child.apiCalls ?? null,
        child.toolCount ?? null,
        child.lastActiveAt,
        child.startedAt,
        child.endedAt ?? null,
      );
  }

  /** Every delegation child recorded for one chat, oldest first and in-batch order within. */
  botChatDelegations(
    sessionId: string,
    notBefore: number,
  ): Array<{
    turnId: string;
    batchId: string;
    aliasId: string | null;
    childId: string;
    index: number;
    count: number;
    label: string | null;
    status: string;
    currentTool: string | null;
    apiCalls: number | null;
    toolCount: number | null;
    lastActiveAt: number;
    startedAt: number;
    endedAt: number | null;
  }> {
    return this.#db
      .prepare(
        `SELECT turn_id AS turnId, batch_id AS batchId, alias_id AS aliasId,
                child_id AS childId,
                child_index AS "index", batch_count AS count, label, status,
                current_tool AS currentTool, api_calls AS apiCalls, tool_count AS toolCount,
                last_active_at AS lastActiveAt, started_at AS startedAt, ended_at AS endedAt
         FROM bot_chat_delegations
         WHERE session_id = ? AND started_at >= ?
         ORDER BY started_at, child_index, child_id`,
      )
      .all(sessionId, notBefore) as unknown as Array<{
      turnId: string;
      batchId: string;
      aliasId: string | null;
      childId: string;
      index: number;
      count: number;
      label: string | null;
      status: string;
      currentTool: string | null;
      apiCalls: number | null;
      toolCount: number | null;
      lastActiveAt: number;
      startedAt: number;
      endedAt: number | null;
    }>;
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
        "INSERT INTO bot_group_members (group_key, member, watermark, session_id) VALUES (?, ?, 0, ?)",
      );
      for (const name of room.members) member.run(room.key, name, `group:${room.key}:${name}`);
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
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      // Preserve attach-event authorization after delete/recreate, but make it impossible for an
      // old pending command to block the new room under the same case-insensitive key.
      this.#db.prepare(
        "UPDATE bot_group_turns SET state = 'cancelled', detail = 'group deleted', completed_at = COALESCE(completed_at, 0) WHERE group_key = ? AND state = 'pending'",
      ).run(key);
      const deleted = this.#db.prepare("DELETE FROM bot_groups WHERE key = ?").run(key).changes === 1;
      this.#db.exec("COMMIT");
      return deleted;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
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

  /** Returns the gateway-owned attach thread for this member.  Older rooms gain the deterministic
   * binding lazily, which is safe because it is scoped by the room key and never derived from a
   * Dashboard session. */
  ensureBotGroupThread(key: string, member: string): string {
    const existing = this.#db.prepare(
      "SELECT session_id AS sessionId FROM bot_group_members WHERE group_key = ? AND member = ?",
    ).get(key, member) as { sessionId: string | null } | undefined;
    if (existing?.sessionId !== null && existing?.sessionId !== undefined) return existing.sessionId;
    const threadId = `group:${key}:${member}`;
    this.#db.prepare(
      `INSERT INTO bot_group_members (group_key, member, watermark, session_id) VALUES (?, ?, 0, ?)
       ON CONFLICT(group_key, member) DO UPDATE SET session_id = excluded.session_id`,
    ).run(key, member, threadId);
    return threadId;
  }

  beginBotGroupTurn(turn: Omit<BotGroupTurnRow, "state" | "createdAt" | "completedAt" | "consumedAt" | "text" | "detail"> & { createdAt: number }): boolean {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.#db.prepare(
        "SELECT 1 FROM bot_group_turns WHERE group_key = ? AND state = 'pending' LIMIT 1",
      ).get(turn.key);
      if (active !== undefined) {
        this.#db.exec("COMMIT");
        return false;
      }
      this.#db.prepare(
        `INSERT INTO bot_group_turns
           (group_key, turn_id, member, agent_id, thread_id, message_id, epoch, watermark, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(turn.key, turn.turnId, turn.member, turn.agentId, turn.threadId, turn.messageId, turn.epoch, turn.watermark, turn.createdAt);
      this.#db.exec("COMMIT");
      return true;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  botGroupTurnForAttach(agentId: string, threadId: string, turnId: string): BotGroupTurnRow | undefined {
    const row = this.#db.prepare(
      `SELECT group_key AS key, turn_id AS turnId, member, agent_id AS agentId, thread_id AS threadId,
              message_id AS messageId, epoch, watermark, state, text, detail, created_at AS createdAt,
              completed_at AS completedAt, consumed_at AS consumedAt
       FROM bot_group_turns WHERE agent_id = ? AND thread_id = ? AND turn_id = ?`,
    ).get(agentId, threadId, turnId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toBotGroupTurnRow(row);
  }

  completeBotGroupTurn(agentId: string, threadId: string, turnId: string, state: Exclude<BotGroupTurnRow["state"], "pending" | "timeout">, text: string | undefined, detail: string | undefined, completedAt: number): BotGroupTurnRow | undefined {
    const prior = this.botGroupTurnForAttach(agentId, threadId, turnId);
    if (prior === undefined) return undefined;
    if (prior.state === "pending") {
      this.#db.prepare(
        `UPDATE bot_group_turns SET state = ?, text = ?, detail = ?, completed_at = ?
         WHERE group_key = ? AND turn_id = ? AND state = 'pending'`,
      ).run(state, text ?? null, detail ?? null, completedAt, prior.key, prior.turnId);
    }
    return this.botGroupTurnForAttach(agentId, threadId, turnId);
  }

  timeoutBotGroupTurn(key: string, turnId: string, detail: string, completedAt: number): void {
    this.#db.prepare(
      `UPDATE bot_group_turns SET state = 'timeout', detail = ?, completed_at = ?
       WHERE group_key = ? AND turn_id = ? AND state = 'pending'`,
    ).run(detail, completedAt, key, turnId);
  }

  botGroupTurn(key: string, turnId: string): BotGroupTurnRow | undefined {
    const row = this.#db.prepare(
      `SELECT group_key AS key, turn_id AS turnId, member, agent_id AS agentId, thread_id AS threadId,
              message_id AS messageId, epoch, watermark, state, text, detail, created_at AS createdAt,
              completed_at AS completedAt, consumed_at AS consumedAt
       FROM bot_group_turns WHERE group_key = ? AND turn_id = ?`,
    ).get(key, turnId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toBotGroupTurnRow(row);
  }

  /** Atomically assigns a completed settlement to one orchestrator. */
  consumeBotGroupTurn(key: string, turnId: string, consumedAt: number): BotGroupTurnRow | undefined {
    const row = this.botGroupTurn(key, turnId);
    if (row === undefined || row.state === "pending" || row.consumedAt !== undefined) return undefined;
    const changed = this.#db.prepare(
      "UPDATE bot_group_turns SET consumed_at = ? WHERE group_key = ? AND turn_id = ? AND consumed_at IS NULL",
    ).run(consumedAt, key, turnId).changes;
    return changed === 1 ? { ...row, consumedAt } : undefined;
  }

  pendingBotGroupTurns(): BotGroupTurnRow[] {
    const rows = this.#db.prepare(
      `SELECT group_key AS key, turn_id AS turnId, member, agent_id AS agentId, thread_id AS threadId,
              message_id AS messageId, epoch, watermark, state, text, detail, created_at AS createdAt,
              completed_at AS completedAt, consumed_at AS consumedAt
       FROM bot_group_turns WHERE state = 'pending'`,
    ).all() as Record<string, unknown>[];
    return rows.map(toBotGroupTurnRow);
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

  /** An unsupported negotiated capability turns a queued native resolution into a transport
   * discard. Clear only its matching pending marker in the same transaction, so the card is
   * actionable again instead of claiming a request Hermes can no longer receive. */
  discardAttachCommandAndReopenNativeInteraction(
    agentId: string,
    sequence: number,
    commandId: string,
    reason: string,
    cancelledAt: number,
  ): AttachV1CommandFrame | undefined {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          `UPDATE attach_command_outbox
           SET cancelled_at = COALESCE(cancelled_at, ?), cancel_reason = COALESCE(cancel_reason, ?)
           WHERE agent_id = ? AND sequence = ? AND command_id = ? AND acked_at IS NULL`,
        )
        .run(cancelledAt, reason.slice(0, 512), agentId, sequence, commandId);
      this.#db
        .prepare(
          `UPDATE bot_native_interactions
           SET resolution_command_id = NULL, resolution_requested_at = NULL,
               requested_decision = NULL, requested_option_id = NULL
           WHERE bot = ? AND resolution_command_id = ? AND status = 'pending'`,
        )
        .run(agentId, commandId);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
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

  /** Durable attach-v1 observability with no frame payloads or identity details. */
  attachHealth(): {
    lastEventAt: number | null;
    lastTerminalAt: number | null;
    queueDepth: number;
    deadLetters: number;
    pluginOutboxDepth: number;
    pluginOldestEventAgeMs: number;
    pluginLastAckProgressAt: number | null;
    pluginCommandInboxDepth: number;
  } {
    return this.#db.prepare(
      `SELECT
         (SELECT MAX(received_at) FROM attach_event_inbox) AS lastEventAt,
         (SELECT MAX(at) FROM (
            SELECT inbox.received_at AS at
              FROM attach_turn_terminals AS terminal
              JOIN attach_event_inbox AS inbox
                ON inbox.agent_id = terminal.agent_id AND inbox.event_id = terminal.event_id
            UNION ALL SELECT completed_at AS at FROM bot_native_turn_terminals
         )) AS lastTerminalAt,
         (SELECT COUNT(*) FROM attach_command_outbox WHERE acked_at IS NULL) AS queueDepth,
         (SELECT COUNT(*) FROM attach_event_inbox
          WHERE disposition = 'accepted' AND dead_lettered_at IS NOT NULL) AS deadLetters,
         (SELECT COALESCE(SUM(plugin_event_outbox_depth), 0) FROM attach_streams) AS pluginOutboxDepth,
         (SELECT COALESCE(MAX(plugin_oldest_event_age_ms), 0) FROM attach_streams) AS pluginOldestEventAgeMs,
         (SELECT MAX(plugin_last_ack_progress_at) FROM attach_streams) AS pluginLastAckProgressAt,
         (SELECT COALESCE(SUM(plugin_command_inbox_depth), 0) FROM attach_streams) AS pluginCommandInboxDepth`,
    ).get() as {
      lastEventAt: number | null;
      lastTerminalAt: number | null;
      queueDepth: number;
      deadLetters: number;
      pluginOutboxDepth: number;
      pluginOldestEventAgeMs: number;
      pluginLastAckProgressAt: number | null;
      pluginCommandInboxDepth: number;
    };
  }

  /** Persist only bounded spool counters from an authenticated control frame. The gateway owns
   * progress time: a plugin-reported clock can be skewed, while a higher durable cursor is proof. */
  recordAttachTelemetry(agentId: string, telemetry: AttachV1Telemetry, receivedAt: number): {
    eventOutboxDepth: number;
    lastAckProgressAt: number;
  } {
    this.#db
      .prepare(
        `INSERT INTO attach_streams
           (agent_id, next_command_sequence, last_event_sequence, plugin_event_outbox_depth,
            plugin_oldest_event_age_ms, plugin_event_ack_cursor, plugin_last_ack_progress_at,
            plugin_command_inbox_depth, updated_at)
         VALUES (?, 1, 0, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           plugin_event_outbox_depth = excluded.plugin_event_outbox_depth,
           plugin_oldest_event_age_ms = excluded.plugin_oldest_event_age_ms,
           plugin_last_ack_progress_at = CASE
             WHEN attach_streams.plugin_event_ack_cursor IS NULL
               OR attach_streams.plugin_last_ack_progress_at IS NULL
               OR (COALESCE(attach_streams.plugin_event_outbox_depth, 0) = 0
                   AND excluded.plugin_event_outbox_depth > 0)
               OR excluded.plugin_event_ack_cursor > attach_streams.plugin_event_ack_cursor
             THEN excluded.plugin_last_ack_progress_at
             ELSE attach_streams.plugin_last_ack_progress_at
           END,
           plugin_event_ack_cursor = excluded.plugin_event_ack_cursor,
           plugin_command_inbox_depth = excluded.plugin_command_inbox_depth,
           updated_at = excluded.updated_at`,
      )
      .run(
        agentId, telemetry.eventOutboxDepth, telemetry.oldestEventAgeMs, telemetry.eventAckCursor,
        receivedAt, telemetry.commandInboxDepth, receivedAt,
      );
    const row = this.#db
      .prepare(
        `SELECT plugin_event_outbox_depth AS eventOutboxDepth,
                plugin_last_ack_progress_at AS lastAckProgressAt
         FROM attach_streams WHERE agent_id = ?`,
      )
      .get(agentId) as { eventOutboxDepth: number; lastAckProgressAt: number | null };
    return { eventOutboxDepth: row.eventOutboxDepth, lastAckProgressAt: row.lastAckProgressAt ?? receivedAt };
  }

  attachQueueHealth(agentId: string, now: number): { depth: number; oldestAgeMs: number } {
    const row = this.#db.prepare(
      `SELECT COUNT(*) AS depth, MIN(created_at) AS oldestAt
       FROM attach_command_outbox WHERE agent_id = ? AND acked_at IS NULL`,
    ).get(agentId) as { depth: number; oldestAt: number | null };
    return { depth: row.depth, oldestAgeMs: row.oldestAt === null ? 0 : Math.max(0, now - row.oldestAt) };
  }

  /** Inbox admission is the ACK boundary. Sequence must be contiguous; duplicates by eventId are
   * harmless; and a terminal transition seals its turn so late turn events are journaled/ACKed but
   * never applied. Delegation lifecycle is the one exception: async children can settle after their
   * parent turn seals, and the data plane applies those updates idempotently. */
  acceptAttachEvent(
    agentId: string,
    frame: AttachV1EventFrame,
    receivedAt: number,
    discardReason?: AttachV1DiscardReason,
  ):
    | { status: "accepted" | "duplicate" | "ignored_terminal" | "ignored_delivery"; acknowledgedSequence: number }
    | { status: "discarded"; acknowledgedSequence: number; reason: AttachV1DiscardReason }
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
      const quarantine = (reason: AttachV1DiscardReason) => {
        this.#db
          .prepare(
            `INSERT INTO attach_event_inbox
               (agent_id, sequence, event_id, frame_json, received_at, disposition,
                projection_error, applied_at, dead_lettered_at)
             VALUES (?, ?, ?, ?, ?, 'discarded', ?, ?, ?)`,
          )
          .run(
            agentId, frame.sequence, frame.eventId, JSON.stringify(frame), receivedAt,
            reason, receivedAt, receivedAt,
          );
        this.#db
          .prepare("UPDATE attach_streams SET last_event_sequence = ?, updated_at = ? WHERE agent_id = ?")
          .run(frame.sequence, receivedAt, agentId);
        this.#db.exec("COMMIT");
        return {
          status: "discarded" as const,
          acknowledgedSequence: frame.sequence,
          reason,
        };
      };
      if (discardReason !== undefined) return quarantine(discardReason);
      const event = frame.event;
      const turnId = "turnId" in event ? event.turnId : undefined;
      const terminal = event.kind === "commit" || event.kind === "failed" || event.kind === "cancelled" || event.kind === "interrupted";
      const sealed = turnId === undefined
        ? undefined
        : (this.#db.prepare("SELECT event_id AS eventId FROM attach_turn_terminals WHERE agent_id = ? AND turn_id = ?").get(agentId, turnId) as { eventId: string } | undefined);
      let disposition: "accepted" | "ignored_terminal" | "ignored_delivery" =
        sealed === undefined || event.kind === "delegation" ? "accepted" : "ignored_terminal";
      if (event.kind === "scheduled") {
        const prior = this.#db
          .prepare(
            `SELECT delivery.thread_id AS threadId, delivery.message_id AS messageId,
                    inbox.frame_json AS frameJson
             FROM attach_scheduled_deliveries AS delivery
             JOIN attach_event_inbox AS inbox
               ON inbox.agent_id = delivery.agent_id AND inbox.event_id = delivery.event_id
             WHERE delivery.agent_id = ? AND delivery.delivery_id = ?`,
          )
          .get(agentId, event.deliveryId) as { threadId: string; messageId: string; frameJson: string } | undefined;
        if (prior !== undefined) {
          const first = JSON.parse(prior.frameJson) as AttachV1EventFrame;
          const firstScheduled = first.event.kind === "scheduled" ? first.event : undefined;
          const sameTarget = firstScheduled !== undefined
            && ("target" in firstScheduled) === ("target" in event)
            && ("target" in event || ("threadId" in firstScheduled && firstScheduled.threadId === event.threadId));
          if (prior.messageId !== event.messageId || !sameTarget) {
            this.#db.exec("COMMIT");
            return { status: "conflict", acknowledgedSequence: stream.sequence };
          }
          disposition = "ignored_delivery";
        } else {
          // `agentId` is the authenticated attach identity. Check the active native-session
          // pointer while this same IMMEDIATE transaction holds admission, not only in ingress:
          // a /new selection between a precheck and this write must not deliver to the old chat.
          if (!("target" in event)) {
            const selected = this.#db
              .prepare("SELECT session_id AS sessionId FROM bot_native_chats WHERE bot = ?")
              .get(agentId) as { sessionId: string } | undefined;
            // Core threads share this attach identity but are authorized by the server's core
            // thread lookup. Only a known native-session id is constrained by this local pointer.
            if (
              selected !== undefined &&
              selected.sessionId !== event.threadId &&
              this.nativeBotHasSession(agentId, event.threadId)
            ) {
              return quarantine("unauthorized_target");
            }
          }
          // This is inside the admission transaction, so /new cannot race a semantic home event
          // between its selection and its durable delivery binding.
          const threadId = "target" in event
            ? this.nativeBotChat(agentId, receivedAt).sessionId
            : event.threadId;
          this.#db
            .prepare(
              `INSERT INTO attach_scheduled_deliveries
                 (agent_id, delivery_id, thread_id, message_id, event_id, projected_at)
               VALUES (?, ?, ?, ?, ?, NULL)`,
            )
            .run(agentId, event.deliveryId, threadId, event.messageId, frame.eventId);
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
         WHERE agent_id = ? AND disposition = 'accepted' AND dead_lettered_at IS NOT NULL
         ORDER BY sequence LIMIT 1`,
      )
      .get(agentId) as { eventId: string } | undefined;
    if (earliest?.eventId !== eventId) return false;
    return this.#db
      .prepare(
        `UPDATE attach_event_inbox
         SET projection_attempts = 0, projection_error = NULL, dead_lettered_at = NULL
         WHERE agent_id = ? AND event_id = ? AND disposition = 'accepted' AND applied_at IS NULL`,
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
              WHERE blocked.agent_id = ? AND blocked.disposition = 'accepted'
                AND blocked.dead_lettered_at IS NOT NULL),
             9223372036854775807
           )
         ORDER BY sequence LIMIT ?`,
      )
      .all(agentId, agentId, limit) as unknown as Array<{ frameJson: string }>;
    return rows.map((row) => JSON.parse(row.frameJson) as AttachV1EventFrame);
  }

  /** Operator surface (issue #193): the projection dead letters currently blocking streams. */
  attachProjectionDeadLetters(): Array<{
    agentId: string; sequence: number; eventId: string; kind: string;
    attempts: number; error: string | null; deadLetteredAt: number; receivedAt: number;
  }> {
    return this.#db
      .prepare(
        `SELECT agent_id AS agentId, sequence, event_id AS eventId,
                json_extract(frame_json, '$.event.kind') AS kind,
                projection_attempts AS attempts, projection_error AS error,
                dead_lettered_at AS deadLetteredAt, received_at AS receivedAt
         FROM attach_event_inbox
         WHERE disposition = 'accepted' AND dead_lettered_at IS NOT NULL AND applied_at IS NULL
         ORDER BY agent_id, sequence`,
      )
      .all() as unknown as Array<{
        agentId: string; sequence: number; eventId: string; kind: string;
        attempts: number; error: string | null; deadLetteredAt: number; receivedAt: number;
      }>;
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

  /** Durable delivery evidence for one native turn. ACK proves the plugin accepted the command;
   * absent ACK keeps the user-visible state queued without inventing a timeout. */
  nativeBotTurnDelivery(agentId: string, turnId: string): {
    sequence: number;
    commandId: string;
    queuedAt: number;
    acknowledgedAt: number | null;
  } | undefined {
    return this.#db
      .prepare(
        `SELECT sequence, command_id AS commandId, created_at AS queuedAt, acked_at AS acknowledgedAt
         FROM attach_command_outbox
         WHERE agent_id = ? AND cancelled_at IS NULL
           AND json_extract(command_json, '$.kind') = 'turn'
           AND json_extract(command_json, '$.turnId') = ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(agentId, turnId) as {
      sequence: number;
      commandId: string;
      queuedAt: number;
      acknowledgedAt: number | null;
    } | undefined;
  }

  recordNativeBotTerminal(input: {
    bot: string;
    sessionId: string;
    turnId: string;
    status: "completed" | "failed" | "interrupted" | "timed_out";
    cause?: "cancelled";
    completedAt: number;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO bot_native_turn_terminals
           (bot, session_id, turn_id, status, cause, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(bot, turn_id) DO UPDATE SET
           session_id = excluded.session_id,
           status = excluded.status,
           cause = excluded.cause,
           completed_at = excluded.completed_at
         WHERE bot_native_turn_terminals.status != 'completed'
           AND excluded.status = 'completed'`,
      )
      .run(
        input.bot,
        input.sessionId,
        input.turnId,
        input.status,
        input.cause ?? null,
        input.completedAt,
      );
  }

  nativeBotTurnTerminal(bot: string, sessionId: string, turnId: string): {
    status: "completed" | "failed" | "interrupted" | "timed_out";
    cause?: "cancelled";
  } | undefined {
    const row = this.#db
      .prepare(
        `SELECT status, cause FROM bot_native_turn_terminals
         WHERE bot = ? AND session_id = ? AND turn_id = ?`,
      )
      .get(bot, sessionId, turnId) as {
        status: "completed" | "failed" | "interrupted" | "timed_out";
        cause: "cancelled" | null;
      } | undefined;
    return row === undefined
      ? undefined
      : { status: row.status, ...(row.cause === null ? {} : { cause: row.cause }) };
  }

  /** Last durable terminal for a native session, including a gateway deadline before any plugin
   * event exists. */
  nativeBotLastTerminal(agentId: string, sessionId: string): {
    status: "completed" | "failed" | "interrupted" | "timed_out";
    cause?: "cancelled";
  } | undefined {
    const row = this.#db
      .prepare(
        `SELECT status, cause FROM bot_native_turn_terminals
         WHERE bot = ? AND session_id = ? ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(agentId, sessionId) as {
      status: "completed" | "failed" | "interrupted" | "timed_out";
      cause: "cancelled" | null;
    } | undefined;
    return row === undefined
      ? undefined
      : {
          status: row.status,
          ...(row.cause === null ? {} : { cause: row.cause }),
        };
  }

  attachScheduledDelivery(agentId: string, deliveryId: string): { threadId: string; messageId: string; projectedAt: number | null } | undefined {
    return this.#db
      .prepare(
        `SELECT thread_id AS threadId, message_id AS messageId, projected_at AS projectedAt
         FROM attach_scheduled_deliveries WHERE agent_id = ? AND delivery_id = ?`,
      )
      .get(agentId, deliveryId) as { threadId: string; messageId: string; projectedAt: number | null } | undefined;
  }

  /** Binds a committed turn reply's message to the delivery id its plugin keyed the attachments
   * under. Only called for a reply that actually carries attachments: a text-only turn has no
   * media lifecycle to close, so binding it would only put a receipt on the wire that nothing
   * reads. First write wins, matching the receipt itself. */
  bindTurnMediaDelivery(bot: string, messageId: string, deliveryId: string): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO bot_turn_media_deliveries (bot, message_id, delivery_id)
         VALUES (?, ?, ?)`,
      )
      .run(bot, messageId, deliveryId);
  }

  /** Records that a device put these bot rows on screen. First write wins: a later report for an
   * id that already has a receipt changes nothing, and an id naming no durable row is ignored
   * rather than refused, so a device replaying an offline queue never gets stuck on a batch it
   * cannot repair.
   *
   * The delivery join belongs here, in the same transaction as the write, so a caller cannot see
   * a receipt without also seeing the delivery binding it just closed. Both kinds of delivery are
   * joined: a scheduled occurrence, and a turn reply that carried media. Emitting the attach
   * command is deliberately NOT this layer's job. */
  recordBotMessageDisplayed(
    bot: string,
    messageIds: readonly string[],
    deviceId: string,
    at: number,
  ): { recorded: number; deliveries: Array<{ deliveryId: string; messageId: string }> } {
    const insert = this.#db.prepare(
      `INSERT OR IGNORE INTO bot_message_receipts (bot, message_id, displayed_at, device_id)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM bot_native_messages WHERE bot = ? AND message_id = ?)`,
    );
    const binding = this.#db.prepare(
      `SELECT delivery_id AS deliveryId FROM attach_scheduled_deliveries
       WHERE agent_id = ? AND message_id = ?`,
    );
    const turnBinding = this.#db.prepare(
      `SELECT delivery_id AS deliveryId FROM bot_turn_media_deliveries
       WHERE bot = ? AND message_id = ?`,
    );
    const deliveries: Array<{ deliveryId: string; messageId: string }> = [];
    let recorded = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const messageId of new Set(messageIds)) {
        if (insert.run(bot, messageId, at, deviceId, bot, messageId).changes !== 1) continue;
        recorded += 1;
        const bound = (binding.get(bot, messageId) ?? turnBinding.get(bot, messageId)) as
          { deliveryId: string } | undefined;
        if (bound !== undefined) deliveries.push({ deliveryId: bound.deliveryId, messageId });
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    return { recorded, deliveries };
  }

  botMessageReceipt(bot: string, messageId: string): { displayedAt: number; deviceId: string } | undefined {
    return this.#db
      .prepare(
        `SELECT displayed_at AS displayedAt, device_id AS deviceId
         FROM bot_message_receipts WHERE bot = ? AND message_id = ?`,
      )
      .get(bot, messageId) as { displayedAt: number; deviceId: string } | undefined;
  }

  /** Read the admitted event's existing durable records; it intentionally performs no projection
   * or mutation, so an agent can distinguish pending admission from a visible transcript row. */
  attachScheduledDeliveryReceipt(agentId: string, deliveryId: string): AttachScheduledDeliveryReceipt | undefined {
    const row = this.#db
      .prepare(
        `SELECT delivery.thread_id AS threadId, delivery.message_id AS messageId,
                inbox.frame_json AS frameJson, inbox.received_at AS admittedAt,
                inbox.applied_at AS projectedAt, inbox.projection_attempts AS attempts,
                inbox.dead_lettered_at AS deadLetteredAt, inbox.disposition AS disposition,
                inbox.projection_error AS projectionError,
                receipt.displayed_at AS displayedAt,
                message.attachments_json AS attachmentsJson
         FROM attach_scheduled_deliveries AS delivery
         JOIN attach_event_inbox AS inbox
           ON inbox.agent_id = delivery.agent_id AND inbox.event_id = delivery.event_id
         LEFT JOIN bot_message_receipts AS receipt
           ON receipt.bot = delivery.agent_id AND receipt.message_id = delivery.message_id
         LEFT JOIN bot_native_messages AS message
           ON message.bot = delivery.agent_id AND message.message_id = delivery.message_id
         WHERE delivery.agent_id = ? AND delivery.delivery_id = ?`,
      )
      .get(agentId, deliveryId) as {
        threadId: string; messageId: string; frameJson: string; admittedAt: number;
        projectedAt: number | null; attempts: number; deadLetteredAt: number | null;
        disposition: string; projectionError: string | null; displayedAt: number | null;
        attachmentsJson: string | null;
      } | undefined;
    if (row === undefined) return undefined;
    const frame = JSON.parse(row.frameJson) as AttachV1EventFrame;
    const semanticHome = frame.event.kind === "scheduled" && "target" in frame.event;
    const target = semanticHome
      ? { kind: "canonical_home" as const, sessionId: row.threadId }
      : { kind: "thread" as const, threadId: row.threadId };
    // One terminal fact, and displayed outranks failed: a row a human read is delivered no matter
    // what the pipeline had to survive to put it there.
    const reason = row.projectionError === null ? undefined : row.projectionError.slice(0, 256);
    const terminal: AttachScheduledDeliveryReceipt["terminal"] =
      row.displayedAt !== null
        ? { state: "displayed", at: row.displayedAt }
        : row.disposition === "discarded"
          ? { state: "failed", stage: "authorization", ...(reason === undefined ? {} : { reason }), at: row.admittedAt }
          : row.deadLetteredAt !== null
            ? { state: "failed", stage: "projection", ...(reason === undefined ? {} : { reason }), at: row.deadLetteredAt }
            : undefined;
    const extras = {
      ...(row.displayedAt === null ? {} : { displayedAt: row.displayedAt }),
      ...(terminal === undefined ? {} : { terminal }),
    };
    const expectedMediaIds = frame.event.kind === "scheduled" && frame.event.mediaIds?.length
      ? frame.event.mediaIds.slice(0, 16)
      : undefined;
    const committedMediaIds = row.projectedAt === null || row.attachmentsJson === null
      ? []
      : (JSON.parse(row.attachmentsJson) as BotChatAttachment[])
        .flatMap((attachment) => typeof attachment.fileId === "string" ? [attachment.fileId] : []);
    const media = expectedMediaIds === undefined
      ? {}
      : {
        expectedMediaIds,
        committedMediaIds,
        mediaVerified: row.projectedAt !== null
          && expectedMediaIds.length === committedMediaIds.length
          && expectedMediaIds.every((mediaId, index) => mediaId === committedMediaIds[index]),
      };
    if (row.projectedAt !== null) {
      return {
        deliveryId, messageId: row.messageId, target,
        state: "projected", admittedAt: row.admittedAt, projectedAt: row.projectedAt, ...extras, ...media,
      };
    }
    if (row.deadLetteredAt !== null) {
      return {
        deliveryId, messageId: row.messageId, target,
        state: "blocked", admittedAt: row.admittedAt, attempts: row.attempts,
        deadLetteredAt: row.deadLetteredAt, ...extras, ...media,
      };
    }
    return {
      deliveryId, messageId: row.messageId, target,
      state: "admitted", admittedAt: row.admittedAt, ...extras, ...media,
    };
  }

  saveAttachMedia(
    agentId: string,
    descriptor: AttachV1MediaDescriptor,
    bytes: Uint8Array,
    createdAt: number,
  ): boolean {
    const descriptorJson = JSON.stringify(descriptor);
    try {
      this.#db
        .prepare(
          `INSERT INTO attach_media
             (agent_id, media_id, descriptor_json, mime, size, sha256, bytes, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          agentId,
          descriptor.mediaId,
          descriptorJson,
          descriptor.mimeType,
          bytes.byteLength,
          descriptor.sha256,
          bytes,
          createdAt,
          descriptor.expiresAt ?? null,
        );
      return true;
    } catch {
      const existing = this.#db
        .prepare(
          `SELECT descriptor_json AS descriptorJson FROM attach_media
           WHERE agent_id = ? AND media_id = ?`,
        )
        .get(agentId, descriptor.mediaId) as { descriptorJson: string } | undefined;
      if (existing?.descriptorJson === descriptorJson) return false;
      throw new Error("attach media id already exists");
    }
  }

  /** Roll back one just-created attach row when its command could not be admitted. */
  deleteAttachMedia(agentId: string, mediaId: string): void {
    this.#db
      .prepare("DELETE FROM attach_media WHERE agent_id = ? AND media_id = ?")
      .run(agentId, mediaId);
  }

  /** Reclaim only rows whose producer explicitly gave them a retention deadline. Attach-plugin
   * descriptors without `expiresAt` remain under the plugin's existing retention policy. */
  pruneExpiredAttachMedia(now: number): number {
    return Number(
      this.#db
        .prepare("DELETE FROM attach_media WHERE expires_at IS NOT NULL AND expires_at <= ?")
        .run(now)
        .changes,
    );
  }

  /** Delete only media that cannot yet be reached from any durable attach event or native
   * transcript. This is the rollback half of an atomic producer occurrence; a referenced object
   * is deliberately retained rather than turning a successfully committed attachment into a 404. */
  deleteUnreferencedAttachMedia(agentId: string, mediaId: string): "deleted" | "absent" | "referenced" {
    const exists = this.#db
      .prepare("SELECT 1 FROM attach_media WHERE agent_id = ? AND media_id = ?")
      .get(agentId, mediaId) !== undefined;
    if (!exists) return "absent";
    const referenced = this.#db
      .prepare(
        `SELECT 1
           WHERE EXISTS (
             SELECT 1 FROM attach_event_inbox AS inbox, json_each(inbox.frame_json, '$.event.mediaIds') AS media
             WHERE inbox.agent_id = ? AND media.value = ?
           )
           OR EXISTS (
             SELECT 1 FROM bot_native_messages AS message, json_each(message.attachments_json) AS attachment
             WHERE message.bot = ? AND json_extract(attachment.value, '$.fileId') = ?
           )`,
      )
      .get(agentId, mediaId, agentId, mediaId) !== undefined;
    if (referenced) return "referenced";
    this.#db
      .prepare("DELETE FROM attach_media WHERE agent_id = ? AND media_id = ?")
      .run(agentId, mediaId);
    return "deleted";
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

  /** Return the selected local conversation, creating the first empty conversation on demand. */
  nativeBotChat(bot: string, now: number): { sessionId: string; created: boolean; activeTurnId?: string } {
    const selected = this.#db
      .prepare("SELECT session_id AS sessionId, active_turn_id AS activeTurnId, updated_at AS updatedAt FROM bot_native_chats WHERE bot = ?")
      .get(bot) as { sessionId: string; activeTurnId: string | null; updatedAt: number } | undefined;
    if (selected === undefined) {
      const sessionId = this.#insertNativeBotSession(bot, now);
      this.#db.prepare("INSERT INTO bot_native_chats (bot, session_id, active_turn_id, updated_at) VALUES (?, ?, NULL, ?)").run(bot, sessionId, now);
      return { sessionId, created: true };
    }
    const session = this.#db
      .prepare("SELECT active_turn_id AS activeTurnId FROM bot_native_sessions WHERE bot = ? AND session_id = ?")
      .get(bot, selected.sessionId) as { activeTurnId: string | null } | undefined;
    if (session === undefined) {
      // A pre-session-table database (or a manually damaged pointer) still has authoritative
      // selection and turn state in bot_native_chats. Restore that missing companion row.
      this.#db
        .prepare("INSERT OR IGNORE INTO bot_native_sessions (bot, session_id, created_at, updated_at, active_turn_id) VALUES (?, ?, ?, ?, ?)")
        .run(bot, selected.sessionId, selected.updatedAt, selected.updatedAt, selected.activeTurnId);
      return { sessionId: selected.sessionId, created: false, ...(selected.activeTurnId === null ? {} : { activeTurnId: selected.activeTurnId }) };
    }
    return { sessionId: selected.sessionId, created: false, ...(session.activeTurnId === null ? {} : { activeTurnId: session.activeTurnId }) };
  }

  /** Mint and select a fresh empty local conversation. `reset` and `new session` intentionally
   * share this primitive: the wire distinguishes them by frame type, not by storage semantics. */
  resetNativeBotChat(bot: string, now: number): string {
    const sessionId = this.#insertNativeBotSession(bot, now);
    this.#db
      .prepare(
        `INSERT INTO bot_native_chats (bot, session_id, active_turn_id, updated_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT(bot) DO UPDATE SET session_id = excluded.session_id, active_turn_id = NULL, updated_at = excluded.updated_at`,
      )
      .run(bot, sessionId, now);
    return sessionId;
  }

  nativeBotSessions(bot: string, limit: number): Array<{
    id: string; startedAt: number; lastActiveAt: number; title?: string; preview?: string;
  }> {
    const rows = this.#db
      .prepare(
        `SELECT session_id AS id, created_at AS startedAt, updated_at AS lastActiveAt
         FROM bot_native_sessions WHERE bot = ?
         ORDER BY updated_at DESC, created_at DESC, session_id DESC LIMIT ?`,
      )
      .all(bot, limit) as unknown as Array<{ id: string; startedAt: number; lastActiveAt: number }>;
    const latestMessage = this.#db.prepare(
      `SELECT text FROM bot_native_messages
       WHERE bot = ? AND session_id = ? AND trim(text) <> ''
       ORDER BY seq DESC LIMIT 1`,
    );
    return rows.map((row) => {
      const preview = (latestMessage.get(bot, row.id) as { text: string } | undefined)?.text.trim();
      return { ...row, title: "Bot Chat", ...(preview === undefined || preview.length === 0 ? {} : { preview }) };
    });
  }

  nativeBotSessionOwner(sessionId: string): string | undefined {
    return (this.#db
      .prepare("SELECT bot FROM bot_native_sessions WHERE session_id = ? LIMIT 1")
      .get(sessionId) as { bot: string } | undefined)?.bot;
  }

  nativeBotHasSession(bot: string, sessionId: string): boolean {
    return this.#db
      .prepare("SELECT 1 AS found FROM bot_native_sessions WHERE bot = ? AND session_id = ?")
      .get(bot, sessionId) !== undefined;
  }

  selectNativeBotSession(bot: string, sessionId: string, now: number): boolean {
    if (!this.nativeBotHasSession(bot, sessionId)) return false;
    this.#db.prepare("UPDATE bot_native_chats SET session_id = ?, active_turn_id = NULL, updated_at = ? WHERE bot = ?").run(sessionId, now, bot);
    return true;
  }

  setNativeBotTurn(bot: string, sessionId: string, turnId: string | undefined, now: number): void {
    this.#db
      .prepare("UPDATE bot_native_sessions SET active_turn_id = ?, updated_at = ? WHERE bot = ? AND session_id = ?")
      .run(turnId ?? null, now, bot, sessionId);
    this.#db
      .prepare("UPDATE bot_native_chats SET active_turn_id = ?, updated_at = ? WHERE bot = ? AND session_id = ?")
      .run(turnId ?? null, now, bot, sessionId);
  }

  clearNativeBotTurn(bot: string, sessionId: string, turnId: string, now: number): boolean {
    const cleared = this.#db
      .prepare(
        "UPDATE bot_native_sessions SET active_turn_id = NULL, updated_at = ? WHERE bot = ? AND session_id = ? AND active_turn_id = ?",
      )
      .run(now, bot, sessionId, turnId);
    if (cleared.changes === 0) return false;
    this.#db
      .prepare(
        "UPDATE bot_native_chats SET active_turn_id = NULL, updated_at = ? WHERE bot = ? AND session_id = ? AND active_turn_id = ?",
      )
      .run(now, bot, sessionId, turnId);
    return true;
  }

  appendNativeBotMessage(input: {
    bot: string;
    sessionId: string;
    messageId: string;
    role: string;
    text: string;
    at: number;
    clientId?: string;
    /** Capability 32: an entry MAY carry a `position` saying where in the block flow it renders. */
    attachments?: BotChatAttachment[];
    /** Capability 31: labels a gateway-authored row that is not conversation. */
    marker?: string;
  }): BotChatMessage {
    const prior = this.#db
      .prepare(
        `SELECT message_id AS id, role, text, at, client_id AS clientId, attachments_json AS attachmentsJson, marker
         FROM bot_native_messages WHERE bot = ? AND message_id = ?`,
      )
      .get(input.bot, input.messageId) as NativeBotMessageDbRow | undefined;
    if (prior !== undefined) return nativeBotMessage(prior);
    const next = this.#db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM bot_native_messages WHERE bot = ? AND session_id = ?")
      .get(input.bot, input.sessionId) as { seq: number };
    this.#db
      .prepare(
        `INSERT INTO bot_native_messages
           (bot, session_id, seq, message_id, role, text, at, client_id, attachments_json, marker)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.marker ?? null,
      );
    this.#db
      .prepare("UPDATE bot_native_sessions SET updated_at = MAX(updated_at, ?) WHERE bot = ? AND session_id = ?")
      .run(input.at, input.bot, input.sessionId);
    this.#db
      .prepare("UPDATE bot_native_chats SET updated_at = MAX(updated_at, ?) WHERE bot = ? AND session_id = ?")
      .run(input.at, input.bot, input.sessionId);
    return { id: input.messageId, role: input.role, text: input.text, at: input.at, ...(input.clientId === undefined ? {} : { clientId: input.clientId }), ...(input.attachments === undefined ? {} : { attachments: input.attachments }), ...(input.marker === undefined ? {} : { marker: input.marker }) };
  }

  nativeBotMessages(bot: string, sessionId: string): BotChatMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT message_id AS id, role, text, at, client_id AS clientId, attachments_json AS attachmentsJson, marker
         FROM bot_native_messages WHERE bot = ? AND session_id = ? ORDER BY seq`,
      )
      .all(bot, sessionId) as unknown as NativeBotMessageDbRow[];
    return rows.map(nativeBotMessage);
  }

  /** First write wins on requestId. Only metadata is accepted by this API. */
  recordBotMobileReceipt(input: {
    requestId: string;
    bot: string;
    sessionId: string;
    turnId: string;
    command: BotMobileReceipt["command"];
    sharedDescription: BotMobileReceipt["sharedDescription"];
    purpose: string;
    sharedAt: number;
  }): BotMobileReceipt | undefined {
    const written = this.#db
      .prepare(
        `INSERT INTO bot_mobile_receipts
           (request_id, bot, session_id, turn_id, command, shared_description, purpose, shared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO NOTHING`,
      )
      .run(
        input.requestId,
        input.bot,
        input.sessionId,
        input.turnId,
        input.command,
        input.sharedDescription,
        input.purpose,
        input.sharedAt,
      );
    if (written.changes !== 1) return undefined;
    return input;
  }

  nativeBotMobileReceipts(bot: string, sessionId: string): BotMobileReceipt[] {
    return this.#db
      .prepare(
        `SELECT request_id AS requestId, bot, session_id AS sessionId,
                turn_id AS turnId, command, shared_description AS sharedDescription, purpose, shared_at AS sharedAt
         FROM bot_mobile_receipts
         WHERE bot = ? AND session_id = ?
         ORDER BY shared_at, request_id`,
      )
      .all(bot, sessionId) as unknown as BotMobileReceipt[];
  }

  /** Agent-sent artifacts across configured profiles and every durable session. Filtering stays in
   * SQLite so a phone asking for one page never makes the gateway hydrate an unbounded transcript. */
  nativeBotAttachmentHistory(input: {
    bots: readonly string[];
    query?: string;
    kind?: "image" | "video" | "audio" | "file";
    bot?: string;
    since?: number;
    offset: number;
    limit: number;
  }): NativeBotAttachmentHistoryItem[] {
    if (input.bots.length === 0) return [];
    const botPlaceholders = input.bots.map(() => "?").join(", ");
    const kind = `COALESCE(json_extract(artifact.value, '$.mediaKind'), CASE
      WHEN lower(json_extract(artifact.value, '$.mimeType')) LIKE 'image/%' THEN 'image'
      WHEN lower(json_extract(artifact.value, '$.mimeType')) LIKE 'video/%' THEN 'video'
      WHEN lower(json_extract(artifact.value, '$.mimeType')) LIKE 'audio/%' THEN 'audio'
      ELSE 'file' END)`;
    const clauses = [
      "message.role = 'assistant'",
      "message.attachments_json IS NOT NULL",
      `message.bot IN (${botPlaceholders})`,
    ];
    const args: Array<string | number> = [...input.bots];
    if (input.bot !== undefined) { clauses.push("message.bot = ?"); args.push(input.bot); }
    if (input.kind !== undefined) { clauses.push(`${kind} = ?`); args.push(input.kind); }
    if (input.since !== undefined) { clauses.push("COALESCE(message.at, 0) >= ?"); args.push(input.since); }
    const query = input.query?.trim().toLowerCase();
    if (query) {
      clauses.push(`instr(lower(message.bot || ' ' || message.text || ' ' ||
        json_extract(artifact.value, '$.name') || ' ' ||
        json_extract(artifact.value, '$.mimeType')), ?) > 0`);
      args.push(query);
    }
    const rows = this.#db.prepare(
      `SELECT message.bot, message.session_id AS sessionId,
              message.message_id AS messageId, message.text AS caption, message.at,
              artifact.value AS attachmentJson
       FROM bot_native_messages AS message, json_each(message.attachments_json) AS artifact
       WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(message.at, 0) DESC, message.message_id DESC,
                json_extract(artifact.value, '$.fileId') DESC
       LIMIT ? OFFSET ?`,
    ).all(...args, input.limit, input.offset) as unknown as Array<{
      bot: string; sessionId: string; messageId: string; caption: string;
      at: number | null; attachmentJson: string;
    }>;
    return rows.map((row) => ({
      bot: row.bot,
      sessionId: row.sessionId,
      messageId: row.messageId,
      caption: row.caption,
      at: row.at,
      attachment: JSON.parse(row.attachmentJson) as AttachmentBlock,
    }));
  }

  nativeBotMessage(bot: string, messageId: string): BotChatMessage | undefined {
    const row = this.#db
      .prepare(
        `SELECT message_id AS id, role, text, at, client_id AS clientId, attachments_json AS attachmentsJson, marker
         FROM bot_native_messages WHERE bot = ? AND message_id = ?`,
      )
      .get(bot, messageId) as NativeBotMessageDbRow | undefined;
    return row === undefined ? undefined : nativeBotMessage(row);
  }

  #insertNativeBotSession(bot: string, now: number): string {
    const sessionId = `native:${bot}:${randomUUID()}`;
    this.#db
      .prepare("INSERT INTO bot_native_sessions (bot, session_id, created_at, updated_at, active_turn_id) VALUES (?, ?, ?, ?, NULL)")
      .run(bot, sessionId, now, now);
    return sessionId;
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
  }): "inserted" | "updated" | "duplicate" | "conflict" {
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
      if (input.status !== "pending") this.#trimTerminalNativeInteractions(input.bot);
      return "inserted";
    }
    if (prior.status !== "pending") return "duplicate";
    if (input.status === "pending") return "duplicate";
    if (prior.sessionId !== input.sessionId || prior.turnId !== input.turnId)
      return "conflict";
    this.#db
      .prepare(
        `UPDATE bot_native_interactions SET status = ?, selected_option_id = ?, updated_at = ?
         WHERE bot = ? AND kind = ? AND interaction_id = ? AND status = 'pending'`,
      )
      .run(input.status, input.selectedOptionId ?? null, input.updatedAt, input.bot, input.kind, input.interactionId);
    this.#trimTerminalNativeInteractions(input.bot);
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
    const resolved = this.#db
      .prepare(
        `UPDATE bot_native_interactions SET status = ?, selected_option_id = ?, updated_at = ?
         WHERE bot = ? AND kind = ? AND interaction_id = ? AND status = 'pending'`,
      )
      .run(status, selectedOptionId ?? null, updatedAt, bot, kind, interactionId).changes === 1;
    if (resolved) this.#trimTerminalNativeInteractions(bot);
    return resolved;
  }

  nativeInteraction(
    bot: string,
    kind: "approval" | "clarify",
    interactionId: string,
  ): { sessionId: string; turnId: string; payload: unknown; status: string; selectedOptionId: string | null; expiresAt: number | null; resolutionCommandId: string | null; resolutionRequestedAt: number | null; requestedDecision: string | null; requestedOptionId: string | null; updatedAt: number } | undefined {
    const row = this.#db
      .prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId, payload_json AS payloadJson, status,
                selected_option_id AS selectedOptionId, expires_at AS expiresAt,
                resolution_command_id AS resolutionCommandId,
                resolution_requested_at AS resolutionRequestedAt,
                requested_decision AS requestedDecision,
                requested_option_id AS requestedOptionId,
                updated_at AS updatedAt
         FROM bot_native_interactions WHERE bot = ? AND kind = ? AND interaction_id = ?`,
      )
      .get(bot, kind, interactionId) as { sessionId: string; turnId: string; payloadJson: string; status: string; selectedOptionId: string | null; expiresAt: number | null; resolutionCommandId: string | null; resolutionRequestedAt: number | null; requestedDecision: string | null; requestedOptionId: string | null; updatedAt: number } | undefined;
    return row === undefined ? undefined : { ...row, payload: JSON.parse(row.payloadJson) as unknown };
  }

  /** The decision marker and command outbox append are one transaction. A restart can therefore
   * never present a decision as submitted without retaining the exact command for replay. */
  requestNativeInteractionResolution(input: {
    bot: string;
    kind: "approval" | "clarify";
    interactionId: string;
    decision: string;
    optionId?: string;
    commandId: string;
    command: AttachV1Command;
    requestedAt: number;
  }): NativeInteractionResolutionRequest {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db
        .prepare(
          `SELECT session_id AS sessionId, turn_id AS turnId, status, expires_at AS expiresAt,
                  resolution_command_id AS resolutionCommandId,
                  requested_decision AS requestedDecision,
                  requested_option_id AS requestedOptionId
           FROM bot_native_interactions
           WHERE bot = ? AND kind = ? AND interaction_id = ?`,
        )
        .get(input.bot, input.kind, input.interactionId) as {
        sessionId: string;
        turnId: string;
        status: string;
        expiresAt: number | null;
        resolutionCommandId: string | null;
        requestedDecision: string | null;
        requestedOptionId: string | null;
      } | undefined;
      if (row === undefined) {
        this.#db.exec("COMMIT");
        return { outcome: "unknown" };
      }
      if (row.status !== "pending") {
        this.#db.exec("COMMIT");
        return { outcome: row.status === "expired" ? "expired" : "not_pending", ...(row.status === "expired" ? { sessionId: row.sessionId, turnId: row.turnId } : {}) } as NativeInteractionResolutionRequest;
      }
      if (row.expiresAt !== null && row.expiresAt <= input.requestedAt) {
        this.#db
          .prepare(
            `UPDATE bot_native_interactions SET status = 'expired', updated_at = ?
             WHERE bot = ? AND kind = ? AND interaction_id = ? AND status = 'pending'
               AND expires_at IS NOT NULL AND expires_at <= ?`,
          )
          .run(input.requestedAt, input.bot, input.kind, input.interactionId, input.requestedAt);
        this.#trimTerminalNativeInteractions(input.bot);
        this.#db.exec("COMMIT");
        return { outcome: "expired", sessionId: row.sessionId, turnId: row.turnId };
      }
      if (row.resolutionCommandId !== null) {
        const same = row.requestedDecision === input.decision && row.requestedOptionId === (input.optionId ?? null);
        this.#db.exec("COMMIT");
        return {
          outcome: same ? "already_requested" : "resolution_pending",
          sessionId: row.sessionId,
          turnId: row.turnId,
          fresh: false,
        };
      }
      this.#db
        .prepare(
          `INSERT INTO attach_streams (agent_id, next_command_sequence, last_event_sequence, updated_at)
           VALUES (?, 1, 0, ?) ON CONFLICT(agent_id) DO NOTHING`,
        )
        .run(input.bot, input.requestedAt);
      const stream = this.#db
        .prepare("SELECT next_command_sequence AS sequence FROM attach_streams WHERE agent_id = ?")
        .get(input.bot) as { sequence: number };
      this.#db
        .prepare(
          `INSERT INTO attach_command_outbox
             (agent_id, sequence, command_id, command_json, created_at, acked_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(input.bot, stream.sequence, input.commandId, JSON.stringify(input.command), input.requestedAt);
      this.#db
        .prepare("UPDATE attach_streams SET next_command_sequence = ?, updated_at = ? WHERE agent_id = ?")
        .run(stream.sequence + 1, input.requestedAt, input.bot);
      const marked = this.#db
        .prepare(
          `UPDATE bot_native_interactions
           SET resolution_command_id = ?, resolution_requested_at = ?, requested_decision = ?,
               requested_option_id = ?
           WHERE bot = ? AND kind = ? AND interaction_id = ? AND status = 'pending'
             AND resolution_command_id IS NULL`,
        )
        .run(
          input.commandId,
          input.requestedAt,
          input.decision,
          input.optionId ?? null,
          input.bot,
          input.kind,
          input.interactionId,
        ).changes;
      if (marked !== 1) throw new Error("native interaction changed during resolution request");
      this.#db.exec("COMMIT");
      return { outcome: "requested", sessionId: row.sessionId, turnId: row.turnId, fresh: true };
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
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

  /** Bounded current-state projection for the mobile approval inbox. `updated_at` is the pending
   * record's creation time: records are inserted pending once and only transition to a terminal
   * status afterwards, at which point this query excludes them. Keep the payload JSON in SQLite;
   * this read selects only the already-safe rule display name and can never surface tool args. */
  pendingNativeApprovals(bots: readonly string[], limit: number): Array<{
    bot: string;
    sessionId: string;
    turnId: string;
    toolCallId: string;
    ruleName: string;
    createdAt: number;
    resolutionRequestedAt?: number;
  }> {
    if (bots.length === 0) return [];
    const placeholders = bots.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT bot, session_id AS sessionId, turn_id AS turnId,
                interaction_id AS toolCallId,
                json_extract(payload_json, '$.name') AS ruleName,
                updated_at AS createdAt,
                resolution_requested_at AS resolutionRequestedAt
         FROM bot_native_interactions
         WHERE kind = 'approval' AND status = 'pending' AND bot IN (${placeholders})
         ORDER BY updated_at, interaction_id
         LIMIT ?`,
      )
      .all(...bots, limit) as unknown as Array<{
        bot: string;
        sessionId: string;
        turnId: string;
        toolCallId: string;
        ruleName: string;
        createdAt: number;
        resolutionRequestedAt: number | null;
      }>;
    return rows.map(({ resolutionRequestedAt, ...row }) => ({
      ...row,
      ...(resolutionRequestedAt === null ? {} : { resolutionRequestedAt }),
    }));
  }

  /** Bounded display-safe clarification recovery. The original payload remains private in the
   * durable interaction row; this projects only the already-rendered prompt/options. */
  pendingNativeClarifications(
    bots: readonly string[],
    limit: number,
  ): BotPendingClarification[] {
    if (bots.length === 0) return [];
    const placeholders = bots.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT bot, session_id AS sessionId, turn_id AS turnId,
                interaction_id AS clarifyId, payload_json AS payloadJson,
                expires_at AS expiresAt, resolution_requested_at AS resolutionRequestedAt
         FROM bot_native_interactions
         WHERE kind = 'clarify' AND status = 'pending' AND bot IN (${placeholders})
         ORDER BY updated_at, interaction_id
         LIMIT ?`,
      )
      .all(...bots, limit) as unknown as Array<{
        bot: string;
        sessionId: string;
        turnId: string;
        clarifyId: string;
        payloadJson: string;
        expiresAt: number | null;
        resolutionRequestedAt: number | null;
      }>;
    return rows.map(({ payloadJson, expiresAt, resolutionRequestedAt, ...row }) => {
      const payload = JSON.parse(payloadJson) as { prompt?: unknown; options?: unknown };
      return {
        ...row,
        prompt: typeof payload.prompt === "string" ? payload.prompt : "",
        options: Array.isArray(payload.options) ? payload.options as BotPendingClarification["options"] : [],
        ...(expiresAt === null ? {} : { expiresAt }),
        ...(resolutionRequestedAt === null ? {} : { resolutionRequestedAt }),
      };
    });
  }

  /** Terminal interaction proof is durable but bounded. This recovery read includes neither
   * command ids/decisions nor raw approval or model payloads. */
  terminalNativeSettlements(
    bots: readonly string[],
  ): BotInteractionSettlement[] {
    if (bots.length === 0) return [];
    // Existing deployments predate the retention bound. Normalize their retained history when it
    // is first read, so an upgrade cannot leave an indefinitely growing terminal table until the
    // next incoming Hermes event happens to settle.
    for (const bot of bots) this.#trimTerminalNativeInteractions(bot);
    const placeholders = bots.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(
        `SELECT bot, kind, interaction_id AS interactionId, session_id AS sessionId,
                turn_id AS turnId, status AS outcome, selected_option_id AS selectedOptionId,
                updated_at AS settledAt
         FROM bot_native_interactions
         WHERE status <> 'pending' AND bot IN (${placeholders})
         ORDER BY updated_at DESC, kind, interaction_id`,
      )
      .all(...bots) as unknown as Array<{
        bot: string;
        kind: "approval" | "clarify";
        interactionId: string;
        sessionId: string;
        turnId: string;
        outcome: BotInteractionSettlement["outcome"];
        selectedOptionId: string | null;
        settledAt: number;
      }>;
    return rows.map(({ selectedOptionId, ...row }) => ({
      ...row,
      ...(selectedOptionId === null ? {} : { selectedOptionId }),
    }));
  }

  /** Atomically transition one stale approval before a user can act on it. The conditional update
   * is authoritative, so a timer or another device winning the race cannot expire a settled row. */
  expireNativeApprovalIfDue(
    bot: string,
    interactionId: string,
    now: number,
  ): { sessionId: string; turnId: string } | undefined {
    return this.expireNativeInteractionIfDue(bot, "approval", interactionId, now);
  }

  /** A requested decision remains pending until Hermes proves a terminal result. The deadline is
   * still authoritative during that interval, so it must be checked in the same synchronous path
   * used by the action route, not only by a background timer. */
  expireNativeInteractionIfDue(
    bot: string,
    kind: "approval" | "clarify",
    interactionId: string,
    now: number,
  ): { sessionId: string; turnId: string } | undefined {
    const row = this.#db
      .prepare(
        `SELECT session_id AS sessionId, turn_id AS turnId
         FROM bot_native_interactions
         WHERE bot = ? AND kind = ? AND interaction_id = ?
           AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .get(bot, kind, interactionId, now) as { sessionId: string; turnId: string } | undefined;
    if (row === undefined) return undefined;
    const changed = this.#db
      .prepare(
        `UPDATE bot_native_interactions SET status = 'expired', updated_at = ?
         WHERE bot = ? AND kind = ? AND interaction_id = ?
           AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(now, bot, kind, interactionId, now).changes === 1;
    if (changed) this.#trimTerminalNativeInteractions(bot);
    return changed ? row : undefined;
  }

  /** Due active-profile approval ids. Callers settle each through the conditional method above,
   * retaining exactly-one terminal event semantics while completing the check synchronously. */
  dueNativeApprovalIds(bots: readonly string[], now: number): Array<{ bot: string; interactionId: string }> {
    if (bots.length === 0) return [];
    const placeholders = bots.map(() => "?").join(", ");
    return this.#db
      .prepare(
        `SELECT bot, interaction_id AS interactionId FROM bot_native_interactions
         WHERE kind = 'approval' AND status = 'pending' AND expires_at IS NOT NULL
           AND expires_at <= ? AND bot IN (${placeholders})
         ORDER BY expires_at, interaction_id`,
      )
      .all(now, ...bots) as unknown as Array<{ bot: string; interactionId: string }>;
  }

  #trimTerminalNativeInteractions(bot: string): void {
    this.#db
      .prepare(
        `DELETE FROM bot_native_interactions
         WHERE bot = ? AND status <> 'pending'
           AND (kind, interaction_id) IN (
             SELECT kind, interaction_id FROM bot_native_interactions
             WHERE bot = ? AND status <> 'pending'
             ORDER BY updated_at DESC, kind, interaction_id
             LIMIT -1 OFFSET ?
           )`,
      )
      .run(bot, bot, NATIVE_INTERACTION_SETTLEMENT_LIMIT);
  }

  /** The bot's live native turn, if any, read WITHOUT the create-if-missing side effect of
   *  `nativeBotChat`. Deletion asks this question about a bot it is about to remove, so writing a
   *  fresh chat row for it here would be self-defeating. */
  nativeBotActiveTurn(bot: string): { sessionId: string; turnId: string } | undefined {
    const row = this.#db
      .prepare("SELECT session_id AS sessionId, active_turn_id AS turnId FROM bot_native_chats WHERE bot = ?")
      .get(bot) as unknown as { sessionId: string; turnId: string | null } | undefined;
    if (row === undefined || row.turnId === null) return undefined;
    return { sessionId: row.sessionId, turnId: row.turnId };
  }

  /** Removes every durable row this gateway holds for one bot, in one transaction: the roster
   *  cache row, the native chat plane (active pointer, sessions, transcript, receipts, turn media
   *  bindings, interactions, terminals), tool steps and delegations, routine overrides, the attach
   *  journals (stream cursors, command outbox, event inbox, turn terminals, media blobs, scheduled
   *  deliveries), the bot's group-turn tombstones, its Live Activity registrations, and its half
   *  of the core thread surface (messages, threads, the agent row). Group rooms and their
   *  membership are deliberately NOT touched: a room is a user-owned resource that may name a
   *  deleted member, and
   *  the room surface already renders a missing member honestly.
   *
   *  Returns the deleted row count per area (zero-row areas omitted), so the delete route reports
   *  what it actually removed rather than asserting it. Keys are the stable identifiers
   *  `BotDeleteResponse.purged` carries on the wire. */
  purgeBot(bot: string): Record<string, number> {
    const areas: ReadonlyArray<readonly [area: string, table: string, column: string]> = [
      ["roster", "bot_roster", "name"],
      ["toolSteps", "bot_chat_tool_steps", "bot"],
      ["delegations", "bot_chat_delegations", "bot"],
      ["routineOverrides", "bot_routine_overrides", "bot"],
      ["chatPointer", "bot_native_chats", "bot"],
      ["sessions", "bot_native_sessions", "bot"],
      ["messages", "bot_native_messages", "bot"],
      ["receipts", "bot_message_receipts", "bot"],
      ["mobileReceipts", "bot_mobile_receipts", "bot"],
      ["turnMediaDeliveries", "bot_turn_media_deliveries", "bot"],
      ["interactions", "bot_native_interactions", "bot"],
      ["turnTerminals", "bot_native_turn_terminals", "bot"],
      ["attachStream", "attach_streams", "agent_id"],
      ["attachCommands", "attach_command_outbox", "agent_id"],
      ["attachEvents", "attach_event_inbox", "agent_id"],
      ["attachTurnTerminals", "attach_turn_terminals", "agent_id"],
      ["attachMedia", "attach_media", "agent_id"],
      ["scheduledDeliveries", "attach_scheduled_deliveries", "agent_id"],
      ["groupTurns", "bot_group_turns", "agent_id"],
      ["liveActivities", "live_activity_registrations", "bot"],
    ];
    const purged: Record<string, number> = {};
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const [area, table, column] of areas) {
        const changes = Number(
          this.#db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(bot).changes,
        );
        if (changes > 0) purged[area] = changes;
      }
      // The core thread surface is a parent/child chain rather than a flat `WHERE bot = ?`, and
      // `PRAGMA foreign_keys` is ON, so it goes child-first inside this same transaction. The
      // `agents` row is config-derived and will be rewritten at the next boot if the operator
      // never runs the deprovision sweep, which is exactly why that sweep is in the residue list.
      const core: ReadonlyArray<readonly [area: string, sql: string]> = [
        [
          "coreMessages",
          "DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE agent_id = ?)",
        ],
        ["coreThreads", "DELETE FROM threads WHERE agent_id = ?"],
        ["agentRow", "DELETE FROM agents WHERE id = ?"],
      ];
      for (const [area, sql] of core) {
        const changes = Number(this.#db.prepare(sql).run(bot).changes);
        if (changes > 0) purged[area] = changes;
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    return purged;
  }

  close(): void {
    this.#db.close();
  }
}

interface NativeBotMessageDbRow {
  id: string;
  role: string;
  text: string;
  at: number | null;
  clientId: string | null;
  attachmentsJson: string | null;
  marker: string | null;
}

function nativeBotMessage(row: NativeBotMessageDbRow): BotChatMessage {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    at: row.at,
    ...(row.clientId === null ? {} : { clientId: row.clientId }),
    ...(row.attachmentsJson === null ? {} : { attachments: JSON.parse(row.attachmentsJson) as BotChatAttachment[] }),
    ...(row.marker === null ? {} : { marker: row.marker }),
  };
}

export function openStorage(dbPath: string): Storage {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  // Setup codes predate onboarding. Add publication authority in place so App Review, Docker,
  // conformance, and operator-created legacy codes keep their existing active behavior. The
  // challenge index must come after both columns exist: CREATE TABLE IF NOT EXISTS does not add
  // columns to an older table.
  db.exec("BEGIN IMMEDIATE");
  try {
    const setupCodeColumns = db
      .prepare("SELECT name FROM pragma_table_info('setup_codes')")
      .all() as Array<{ name: string }>;
    if (!setupCodeColumns.some(({ name }) => name === "challenge_id"))
      db.exec(`
        ALTER TABLE setup_codes ADD COLUMN challenge_id TEXT
          REFERENCES onboarding_challenges(challenge_id)
      `);
    if (!setupCodeColumns.some(({ name }) => name === "output_state")) {
      db.exec(`
        ALTER TABLE setup_codes ADD COLUMN output_state TEXT NOT NULL DEFAULT 'active'
          CHECK (output_state IN ('pending_output', 'active', 'revoked'))
      `);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS setup_codes_one_per_challenge
        ON setup_codes (challenge_id) WHERE challenge_id IS NOT NULL
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // The first outbox build keyed only by push id. Rebuild once with an AUTOINCREMENT sequence so
  // a drain can capture a stable high-water snapshot that new enqueue traffic can never enter.
  const outboxColumns = db
    .prepare("SELECT name FROM pragma_table_info('live_activity_relay_deletion_outbox')")
    .all() as Array<{ name: string }>;
  if (!outboxColumns.some((column) => column.name === "sequence")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE live_activity_relay_deletion_outbox
          RENAME TO live_activity_relay_deletion_outbox_v1;
        CREATE TABLE live_activity_relay_deletion_outbox (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          push_id TEXT NOT NULL UNIQUE,
          queued_at INTEGER NOT NULL
        ) STRICT;
        INSERT INTO live_activity_relay_deletion_outbox (push_id, queued_at)
        SELECT push_id, queued_at FROM live_activity_relay_deletion_outbox_v1
        ORDER BY queued_at, push_id;
        DROP TABLE live_activity_relay_deletion_outbox_v1;
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  // Older builds keyed activities only by ActivityKit id, so every new run could leave another
  // row for the same device conversation. Retire all but the newest row durably before installing
  // the invariant that prevents that fan-out shape from returning.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      WITH ranked AS (
        SELECT rowid AS registrationRowId, push_id AS pushId,
          ROW_NUMBER() OVER (
            PARTITION BY device_id, conversation_id
            ORDER BY created_at DESC, rowid DESC
          ) AS recency
        FROM live_activity_registrations
      )
      INSERT OR IGNORE INTO live_activity_relay_deletion_outbox (push_id, queued_at)
      SELECT pushId, ? FROM ranked WHERE recency > 1
    `).run(Date.now());
    db.exec(`
      DELETE FROM live_activity_registrations WHERE rowid IN (
        SELECT registrationRowId FROM (
          SELECT rowid AS registrationRowId,
            ROW_NUMBER() OVER (
              PARTITION BY device_id, conversation_id
              ORDER BY created_at DESC, rowid DESC
            ) AS recency
          FROM live_activity_registrations
        ) WHERE recency > 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS live_activity_device_conversation
        ON live_activity_registrations (device_id, conversation_id);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  // Capability 28 distinguishes a submitted device decision from Hermes' later terminal event.
  // Existing durable rows remain pending with all request fields null after this additive migration.
  const interactionColumns = db
    .prepare("SELECT name FROM pragma_table_info('bot_native_interactions')")
    .all() as Array<{ name: string }>;
  for (const [name, definition] of [
    ["resolution_command_id", "TEXT"],
    ["resolution_requested_at", "INTEGER"],
    ["requested_decision", "TEXT"],
    ["requested_option_id", "TEXT"],
  ] as const) {
    if (!interactionColumns.some((column) => column.name === name))
      db.exec(`ALTER TABLE bot_native_interactions ADD COLUMN ${name} ${definition}`);
  }
  // Capability 31 marks gateway-authored non-conversation rows (`delivery.failed`). Existing rows
  // stay unmarked, which is exactly what they are.
  const messageColumns = db
    .prepare("SELECT name FROM pragma_table_info('bot_native_messages')")
    .all() as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === "marker"))
    db.exec("ALTER TABLE bot_native_messages ADD COLUMN marker TEXT");
  const streamColumns = db
    .prepare("SELECT name FROM pragma_table_info('attach_streams')")
    .all() as Array<{ name: string }>;
  for (const [name, definition] of [
    ["plugin_event_outbox_depth", "INTEGER"],
    ["plugin_oldest_event_age_ms", "INTEGER"],
    ["plugin_event_ack_cursor", "INTEGER"],
    ["plugin_last_ack_progress_at", "INTEGER"],
    ["plugin_command_inbox_depth", "INTEGER"],
  ] as const) {
    if (!streamColumns.some((column) => column.name === name))
      db.exec(`ALTER TABLE attach_streams ADD COLUMN ${name} ${definition}`);
  }
  // Capability 34 additive alias: the canonical Hermes delegation id for a batch, learned from
  // the parent delegate_task result. Existing rows stay unaliased, which is what they are.
  const delegationColumns = db
    .prepare("SELECT name FROM pragma_table_info('bot_chat_delegations')")
    .all() as Array<{ name: string }>;
  if (!delegationColumns.some((column) => column.name === "alias_id"))
    db.exec("ALTER TABLE bot_chat_delegations ADD COLUMN alias_id TEXT");
  // v0.1 stored only a selected native-chat pointer and transcript rows. v0.2 split sessions
  // into their own table; recreate every existing session without changing populated new rows.
  db.exec(`
    WITH legacy_sessions AS (
      SELECT bot, session_id, updated_at AS created_at, updated_at, active_turn_id FROM bot_native_chats
      UNION ALL
      SELECT bot, session_id, COALESCE(MIN(at), 0), COALESCE(MAX(at), 0), NULL
      FROM bot_native_messages GROUP BY bot, session_id
    )
    INSERT OR IGNORE INTO bot_native_sessions (bot, session_id, created_at, updated_at, active_turn_id)
    SELECT bot, session_id, MIN(created_at), MAX(updated_at), MAX(active_turn_id)
    FROM legacy_sessions GROUP BY bot, session_id
  `);
  // A process can disappear after a tool starts but before its terminal event is persisted. Only
  // the selected active turn can still receive that event after restart; close every older step so
  // history never presents stale work as currently running.
  db.prepare(`
    UPDATE bot_chat_tool_steps
    SET status = 'interrupted', ended_at = ?
    WHERE ended_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM bot_native_chats AS chat
      WHERE chat.bot = bot_chat_tool_steps.bot
        AND chat.session_id = bot_chat_tool_steps.session_id
        AND chat.active_turn_id = bot_chat_tool_steps.turn_id
    )
  `).run(Date.now());
  // Restart truth for delegation children: only the selected active turn can still receive a
  // finish leg after restart, so every other still-live child settles as `unknown` -- NEVER
  // `failed`. Hermes explicitly cannot prove what external side effects an in-flight child had,
  // and a late finish leg replayed through the spool is still free to overwrite `unknown` with
  // the real outcome.
  db.prepare(`
    UPDATE bot_chat_delegations
    SET status = 'unknown', ended_at = ?
    WHERE status IN ('queued', 'starting', 'running', 'stalling') AND NOT EXISTS (
      SELECT 1 FROM bot_native_chats AS chat
      WHERE chat.bot = bot_chat_delegations.bot
        AND chat.session_id = bot_chat_delegations.session_id
        AND chat.active_turn_id = bot_chat_delegations.turn_id
    )
  `).run(Date.now());
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS messages_external_id ON messages (thread_id, external_id) WHERE external_id IS NOT NULL");
  // Issue #193: `applied_at` is the assembly-time replay watermark -- every accepted inbox row
  // still NULL at boot is re-applied through the normal projection path. Rows from before this
  // build predate that contract: some were applied by builds whose bookkeeping then failed or
  // dead-lettered, and replaying weeks of stale conversation into live chats on the first boot
  // of this build would be a worse failure than the (already hand-repaired) ghosts it might
  // heal. The honest watermark is therefore "replay begins with events journaled after this
  // migration": every pre-existing unapplied row is stamped applied at its own received_at, so
  // the first boot replays nothing historical.
  let { user_version: schemaVersion } = db
    .prepare("PRAGMA user_version")
    .get() as { user_version: number };
  if (schemaVersion < 1) {
    db.exec("UPDATE attach_event_inbox SET applied_at = received_at WHERE applied_at IS NULL");
    db.exec("PRAGMA user_version = 1");
    schemaVersion = 1;
  }
  // Capability 39 originally shipped with receipt constraints for status and location only.
  // Expanded phone commands reached the broker later, so SQLite rejected every successful camera,
  // picker, and notification receipt. Rebuild the table transactionally because SQLite cannot
  // alter a CHECK constraint in place; the old table's narrower constraints guarantee every copied
  // row is valid under the expanded domain.
  if (schemaVersion < 2) {
    const receiptTable = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bot_mobile_receipts'")
      .get() as { sql: string };
    if (!receiptTable.sql.includes("'notification.present'")) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          DROP INDEX IF EXISTS bot_mobile_receipts_session;
          ALTER TABLE bot_mobile_receipts RENAME TO bot_mobile_receipts_v1;
          CREATE TABLE bot_mobile_receipts (
${BOT_MOBILE_RECEIPT_COLUMNS}
          ) STRICT, WITHOUT ROWID;
          INSERT INTO bot_mobile_receipts
            (request_id, bot, session_id, turn_id, command, shared_description, purpose, shared_at)
          SELECT request_id, bot, session_id, turn_id, command, shared_description, purpose, shared_at
          FROM bot_mobile_receipts_v1;
          DROP TABLE bot_mobile_receipts_v1;
          CREATE INDEX bot_mobile_receipts_session
            ON bot_mobile_receipts (bot, session_id, shared_at, request_id);
          PRAGMA user_version = 2;
          COMMIT;
        `);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else {
      db.exec("PRAGMA user_version = 2");
    }
  }
  return new Storage(db);
}

/** Vendor extension `com.cozylabs.bots`, version 1. NOT part of the frozen `contract: "v1"`
 *  core surface: it is advertised through `GatewayInfo.capabilities` (see resources.ts) and
 *  documented in contract/ext-bots-v1.md, versioned independently. A gateway that does not
 *  advertise the capability never emits these frames, and a client that does not recognize the
 *  capability ignores them, exactly as the forward-compatibility rule for unknown server frames
 *  requires.
 *
 *  Everything here mirrors what a Hermes gateway's Bot Mode conventions carry. The units are the
 *  ones the wire uses after the bridge has normalized them: `lastActiveAt` is MILLISECONDS (the
 *  Hermes `last_session.last_active` is seconds and is converted inside the bridge), and
 *  `meta.created` stays milliseconds as the desktop plugin writes it. */
import { type Static, Type } from "@sinclair/typebox";

/** The roster preview line, already classified. `a2a` is a bot-to-bot delivery whose
 *  `Message from ... :` prefix has been stripped, with the sender handle carried separately;
 *  `plain` is an ordinary conversation preview; `empty` means the bot has no conversation yet. */
export const BotPreviewSchema = Type.Object({
  kind: Type.Union([Type.Literal("a2a"), Type.Literal("plain"), Type.Literal("empty")]),
  text: Type.String(),
  sender: Type.Optional(Type.String()),
});
export type BotPreview = Static<typeof BotPreviewSchema>;

/** One roster row. `meta` is the bot's `ui_meta["hermes-bots"]` blob verbatim (or null when the
 *  profile carries none), kept open on purpose: the desktop plugin owns that namespace and may
 *  add keys we do not model. */
export const BotSummarySchema = Type.Object({
  name: Type.String(),
  displayName: Type.String(),
  handle: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  hasAvatar: Type.Boolean(),
  group: Type.Union([Type.String(), Type.Null()]),
  pinned: Type.Boolean(),
  active: Type.Boolean(),
  lastActiveAt: Type.Union([Type.Integer(), Type.Null()]),
  chatSessionId: Type.Union([Type.String(), Type.Null()]),
  preview: BotPreviewSchema,
  meta: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
});
export type BotSummary = Static<typeof BotSummarySchema>;

/** Full-replace roster snapshot. Sent whenever the bridge's cached roster changes. */
export const BotRosterFrameSchema = Type.Object({
  type: Type.Literal("bot_roster"),
  bots: Type.Array(BotSummarySchema),
  updatedAt: Type.Integer(),
});
export type BotRosterFrame = Static<typeof BotRosterFrameSchema>;

/** The "Active now" set, by profile name, as a full replace. Sent only when the set changes, so
 *  an idle gateway is silent. */
export const BotPresenceFrameSchema = Type.Object({
  type: Type.Literal("bot_presence"),
  active: Type.Array(Type.String()),
  updatedAt: Type.Integer(),
});
export type BotPresenceFrame = Static<typeof BotPresenceFrameSchema>;

/** One message in a bot's canonical chat, after the bridge has flattened whatever shape Hermes
 *  returned. `id` is stable for a given session: the gateway's own message id when it carries one,
 *  otherwise the session id plus the message's position, so a client can key a list on it and
 *  drop a replayed frame. `at` is MILLISECONDS, or null when the message carries no timestamp at
 *  all (Hermes stamps in seconds on some builds and not at all on others). */
export const BotChatMessageSchema = Type.Object({
  id: Type.String(),
  role: Type.String(),
  text: Type.String(),
  at: Type.Union([Type.Integer(), Type.Null()]),
});
export type BotChatMessage = Static<typeof BotChatMessageSchema>;

/** New messages in a bot's canonical chat. A DELTA, not a snapshot: `messages` carries only what
 *  the bridge has not broadcast before, in order. */
export const BotChatFrameSchema = Type.Object({
  type: Type.Literal("bot_chat"),
  bot: Type.String(),
  sessionId: Type.String(),
  messages: Type.Array(BotChatMessageSchema),
  updatedAt: Type.Integer(),
});
export type BotChatFrame = Static<typeof BotChatFrameSchema>;

/** How a bot's canonical chat is doing right now. `phase` is the bridge's own view of the turn it
 *  is polling; `running` and `inflight` are Hermes' own flags, passed through. */
export const BotChatStateFrameSchema = Type.Object({
  type: Type.Literal("bot_chat_state"),
  bot: Type.String(),
  sessionId: Type.String(),
  /** `polling` = a turn is being awaited; `complete` = the reply landed and Hermes went idle;
   *  `timeout` = the cap expired with no settled reply; `failed` = the poll gave up because
   *  Hermes kept refusing. */
  phase: Type.Union([
    Type.Literal("polling"),
    Type.Literal("complete"),
    Type.Literal("timeout"),
    Type.Literal("failed"),
  ]),
  running: Type.Boolean(),
  inflight: Type.Boolean(),
  updatedAt: Type.Integer(),
});
export type BotChatStateFrame = Static<typeof BotChatStateFrameSchema>;

/** `POST /bots/:name/chat/messages` body. */
export const BotChatSendRequestSchema = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 32_000 }),
});
export type BotChatSendRequest = Static<typeof BotChatSendRequestSchema>;

/** `POST /bots/focus` body. The app declares what it is looking at so the bridge polls Hermes at
 *  the desktop's cadences only while a screen is open, and idles otherwise. `null` means the app
 *  left the bots surface. */
export const BotFocusRequestSchema = Type.Object({
  screen: Type.Union([Type.Literal("roster"), Type.Literal("routines"), Type.Null()]),
});
export type BotFocusRequest = Static<typeof BotFocusRequestSchema>;

/** Capability id and version advertised in `GatewayInfo.capabilities` when the bots bridge is
 *  configured. */
export const BOTS_CAPABILITY_ID = "com.cozylabs.bots";
export const BOTS_CAPABILITY_VERSION = 1;

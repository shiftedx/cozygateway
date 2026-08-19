/** Vendor extension `com.cozylabs.bots`. NOT part of the frozen `contract: "v1"`
 *  core surface: it is advertised through `GatewayInfo.capabilities` (see resources.ts) and
 *  documented in contract/ext-bots-v1.md, versioned independently. A gateway that does not
 *  advertise the capability never emits these frames, and a client that does not recognize the
 *  capability ignores them, exactly as the forward-compatibility rule for unknown server frames
 *  requires.
 *
 *  The current version and its whole history live on `BOTS_CAPABILITY_VERSION` at the foot of this
 *  file, and nowhere else. Naming a number up here is how this comment came to claim "version 6"
 *  through three bumps.
 *
 *  Everything here mirrors what a Hermes gateway's Bot Mode conventions carry. The units are the
 *  ones the wire uses after the bridge has normalized them: `lastActiveAt` is MILLISECONDS (the
 *  Hermes `last_session.last_active` is seconds and is converted inside the bridge), and
 *  `meta.created` stays milliseconds as the desktop plugin writes it. */
import { type Static, Type } from "@sinclair/typebox";

import { AttachmentBlockSchema } from "./rich-blocks.ts";
import { ApprovalOutcomeSchema } from "./resources.ts";

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
 *  all (Hermes stamps in seconds on some builds and not at all on others).
 *
 *  `role` is always `user` or `assistant` on this wire: the bridge drops `system` and `tool` rows,
 *  and any row whose text is empty, so tool chatter never reaches a chat bubble.
 *
 *  `clientId` is the echo of what the sender put on `POST /bots/:name/chat/messages` (or the
 *  gateway's own local id when the sender sent none). It rides the 202 body AND the same message
 *  when it comes back in a `bot_chat` frame, which is what lets a sender replace its optimistic row
 *  instead of rendering the message twice.
 *
 *  `attachments` (capability 9) carries the photos that were sent WITH this message, as the frozen
 *  `attachment` block from `contract/v1.md`. Every entry's `fileId` is gateway-scoped and opaque, is
 *  never a URL and is never a path, and is fetched from `GET /bots/:name/chat/attachments/:fileId`.
 *  A host path never reaches this wire: the bridge strips the `@image:<path>` directive lines hermes
 *  writes into its own transcript before the text is decoded, and puts this block there instead. The
 *  field is ABSENT, not empty, on a message with no attachments, so a client below 9 is unaffected. */
export const BotChatMessageSchema = Type.Object({
  id: Type.String(),
  role: Type.String(),
  text: Type.String(),
  at: Type.Union([Type.Integer(), Type.Null()]),
  clientId: Type.Optional(Type.String()),
  attachments: Type.Optional(Type.Array(AttachmentBlockSchema)),
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

/** A LIVE DRAFT of the assistant reply a bot is composing right now, streamed off the Hermes
 *  `message.delta` events while the turn runs. Decoration, never the record: the canonical message
 *  still arrives in a `bot_chat` frame when the turn's poll finds it, and that message is the one a
 *  client stores.
 *
 *  Three properties make it safe to drop any subset of these frames:
 *  - `text` is the FULL accumulated assistant text so far, not an increment, so a client never
 *    reassembles anything and a missed frame costs nothing but a moment of staleness;
 *  - `seq` is monotonic within one `turnId`, so a frame that arrives out of order is dropped by
 *    comparing it against the last one rendered;
 *  - `turnId` is minted per turn and is never reused, so a new turn on the same session invalidates
 *    the previous draft outright (a Hermes session id IS reused across turns; the turn id is not).
 *
 *  `done` marks the last frame of a turn: no further delta for that `turnId` will be sent, and the
 *  reply itself is on its way over `bot_chat`. A client clears the draft on `done`, on a
 *  `bot_chat_state` phase of `complete`/`timeout`/`failed`, or when the canonical message lands,
 *  whichever comes first.
 *
 *  `room` is present only for a member's turn inside a group room, in which case `bot` is the member
 *  profile name and `sessionId` is that member's room session, which is not a session a client
 *  addresses anywhere else: render the draft in the room keyed on `room` + `bot`.
 *
 *  NOTHING derived from a model's chain of thought ever rides this frame. The gateway forwards the
 *  `message.*` event family and nothing else; `thinking.delta`, `reasoning.delta` and
 *  `reasoning.available` are dropped at the bridge. */
export const BotChatDeltaFrameSchema = Type.Object({
  type: Type.Literal("bot_chat_delta"),
  bot: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  /** FULL accumulated assistant text so far. Idempotent and drop-tolerant. */
  text: Type.String(),
  /** Monotonic within one `turnId`, starting at 1. */
  seq: Type.Integer(),
  updatedAt: Type.Integer(),
  done: Type.Optional(Type.Boolean()),
  /** The group room this draft belongs to, for a member turn. Absent for a 1:1 chat. */
  room: Type.Optional(Type.String()),
});
export type BotChatDeltaFrame = Static<typeof BotChatDeltaFrameSchema>;

/** A tool call inside a bot's turn is waiting on a human decision. Capability 10 (issue #19,
 *  bridge lane).
 *
 *  Why this is a bots frame and not the core `approval_pending` of contract v1.md section 5a: the
 *  bots surface is a PARALLEL path. It has no threads, no `TurnRunner`, and no `BackendAdapter`;
 *  every frame on it is keyed `bot` + `sessionId`, and a bot chat has no `threadId` to put in the
 *  core frame. So the pair is mirrored onto this channel's keying and is otherwise field for field
 *  the core pair, so one client view renders both.
 *
 *  Field provenance, all of it from the hermes `approval.request` event:
 *  - `toolCallId` is the hermes `request_id`, a uuid4 hex. It is the correlation id the pending
 *    frame, the resolve route, the resolved frame and the push collapse id all key on.
 *  - `turnId` is the GATEWAY's own turn id for the chat, the same value `bot_chat_delta` carries.
 *    The hermes event is session-scoped and names no turn, so the gateway supplies its own.
 *  - `name` is DERIVED from the hermes `pattern_key` (the rule the approval matched), never from
 *    the free-text `command`. See the derivation rule in the gateway's `approvals.ts`.
 *
 *  There is deliberately NO `argSummary` member: the hermes surface carries no structured
 *  arguments to summarize, and its free-text `command` / `description` are never forwarded into
 *  any frame, push payload, or log line. A member that does not exist cannot leak. */
export const BotApprovalPendingFrameSchema = Type.Object({
  type: Type.Literal("bot_approval_pending"),
  bot: Type.String(),
  /** The STORED canonical-chat id, the one every other bots frame uses. Never the hermes runtime
   *  session id, which is an internal no client has ever seen. */
  sessionId: Type.String(),
  turnId: Type.String(),
  toolCallId: Type.String(),
  name: Type.String(),
  updatedAt: Type.Integer(),
});
export type BotApprovalPendingFrame = Static<typeof BotApprovalPendingFrameSchema>;

/** That approval reached one of its three terminal states. Exactly one of these is ever emitted
 *  per `toolCallId`: the first terminal state wins and every later one is swallowed.
 *
 *  `expired` is SYNTHESIZED by the gateway from its own timer, because hermes emits no expiry
 *  event of any kind: it drops the queue entry silently when `approvals.timeout` (default 300 s)
 *  lapses. It is also what a resolve answered `{"resolved": 0}` maps to, since that answer means
 *  "the entry is gone" and therefore that nobody's decision took effect. */
export const BotApprovalResolvedFrameSchema = Type.Object({
  type: Type.Literal("bot_approval_resolved"),
  bot: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  toolCallId: Type.String(),
  outcome: ApprovalOutcomeSchema,
  updatedAt: Type.Integer(),
});
export type BotApprovalResolvedFrame = Static<typeof BotApprovalResolvedFrameSchema>;

/** A bot's canonical chat was RETIRED and a fresh one pinned in its place, by
 *  `POST /bots/:name/chat/reset`. Broadcast to every paired device, which is the whole point of the
 *  frame: another device sitting on the old chat has no other way to learn that the session it is
 *  appending to is no longer the bot's canonical one. On receipt a client rebinds to `sessionId`,
 *  drops whatever draft it was rendering, and reloads history for the new chat.
 *
 *  What this frame does NOT say is that anything was deleted. Hermes exposes no session delete on
 *  this surface: the retired session and its whole transcript stay on the Hermes host and keep
 *  appearing in `GET /bots/:name/sessions`. The only thing that changed is which session the bot's
 *  canonical pin points at.
 *
 *  A client that does not know this frame ignores it, per the forward-compatibility rule for unknown
 *  server frames, and then keeps writing into a session that is no longer canonical: it looks
 *  correct locally and diverges from every other device. That is exactly why the reset route rides a
 *  capability bump rather than arriving silently. */
export const BotChatResetFrameSchema = Type.Object({
  type: Type.Literal("bot_chat_reset"),
  bot: Type.String(),
  /** The freshly minted canonical chat. Every device rebinds to this id. */
  sessionId: Type.String(),
  /** The chat that was retired. Absent when there was nothing to retire. Retired, not deleted: this
   *  session is still on the Hermes host and still listed by `GET /bots/:name/sessions`. */
  previousSessionId: Type.Optional(Type.String()),
  updatedAt: Type.Integer(),
});
export type BotChatResetFrame = Static<typeof BotChatResetFrameSchema>;

/** `POST /bots/:name/chat/reset` response. `sessionId` is the STORED id of the new canonical chat,
 *  the same value a subsequent `GET /bots/:name/chat` reports, and `previousSessionId` is what the
 *  pin used to point at, absent only when the bot had no chat to retire.
 *
 *  NOTHING WAS DELETED, and a client author reading only this schema needs to know it before writing
 *  a label. Hermes exposes no session delete on this surface, so the reset is a retire-and-re-pin:
 *  the session named by `previousSessionId` and its entire transcript stay on the Hermes host and
 *  keep appearing in `GET /bots/:name/sessions` (and in the Hermes desktop's own session list). What
 *  changed is which session the bot's canonical pin points at, which buys the bot a fresh context
 *  window and the user a clean screen. A UI that promises the history is gone is promising something
 *  this gateway did not do. */
export const BotChatResetResponseSchema = Type.Object({
  name: Type.String(),
  sessionId: Type.String(),
  previousSessionId: Type.Optional(Type.String()),
});
export type BotChatResetResponse = Static<typeof BotChatResetResponseSchema>;

/** `POST /bots/:name/chat/messages` body. `clientId` is the sender's own id for this message; the
 *  gateway never interprets it, it only echoes it back on the committed message and on that same
 *  message when the turn poll finds it, so the sender can de-duplicate its optimistic row. */
export const BotChatSendRequestSchema = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 32_000 }),
  clientId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export type BotChatSendRequest = Static<typeof BotChatSendRequestSchema>;

/** The non-file parts of the `POST /bots/:name/chat/photos` multipart body (capability 9). The
 *  `file` part is not modelled here on purpose: it is bytes, and what makes it acceptable is the
 *  size cap and the magic-byte sniff the gateway runs, neither of which a JSON schema can express.
 *
 *  `text` is the CAPTION, and it is what the bot is actually prompted with. It is optional and
 *  shorter-capped than a text send: a caption rides beside an image, and the 32000-character
 *  contract on `POST /bots/:name/chat/messages` is untouched by this route. An absent or blank
 *  caption is replaced by a neutral default prompt, because hermes needs SOME prompt to spend the
 *  attached image on, and the transcript then honestly shows the words that were submitted. */
export const BotChatPhotoFieldsSchema = Type.Object({
  text: Type.Optional(Type.String({ maxLength: 4_000 })),
  clientId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export type BotChatPhotoFields = Static<typeof BotChatPhotoFieldsSchema>;

/** `POST /bots` body: the three-field quick create, plus the two look fields the roster renders.
 *  `name` is the Hermes profile name and the id of the bot everywhere else in this API; it is
 *  validated against the Hermes profile-name rule server-side (lowercase slug, reserved names
 *  refused), so the bounds here are only the cheap ones. `title`, `shape` and `color` are pure
 *  client convention: they ride the profile's `ui_meta["hermes-bots"]` blob, while `description`
 *  is the profile's own description and reaches `profiles.create` untouched. */
export const BotCreateRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.String({ maxLength: 2_000 })),
  shape: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
  /** Six-digit hex, the form the desktop's palette writes. */
  color: Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$" })),
});
export type BotCreateRequest = Static<typeof BotCreateRequestSchema>;

/** `POST /bots/focus` body. The app declares what it is looking at so the bridge polls Hermes at
 *  the desktop's cadences only while a screen is open, and idles otherwise. `null` means the app
 *  left the bots surface. */
export const BotFocusRequestSchema = Type.Object({
  screen: Type.Union([Type.Literal("roster"), Type.Literal("routines"), Type.Null()]),
});
export type BotFocusRequest = Static<typeof BotFocusRequestSchema>;

/** One installed skill on a bot's profile. Skills are a DISABLED list server-side: a skill is
 *  installed-and-enabled unless its name sits in the profile's disabled set, which is why the write
 *  path sends `disabledSkills` (the OFF names) while the read reports `enabled` per skill.
 *  `description` rides along only when the gateway carried one. */
export const BotSkillSchema = Type.Object({
  name: Type.String(),
  enabled: Type.Boolean(),
  description: Type.Optional(Type.String()),
});
export type BotSkill = Static<typeof BotSkillSchema>;

/** One toolset. Toolsets are an ENABLED list and it is a PIN: `BotProfile.toolsetsPinned` says
 *  whether the profile carries one at all, and an EMPTY `enabledToolsets` on the write path pops
 *  it rather than disabling everything. `toolCount` is how many tools the set resolves to. */
export const BotToolsetSchema = Type.Object({
  name: Type.String(),
  enabled: Type.Boolean(),
  label: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  toolCount: Type.Optional(Type.Integer()),
});
export type BotToolset = Static<typeof BotToolsetSchema>;

/** One MCP server as the edit screen sees it: the union of the servers the profile DEFINES and the
 *  bundled catalog's menu. `installed` is true for a server the profile defines, and the catalog's
 *  own flag otherwise; `fromCatalog` marks a row the profile does not define yet, which is offered
 *  so a user can turn it on (the gateway copies its definition from the launch profile on write).
 *  `auth` is passed through only when the gateway sends it. */
export const BotMcpServerSchema = Type.Object({
  name: Type.String(),
  installed: Type.Boolean(),
  enabled: Type.Boolean(),
  auth: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  transport: Type.Optional(Type.String()),
  requires: Type.Optional(Type.Array(Type.String())),
  fromCatalog: Type.Optional(Type.Boolean()),
});
export type BotMcpServer = Static<typeof BotMcpServerSchema>;

/** Which profile sections this gateway accepts, persists and shows back on a read, but which the
 *  BACKEND does not consult at runtime. A client renders those sections with an honesty note
 *  ("saved, takes effect when the gateway supports it") and gates it on this list rather than on a
 *  Hermes version string it has no reliable way to read.
 *
 *  Always present, possibly empty. The names are the PATCH body's own sections, minus the
 *  `enabled`/`disabled` prefix: `toolsets` answers for `enabledToolsets`, `mcpServers` for
 *  `enabledMcpServers`. A client that does not recognize a name shows the generic note. */
export const BotProfileRuntimeInertSchema = Type.Array(
  Type.Union([Type.Literal("toolsets"), Type.Literal("mcpServers")]),
);
export type BotProfileRuntimeInert = Static<typeof BotProfileRuntimeInertSchema>;

/** `GET /bots/:name/profile`: one bot's full edit-screen state. `model.default` is the model id and
 *  keeps the gateway's own field name; both model fields are empty strings when the profile
 *  inherits the launch profile's model rather than pinning one. */
export const BotProfileSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  soul: Type.String(),
  skills: Type.Array(BotSkillSchema),
  toolsets: Type.Array(BotToolsetSchema),
  toolsetsPinned: Type.Boolean(),
  mcpServers: Type.Array(BotMcpServerSchema),
  model: Type.Object({ provider: Type.String(), default: Type.String() }),
  runtimeInert: BotProfileRuntimeInertSchema,
});
export type BotProfile = Static<typeof BotProfileSchema>;

/** `PATCH /bots/:name/profile` body. Every field is optional and ONLY the fields present are
 *  written, which is the desktop's "send only dirty sections" rule. The inversions are the whole
 *  point of the shape and must not be guessed at:
 *  - `disabledSkills` is the OFF list (send the names to disable, not the ones to keep);
 *  - `enabledToolsets` is the ON list, and `[]` CLEARS the pin so every toolset is enabled again;
 *  - `enabledMcpServers` is the ON list, replace semantics, unknown names skipped by the gateway.
 *
 *  Every name must carry at least one non-whitespace character, which is why the item rule is a
 *  PATTERN and not just `minLength: 1`. A single space passes a length check, and the backend then
 *  filters it, leaving `enabledToolsets` EMPTY, which pops the pin and enables every toolset: the
 *  maximum-permission outcome from what looks like a typo. Refused at the boundary instead. */
const NameItem = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });

export const BotProfilePatchSchema = Type.Object({
  soul: Type.Optional(Type.String({ maxLength: 200_000 })),
  disabledSkills: Type.Optional(Type.Array(NameItem, { maxItems: 500 })),
  enabledToolsets: Type.Optional(Type.Array(NameItem, { maxItems: 500 })),
  enabledMcpServers: Type.Optional(Type.Array(NameItem, { maxItems: 500 })),
});
export type BotProfilePatch = Static<typeof BotProfilePatchSchema>;

/** The gateway's per-section `applied` map, echoed VERBATIM: its keys (`soul`, `skills`,
 *  `toolsets`, `mcp_servers`, and any section a future gateway adds) and its booleans. Deliberately
 *  open and deliberately NOT renamed to this API's field names, so a client reads exactly what the
 *  backend said and an unmodeled section still reaches it. */
export const BotProfileAppliedSchema = Type.Record(Type.String(), Type.Boolean());
export type BotProfileApplied = Static<typeof BotProfileAppliedSchema>;

/** `PATCH /bots/:name/profile` response. `outcome: "unsupported"` means the gateway answered with
 *  no `applied` map at all, which is an older backend that does not report per-section results: the
 *  write may well have landed, but nothing can confirm it, so `ok` is false and `applied` is empty.
 *  `requested` names the body fields this call carried, so a client can pair a section with the
 *  `applied` key that answers for it. */
export const BotProfileConfigureResponseSchema = Type.Object({
  name: Type.String(),
  outcome: Type.Union([Type.Literal("applied"), Type.Literal("unsupported")]),
  ok: Type.Boolean(),
  applied: BotProfileAppliedSchema,
  requested: Type.Array(Type.String()),
});
export type BotProfileConfigureResponse = Static<typeof BotProfileConfigureResponseSchema>;

/** `GET /bots/catalog`: the menus the edit screen offers, aggregated from three gateway calls.
 *  `unavailable` names the sections whose call the gateway refused (an older backend missing a
 *  method); those sections are EMPTY rather than absent, so a client never special-cases a missing
 *  field. `query` echoes the skill search this catalog was built for. */
export const BotCatalogSchema = Type.Object({
  query: Type.String(),
  skills: Type.Array(Type.Object({ name: Type.String(), description: Type.String() })),
  mcpServers: Type.Array(
    Type.Object({
      name: Type.String(),
      description: Type.String(),
      installed: Type.Boolean(),
      enabled: Type.Boolean(),
      requires: Type.Array(Type.String()),
      auth: Type.Optional(Type.String()),
      transport: Type.Optional(Type.String()),
    }),
  ),
  models: Type.Array(
    Type.Object({ slug: Type.String(), name: Type.String(), models: Type.Array(Type.String()) }),
  ),
  unavailable: Type.Array(Type.String()),
  updatedAt: Type.Integer(),
});
export type BotCatalog = Static<typeof BotCatalogSchema>;

/** One routine's schedule. `raw` is the Hermes-native schedule string EXACTLY as the backend stores
 *  it (`30m`, `every 2h`, `0 9 * * 1-5`), which is also exactly what a client sends back on a write:
 *  the schedule is never re-encoded on this wire, because the picker's frequency choice is not
 *  recoverable from the string and a round trip through a structured form would silently rewrite
 *  schedules a desktop authored.
 *
 *  `human` is the gateway's own label for the shapes it can name (`Daily`, `Every 3h`, `Once (30m)`)
 *  and is ABSENT when the string is not one of them, which is a client's signal to render `raw`
 *  verbatim rather than a label it invented. */
export const BotRoutineScheduleSchema = Type.Object({
  raw: Type.String(),
  human: Type.Optional(Type.String()),
});
export type BotRoutineSchedule = Static<typeof BotRoutineScheduleSchema>;

/** One routine (a Hermes cron job in this bot's `[bot:<name>]` namespace).
 *
 *  `id` is the backend's `job_id` and is the ONLY identifier the write routes accept; the display
 *  title is not unique and is not an id. `title` is the job name with the `[bot:<name>] ` tag
 *  stripped, and falls back to `Untitled cronjob` for a tagged job with nothing after the tag.
 *
 *  `enabled` is the ROW STATE the desktop's switch renders, which folds three backend facts into
 *  one: a job is enabled only when the backend's `enabled` is not false, its `state` is not
 *  `paused`, and it is not `legacyUnsafe`. `state` carries the backend's own word when it sent one.
 *
 *  `legacyUnsafe` marks a pre-marker delegated routine: a tagged job whose prompt begins with
 *  `You are running the scheduled routine "`. Those are auto-paused on every list (see
 *  `GET /bots/:name/routines`) and cannot be resumed through this API; a client renders the row
 *  disabled with the desktop's own wording and offers delete only. `autoPaused` is true for the one
 *  response in which this gateway actually performed that pause.
 *
 *  `lastRun` and `nextRun` are MILLISECONDS, or null when the backend sent nothing parsable (it
 *  sends ISO strings, and older builds send neither). */
export const BotRoutineSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  schedule: BotRoutineScheduleSchema,
  enabled: Type.Boolean(),
  state: Type.Optional(Type.String()),
  legacyUnsafe: Type.Boolean(),
  autoPaused: Type.Optional(Type.Boolean()),
  /** The job's prompt as the backend reported it, which on a list is often a PREVIEW rather than
   *  the whole thing. Absent when the backend sent neither. */
  prompt: Type.Optional(Type.String()),
  lastRun: Type.Union([Type.Integer(), Type.Null()]),
  nextRun: Type.Union([Type.Integer(), Type.Null()]),
  /** How the last run ended, the backend's own word (`success`, `error`, ...), when it sent one. */
  lastStatus: Type.Optional(Type.String()),
  /** The backend's run-cap DISPLAY string, not a number: `forever`, `once`, `3 times`, `1/3`. It is
   *  rendered, never parsed, and it is NOT what a write sends (a create sends an integer `repeat`),
   *  because the remaining count is not recoverable from it. */
  repeat: Type.Optional(Type.String()),
  continuity: Type.Optional(Type.Boolean()),
});
export type BotRoutine = Static<typeof BotRoutineSchema>;

/** `GET /bots/:name/routines`: every routine in that bot's namespace, and nothing else. */
export const BotRoutineListResponseSchema = Type.Object({
  name: Type.String(),
  routines: Type.Array(BotRoutineSchema),
  updatedAt: Type.Integer(),
});
export type BotRoutineListResponse = Static<typeof BotRoutineListResponseSchema>;

/** A schedule string and a routine title both reach a shell-quoted command line and a cron store,
 *  so a NUL is refused at the boundary the way the desktop refuses it, and a name must carry at
 *  least one non-whitespace character. */
const RoutineText = (max: number) =>
  Type.String({ minLength: 1, maxLength: max, pattern: "^(?![\\s\\S]*\\u0000)[\\s\\S]*\\S[\\s\\S]*$" });

/** `POST /bots/:name/routines` body. `schedule` is the RAW Hermes schedule string, composed by the
 *  client exactly as the desktop's picker composes it (`30m`, `every 1h`, `0 9 * * *`,
 *  `0 9 * * 1-5`, `0 9 * * 1`, `0 9 1 * *`, `every 2h`, or free text on Advanced). The gateway does
 *  not validate its grammar: the backend owns that, and a gateway that guessed would refuse
 *  schedules a newer Hermes accepts.
 *
 *  `prompt` is the routine's INSTRUCTION, in the user's own words. The gateway, not the client,
 *  decides how it is delivered (see `contract/ext-bots-v1.md`, routines): it may be sent bare or
 *  wrapped in the marker-prefixed delegation the desktop uses, and a client must not build that
 *  wrapper itself. */
export const BotRoutineCreateRequestSchema = Type.Object({
  title: RoutineText(200),
  schedule: RoutineText(200),
  prompt: RoutineText(32_000),
  /** Stop after N runs. Absent means forever, which is the desktop's blank field. */
  repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  /** Each run sees the previous run's output. */
  continuity: Type.Optional(Type.Boolean()),
});
export type BotRoutineCreateRequest = Static<typeof BotRoutineCreateRequestSchema>;

/** `PATCH /bots/:name/routines/:id` body. Every field is optional and only the fields present are
 *  written. `enabled` alone is the row switch (true resumes, false pauses) and keeps the routine's
 *  `id`.
 *
 *  `title`, `schedule`, `prompt`, `repeat` and `continuity` are a REWRITE, and the backend has no
 *  edit action at all: the gateway pauses the old job, creates a replacement, and removes the old
 *  one, so the routine comes back with a NEW `id`. Three consequences a client must design around,
 *  all spelled out in `contract/ext-bots-v1.md`:
 *  - `prompt` is REQUIRED whenever any of those five is present, because the backend only ever
 *    reports a 100-character preview of a stored prompt and a rewrite that guessed the rest would
 *    silently truncate the user's instruction;
 *  - everything the patch does not restate is CARRIED OVER from the routine being replaced, run cap
 *    included (it is recovered from the backend's display string, and a remaining `1/3` is carried
 *    as the 2 runs that are left), so an edit to a title cannot turn a bounded routine into a
 *    forever one;
 *  - `enabled` COMPOSES with a rewrite instead of being ignored by it: the replacement ends up in
 *    the state the patch asked for, and otherwise in the state the routine already had. */
export const BotRoutinePatchSchema = Type.Object({
  title: Type.Optional(RoutineText(200)),
  schedule: Type.Optional(RoutineText(200)),
  prompt: Type.Optional(RoutineText(32_000)),
  enabled: Type.Optional(Type.Boolean()),
  repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
  continuity: Type.Optional(Type.Boolean()),
});
export type BotRoutinePatch = Static<typeof BotRoutinePatchSchema>;

/** `POST` and `PATCH` response: the routine as it now stands.
 *
 *  `replacedId` is the id the routine had before a rewrite, so a client can retire its old row.
 *  `orphanedId` is the darker case: the replacement was created but the old job could not be
 *  removed. It is reported rather than swallowed because that job still EXISTS. It is left PAUSED,
 *  so it cannot fire and cannot double-run the routine, and it is deletable by id. */
export const BotRoutineWriteResponseSchema = Type.Object({
  name: Type.String(),
  routine: BotRoutineSchema,
  replacedId: Type.Optional(Type.String()),
  orphanedId: Type.Optional(Type.String()),
});
export type BotRoutineWriteResponse = Static<typeof BotRoutineWriteResponseSchema>;

/** One bot's routines, as a FULL REPLACE snapshot. Sent when this gateway changed them and when a
 *  `cron.changed` broadcast made the bridge re-read a bot whose routines some device is watching. */
export const BotRoutinesFrameSchema = Type.Object({
  type: Type.Literal("bot_routines"),
  bot: Type.String(),
  routines: Type.Array(BotRoutineSchema),
  updatedAt: Type.Integer(),
});
export type BotRoutinesFrame = Static<typeof BotRoutinesFrameSchema>;

/** One entry in a group room's log. `from.kind` is `user` for the human (whose display name is the
 *  desktop's own `You`) and `member` for a bot, in which case `from.name` is the bot's profile name
 *  and `from.displayName` is what a transcript renders. `at` is MILLISECONDS.
 *
 *  `seq` is the room-local ordinal and is what a client keys on: the log is TRIMMED from the head
 *  once it passes its retention cap, so a position in the array is not stable while a `seq` is. */
export const BotGroupMessageSchema = Type.Object({
  seq: Type.Integer(),
  from: Type.Object({
    kind: Type.Union([Type.Literal("user"), Type.Literal("member")]),
    name: Type.String(),
    displayName: Type.String(),
  }),
  text: Type.String(),
  at: Type.Integer(),
  clientId: Type.Optional(Type.String()),
});
export type BotGroupMessage = Static<typeof BotGroupMessageSchema>;

/** A room, without its log. `members` are Hermes profile names in the order the room was created
 *  with, and that order is what the per-round speaker rotation turns. `state` is the room's live
 *  orchestration state; `needsYou` is the sticky escalation flag (a member's reply mentioned
 *  `@user`), cleared when the user sends into the room or opens it. */
export const BotGroupSchema = Type.Object({
  name: Type.String(),
  members: Type.Array(Type.String()),
  createdAt: Type.Integer(),
  state: Type.Union([Type.Literal("running"), Type.Literal("settled"), Type.Literal("needs_you")]),
  needsYou: Type.Boolean(),
  /** Bumped on every user send. A round loop that finds the epoch changed abandons the rest of its
   *  rounds, which is how a second user message supersedes the first mid-deliberation. */
  epoch: Type.Integer(),
  /** Stamp of the newest log entry, or the room's creation when the log is empty. */
  updatedAt: Type.Integer(),
});
export type BotGroup = Static<typeof BotGroupSchema>;

/** `GET /bots/groups/:name`: the room plus its log. */
export const BotGroupDetailSchema = Type.Composite([
  BotGroupSchema,
  Type.Object({ messages: Type.Array(BotGroupMessageSchema) }),
]);
export type BotGroupDetail = Static<typeof BotGroupDetailSchema>;

/** New room messages. A DELTA, like `bot_chat`: only entries the gateway has not broadcast before,
 *  in `seq` order. */
export const BotGroupFrameSchema = Type.Object({
  type: Type.Literal("bot_group"),
  group: Type.String(),
  messages: Type.Array(BotGroupMessageSchema),
  updatedAt: Type.Integer(),
});
export type BotGroupFrame = Static<typeof BotGroupFrameSchema>;

/** A member turn that produced no message for a reason worth showing. NEVER a fabricated room
 *  message: a member whose turn timed out or failed contributes this note and the round carries on
 *  with the others. `detail` is Hermes' own text verbatim when the failure came from Hermes.
 *
 *  A member that simply chose to pass produces no note at all: passing is ordinary, and the desktop
 *  protocol treats it as the healthy outcome rather than as an incident.
 *
 *  `capped` is the third reason and the only one that is not a failure: the room stopped because it
 *  reached its 10-message limit for this send, and `member` names the member that was next in line
 *  and never got asked. Without it a capped room is indistinguishable from one where everybody
 *  passed, and those mean opposite things to a reader deciding whether to send again. */
export const BotGroupNoteSchema = Type.Object({
  member: Type.String(),
  reason: Type.Union([Type.Literal("timeout"), Type.Literal("failed"), Type.Literal("capped")]),
  detail: Type.String(),
});
export type BotGroupNote = Static<typeof BotGroupNoteSchema>;

/** How a room's deliberation is doing. `running` while a round loop holds the room, `settled` when
 *  every responder passed or a cap was reached, `needs_you` when the loop settled AND some member's
 *  reply mentioned `@user`. `round` is the zero-based round the loop is on. */
export const BotGroupStateFrameSchema = Type.Object({
  type: Type.Literal("bot_group_state"),
  group: Type.String(),
  state: Type.Union([Type.Literal("running"), Type.Literal("settled"), Type.Literal("needs_you")]),
  round: Type.Integer(),
  epoch: Type.Integer(),
  note: Type.Optional(BotGroupNoteSchema),
  updatedAt: Type.Integer(),
});
export type BotGroupStateFrame = Static<typeof BotGroupStateFrameSchema>;

/** `POST /bots/groups` body. Membership is 2 to 6 bots, the desktop's own bounds, and every name is
 *  validated against the roster before the room exists. */
export const BotGroupCreateRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  members: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 2, maxItems: 6 }),
});
export type BotGroupCreateRequest = Static<typeof BotGroupCreateRequestSchema>;

/** `POST /bots/groups/:name/messages` body. Same `clientId` echo contract as the 1:1 composer. */
export const BotGroupSendRequestSchema = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 32_000 }),
  clientId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export type BotGroupSendRequest = Static<typeof BotGroupSendRequestSchema>;

/** Capability id and version advertised in `GatewayInfo.capabilities` when the bots bridge is
 *  configured.
 *
 *  Version history, additive throughout (a client compares `>=`, never `===`):
 *  - `1`: roster, presence, canonical-chat resolve, session list, history read.
 *  - `2`: `POST /bots/:name/chat/messages` plus the `bot_chat` and `bot_chat_state` frames. A
 *    client that offers a composer MUST require `>= 2`: a v1 gateway 404s that route and never
 *    sends those frames, which without this bump reads as a silently dead composer.
 *  - `3`: the edit-profile surface: `GET`/`PATCH /bots/:name/profile` and `GET /bots/catalog`. A
 *    client that offers an edit screen MUST require `>= 3`, by the same rule the composer bump
 *    used: a screen whose Save 404s reads as a broken app, not as a missing feature.
 *  - `4`: the routines surface: `GET`/`POST /bots/:name/routines`,
 *    `PATCH`/`DELETE /bots/:name/routines/:id`, plus the `bot_routines` frame. A client that offers
 *    a routines pane MUST require `>= 4`.
 *  - `5`: server-side group chats: the `/bots/groups` routes plus the `bot_group` and
 *    `bot_group_state` frames. A client that offers a rooms screen MUST require `>= 5`.
 *  - `6`: the `bot_chat_delta` frame, the live draft of a reply as it is written. No route changes
 *    ride this bump: it exists so a client can tell "this gateway will stream" from "this gateway
 *    is quiet right now", since a bot that never streams and a gateway that cannot stream look
 *    identical otherwise. Everything works unchanged without it; the draft is decoration and the
 *    `bot_chat` frame remains the record.
 *  - `7`: `GET /bots/:name/media`, the image proxy. A client that renders the image references in a
 *    bot's reply as pictures MUST require `>= 7`: a v6 gateway 404s the route, so an app that
 *    reached for it anyway would replace working links with broken-image chips. Below 7 a client
 *    keeps whatever it did before, which is to show the link. The route serves `https` sources only;
 *    a LOCAL path on the Hermes box is refused, and the refusal is part of the contract so the app
 *    can say so rather than spin.
 *  - `8`: `POST /bots/:name/chat/reset` plus the `bot_chat_reset` frame. A client that offers a
 *    "clear chat" action MUST require `>= 8`: a version 7 gateway 404s the route. Note what it is
 *    NOT: hermes exposes no session delete here, so the retired chat is still on the hermes host and
 *    still appears in `GET /bots/:name/sessions`; what is cleared is which session the bot's
 *    canonical chat points at.
 *  - `9`: photos to bots. `POST /bots/:name/chat/photos` sends one image with an optional caption,
 *    `GET /bots/:name/chat/attachments/:fileId` serves the gateway's own copy of it back, and
 *    `BotChatMessage.attachments` carries the `attachment` block that ties the two together. A
 *    client that offers a photo picker MUST require `>= 9`: a version 8 gateway 404s both routes.
 *    A client below 9 keeps working unchanged, because `attachments` is an optional field it can
 *    ignore and no existing route or frame changed shape. What a client CANNOT infer from the
 *    version is whether the bot on the other end can see pixels: that is decided per turn inside
 *    hermes by the bot's own model, and a text-only model quietly gets a description instead.
 *  - `10`: mobile approve/deny for bot chats (issue #19, bridge lane). The
 *    `bot_approval_pending` / `bot_approval_resolved` frames plus
 *    `POST /bots/:name/approvals/:toolCallId/approve` and `.../deny`. A client that offers an
 *    approve/deny UI MUST require `>= 10`: a version 9 gateway 404s both routes and never sends
 *    either frame, so the buttons would do nothing. A client below 10 keeps working unchanged --
 *    it simply never learns that a bot is blocked on a decision, which is exactly where it was
 *    before. What the version does NOT promise is that any approval will ever be raised: that
 *    depends on the hermes profile running with `approvals.mode: manual` and without
 *    `security.approval.transport`, both of which are deployment facts the wire cannot assert
 *    (see contract/ext-bots-v1.md, "Deployment: what a bridged profile must pin").
 *  - `11`: fresh bot chats are BORN EMPTY, and the canned opener becomes a client-side SUGGESTION
 *    (issue #59). The one entry in this list that changes existing BEHAVIOUR rather than only adding
 *    surface, so it is a behaviour note before it is a field:
 *    - up to 10, opening a bot with no chat (and, from 8, resetting one) created the session and
 *      SUBMITTED a canned opener into it, which the app then rendered as a message the USER had sent
 *      and which the bot answered before the user had typed anything. Neither path does that any
 *      more. The gateway submits what the user submits, and nothing else.
 *    - `GET /bots/:name/chat/messages` gains an optional `suggestion` string, present ONLY when
 *      `messages` is empty and the deployment configured an opener, and absent otherwise. It is
 *      presentation-only: a client MAY show it, and MAY let the user send it AS THEIR OWN message
 *      through the ordinary composer, and until they do it is in no transcript anywhere.
 *    A client below 11 keeps working and keeps ignoring an optional field it never heard of, but it
 *    will see something new from an 11 gateway: a freshly opened bot chat is genuinely empty where it
 *    used to hold an exchange. That is the same empty payload a version 10 gateway already answered
 *    with while a chat was being created, so nothing breaks; the chat simply no longer fills itself
 *    in. A client that offers a suggestion chip MUST require `>= 11`, because a version 10 gateway
 *    never sends the field. */
export const BOTS_CAPABILITY_ID = "com.cozylabs.bots";
export const BOTS_CAPABILITY_VERSION = 11;

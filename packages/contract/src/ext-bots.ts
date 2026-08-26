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
 *  Profile, catalog, routine, and inbox resources mirror Hermes control-plane data. Configured
 *  Bot Mode chats, their sessions, messages, attachments, and turn state are gateway-owned
 *  attach-v1 projections. Every timestamp on this wire is milliseconds. */
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

/** The minimum needed to create a Hermes profile, plus what the creating user chose to hand it on
 * day one. Its soul and model still come from Hermes and the profile routes afterwards.
 *
 * `toolsets` and `mcpServers` are ADDITIVE and OPTIONAL (capability 33). A gateway that seeds
 * blank-slate bots starts a bot on the `file` + `terminal` floor; these two fields name what to
 * grant ON TOP of it at creation, so a power user does not have to earn back the tools they
 * already know they want. Both are advisory lists, not assertions: a name the backend does not
 * report is SKIPPED and named back in `BotCreateResponse.warnings`, never invented and never a
 * reason to fail the create. An empty array is the same as omitting the field.
 *
 * The fields are additive on the wire too. `BotCreateRequestSchema` is not
 * `additionalProperties: false`, so a gateway below 33 accepts a request carrying them and
 * silently ignores them; the bot is still created, just without the selection. A client that must
 * not silently drop the user's picks gates its picker on `com.cozylabs.bots >= 33`. */
export const BotCreateRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  description: Type.Optional(Type.String({ maxLength: 2_000 })),
  toolsets: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 64 })),
  mcpServers: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 64 })),
});
export type BotCreateRequest = Static<typeof BotCreateRequestSchema>;

/** The `POST /bots` reply. `warnings` is present only when there is something to say, and its
 * lines are display-safe operator English about the create that just SUCCEEDED: a selected name
 * that was skipped, or a seed that could not be written. It is never an error channel; a failed
 * create answers `ErrorBody` with a status instead. A client below 33 ignores the field. */
export const BotCreateResponseSchema = Type.Object({
  bot: BotSummarySchema,
  warnings: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { maxItems: 16 })),
});
export type BotCreateResponse = Static<typeof BotCreateResponseSchema>;

/** Gateway-owned attach-v1 Bot Mode sessions are conversations. */
export const BotSessionKindSchema = Type.Literal("conversation");
export type BotSessionKind = Static<typeof BotSessionKindSchema>;

export const BotSessionSummarySchema = Type.Object({
  id: Type.String(),
  startedAt: Type.Integer(),
  lastActiveAt: Type.Integer(),
  kind: BotSessionKindSchema,
  title: Type.Optional(Type.String()),
  preview: Type.Optional(Type.String()),
});
export type BotSessionSummary = Static<typeof BotSessionSummarySchema>;

export const BotSessionsResponseSchema = Type.Object({
  sessions: Type.Array(BotSessionSummarySchema),
  activeSessionId: Type.Union([Type.String(), Type.Null()]),
});
export type BotSessionsResponse = Static<typeof BotSessionsResponseSchema>;

export const BotSessionAdoptResponseSchema = Type.Object({
  name: Type.String(),
  sessionId: Type.String(),
  previousSessionId: Type.String(),
});
export type BotSessionAdoptResponse = Static<typeof BotSessionAdoptResponseSchema>;

/** Capability 19 `POST /bots/:name/sessions/new` response. The new gateway-owned session is
 *  selected while the previous native transcript remains in local history and restorable through
 *  the capability-16 adoption route. */
export const BotNewSessionResponseSchema = Type.Object({
  name: Type.String(),
  sessionId: Type.String(),
  previousSessionId: Type.String(),
});
export type BotNewSessionResponse = Static<typeof BotNewSessionResponseSchema>;

/** One bot-to-bot session surfaced in the agent inbox (capability 17). `peers` names the
 *  counterpart agents visible in the a2a delivery prefix; the bot addressed by the route is not
 *  repeated there. */
export const BotInboxThreadSchema = Type.Object({
  id: Type.String(),
  peers: Type.Array(Type.String()),
  startedAt: Type.Integer(),
  lastActiveAt: Type.Integer(),
  preview: Type.String(),
  messageCount: Type.Integer({ minimum: 0 }),
});
export type BotInboxThread = Static<typeof BotInboxThreadSchema>;

export const BotInboxResponseSchema = Type.Object({
  threads: Type.Array(BotInboxThreadSchema),
});
export type BotInboxResponse = Static<typeof BotInboxResponseSchema>;

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

/** One durable message in a gateway-owned attach-v1 Bot Mode transcript. `id` is a stable gateway
 *  or attach event id and `at` is the gateway clock in milliseconds. `role` is `user` or
 *  `assistant`; tool activity is carried separately and model reasoning never enters this shape.
 *
 *  `clientId` echoes an optional sender id so an optimistic row can be replaced. `attachments`
 *  holds immutable gateway-scoped blocks for sent or received media. Their `fileId` is opaque and
 *  resolves only through `GET /bots/:name/chat/attachments/:fileId`; it is never a URL or path. */
/** One attachment on a durable message: the gateway-owned block, plus WHERE in the message it
 *  renders (capability 32).
 *
 *  `position` is the index in this message's normalized block array BEFORE which the attachment
 *  renders: `0` puts it above everything, `blocks.length` puts it below everything, and any value
 *  in between puts it between those two blocks. It exists so an image written under its heading
 *  renders under that heading instead of on a stack above the whole reply.
 *
 *  Absent `position` is the legacy shape and means above-stack, which is what every message
 *  written before 32 carries and what any sender that cannot say where an attachment belongs keeps
 *  sending. A reader MUST clamp an out-of-range value into `0...blocks.length` rather than dropping
 *  the attachment: a sender that counts blocks differently degrades to a picture in a slightly
 *  wrong place, never to a lost picture. A message MAY mix the two: positioned attachments render
 *  in flow, unpositioned ones render above, and both are correct. */
export const BotChatAttachmentSchema = Type.Composite([
  AttachmentBlockSchema,
  Type.Object({ position: Type.Optional(Type.Integer({ minimum: 0, maximum: 4096 })) }),
]);
export type BotChatAttachment = Static<typeof BotChatAttachmentSchema>;

export const BotChatMessageSchema = Type.Object({
  id: Type.String(),
  role: Type.String(),
  text: Type.String(),
  at: Type.Union([Type.Integer(), Type.Null()]),
  clientId: Type.Optional(Type.String()),
  attachments: Type.Optional(Type.Array(BotChatAttachmentSchema)),
  /** Capability 31. Present only on gateway-authored rows that are not conversation: a client MAY
   *  render a marked row as a status chip rather than a bubble, and a client that does not know the
   *  marker renders the ordinary row it already renders. The only v1 value is `delivery.failed`,
   *  which the gateway writes with role `system` when a scheduled delivery terminally fails. */
  marker: Type.Optional(Type.String({ maxLength: 64 })),
});
export type BotChatMessage = Static<typeof BotChatMessageSchema>;

/** Capability 19 hard-stop response. The cross-device terminal signal remains the existing
 *  `bot_chat_state` frame with `phase: "complete"`. */
export const BotChatStopResponseSchema = Type.Object({
  status: Type.Literal("stopped"),
});
export type BotChatStopResponse = Static<typeof BotChatStopResponseSchema>;

/** New messages in a bot's native canonical chat. A DELTA, not a snapshot: `messages` carries only
 *  newly committed durable rows, in order.
 *
 *  A settled assistant row in the canonical conversational session also raises the existing
 *  encrypted `message` push for registered devices without a live socket. This changes no frame or
 *  capability: drafts, user echoes, and tool activity stay in-band. */
export const BotChatFrameSchema = Type.Object({
  type: Type.Literal("bot_chat"),
  bot: Type.String(),
  sessionId: Type.String(),
  messages: Type.Array(BotChatMessageSchema),
  updatedAt: Type.Integer(),
});
export type BotChatFrame = Static<typeof BotChatFrameSchema>;

/** Capability 23's exact app-facing native-turn status. `queued` means the command is durably in
 * the attach outbox; `connectivity_lost` keeps that same durable command for replay. */
export const BotChatStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("executing"),
  Type.Literal("using_tools"),
  Type.Literal("awaiting_input"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("interrupted"),
  Type.Literal("timed_out"),
  Type.Literal("connectivity_lost"),
]);
export type BotChatStatus = Static<typeof BotChatStatusSchema>;

export const BotChatStateCauseSchema = Type.Union([
  Type.Literal("attach_absent"),
  Type.Literal("attach_degraded"),
  Type.Literal("attach_lost"),
  Type.Literal("cancelled"),
]);
export type BotChatStateCause = Static<typeof BotChatStateCauseSchema>;

/** How a bot's native canonical chat is doing right now. `phase`, `running`, and `inflight` are the
 * gateway's durable attach-v1 turn projection, not Dashboard session flags. `status`, `cause`, and
 * `queuedAt` are capability-23 additions; clients below 23 retain the legacy phase behavior. */
export const BotChatStateFrameSchema = Type.Object({
  type: Type.Literal("bot_chat_state"),
  bot: Type.String(),
  sessionId: Type.String(),
  /** `polling` = an attach-v1 turn is active; `complete` = its reply committed or capability 19
   *  interrupted it; `timeout` = the gateway cap expired; `failed` = attach-v1 reported failure. */
  phase: Type.Union([
    Type.Literal("polling"),
    Type.Literal("complete"),
    Type.Literal("timeout"),
    Type.Literal("failed"),
  ]),
  running: Type.Boolean(),
  inflight: Type.Boolean(),
  status: Type.Optional(BotChatStatusSchema),
  cause: Type.Optional(BotChatStateCauseSchema),
  /** Gateway-clock time when an offline command entered the durable outbox. The existing gateway
   * turn-timeout bound applies from this instant, then the command is discarded or interrupted. */
  queuedAt: Type.Optional(Type.Integer()),
  updatedAt: Type.Integer(),
});
export type BotChatStateFrame = Static<typeof BotChatStateFrameSchema>;

/** A LIVE DRAFT of the assistant reply a bot is composing right now, streamed from attach-v1 while
 *  the turn runs. Decoration, never the record: committed native transcript rows arrive in
 *  `bot_chat` and are what a client stores.
 *
 *  Three properties make it safe to drop any subset of these frames:
 *  - `text` is the FULL accumulated assistant text so far, not an increment, so a client never
 *    reassembles anything and a missed frame costs nothing but a moment of staleness;
 *  - `seq` is monotonic within one `turnId`, so a frame that arrives out of order is dropped by
 *    comparing it against the last one rendered;
 *  - `turnId` is gateway-minted per turn and is never reused, so a new turn on the same native
 *    session invalidates the previous draft outright.
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
 *  NOTHING derived from a model's chain of thought ever rides this frame. Attach-v1 does not define
 *  a reasoning event, and the gateway projects only its display-safe draft blocks. */
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

/** A tool call inside an attach-v1 bot turn is waiting on a human decision. Capability 10.
 *
 *  Why this is a bots frame and not the core `approval_pending` of contract v1.md section 5a: the
 *  bots surface is a PARALLEL path. It has no threads, no `TurnRunner`, and no `BackendAdapter`;
 *  every frame on it is keyed `bot` + `sessionId`, and a bot chat has no `threadId` to put in the
 *  core frame. So the pair is mirrored onto this channel's keying and is otherwise field for field
 *  the core pair, so one client view renders both.
 *
 *  `toolCallId` is the attach-v1 approval id; `turnId` is the gateway's native turn id; and `name`
 *  is the bounded display-safe tool name supplied by the plugin. There is deliberately no argument
 *  or command summary: a member that does not exist cannot leak. */
/** One tool step inside a bot's turn: capability 12, the live activity a client renders as chips
 *  while the turn runs.
 *
 *  Field for field this is the core `ToolCall` of `contract/v1.md` ("ToolCall") with the two members
 *  this channel's frames always carry added, and its one free-text member removed:
 *  - `id` -> `stepId`, `name` and `status` are the core three, and `status` uses the CORE
 *    vocabulary `running`/`ok`/`error` rather than any new one, so a client that already renders
 *    threads chips renders these with the same switch.
 *  - `seq` and the timestamps are added because a bots frame is a snapshot with an ordering, not an
 *    implicitly ordered array on a draft (see `BotToolActivityFrame`).
 *  - capability 21 adds optional bounded, redacted `detail` and error-only `errorText`. Attach-v1
 *    sends display-safe detail only; raw args/results, context, inline diffs, and todos are never
 *    forwarded.
 *
 *  `name` is the plugin tool identifier, passed through and length-capped. It names a tool rather
 *  than anything the tool was asked to do. */
export const BotToolStepSchema = Type.Object({
  /** Stable for the life of the step and unique within its `turnId`: the attach-v1 `callId` that
   *  joins its running and terminal events. */
  stepId: Type.String(),
  /** Position within the turn, from 1, assigned when the gateway FIRST sees the step. It is the
   *  order the steps started in, and it never moves once assigned. */
  seq: Type.Integer(),
  name: Type.String(),
  /** `running` until the step ends. `ok` and `error` are TERMINAL: a step never leaves them.
   *
   *  `error` means the plugin reported that the step did not finish cleanly. Nothing about WHY is
   *  reported beyond optional bounded `errorText`. */
  status: Type.Union([Type.Literal("running"), Type.Literal("ok"), Type.Literal("error")]),
  /** MILLISECONDS, gateway clock. When the gateway first saw the step. */
  startedAt: Type.Integer(),
  /** MILLISECONDS. Absent while `running`, present on every terminal step. */
  endedAt: Type.Optional(Type.Integer()),
  /** Bounded, redacted human-readable activity. Capability 21. */
  detail: Type.Optional(Type.String()),
  /** Bounded, redacted failure text; present only for an error step. Capability 21. */
  errorText: Type.Optional(Type.String()),
});
export type BotToolStep = Static<typeof BotToolStepSchema>;

/** What a bot's turn is DOING right now, as a full-replace snapshot of that turn's tool steps.
 *  Capability 12 (issue #60).
 *
 *  Snapshot, not a delta, for the same reason `bot_chat_delta` carries the full accumulated text:
 *  it makes every frame independently sufficient and any subset of them droppable. A client renders
 *  the newest frame it has for a `turnId` and needs no reassembly, and "what happened this turn" is
 *  read off one frame rather than folded from a stream.
 *
 *  - `steps` is EVERY step of the turn so far, in `seq` order, each carrying its own current status.
 *    A step that has ended stays in the array with a terminal status; it is not removed.
 *  - `seq` on the FRAME is monotonic within one `turnId`, from 1, so a frame that arrives out of
 *    order is dropped by comparing it against the last one rendered. (The `seq` on a STEP is a
 *    different number: the step's position in the turn.)
 *  - `turnId` is the gateway's own turn id, the same value `bot_chat_delta` and
 *    `bot_approval_pending` carry for that chat, so all three frames agree about which turn a client
 *    is looking at.
 *  - `done` marks the last frame of a turn: every step in it is terminal and no further frame will
 *    be sent for that `turnId`.
 *
 *  `room` is present only for a member's turn inside a group room, exactly as on `bot_chat_delta`.
 *
 *  NOT PUSHED. Ever. Tool activity is a foreground surface: it is worth showing to someone watching
 *  a turn run and is worth nothing to a phone in a pocket, where it would be a stream of
 *  notifications for something nobody was asked to decide. `contract/push-v0.md` keeps its three
 *  payload kinds -- `message`, `approval_pending`, `approval_resolved` -- and this capability adds
 *  none. */
export const BotToolActivityFrameSchema = Type.Object({
  type: Type.Literal("bot_tool_activity"),
  bot: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  steps: Type.Array(BotToolStepSchema),
  /** Monotonic within one `turnId`, starting at 1. */
  seq: Type.Integer(),
  updatedAt: Type.Integer(),
  done: Type.Optional(Type.Boolean()),
  /** The group room this turn belongs to, for a member turn. Absent for a 1:1 chat. */
  room: Type.Optional(Type.String()),
});
export type BotToolActivityFrame = Static<typeof BotToolActivityFrameSchema>;

/** One past native turn's tool steps, persisted by the gateway so history survives reconnect and
 *  restart. Steps belong to a turn rather than a message: attach-v1 intentionally supplies no
 *  message-to-turn join, so the gateway does not invent one. Clients can order a strip by its
 *  gateway-clock `startedAt`/`endedAt` timestamps or key it to a live `turnId`. */
export const BotTurnToolStepsSchema = Type.Object({
  turnId: Type.String(),
  /** MILLISECONDS: when the turn's FIRST step started. The chronological join to the transcript. */
  startedAt: Type.Integer(),
  /** MILLISECONDS: when the turn's LAST step ended. Absent while any step is still `running`, which
   *  after a restart means a turn whose end this gateway never saw. */
  endedAt: Type.Optional(Type.Integer()),
  steps: Type.Array(BotToolStepSchema),
});
export type BotTurnToolSteps = Static<typeof BotTurnToolStepsSchema>;

/** Closed status vocabulary for one delegated child. Capability 34 (subagent visibility).
 *  `queued|starting|running|stalling` are live; the rest are settled. `unknown` is the honest
 *  settle for work whose outcome cannot be proven (a restart with the child in flight) and is
 *  never rendered as failure. `stalling`/`stalled` mark long-quiet work; clients may also derive
 *  quietness from `lastActiveAt` ("quiet for 2m", not failed). */
export const BotDelegationChildStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("starting"), Type.Literal("running"),
  Type.Literal("stalling"), Type.Literal("succeeded"), Type.Literal("failed"),
  Type.Literal("interrupted"), Type.Literal("stalled"), Type.Literal("unknown"),
]);
export type BotDelegationChildStatus = Static<typeof BotDelegationChildStatusSchema>;

/** One delegated child of a native turn's `delegate_task` batch. Capability 34.
 *
 *  Identity is (batchId, childId) -- `childId` is the Hermes child session id, the one
 *  identifier present on both the spawn and finish legs of the lifecycle, so it is the upsert
 *  key exactly as `stepId` keys a tool step; tool names are display metadata only and can never
 *  collide. Only bounded display text crosses this wire: a truncated task label and a tool
 *  NAME -- never args, results, reasoning, prompts, local paths, or child summaries. */
export const BotDelegationChildSchema = Type.Object({
  childId: Type.String(),
  /** Position within the batch, from 0, pinned when the gateway FIRST sees the child. */
  index: Type.Integer(),
  label: Type.Optional(Type.String()),
  status: BotDelegationChildStatusSchema,
  /** Tool NAME only. */
  currentTool: Type.Optional(Type.String()),
  apiCalls: Type.Optional(Type.Integer()),
  toolCount: Type.Optional(Type.Integer()),
  /** MILLISECONDS, plugin clock. When the child last showed observable activity. */
  lastActiveAt: Type.Integer(),
  /** MILLISECONDS, gateway clock. When the gateway first saw the child. */
  startedAt: Type.Integer(),
  /** MILLISECONDS. Absent while the child is live. */
  endedAt: Type.Optional(Type.Integer()),
});
export type BotDelegationChild = Static<typeof BotDelegationChildSchema>;

/** What one turn's `delegate_task` batch is doing, as a full-replace snapshot. Capability 34.
 *  Same wire discipline as `bot_tool_activity`: every frame is independently sufficient, frame
 *  `seq` is monotonic within one (turnId, batchId), `done` marks the batch fully settled, and
 *  the frame is NOT pushed, ever. `batchId` also keys the client's reconciliation of the live
 *  card with Hermes's synthetic "[ASYNC DELEGATION BATCH COMPLETE ...]" transcript row. A batch
 *  may outlive its turn (async dispatch): frames legitimately arrive after the turn sealed. */
export const BotDelegationActivityFrameSchema = Type.Object({
  type: Type.Literal("bot_delegation_activity"),
  bot: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  batchId: Type.String(),
  /** Canonical Hermes delegation id (`deleg_...`) for this batch, when known. `batchId` stays
   *  the identity; a client whose exact-`batchId` reconciliation with Hermes's synthetic
   *  "[ASYNC DELEGATION BATCH COMPLETE - <deleg_id>]" transcript row fails falls back to
   *  matching that row's id against `aliasId`. Additive under capability 34. */
  aliasId: Type.Optional(Type.String()),
  /** Children known to the batch so far; grows monotonically. */
  count: Type.Integer(),
  children: Type.Array(BotDelegationChildSchema),
  /** Monotonic within one (turnId, batchId), starting at 1. */
  seq: Type.Integer(),
  updatedAt: Type.Integer(),
  done: Type.Optional(Type.Boolean()),
});
export type BotDelegationActivityFrame = Static<typeof BotDelegationActivityFrameSchema>;

/** One past turn's delegation batch, persisted like `BotTurnToolSteps` and for the same
 *  reason: a batch belongs to a TURN, and `startedAt` is the honest chronological join. */
export const BotTurnDelegationsSchema = Type.Object({
  turnId: Type.String(),
  batchId: Type.String(),
  /** Canonical Hermes delegation id (`deleg_...`) for this batch, when known. See
   *  `BotDelegationActivityFrameSchema.aliasId`. */
  aliasId: Type.Optional(Type.String()),
  count: Type.Integer(),
  startedAt: Type.Integer(),
  endedAt: Type.Optional(Type.Integer()),
  children: Type.Array(BotDelegationChildSchema),
});
export type BotTurnDelegations = Static<typeof BotTurnDelegationsSchema>;

/** A short rolling preview of the bot's live reasoning for one native turn. Capability 35.
 *
 *  LATEST-ONLY full replace: `text` is the WHOLE preview, tail-truncated to 280 chars, so every
 *  frame is independently sufficient and any subset is droppable. `seq` is monotonic within one
 *  `turnId`; a frame whose `seq` is not greater than the last one rendered is stale and dropped.
 *
 *  EPHEMERAL BY DESIGN: never persisted, never in chat history, gone on reopen. The turn's
 *  terminal is the hard stop -- no frame follows it. Privacy bounds are enforced on BOTH sides:
 *  the plugin sanitizes (no tool args or results, no prompts, no credentials, no file paths)
 *  and the schema caps length, so an unsanitized peer still cannot exceed the preview budget.
 *  NOT PUSHED, ever, for the same reason tool activity is not. */
export const BotThinkingActivityFrameSchema = Type.Object({
  type: Type.Literal("bot_thinking_activity"),
  bot: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  /** Sanitized rolling tail, at most 280 chars. */
  text: Type.String({ maxLength: 280 }),
  /** Monotonic within one `turnId`, starting at 1. */
  seq: Type.Integer({ minimum: 1 }),
  updatedAt: Type.Integer(),
});
export type BotThinkingActivityFrame = Static<typeof BotThinkingActivityFrameSchema>;

export const BotApprovalPendingFrameSchema = Type.Object({
  type: Type.Literal("bot_approval_pending"),
  bot: Type.String(),
  /** The gateway-owned canonical-chat id used by every Bot Mode frame. */
  sessionId: Type.String(),
  turnId: Type.String(),
  toolCallId: Type.String(),
  name: Type.String(),
  updatedAt: Type.Integer(),
  /** Present for an approval raised by a member turn inside a group room. */
  room: Type.Optional(Type.String()),
});
export type BotApprovalPendingFrame = Static<typeof BotApprovalPendingFrameSchema>;

/** A paired device submitted a decision, which is durably queued for Hermes but NOT yet
 * confirmed. The terminal frame remains the only proof that Hermes handled it. */
export const BotApprovalResolutionRequestedFrameSchema = Type.Object({
  type: Type.Literal("bot_approval_resolution_requested"),
  bot: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  toolCallId: Type.String(),
  updatedAt: Type.Integer(),
});
export type BotApprovalResolutionRequestedFrame = Static<typeof BotApprovalResolutionRequestedFrameSchema>;

/** A native approval reached a terminal state. The gateway emits at most one terminal frame per
 *  `toolCallId`; an expiry is driven by the durable attach-v1 interaction record. */
export const BotApprovalResolvedFrameSchema = Type.Object({
  type: Type.Literal("bot_approval_resolved"),
  bot: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  toolCallId: Type.String(),
  outcome: ApprovalOutcomeSchema,
  updatedAt: Type.Integer(),
  room: Type.Optional(Type.String()),
});
export type BotApprovalResolvedFrame = Static<typeof BotApprovalResolvedFrameSchema>;

/** Capability 22: a native bot paused its turn to ask the user to choose one bounded option. The
 * stable clarifyId is the REST resolution key and options are identifiers plus display labels;
 * arbitrary model reasoning is never present. */
export const BotClarifyOptionSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
});
export type BotClarifyOption = Static<typeof BotClarifyOptionSchema>;
export const BotClarifyResolveRequestSchema = Type.Object({ optionId: Type.String({ minLength: 1 }) });
export type BotClarifyResolveRequest = Static<typeof BotClarifyResolveRequestSchema>;

export const BotClarifyPendingFrameSchema = Type.Object({
  type: Type.Literal("bot_clarify_pending"),
  bot: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  clarifyId: Type.String(),
  prompt: Type.String(),
  options: Type.Array(BotClarifyOptionSchema),
  expiresAt: Type.Optional(Type.Integer()),
  updatedAt: Type.Integer(),
});
export type BotClarifyPendingFrame = Static<typeof BotClarifyPendingFrameSchema>;

/** The option selection is durably queued for Hermes but has not yet been accepted by the
 * blocking clarification primitive. No selected option leaks to other paired devices here. */
export const BotClarifyResolutionRequestedFrameSchema = Type.Object({
  type: Type.Literal("bot_clarify_resolution_requested"),
  bot: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  clarifyId: Type.String(),
  updatedAt: Type.Integer(),
});
export type BotClarifyResolutionRequestedFrame = Static<typeof BotClarifyResolutionRequestedFrameSchema>;

export const BotClarifyResolvedFrameSchema = Type.Object({
  type: Type.Literal("bot_clarify_resolved"),
  bot: Type.String(),
  sessionId: Type.String(),
  turnId: Type.String(),
  clarifyId: Type.String(),
  outcome: Type.Union([Type.Literal("selected"), Type.Literal("expired"), Type.Literal("cancelled")]),
  selectedOptionId: Type.Optional(Type.String()),
  updatedAt: Type.Integer(),
});
export type BotClarifyResolvedFrame = Static<typeof BotClarifyResolvedFrameSchema>;

/** `POST /bots/:name/chat/reset` selected a fresh gateway-owned session. Rebind to `sessionId`,
 *  drop any draft, and reload. The previous local transcript is retained; the reset frame is the
 *  cross-device signal that the selected chat changed. */
export const BotChatResetFrameSchema = Type.Object({
  type: Type.Literal("bot_chat_reset"),
  bot: Type.String(),
  /** The freshly minted canonical chat. Every device rebinds to this id. */
  sessionId: Type.String(),
  /** The previously selected local session. It remains in `GET /bots/:name/sessions`. */
  previousSessionId: Type.Optional(Type.String()),
  updatedAt: Type.Integer(),
});
export type BotChatResetFrame = Static<typeof BotChatResetFrameSchema>;

/** A user selected an existing native session or started a new one. Every paired client rebinds to
 *  `sessionId` and re-reads history. Both the old and new session ids are gateway-owned; the old
 *  transcript remains available for a later manual adoption. */
export const BotChatAdoptedFrameSchema = Type.Object({
  type: Type.Literal("bot_chat_adopted"),
  bot: Type.String(),
  /** The session the canonical chat now points at. Every device rebinds to this id. */
  sessionId: Type.String(),
  /** The session the pin resolved to when this adoption began. Always present. */
  previousSessionId: Type.String(),
  updatedAt: Type.Integer(),
});
export type BotChatAdoptedFrame = Static<typeof BotChatAdoptedFrameSchema>;

/** `POST /bots/:name/chat/reset` response. `sessionId` is the selected fresh native chat and
 *  `previousSessionId` is the prior selection. Reset changes selection; it does not erase the
 *  gateway-owned history returned by `GET /bots/:name/sessions`. */
export const BotChatResetResponseSchema = Type.Object({
  name: Type.String(),
  sessionId: Type.String(),
  previousSessionId: Type.Optional(Type.String()),
});
export type BotChatResetResponse = Static<typeof BotChatResetResponseSchema>;

/** `POST /bots/:name/chat/messages` body. `clientId` is the sender's own id. The gateway echoes it
 *  on the immediately committed native user row, so the sender can de-duplicate its optimistic row. */
export const BotChatSendRequestSchema = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 32_000 }),
  clientId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export type BotChatSendRequest = Static<typeof BotChatSendRequestSchema>;

/** `POST /bots/:name/chat/messages/displayed` body (capability 31). The ids are wire ids of rows the
 *  device actually PUT ON SCREEN, which is the one fact a gateway cannot observe for itself: a
 *  durable transcript row proves delivery to the gateway, and a push proves nothing at all.
 *
 *  Bounded at 64 per request because the app coalesces a scroll burst into one call, not because a
 *  session is short: a client with more to report sends more requests. Unknown ids are ignored
 *  rather than refused, so a device replaying its offline queue after a chat reset is never stuck
 *  retrying a batch it cannot repair. */
export const BotChatDisplayedRequestSchema = Type.Object({
  messageIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 64 }),
});
export type BotChatDisplayedRequest = Static<typeof BotChatDisplayedRequestSchema>;

/** `202` body for the same route. `recorded` counts the ids that became a NEW receipt: ids already
 *  displayed and ids naming no durable row both count zero, so a client cannot read it as an error
 *  signal and MUST NOT retry on a low count. The route is idempotent and first-write-wins. */
export const BotChatDisplayedResponseSchema = Type.Object({
  recorded: Type.Integer({ minimum: 0 }),
});
export type BotChatDisplayedResponse = Static<typeof BotChatDisplayedResponseSchema>;

/** The non-file parts of the `POST /bots/:name/chat/photos` multipart body (capability 9). The
 *  `file` part is not modelled here on purpose: it is bytes, and what makes it acceptable is the
 *  size cap and the magic-byte sniff the gateway runs, neither of which a JSON schema can express.
 *
 *  `text` is the CAPTION, and it is what the bot is actually prompted with. It is optional and
 *  shorter-capped than a text send: a caption rides beside an image, and the 32000-character
 *  contract on `POST /bots/:name/chat/messages` is untouched by this route. An absent or blank
 *  caption is replaced by a neutral default prompt so the attached plugin receives an explicit
 *  turn instruction and the transcript honestly shows the words that were submitted. */
export const BotChatPhotoFieldsSchema = Type.Object({
  text: Type.Optional(Type.String({ maxLength: 4_000 })),
  clientId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export type BotChatPhotoFields = Static<typeof BotChatPhotoFieldsSchema>;

/** Non-file parts of `POST /bots/:name/chat/attachments` (capability 24). */
export const BotChatAttachmentFieldsSchema = BotChatPhotoFieldsSchema;
export type BotChatAttachmentFields = Static<typeof BotChatAttachmentFieldsSchema>;

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

/** One model the focused bot can select. `id` is the stable picker identity
 *  `<provider>:<model>`; `displayName` is presentation-only. From capability 36 an entry may
 *  carry `unauthenticated: true`: Hermes kept the provider visible although its credential is
 *  presently unusable, so a picker renders the entry disabled with a re-auth hint instead of
 *  hiding a selection the user explicitly configured. */
export const BotModelCatalogEntrySchema = Type.Object({
  id: Type.String(),
  displayName: Type.String(),
  unauthenticated: Type.Optional(Type.Literal(true)),
});
export type BotModelCatalogEntry = Static<typeof BotModelCatalogEntrySchema>;

/** Capability 36: one provider row from the Hermes picker payload, kept EVEN when it currently
 *  contributes zero catalog entries (no static models and no reachable endpoint) or has lost its
 *  credential. `modelCount` is how many catalog entries the provider contributes right now;
 *  `authenticated: false` marks a configured provider awaiting re-auth. The gateway mirrors the
 *  Hermes picker: every provider the user explicitly configured is visible, none silently
 *  dropped. */
export const BotModelProviderSchema = Type.Object({
  slug: Type.String(),
  name: Type.String(),
  authenticated: Type.Boolean(),
  modelCount: Type.Integer({ minimum: 0 }),
  baseUrl: Type.Optional(Type.String()),
});
export type BotModelProvider = Static<typeof BotModelProviderSchema>;

/** `GET /bots/:name/model-config`. Null means the profile follows Hermes' default for that axis.
 *  The catalog is the configured Hermes picker catalog, not a gateway-maintained model list.
 *  `providers` (capability 36) is the additive per-provider summary; a client below 36 ignores
 *  it and keeps rendering `catalog` alone. */
export const BotModelConfigSchema = Type.Object({
  model: Type.Union([Type.String(), Type.Null()]),
  effort: Type.Union([Type.String(), Type.Null()]),
  catalog: Type.Array(BotModelCatalogEntrySchema),
  efforts: Type.Array(Type.String()),
  providers: Type.Optional(Type.Array(BotModelProviderSchema)),
});
export type BotModelConfig = Static<typeof BotModelConfigSchema>;

/** `PUT /bots/:name/model-config`. Omitted leaves an axis unchanged; null clears it. */
export const BotModelConfigPatchSchema = Type.Object({
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  effort: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type BotModelConfigPatch = Static<typeof BotModelConfigPatchSchema>;

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

/** One current Hermes cron job carrying this bot's `[bot:<name>]` tag.
 *
 *  `id` is the backend's `job_id` and is the ONLY identifier the write routes accept; the display
 *  title is not unique and is not an id. `title` is the job name with the `[bot:<name>] ` tag
 *  stripped, and falls back to `Untitled cronjob` for a tagged job with nothing after the tag.
 *
 *  `enabled` is the ROW STATE the desktop's switch renders, which folds three backend facts into
 *  one: a job is enabled only when the backend's `enabled` is not false and its `state` is not
 *  `paused`. `state` carries the backend's own word when it sent one.
 *
 *  `lastRun` and `nextRun` are MILLISECONDS, or null when the backend sent nothing parsable (it
 *  sends ISO strings, and older builds send neither). */
export const BotRoutineSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  schedule: BotRoutineScheduleSchema,
  enabled: Type.Boolean(),
  state: Type.Optional(Type.String()),
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
  /** Capability 18 accepts and preserves these selections, but current Hermes cron RPCs cannot
   *  apply both to one run. They are inert until Hermes exposes a true per-run pair. Null means
   *  follow the bot profile; absent means the routine predates this field. */
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  effort: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  effort: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  effort: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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

/** Read-only transcript of an a2a inbox thread. Entries deliberately reuse the group-room message
 *  shape so every line carries its agent speaker. Capability 17 defines no send request schema. */
export const BotInboxMessagesResponseSchema = Type.Object({
  messages: Type.Array(BotGroupMessageSchema),
});
export type BotInboxMessagesResponse = Static<typeof BotInboxMessagesResponseSchema>;

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

/** Coarse invalidation for an open agent-inbox thread. The client re-reads the transcript instead
 *  of attempting to merge a second delta family into the group-room message projection. */
export const BotInboxActivityFrameSchema = Type.Object({
  type: Type.Literal("bot_inbox_activity"),
  bot: Type.String(),
  threadId: Type.String(),
  updatedAt: Type.Integer(),
});
export type BotInboxActivityFrame = Static<typeof BotInboxActivityFrameSchema>;

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

/** One command the selected Hermes profile accepts through a messaging surface. The catalog is
 * profile-owned and comes from Hermes' central registry, plugins, and installed skills. */
export const BotSlashCommandSchema = Type.Object({
  name: Type.String({ pattern: "^/[A-Za-z0-9_-]+$", minLength: 2, maxLength: 129 }),
  description: Type.String({ minLength: 1, maxLength: 200 }),
  argsHint: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
});
export type BotSlashCommand = Static<typeof BotSlashCommandSchema>;

export const BotSlashCommandCatalogSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 256 }),
  commands: Type.Array(BotSlashCommandSchema, { maxItems: 512 }),
});
export type BotSlashCommandCatalog = Static<typeof BotSlashCommandCatalogSchema>;

/** One agent-sent artifact projected from every durable native Bot Mode session. The attachment
 * remains gateway-scoped and downloads through the existing authenticated per-bot route. */
export const BotAttachmentHistoryItemSchema = Type.Object({
  bot: Type.String({ minLength: 1, maxLength: 256 }),
  sessionId: Type.String({ minLength: 1 }),
  messageId: Type.String({ minLength: 1 }),
  caption: Type.String(),
  at: Type.Union([Type.Integer(), Type.Null()]),
  attachment: AttachmentBlockSchema,
});
export type BotAttachmentHistoryItem = Static<typeof BotAttachmentHistoryItemSchema>;

export const BotAttachmentHistorySchema = Type.Object({
  items: Type.Array(BotAttachmentHistoryItemSchema, { maxItems: 100 }),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});
export type BotAttachmentHistory = Static<typeof BotAttachmentHistorySchema>;

/** One approval currently awaiting a decision. This is deliberately a compact recovery snapshot,
 * not another approval-request payload: raw tool arguments, commands, descriptions, results, and
 * model reasoning never enter it. `createdAt` is the durable pending-record timestamp; a pending
 * record is immutable until its terminal transition, so it cannot be confused with a resolution
 * time. */
export const BotPendingApprovalSchema = Type.Object({
  bot: Type.String({ minLength: 1, maxLength: 256 }),
  sessionId: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
  toolCallId: Type.String({ minLength: 1 }),
  ruleName: Type.String({ minLength: 1, maxLength: 512 }),
  createdAt: Type.Integer(),
  /** A device has durably submitted an action; wait for the terminal Hermes event. */
  resolutionRequestedAt: Type.Optional(Type.Integer()),
});
export type BotPendingApproval = Static<typeof BotPendingApprovalSchema>;

/** Capability 27's bounded, current-state approval inbox. It only ever represents `pending`;
 * terminal records remain durable for idempotency but are deliberately absent. */
export const BotPendingApprovalsSchema = Type.Object({
  approvals: Type.Array(BotPendingApprovalSchema, { maxItems: 100 }),
});
export type BotPendingApprovals = Static<typeof BotPendingApprovalsSchema>;

/** Compact terminal proof for an approval or clarification. A client may settle an optimistic
 * action only after it observes this receipt, never from the action POST or queued command. */
export const BotInteractionSettlementSchema = Type.Object({
  bot: Type.String({ minLength: 1, maxLength: 256 }),
  kind: Type.Union([Type.Literal("approval"), Type.Literal("clarify")]),
  interactionId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
  outcome: Type.Union([
    Type.Literal("approved"), Type.Literal("denied"), Type.Literal("expired"),
    Type.Literal("selected"), Type.Literal("cancelled"),
  ]),
  selectedOptionId: Type.Optional(Type.String({ minLength: 1 })),
  settledAt: Type.Integer(),
});
export type BotInteractionSettlement = Static<typeof BotInteractionSettlementSchema>;

/** Pending clarification recovery mirrors the approval inbox while retaining only display-safe
 * prompt/options and the durable request marker. */
export const BotPendingClarificationSchema = Type.Object({
  bot: Type.String({ minLength: 1, maxLength: 256 }),
  sessionId: Type.String({ minLength: 1 }),
  turnId: Type.String({ minLength: 1 }),
  clarifyId: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1, maxLength: 4096 }),
  options: Type.Array(BotClarifyOptionSchema, { minItems: 1, maxItems: 20 }),
  expiresAt: Type.Optional(Type.Integer()),
  resolutionRequestedAt: Type.Optional(Type.Integer()),
});
export type BotPendingClarification = Static<typeof BotPendingClarificationSchema>;

/** One bounded reconnect snapshot. Pending items and terminal receipts intentionally remain
 * separate so a caller cannot mistake command admission for Hermes confirmation. */
export const BotInteractionRecoverySchema = Type.Object({
  approvals: Type.Array(BotPendingApprovalSchema, { maxItems: 100 }),
  clarifications: Type.Array(BotPendingClarificationSchema, { maxItems: 100 }),
  // Retention is bounded to 100 per configured bot. The aggregate must not apply a second global
  // cap or a busy bot could hide another bot's only terminal proof from a reconnecting device.
  settlements: Type.Array(BotInteractionSettlementSchema),
});
export type BotInteractionRecovery = Static<typeof BotInteractionRecoverySchema>;

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
 *  - `8`: `POST /bots/:name/chat/reset` plus `bot_chat_reset`. It selects a fresh gateway-owned
 *    session; previous local history remains listed and may be adopted later.
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
 *    never sends the field.
 *  - `12`: LIVE TOOL ACTIVITY for bot chats (issue #60). The `bot_tool_activity` frame, a
 *    full-replace snapshot of a turn's tool steps as they run, plus a `toolSteps` array on
 *    `GET /bots/:name/chat/messages` carrying the same steps for turns that have already finished.
 *    A client that offers step-by-step chips MUST require `>= 12`: a version 11 gateway never sends
 *    the frame and never sends the field, so a chip strip would sit permanently empty. A client
 *    below 12 keeps working unchanged -- it ignores a frame type it does not know and an optional
 *    response field it never heard of, which is exactly where it was before.
 *
 *    Additive throughout, and deliberately narrow. Three things it does NOT do:
 *    - it adds NO push. Tool steps stay off `contract/push-v0.md` entirely; its payload kinds are
 *      still `message`, `approval_pending` and `approval_resolved`. Chips are a foreground surface.
 *    - it does not change `BotChatMessage`. The steps are NOT attached to a transcript row, because
 *      the gateway cannot honestly say which row a turn produced (see `BotTurnToolSteps`).
 *    - capability 12 carries no tool arguments, output, or preview text. Capability 21 later adds
 *      only bounded, redacted display text; raw argument/result objects remain excluded.
 *
 *    What the version does NOT promise, exactly as with 10, is that any step will ever be reported:
 *    hermes gates its whole tool lifecycle on `display.tool_progress`, which defaults to `all` but
 *    which an operator can set to `off`, and a profile running that way is silent here (see
 *    contract/ext-bots-v1.md, "Deployment: what a bridged profile must pin").
 *  - `14`: `bot_chat_adopted`, emitted when the user manually selects a stored native session or
 *    starts a fresh one. It tells paired clients to rebind and reload the durable local transcript.
 *  - `15`: assistant attach-v1 media becomes gateway-owned `BotChatMessage.attachments`.
 *  - `16`: `GET /bots/:name/sessions` and manual native-session adoption.
 *  - `17`: AGENT INBOX (issue #95). `GET /bots/:name/inbox` lists the newest 50 a2a sessions and
 *    `GET /bots/:name/inbox/:threadId/messages` returns a read-only transcript in the group-room
 *    message shape. An open thread that gains rendered messages emits `bot_inbox_activity`, a
 *    coarse signal telling clients to re-read it. There is deliberately no inbox send route.
 *  - `18`: BOT MODEL CONFIG (issue #106). Adds authenticated GET/PUT
 *    `/bots/:name/model-config`, backed by Hermes profile config and its configured picker catalog.
 *    Routine records and writes accept nullable model/effort selections. The surveyed cron RPC
 *    cannot scope both to one run, so they are preserved as inert metadata and the gateway never
 *    mutates a profile around a routine run.
 *  - `19`: native hard stop and fresh native chat routes.
 *  - `20`: STREAMED ASSISTANT MEDIA (issues #118 / cozychat#220). Assistant attachments carry an
 *    optional `mediaKind`; video and audio are ingested up to their per-kind 40 MB cap and the
 *    authenticated attachment route supports byte ranges for AVPlayer.
 *  - `21`: SAFE TOOL DETAILS (cozychat#224). Steps may carry bounded, defense-in-depth-redacted
 *    `detail` and error-only `errorText`; raw argument and result objects never cross the bridge.
 *  - `22`: NATIVE CLARIFICATION. Adds `bot_clarify_pending` / `bot_clarify_resolved` and the
 *    authenticated option-resolution route. Pending/options/expiry are durable and stable-id
 *    idempotent across gateway/plugin restart.
 *  - `23`: exact native turn status/cause and durable queued-at recovery metadata.
 *  - `24`: document attachments. `POST /bots/:name/chat/attachments` accepts one validated
 *    common document, and attachment `mediaKind: "file"` tells clients to offer download/share.
 *  - `25`: profile-local slash-command discovery. `GET /bots/:name/commands` returns the canonical
 *    gateway-safe commands, plugin commands, and installed skill commands advertised by that
 *    profile's authenticated attach plugin. The invocation is sent unchanged through the ordinary
 *    message route; no command execution logic is duplicated in CozyGateway or a client.
 *  - `26`: aggregate agent-sent attachment history. `GET /bots/attachments` searches and filters
 *    artifacts across configured profiles and every durable native session without duplicating
 *    their bytes or weakening the existing authenticated download route.
 *  - `27`: pending approval inbox. `GET /bots/approvals?state=pending` returns at most 100
 *    durable unresolved approvals, carrying only the bot/session/turn routing ids, tool-call id,
 *    safe rule display name, and original pending timestamp. Resolved and expired records vanish
 *    because the endpoint reads the same lifecycle truth as the existing action routes.
 *  - `28`: requested-vs-confirmed approval and clarification settlement. A decision request is
 *    durable and replayable, but `bot_*_resolved` remains reserved for the later terminal Hermes
 *    event. `bot_*_resolution_requested` disables duplicate actions across paired devices.
 *  - `29`: `GET /bots/approvals?state=pending` additionally returns bounded pending
 *    clarifications and confirmed terminal settlement receipts so a reconnect can settle an
 *    optimistic action without guessing from the action POST.
 *  - `31`: DURABLE DELIVERY RECEIPTS. Three additive pieces, and a client gates each on `>= 31`:
 *    - `POST /bots/:name/chat/messages/displayed` reports the wire ids of rows the device actually
 *      put on screen. It is the only signal in this contract that a HUMAN saw a message: a durable
 *      transcript row proves the gateway holds it, and `contract/push-v0.md` push is fire-and-forget
 *      by construction. A client MUST require `>= 31` before sending it; a version 30 gateway
 *      answers `404`, and a client MUST treat that as "this gateway does not collect receipts"
 *      rather than as a lost message.
 *    - `BotChatMessage.marker`, an optional bounded label on gateway-authored rows that are not
 *      conversation. A client below 31 ignores it and renders the ordinary row, which is exactly
 *      where it was before.
 *    - role `system` on a `BotChatMessage`. Roles were never an enum on this wire (section 3), so
 *      this adds no new rule: a client MUST render an unknown role rather than dropping the row.
 *      The one v1 emitter is the `delivery.failed` marker row the gateway appends to a bot's
 *      current canonical chat when a scheduled delivery terminally fails, so a cron report that
 *      never arrived is visible to the user instead of silently absent.
 *    What 31 does NOT add: any push, any per-attachment receipt, and any retroactive receipt for
 *    rows that were already on screen before the client learned to report them.
 *  - `32`: INLINE MEDIA ORDERING. `BotChatMessage.attachments` entries gain an optional
 *    `position`, the block index BEFORE which that attachment renders (see
 *    `BotChatAttachmentSchema` and `contract/ext-bots-v1.md`). Purely additive in both
 *    directions: a client below 32 ignores the field and keeps its above-stack stack, and a
 *    gateway below 32 simply never sends one. Rendering is data driven, not version gated: a
 *    client renders in flow whenever positions are present. The emitting side is what gates on
 *    `>= 32`. An out-of-range value clamps into `0...blocks.length`; it never drops the
 *    attachment. */
export const BOTS_CAPABILITY_ID = "com.cozylabs.bots";
/** Capability 30: a bounded, source-labelled projection of memory owned by the
 * attached Hermes profile.  `attributes` deliberately does not exist: every
 * field a client can render is named and bounded here, and a capability flag
 * exists only where a client actually branches on it: the mutation verbs, the
 * curated capacity meter and its next-session note, and `relationships`, which
 * gates the graph destination. */
/** `profile` is the curated About-me store. Hermes' own store calls that target
 *  `user`; the wire keeps the reader-facing name, and `user` is not a member. */
export const BotMemoryKindSchema = Type.Union([
  Type.Literal("memory"), Type.Literal("profile"), Type.Literal("fact"), Type.Literal("note"),
]);
export type BotMemoryKind = Static<typeof BotMemoryKindSchema>;
export const BotMemoryTimestampKindSchema = Type.Union([
  Type.Literal("created"), Type.Literal("fileCreated"), Type.Literal("firstObserved"), Type.Literal("unknown"),
]);
export type BotMemoryTimestampKind = Static<typeof BotMemoryTimestampKindSchema>;
export const BotMemoryCapabilitiesSchema = Type.Object({
  create: Type.Boolean(), edit: Type.Boolean(), delete: Type.Boolean(),
  relationships: Type.Boolean(), capacity: Type.Boolean(), effectiveNextSession: Type.Boolean(),
}, { additionalProperties: false });
export const BotMemorySourceSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 120 }),
  displayName: Type.String({ minLength: 1, maxLength: 160 }),
  kind: Type.String({ minLength: 1, maxLength: 80 }),
  status: Type.Union([Type.Literal("available"), Type.Literal("degraded"), Type.Literal("unavailable"), Type.Literal("unsupported")]),
  detail: Type.Optional(Type.String({ maxLength: 512 })),
  capabilities: BotMemoryCapabilitiesSchema,
  capacity: Type.Optional(Type.Object({ used: Type.Integer({ minimum: 0 }), limit: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
  effectiveNextSession: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type BotMemorySource = Static<typeof BotMemorySourceSchema>;
export const BotMemoryItemSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 512 }), sourceId: Type.String({ minLength: 1, maxLength: 120 }), kind: BotMemoryKindSchema,
  title: Type.String({ maxLength: 512 }), snippet: Type.String({ maxLength: 1_000 }), content: Type.Optional(Type.String({ maxLength: 32_000 })),
  createdAt: Type.Optional(Type.Integer({ minimum: 0 })), updatedAt: Type.Optional(Type.Integer({ minimum: 0 })), timestampKind: BotMemoryTimestampKindSchema,
  revision: Type.String({ minLength: 1, maxLength: 256 }), category: Type.Optional(Type.String({ maxLength: 120 })),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 64 })), trustScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  relativePath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  backlinks: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 128 })), effectiveNextSession: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type BotMemoryItem = Static<typeof BotMemoryItemSchema>;
export const BotMemoryOverviewResponseSchema = Type.Object({ sources: Type.Array(BotMemorySourceSchema, { maxItems: 32 }) }, { additionalProperties: false });
export type BotMemoryOverviewResponse = Static<typeof BotMemoryOverviewResponseSchema>;
export const BotMemoryItemsResponseSchema = Type.Object({ items: Type.Array(BotMemoryItemSchema, { maxItems: 100 }), sources: Type.Optional(Type.Array(BotMemorySourceSchema, { maxItems: 32 })) }, { additionalProperties: false });
export type BotMemoryItemsResponse = Static<typeof BotMemoryItemsResponseSchema>;
export const BotMemoryGraphResponseSchema = Type.Object({ nodes: Type.Array(BotMemoryItemSchema, { maxItems: 200 }), edges: Type.Array(Type.Object({ from: Type.String({ maxLength: 512 }), to: Type.String({ maxLength: 512 }), kind: Type.Union([Type.Literal("entity"), Type.Literal("wikilink")]) }, { additionalProperties: false }), { maxItems: 400 }) }, { additionalProperties: false });
export type BotMemoryGraphResponse = Static<typeof BotMemoryGraphResponseSchema>;
export const BotMemoryWriteRequestSchema = Type.Object({ content: Type.String({ minLength: 1, maxLength: 32_000 }), title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), category: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 64 })), expectedRevision: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })) }, { additionalProperties: false });
export const BotMemoryDeleteRequestSchema = Type.Object({ expectedRevision: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false });
export const BotMemoryWriteResponseSchema = Type.Object({ item: BotMemoryItemSchema }, { additionalProperties: false });
export type BotMemoryWriteResponse = Static<typeof BotMemoryWriteResponseSchema>;
export const BotMemoryDeleteResponseSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 512 }), revision: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false });
export type BotMemoryDeleteResponse = Static<typeof BotMemoryDeleteResponseSchema>;

/** Capability 33: create-time tool selection. `POST /bots` accepts optional `toolsets` and
 *  `mcpServers` alongside the name, and answers `BotCreateResponse`, whose optional `warnings`
 *  name any selection the backend did not report and could not grant. A gateway that seeds
 *  blank-slate bots applies the selection ON TOP of the `file` + `terminal` floor. Both request
 *  fields are optional and additive, so a client below 33 is untouched and a gateway below 33
 *  ignores them; a picker UI gates on `>= 33` so the user is never shown a choice that will be
 *  dropped in silence. */
/** Capability 34: SUBAGENT VISIBILITY. When a bot delegates work to subagents mid-turn (Hermes
 *  `delegate_task`), the batch lifecycle reaches clients as `bot_delegation_activity`
 *  full-replace snapshots, plus a `delegations` array on `GET /bots/:name/chat/messages` so an
 *  active batch survives reopen and reconnect. Additive exactly as capability 12 was: a client
 *  below 34 ignores an unknown frame type and an optional response field and keeps today's
 *  behavior (the outer delegate_task chip plus the terminal completion card); a client that
 *  renders live batch cards gates on `>= 34`, because an older gateway never sends either.
 *  Children carry only bounded display metadata (a truncated task label, a tool name); raw
 *  child transcripts, summaries, args, and results never cross this wire, a restart with a
 *  child in flight settles it `unknown` -- never `failed` -- and nothing here is pushed. */
/** Capability 35: LIVE THINKING PREVIEW. A deliberate, bounded reopening of the old
 *  "no reasoning on the wire" rule (approved 2026-08: reasoning models emit their whole reply in
 *  one end burst, so a turn otherwise shows only a generic thinking state). What crosses the wire
 *  is `bot_thinking_activity`: a latest-only, sanitized, <=280-char rolling preview -- never the
 *  chain of thought itself, never tool args/results, prompts, credentials, or paths. It is
 *  ephemeral end to end: not persisted, absent from chat history, and it stops at the turn's
 *  terminal. Additive exactly as 34 was: a client below 35 ignores the unknown frame and keeps
 *  today's shimmer; a client that renders the preview gates on `>= 35`. */
/** Capability 36: FULL PROVIDER VISIBILITY. `BotModelConfig` gains the optional `providers`
 *  summary (one row per provider Hermes reported, kept even at zero selectable models or with a
 *  lost credential) and catalog entries may carry `unauthenticated: true`. Hermes deliberately
 *  keeps an unauthenticated configured provider visible so the picker can show the saved
 *  selection and a re-auth affordance; the gateway now forwards that intent instead of silently
 *  dropping the rows. Additive exactly as 33 was: a client below 36 ignores the unknown field
 *  and marker; a client that renders the providers summary or disabled entries gates on
 *  `>= 36`. */
export const BOTS_CAPABILITY_VERSION = 36;

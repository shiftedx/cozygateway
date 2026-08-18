/** Vendor extension `com.cozylabs.bots`, version 3. NOT part of the frozen `contract: "v1"`
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
 *  all (Hermes stamps in seconds on some builds and not at all on others).
 *
 *  `role` is always `user` or `assistant` on this wire: the bridge drops `system` and `tool` rows,
 *  and any row whose text is empty, so tool chatter never reaches a chat bubble.
 *
 *  `clientId` is the echo of what the sender put on `POST /bots/:name/chat/messages` (or the
 *  gateway's own local id when the sender sent none). It rides the 202 body AND the same message
 *  when it comes back in a `bot_chat` frame, which is what lets a sender replace its optimistic row
 *  instead of rendering the message twice. */
export const BotChatMessageSchema = Type.Object({
  id: Type.String(),
  role: Type.String(),
  text: Type.String(),
  at: Type.Union([Type.Integer(), Type.Null()]),
  clientId: Type.Optional(Type.String()),
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

/** `POST /bots/:name/chat/messages` body. `clientId` is the sender's own id for this message; the
 *  gateway never interprets it, it only echoes it back on the committed message and on that same
 *  message when the turn poll finds it, so the sender can de-duplicate its optimistic row. */
export const BotChatSendRequestSchema = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 32_000 }),
  clientId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export type BotChatSendRequest = Static<typeof BotChatSendRequestSchema>;

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
const RoutineText = (max: number) => Type.String({ minLength: 1, maxLength: max, pattern: "^[^\\u0000]*\\S[^\\u0000]*$" });

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
 *  `title`, `schedule` and `prompt` are a REWRITE, and the backend has no edit action at all: the
 *  gateway pauses the old job, creates a replacement, and removes the old one, so the routine comes
 *  back with a NEW `id`. Two consequences a client must design around, both spelled out in
 *  `contract/ext-bots-v1.md`:
 *  - `prompt` is REQUIRED whenever any of the three is present, because the backend only ever
 *    reports a 100-character preview of a stored prompt and a rewrite that guessed the rest would
 *    silently truncate the user's instruction;
 *  - `repeat` and `continuity` are not carried over unless they are restated here, for the same
 *    reason: the backend reports the run cap as a display string, not a number. */
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
 *    a routines pane MUST require `>= 4`. */
export const BOTS_CAPABILITY_ID = "com.cozylabs.bots";
export const BOTS_CAPABILITY_VERSION = 4;

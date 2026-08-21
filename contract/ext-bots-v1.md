# cozygateway vendor extension: com.cozylabs.bots, v1

Status: draft, wave 5 (read path, full-duplex bot chat, bot create/delete, the edit-profile
surface, routines, and server-side group chats). Versioned
INDEPENDENTLY of `contract/v1.md`, which stays frozen. This document describes an optional surface
a gateway may or may not have; a client that does not recognize it ignores the capability and the
frames, and nothing in v1 changes.

Machine artifact: `packages/contract/src/ext-bots.ts` (TypeBox schemas). Notation follows
`contract/v1.md`: objects are OPEN, unions are CLOSED, `field?:` means optional.

## 1. What it is

A surface over a Hermes gateway's "Bot Mode": the roster of named bots, each bot's canonical chat
(read AND write), each bot's session list, and multi-bot group rooms. The gateway holds one
persistent outbound JSON-RPC WebSocket
to the Hermes gateway (the "hermes bridge") and caches what it learns in SQLite, so the app reads
are cache-first and the live updates are pushed rather than polled.

Group rooms are the exception to "cache": they are HOSTED here, not mirrored from Hermes, which is
also why a Hermes desktop on the same gateway cannot see them. See the group-chat notes in section 4
before building against them.

Bot Mode itself is mostly a set of CONVENTIONS over generic Hermes primitives (profiles, a
`ui_meta` blob, cron, a session `hidden` flag). The bridge reimplements those conventions
server-side so a phone sees exactly what a desktop sees. The conventions that must never drift:

- canonical chat session title is exactly `Bot Chat`;
- the `ui_meta` namespace key is `hermes-bots`;
- `last_session.last_active` is UNIX SECONDS, `meta.created` is MILLISECONDS;
- an unknown Hermes method rejects with a message matching `/unknown method/i`, and that text is
  passed through untouched so client feature probes keep working.

## 2. Discovery

A gateway that has a bridge configured advertises it in `GatewayInfo.capabilities`
(`contract/v1.md` section 5):

```
"capabilities": { "com.cozylabs.bots": 15 }
```

The value is the extension's integer version, which is what the capabilities map is typed for.
A gateway with no bridge omits the id entirely and does not register any `/bots` route, so a
client can rely on the capability rather than probing for 404s.

Versions are ADDITIVE, so a client compares `>=`, never `===`:

- `1`: roster, presence, canonical-chat resolve, session list, chat history.
- `2`: `POST /bots/:name/chat/messages` plus the `bot_chat` and `bot_chat_state` frames. A client
  that offers a composer MUST require `>= 2`: a version 1 gateway 404s that route and never sends
  those frames, which without the bump reads as a composer that silently does nothing.
  `POST /bots` and `DELETE /bots/:name` ride this same version rather than a third one. The rule for
  bumping is whether a client can be misled by the absence: a composer on a gateway without the send
  route looks broken, which is worth a version, while a create or delete button on a gateway without
  those routes gets a 404 that says exactly what happened. A client that wants to hide the buttons
  can probe once.
- `3`: the edit-profile surface: `GET` and `PATCH /bots/:name/profile`, plus `GET /bots/catalog`. A
  client that offers an edit screen MUST require `>= 3`, by the same rule the composer bump used: a
  screen whose Save 404s reads as a broken app rather than as a missing feature.
- `4`: the routines surface: `GET` and `POST /bots/:name/routines`, `PATCH` and
  `DELETE /bots/:name/routines/:id`, plus the `bot_routines` frame. A client that offers a routines
  pane MUST require `>= 4`, for the same reason again.
- `5`: server-side group chats: the `/bots/groups` routes plus the `bot_group` and
  `bot_group_state` frames. A client that offers a rooms screen MUST require `>= 5`.
- `6`: the `bot_chat_delta` frame, a live draft of the reply a bot is writing. No route changes ride
  this bump and nothing about an existing frame changed. It exists because a gateway that CANNOT
  stream and a bot that simply has not produced a token yet look identical on the wire: a client
  that wants to show "typing" as a growing bubble gates that on `>= 6` and otherwise keeps its
  spinner. A client that ignores the frame entirely loses nothing but the animation.
- `7`: `GET /bots/:name/media`, the image proxy. A client that renders the image references in a
  bot's reply as pictures MUST require `>= 7`: a version 6 gateway 404s the route, so a client that
  reached for it anyway would turn links that work today into broken-image chips. Below 7 a client
  keeps whatever it did before, which is to show the URL as a link. This is a route bump with no
  frame changes and no change to any existing route.
- `8`: `POST /bots/:name/chat/reset` plus the `bot_chat_reset` frame. A client that offers a "clear
  chat" action MUST require `>= 8`: a version 7 gateway 404s the route. Note what it is NOT: hermes
  exposes no session delete here, so the retired chat is still on the hermes host and still appears
  in `GET /bots/:name/sessions`; what is cleared is which session the bot's canonical chat points at.
  The frame matters as much as the route, which is why they ride one number: a client below 8 ignores
  `bot_chat_reset` and goes on appending to a session that is no longer canonical, which looks
  perfectly correct on that device and diverges from every other one.
- `9`: photos to bots. `POST /bots/:name/chat/photos` sends one image with an optional caption,
  `GET /bots/:name/chat/attachments/:fileId` serves the gateway's own copy back, and
  `BotChatMessage.attachments` carries the `attachment` block that joins the two. A client that
  offers a photo picker MUST require `>= 9`: a version 8 gateway 404s both routes. Below 9 nothing
  changes for a client, because `attachments` is an optional field and no existing route or frame
  changed shape. What the version does NOT promise is that the bot will SEE the picture: whether a
  photo arrives as pixels or as a description is decided per turn inside Hermes, from the bot's own
  model, and this gateway cannot observe that decision. See "What a photo actually reaches" below.
- `10`: mobile approve/deny for bot chats. The `bot_approval_pending` and `bot_approval_resolved`
  frames, plus `POST /bots/:name/approvals/:toolCallId/approve` and `.../deny`. A client that offers
  an approve/deny UI MUST require `>= 10`: a version 9 gateway 404s both routes and never sends
  either frame, so the buttons would do nothing at all. A client below 10 keeps working unchanged;
  it simply never learns that a bot is blocked waiting on a human, which is exactly where it was
  before. What the version does NOT promise is that any approval will ever arrive: that depends on
  two hermes settings this wire cannot assert, and if either is wrong the surface is silently
  lossy. See "Deployment: what a bridged profile must pin".
- `11`: fresh bot chats are BORN EMPTY, and the canned opener becomes a client-side SUGGESTION. The
  one entry in this list that changes BEHAVIOUR rather than only adding surface, so read it as that
  first: up to 10, opening a bot with no chat (and, from 8, resetting one) created the session and
  SUBMITTED a canned opener into it, which the app rendered as a message the USER had sent and which
  the bot answered before the user had typed anything. Neither path does that any more, on the
  ruling that the user's own input is the only thing this API ever submits in a conversation. In its
  place, `GET /bots/:name/chat/messages` carries an optional `suggestion` string while the transcript
  is empty; it is presentation-only, and a client MAY show it and MAY let the user send it as their
  own message. A client that offers a suggestion chip MUST require `>= 11`. A client below 11 keeps
  working and keeps ignoring an unknown optional field, but it will see one difference against an 11
  gateway: a freshly opened bot chat is genuinely empty where it used to hold an exchange. That is
  the same empty payload a version 10 gateway already answered with while a chat was being created,
  so nothing breaks; the chat simply no longer fills itself in.
- `12`: live tool activity for bot chats. The `bot_tool_activity` frame, a full-replace snapshot of
  a turn's tool steps as they run, plus a `toolSteps` array on `GET /bots/:name/chat/messages`
  carrying the same steps for turns that have already finished. A client that offers step-by-step
  chips MUST require `>= 12`: a version 11 gateway sends neither, so a chip strip would sit
  permanently empty. It adds no push, changes no existing field, and carries no tool arguments,
  output or preview text of any kind.
- `13`: LEGACY CRONJOBS become visible as routines. `GET /bots/:name/routines` and the
  `bot_routines` frame also carry the UNTAGGED cron jobs in that bot's own store, each with
  `BotRoutine.legacy: true`, and the row actions accept their ids. No route, frame or existing field
  changed shape, and a tagged routine is byte-for-byte what it was.

  A client below 13 keeps working and keeps ignoring an optional field, but against a 13 gateway it
  will see rows it never saw before and will offer Edit on them, which answers 400. That is why this
  is a version rather than a silent widening: a client that renders legacy rows MUST require
  `>= 13`, MUST hide or disable Edit on a row carrying `legacy`, and offers the conversion as delete
  then create. What the version does NOT promise is that any legacy job will be found; see the
  ownership rule under `GET /bots/:name/routines`.
- `14`: THE CANONICAL CHAT PIN FOLLOWS THE BOT'S LATEST CONVERSATION, plus the `bot_chat_adopted`
  frame that announces the move. Like 11, this changes BEHAVIOUR rather than only adding surface, so
  read it as that first. Up to 13 the pin was adopted once and then held, while `GET /bots` derived
  a bot's preview and `lastActiveAt` from its last activity across ALL its sessions. A conversation
  held from a second device therefore updated the roster row and never appeared in the chat the app
  opened: the two surfaces disagreed about which session was "this bot's conversation", and the
  missing messages were absent from the wire rather than dropped by the client. From 14 they cannot
  disagree. See "The pin follows the bot's latest conversation" under `GET /bots/:name/chat` for the
  rule, for what may never move the pin (routine fires, bot-to-bot deliveries, group rooms), and for
  how it stays out of a reset's way.

  A client that offers a chat screen SHOULD require `>= 14` before it relies on the transcript
  matching the roster preview, and MUST require `>= 14` to act on `bot_chat_adopted`. A client below
  14 keeps working: it ignores a frame type it does not know, and its next ordinary read of
  `GET /bots/:name/chat/messages` returns the re-adopted transcript anyway, so what it loses is
  promptness, not correctness. A re-adoption retires nothing and deletes nothing, and the previous
  session stays listed by `GET /bots/:name/sessions`.
- `15`: BOT-TO-APP IMAGE ATTACHMENTS. When a turn settles, standalone `MEDIA:<path>` lines in an
  assistant message, outside code fences, may become `attachments` on that assistant row. The
  gateway attempts at most three directives per message. It reads through Hermes' authenticated
  dashboard, tries `/api/media` before `/api/fs/read-data-url`, accepts only png, jpeg, gif and webp
  bytes up to 8 MB, and stores a gateway-owned copy under a gateway-minted `fileId`. A successful
  directive line is removed from the settled text. A missing, denied, oversized or wrong-type file
  leaves its line untouched, as does every directive after the first three.

  A client below 15 ignores the optional assistant `attachments` field. `bot_chat` frames and chat
  history carry the blocks. `bot_chat_adopted` continues to trigger the history reread that carries
  them rather than gaining a message payload of its own.
- `16`: SESSION HISTORY AND MANUAL RESTORE. `GET /bots/:name/sessions` returns the Hermes sessions
  the bridge can see, newest first, with normalized times, the capability-14 classification, and
  the active canonical-chat pin. `POST /bots/:name/sessions/:id/adopt` restores one as that pin and
  broadcasts the existing `bot_chat_adopted` frame so every paired device re-reads it.

  A manual restore holds through every session that already existed. The capability-14
  follow-latest rule resumes when the next new conversational session appears. A client below 16
  sees no change.

## 3. Resources

### BotPreview

```
{
  kind: "a2a" | "plain" | "empty",
  text: string,
  sender?: string
}
```

`a2a` is a bot-to-bot delivery: `text` has the `Message from ...:` prefix stripped and `sender`
carries the sending bot's handle. `plain` is an ordinary preview (falling back to the bot's
description). `empty` means the bot has no conversation yet.

### BotChatMessage

```
{
  id: string,                         // stable per session, see below
  role: string,                       // "user" | "assistant" | whatever hermes said
  text: string,
  at: integer | null,                 // MILLISECONDS, null when the message carries no stamp
  clientId?: string,                  // the sender's own id, echoed; see below
  attachments?: Attachment[]          // capability >= 9; ABSENT, never [], when there are none
}
```

Hermes message shapes drift between builds and between the paths that wrote the message, so the
bridge flattens them and this is what a client sees. The mapping, exactly:

- `text`: `content` when it is a string; when `content` is an array, the parts joined in order,
  where a part contributes its own string, or its `text` / `content` / `value` field, and a part
  with none of those (a tool-call record, for instance) contributes nothing; when there is no
  `content` at all, `text` is `msg.text`. The result is trimmed.
- `role`: the message's `role`, or `"assistant"` when it carries none. Roles are NOT an enum on
  this wire: a build that invents `tool` must not break a client.
- `at`: the first usable value among `at`, `ts`, `timestamp`, `time`, `created_at`, `created`.
  A number at or below 10^11 is read as SECONDS and multiplied, anything larger is already
  milliseconds; numeric strings and ISO strings are accepted; anything else yields null.
- `id`: the message's own `id`, `message_id` or `row_id` when it has one, otherwise an id the
  gateway derives from the row's CONTENT: `<sessionId>#<fingerprint>-<n>`, where the fingerprint
  covers the role and the text and `n` distinguishes repeated lines. Position is deliberately not in
  it. A backend transcript is not an append-only log (a `/compact` drops the head, may write a
  summary in its place, and carries the tail over), and an id derived from where a row sat would be
  a DIFFERENT id for the same row the moment that happens.
  Stable for a given session, and that word is load-bearing: an id names one rendered row for the
  life of the session, ACROSS a compaction, so keying a list on it and de-duplicating a replayed
  frame with it both work. A gateway that cannot honour that must not re-deliver the row at all.
  Two limits, stated so a client is not surprised by them: a row whose TEXT changes is a new row,
  and a repeated line whose earlier copy is compacted away while the gateway is restarting can come
  back once under the other copy's id.
- `clientId`: present only on a message the sender submitted with one (see
  `POST /bots/:name/chat/messages`), both in the 202 body and on that same message when it comes
  back in a `bot_chat` frame. It appears on AT MOST ONE message: a clientId is never re-used for a
  second row, never attached to a row the gateway has already delivered (in an earlier frame or in a
  history read, either of which can replay rows a client already holds), and never carried across a
  turn boundary or past a history read that re-based the watermark over the row it was waiting for,
  however many times the same words are sent.
  It is not a guarantee that the row wearing it is the row that send produced. A frame's user row is
  joined back to a send by its TEXT, which is the only thing the two have in common, so if hermes
  never records a send at all the next row with those same words can inherit its key. `id` is
  therefore the identity of a rendered row and `clientId` is only the join back to the sender's
  optimistic copy; a client that keys its list on the clientId instead collapses two identical sends
  into one row.
- `attachments`: images associated with this message, each one the frozen
  `attachment` block from `contract/v1.md` section 2:
  `{ "type": "attachment", "fileId": string, "name": string, "mimeType": string, "size": integer }`.
  `fileId` is gateway-scoped and opaque; it is never a URL and never a path, and it is fetched from
  `GET /bots/:name/chat/attachments/:fileId`. `name` is GENERATED (`photo.jpg`, `photo.png`), never
  any source filename, and `mimeType` is what the BYTES are rather than what an upload or dashboard
  claimed. The field is absent, not an empty array, on a message with no attachments. Since
  capability 9 it appears on user rows for photos sent with that row, riding the 202 body, later
  `bot_chat` frame and every history read. Since capability 15 it may also appear on assistant rows
  for successfully ingested `MEDIA:<path>` lines after the turn settles. Failed lines remain in
  `text`; successful lines are removed and stay removed on later history reads.
- Hermes writes its own bookkeeping into the user row it persists for an image turn: an
  `@image:/absolute/path/on/the/hermes/host.png` directive line and a `[screenshot]` marker (and, on
  other paths, `[Image attached at: ...]` or `[User attached image: ...]`). Those lines are STRIPPED
  from `text` before it reaches this wire, on user rows only. No path from this bookkeeping reaches
  a device: the block above is what replaces it, and it names bytes this gateway holds. Assistant
  text has a separate capability-15 rule: only a whole-line `MEDIA:<path>` directive outside code
  fences is machinery, and only a successfully ingested line is removed. Every other mention of a
  path remains conversation.
- Rows are DROPPED, never rendered as blank bubbles: anything that is not an object, anything whose
  role is not `user` or `assistant` (a `system` prompt, a `tool` result), and anything whose text is
  empty after flattening (an assistant turn whose whole content was a `tool_use` part). A settled
  capability-15 row whose text becomes empty only because every directive succeeded is retained with
  its attachments, so an image-only answer remains visible. Only the two conversational roles reach
  the app, from BOTH the history route and the frames, so a client never has to filter tool chatter
  itself.

A reply the bridge cannot parse at all reads as an empty, idle session. It never raises.

### BotSummary

```
{
  name: string,                       // the Hermes profile name, the id everywhere in this API
  displayName: string,                // meta.title, else "Hermes" for the default profile, else title cased name
  handle: string,                     // "hermes" for the default profile, else name
  description: string | null,
  hasAvatar: boolean,
  group: string | null,
  pinned: boolean,                    // roster pin, not the chat pin
  active: boolean,                    // see section 5
  lastActiveAt: integer | null,       // MILLISECONDS
  chatSessionId: string | null,       // canonical Bot Chat, when one is known
  preview: BotPreview,
  meta: object | null                 // the ui_meta["hermes-bots"] blob, verbatim and open
}
```

Roster order is: pinned bots first, then most recently active first, where activity is the later
of `meta.created` and `lastActiveAt`. Client-side search filters this order, it never re-ranks it.

### BotProfile

```
{
  name: string,
  description: string,                // the profile's own description, "" when unset. READ-ONLY here
  soul: string,                       // whole SOUL.md, "" when the profile has none
  skills:  [ { name: string, enabled: boolean, description?: string } ],
  toolsets: [ { name: string, enabled: boolean,
                label?: string, description?: string, toolCount?: integer } ],
  toolsetsPinned: boolean,            // whether the profile pins a toolset set at all
  mcpServers: [ { name: string, installed: boolean, enabled: boolean,
                  auth?: string, description?: string, transport?: string,
                  requires?: string[], fromCatalog?: boolean } ],
  model: { provider: string, default: string },  // both "" when the profile inherits
  runtimeInert: string[]              // sections saved and shown back, but inert at runtime today
}
```

Read by `GET /bots/:name/profile`, written (in part) by `PATCH /bots/:name/profile`. The three
lists carry three DIFFERENT enable semantics; the table under that route is the load-bearing part
of this document for a client author.

`runtimeInert` is always present and possibly empty. It names the PATCH sections this gateway
accepts, persists and reads back, but which the backend does not consult when the bot actually
runs. Values are `"toolsets"` (for `enabledToolsets`) and `"mcpServers"` (for `enabledMcpServers`);
a client that does not recognize a value shows a generic note. See the KNOWN ISSUE under
`PATCH /bots/:name/profile`, which this field exists to let a client gate on without sniffing a
backend version string it has no reliable way to read.

### BotCatalog

```
{
  query: string,                      // the skill search this catalog answers
  skills: [ { name: string, description: string } ],
  mcpServers: [ { name: string, description: string, installed: boolean, enabled: boolean,
                  requires: string[], auth?: string, transport?: string } ],
  models: [ { slug: string, name: string, models: string[] } ],
  unavailable: string[],              // sections the gateway could not answer: skills|mcpServers|models
  updatedAt: integer                  // MILLISECONDS
}
```

Read by `GET /bots/catalog`. It is the MENU, shared by every bot; a bot's own state is in
`BotProfile`.

### BotRoutine

```
{
  id: string,                         // the backend's cron `job_id`, the ONLY write identifier
  title: string,                      // the job name with its `[bot:<name>] ` tag stripped
  schedule: { raw: string, human?: string },
  enabled: boolean,                   // the row switch: on unless paused, disabled, or legacyUnsafe
  state?: string,                     // the backend's own word, e.g. "paused"
  legacyUnsafe: boolean,              // a pre-marker delegated routine; see the auto-pause below
  legacy?: boolean,                   // an UNTAGGED cron job in this bot's own store; never false
  autoPaused?: boolean,               // this response is the one that paused it
  prompt?: string,                    // the backend's PREVIEW, truncated at 100 characters
  lastRun: integer | null,            // MILLISECONDS
  nextRun: integer | null,            // MILLISECONDS
  lastStatus?: string,                // how the last run ended, the backend's own word
  repeat?: string,                    // a DISPLAY string: "forever", "once", "3 times", "1/3"
  continuity?: boolean                // each run sees the previous run's output
}
```

A bot owns a cron job by one of two facts, and they are not equally strong.

**The tag.** A routine either client CREATES is an ordinary Hermes cron job whose NAME is
`[bot:<name>] <title>`. There is no bot field on a cron job and no per-bot cron API, so that tag is
the whole relationship. Consequences a client should hold onto:

- the gateway filters every list and every write through that tag, so another bot's jobs are
  invisible on these routes, whatever id is sent;
- the tag is written exactly as the Hermes desktop writes it, so routines created on a phone appear
  in the desktop's Routines pane and vice versa.

**The store** (`legacy`, from version 13). Cron storage is per Hermes home, so an UNTAGGED job in a
bot's own cron store is that bot's schedule: it was created before routines existed, it still fires,
and hiding it made every routines client blind to it. Those rows carry `legacy: true`. What is
different about them:

- `title` is the job's RAW name, verbatim. Nothing is stripped and nothing is prettified, because
  the operator named the job themselves and that name is how they recognize it everywhere else.
  `schedule` (with `human` where the gateway can name the shape), `enabled`, `state`, `prompt`,
  `lastRun`, `nextRun`, `lastStatus`, `repeat` and `continuity` are all read exactly as for a tagged
  routine.
- pause, resume and delete accept a legacy id. A schedule a user can see and cannot stop would be
  worse than one they never saw.
- a REWRITE does not: `PATCH` carrying anything but `enabled` answers 400. The rewrite would recreate
  the job under the `[bot:]` tag with a new id, which is a conversion rather than an edit. A client
  that wants the conversion does it in the open, by deleting the legacy job and creating a routine.
- `legacy` is absent on every tagged routine, and is never `false`.

The field is not `legacyUnsafe` and the two are independent. `legacy` says "untagged, and yours by
the store"; `legacyUnsafe` says "a pre-marker delegated routine", which is a TAGGED shape only. A
legacy row is never `legacyUnsafe` and is never auto-paused: see the auto-pause under
`GET /bots/:name/routines`.

**The ownership rule.** The gateway claims a bot's untagged jobs only out of a store the backend
agrees is that bot's. Every cron call carries `profile`; a Hermes that honors it scopes the call to
that bot's home, and one that does not answers with the launch profile's store instead. Where the
backend names the store it read, an answer naming a DIFFERENT profile contributes no legacy rows at
all. Where it names nothing, the requested scope is taken at its word, which is the only reading
under which pre-routines jobs are reachable on a backend that does not echo. Two things hold under
every backend: the tag filter is unconditional, so no answer ever hands one bot another bot's tagged
routines; and a name beginning `[bot:` is somebody's tag claim even when the gateway refuses to parse
it, so it is never claimed as a legacy job.

`schedule.raw` is the backend's stored schedule string, which is a NORMALIZED echo rather than what
was sent: an interval comes back in minutes (`every 2h` is stored and reported as `every 120m`), a
one-shot duration comes back as `once in 30m`, an ISO timestamp as `once at 2026-02-03 14:00`, and a
cron expression verbatim. `human` is present only for the shapes the gateway can name (`Daily`,
`Hourly`, `Every 3h`, `Every 45m`, `Every 2 days`, `Once (30m)`); when it is absent, render `raw`.
Cron expressions never get an English rendering from either side.

`repeat` is a display string and NOT what a write sends: a create sends an integer `repeat`, and the
remaining-run count is not recoverable from the string the backend reports.

`prompt` is a PREVIEW. The backend truncates a stored prompt to 100 characters and appends `...`,
and there is no RPC anywhere that returns the whole thing. It is enough to recognize a routine, not
enough to rebuild one, which is why an edit must resend the instruction (see
`PATCH /bots/:name/routines/:id`).

### BotGroupMessage

```
{
  seq: integer,                       // room-local ordinal, stable and monotonic
  from: { kind: "user" | "member", name: string, displayName: string },
  text: string,
  at: integer,                        // MILLISECONDS
  clientId?: string                   // echo of the sender's own id, user messages only
}
```

One entry in a room transcript. `from.kind: "user"` is the human, whose `name` and `displayName` are
both the literal `You` (the desktop's own label, kept so a transcript reads the same on both
clients). For a member, `name` is the Hermes profile name and `displayName` is the bot's title.

Key a list on `seq`, never on array position: the log is TRIMMED from the head at 96 entries, so
positions shift while a `seq` never does. `seq` starts at 1 per room and is never reused, including
after a trim.

### BotGroup

```
{
  name: string,                       // as typed, 1..64
  members: string[],                  // 2..6 Hermes profile names, in creation order
  createdAt: integer,                 // MILLISECONDS
  state: "running" | "settled" | "needs_you",
  needsYou: boolean,
  epoch: integer,
  updatedAt: integer                  // newest entry's stamp, or createdAt for an empty room
}
```

`state` is derived and is what a list renders: `running` while a round loop holds the room,
`needs_you` when the room is idle and some member's reply mentioned `@user`, `settled` otherwise.
`needsYou` is the same escalation flag on its own, so a client can show a badge without parsing the
state union.

`epoch` is bumped on every user send and is the supersession counter: a round loop that finds the
room's epoch has moved on abandons the rest of its rounds. A client can ignore it; it is on the wire
because the state frames carry it, and a client that renders per-conversation state wants to know
which send a frame belongs to.

Room names are addressed CASE-INSENSITIVELY (`/bots/groups/release%20room` reaches `Release Room`)
and two rooms cannot differ by case alone.

### BotGroupDetail

`BotGroup` plus `messages: BotGroupMessage[]`, oldest first. Returned by `GET /bots/groups/:name`.

### BotGroupNote

```
{ member: string, reason: "timeout" | "failed", detail: string }
```

Rides a `bot_group_state` frame when a member's turn produced nothing for a reason worth showing.
`detail` is the gateway's own text, verbatim from Hermes when that is where the failure came from. A
member that simply PASSED produces no note: passing is the protocol's healthy outcome, not an
incident.

## 4. Routes

All routes take the same `Authorization: Bearer <deviceToken>` as every other route.

### GET /bots

```
200 { bots: BotSummary[], updatedAt: integer | null, stale: boolean }
```

Answers from the cache immediately, including on a cold link (`bots: []`, `updatedAt: null`), and
kicks off a background refresh whose result arrives as a `bot_roster` frame. `stale` is true when
the bridge is not currently connected to Hermes, so the app can show a soft "showing the last good
list" state instead of an error.

Profiles the gateway operator has hidden (`hermes.hiddenProfiles` in its config) are NOT on this
list, and never appear in a `bot_roster` or `bot_presence` frame. They remain real Hermes profiles,
and every `/bots/:name` route still addresses them: hiding is a roster filter, not an access rule.
Because they are addressable, the gateway reads a hidden bot's `ui_meta` blob FRESH off Hermes when
resolving or writing that bot's canonical-chat pin, rather than through the filtered roster cache it
is by definition absent from. Reading the absence as "the server carries nothing" would have made a
hidden bot's server-side pin invisible and, worse, made the first chat open replace its whole
desktop-authored blob with a bare pin.

### POST /bots

```
body {
  name: string,                       // 1..64, the Hermes profile name
  title?: string,                     // 1..120
  description?: string,               // 0..2000
  shape?: string,                     // 1..32
  color?: string                      // "#rrggbb"
}
201  { bot: BotSummary, metaOutcome: "persisted" | "unsupported" | "failed", metaError?: string }
400  invalid_request                  // malformed body, or a name the Hermes rule refuses
409  conflict                         // a profile of that name already exists
```

Creates a bot, which upstream calls a profile. Two Hermes calls, in this order:

1. `profiles.create` with the canonical name, the `description` verbatim, and **`share_auth: true`
   sent explicitly**. That flag is load-bearing: the backend defaults it to false, which COPIES the
   launch profile's `auth.json` rather than sharing it, and a forked OAuth pool means the first
   token refresh on either side invalidates the other. The description is the profile's own;
   `title` is a client-side label and stays out of it.
2. `profiles.configure` writing `ui_meta["hermes-bots"] = { title?, shape?, color?, created }`,
   where `created` is MILLISECONDS. The namespace key and the field names are the desktop plugin's,
   so a bot made from a phone renders identically on a desktop.

`metaOutcome` is the desktop's three-way `saveBotMeta` contract, reported rather than swallowed:
`persisted` when the gateway answered `applied.ui_meta === true`; `unsupported` when it does not
speak that contract at all (it rejected `profiles.configure`, or answered without an `applied`
object), which is the expected, silent fallback on an older Hermes; `failed` when it speaks the
contract and said the blob did not apply, OR the call was lost to the transport (the socket dropped,
or it did not answer inside its bound). **A look that did not persist never fails the create**: the
bot exists either way, and only `failed` is worth showing a user.

The transport case belongs with `failed` and not with `unsupported`, and the difference is the whole
point of the split: `unsupported` says "this gateway will never store looks, stop expecting it and
say nothing", which is the wrong thing to tell a user about a write that was merely lost and is worth
retrying. `metaError` carries Hermes' own text for either non-`persisted` outcome, verbatim.

A transport failure here does not turn the create into a 502. `profiles.create` has already
returned, so the bot exists; answering 502 would tell the caller its bot was not made, and its retry
would come back 409 on a bot it owns.

Concurrent creates of one name are single-flighted by the gateway: two devices racing on `scout` cost
one `profiles.create` and receive the same 201. That is an efficiency and consistency property, not
the safety one; safety comes from upstream, whose `create_profile` answers the loser with
`FileExistsError` (error code 4062), which this route maps to 409.

`name` is validated against the Hermes profile rule before anything is put on the wire, so a bad
name is a 400 naming the rule rather than a 502. The rule, from upstream `hermes_cli/profiles.py` at
v2026.8.16.2: the name is trimmed and lowercased first (so `Scout` is accepted and becomes `scout`),
then it must match `[a-z0-9][a-z0-9_-]{0,63}`, and it must not be one of the reserved names
`hermes`, `default`, `test`, `tmp`, `root`, `sudo`. `default` additionally names the built-in
profile and can never be created.

The response carries the bot's roster row, and the gateway refreshes the roster BEFORE answering, so
that row is the same one the `bot_roster` frame firing alongside it carries. A bot created under a
hidden name is returned here but is absent from that frame, by definition.

### DELETE /bots/:name

```
204  (no body)
400  invalid_request                  // a name the Hermes rule refuses, the built-in "default"
                                      //   profile, or the profile the bridge itself runs on
404  not_found                        // no profile of that name
502  command_blocked                  // + { blocked: true, hint: string }
502  backend_unavailable              // + { blocked: false, exitCode: integer, hermesError: string }
504  backend_unavailable              // + { timedOut: true }; the delete may still be running
```

`:name` is trimmed, lowercased, and validated against **the same rule `POST /bots` applies** before
anything is put on the wire: `[a-z0-9][a-z0-9_-]{0,63}`, and not one of the reserved names. This is
not cosmetic. The name is interpolated into a `cli.exec` argv the gateway builds itself, and
`DELETE /bots/%2E%2E%2Fetc` decodes to `../etc` while `DELETE /bots/--help` decodes to a leading-dash
token; neither may reach that argv on the strength of a remote validator alone. `default` is refused
with its own message, and so is the profile the bridge's own Hermes link runs on, when the operator
has named it in the config (it cannot be detected: the RPC surface reports the profile a SESSION is
routed to, never the one the gateway process was launched under).

This route is **deliberately not idempotent**: deleting a name that does not exist answers 404
`not_found`, not 204. A client that cannot tell "already gone" from "the delete broke" cannot decide
whether to retry, and retrying a delete that timed out (below) is exactly the case where the
difference is load-bearing.

Deletes the bot's profile. The gateway prefers a teardown-first `profiles.delete` RPC and falls back
to `cli.exec ["profile","delete",<name>,"--yes"]` when the gateway answers `/unknown method/i`.
Hermes 0.20.3 registers no such RPC, so the CLI path is the live one today; the probe means a
gateway that later gains the RPC is used correctly with no change on either side. The teardown-first
preference matters because `cli.exec` bypasses backend teardown, and a pool backend still holding
the profile directory open races the CLI's rmtree, which is upstream's "can't delete a bot" bug.

`blocked` is not a Hermes error: it is a SUCCESSFUL `cli.exec` whose result says the gateway's
command allow-list refused to run the delete at all. The gateway's own `hint` rides the body
verbatim, because it is the only thing that tells an operator what to widen.

A profile delete is SLOW: upstream disables the profile's service unit, stops a running gateway, and
rmtrees the profile directory with retries. It is given 180 s (passed to `cli.exec` as its own
`timeout`, in seconds, and used as the client-side bound), rather than the 30 s every other call
gets. A delete that still runs out answers **504 with `timedOut: true`** and a message saying the
operation may still be running, never the 503 "the bridge is not connected", which would be a
factually wrong account of a call that went out and may be completing right now.

Nothing local is discarded until Hermes confirms the delete, so a blocked, failing or timed-out
delete leaves the bot exactly as it was, canonical-chat pin included. On success the gateway forgets
the bot's cached roster row, its `ui_meta` mirror and its canonical-chat pin, and it CANCELS the
bot's live turn poll if one is running, dropping its broadcast watermark and pending sends with it.
Cancelling is what makes the cleanup real: a poll left running would keep emitting `bot_chat` and
`bot_chat_state` frames for a bot no longer on the roster, and each poll rewrote the watermark that
was just dropped. Then the roster is refreshed, so a name reused later starts clean.

Every `/bots/:name` route trims and lowercases `:name` at the boundary, so a bot has exactly one
identity whatever casing a client used: `GET /bots/Scout/chat` and `DELETE /bots/scout` address the
same bot, and no pin or meta row can outlive the profile it belongs to.

### GET /bots/:name/chat

```
200 { name: string, sessionId: string, adoption: "pin" | "title" | "latest" | "recovery" | "created" }
404 not_found                         // no profile named `name` exists
```

Every `/bots/:name/*` route below, this one included, answers **404 `not_found`** when `:name`
does not name a Hermes profile at all, checked against the roster cache and, on a miss, a fresh
`profiles.list` (never the possibly-stale cache alone, so a bot created moments ago is never
punished for a snapshot that predates it, and so a HIDDEN bot -- absent from the cache by design,
per `GET /bots` above -- is still resolved correctly rather than read as unknown). `hermes`
`session.create` does not itself validate the profile name, so without this check
`GET /bots/probe-bot/chat` on a name nobody ever created answered 200 `adoption: "created"`, minting
a live session for a profile that was never there, while `POST /bots/:name/chat/messages` on that
same name 202'd into the void: accepted by the gateway, delivered nowhere, because there was never a
Hermes-side profile behind it. "Unknown" here means "not a Hermes profile at all"; a hidden bot is a
real profile and stays chattable by name on every one of these routes, exactly as section 3's
`GET /bots` note describes.

Resolve-or-create the canonical Bot Chat. The gateway lists the bot's sessions and:

- `pin`: the known pin still resolves and nothing newer outranks it, return it;
- `title`: first open of a bot with history, adopt the session titled `Bot Chat`;
- `latest`: the newest CONVERSATIONAL session, which is both the first open of a bot with history
  and no canonical title AND, since capability 14, a later open where a newer conversation has
  outrun the pin. See the next section;
- `recovery`: the pinned id vanished (compaction rewrote the lineage), re-pin the newest session;
- `created`: no history at all, create a session titled `Bot Chat` (hidden by default). Since
  capability 11 NOTHING is submitted into it: the chat is born empty and stays empty until the user
  writes in it. A failed create leaves no pin behind and the route reports the failure.

The returned `sessionId` is the STORED session id.

### The pin follows the bot's latest conversation

Capability `>= 14`. The canonical chat is not adopted once and held: **when a newer conversational
session outruns the pinned one, the canonical chat RE-ADOPTS it**, this route reports
`adoption: "latest"`, and a `bot_chat_adopted` frame goes to every paired device.

Why it has to. `GET /bots` derives a bot's preview and `lastActiveAt` from its last activity across
ALL its sessions, while `GET /bots/:name/chat/messages` is scoped to the single pinned session. Up
to 13 the two could describe different conversations, and did: a chat held from a second device
(a desktop, the CLI) mints a session of its own, which moved the roster preview and never became the
chat the app opened. The messages were absent from the wire, not dropped by the client. Following
the latest conversation is what makes the two surfaces answer one question.

**What may move the pin.** Exactly the sessions the roster preview would present as CONVERSATION.
Everything else is a session a machine wrote into the bot's history, and each exclusion is a
transcript that would be wrong to open when a user taps the bot:

- **cron sessions** (`source: "cron"`, and the `cron_<job_id>_<timestamp>` id shape, checked as well
  because `source` is nullable on this wire). Every routine fire deliberately mints its own session,
  as "Where a routine's runs land" describes, so a bot with an hourly routine would otherwise
  re-adopt away from its owner's conversation once an hour;
- **delegated routine runs**, titled `Routine: <title>`. The same feature's other delivery: a
  routine whose bot is not the gateway's own profile runs through
  `hermes -p <bot> chat -c "Routine: <title>"`, which lands in that bot's own history with source
  `cli` rather than `cron`. Excluding only `source: cron` would have caught half of routines;
- **group-room sessions**, titled `Group: <name>`. A member's room session is the room's half of a
  multi-bot conversation, and adopting it would splice room traffic into the 1:1 chat;
- **bot-to-bot deliveries**, recognized on the session preview by the same rule that classifies a
  roster preview as `BotPreview.kind: "a2a"`.

Everything else counts, including a session with no title and no source, because the second device
whose conversation this rule exists to follow titles its sessions however it likes. The exclusions
are the closed list; conversation is the default.

**Re-adoption never fights a reset**, and the ordering is worth stating because the two look alike
from a distance. A reset retires the outgoing session, records it, and pins a freshly minted
replacement that has NO row in `session.list` until the user writes in it. So a just-reset bot is
resolved by the pin the gateway holds rather than by any listed session, and once the replacement
does become listed it is the newest row with nothing above it to follow. A retired session is not a
re-adoption candidate at any point, whatever its title and wherever it sorts, by the same rule the
reset section states. Clearing a chat cannot undo itself on the next open.

**"Newer" normally means list position**, which `GET /bots/:name/sessions` documents as a convention
this wire cannot verify. It is used as a preference and never as a fact, and the two guards above are
what make a wrong guess harmless: the worst a mis-ordered list can do is prefer one conversation the
user actually held over another.

Capability 16 adds one exception for a manual restore. The pin row records that the choice was
manual and when it happened. Conversations already above the restored row cannot immediately undo
the choice. Follow-latest resumes only for a conversational row whose nonzero `startedAt` is later
than that manual choice. An older Hermes that supplies no creation time cannot prove a later session
and therefore keeps the manual choice.

One related fix rides the same capability, because a client can observe it. A pin THIS gateway wrote
after its last `profiles.list` snapshot now outranks that snapshot whatever the snapshot carries,
not only when the snapshot carries no pin. Both a reset and a re-adoption repoint the pin, and a
client that reads back inside the refresh window used to be handed the session that had just been
moved away from.

Three v1 properties worth knowing before writing a client:

- **The server's pin wins, key-wise.** `ui_meta["hermes-bots"]` is the cross-machine source of
  truth for `chat`: once a profile carries that blob, an absent `chat` key and an explicit
  `chat: null` both mean "no pin", and the gateway's local record is never used to fill the gap.
  Only a profile with no bot blob at all falls back to that local record, with ONE exception, and
  `GET /bots` applies it identically so the two routes cannot disagree: a pin this gateway wrote
  AFTER the `profiles.list` snapshot in hand is newer than that snapshot, not contradicted by it, so
  it wins until a later snapshot has had a chance to see it. From capability 14 that exception
  covers a snapshot naming a DIFFERENT session as well as one naming none, which is the same
  statement about the same staleness; before 14 it covered only the absent key, and a reset or a
  re-adoption read back inside the refresh window was handed the session it had just moved away
  from.
- **The pin IS written back.** When the resolved pin differs from what the profile's
  `ui_meta["hermes-bots"]` carries, the gateway pushes it with `profiles.configure`. Because that
  RPC replaces the blob WHOLE, the write is a read-modify-write against a FRESH `profiles.list`,
  never against the cached roster: another client's edit that landed since the last poll survives,
  and a pin that was present when the resolve started and is gone from the fresh read is treated as
  an authoritative clear and NOT written back. `image`, `pet` and `custom` are stripped, a legacy
  pre-namespace `ui_meta` contributes only the fields this namespace owns, and a blob that would
  exceed the 64 KB `ui_meta` cap is reduced or refused, because that object rides every
  `profiles.list`. The write counts as persisted only when `applied.ui_meta === true`; a gateway
  that rejects the method, or answers without an `applied` map at all, is not asked again and the
  pin stays gateway-local, which still works. A writeback failure never fails the request.
- **A pin the gateway just wrote survives an empty session list.** `session.create` persists no row
  until its first prompt lands, so a chat nobody has written in is absent from `session.list`
  entirely. An empty list therefore does NOT mean "this bot has no chat": a pin the gateway holds
  wins, and only a bot with no pin at all gets a new chat. This is the fix for the wave 1
  duplicate-adoption bug, where two consecutive calls both answered `created` with different session
  ids and the app ended up rendering a different chat than the roster previewed. From capability 11
  this is no longer a few-second race but the resting state of an untouched chat, so the rule holds
  for as long as the chat stays untouched.
- **This GET has side effects.** On a bot with no history it CREATES a session. It costs no tokens
  since capability 11 (nothing is prompted into it), but it is still a write: it mints a session on
  the Hermes host and moves the pin. Do not use it as a prefetch.

### GET /bots/:name/chat/messages

```
200 {
  name: string,
  sessionId: string,
  adoption: "pin" | "title" | "latest" | "recovery" | "created",
  messages: BotChatMessage[],
  running: boolean,
  inflight: boolean,
  updatedAt: integer,
  suggestion?: string,                // capability >= 11, only while `messages` is empty
  toolSteps?: BotTurnToolSteps[]      // capability >= 12, absent when the chat has run no tools
}
404 not_found                         // no profile named `name` exists
```

```
BotTurnToolSteps = {
  turnId: string,
  startedAt: integer,                 // ms: when the turn's FIRST step started
  endedAt?: integer,                  // ms: absent while any step is still `running`
  steps: BotToolStep[]                // same shape the live `bot_tool_activity` frame carries
}
```

History of the canonical chat. The chat is resolved exactly as `GET /bots/:name/chat` resolves it,
so the app never has to hold a session id, and the same side effect applies: a bot with no history
gets a chat created. A chat nobody has written in has no row to resume, and Hermes rejects the
resume; that specific case answers `messages: []` rather than an error, because the chat is simply
empty. What decides it is whether the gateway is holding the runtime id of that exact session, which
is its durable record that it minted the chat and nothing has been said in it since. NOT the
`adoption` value: the second read correctly reports `pin`, and it is exactly the read the app
performs. And no longer a time window either: up to capability 10 the tolerance expired with the
180 s turn cap, which was right only while an auto-submitted opener meant the row was seconds away.
Every other Hermes failure is passed through.

**`toolSteps` (capability `>= 12`).** The tool steps of the turns this chat has already run, oldest
turn first and in `seq` order within each, so a collapsed "what did it do" strip under an old reply
can be expanded long after the socket that watched it live is gone. ABSENT, not empty, when the chat
has run no tools, so a client at 12 can tell "nothing happened" from "nothing was recorded" and a
client below 12 is unaffected by a field it never heard of. Steps are retained for 90 days and swept
hourly; a chat reset or a profile delete drops them immediately, with everything else keyed on the
bot's name.

It names TURNS and never messages. See "bot_tool_activity, the live tool-step strip" in section 6
for why the gateway will not guess which transcript row a turn produced, and for the chronological
join a client uses instead -- `startedAt` and `BotChatMessage.at` are the same millisecond clock.

**`suggestion` (capability `>= 11`).** An opener the client MAY offer while the chat is empty.
Present ONLY when `messages` is empty AND the deployment configured one (`hermes.chatSuggestion`,
which defaults to `Hey, tell me about yourself!` and is turned off with an empty string); absent in
every other case, including the moment the transcript stops being empty.

It is **presentation only**, and that is the whole of the contract. The gateway does not submit it,
it is in no transcript, and it appears in no frame. A client may render it (a chip, a placeholder,
a tappable line) and may let the user send it AS THEIR OWN message through the ordinary
`POST /bots/:name/chat/messages`, at which point it is that user's message like any other and the
field disappears from the next read. A client must not send it automatically, must not display it as
though the user or the bot had said it, and must not treat its absence as an error.

Why it exists rather than the gateway just saying it: up to capability 10 this gateway submitted that
line itself on both fresh-chat paths, and the app drew the result as a message the USER had sent to a
bot that had already answered it. The user's own input is the only thing this API ever submits in a
conversation.

`running` and `inflight` are Hermes' own flags for the session: a client rendering a "thinking"
state should trust the `bot_chat_state` frames over this snapshot, which is only ever a point in
time.

### POST /bots/:name/chat/messages

```
body { text: string, clientId?: string }   // text 1..32000 characters, clientId 1..128
202  { name: string, sessionId: string, message: BotChatMessage }
400  invalid_request                       // missing or empty text
404  not_found                             // no profile named `name` exists
502  backend_unavailable                   // hermes refused, or no runtime session could be addressed
```

Submits `text` into the canonical chat. **202, not 200**: Hermes has accepted the prompt and the
reply is NOT in this response. The body carries the user message the gateway committed, so the app
can render it immediately; its `id` is a gateway-local one (`<sessionId>#local-<ms>`) because Hermes
does not hand one back, and the same message reappears with HERMES' own id in a later `bot_chat`
frame. The two ids never match, so dedupe rides `clientId` instead: whatever the sender put on the
request (or the gateway-local id, when it sent none) comes back on the committed message AND on that
same message in the frame, so the optimistic row is replaced rather than duplicated.

The gateway matches a frame's user row back to the send it came from by TEXT, which is the only
thing the two have in common, so the match is ordered and single use. The queue of accepted sends is
FIFO, the first entry holding those words wins, that entry is then spent, and everything ahead of it
is dropped (a newer entry matching first proves the older ones are never coming back). An entry is
also dropped, unmatched, in the two places where the row it was waiting for can no longer arrive:

- when the next turn opens, since the previous turn's poll has ended;
- when a history read re-bases the delta watermark past that row, since the row is handed to the
  reader directly and the poll will never emit it. This is the case a turn boundary cannot cover,
  because a repeat sent while the bot is still replying JOINS the live turn rather than opening a
  new one.

A row the gateway has already delivered is never stamped at all. Without those rules, sending the
same words twice handed the second row the FIRST send's clientId, and a client keyed on it silently
rendered one bubble where the user had typed two (cozychat#38). What survives is the residual case
in the section 3 note: a send hermes never records leaves its key free for the next row with the
same words, which is why `id`, not `clientId`, is a row's identity. The wire shape is unchanged,
which is why this rides capability 6.

Delivery of the reply: the gateway submits against the session's RUNTIME id (learned from a cheap
`session.resume`, which is also the message-count baseline, or from `session.create` for a chat
nobody has written in and which therefore cannot be resumed at all -- since capability 11 that is
every chat until this very send, so the gateway keeps that runtime id on disk rather than in memory). The stored pin is NEVER
used in that slot: a send whose runtime id cannot be established is never submitted against the pin,
because that answers 202 for a message that goes nowhere. The gateway then polls `session.resume` every 2 seconds until the
transcript ENDS on an assistant message AND the session reports neither `running` nor `inflight`,
giving up after 180 seconds. Growth alone is not enough, because `prompt.submit` persists the
sender's own message. That is the desktop plugin's own turn loop, moved server-side, so a
phone that is backgrounded (or a second device that was never in the room) still receives the whole
turn. Each poll that finds new messages emits a `bot_chat` delta; each change of state emits a
`bot_chat_state`.

While the turn runs, the gateway also streams a LIVE DRAFT of the reply as `bot_chat_delta` frames
(section 6), built from Hermes' own token events rather than from the poll. It is decoration: the
message a client stores is still the one that arrives in `bot_chat`, and a turn that streams nothing
is an ordinary turn.

There is exactly ONE turn poll per bot. A send that arrives while a poll is running rides that
poll rather than starting another, and extends its deadline. Three consecutive failing polls
abandon the turn with `phase: "failed"`; a single transient failure is ridden out.

**A send may answer with a DIFFERENT `sessionId` than the chat the client was in.** A chat whose
hermes session no longer exists (hermes restarted while the chat sat unwritten in, and an unwritten
session was never persisted) cannot be addressed and cannot be repaired, so rather than failing that
send, and every send after it, the gateway retires the dead pin, mints a replacement exactly as
`POST /bots/:name/chat/reset` does, submits the message into it, and answers 202 naming the NEW
session. It is announced, not silent: every device also receives the ordinary `bot_chat_reset` frame
(section 6) carrying the new `sessionId` and the `previousSessionId` it replaced. A client that keys
its transcript on the session id must therefore read the `sessionId` in this response, and not
assume it is the one it sent against. If the replacement cannot be minted, or the message cannot be
submitted into it either, the send answers 502 with the hermes text; the gateway heals once per send
and never loops.

### POST /bots/:name/chat/reset

Capability `>= 8`.

```
(no request body)
200 { name: string, sessionId: string, previousSessionId?: string }
400 invalid_request                   // `name` is not a legal profile id
404 not_found                         // no profile named `name` exists
502 backend_unavailable + hermesError // hermes refused to create the replacement chat
```

Retires the bot's current canonical chat and pins a freshly minted one in its place. This is what a
"clear chat" or "start over" action calls, and the word "clear" is generous, so read the next
paragraph before you write that label.

**Nothing is deleted.** Hermes exposes no session delete on this surface, so a reset is a
retire-and-re-pin and never a removal. The old session and its entire transcript stay on the Hermes
host, untouched, and keep appearing in `GET /bots/:name/sessions` and in the Hermes desktop's own
session list. The only thing that changes is which session the bot's canonical pin points at: the
bot starts a new conversation, it does not forget the old one. A client that promises its user the
history is gone is promising something this gateway did not do. What a reset genuinely buys is a
fresh context window for the bot and a clean chat screen for the user, which is what the action is
usually wanted for.

**The new chat IS empty** (capability `>= 11`; up to 10 it came back carrying the bot's greeting).
It is minted exactly as `GET /bots/:name/chat` mints one on the `created` path: a session titled
`Bot Chat`, hidden by default, and nothing submitted into it. Because Hermes persists no row for a
session until its first prompt lands, that chat cannot be resumed until the user writes in it, which
is the same state any freshly created chat is in and which `GET /bots/:name/chat/messages` answers as
an empty history (with the `suggestion` field, when one is configured).

`previousSessionId` is the id the pin pointed at before this call. It is ABSENT only when there was
nothing to retire, which in practice means the outgoing chat could not be resolved at all; a bot
that has simply never been opened gets its chat resolved (and therefore minted) first, and is then
reset, so it answers with both ids like everything else.

**200, not 202.** Unlike a send, the work this route describes is finished when it answers: the new
chat exists, it is pinned locally and pushed to `ui_meta`, the retired chat's turn poll is
cancelled, and the `bot_chat_reset` frame has gone out. Nothing at all is left in flight: the
replacement chat is empty and stays empty until the user writes in it.

What the gateway tears down before it mints, and why a client can rely on it: the retired chat's
turn poll is cancelled, its delta watermark and pending sends are dropped, and the live-draft
bindings are forgotten. So no `bot_chat`, `bot_chat_state` or `bot_chat_delta` frame for the retired
session arrives after this route answers. A poll left running would have kept broadcasting for a
chat nobody is in and would have rewritten the very watermark the reset dropped.

**A retired chat never comes back as the canonical one.** The replacement is minted with the same
title as the chat it replaces, so a bot reset several times has several sessions titled `Bot Chat`
and only the pin says which is live. The gateway therefore remembers the ids it has retired (the
most recent few dozen per bot, on disk) and refuses to adopt any of them, whatever their title and
wherever they sort in `session.list`. That matters because the pin is losable: pushing it to
`ui_meta` is never allowed to fail a reset, so a gateway that cannot store it keeps the pin local.
Without the refusal, the first resolve after a lost pin could re-adopt the conversation the user
cleared. A bot whose every listed session has been retired gets a freshly minted chat rather than
any of them.

A reset is mutually exclusive with the canonical-chat resolve for that bot. A resolve already in
flight is awaited first, and a resolve that arrives while the reset runs joins it and receives the
NEW chat, so no device is ever handed a session id that is a moment from being retired.

### POST /bots/:name/chat/photos

Capability `>= 9`.

```
content-type: multipart/form-data
parts:
  file      (required, exactly one image)
  text      (optional, the caption, 0..4000 characters)
  clientId  (optional, 1..128)

202  { name: string, sessionId: string, message: BotChatMessage }
400  invalid_request                       // no file part, more than one, or a malformed body
400  media_refused  reason: "empty"        // a file part with no bytes in it
404  not_found                             // no profile named `name` exists
413  media_refused  reason: "too_large"    // over the size cap, declared or delivered
415  media_refused  reason: "content_type" // not a type this gateway accepts, or the bytes disagree
429  rate_limited + retryAfterMs           // this DEVICE has sent photos too quickly; retry-after
502  backend_unavailable + hermesError     // hermes refused; NOTHING was submitted.
                                           // hermesError has host paths redacted on THIS route
503  backend_unavailable  busy: true       // the gateway is already sending as many photos as it will
```

Sends ONE photo, with an optional caption, into the canonical chat. The answer is the same 202 and
the same body as `POST /bots/:name/chat/messages`, and for the same reason: Hermes has accepted the
prompt and the reply is not in this response, it arrives over `bot_chat` like any other turn. The
`clientId` echo, the FIFO match of a send back to its persisted row, and the turn poll all behave
exactly as they do for a text send. No new frame type exists, and none was needed.

The one thing the body carries that a text send's does not is `message.attachments`, and it carries
it immediately, so a sender can render its own photo the instant the request returns instead of
waiting a poll for it.

**A photo is always sent with words.** Hermes holds an attached image on the session and spends it on
the NEXT prompt and nothing else, so a caption is not decoration here: without one the picture would
sit queued and land on whatever the user typed afterwards. An absent or blank `text` is therefore
replaced with a neutral default prompt, and the transcript honestly shows that prompt as the user's
line rather than an empty bubble.

**One image per send.** Not a limit that could be raised by sending more parts: a second `file` part
is a `400`. Hermes' image queue is per session and is spent whole on one turn, so several files in
one request would mean several pictures on one turn described by one attachment block.

What the gateway will accept:

- Content type on an allow-list, not an `image/*` prefix test: `image/png`, `image/jpeg`,
  `image/gif`, `image/webp`, `image/bmp`. `image/svg+xml` is NOT on it, for the reason
  `GET /bots/:name/media` gives and more so inbound: SVG is a document format carrying script, and
  these bytes are stored by this gateway and served back from an authenticated route.
- `image/heic`, `image/heif`, `image/avif` and `image/tiff` are refused with `415` and a message
  saying to convert the photo. They ARE on the capability-7 OUTBOUND allow-list, and the asymmetry is
  deliberate: what a CDN may serve to a phone and what this gateway may feed to a model are different
  questions, and Hermes' own inbound extension list does not include them. iOS shoots HEIC by
  default, so converting on device is the app's job; a distinct `415` is what lets it say something
  true instead of surfacing a Hermes `4016` as a `502`.
- **The declared type never decides anything.** The leading bytes are sniffed (PNG, JPEG, GIF87a/89a,
  WEBP, BMP) and they decide. A declared type that is not on the allow-list is refused so the message
  can be specific; a declared type that disagrees with the bytes is refused rather than resolved in
  the sender's favour. `mimeType` on the resulting block is always the sniffed type.
- At most 8 MB per photo, enforced against the declared length AND against the bytes that actually
  arrive. The number sits between three ceilings: Hermes takes 25 MB per attach, the
  Anthropic-family providers reject a single image over 5 MB, and a 2048 px JPEG at q0.8 (what an app
  should send) is under 2 MB. Refusing here rather than at Hermes is what turns "the gateway is
  broken" into a `413` that says what happened.
- **The filename is never used.** Not for the stored id, not for the served name, not for the
  extension. The id is generated, the name is `photo.<ext>`, and the extension comes from the sniffed
  bytes.
- **And no host path leaves this route, including in an error.** Every other route on this surface
  passes Hermes' own text through verbatim in `hermesError`, and still does, because client feature
  probes match against it. This route is the exception: its ordinary failures name the Hermes images
  directory (a write failure carries the full path), and stripping paths out of the transcript while
  handing the same path back in an error body would close nothing. On this route only, anything
  path-shaped in `hermesError` is replaced with `<path>`. The code, the verb and the reason survive.

**At most 3 of these run at once, per GATEWAY**, with the same bounded wait and the same `503 busy`
answer the media proxy uses (`retry-after: 1`, `waitedMs` in the body). The number is smaller than
the proxy's five because a photo is buffered whole and then base64-encoded into a single JSON-RPC
frame, so the cost is memory rather than a socket. On top of that, and unlike the proxy, there is a
per-DEVICE rate limit: a burst of 8 with one refilling every 5 seconds. The cost of a photo is
attributable to the phone that caused it, and what is being bounded is one device spending the
household's token budget in a loop. The token is spent when the request ARRIVES, before anything is
read or validated, so a run of refused requests costs a device the same budget a run of accepted ones
does. A limiter that only charged for successes would be one a caller could dodge by failing cheaply.
A client should treat `429` as "wait", never as a verdict on the photo.

**Attach then submit, in that order, and never one without the other.** The gateway resolves the
runtime session id exactly as a text send does, attaches the bytes, and only then submits the prompt.
An attach that fails, or that succeeds without reporting the image as attached, fails the whole send
with `502` BEFORE any submit, so a caption never lands without its photo. A `502` from this route
means NOTHING WAS SUBMITTED, and a retry is a retry rather than a duplicate.

The narrow case that phrasing is careful about: the attach can land and the submit can then fail (a
transient RPC error, a dropped socket with Hermes still up). Hermes would be left holding a queued
image that the NEXT prompt spends, whatever that prompt is, so the user's next unrelated question
would silently carry a picture the transcript does not show. The gateway therefore asks Hermes to
drop the queued image (`image.detach`) before it reports the failure. That unwind is BEST EFFORT: if
it fails too, the gateway has nothing further to try, and the honest statement of the guarantee is
"nothing was submitted" rather than "nothing reached Hermes". This is also why the gateway deletes its
own copy on that path: a photo no message points at is not kept.

Sends are serialized per bot across that pair. Hermes' attached-image queue is per session and is
consumed and cleared by the next prompt, so an interleaved send would take somebody else's picture:
two photos racing would put both on one turn and none on the other, and an ordinary TEXT send racing
a photo upload would steal the picture outright and attach it to words that were not about it. The
serialization covers text sends too, for exactly that second case.

**What a photo actually reaches.** Hermes decides per turn whether the bot gets pixels or a text
description, from the bot's own model: a vision-capable model gets native multimodal input, and a
text-only one gets a reference and is told to look at the image itself. A profile configured with
`model.openai_runtime: codex_app_server` is forced to the text path whatever its model. The gateway
cannot see that decision and does not report it, so a client cannot warn about it from the wire; it
is a property of the bot, best said on a bot's own screen rather than surfaced as a runtime error.

### GET /bots/:name/chat/attachments/:fileId

Capability `>= 9`.

```
200  <the image bytes>
     content-type: the sniffed type of the stored image
     content-length: its size in bytes
     cache-control: private, max-age=86400
     x-content-type-options: nosniff

400  invalid_request   // `name` is not a legal profile id, or fileId is not an attachment id
404  not_found         // no attachment with that id belongs to this bot
```

Serves the gateway's OWN copy of an image. For a user row, these are the bytes a device uploaded.
For a capability-15 assistant row, these are bytes the gateway copied through Hermes' authenticated,
size-capped and path-guarded dashboard read endpoints after the turn settled. In both cases the id
was minted by this gateway and never contains a host path.

`fileId` is opaque, fixed-shape (32 hex characters) and gateway-scoped, and is checked against that
shape before any lookup: a path parameter that could be anything is how an id becomes a path. The
lookup is scoped to the bot in the URL as well, so one bot's route never serves another bot's photo.
There is no uploader-device scope: any paired device may read an assistant-bound or user-bound row,
matching the chat frames and history that are already shared across paired devices.

The header set is the capability-7 posture, for the same reasons: `nosniff` because the type was
taken from an allow-list and confirmed against the bytes and nothing downstream should improve on it,
and `private, max-age=86400` because the bytes are immutable (an id names one upload forever) and
went through a device-token route, so they belong to that device rather than to any shared cache.
Range requests are not supported and `Accept-Ranges` is not sent: the cap is 8 MB, so the answer is
always one whole image.

**Images expire, conversations do not.** Stored bytes are kept for 14 days. After that the message
keeps its post-ingest text and simply stops carrying the attachment block, and this route answers
`404` for the id. A successfully consumed assistant directive does not reappear when its bytes
expire. A client should render the missing block as a picture that is no longer available rather
than as a broken chat.

The expiry is a property of the READ, not of a sweep having run: a photo past 14 days is unreachable
from the moment it expires, whether or not the gateway has got around to reclaiming the disk. That
distinction is load bearing on exactly the gateway this feature is for. A household that sends photos
for a week and then stops gives a sweep nothing to trigger it, so an expiry that depended on one would
never happen at all, and the promise above would be false on the quietest boxes rather than the
busiest.

Deleting a bot deletes its photos immediately, by the same rule that drops its pin and its cached
rows. Clearing a chat (`POST /bots/:name/chat/reset`) does NOT: the retired session's photos stay
fetchable by `fileId` until they expire, which is consistent with what a reset actually does, since
the retired transcript itself also stays on the Hermes host. A client that wants the photos gone as
well as the chat cleared is asking for a deletion this surface does not offer.

### GET /bots/:name/media

Capability `>= 7`.

```
GET /bots/:name/media?src=<url-encoded absolute https URL>

200  <the image bytes>
     content-type: one of the allowed image types below
     cache-control: private, max-age=86400
     x-content-type-options: nosniff
     x-cozy-media-source: the URL that was actually fetched, after redirects

400  invalid_request                  // src missing, empty, or over 2048 characters
400  media_refused  reason: "local_path" | "scheme" | "host" | "credentials"
413  media_refused  reason: "too_large"
415  media_refused  reason: "content_type"
502  backend_unavailable              // the source host failed, did not resolve, or answered non-2xx
                                      // + sourceError, and sourceStatus when there was one
503  backend_unavailable  busy: true  // nothing was dialed: the gateway is already fetching as many
                                      // images as it will at once. + waitedMs, retry-after: 1
504  backend_unavailable  timedOut: true
```

A bot writes image references into its replies two ways: an `https` URL, and a path on the machine
Hermes runs on (an `image_gen` output, a screenshot). This route answers the first kind and REFUSES
the second, which is the whole of what version 7 adds.

**Local paths are refused, deliberately.** A `reason: "local_path"` answer is what a client gets for
`/Users/kyle/out.png`, `C:\out.png`, `~/shot.png`, and `file:///tmp/x.png` alike. Serving an
arbitrary local path from an authenticated route is a file-read primitive over the whole box, and
the containment that would make it safe (a resolved allow-root, realpath checks against symlinks, a
per-bot output directory Hermes does not currently promise) is a design rather than a guard. The
refusal is in the contract, and carries its own `reason`, so a client can render an honest chip
("this bot pointed at a file on its own machine") instead of a spinner that never resolves or a
generic failure. A later version may add local sources; it will be additive and gated on its own
number.

The `:name` in the path scopes the route to a bot for symmetry with everything else under
`/bots/:name`, and is validated the same way, but it is NOT resolved against Hermes. The answer does
not depend on which bot's reply carried the URL, and a Hermes outage must not stop an image that is
already sitting on a CDN from loading. A name that could not name a profile is still a 400.

What the proxy will fetch:

- `https` ONLY. `http`, `file`, `data` and everything else is `reason: "scheme"`.
- No credentials in the URL (`reason: "credentials"`).
- Not a loopback, private, link-local, carrier-grade-NAT or multicast address (`reason: "host"`).
  The gateway sits inside the operator's network and the `src` it is handed comes out of model
  output, so without this an authenticated app route becomes a probe of the operator's LAN and of
  every cloud metadata endpoint on `169.254.169.254`. The rule is applied TWICE: to the address
  literal in the URL, and to every address the URL's hostname resolves to, on the initial URL and on
  each redirect hop. A name is resolved before anything is dialed, so `https://10.0.0.5.nip.io/` is
  refused for the same reason `https://10.0.0.5/` is. A v4 address written inside a v6 one
  (`::ffff:`, the deprecated `::` form, the `64:ff9b::` NAT64 prefix) is unwrapped and judged as the
  v4 address it carries, so no spelling of a private address gets a different answer than another,
  and a public address inside those prefixes stays allowed. A trailing FQDN root dot is stripped
  before any of it, so `localhost.` and `nas.local.` are the same names as `localhost` and
  `nas.local`.

  What this does NOT close, stated plainly rather than implied away: the resolver is asked here and
  the socket asks again, so a name that answers publicly at the check and privately a moment later
  (DNS rebinding, a short-TTL record) still reaches a private address. Only pinning the connection to
  the address that was checked closes that, and this version does not do it. What is closed is the
  part that costs an attacker nothing: pointing a public hostname at a private address.
- At most 3 redirects, each hop re-checked against every rule above rather than followed blind.
- 15 s for the whole exchange, headers and body, so an upstream that dribbles cannot hold a
  connection open.
- At most 10 MB, enforced against the declared `Content-Length` AND against the bytes that actually
  arrive, because the header is a claim and the body is the fact. A body that runs past the cap
  mid-stream is cut off, so a client can see a truncated image; the declared-length case is a clean
  413.
- Content type on an allow-list: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/heic`,
  `image/heif`, `image/avif`, `image/bmp`, `image/tiff`. Note what is NOT on it: `image/svg+xml`.
  SVG is a document format carrying script and external references, and passing one through an
  authenticated route hands a bot's text a way to run markup inside whatever renders it. The
  allow-list is a list, not an `image/*` prefix test, for exactly that reason.

**At most 5 of these run at once, per GATEWAY.** Not per device: what is being protected is the
gateway process's sockets and the household's uplink, and both are shared by every paired device, so
a per-device cap would multiply the fan-out by the number of phones instead of bounding it. The slot
is held for the whole fetch including the body, because a socket dribbling bytes costs what a socket
being negotiated costs. The bound matters because one reply can carry fifty image references and a
client asks for all of them: without it that reply is fifty simultaneous outbound fetches, each
allowed 10 MB and 15 s.

A request that arrives with all five slots busy WAITS, for at most 5 seconds, and is then refused
with `503` and `busy: true`. The bounded wait is the middle of two worse answers. An unbounded queue
is wrong because the 15 s fetch timeout only starts once a slot is held: a queued request's total
latency would be unbounded no matter what the per-fetch timeout says, and a client would have no way
to tell a request stuck in a queue from a host that is simply slow. Refusing instantly is wrong the other way: the ordinary deep
queue is a burst of thumbnails that each finish in well under a second, and refusing those would make
a normal gallery flicker with errors. So: wait through the burst, give up before a stalled upstream
can hide behind the queue.

`503 busy` says nothing about the source. It carries `waitedMs` and a `retry-after: 1` header, and a
client should treat it as "ask again", ideally when the image is scrolled back into view, rather than
as a failure to show in a fallback chip. It is the one error here that a retry of the same URL is
expected to clear.

`x-content-type-options: nosniff` rides every 200. The content type is already taken from the
allow-list below, and this stops anything downstream from improving on it.

Range requests are not supported and `Accept-Ranges` is not sent: the cap is 10 MB, so the answer is
always one whole image.

`cache-control: private, max-age=86400` is the point of the header set. The source URL is in practice
immutable (a generated asset, a CDN object), so a day of caching removes the re-fetch every time a
transcript is scrolled back through; `private` because the bytes came through a device-token route
and belong to that device, not to any shared cache.

### GET /bots/:name/sessions

```
200 {
  sessions: [ {
    id: string,
    startedAt: integer,                // milliseconds; 0 when Hermes omits it
    lastActiveAt: integer,             // milliseconds; 0 when Hermes omits it
    kind: "conversation" | "cron" | "routine" | "group" | "a2a",
    title?: string,
    preview?: string
  } ],
  activeSessionId: string | null
}
404 not_found                         // no profile named `name` exists
```

The bot's visible Hermes session list, capped at 200 rows and kept in Hermes' newest-first order.
`activeSessionId` is the canonical-chat pin and may name an unwritten session that has no list row
yet. The `kind` classifier is the exact classifier the capability-14 pin-follow rule uses: cron
source or id shape, `Routine: ` title, `Group: ` title, then bot-to-bot preview, with conversation as
the default.

### POST /bots/:name/sessions/:id/adopt

```
200 { name: string, sessionId: string, previousSessionId: string }
404 not_found                         // no such bot or no visible session with this id
409 conflict                          // the session belongs to another bot
```

Manually makes the selected session the bot's canonical chat. A session retired by a prior reset is
restored rather than deleted or copied. The gateway broadcasts `bot_chat_adopted` with the same
fields as an automatic capability-14 adoption, including when the selected session was already
active, so every device rebinds and re-reads.

The manual flag sticks until the next new conversational session appears. Cron, routine-titled,
group-titled, and a2a sessions never release it. No separate persistence object is introduced: the
existing pin row carries the flag and its existing update timestamp is the boundary.

### GET /bots/:name/profile

One bot's full edit-screen state: SOUL.md, its skills, its toolsets, its MCP servers, and its model
pin. This is the read half of the desktop's Edit Profile dialog, reimplemented server-side.

```
200 BotProfile
404 not_found                         // no profile named `name` exists
502 backend_unavailable + hermesError // hermes answered and refused
```

Hidden profiles (`hermes.hiddenProfiles`) are editable by name, the same way they stay chattable by
name: hiding is a roster filter, not an access rule. `:name` is lowercased before use, so
`/bots/Scout/profile` and `/bots/scout/profile` address one bot.

Full response example:

```json
{
  "name": "scout",
  "description": "watches CI",
  "soul": "# Scout\nWatches CI and reports failures.\n",
  "skills": [
    { "name": "ci-watch", "enabled": true },
    { "name": "deploy", "enabled": false, "description": "ships a release" }
  ],
  "toolsets": [
    { "name": "files", "enabled": true, "label": "Files", "description": "read and write", "toolCount": 7 },
    { "name": "shell", "enabled": false, "label": "Shell", "description": "run commands", "toolCount": 2 }
  ],
  "toolsetsPinned": true,
  "mcpServers": [
    { "name": "github", "installed": true, "enabled": true, "description": "issues and PRs", "transport": "stdio" },
    { "name": "linear", "installed": true, "enabled": false, "transport": "http" },
    {
      "name": "slack",
      "installed": false,
      "enabled": false,
      "description": "messages",
      "transport": "stdio",
      "requires": ["SLACK_TOKEN"],
      "fromCatalog": true
    }
  ],
  "model": { "provider": "nous", "default": "hermes-4" },
  "runtimeInert": ["toolsets", "mcpServers"]
}
```

Field notes, in the order a client will hit them:

- `description` is the profile's own description, the same string `BotSummary.description` carries
  (except that it is `""` here rather than `null` when unset). It is READ-ONLY on this route; the
  patch body does not accept it.
- `soul` is the whole SOUL.md file, `""` when the profile has none.
- `model.provider` / `model.default` are both `""` when the profile pins no model and inherits the
  launch profile's. `default` is the model ID, and keeps the gateway's own field name.
- `toolsetsPinned` says whether the profile carries an `enabled_toolsets` pin at all. Without a pin,
  every `toolsets[].enabled` reflects the platform default rather than a choice anyone made, which
  is the difference between "the user turned these on" and "nobody has decided yet".
- `label`, `description`, `toolCount`, `transport`, `requires`, `auth` and `fromCatalog` are all
  OPTIONAL and are omitted when the gateway carried nothing for them.
- `runtimeInert` is always present. Render the sections it names with the honesty note described
  under `PATCH /bots/:name/profile`, and gate on this field rather than on a backend version.

THE THREE LIST SEMANTICS. They are not the same, and a client that treats them uniformly writes the
opposite of what its user chose:

| Section | Read | Write field | Write semantics |
|---|---|---|---|
| skills | `skills[].enabled`, already resolved | `disabledSkills` | The names to turn OFF. INVERTED against the read: send the UNCHECKED names. |
| toolsets | `toolsets[].enabled` + `toolsetsPinned` | `enabledToolsets` | The names to turn ON. `[]` CLEARS the pin (everything enabled again), it does NOT disable everything. |
| mcpServers | `mcpServers[].enabled` | `enabledMcpServers` | The names to turn ON. Replace semantics; a name the gateway does not know is skipped, never invented. |

> **KNOWN ISSUE: two of these three sections are saved but do not take effect yet.**
>
> On Hermes 0.20.3 and 0.20.4, `enabledToolsets` and `enabledMcpServers` are written, persisted and
> read back correctly, and every screen shows the state the user chose. Neither changes what the bot
> can actually do at runtime. This is an upstream defect, not a gap in this gateway: the desktop
> Edit Profile dialog has the identical hole.
>
> - **Toolsets.** `profiles.configure` writes `tools.enabled_toolsets`. Exactly two things in the
>   whole backend read that key: `profiles.describe` (which is what the edit screen shows back) and
>   the bot-mode capability fingerprint. Runtime toolset resolution reads `platform_toolsets` for
>   the platform instead. The pin is describe-visible only.
> - **MCP servers.** `profiles.configure` writes a per-server `disabled` key, and `profiles.describe`
>   reads it. Nothing else does. Every runtime consumer, and the MCP catalog's own `is_enabled`,
>   reads the `enabled` key instead.
>
> The fingerprint DOES change, so a save rebuilds the capability epoch and the system prompt: the
> user sees activity, just not the effect. Without this note the first bug report is "I turned off
> the shell toolset on my phone and the bot still ran shell commands."
>
> **What a client should do.** Keep sending both sections (they are accepted, persisted and
> forward-compatible, so a backend that starts honouring them needs no client change), and surface
> those two sections with an honesty note: *saved, takes effect when the gateway supports it*. Gate
> the note on `BotProfile.runtimeInert` from `GET /bots/:name/profile`, which names exactly the
> sections this gateway knows to be inert (`"toolsets"`, `"mcpServers"`, and it shrinks when a
> backend fixes them). Do NOT sniff a backend version: nothing on this wire carries one a client can
> trust. `disabledSkills` is NOT affected and takes effect normally.

Why skills invert: the backend stores a DISABLED list, so an installed skill is enabled unless its
name is in that list. Echoing the enabled names back would disable exactly the skills the user kept.
A skill row that carries no `enabled` field at all is enabled, for the same reason.

Two caveats on the skills round trip, both upstream behaviours the desktop shares, both of which
matter because this document tells a client exactly how to compute `disabledSkills`:

- `disabledSkills` is REPLACE semantics against a list the read cannot fully see. `skills[]`
  enumerates only the skills installed under the profile's own skills directory, while the stored
  disabled list can legitimately hold names that are not there: a skill that was disabled and then
  uninstalled, and project-local or external-directory skills the runtime scans but the read does
  not enumerate. Saving the computed set silently RE-ENABLES those. A client that must not do that
  has no way to avoid it on this version; a client that shows a "reset skills" affordance should at
  least not present the save as a no-op.
- A disable can also be a no-op in the other direction: the read keys a skill on its DIRECTORY name
  while the runtime matches the skill's declared `name`, and the read's comparison is
  case-insensitive while the runtime's is not. Where the two disagree, a name sent in
  `disabledSkills` matches nothing at runtime.

Why an empty `enabledToolsets` means "all of them": the backend stores an optional PIN, and popping
the pin restores every toolset. The desktop exploits this and sends `[]` both when everything is
checked and when nothing is, because "all of them" and "no opinion" are the same backend state. A
client may copy that, or send the checked names literally; only `[]` clears the pin.

How `mcpServers` is assembled: it is a UNION of two sources, and the two carry different truths.

- The servers the PROFILE defines come first, in the gateway's order. `installed` is `true` for all
  of them (the profile carries their definition) and `enabled` is the inverse of the backend's
  `disabled` flag. A defined-but-disabled server is `installed: true, enabled: false`.
- Servers from the bundled catalog that the profile does NOT define follow, marked
  `fromCatalog: true`. They are always `enabled: false` for this bot, even though the catalog row's
  own `enabled` flag may say otherwise. Not because that flag describes some other profile: this
  route asks for the catalog SCOPED to the bot, and the backend resolves `installed` and `enabled`
  under that scope, so the flags already describe this bot. The reason is narrower and stronger. A
  row absent from the profile's defined servers is by construction absent from the very config the
  scoped flag resolves through, so a `true` there cannot describe this bot under any reading, and
  forcing `false` states that invariant rather than trusting it. (The launch-profile caveat is real
  for `GET /bots/catalog`, which asks UNSCOPED. See that route.) Turning one on is supported: the
  backend copies its definition from the launch profile on write.
- `requires` lists the environment keys the server needs before it will work, so a client can mark a
  row as needing setup. `auth` is a hint about how the server authenticates and is present only when
  the gateway sends one (Hermes 0.20.3 does not, so treat its absence as "unknown", not as "none").
- When the gateway has no MCP catalog at all, the response still carries the profile's own servers
  and simply offers nothing extra. The catalog half is best-effort by design.

### PATCH /bots/:name/profile

The write half. Every field is optional and ONLY the fields present are written, which is the
desktop's "send just the dirty sections" rule: a section that is not on the wire is not touched and
gets no verdict back.

```
body {
  soul?: string,                      // 0..200000, full SOUL.md replacement
  disabledSkills?: string[],          // names to turn OFF (see the inversion above)
  enabledToolsets?: string[],         // names to turn ON; [] clears the pin
  enabledMcpServers?: string[]        // names to turn ON, replace semantics
}
200 { name: string, outcome: "applied" | "unsupported", ok: boolean,
      applied: { [section: string]: boolean }, requested: string[] }
400 invalid_request                   // malformed body, or none of the four fields present
404 not_found                         // no profile named `name` exists
502 backend_unavailable + hermesError
```

A body carrying none of the four fields is a 400, not an empty success: a client that sends nothing
has a bug, and answering it with an empty `applied` map hides it.

`soul: ""` CLEARS SOUL.md. It writes a zero-byte file, it is not a no-op and it is not the same as
omitting the field: omitting leaves the existing SOUL.md untouched, sending `""` empties it. Every
name in the three lists must carry at least one non-whitespace character; a whitespace-only name is
a 400 rather than being forwarded, because the backend would filter it and leave `enabledToolsets`
EMPTY, which pops the pin and enables everything. Names are trimmed and deduped at this boundary.

**Two sections of this body are runtime-inert on Hermes 0.20.3 / 0.20.4.** See the KNOWN ISSUE
under `GET /bots/:name/profile`, and gate the client-side note on `BotProfile.runtimeInert`.

CONCURRENCY. This gateway serializes patches PER BOT: two overlapping saves of the same bot run one
after the other, never at once, because the backend's write is a read-modify-write across up to
three separate save cycles and two overlapping calls silently lose the loser's sections. What is NOT
offered on this version is optimistic concurrency: there is no ETag or version on
`GET /bots/:name/profile`, so a read, a user edit and a patch is a lost-update window against any
writer this gateway does not see (a desktop editing the same profile directly). A client that keeps
an edit screen open for a long time should re-read before saving.

Request example, all four sections at once:

```json
{
  "soul": "# Scout\nWatches CI and reports failures.\n",
  "disabledSkills": ["deploy"],
  "enabledToolsets": ["files"],
  "enabledMcpServers": ["github", "slack"]
}
```

Response example:

```json
{
  "name": "scout",
  "outcome": "applied",
  "ok": true,
  "applied": { "soul": true, "skills": true, "toolsets": true, "mcp_servers": true },
  "requested": ["soul", "disabledSkills", "enabledToolsets", "enabledMcpServers"]
}
```

`applied` is the gateway's own per-section map, echoed VERBATIM: its key names, its booleans,
including a section this extension does not model. It is deliberately NOT renamed to the request's
field names, so a client reads exactly what the backend said. The mapping between the two:

| Request field | `applied` key |
|---|---|
| `soul` | `soul` |
| `disabledSkills` | `skills` |
| `enabledToolsets` | `toolsets` |
| `enabledMcpServers` | `mcp_servers` |

`requested` echoes the body's fields, in that same order, so a client can pair a section with the
key that answers for it without hardcoding the table.

`ok` is computed over the REQUESTED sections only. A requested section whose key is missing from
`applied` counts as NOT applied (the backend silently ignored it), while an extra key the backend
volunteered is reported but never makes a successful write read as a failure.

`outcome` is the older-gateway signal, the same three-way reading this surface already uses for
`ui_meta` writes:

- `"applied"`: the gateway answered with an `applied` map, reproduced above.
- `"unsupported"`: the gateway answered with NO `applied` map at all. That is an older backend that
  does not report per-section results. The write may well have landed, but nothing can confirm it,
  so `ok` is `false` and `applied` is `{}`. A client should treat this as "we cannot tell" and
  re-read the profile, NOT as an error to put in front of a user. No shipped Hermes does this: every
  known version answers with an `applied` map, possibly empty. Handle it as forward compatibility,
  not as a case to design a screen around.

```json
{ "name": "scout", "outcome": "unsupported", "ok": false, "applied": {}, "requested": ["soul"] }
```

A partial failure is reported honestly rather than collapsed:

```json
{
  "name": "scout",
  "outcome": "applied",
  "ok": false,
  "applied": { "soul": true, "skills": true, "toolsets": false, "mcp_servers": true },
  "requested": ["soul", "disabledSkills", "enabledToolsets", "enabledMcpServers"]
}
```

NOT in this version: `model` / `provider`, and the profile `description`. Both are writable upstream
but each carries a second mechanism the desktop reaches for (clearing a model pin runs a CLI command
rather than a configure call, and the desktop writes descriptions through the CLI too), so they are
deferred rather than half-modeled. A later version can add them additively.

The roster is refreshed behind a patch, so a `bot_roster` frame follows shortly.

### GET /bots/catalog

The menus the edit screen offers: installable skills, the MCP server catalog, and the model
inventory. Aggregated from three gateway calls into one round trip, because this is a screen OPEN,
not a poll.

```
?q=<skill search>                     // optional, 0..200 chars; omitted or empty searches broadly
200 BotCatalog
400 invalid_request                   // q longer than 200 characters
```

This route is NOT per-bot: it is the menu, and per-bot state comes from `GET /bots/:name/profile`.
`catalog` is a literal path segment and is never read as a bot name.

Response example:

```json
{
  "query": "ci",
  "skills": [
    { "name": "ci-watch", "description": "watch CI and report failures" }
  ],
  "mcpServers": [
    {
      "name": "github",
      "description": "issues and PRs",
      "installed": true,
      "enabled": true,
      "requires": [],
      "transport": "stdio"
    },
    {
      "name": "slack",
      "description": "messages",
      "installed": false,
      "enabled": true,
      "requires": ["SLACK_TOKEN"],
      "transport": "stdio"
    }
  ],
  "models": [
    { "slug": "nous", "name": "Nous", "models": ["hermes-4", "hermes-4-mini"] }
  ],
  "unavailable": [],
  "updatedAt": 1800000000000
}
```

- `query` echoes the search this catalog was built for, so a client can drop a stale answer.
- `skills[]` is a hub SEARCH, not the bot's installed set (that is `BotProfile.skills`). Installing
  one is not part of this version.
- `mcpServers[].enabled` here describes the LAUNCH profile, not any bot. For a bot's own state read
  `BotProfile.mcpServers`. `requires` is always present, possibly empty; `auth` and `transport` ride
  along only when the gateway sends them.
- `models[].models` is a flat list of model IDs. Upstream returns model rows as bare strings on some
  builds and as objects on others; both are reduced to the ID, which is what a model write wants.
- `unavailable` names the sections whose gateway call was refused, which is how an older backend
  missing a method shows up. It is SORTED, so the same degradation reads the same way every time.
  Those sections are EMPTY rather than absent, so a client never special-cases a missing field:

```json
{ "query": "", "skills": [], "mcpServers": [], "models": [],
  "unavailable": ["models", "skills"], "updatedAt": 1800000000000 }
```

  A TRANSPORT failure is different and is not degraded: if the bridge is down the route answers 503
  rather than three empty lists.

CACHING, and the three cases are not the same:

- A COMPLETE answer (`unavailable` empty) is cached for 60 s per `q`.
- A DEGRADED answer (`unavailable` non-empty) is cached for a few seconds only. It is a report that
  a section could not be fetched, not the screen's data, and the most failure-prone of the three
  calls is the model inventory, which does live discovery against every configured provider. One
  flaky moment must not pin an empty model picker in front of a user for a full minute under a
  message that reads "your gateway is too old". It is cached at all, rather than not cached, so a
  client re-reading per keystroke cannot hammer a struggling backend.
- A TRANSPORT failure is not cached at all, so a gateway that was down when the screen opened is
  retried on the very next read.

Concurrent reads of the same `q` share one fetch, so two devices opening the edit screen together
cost one round of three calls. The cache holds a bounded number of recent queries and evicts the
oldest, so a client that reads per keystroke cannot grow it without limit.

### GET /bots/:name/routines

```
200 { name: string, routines: BotRoutine[], updatedAt: integer }
400 invalid_request                   // `name` is not a legal profile id (see below)
404 not_found                         // no profile named `name` exists
502 backend_unavailable + hermesError // hermes answered and refused
```

**The name rule, on all four routine routes.** `name` must match `[a-z0-9][a-z0-9_-]{0,63}`, the
Hermes profile id rule, and a name that does not is a 400 before anything reaches Hermes. The tag is
the entire ownership relation and it is parsed back out of a job name with that same charset, so a
profile called `a]b` would write `[bot:a]b] Title`, which reads as bot `a`: it would let one bot list
and DELETE another's routines, and orphan its own on creation. Profiles this gateway creates cannot
hold such a name; profiles created elsewhere can, so the routes check.

Every routine in this bot's `[bot:<name>]` namespace, plus the untagged jobs of its own cron store
(`legacy: true`, from version 13), and nothing else. Read fresh on every call: the answer carries
next-run times that go stale by the second, and the read has a side effect (see below) that a cache
would skip. Two devices reading at once share one round trip.

Full response example:

```json
{
  "name": "scout",
  "routines": [
    {
      "id": "job_7f2c19",
      "title": "Morning digest",
      "schedule": { "raw": "0 9 * * 1-5" },
      "enabled": true,
      "state": "active",
      "legacyUnsafe": false,
      "prompt": "[bot-mode:routine:v2] You are running the scheduled routine \"Morning digest\" for agent 's...",
      "lastRun": 1755424800000,
      "nextRun": 1755507600000,
      "lastStatus": "success",
      "repeat": "forever"
    },
    {
      "id": "job_04ba55",
      "title": "Inbox sweep",
      "schedule": { "raw": "every 120m", "human": "Every 2h" },
      "enabled": false,
      "state": "paused",
      "legacyUnsafe": false,
      "lastRun": null,
      "nextRun": null,
      "repeat": "3 times",
      "continuity": true
    },
    {
      "id": "job_9c31de",
      "title": "nightly backup",
      "schedule": { "raw": "0 3 * * *" },
      "enabled": true,
      "state": "active",
      "legacyUnsafe": false,
      "legacy": true,
      "prompt": "back up /srv to the NAS",
      "lastRun": 1755392400000,
      "nextRun": 1755478800000,
      "repeat": "forever"
    }
  ],
  "updatedAt": 1755428400000
}
```

The third row is a legacy one: an untagged cron job in `scout`'s own store, titled by its raw name,
carrying `legacy: true`. Its schedule, timestamps and switch read exactly like the two above it. It
can be paused, resumed and deleted; it cannot be rewritten (see `PATCH` below).

**The legacy auto-pause.** A routine is `legacyUnsafe` when it carries the `[bot:]` tag AND its
prompt begins with `You are running the scheduled routine "`. That is the pre-marker delegation
shape, which builds a shell command by interpolating a title that syncs from `ui_meta`: anything
that can write a bot's look can write a command line, and those jobs keep FIRING until something
pauses them. So this route pauses every active one it finds, exactly as the Hermes desktop does, and
reports the row as paused in the same response (`autoPaused: true`).

Three properties of that behavior are load-bearing and a client should not work around them:

- a pause that FAILS never fails the list. The routines still come back; only the jobs the backend
  actually paused are reported paused, and the next read retries the rest. A list that failed
  because a pause failed would put "could not load routines" over data that loaded perfectly, and a
  20 s poll would retry the failing pause inside the failing read forever.
- `legacyUnsafe` rows cannot be resumed through this API. Render them disabled with the desktop's
  own wording, *"Paused for security: delete and recreate this legacy cronjob before running it
  again."*, and offer delete only.
- a routine this gateway creates is never `legacyUnsafe`: its delegation prompt is prefixed with the
  marker `[bot-mode:routine:v2] `, which is what keeps it out of the `startsWith` check.

**How the auto-pause composes with legacy rows.** It does not reach them. The tag requirement in the
`legacyUnsafe` rule above is load-bearing rather than incidental, and listing untagged jobs did not
relax it: the danger in the pre-marker shape is that it interpolates a title synced from `ui_meta`
into a shell command, so anything that can write a bot's LOOK can write a command line. An untagged
job has no bot whose look could rewrite it, so it is not that shape however its prompt reads. A
`legacy` row therefore comes back `legacyUnsafe: false`, is never paused by a read, and is offered
with its switch live. This is the deliberate half of the trade: making a pre-routines schedule
visible must not be the same act as silently switching it off, which is the opposite of why it is
listed. An untagged job whose prompt happens to begin with the legacy sentence is still just an
untagged job.

### POST /bots/:name/routines

```
body { title: string, schedule: string, prompt: string, repeat?: integer, continuity?: boolean }
201  { name: string, routine: BotRoutine }
400  invalid_request                  // malformed body, a NUL in title/schedule/prompt, or a `name`
                                      // that is not a legal profile id (see below)
400  invalid_request + hermesError    // hermes ANSWERED the `add` with a refusal (`success: false`)
404  not_found                        // no profile named `name` exists
502  backend_unavailable + hermesError // hermes REJECTED the call: an unparsable schedule is this
502  backend_unavailable + hermesError + createdId?  // hermes ACCEPTED the add but the stored
                                      // routine could not be read back; see below
```

`schedule` is the RAW Hermes schedule string, composed exactly as the desktop's picker composes it.
The gateway does not validate its grammar; the backend owns that, and a gateway that guessed would
refuse schedules a newer Hermes accepts. What the backend accepts today:

| picker frequency | send | example |
|---|---|---|
| Once, in… | `<n><m\|h\|d>` | `30m` |
| Every hour | `every 1h` | `every 1h` |
| Every day | `<m> <h> * * *` | `0 9 * * *` |
| Weekdays | `<m> <h> * * 1-5` | `0 9 * * 1-5` |
| Every week | `<m> <h> * * <0-6>` | `0 9 * * 1` |
| Every month | `<m> <h> <day> * *` | `0 9 1 * *` |
| Interval | `every <n><m\|h\|d>` | `every 2h` |
| Advanced | raw user text | `every 1d`, `0 9 * * *` |

Durations accept `m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days`, one unit only: there is
no `1h30m`, no weeks, and no natural language. A cron expression must be 5 or 6 fields of digits and
`* - , /` (names like `MON` are refused). An ISO timestamp (`2026-02-03T14:00`) is accepted as a
one-shot and is anchored to the backend's configured timezone. Anything else is refused, and the
backend's own four-line usage message comes back in `hermesError`.

Two failure shapes, and they mean different things. A schedule the backend cannot PARSE raises
inside Hermes and comes back as a rejection: **502** with the usage message in `hermesError`. A cron
call Hermes ANSWERS with `success: false` is not a transport failure at all, and which status it
gets depends on WHOSE input the refused call carried:

- a refused **`add`** is **400** with the backend's text in `hermesError`. That call carries a
  schedule, a title and an instruction the client composed, so the input really was the client's.
- a refused **`list`**, **`pause`**, **`resume`** or **`remove`** is **502**, same `hermesError`.
  A list carries no client input at all, and the row actions carry only a job id the gateway already
  resolved inside the bot's own namespace (an id that resolves to nothing is a 404, before the call
  goes out). Reporting those as `invalid_request` would put "check what you typed" over a GET with no
  body, which is what an older or scoping-hostile Hermes turned the whole routines pane into.

`repeat` is "stop after N runs", blank meaning forever; the desktop offers it for every frequency
except Once and Advanced. `continuity: true` injects the previous run's output into the next run's
prompt (it does NOT reuse a session; see below).

`prompt` is the routine's INSTRUCTION in the user's own words. Do not build a delegation wrapper: the
gateway decides how the instruction is delivered, and a client-built wrapper is exactly the shape the
legacy auto-pause exists to kill. The response carries the routine the backend actually STORED, not
an echo of the request, because the schedule is normalized and the first run time is computed.

That rule holds on the failure path too, which is where it matters most. `add` normally answers with
the created row embedded; a build that answers without one is READ BACK once, by the id the reply
carried, and the stored job is what comes back. When the read-back finds nothing, the answer is a
502, never a 201 built out of the request: a routines pane rendering the string the user typed, in a
shape the backend does not store, at the exact moment the round trip failed, is the one outcome worth
refusing. `createdId` is present whenever the `add` reported an id, because the routine may really be
there; list the routines to find out, and delete the leftover by that id if it is. Do NOT blindly
retry this 502 (or accept a second Save tap for it): the add likely landed, and each retry can add
another live schedule. List first.

### PATCH /bots/:name/routines/:id

```
body { title?: string, schedule?: string, prompt?: string, enabled?: boolean,
       repeat?: integer, continuity?: boolean }
200  { name: string, routine: BotRoutine, replacedId?: string, orphanedId?: string }
400  invalid_request                  // no fields, a rewrite field without prompt, a rewrite of a
                                      // `legacy` routine, or a `name` that is not a legal profile id
400  invalid_request + hermesError    // hermes ANSWERED the `add` with a refusal (`success: false`)
404  not_found                        // no profile named `name`, or no routine `id` for this bot
502  backend_unavailable + hermesError // hermes REJECTED the call, or ANSWERED a pause/resume/remove
                                      // with a refusal
502  backend_unavailable + hermesError + createdId?  // the replacement was accepted but could not be
                                      // read back; the old routine is left PAUSED, see step 2 below
```

Two very different operations, and the difference is the backend's rather than this API's invention:

**`enabled` alone is the row switch.** `true` resumes, `false` pauses, and the routine keeps its
`id`. This is the desktop's switch, and the pause/resume it performs is the same one. It is the only
patch a `legacy` routine takes.

**A rewrite of a `legacy` routine is a 400, always.** Not a 404 and not a backend failure: the job is
right there, it is listed, and pause, resume and delete all work on it. What the gateway will not do
is recreate it under the `[bot:]` tag with a new id, which is what any rewrite would mean and which
is a conversion rather than an edit. Convert one by DELETING it and creating a routine with the
schedule and instruction you want; the new routine gets a new id and appears without `legacy`. The
gateway never renames or rewrites a legacy job on its own.

**Anything else is a REWRITE, and the routine's `id` CHANGES.** `repeat` and `continuity` are on
that side of the line too: neither reaches the backend except on an `add`, so a patch naming one
cannot be honored without the rewrite. `cron.manage` exposes no update
action at all on Hermes 0.20.3 and 0.20.4 (the tool behind it has one; the gateway does not route to
it), so an edit is a recreate. The gateway performs it in an order chosen so no failure can leave a
routine firing twice or half-edited:

1. the existing job is PAUSED, so from that moment it cannot fire. A pause that fails aborts the
   whole edit, since the alternative is a window with two live schedules.
2. the replacement is CREATED. If that fails (an unparsable schedule is the common case) the old job
   is resumed back to the state it was in and the failure is reported: the routine is exactly as it
   was before the edit was attempted. The one create failure that is NOT rolled back is a
   replacement the backend accepted and the gateway could not read back: it may already be running,
   and resuming the old one on top of it is exactly the double schedule this ordering exists to
   prevent. The old routine stays paused, the error carries `createdId`, and a list says which jobs
   are really there. On this path the old job is also never REMOVED and no `orphanedId` is
   reported: the old routine keeps its id, paused, and its own switch turns it back on. The retry
   warning above applies here too, doubled: a blind retry can leave the unconfirmed replacement AND
   a second replacement both live.
3. the old job is REMOVED. If THAT fails, the new routine exists and the old one is still paused, so
   nothing double-fires; its id comes back as `orphanedId` and is deletable through
   `DELETE /bots/:name/routines/:id`.

`replacedId` is always present on a rewrite. A routine that was switched OFF stays off across a
rewrite: an edit is not a resume. `enabled` sent ALONGSIDE the rewrite fields is honored rather than
ignored, so `{ title, prompt, enabled: true }` on a paused routine comes back running.

Two rules follow from the backend and cannot be papered over:

- **`prompt` is REQUIRED whenever `title`, `schedule`, `prompt`, `repeat` or `continuity` is
  present.** The backend reports only a 100-character preview of a stored prompt, so a rewrite that
  reused it would silently truncate the user's instruction. A client's edit form must carry the
  instruction it wants the routine to end with, not the preview it read back.
- **Everything else IS carried over.** A rewrite is a delete and a create, so any field the patch
  does not restate would otherwise be lost; the gateway restates them from the routine it is
  replacing. The run cap is recovered from the display string (`3 times` is carried as 3, and a
  part-run `1/3` as the 2 runs that remain), so fixing a typo in a title cannot turn a bounded
  routine into a forever one. A shape the display string cannot express (an unknown word) is the one
  case that cannot be recovered, and the replacement is uncapped.

### DELETE /bots/:name/routines/:id

```
204                                   // gone
400 invalid_request                   // `name` is not a legal profile id
404 not_found                         // no profile named `name`, or no routine `id` for this bot
502 backend_unavailable + hermesError // hermes answered the removal with a refusal
```

Not idempotent: a second delete answers 404, by the same rule `DELETE /bots/:name` follows. An id
that names a job this bot does not own is a 404, never a delete: another bot's tagged routine, and
any job in another store, are both refused here exactly as they are hidden from the list. A `legacy`
routine deletes like any other, and delete-then-create is how a client converts one.

### Where a routine's runs land

Stated plainly, because it is the one place a client's mental model is likely to be wrong, and the
answer is not what "runs land in its own chat history" suggests.

**A routine's output does NOT appear in the bot's canonical `Bot Chat`.** Every cron fire mints a
brand new session, `cron_<job_id>_<timestamp>`, titled `<job name> · <Mon DD HH:MM>` with source
`cron`, and ends it when the run finishes. Nothing in the cron path resumes `Bot Chat`, and
`continuity: true` does not change this: it injects the previous run's OUTPUT FILE into the next
run's prompt, and still mints a fresh session. So `GET /bots/:name/chat/messages` will not show
routine output, and a client must not present the routines pane as if it would.

Those cron sessions are not hidden, and `session.list` does not filter source `cron`, so they DO
appear in `GET /bots/:name/sessions` as one row per run. That list is where a client can surface
"what did this routine do", by title and time.

Where the run happens depends on the delivery the gateway chose, which follows the desktop's rule:

- when the routine's bot is the profile the gateway's own Hermes runs as (`hermes.bridgeProfile`),
  the stored prompt is the bare instruction;
- otherwise the instruction is wrapped in a marker-prefixed delegation that runs
  `hermes -p <bot> chat -c "Routine: <title>" -q "[Scheduled routine] <instruction>"`, so the run
  reaches that bot's own history rather than the scheduler's. That delegated run lands in a session
  titled `Routine: <title>`, which again is not `Bot Chat`.

One operator-level caveat, stated because a client cannot detect it and will otherwise be blamed for
it: cron storage is per Hermes home, and a job created with `profile: <bot>` is written to that
bot's own cron store. It fires only if a Hermes scheduler is actually running for that profile. A
routine created against a profile nothing is running will sit there, correctly stored, and never
fire. The gateway does not claim otherwise, and there is no field on the wire that can promise it.

### POST /bots/focus

```
body { screen: "roster" | "routines" | null }
200  { ok: true }
```

The app declares what it is looking at. The bridge polls Hermes at the desktop's own cadences
(roster every 5 s, routines every 20 s) only while some device is focused on that screen, and
idles completely otherwise. A focus declaration expires by itself after 60 s of silence, so a
device that disappears cannot pin the bridge into polling forever: an app that wants to keep the
roster warm must re-POST inside that 60 s window. Where Hermes offers a change broadcast the bridge
refreshes on the event instead, which is cheaper than any poll; a change that arrives while a
refresh is already running costs exactly one more refresh, after it.

### GET /bots/groups

```
200 { groups: BotGroup[] }
```

Every room this gateway hosts, oldest first. No Hermes round trip: rooms are the gateway's own
state (see "Group chats" below), so this route answers from SQLite and is always current.

### POST /bots/groups

```
body { name: string, members: string[] }   // name 1..64, members 2..6
201  { group: BotGroup }
400  invalid_request                       // bad body, member count out of bounds, reserved name,
                                          // or members that are not bots here (all of them named)
409  conflict                              // a room with that name (case-insensitively) exists
```

```
POST /bots/groups
{ "name": "Release Room", "members": ["scout", "luna"] }

201
{ "group": { "name": "Release Room", "members": ["scout", "luna"],
             "createdAt": 1800000000000, "state": "settled", "needsYou": false,
             "epoch": 0, "updatedAt": 1800000000000 } }
```

Member names are canonicalized the same way every `/bots/:name` route canonicalizes its path
parameter (trimmed, lowercased), and DUPLICATES COLLAPSE: `["scout", "Scout"]` is one member and
therefore fails the two-member floor with a 400 rather than creating a room that talks to itself.

Every member is validated BEFORE the room is written, so a create either yields a room whose
membership is real or yields a 400 and no room at all, and the error names EVERY member that is
missing rather than only the first. Membership is fixed at create; there is no edit route yet (see
section 7).

The check reads a FRESH profile list rather than the gateway's roster cache. A cache is only ever as
young as its last refresh, and a stale yes here is not a cosmetic problem: the room is durable, its
first round hands each member name to `session.create`, and a Hermes that does not know the name
CREATES a profile for it. A bot deleted moments before the room was made would come back as a bare
profile that no later roster could tell from a real one. For the same reason a member that vanishes
while a room is deliberating is dropped from the round with a `bot_group_state` note ("<bot> is no
longer a bot on this gateway") instead of having a session minted for it.

Six room names are RESERVED and answer 400: `profile`, `chat`, `sessions`, `messages`, `catalog`,
`focus`. `/bots/groups/:name` and `/bots/:name/<suffix>` are both three segments, and the per-bot
routes are matched first so that a bot literally named `groups` keeps working. Refusing those six
names is the other half of that bargain: no room can exist at an address that would not reach it.

On the same reasoning, a name carrying `/`, `\`, `?`, `#`, `%` or a control character answers 400.
The name IS the path segment the room lives at, and a room whose address only resolves when the
client percent-encodes it exactly right is a room some client will fail to reach. Spaces are fine
(`Release%20Room` above), and every other printable character is fine.

### GET /bots/groups/:name

```
200 BotGroupDetail
404 not_found
```

The room and its whole transcript (at most 96 entries; older ones are trimmed).

This read CLEARS the room's `needs you` badge, which is the desktop's rule: opening the room is the
acknowledgement. The clear is broadcast as a `bot_group_state` frame, so the badge drops on every
device rather than only on the one that read it. The response itself always carries
`needsYou: false` for that reason.

### DELETE /bots/groups/:name

```
204 (no body)
404 not_found
```

Deletes the room, its transcript and its per-member watermarks. NOT idempotent: a second delete is a
404, by the same rule `DELETE /bots/:name` follows, so a client can tell "already gone" from "the
delete broke".

What it does NOT delete is each member's `Group: <name>` session inside Hermes. That is the bot's own
memory of the conversation, removing it is not this route's business, and a room later recreated
under the same name picks those sessions straight back up.

### POST /bots/groups/:name/messages

```
body { text: string, clientId?: string }   // text 1..32000
202  { group: string, message: BotGroupMessage }
400  invalid_request
404  not_found
```

```
POST /bots/groups/Release%20Room/messages
{ "text": "@luna how is the plan looking?", "clientId": "c-1" }

202
{ "group": "Release Room",
  "message": { "seq": 1, "from": { "kind": "user", "name": "You", "displayName": "You" },
               "text": "@luna how is the plan looking?", "at": 1800000000000, "clientId": "c-1" } }
```

202, not 200: the message is durable and the deliberation it starts runs afterwards, in the gateway.
Every reply arrives over `/ws` as `bot_group` frames, with `bot_group_state` around them. Nothing in
this request waits on a member turn, which is the entire point of hosting the room server-side: the
phone can be locked before the first bot answers.

The body carries the entry the gateway committed, so the app can render the user's own message
immediately. `clientId` is echoed there and on the same entry when it arrives in a `bot_group` frame.

### Group chats: how a room actually behaves

This is the one place where this gateway does something the Hermes desktop does NOT, and it is worth
stating exactly.

**Rooms are gateway-local.** The desktop plugin has no room object at all: it marks each bot's
`ui_meta` with a group name and runs the whole deliberation in the renderer, keeping the log in
browser storage. This gateway hosts the room instead: membership, transcript, watermarks and epoch
live in its SQLite. So a Hermes DESKTOP connected to the same Hermes gateway WILL NOT SEE these
rooms, their transcripts, or their membership. What it does see is the other half, which is stored
Hermes-side exactly as the desktop stores it: each member has a session titled `Group: <name>`
carrying its own side of the conversation. This is a deliberate trade (rooms that survive
backgrounding, restarts and second devices, in exchange for desktop visibility), not an oversight.

**The protocol itself is the desktop's, unchanged.** A user message starts a deliberation:

1. Responders are resolved from the log slice since the last user message. `@everyone`, `@all`, or
   NO mention at all means every member answers; otherwise only the members mentioned. A member
   named by a TEAMMATE joins from the next round, because responders are recomputed each round.
   Mentions resolve on a bot's name, its name with separators collapsed, its title, and its title's
   first word, so `@ops-runner`, `@opsrunner` and `@Ops` all reach the same bot. `@user` is the
   human and never resolves to a member.
2. Members take turns SERIALLY, never in parallel, in an order rotated by one per round so a
   different member leads each time.
3. A member is skipped in a round where nothing it has not already seen has landed. This is why a
   three-round deliberation between two bots usually posts four messages rather than six.
4. Each member is asked with a self-contained turn prompt naming the room, its own handle, its
   peers, and the transcript delta since its last turn (at most 24 lines). The rules travel in that
   prompt rather than in the bot's SOUL, so ANY existing bot can join a room with no profile change.
5. A member with nothing to add answers `(pass)` and nothing is posted. Passing is the healthy
   outcome; a round in which everybody passes settles the room immediately.
6. Caps: at most 3 rounds and at most 10 posted messages per user send, 2 to 6 members per room, 24
   delta lines per turn, 180 s per member turn, 96 entries of transcript retained.

**Failure is reported, never invented.** A member whose turn times out or fails posts NOTHING. The
room emits a `bot_group_state` frame carrying a `note` naming the member and the reason, and the
round continues with the other members. The gateway never writes a message on a bot's behalf. Two
non-failure conditions use the same note channel so they are not silent either: `reason: "capped"`
when the room stopped because it reached its 10-message limit for this send (`member` names the one
that was next in line), and `reason: "failed"` with a "no longer a bot" detail when a member's
profile was deleted after the room was created, which is skipped rather than retried every round.

**A newer user message supersedes an older deliberation.** Sending again bumps the room's `epoch`;
the loop still running checks the epoch at every member boundary and abandons the rest of its rounds
there, and the new deliberation takes over. The superseded loop stays silent about state: only the
current one ever emits `settled` or `needs_you`, so a stale settle cannot land on top of a live
conversation. A member turn already in flight when the supersession happens is NOT waited on, but it
is not thrown away either: the turn is read once more, and if the member's reply has ALREADY
completed it is posted (it was a real answer to a real question). If the member is still thinking,
the turn is abandoned, its answer stays in that member's own `Group: <name>` session, and the next
round's delta carries the conversation forward from there. Nothing after that turn runs either way.

**Deleting a room stops its deliberation.** `DELETE` answers immediately rather than waiting on a
member turn that can be up to 180 s from finishing, so a drive may still be winding down for a beat
afterwards. It writes nothing: a drive checks at every member boundary that the room it started
against is still the room living at that name, so a room deleted and recreated under the same name
never runs two deliberations at once, and the dead one's replies are dropped rather than posted into
the new room.

**`needs you`** is set when a member's reply mentions `@user`, and cleared when the user sends into
the room or opens it. `@user` has to START a mention, so an email address such as
`ops@user.example.com` is not an escalation. Setting it also raises a push notification through the
relay, for a device that is not holding a socket open, under the thread id `group:<name>`; devices
that were connected at that moment are excluded, because they already have the frame. Client-side
handling of the `group:<name>` thread id is a follow-up: a client that does not recognize it should
treat the push as a plain "a room wants you" and open the app.

**Restart behavior.** Everything except "a loop is running right now" is durable. A gateway that
restarts mid-deliberation comes back with the room, its transcript, its watermarks and its epoch
intact, and the room `settled`: the process that was driving it is gone, so nothing is running, and
the next user message starts a fresh deliberation from where the transcript left off.

### POST /bots/:name/approvals/:toolCallId/approve
### POST /bots/:name/approvals/:toolCallId/deny

Version 10 and up. Resolve one pending approval. No body: the verb IS the request, exactly as
`POST /threads/:id/interrupt` takes none, and a notification action button maps to a URL with
nothing to encode.

Only per-call scope exists on this wire. `approve` maps to the native Hermes `once`, which writes
nothing to the session or the permanent allow-list; `deny` maps to the native `deny`. The broader
native scopes (`session`, `always`) are deliberately not offered, a broker-boundary least-privilege
default, and the gateway never sends either string.

Server-authoritative, the same posture the core route has: the path carries a bot and a correlation
id and NOTHING else. `turnId` travels outward on the frames and is never accepted inward, the Hermes
runtime session id never appears on this wire in either direction, and records are kept per bot, so
a client cannot reach another bot's approval by guessing an id.

- `202 {"status": "approved"}` / `202 {"status": "denied"}`.
- `404 not_found`: no pending approval by that id for that bot.
- `409 approval_not_pending`: already approved or denied.
- `409 approval_expired`: it lapsed first, deliberately distinct from denied.
- `503 backend_unavailable`: Hermes could not carry the decision (an older build with no
  `approval.respond`, or a link that is down). The approval is still pending, and its own timer is
  still what will end it.
- `401` unauthenticated, like every other route here.

A resolution is audit-logged against the same `toolCallId` the frame carried, naming the bot, the
chat, the turn, the outcome and the deciding device, and never anything describing the action.

### Errors

The ordinary `ErrorBody` (`contract/v1.md` section 4) plus, when the failure came from Hermes,
the gateway's own text VERBATIM:

```
{ "error": { "code": "backend_unavailable", "message": "..." },
  "hermesError": "unknown method: session.list",
  "hermesErrorCode": 4001 }
```

- `502` with `hermesError`: Hermes answered and refused. Feature probes match
  `/unknown method/i` against `hermesError`, so it is never reworded.
- `503` with `hermesError`: the bridge is not connected, nothing reached Hermes.
- `504` with `hermesError` and `timedOut: true`: the call went out and did not answer inside its
  bound. Distinct from 503 on purpose, because the operation may still be running: for a delete, a
  retry can legitimately come back 404 once it finishes.

Four error CODES are added by this extension, on top of the core list in `contract/v1.md` section 4
(where `error.code` is a plain string precisely so an extension can add to it). A client that does
not know them treats them as a generic failure, which the HTTP status already conveys:

- `conflict` (409, `POST /bots`): the profile name is taken.
- `command_blocked` (502, `DELETE /bots/:name`): the gateway's command allow-list refused to run
  the profile delete; the body carries `blocked: true` and the gateway's own `hint`.
- `media_refused` (400/413/415, `GET /bots/:name/media` and `POST /bots/:name/chat/photos`): this
  gateway will not carry that image, in either direction. The body carries `reason` so a client can
  render a specific fallback without parsing prose.
- `rate_limited` (429, `POST /bots/:name/chat/photos`): this device has sent photos too quickly. The
  body carries `retryAfterMs` and the answer carries a `retry-after` header in whole seconds. It is a
  retryable answer and says nothing about the photo.

## 5. Presence

A bot is `active` when EITHER holds:

1. the Hermes gateway is routed to that bot's profile and is mid-turn (busy), or
2. `now_seconds - last_session.last_active < 90` (strict).

Because `lastActiveAt` is milliseconds on this wire and the rule is in seconds, a client that
recomputes presence locally must divide before comparing.

## 6. Server frames

All of them are additive members of the `ServerFrame` union on the existing per-device `/ws` socket, and
are only ever sent by a gateway that advertises the capability.

```
{ type: "bot_roster", bots: BotSummary[], updatedAt: integer }
{ type: "bot_presence", active: string[], updatedAt: integer }
{ type: "bot_chat", bot: string, sessionId: string, messages: BotChatMessage[], updatedAt: integer }
{ type: "bot_chat_state", bot: string, sessionId: string,
  phase: "polling" | "complete" | "timeout" | "failed",
  running: boolean, inflight: boolean, updatedAt: integer }
{ type: "bot_chat_delta", bot: string, sessionId: string, turnId: string,
  text: string, seq: integer, updatedAt: integer,
  done?: boolean, room?: string }
{ type: "bot_chat_reset", bot: string, sessionId: string,
  previousSessionId?: string, updatedAt: integer }
{ type: "bot_routines", bot: string, routines: BotRoutine[], updatedAt: integer }
{ type: "bot_group", group: string, messages: BotGroupMessage[], updatedAt: integer }
{ type: "bot_group_state", group: string,
  state: "running" | "settled" | "needs_you",
  round: integer, epoch: integer, note?: BotGroupNote, updatedAt: integer }
{ type: "bot_approval_pending", bot: string, sessionId: string, turnId: string,
  toolCallId: string, name: string, updatedAt: integer }
{ type: "bot_approval_resolved", bot: string, sessionId: string, turnId: string,
  toolCallId: string, outcome: "approved" | "denied" | "expired", updatedAt: integer }
```

`bot_roster` and `bot_presence` are FULL REPLACE snapshots, and both are sent only when the value
actually changed, so an idle gateway is silent. `bot_presence.active` carries profile names, in
roster order.

`bot_chat` is a DELTA: `messages` carries only what the gateway has not broadcast before for that
bot, in order. The watermark is per bot and is kept as the SET of message ids already delivered,
not as a count and not as a position, so a `/compact` that rewrites the transcript costs exactly the
rows it added (the summary it wrote, and whatever landed after it) rather than the whole compacted
transcript. That is the other half of the id guarantee in section 3, and it is a guarantee rather
than an optimisation: a row a client has already been handed is NEVER handed to it again wearing a
different id, because every client guard is an identity guard and the same words under a fresh id
are a second bubble, not a duplicate to fold away. The mark resets when the bot's session id
changes; a `GET /bots/:name/chat/messages` re-bases it on what that response returned, so a client
that reads history and then listens receives each message exactly once, and the ids in that response
are the same ids the stream uses. Keying on `BotChatMessage.id` makes a duplicate harmless anyway.

Two scoping properties to design a client around:

- Both chat frames are BROADCAST to every paired device, carrying full message text. That is
  intended under the one-user gateway model (a phone, a tablet and a laptop belonging to the same
  person all follow the same turn), and it is the property that would have to change first if a
  gateway ever served more than one human.
- The delta watermark is per bot, SHARED by those devices. A `GET /bots/:name/chat/messages` from
  one device re-bases it for all of them, so a second device mid-turn can miss a delta and recovers
  on its next history read. A client that must not miss a message reads history on foreground.

`bot_chat_state` is edge-triggered: a poll that finds nothing changed is silent. `phase` is the
gateway's view of the turn it is polling (`polling` while awaiting, `complete` when the reply landed
and Hermes went idle, `timeout` at the 180 s cap, `failed` when Hermes kept refusing), while
`running` and `inflight` are Hermes' own flags passed through.

### bot_chat_delta, the live draft

`bot_chat_delta` is the reply a bot is writing, sent while it writes it. Version 6 and up.

```
{ type: "bot_chat_delta", bot: "scout", sessionId: "canonical",
  turnId: "runtime-1#1800000000123-4", text: "all", seq: 1, updatedAt: 1800000000123 }
{ type: "bot_chat_delta", bot: "scout", sessionId: "canonical",
  turnId: "runtime-1#1800000000123-4", text: "all green on", seq: 2, updatedAt: 1800000000323 }
{ type: "bot_chat_delta", bot: "scout", sessionId: "canonical",
  turnId: "runtime-1#1800000000123-4", text: "all green on main", seq: 3,
  updatedAt: 1800000000480, done: true }
```

and, for a member speaking inside a group room:

```
{ type: "bot_chat_delta", bot: "scout", sessionId: "<the member's room session>",
  room: "Release Room", turnId: "runtime-7#1800000000900-9", text: "ship it", seq: 1,
  updatedAt: 1800000000900 }
```

Read it as a DRAFT and never as a message:

- Capability 15 does not extract media from drafts. A streaming draft may briefly show a raw
  standalone `MEDIA:<path>` line. Extraction, attachment storage and successful-line removal happen
  only when the turn settles; the settled `bot_chat` row replaces the draft as usual.

- `text` is the FULL accumulated assistant text so far, not an increment. There is nothing to
  reassemble, re-ordering is harmless, and any subset of the frames can be dropped: render the
  newest one you have.
- `seq` is monotonic within one `turnId` and starts at 1. Drop a frame whose `seq` is not greater
  than the last one rendered for that turn.
- `turnId` is minted per turn and is never reused. A Hermes session id IS reused across turns, so
  the turn id is the only thing that says "this is a different reply": a frame with a new `turnId`
  REPLACES the draft, it does not extend it.
- `done: true` marks the last frame of a turn. Nothing further will be sent for that `turnId`.
- `room` is present only for a member's turn inside a group room, and then `bot` is the member's
  profile name and `sessionId` is that member's own room session, which is not an id a client
  addresses anywhere else. Key the draft on `room` + `bot` and render it in the room; the room's
  actual transcript still arrives as `bot_group` entries.
- The draft is NOT persisted anywhere. It is never replayed, a device that connects mid-turn will
  usually pick the draft up part-way through, and `GET /bots/:name/chat/messages` knows nothing
  about it.

Clear the draft on whichever comes first: `done`, a `bot_chat_state` phase of `complete`, `timeout`
or `failed`, or the canonical message landing in `bot_chat`. Do not try to reconcile the draft text
with the final message: they are produced by two different paths and the final message wins outright
(it may be trimmed, tool chatter may have been dropped from it, and a compaction may have rewritten
the transcript under both).

Three behaviours worth designing around, stated plainly because a user can observe all three:

- **The draft can freeze and then jump.** Hermes routes these events to whichever connection most
  recently resumed the session, so a human opening the same session in a Hermes desktop takes the
  route away from this gateway. The gateway's own 2 s turn poll resumes the session and takes it
  back, so the draft stalls for up to a poll interval and then jumps forward, or (for a short turn)
  never appears at all. The reply itself is never at risk: it does not come from this path.
- **A draft may start part-way in.** Under the same theft, or after a reconnect mid-turn, the
  gateway starts drafting from the first token it sees. The `done` frame carries the whole reply as
  Hermes persisted it, so the draft self-corrects at the end.
- **A turn may produce no draft at all.** A Hermes build that does not emit token events, a stolen
  transport for the turn's whole length, or a reply short enough to complete inside one throttle
  window. A client MUST keep whatever "working" affordance it had for the gap before the first
  token, which is a real gap (1.8 to 3 seconds against a hosted model in the reference probe).

Frequency is throttled server-side to one frame per session per 200 ms, plus the closing `done`
frame, so a long reply costs tens of frames rather than the hundreds of token events behind it.
Unchanged text is never re-sent.

Nothing derived from a model's chain of thought EVER rides this frame. Hermes emits
`thinking.delta`, `reasoning.delta` and `reasoning.available` on the very same socket; the gateway
reads the `message.*` family and drops everything else, and there is no setting that changes it.

`bot_chat_reset` says a bot's canonical chat was RETIRED and a fresh one pinned in its place, by
`POST /bots/:name/chat/reset`. Version 8 and up. `sessionId` is the new chat, `previousSessionId` the
one that was retired (absent when there was nothing to retire). It is broadcast to every paired
device, which is the whole reason it exists: a second device sitting on the old chat has no other way
to learn that the session it is appending to is no longer the bot's. On receipt, rebind to
`sessionId`, drop any draft you were rendering, and read `GET /bots/:name/chat/messages` for the new
chat, which is empty until the user writes in it (and may carry a `suggestion` to offer them).

It is not a deletion notice. The retired session is still on the hermes host and still in
`GET /bots/:name/sessions`; only the pin moved. No further `bot_chat`, `bot_chat_state` or
`bot_chat_delta` frame will arrive for the retired session, because the gateway cancels its turn poll
and forgets its draft bindings before it mints the replacement.

`bot_chat_adopted` says a bot's canonical chat adopted a conversational session, automatically from
version 14 or manually from version 16. `sessionId` is the session the chat now points at and
`previousSessionId` is the one the pin
held until this moment; unlike the reset frame's, that field is always present, because a
re-adoption by definition replaces a pin that resolved. It is broadcast to every paired device, for
the same reason `bot_chat_reset` is: a device sitting on the previous transcript has no other way to
learn that the conversation it is appending to is no longer the bot's. On receipt, rebind to
`sessionId` and read `GET /bots/:name/chat/messages` for the new chat.

That is the same handling `bot_chat_reset` gets, and a client MAY implement the two together, but
they say different things about the session they name, so read the difference before collapsing
them. A reset says the previous chat was RETIRED: the user asked to leave it behind, it will never be
adopted again, and no further live frame arrives for it. `bot_chat_adopted` says nothing of the kind.
The previous session is an ordinary conversation that simply stopped being the newest one; it stays
listed, stays resumable, and would become canonical again if something wrote to it. Nothing is
retired, and a turn still running in it may deliver its `bot_chat` frames, which carry that session's
id and its own message ids and which a rebound client ignores.

Automatic adoption is never emitted for a routine fire, a bot-to-bot delivery or a group-room
session. A manual restore may select any listed kind. See "The pin follows the bot's latest
conversation".

`bot_routines` is a FULL REPLACE for one bot, sent only when that bot's routine list actually
changed, so an idle cron store is silent. It fires when this gateway changed a routine, and when a
`cron.changed` broadcast arrived for a bot whose routines something has read in the last five
minutes. A cron change carries no bot name and no job id, so "which bots changed" is unanswerable
and the gateway re-reads the bots it has reason to believe someone is watching: reading
`GET /bots/:name/routines` is what arms that, and reading it again is what keeps it armed. A client
whose routines pane has been open longer than that should re-read on foreground rather than assume
the frames kept coming. Where a gateway sends no `cron.changed` at all, `POST /bots/focus` with
`screen: "routines"` drives the same re-read on the desktop's own 20 s cadence.

The frame carries the same rows the route does, `legacy` ones included, and `cron.changed`
invalidation is untouched by them: it was already a whole-list, per-bot re-read that names no job, so
an untagged job changing anywhere in a watched bot's store moves that bot's list exactly as a tagged
one does.

`bot_group` is a DELTA on the same terms as `bot_chat`: `messages` carries only the room entries the
gateway has not broadcast before, in `seq` order, and one frame is sent per entry as the
deliberation produces it. The user's own message rides a frame too, so a second device sees it
arrive. Key on `BotGroupMessage.seq` and a replayed entry is harmless.

`bot_group_state` brackets a deliberation. `running` is sent when a loop takes the room and again
whenever it has a `note` to report; `settled` or `needs_you` is sent once when the loop finishes,
and only by the loop that still owns the room (a superseded loop stays silent). `round` is the
zero-based round the loop is on, and `epoch` says which user send the frame belongs to. A `note`
means a member contributed nothing to the round and why: `timeout` and `failed` are its turn not
completing, and `capped` is the room hitting its 10-message limit with that member next in line. A
room may also emit a `settled` or `needs_you`
frame outside a deliberation, when `GET /bots/groups/:name` clears the escalation badge.

Both group frames are BROADCAST to every paired device, on the same one-user-gateway reasoning the
chat frames use. Unlike `bot_chat` there is no shared read watermark to miss: room entries are
persisted with a monotonic `seq`, so a device that missed a frame recovers completely by reading
`GET /bots/groups/:name`.

### bot_approval_pending / bot_approval_resolved, the approve-deny pair

Version 10 and up. A tool call inside a bot's turn is waiting on a human decision, and then reaches
one of three terminal states. They ride the live channel, are never sealed, produce no durable
message, and are not replayed on reconnect.

These exist because the bots surface is a PARALLEL path to the core one. Contract v1.md section 5a
already defines `approval_pending` / `approval_resolved`, keyed on `threadId` -- but a bot chat has
no thread, no `TurnRunner` and no backend session, so those frames cannot address one. Every field
beyond the `bot` + `sessionId` keying is copied from the core pair one for one, deliberately, so a
client renders both with a single view.

Where each field comes from, all of it out of the Hermes `approval.request` event:

- `toolCallId` IS the Hermes `request_id` (a uuid4 hex). It is the correlation id the pending frame,
  the resolve routes, the resolved frame and the push collapse id all key on. The Hermes event
  carries no tool-call id of its own, and this is the only correlation key it offers.
- `turnId` is the GATEWAY's own turn id for the chat: the same value `bot_chat_delta` carries, so an
  approval lands on the bubble the user is looking at. The Hermes event is session-scoped and names
  no turn. When no turn is in flight (an approval raised by a routine, a turn whose draft never
  started) the gateway mints one and holds it for the life of the approval, so the pending frame and
  the resolved frame always agree.
- `name` is DERIVED from the Hermes `pattern_key`, the approval RULE that matched (`terminal:rm`,
  `execute_code:python`). The rule, in order: `pattern_key` if it is a non-empty string, else the
  first non-empty entry of `pattern_keys`, else the literal `unknown`; then capped at 120
  characters. It is never derived from the command.

There is deliberately **no `argSummary` member**, and there never will be one on this frame. The
Hermes surface carries no structured arguments to summarize, and the free text it does carry
(`command`, `description`) is never forwarded into any frame, push payload, or log line. A member
that does not exist cannot leak one.

`outcome` folds the three terminal states. `expired` is SYNTHESIZED by the gateway from its own
timer: Hermes emits no expiry event of any kind, it simply drops the queue entry when its
`approvals.timeout` (default 300 s) lapses and tells nobody. The gateway's timer mirrors that value
and is configurable through `hermes.approvalTimeoutSeconds` in the gateway config file. `expired` is
also what a resolve answered `{"resolved": 0}` maps to, because that answer means the entry is gone
and therefore that nobody's decision took effect.

Unlike `bot_chat_delta` there is no `room` member. An approval raised inside a group room is keyed
on the member profile and that member's ROOM session, which is exactly how its draft is keyed, so a
client that is already rendering the room's drafts can place it without a second field; and a
`sessionId` that is not the bot's canonical chat is what says it is not a 1:1 approval.

Exactly one `bot_approval_resolved` is ever emitted per `toolCallId`: the first terminal state wins
and every later one is swallowed. A pending approval this gateway is already tracking is never
re-announced either, so a reconnect that replays the same entry costs no second banner.

### bot_tool_activity, the live tool-step strip

Version 12 and up. What a bot's turn is DOING right now: the tool steps it has run so far, as a
FULL-REPLACE snapshot, so a client can render step-by-step chips that fill in while the turn runs
instead of showing an undifferentiated "thinking".

```
{ "type": "bot_tool_activity", "bot": "scout", "sessionId": "sess-1",
  "turnId": "sess-1#1800000000000-4", "seq": 3, "updatedAt": 1800000000000,
  "done": true, "room": "Release Room",
  "steps": [ { "stepId": "call_1", "seq": 1, "name": "terminal",
               "status": "ok", "startedAt": 1800000000000, "endedAt": 1800000001200 } ] }
```

Snapshot, not a delta, for the same reason `bot_chat_delta` carries the full accumulated text: every
frame is independently sufficient, so any subset of them can be dropped and a client never
reassembles anything. `steps` carries every step of the turn so far in `seq` order; a step that has
ended stays in the array carrying its terminal status rather than being removed. "What happened this
turn" is therefore read off ONE frame.

- `stepId` IS the Hermes `tool_id`, the correlation key its `tool.start` and `tool.complete` share.
  Unique within the turn.
- `seq` on a STEP is that step's position in the turn, from 1, assigned when the gateway first sees
  it and never moved afterwards. It is the order steps STARTED in. Tools run concurrently inside
  Hermes, so completions routinely arrive out of that order and each step carries its own two
  timestamps.
- `seq` on the FRAME is a different number: monotonic within one `turnId`, from 1, so a frame that
  arrives out of order is dropped by comparing it against the last one rendered.
- `turnId` is the GATEWAY's own turn id, the same value `bot_chat_delta` and `bot_approval_pending`
  carry for that chat, so all three frames agree about which turn a client is looking at. The Hermes
  tool events are session-scoped and name no turn at all.
- `status` is the CORE vocabulary of `contract/v1.md`'s `ToolCall`: `running` | `ok` | `error`, and
  deliberately not a fourth word, so one client switch renders a threads chip and a bots chip.
- `done` marks the last frame of a turn: every step in it is terminal and no further frame will be
  sent for that `turnId`.
- `room` is present only for a member's turn inside a group room, exactly as on `bot_chat_delta`.

**`error` means the step did not report success, which is broader than "the tool threw."** Hermes
puts no status flag on `tool.complete` at all -- its executor computes one and drops it before the
event is built -- so the gateway classifies the completion itself, from structure it can trust: a
non-zero `exit_code`, an `error` key or `success: false`, a `status` of `cancelled`/`failed`/`error`,
or one of the fixed error prefixes Hermes writes when it returns an unparsed string. Two further
things land in `error`: a call Hermes cancelled or timed out, and a step whose completion the gateway
never saw because the turn ended first (Hermes does not guarantee a `tool.complete` for every
`tool.start`; a turn that dies mid-tool emits only the start). Leaving such a step `running` would
spin a chip forever and calling it `ok` would claim an outcome nobody observed. **Nothing about WHY
is ever reported**, on this or any other member.

There is deliberately **no `detail`, `args`, `argSummary`, `context`, `result`, `summary`,
`inlineDiff` or `todos` member**, and there never will be one. The Hermes tool events carry all of
those and every one of them is radioactive: `args` is the raw argument map (full file contents on a
write, full shell commands, full patches), `context` is an 80-character preview of the raw command
or path, `result` gets no redaction of any kind, `inline_diff` is verbatim file content, `todos` is
user-authored text, and `summary` has one branch that is arbitrary tool text. The gateway reads
`result` exactly once, to choose between `ok` and `error`, and forwards none of it into a frame, a
stored row, a push payload or a log line. This mirrors the threads surface, where the same `detail`
member exists in the schema and the adapter refuses to populate it for the same reason. A member
that does not exist cannot leak one.

`name` is the Hermes tool identifier, narrowed to `[A-Za-z0-9_.:-]`, capped at 120 characters, and
falling back to the literal `tool` rather than to any other member of the payload. It is the one
piece of Hermes-side text on this frame, and it names a tool rather than describing what the tool was
asked to do. MCP tools keep their `mcp__server__tool` namespacing.

**These frames are NEVER pushed.** Tool activity is a foreground surface: it is worth showing to
somebody watching a turn run and worth nothing to a phone in a pocket, where it would be a stream of
notifications about something nobody was asked to decide. `contract/push-v0.md` keeps its three
payload kinds -- `message`, `approval_pending`, `approval_resolved` -- and this capability adds none.

A turn that runs no tools emits no frame at all, so an idle or purely conversational bot is silent
here.

#### Durability, and what a client must retain

Tool steps ARE durable, and a client does not have to hold them to offer expand-after-the-fact. They
are written to the gateway's own database as they happen and served back on
`GET /bots/:name/chat/messages` as `toolSteps` (see section 4). Hermes itself replays no tool
lifecycle of any kind on reconnect -- nothing on `session.info`, nothing in a resume's inflight
snapshot -- so the gateway is the only thing that can answer this after the socket is gone.

What the history array does NOT do is name a message, and that is the part to build against. A step
belongs to a TURN, and the gateway cannot say which transcript row a turn produced without guessing:
the Hermes transcript carries no turn id, and a turn may commit more than one assistant row.
`attachments` can name a message because a photo is bound to its row through the single-use send
queue that accepted it; there is no equivalent join here, so none is invented. What the gateway can
say honestly is WHEN, and `startedAt` / `endedAt` are the same millisecond clock as
`BotChatMessage.at`. **A client places a turn's strip chronologically**: it belongs after the last
message whose `at` precedes `startedAt`. A client that was connected during the turn additionally
already knows the `turnId` from the live frames and can key on it exactly.

### Deployment: what a bridged profile must pin

Two Hermes settings decide whether an approval ever reaches this surface. Neither is visible on the
wire, and neither can be inferred from the capability version, so a gateway can advertise 10
honestly and still never send a frame if a profile is configured against it. `scripts/agent-install.sh`
writes and verifies the first and refuses to proceed on the second.

- **`approvals.mode` MUST be `manual`.** The 0.20.x default is `smart`, an aux-LLM guardian that can
  APPROVE a dangerous call with **no event emitted at all**. Under `smart` the phone is asked
  sometimes and not others, which reads as an approve/deny feature that is intermittently broken
  rather than one that is absent.
- **`security.approval.transport` MUST be unset (or `builtin`).** Setting it routes the whole
  approval prompt to a registered plugin BEFORE the gateway branch is reached, so approvals never
  touch the dashboard WebSocket and this bridge goes permanently blind.
- **`display.tool_progress` MUST NOT be `off`** for `bot_tool_activity` (capability 12) to carry
  anything. It defaults to `all`, so the ordinary case works untouched; set to `off` it suppresses
  both the `tool.start` and the `tool.complete` events at their source and a bridged profile goes
  silent on this frame while looking perfectly healthy everywhere else. Same shape of hazard as
  `approvals.mode`: the capability version cannot assert a deployment fact.

A related knob is the gateway's own: `hermes.approvalTimeoutSeconds` mirrors the Hermes
`approvals.timeout`. Hermes does not expose that value over its RPC surface, so the two are kept in
step by the operator; out of step, the only consequence is that the gateway stops offering the
buttons earlier or later than Hermes stops accepting them, and it never resolves anything by itself.

## 7. Not in this extension yet

Draft frames for anything but a bot's own reply (a user's typing, a tool call in progress), replay
of a draft to a device that joined mid-turn, and any persistence of one; per-device chat-frame
scoping and per-device delta watermarks; model and description writes (see
`PATCH /bots/:name/profile`); skill install; MCP server setup and OAuth; bot duplicate; avatars;
routine run-now and run output (the backend exposes neither over this RPC); attachments that
are not images (PDFs and arbitrary files, which Hermes does expose as `pdf.attach` and `file.attach`
on the same surface), more than one image per send, photos into a GROUP room, and any way for a
client to learn ahead of time whether a given bot will see pixels or a description; and
multi-connection
rosters (the bridge targets exactly one Hermes gateway). Route shapes keep the `connection`
concept out of the URL so a later version can add it additively.

For group chats specifically: editing a room's membership or renaming a room (delete and recreate
for now; the members' `Group: <name>` sessions are preserved and picked back up by title), a
per-room interrupt, cross-machine membership, and any sync of rooms back to a Hermes desktop.

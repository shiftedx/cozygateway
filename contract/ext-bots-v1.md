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
"capabilities": { "com.cozylabs.bots": 6 }
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
  at: integer | null                  // MILLISECONDS, null when the message carries no stamp
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
- `id`: the message's own `id` or `message_id` when it has one, otherwise `<sessionId>#<index>`,
  where `index` is the position in the RAW list, so dropped rows do not shift the ids of the ones
  that survive. Stable for a given session, which is what makes it safe to key a list on and to
  de-duplicate a replayed frame with.
- `clientId`: present only on a message the sender submitted with one (see
  `POST /bots/:name/chat/messages`), both in the 202 body and on that same message when it comes
  back in a `bot_chat` frame. It appears on EXACTLY ONE message, and only on the one that send
  produced: a clientId is never re-used for a second row, never attached to a row the gateway has
  already broadcast (a re-based watermark replays rows a client already holds), and never carried
  across a turn boundary, however many times the same words are sent. `id` is therefore the
  identity of a rendered row and `clientId` is only the join back to the sender's optimistic copy;
  a client that keys its list on the clientId instead collapses two identical sends into one row.
- Rows are DROPPED, never rendered as blank bubbles: anything that is not an object, anything whose
  role is not `user` or `assistant` (a `system` prompt, a `tool` result), and anything whose text is
  empty after flattening (an assistant turn whose whole content was a `tool_use` part). Only the two
  conversational roles reach the app, from BOTH the history route and the frames, so a client never
  has to filter tool chatter itself.

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
  autoPaused?: boolean,               // this response is the one that paused it
  prompt?: string,                    // the backend's PREVIEW, truncated at 100 characters
  lastRun: integer | null,            // MILLISECONDS
  nextRun: integer | null,            // MILLISECONDS
  lastStatus?: string,                // how the last run ended, the backend's own word
  repeat?: string,                    // a DISPLAY string: "forever", "once", "3 times", "1/3"
  continuity?: boolean                // each run sees the previous run's output
}
```

A routine is an ordinary Hermes cron job whose NAME is `[bot:<name>] <title>`. That tag is the
ENTIRE relationship between a bot and a routine: there is no bot field on a cron job and no per-bot
cron API. Consequences a client should hold onto:

- the gateway filters every list and every write through that tag, so another bot's jobs and the
  operator's own unrelated cron jobs are invisible on these routes, whatever id is sent;
- the tag is written exactly as the Hermes desktop writes it, so routines created on a phone appear
  in the desktop's Routines pane and vice versa.

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

- `pin`: the known pin still resolves, return it;
- `title`: first open of a bot with history, adopt the session titled `Bot Chat`;
- `latest`: first open with history but no canonical title, adopt the newest session;
- `recovery`: the pinned id vanished (compaction rewrote the lineage), re-pin the newest session;
- `created`: no history at all, create a session titled `Bot Chat` (hidden by default) and send
  the kickoff prompt, because Hermes persists no row for a session until its first prompt. A
  failed kickoff rolls the pin back and the route reports the failure.

The returned `sessionId` is the STORED session id.

Three v1 properties worth knowing before writing a client:

- **The server's pin wins, key-wise.** `ui_meta["hermes-bots"]` is the cross-machine source of
  truth for `chat`: once a profile carries that blob, an absent `chat` key and an explicit
  `chat: null` both mean "no pin", and the gateway's local record is never used to fill the gap.
  Only a profile with no bot blob at all falls back to that local record, with ONE exception, and
  `GET /bots` applies it identically so the two routes cannot disagree: a pin this gateway wrote
  AFTER the `profiles.list` snapshot in hand is newer than that snapshot, not contradicted by it, so
  it survives an absent `chat` key until a later snapshot has had a chance to see it.
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
  until its first prompt lands, so for a few seconds after a chat is created `session.list` still
  answers empty. An empty list therefore does NOT mean "this bot has no chat": a pin the gateway
  holds wins, and only a bot with no pin at all gets a new chat. This is the fix for the wave 1
  duplicate-adoption bug, where two consecutive calls both answered `created` with different
  session ids and the app ended up rendering a different chat than the roster previewed.
- **This GET has side effects.** On a bot with no history it creates a session and submits the
  kickoff prompt, which costs tokens. Do not use it as a prefetch and do not retry it blindly.

### GET /bots/:name/chat/messages

```
200 {
  name: string,
  sessionId: string,
  adoption: "pin" | "title" | "latest" | "recovery" | "created",
  messages: BotChatMessage[],
  running: boolean,
  inflight: boolean,
  updatedAt: integer
}
404 not_found                         // no profile named `name` exists
```

History of the canonical chat. The chat is resolved exactly as `GET /bots/:name/chat` resolves it,
so the app never has to hold a session id, and the same side effect applies: a bot with no history
gets a chat created and a kickoff submitted. A chat whose kickoff has not landed yet has no row to
resume, and Hermes rejects the resume; that specific case answers `messages: []` rather than an
error, because the messages arrive over `bot_chat` frames moments later. The tolerance follows the
KICKOFF WINDOW (a chat this gateway created whose first prompt has not been seen to land, up to the
180 s turn cap), NOT the `adoption` value: the second read inside that window correctly reports
`pin`, and it is exactly the read the app performs. Every other Hermes failure is passed through.

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
thing the two have in common, so the match is ordered and single use: the queue of accepted sends is
FIFO, the first entry holding those words wins, that entry is then spent, everything ahead of it is
dropped (a newer entry matching first proves the older ones are never coming back), and the entries
of a turn are dropped when the next turn opens. A row the gateway has already broadcast is never
stamped at all. Without those rules, sending the same words twice handed the second row the FIRST
send's clientId, and a client keyed on it silently rendered one bubble where the user had typed two
(cozychat#38). The wire shape is unchanged, which is why this rides capability 6.

Delivery of the reply: the gateway submits against the session's RUNTIME id (learned from a cheap
`session.resume`, which is also the message-count baseline, or from `session.create` for a chat
whose kickoff has not persisted and therefore cannot be resumed at all). The stored pin is NEVER
used in that slot: a send whose runtime id cannot be established answers 502 rather than submitting
somewhere the message is lost. The gateway then polls `session.resume` every 2 seconds until the
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

### GET /bots/:name/sessions

```
200 { sessions: [ { id: string, title: string, preview: string | null, source: string | null } ] }
404 not_found                         // no profile named `name` exists
```

Passthrough of the bot's session list, capped at 200 rows.

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

Every routine in this bot's `[bot:<name>]` namespace, and nothing else. Read fresh on every call:
the answer carries next-run times that go stale by the second, and the read has a side effect (see
below) that a cache would skip. Two devices reading at once share one round trip.

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
    }
  ],
  "updatedAt": 1755428400000
}
```

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
- a routine this gateway creates is never legacy: its delegation prompt is prefixed with the marker
  `[bot-mode:routine:v2] `, which is what keeps it out of the `startsWith` check.

### POST /bots/:name/routines

```
body { title: string, schedule: string, prompt: string, repeat?: integer, continuity?: boolean }
201  { name: string, routine: BotRoutine }
400  invalid_request                  // malformed body, a NUL in title/schedule/prompt, or a `name`
                                      // that is not a legal profile id (see below)
400  invalid_request + hermesError    // hermes ANSWERED the `add` with a refusal (`success: false`)
404  not_found                        // no profile named `name` exists
502  backend_unavailable + hermesError // hermes REJECTED the call: an unparsable schedule is this
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

### PATCH /bots/:name/routines/:id

```
body { title?: string, schedule?: string, prompt?: string, enabled?: boolean,
       repeat?: integer, continuity?: boolean }
200  { name: string, routine: BotRoutine, replacedId?: string, orphanedId?: string }
400  invalid_request                  // no fields, a rewrite field without prompt, or a `name` that
                                      // is not a legal profile id
400  invalid_request + hermesError    // hermes ANSWERED the `add` with a refusal (`success: false`)
404  not_found                        // no profile named `name`, or no routine `id` for this bot
502  backend_unavailable + hermesError // hermes REJECTED the call, or ANSWERED a pause/resume/remove
                                      // with a refusal
```

Two very different operations, and the difference is the backend's rather than this API's invention:

**`enabled` alone is the row switch.** `true` resumes, `false` pauses, and the routine keeps its
`id`. This is the desktop's switch, and the pause/resume it performs is the same one.

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
   was before the edit was attempted.
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
that names a job outside this bot's `[bot:]` namespace is a 404, never a delete.

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

Two error CODES are added by this extension, on top of the core list in `contract/v1.md` section 4
(where `error.code` is a plain string precisely so an extension can add to it). A client that does
not know them treats them as a generic failure, which the HTTP status already conveys:

- `conflict` (409, `POST /bots`): the profile name is taken.
- `command_blocked` (502, `DELETE /bots/:name`): the gateway's command allow-list refused to run
  the profile delete; the body carries `blocked: true` and the gateway's own `hint`.

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
{ type: "bot_routines", bot: string, routines: BotRoutine[], updatedAt: integer }
{ type: "bot_group", group: string, messages: BotGroupMessage[], updatedAt: integer }
{ type: "bot_group_state", group: string,
  state: "running" | "settled" | "needs_you",
  round: integer, epoch: integer, note?: BotGroupNote, updatedAt: integer }
```

`bot_roster` and `bot_presence` are FULL REPLACE snapshots, and both are sent only when the value
actually changed, so an idle gateway is silent. `bot_presence.active` carries profile names, in
roster order.

`bot_chat` is a DELTA: `messages` carries only what the gateway has not broadcast before for that
bot, in order. The watermark is per bot and is kept as the last broadcast message ID, not a count,
so a `/compact` that SHRINKS the transcript re-bases the stream (the compacted transcript is
delivered once) instead of silencing it. It also resets when the bot's session id changes; a
`GET /bots/:name/chat/messages` re-bases it on what that response returned, so a client that reads
history and then listens receives each message exactly once. Keying on `BotChatMessage.id` makes a
duplicate harmless anyway.

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

`bot_routines` is a FULL REPLACE for one bot, sent only when that bot's routine list actually
changed, so an idle cron store is silent. It fires when this gateway changed a routine, and when a
`cron.changed` broadcast arrived for a bot whose routines something has read in the last five
minutes. A cron change carries no bot name and no job id, so "which bots changed" is unanswerable
and the gateway re-reads the bots it has reason to believe someone is watching: reading
`GET /bots/:name/routines` is what arms that, and reading it again is what keeps it armed. A client
whose routines pane has been open longer than that should re-read on foreground rather than assume
the frames kept coming. Where a gateway sends no `cron.changed` at all, `POST /bots/focus` with
`screen: "routines"` drives the same re-read on the desktop's own 20 s cadence.

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

## 7. Not in this extension yet

Draft frames for anything but a bot's own reply (a user's typing, a tool call in progress), replay
of a draft to a device that joined mid-turn, and any persistence of one; per-device chat-frame
scoping and per-device delta watermarks; model and description writes (see
`PATCH /bots/:name/profile`); skill install; MCP server setup and OAuth; bot duplicate; avatars;
routine run-now and run output (the backend exposes neither over this RPC); push; and
multi-connection
rosters (the bridge targets exactly one Hermes gateway). Route shapes keep the `connection`
concept out of the URL so a later version can add it additively.

For group chats specifically: editing a room's membership or renaming a room (delete and recreate
for now; the members' `Group: <name>` sessions are preserved and picked back up by title), a
per-room interrupt, cross-machine membership, and any sync of rooms back to a Hermes desktop.

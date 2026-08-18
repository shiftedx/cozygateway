# cozygateway vendor extension: com.cozylabs.bots, v1

Status: draft. Read path plus full-duplex bot chat (the 4.5 pivot slice; spec section 5's W2 is bot CRUD and
avatars, which is a later, additive version of this document). Versioned INDEPENDENTLY of `contract/v1.md`, which stays
frozen. This document describes an optional surface a gateway may or may not have; a client that
does not recognize it ignores the capability and the frames, and nothing in v1 changes.

Machine artifact: `packages/contract/src/ext-bots.ts` (TypeBox schemas). Notation follows
`contract/v1.md`: objects are OPEN, unions are CLOSED, `field?:` means optional.

## 1. What it is

A surface over a Hermes gateway's "Bot Mode": the roster of named bots, each bot's canonical chat
(read AND write), and each bot's session list. The gateway holds one persistent outbound JSON-RPC WebSocket
to the Hermes gateway (the "hermes bridge") and caches what it learns in SQLite, so the app reads
are cache-first and the live updates are pushed rather than polled.

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
"capabilities": { "com.cozylabs.bots": 2 }
```

The value is the extension's integer version, which is what the capabilities map is typed for.
A gateway with no bridge omits the id entirely and does not register any `/bots` route, so a
client can rely on the capability rather than probing for 404s.

Versions are ADDITIVE, so a client compares `>=`, never `===`:

- `1`: roster, presence, canonical-chat resolve, session list, chat history.
- `2`: `POST /bots/:name/chat/messages` plus the `bot_chat` and `bot_chat_state` frames. A client
  that offers a composer MUST require `>= 2`: a version 1 gateway 404s that route and never sends
  those frames, which without the bump reads as a composer that silently does nothing.

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
  back in a `bot_chat` frame.
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

### GET /bots/:name/chat

```
200 { name: string, sessionId: string, adoption: "pin" | "title" | "latest" | "recovery" | "created" }
```

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
502  backend_unavailable                   // hermes refused, or no runtime session could be addressed
```

Submits `text` into the canonical chat. **202, not 200**: Hermes has accepted the prompt and the
reply is NOT in this response. The body carries the user message the gateway committed, so the app
can render it immediately; its `id` is a gateway-local one (`<sessionId>#local-<ms>`) because Hermes
does not hand one back, and the same message reappears with HERMES' own id in a later `bot_chat`
frame. The two ids never match, so dedupe rides `clientId` instead: whatever the sender put on the
request (or the gateway-local id, when it sent none) comes back on the committed message AND on that
same message in the frame, so the optimistic row is replaced rather than duplicated.

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

There is exactly ONE turn poll per bot. A send that arrives while a poll is running rides that
poll rather than starting another, and extends its deadline. Three consecutive failing polls
abandon the turn with `phase: "failed"`; a single transient failure is ridden out.

### GET /bots/:name/sessions

```
200 { sessions: [ { id: string, title: string, preview: string | null, source: string | null } ] }
```

Passthrough of the bot's session list, capped at 200 rows.

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

## 5. Presence

A bot is `active` when EITHER holds:

1. the Hermes gateway is routed to that bot's profile and is mid-turn (busy), or
2. `now_seconds - last_session.last_active < 90` (strict).

Because `lastActiveAt` is milliseconds on this wire and the rule is in seconds, a client that
recomputes presence locally must divide before comparing.

## 6. Server frames

Both are additive members of the `ServerFrame` union on the existing per-device `/ws` socket, and
are only ever sent by a gateway that advertises the capability.

```
{ type: "bot_roster", bots: BotSummary[], updatedAt: integer }
{ type: "bot_presence", active: string[], updatedAt: integer }
{ type: "bot_chat", bot: string, sessionId: string, messages: BotChatMessage[], updatedAt: integer }
{ type: "bot_chat_state", bot: string, sessionId: string,
  phase: "polling" | "complete" | "timeout" | "failed",
  running: boolean, inflight: boolean, updatedAt: integer }
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

## 7. Not in this extension yet

Per-device chat-frame scoping and per-device delta watermarks; bot create, edit, duplicate, delete;
avatars; routines; group chats; push; and multi-connection
rosters (the bridge targets exactly one Hermes gateway). Route shapes keep the `connection`
concept out of the URL so a later version can add it additively.

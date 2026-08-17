# cozygateway vendor extension: com.cozylabs.bots, v1

Status: draft, wave 1 (read path). Versioned INDEPENDENTLY of `contract/v1.md`, which stays
frozen. This document describes an optional surface a gateway may or may not have; a client that
does not recognize it ignores the capability and the frames, and nothing in v1 changes.

Machine artifact: `packages/contract/src/ext-bots.ts` (TypeBox schemas). Notation follows
`contract/v1.md`: objects are OPEN, unions are CLOSED, `field?:` means optional.

## 1. What it is

A read path over a Hermes gateway's "Bot Mode": the roster of named bots, each bot's canonical
chat, and each bot's session list. The gateway holds one persistent outbound JSON-RPC WebSocket
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
"capabilities": { "com.cozylabs.bots": 1 }
```

The value is the extension's integer version, which is what the capabilities map is typed for.
A gateway with no bridge omits the id entirely and does not register any `/bots` route, so a
client can rely on the capability rather than probing for 404s.

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
device that disappears cannot pin the bridge into polling forever. Where Hermes offers a change
broadcast the bridge refreshes on the event instead, which is cheaper than any poll.

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
```

Both are FULL REPLACE snapshots, and both are sent only when the value actually changed, so an
idle gateway is silent. `bot_presence.active` carries profile names, in roster order.

## 7. Not in v1 of this extension

Bot create, edit, duplicate, delete; avatars; routines; group chats; push; and multi-connection
rosters (the bridge targets exactly one Hermes gateway). Route shapes keep the `connection`
concept out of the URL so a later version can add it additively.

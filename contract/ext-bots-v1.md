# CozyGateway Bot Mode extension (`com.cozylabs.bots`)

Status: v1 extension, capability version 28. This extension is independent of the frozen core
`contract/v1.md`. A gateway advertises it in `GatewayInfo.capabilities`; clients that do not
recognize the capability ignore its routes and frames. The exact machine-readable shapes are in
[`packages/contract/src/ext-bots.ts`](../packages/contract/src/ext-bots.ts). Objects are open and
unions are closed, following the core contract.

## Ownership and boundaries

Bot Mode is split deliberately:

- Hermes Dashboard is the **control/read plane** for the profile roster, profile editing, model
  configuration, catalog, routines, and read-only A2A inbox.
- attach-v1 is the **Bot Mode chat data plane**. For every configured
  `hermes.profiles.<profile>` identity, CozyGateway owns the chat session ids, transcript,
  attachments, active-turn state, tool activity, approvals, and clarification state in its SQLite
  store. The gateway sends commands to that profile's attached Hermes plugin and commits its
  durable attach-v1 events back into this projection.
- Group rooms are gateway-owned attach-v1 conversations too. They are not Hermes Dashboard
  sessions.

Therefore Bot Mode chat must never be implemented with Dashboard `session.create`,
`session.resume`, or `prompt.submit`, nor with a Dashboard transcript as a fallback. A Dashboard
or Hermes outage can affect control-plane reads, but it does not change the ownership of a native
Bot Mode transcript. The A2A inbox is intentionally different: it remains a read-only projection
of Hermes sessions and may use Hermes session list/resume operations.

CozyChat talks only to CozyGateway's existing HTTP, WebSocket, attachment, and push surfaces; it
does not connect to Hermes or attach-v1.

## Discovery and capability history

```
"capabilities": { "com.cozylabs.bots": 36 }
```

Versions are additive. Clients compare `>=`, never equality. A gateway that does not configure the
extension omits the capability and does not register `/bots` routes.

| Version | Added surface |
| --- | --- |
| 1 | Roster, presence, canonical chat, native session list/history. |
| 2 | Send text, `bot_chat`, and `bot_chat_state`. |
| 3 | Profile read/edit and catalog. |
| 4 | Routines and `bot_routines`. |
| 5 | Gateway-hosted group rooms. |
| 6 | `bot_chat_delta` draft frames. |
| 7 | `GET /bots/:name/media` proxy. |
| 8 | Reset chat and `bot_chat_reset`. |
| 9 | Photo sends and attachment downloads. |
| 10 | Approval frames and approve/deny routes. |
| 11 | Empty-chat `suggestion`. |
| 12 | Tool activity frames and history. |
| 14 | `bot_chat_adopted` and manual session adoption. |
| 15 | Assistant attachment ingestion. |
| 16 | Native session history and manual restore. |
| 17 | Read-only A2A inbox. |
| 18 | Per-bot model configuration. |
| 19 | Stop and start-new-chat actions. |
| 20 | Audio/video attachment playback with byte ranges. |
| 21 | Redacted tool-step details. |
| 22 | Durable native clarification events and resolution. |
| 23 | Exact native turn status/cause and durable queued-at metadata. |
| 24 | Common document attachment sends and file downloads. |
| 25 | Profile-local discovery of Hermes gateway-safe, plugin, and installed skill commands. |
| 26 | Searchable aggregate history of agent-sent attachments across native sessions. |
| 27 | Bounded current-state inbox for pending native approvals. |
| 28 | Requested-vs-confirmed native approval and clarification settlement. |
| 29 | Bounded pending clarifications and confirmed terminal settlement receipts on the recovery route. |
| 30 | Profile-local memory read and conditional write routes. |
| 31 | Durable delivery receipts: the displayed report, `BotChatMessage.marker`, and role `system`. |
| 32 | Inline media ordering: `BotChatMessage.attachments[].position`. |
| 33 | Create-time tool selection: optional `toolsets` / `mcpServers` on `POST /bots`, and `BotCreateResponse.warnings`. |
| 34 | Subagent visibility: `bot_delegation_activity` batch snapshots and a `delegations` array on chat history. |
| 35 | Live thinking preview: latest-only `bot_thinking_activity` frames (sanitized, <=280 chars, ephemeral). |
| 36 | Full provider visibility: optional `providers` summary and `unauthenticated` catalog markers on `BotModelConfig`. |

Version 13 was never shipped. A client gates only the feature it renders; unknown optional fields
and unknown server frames are ignored.

## Resources

The TypeBox schemas are normative. The names below identify complete shapes rather than maintaining
a second, hand-copied schema.

- `BotSummary` is one control-plane roster row. Its `chatSessionId`, `preview`, and
  `lastActiveAt` are overlaid from the configured bot's gateway-owned native chat, on every surface
  that serves a roster row. Profile metadata remains Hermes control-plane data.
- `BotChatMessage` is a durable native transcript row. `id` is the gateway/attach event message
  id, `at` is gateway-clock milliseconds (or `null` when unavailable), and `clientId` is an
  optional sender echo. Attachments are gateway-scoped opaque `fileId` values, never paths or URLs.
  Roles are `user` or `assistant` in the conversational projection, plus, from capability 31,
  `system` on gateway-authored rows that are not conversation. Roles are NOT an enum on this wire:
  a client renders an unfamiliar role rather than dropping the row.
  From capability 31 a row may also carry `marker`, a bounded label naming what a gateway-authored
  row IS. The only v1 value is `delivery.failed`. A client that does not know a marker renders the
  ordinary row it already renders.
  From capability 32 an attachment entry may also carry `position`; see "Inline media ordering".
- `BotSessionSummary` is a durable native Bot Mode session. Current native Bot Mode sessions have
  `kind: "conversation"`; `startedAt` and `lastActiveAt` are milliseconds. They are not Hermes
  Dashboard session records.
- `BotProfile`, `BotCatalog`, `BotModelConfig`, and `BotRoutine` are Hermes control-plane
  resources. The profile source may report `runtimeInert` sections that Hermes stores but does not
  execute.
  From capability 36 `BotModelConfig` may carry `providers`: one summary row per provider Hermes
  reported, kept even when the provider currently contributes zero catalog entries or has lost its
  credential (`authenticated: false`), and a catalog entry from such a provider may carry
  `unauthenticated: true`. Hermes keeps an unauthenticated configured provider visible on purpose,
  so the picker can show the saved selection and a re-auth affordance; a client renders those
  entries disabled with a sign-in hint rather than hiding them, and a client below 36 ignores both
  fields.
- `BotInboxThread` and `BotInboxMessagesResponse` are the read-only Hermes A2A projection.
- `BotGroup`, `BotGroupDetail`, and `BotGroupMessage` are gateway-owned room resources.
- `BotSlashCommand` is one canonical command advertised by the authenticated profile plugin. Its
  slash-prefixed `name` is the exact invocation; `description`, optional `argsHint`, and optional
  `category` are presentation metadata. `BotSlashCommandCatalog` is the bounded ordered list.
- `BotAttachmentHistoryItem` identifies one assistant attachment in a durable native transcript,
  including its bot, session, message caption, timestamp, and ordinary opaque attachment block.
  `BotAttachmentHistory` is a newest-first bounded page with an optional next offset.
- `BotPendingApproval` is the safe metadata necessary to render one unresolved approval: bot,
  session/turn ids, tool-call id, rule display name, and its pending timestamp. It carries no tool
  arguments, commands, descriptions, results, or model reasoning. `BotPendingApprovals` is capped
  at 100 current records and excludes all terminal history.
- `BotPendingClarification` mirrors that recovery state for one unresolved option card. Its prompt
  and bounded option labels are the same display-safe values already sent in the pending frame.
- `BotInteractionSettlement` is compact terminal proof for one approval or clarification: stable
  bot/session/turn/interaction identifiers, the terminal outcome, optional selected option id, and
  gateway settlement time. It never includes an approval decision command, tool arguments/results,
  or an option label. The gateway retains only the newest 100 terminal receipts per bot.

Only profiles configured in `hermes.profiles` are exposed as CozyChat bots. Profile lifecycle
belongs to Hermes: create or delete the profile there, then rerun the CozyGateway installer (its
default `--profiles all` selection reconciles plugin, token, service, and gateway configuration).

`POST /bots` creates the Hermes profile and then SEEDS it as a blank slate: the `file` + `terminal`
toolset floor on the `cozygateway` and `cli` platforms, `approvals.mode: manual`, inherited MCP
servers quieted, and the profile's whole skill catalog written into its `skills.disabled` OFF-list
so a new bot starts with no playbooks (skills have no enabled allowlist upstream, so a profile that
names nothing has every installed skill on). Operators keep named skills on with
`hermes.blankSlateSkillsOn`, default `[]`. A skill catalog that cannot be read leaves the key
unwritten and adds a warning rather than guessing at half of it. A fresh profile that is seeded with nothing does not get a small toolset, it
inherits Hermes' broad per-platform default, so the floor has to be written down to exist. The
capability-33 `toolsets` and `mcpServers` fields name what to grant ON TOP of that floor;
`file` and `terminal` are always included, and a name the backend does not report is skipped and
listed in `BotCreateResponse.warnings` rather than failing the create. The seed only ever writes
keys the profile does not already carry, and a seed that fails leaves the created bot in place with
a warning. Operators turn the whole behaviour off with `hermes.seedBlankSlateBots: false`; an
explicit selection is still honoured when they do, and the skills OFF-list stops exactly as the
toolset floor does. There is no create-time `skills` field: the app's post-create
`PATCH /bots/:name/profile disabledSkills` is replace-whole and lands after the seed, so a user's
explicit skill selection wins wholesale while an untouched create keeps the floor. See `docs/attach-v1-operations.md`.

### Slash commands

`GET /bots/:name/commands` returns the last catalog advertised by that profile's authenticated
attach plugin. It contains every Hermes command valid on a messaging gateway: enabled built-ins,
plugin commands, and installed skill commands. Client-local CLI/TUI commands are intentionally not
advertised because they cannot execute through Bot Mode.

Clients MUST require capability `>= 25` before calling the route. Selecting an item should insert
its canonical `name` into the ordinary composer so the user can edit arguments. Sending a command
uses `POST /bots/:name/chat/messages` unchanged; CozyGateway and clients do not duplicate Hermes
command parsing or execution. The most recently authenticated catalog remains readable while the
profile is temporarily disconnected, and an empty catalog is valid.

### Attachment history

`GET /bots/attachments` returns only attachments sent by configured agents in durable native Bot
Mode sessions. It accepts optional `q`, `kind` (`image`, `video`, `audio`, or `file`), `bot`,
millisecond `since`, `offset`, and `limit` query parameters. Search is case-insensitive across the
agent name, message caption, filename, and MIME type. Results are newest first; `limit` is bounded
to 100 and `nextOffset` is `null` when the page is complete.

Clients MUST require capability `>= 26`. This route indexes metadata only. Attachment bytes remain
behind the existing authenticated `GET /bots/:name/chat/attachments/:fileId` route, so clients can
preview, save, or share a result without the gateway duplicating media or exposing a path.

### Pending approvals

`GET /bots/approvals?state=pending` returns a bounded snapshot envelope with every currently
unresolved native approval (ordered oldest first), every unresolved clarification, and recent
confirmed terminal settlement receipts. `state` is optional only for a simpler initial client call;
when supplied it must be `pending`. The route is a recovery/read surface, not a second workflow:
the existing `POST /bots/:name/approvals/:toolCallId/approve` and `.../deny` routes settle the
same durable records, and expired records are absent as soon as their lifecycle timer settles them.
`resolutionRequestedAt`, when present, means the gateway durably appended one stable resolution
command; it is not an approval or denial result and exposes neither a command id nor a decision.

Clients MUST require capability `>= 27` before showing the global pending-requests menu or using
this route. A client that renders the requested-versus-terminal lifecycle or submits either native
resolution action MUST require capability `>= 28`; one that reads clarification recovery or terminal
settlements from this envelope MUST require `>= 29`. A client keeps an action in `awaiting
confirmation` after its POST until it observes the matching terminal receipt (or a terminal frame).
It must never derive a decision URL from push text or retain an old action after a fresh snapshot no
longer contains that `toolCallId`.

### Canonical native chat

Each configured bot always has one selected native session. `GET /bots/:name/chat` and
`GET /bots/:name/chat/messages` create its first empty local session when needed. The session id is
durable across gateway/plugin restart. It is not a Hermes session id and cannot be passed to a
Dashboard RPC.

`GET /bots/:name/sessions` returns that bot's local session history, newest first, and the selected
`activeSessionId`. `POST /bots/:name/sessions/:id/adopt` selects an existing session owned by the
same bot. `POST /bots/:name/sessions/new` selects a fresh empty session without deleting the
previous one. `POST /bots/:name/chat/reset` likewise selects a fresh empty session, interrupts a
running old turn when possible, and additionally sends the stronger `bot_chat_reset` notification.
Neither action deletes prior local history; clients may present reset as “start over”, not as
destructive erase.

### Native sends, events, and suggestions

`POST /bots/:name/chat/messages`, `POST /bots/:name/chat/photos`, and
`POST /bots/:name/chat/attachments` first admit a durable attach-v1
command, then append the user row to the native transcript and answer `202` with that row. If the
configured attach profile cannot accept the command, the request answers `503 backend_unavailable`
without storing transcript or media data. A text send during an active turn is admitted as a native
attach-v1 steer under that turn's id; a photo send during an active turn returns the same `503` so
the client can retry after the turn settles.
The attached plugin returns draft, commit, terminal, tool, approval, and clarification events.
Gateway projection of those durable events emits the corresponding server frames and updates the
same transcript read by `GET /bots/:name/chat/messages`.

There is no automatic greeting. When a selected transcript has no messages and
`hermes.chatSuggestion` is non-empty, history includes optional `suggestion`. It is presentation
text only: clients may offer it, but must not submit it automatically or display it as a transcript
row. Once any row exists, the field is absent.

`running` and `inflight` in history are the gateway's durable active-turn view. Live state frames
are the fresher source for a composing UI. `POST /bots/:name/chat/stop` sends attach-v1 interrupt
for that active native turn; follow-up text uses native attach-v1 steering, never Dashboard chat.

### Delivery receipts (capability 31)

`POST /bots/:name/chat/messages/displayed` carries 1 to 64 wire ids of transcript rows this device
actually put on screen, and answers `202 { "recorded": n }` with the number that became a NEW
receipt. It is the only signal in this contract that a HUMAN received a message: a durable
transcript row proves only that the gateway holds it, and push is fire-and-forget by construction.

Receipts are first-write-wins and never deleted. Ids that already have a receipt, and ids naming no
durable row for that bot, are both ignored and both count zero, so `recorded` is not an error
signal and a client MUST NOT retry a low count. Repeating a request is therefore free, which is
what makes a durable offline client queue safe to flush blindly on reconnect.

A client MUST gate the route on `com.cozylabs.bots >= 31` and MUST NOT send provisional
(client-side, not yet committed) ids. A version 30 gateway answers `404`, which means "this gateway
does not collect receipts", never "the message was lost".

When a receipt lands on a row that was a scheduled delivery, the gateway tells the plugin that
produced it over attach-v1 (`contract/attach-v1.md`, `delivery_receipt`). When a scheduled delivery
instead fails terminally, the gateway appends one `role: "system"`, `marker: "delivery.failed"` row
to that bot's current canonical chat: a quiet status row, not a bubble, and it raises no push.

### Attachments and media

Photo bytes are validated and stored by the gateway before the associated attach-v1 command is
sent. Plugin events refer to media by opaque ids; the gateway commits acceptable media into its own
store. `GET /bots/:name/chat/attachments/:fileId` serves only those gateway-owned bytes and
supports a single byte range for capability 20 playback. It never exposes a Hermes-host path.
Capability 24 additionally admits one 20 MiB document per turn: PDF; UTF-8 plain text, Markdown,
CSV, JSON, or RTF; legacy Office; OOXML; and OpenDocument files. The gateway checks the declared
allow-listed MIME against lightweight format bytes, stores the sanitized filename as metadata, and
serves every attachment with `Content-Disposition: attachment` and `nosniff`.

### Inline media ordering (capability 32)

An attachment entry on `BotChatMessage.attachments` may carry an optional `position`: the index in
that message's normalized block array BEFORE which the attachment renders. `0` renders it above
every block, `blocks.length` renders it below every block, and any value between renders it between
those two blocks. The point is that an image the agent wrote under a heading renders under that
heading rather than on a stack above the whole reply.

The rules, which both sides implement verbatim:

- Absent `position` is the legacy shape and means above-stack. Every row written before 32 has it,
  and any sender that cannot say where an attachment belongs keeps sending it. It is not an error
  and it is not a downgrade.
- A reader MUST clamp an out-of-range value into `0...blocks.length` rather than dropping the
  attachment. A sender that counts blocks differently than the reader degrades to a picture in a
  slightly wrong place; it never degrades to a lost picture.
- A message MAY mix the two. Positioned attachments render in flow at their index, unpositioned
  ones render above the message, and both are correct in the same bubble.
- Rendering is data driven, not version gated: a client renders in flow whenever positions are
  present. The EMITTING side is what gates on `>= 32`.

On the plugin side (`contract/attach-v1.md`), the `commit` and `scheduled` events carry an optional
`mediaPositions` array aligned index-for-index with `mediaIds`, and the gateway threads
`mediaPositions[i]` onto the attachment it builds from `mediaIds[i]`. That array is all or nothing:
when present it MUST have exactly the length of `mediaIds`, because a partial array would silently
claim index `0` for every attachment it omitted. A plugin that is not certain where its attachments
belong omits the field entirely. Message `text` is unaffected: `position` is the only new data.

### Canonical media allowlist

This table is the single reference for outbound media admission. The gateway upload route
(`POST /attach/v1/media/:mediaId`) accepts exactly these MIME types, and the attach plugin's
compatibility policy mirrors this table rather than keeping a second opinion. A type absent here is
refused at the gateway, so a plugin that offers one is guaranteed a 415.

| MIME | Extension | Family | Cap | Baseline |
| --- | --- | --- | --- | --- |
| `image/png` | png | image | 8 MiB | yes |
| `image/jpeg` | jpg | image | 8 MiB | yes |
| `image/webp` | webp | image | 8 MiB | yes |
| `image/gif` | gif | image | 8 MiB | yes |
| `video/mp4` | mp4 | video | 40 MiB | yes, H.264 video with AAC-LC audio |
| `video/quicktime` | mov | video | 40 MiB | beyond baseline, accepted for existing device uploads |
| `audio/mp4` | m4a | audio | 40 MiB | yes, AAC |
| `audio/mpeg` | mp3 | audio | 40 MiB | yes |
| `audio/wav`, `audio/x-wav` | wav | audio | 40 MiB | yes |
| `application/pdf` | pdf | file | 20 MiB | yes |
| `text/plain`, `text/markdown`, `text/csv`, `application/json`, `application/rtf`, `text/rtf` | txt, md, csv, json, rtf | file | 20 MiB | explicit document allowlist |
| `application/msword`, `application/vnd.ms-excel`, `application/vnd.ms-powerpoint` | doc, xls, ppt | file | 20 MiB | explicit document allowlist |
| OOXML `.docx`, `.xlsx`, `.pptx` | docx, xlsx, pptx | file | 20 MiB | explicit document allowlist |
| OpenDocument `.odt`, `.ods`, `.odp` | odt, ods, odp | file | 20 MiB | explicit document allowlist |
| `application/zip` | zip | file | 20 MiB | explicit file allowlist, delivered and shareable, never rendered inline |

The container MIME is what the gateway checks. Codec-level facts for MP4 (H.264 plus AAC-LC,
`yuv420p`, fast-start) are a plugin-side probe: this layer sees a container, not a stream.

`image/svg+xml`, `text/html`, and every other type are excluded on purpose. SVG and HTML carry
script and external references. Excluded means refused at upload, never silently transcoded.

`application/zip` is admitted as a FILE attachment, not a renderable one: it is delivered, stored,
and offered for download or share under the existing `mediaKind: "file"` shape from capability 24,
and no client is asked to render or expand it. It shares the 20 MiB document cap, the largest cap
any `file` type carries. The OOXML and OpenDocument packages above are ZIP containers on the wire,
so the DECLARED type is what separates them from a bare archive; the plugin-side probe tells them
apart by the uncompressed `[Content_Types].xml` entry an Office package stores first.

Declared type is a claim, so every accepted type is additionally checked against format magic bytes
before commit. Bytes that contradict an allowed declaration are refused exactly like a disallowed
type.

### Media rejection shapes

`POST /attach/v1/media/:mediaId` answers a refusal with core `ErrorBody` plus a machine-readable
`reason`, and never echoes any uploaded byte:

| Status | `reason` | Extra fields | Cause |
| --- | --- | --- | --- |
| `400` | `empty` | none | zero-byte upload |
| `413` | `too_large` | `limitBytes` | declared `Content-Length` or delivered bytes over that type's cap |
| `415` | `content_type` | `receivedContentType` | type not on the allowlist, or bytes that do not match the declared type |
| `422` | `digest` | none | `X-Attach-SHA256` missing or not matching the delivered bytes |
| `409` | none | none | media id already exists with different bytes, or a delete target is referenced |

`limitBytes` is the cap for the declared type, not the largest cap in the table. `receivedContentType`
is the request header reduced to MIME token characters and truncated, so it names what arrived
without reflecting attacker-chosen text. Error prose is gateway-authored in every branch; no message
from a layer that touched the payload is passed through.

This route is not rate limited today, so it never answers `429`. If that changes, the shape is the
one already used by `POST /bots/:name/chat/attachments`: status `429`, extension code `rate_limited`,
a `retryAfterMs` field, and a whole-second `Retry-After` header. A producer should treat `429` with
`Retry-After` as retryable whether or not this route emits it yet.

Every type this route accepts is downloadable through `GET /attach/v1/media/:mediaId`, which serves
the stored MIME with `nosniff`, `Content-Disposition: attachment`, and byte-range support. There is
no accept-but-never-serve type.

`GET /bots/:name/media?src=` is a separate HTTPS media proxy for a public source URL in bot output;
it is not a native attachment transport and it refuses unsafe/non-HTTPS sources.

## HTTP routes

Every route below requires device authentication. All normal failures use core `ErrorBody` unless a
route documents an extension-specific code. Names are normalized at the boundary. The schemas named
in this table are exported from `packages/contract/src/ext-bots.ts`.

| Route | Request | Success response | Notes |
| --- | --- | --- | --- |
| `GET /bots` | — | `{ bots: BotSummary[], updatedAt, stale }` | Hermes control-plane roster, with native-chat overlay for configured bots. |
| `POST /bots` | `BotCreateRequest` | `201 BotCreateResponse` | Creates a Hermes profile and seeds it as a blank slate. `409` extension code `conflict` when the name is taken. |
| `POST /bots/focus` | `BotFocusRequest` | `{ ok: true }` | Hints control-plane polling while roster/routines UI is visible. |
| `GET /bots/catalog` | optional `q` | `BotCatalog` | Hermes profile/catalog read. |
| `GET /bots/:name/profile` | — | `BotProfile` | Hermes profile read. |
| `PATCH /bots/:name/profile` | `BotProfilePatch` | `BotProfileConfigureResponse` | Hermes profile update. |
| `GET /bots/:name/model-config` | — | `BotModelConfig` | Hermes profile model read. |
| `PUT /bots/:name/model-config` | `BotModelConfigPatch` | `BotModelConfig` | Hermes profile model update. |
| `GET /bots/:name/chat` | — | `{ name, sessionId, adoption: "created" \| "pin" }` | Resolves the selected native chat. |
| `GET /bots/:name/chat/messages` | — | `{ name, sessionId, adoption, messages, running, inflight, updatedAt, suggestion?, toolSteps? }` | Reads native transcript and native tool history. |
| `POST /bots/:name/chat/messages` | `BotChatSendRequest` | `202 { name, sessionId, message: BotChatMessage }` | Admits a native turn or steer, then appends locally. |
| `POST /bots/:name/chat/messages/displayed` | `BotChatDisplayedRequest` | `202 BotChatDisplayedResponse` | Capability 31. Records that this device displayed those rows. |
| `POST /bots/:name/chat/photos` | multipart `file`, `BotChatPhotoFields` | `202 { name, sessionId, message: BotChatMessage }` | One validated image plus optional caption. |
| `POST /bots/:name/chat/attachments` | multipart `file`, `BotChatAttachmentFields` | `202 { name, sessionId, message: BotChatMessage }` | One validated PDF, text, RTF, Office, or OpenDocument file plus optional caption. |
| `POST /bots/:name/chat/stop` | — | `BotChatStopResponse` | Interrupts the current native turn; returns 409 when idle. |
| `POST /bots/:name/chat/reset` | — | `BotChatResetResponse` | Selects a fresh native chat and emits reset. |
| `GET /bots/:name/chat/attachments/:fileId` | optional single `Range` | attachment bytes | Gateway-owned attachment only. |
| `GET /bots/:name/media` | `src` query | proxied media bytes | HTTPS URL proxy; not an attachment lookup. |
| `GET /bots/:name/sessions` | — | `BotSessionsResponse` | Gateway-owned native sessions. |
| `POST /bots/:name/sessions/new` | — | `BotNewSessionResponse` | Fresh native chat, previous history retained. |
| `POST /bots/:name/sessions/:id/adopt` | — | `BotSessionAdoptResponse` | Selects an owned native session. |
| `GET /bots/:name/inbox` | — | `BotInboxResponse` | Read-only Hermes A2A inbox. |
| `GET /bots/:name/inbox/:threadId/messages` | — | `BotInboxMessagesResponse` | Read-only Hermes A2A transcript; no POST sibling exists. |
| `GET /bots/:name/routines` | — | `BotRoutineListResponse` | Hermes routine read. |
| `POST /bots/:name/routines` | `BotRoutineCreateRequest` | `BotRoutineWriteResponse` | Hermes routine create. |
| `PATCH /bots/:name/routines/:id` | `BotRoutinePatch` | `BotRoutineWriteResponse` | Hermes routine update. |
| `DELETE /bots/:name/routines/:id` | — | `{ id }` | Hermes routine delete. |
| `GET /bots/groups` | — | `{ groups: BotGroup[] }` | Gateway-owned rooms. |
| `POST /bots/groups` | `BotGroupCreateRequest` | `201 { group: BotGroup }` | Creates a gateway-owned room. |
| `GET /bots/groups/:group` | — | `BotGroupDetail` | Reads a gateway-owned room. |
| `DELETE /bots/groups/:group` | — | `204 No Content` | Deletes a gateway-owned room. |
| `POST /bots/groups/:group/messages` | `BotGroupSendRequest` | `202 { group, message: BotGroupMessage }` | Queues member turns through attach-v1. |
| `POST /bots/:name/approvals/:toolCallId/approve` | — | `202 { status: "requested" }` | Durably requests a native approval; the terminal event confirms it. |
| `POST /bots/:name/approvals/:toolCallId/deny` | — | `202 { status: "requested" }` | Durably requests a native denial; the terminal event confirms it. |
| `GET /bots/approvals` | optional `state=pending` | `BotInteractionRecovery` | Bounded pending approvals/clarifications plus confirmed terminal receipts. |
| `POST /bots/:name/clarifications/:clarifyId` | `BotClarifyResolveRequest` | `202 { outcome: "requested" }` | Durably requests a clarification option; the terminal event confirms it. |
| `GET /bots/:name/memory` | — | `BotMemoryOverviewResponse` | Profile-local source health/capabilities only; the gateway never opens Hermes files or provider storage. |
| `GET /bots/:name/memory/items` | bounded `q`, `source`, `kind`, `since`, `until`, `cursor`, `limit` | `BotMemoryItemsResponse` | Stable, source-labelled page (at most 100). One unavailable source is reported in `sources` without hiding healthy results. |
| `GET /bots/:name/memory/graph` | bounded `q`, `source`, `since`, `until`, `limit` | `BotMemoryGraphResponse` | At most 200 nodes / 400 Holographic entity or vault wikilink edges. |
| `GET /bots/:name/memory/sources/:source/items/:id` | — | `BotMemoryItem` | Full bounded content for one source-native item. |
| `POST /bots/:name/memory/sources/:source/items` | `BotMemoryWriteRequest` | `201 BotMemoryWriteResponse` | Native source create. |
| `PATCH /bots/:name/memory/sources/:source/items/:id` | `BotMemoryWriteRequest` with `expectedRevision` | `BotMemoryWriteResponse` | Conditional native source edit; stale data is `409 conflict` with `current` when available. |
| `DELETE /bots/:name/memory/sources/:source/items/:id` | `BotMemoryDeleteRequest` | `BotMemoryDeleteResponse` | Conditional native source delete; stale data is `409 conflict`. |

Memory uses the attached plugin's `memory_management` attach-v1 capability and request id, not
Dashboard file routes. `MemoryItem.timestampKind` is `created` for provider/native explicit dates,
`fileCreated` for a vault filesystem birth time, `firstObserved` for a curated legacy entry tracked
by the plugin-side sidecar, and `unknown` otherwise. Absolute vault roots never cross this boundary.
Memory content never rides a websocket frame, push, heartbeat, telemetry, or trace record.

`MemoryItem.kind` is one of `memory`, `profile`, `fact`, `note`: `profile` is the curated About-me
store, which the plugin's own store calls `user`; that store-side name is not a wire value. Every
memory route spends a per-device token budget and answers `429 rate_limited` with `retryAfterMs`
when it is empty, reads included: the attached plugin serves one memory request at a time, and a
second request arriving while one is in flight is answered `unavailable` rather than queued.

An unavailable attach-v1 identity is a `503 backend_unavailable` on native chat actions. A profile
that exists but is not configured as a native identity must not fall through to Dashboard chat.

## Server frames

All frames travel on the existing authenticated `/ws` and are members of the closed core
`ServerFrame` union. `updatedAt`, message timestamps, and tool timestamps are milliseconds.

- `bot_roster`: complete `BotSummary[]` control-plane roster snapshot. It is the same overlay
  `GET /bots` returns, rows and fields alike: `chatSessionId` carries the bot's real native chat
  session, so a client can join a `bot_chat_delta`, `bot_chat_state`, or `bot_tool_activity` frame
  to the roster row it belongs to.
- `bot_presence`: complete active profile-name set.
- `bot_chat`: native transcript delta. `messages` contains only newly committed rows.
- `bot_chat_state`: current native-turn phase: `polling`, `complete`, `timeout`, or `failed`.
  Capability 23 additionally carries exact `status`: `queued`, `executing`, `using_tools`,
  `awaiting_input`, `completed`, `failed`, `interrupted`, `timed_out`, or `connectivity_lost`.
  `cause` distinguishes absent/degraded/lost attach transport and cancellation; `queuedAt` is the
  durable outbox admission time. The existing gateway turn-timeout bound starts at `queuedAt`; on
  expiry the gateway discards an unacknowledged command or queues an interrupt for an acknowledged
  one, then projects `timed_out`.
- `bot_chat_delta`: full accumulated assistant draft for one native turn. `seq` is monotonic within
  `turnId`; `done` ends that draft. Clients may drop drafts and rely on committed `bot_chat` rows.
- `bot_chat_reset`: a reset selected a fresh native session. Rebind and reload its history.
- `bot_chat_adopted`: a new/adopt action selected an existing native session. Rebind and reload.
- `bot_tool_activity`: full-replace steps for a native turn. `BotToolStep.detail` and `errorText`
  are bounded/redacted display text; raw inputs and outputs never cross this contract.
- `bot_delegation_activity` (capability 34): full-replace children of one native turn's
  `delegate_task` batch. Identity is (`batchId`, `childId`); `seq` is monotonic within one
  (`turnId`, `batchId`) and `done` marks the batch fully settled. `label` is bounded display
  text and `currentTool` is a tool NAME; child args, results, reasoning, summaries, prompts,
  and paths never cross this contract. A batch may outlive its turn (async dispatch), so frames
  legitimately arrive after the turn sealed; a restart with a child in flight settles it
  `unknown` -- never `failed`. Active and past batches also ride chat history as the optional
  `delegations` array, so reconnect does not erase a live card, and `batchId` keys client
  reconciliation with the terminal "[ASYNC DELEGATION BATCH COMPLETE ...]" transcript row.
  When the attach plugin learns the canonical Hermes delegation id (`deleg_...`) from the
  structured `delegation_id` field of the parent `delegate_task` result, the snapshot frame
  and each history batch carry it as an optional batch-level `aliasId`. Identity stays
  (`batchId`, `childId`); a client whose exact-`batchId` reconciliation of that completion
  row fails falls back to matching the row's `deleg_...` id against `aliasId`. The alias
  typically appears from the batch's terminal legs onward (async spawn legs precede the tool
  result) and may be absent entirely under an older Hermes. Additive under capability 34: a
  below-capability or alias-unaware client ignores it.
- `bot_thinking_activity` (capability 35): latest-only sanitized preview of the bot's live
  reasoning for one native turn, shown in the thinking shimmer. `text` is a tail-truncated
  <=280-char display string (schema-enforced); `seq` is monotonic within `turnId` and a
  lower-or-equal frame is stale. EPHEMERAL BY DESIGN: never persisted, never in chat history,
  gone on reopen, and no frame follows the turn's terminal. This is a conscious, bounded
  reopening of the old "no reasoning on the wire" rule: the preview crosses, the chain of
  thought does not -- tool args, results, prompts, credentials, and file paths never appear.
  NOT pushed, ever.
- `bot_approval_pending`, `bot_approval_resolution_requested`, and `bot_approval_resolved`:
  durable native tool-approval lifecycle. The requested frame means outbox admission only; a
  terminal frame is emitted solely from the later plugin terminal event (or local expiry).
- `bot_clarify_pending`, `bot_clarify_resolution_requested`, and `bot_clarify_resolved`: durable
  native clarification lifecycle. A
  pending card contains only a display prompt and bounded option ids/labels, never model reasoning.
- `bot_group`, `bot_group_state`: durable gateway-owned group-room transcript and state.
- `bot_inbox_activity`: a currently open read-only Hermes A2A thread changed; re-read it.

Frames are independently safe to drop where their schema says they are deltas or snapshots.
Committed transcript history remains the recovery source after reconnect.

## Error and privacy rules

- Native session ids, attach message ids, and attachment ids are opaque. Never infer a filesystem
  path, Hermes Dashboard id, or URL from them.
- Attachment and media validation rejects unsafe bytes, unsupported types, oversized bodies, and
  invalid ranges before those values enter a transcript.
- Tool detail, approval display names, clarification prompts/options, group notes, and the
  capability-35 thinking preview are presentation fields. Raw tool arguments, results, command
  text, and full model reasoning are not serialized; the thinking preview is a sanitized,
  bounded display tail, not the chain of thought.
- The inbox has no send route. Bot-to-bot traffic is not another client composer.
- A client handles an unknown extension frame or optional field by ignoring it, then re-reads the
  documented REST state when it needs recovery.

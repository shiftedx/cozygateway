# CozyGateway Bot Mode extension (`com.cozylabs.bots`)

Status: v1 extension, capability version 26. This extension is independent of the frozen core
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
"capabilities": { "com.cozylabs.bots": 26 }
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

Version 13 was never shipped. A client gates only the feature it renders; unknown optional fields
and unknown server frames are ignored.

## Resources

The TypeBox schemas are normative. The names below identify complete shapes rather than maintaining
a second, hand-copied schema.

- `BotSummary` is one control-plane roster row. Its `chatSessionId`, `preview`, and
  `lastActiveAt` are overlaid from the configured bot's gateway-owned native chat. Profile metadata
  remains Hermes control-plane data.
- `BotChatMessage` is a durable native transcript row. `id` is the gateway/attach event message
  id, `at` is gateway-clock milliseconds (or `null` when unavailable), and `clientId` is an
  optional sender echo. Roles are `user` or `assistant` in the projection. Attachments are
  gateway-scoped opaque `fileId` values, never paths or URLs.
- `BotSessionSummary` is a durable native Bot Mode session. Current native Bot Mode sessions have
  `kind: "conversation"`; `startedAt` and `lastActiveAt` are milliseconds. They are not Hermes
  Dashboard session records.
- `BotProfile`, `BotCatalog`, `BotModelConfig`, and `BotRoutine` are Hermes control-plane
  resources. The profile source may report `runtimeInert` sections that Hermes stores but does not
  execute.
- `BotInboxThread` and `BotInboxMessagesResponse` are the read-only Hermes A2A projection.
- `BotGroup`, `BotGroupDetail`, and `BotGroupMessage` are gateway-owned room resources.
- `BotSlashCommand` is one canonical command advertised by the authenticated profile plugin. Its
  slash-prefixed `name` is the exact invocation; `description`, optional `argsHint`, and optional
  `category` are presentation metadata. `BotSlashCommandCatalog` is the bounded ordered list.
- `BotAttachmentHistoryItem` identifies one assistant attachment in a durable native transcript,
  including its bot, session, message caption, timestamp, and ordinary opaque attachment block.
  `BotAttachmentHistory` is a newest-first bounded page with an optional next offset.

Only profiles configured in `hermes.profiles` are exposed as CozyChat bots. Profile lifecycle
belongs to Hermes: create or delete the profile there, then rerun the CozyGateway installer (its
default `--profiles all` selection reconciles plugin, token, service, and gateway configuration).

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

### Attachments and media

Photo bytes are validated and stored by the gateway before the associated attach-v1 command is
sent. Plugin events refer to media by opaque ids; the gateway commits acceptable media into its own
store. `GET /bots/:name/chat/attachments/:fileId` serves only those gateway-owned bytes and
supports a single byte range for capability 20 playback. It never exposes a Hermes-host path.
Capability 24 additionally admits one 20 MiB document per turn: PDF; UTF-8 plain text, Markdown,
CSV, JSON, or RTF; legacy Office; OOXML; and OpenDocument files. The gateway checks the declared
allow-listed MIME against lightweight format bytes, stores the sanitized filename as metadata, and
serves every attachment with `Content-Disposition: attachment` and `nosniff`.

`GET /bots/:name/media?src=` is a separate HTTPS media proxy for a public source URL in bot output;
it is not a native attachment transport and it refuses unsafe/non-HTTPS sources.

## HTTP routes

Every route below requires device authentication. All normal failures use core `ErrorBody` unless a
route documents an extension-specific code. Names are normalized at the boundary. The schemas named
in this table are exported from `packages/contract/src/ext-bots.ts`.

| Route | Request | Success response | Notes |
| --- | --- | --- | --- |
| `GET /bots` | — | `{ bots: BotSummary[], updatedAt, stale }` | Hermes control-plane roster, with native-chat overlay for configured bots. |
| `POST /bots/focus` | `BotFocusRequest` | `{ ok: true }` | Hints control-plane polling while roster/routines UI is visible. |
| `GET /bots/catalog` | optional `q` | `BotCatalog` | Hermes profile/catalog read. |
| `GET /bots/:name/profile` | — | `BotProfile` | Hermes profile read. |
| `PATCH /bots/:name/profile` | `BotProfilePatch` | `BotProfileConfigureResponse` | Hermes profile update. |
| `GET /bots/:name/model-config` | — | `BotModelConfig` | Hermes profile model read. |
| `PUT /bots/:name/model-config` | `BotModelConfigPatch` | `BotModelConfig` | Hermes profile model update. |
| `GET /bots/:name/chat` | — | `{ name, sessionId, adoption: "created" \| "pin" }` | Resolves the selected native chat. |
| `GET /bots/:name/chat/messages` | — | `{ name, sessionId, adoption, messages, running, inflight, updatedAt, suggestion?, toolSteps? }` | Reads native transcript and native tool history. |
| `POST /bots/:name/chat/messages` | `BotChatSendRequest` | `202 { name, sessionId, message: BotChatMessage }` | Admits a native turn or steer, then appends locally. |
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
| `POST /bots/:name/approvals/:toolCallId/approve` | — | `202 { status }` | Resolves a pending native approval. |
| `POST /bots/:name/approvals/:toolCallId/deny` | — | `202 { status }` | Resolves a pending native approval. |
| `POST /bots/:name/clarifications/:clarifyId` | `BotClarifyResolveRequest` | `202 { status: "selected" }` | Resolves a pending native clarification option. |

An unavailable attach-v1 identity is a `503 backend_unavailable` on native chat actions. A profile
that exists but is not configured as a native identity must not fall through to Dashboard chat.

## Server frames

All frames travel on the existing authenticated `/ws` and are members of the closed core
`ServerFrame` union. `updatedAt`, message timestamps, and tool timestamps are milliseconds.

- `bot_roster`: complete `BotSummary[]` control-plane roster snapshot.
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
- `bot_approval_pending` and `bot_approval_resolved`: durable native tool-approval lifecycle.
- `bot_clarify_pending` and `bot_clarify_resolved`: durable native clarification lifecycle. A
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
- Tool detail, approval display names, clarification prompts/options, and group notes are
  presentation fields. Raw tool arguments, results, command text, and model reasoning are not
  serialized.
- The inbox has no send route. Bot-to-bot traffic is not another client composer.
- A client handles an unknown extension frame or optional field by ignoring it, then re-reads the
  documented REST state when it needs recovery.

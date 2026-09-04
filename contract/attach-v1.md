# CozyGateway attach-v1

Status: versioned adapter contract. It is independent of the frozen CozyChat `v1` and
`ext-bots-v1` contracts. The TypeBox source of truth is
`packages/gateway/src/adapters/attach/protocol-v1.ts`.

attach-v1 is the native Hermes plugin ↔ CozyGateway messaging data plane. CozyChat does not
connect to it: clients continue to use the existing REST, `/ws`, attachment, and push surfaces.
Hermes Dashboard JSON-RPC remains the control/read plane for profiles, roster, configuration,
models, sessions, and routines. Attach-v1 is authoritative for every configured Hermes profile's
chat sends, live turns, and groups; CozyGateway MUST NOT submit those chats through Dashboard
`prompt.submit` or settle them by polling/resuming a Dashboard session.

## Transport and negotiation

- WebSocket: `GET /attach/v1`, authenticated with `Authorization: Bearer <token>` during upgrade.
- Media bytes: `POST`, `GET`, and atomic-rollback `DELETE /attach/v1/media/:mediaId`, with the
  same bearer token.
- The plugin sends `hello` first. Any other first frame closes the socket. There is exactly one
  hello shape, carrying `version: 2`; no unversioned attach endpoint exists.
- `hello` carries a stable plugin `instanceId`, supported capabilities, event/command resume
  cursors, bounded receive limits, a spool telemetry snapshot, and may carry a bounded
  profile-local slash-command catalog. Each command has its exact slash-prefixed invocation plus
  presentation metadata; the catalog is authenticated profile state, not a negotiated attach
  capability. `hello_ack` returns the authenticated `agentId`, negotiated limits/capabilities,
  authoritative cursors, and heartbeat interval. Its capabilities are the intersection of the
  plugin offer and that identity's server-side rollout gates; neither peer sends a feature whose
  capability was not negotiated.
- `hello_ack` also carries an optional `extensions` object, mapping a vendor extension capability
  id (e.g. `com.cozylabs.bots`) to the non-negative integer version the gateway runs that
  extension at. This is separate from the negotiated `capabilities` array: an extension is
  advertised through `GatewayInfo.capabilities`, not negotiated on `hello`, so a peer that cares
  about one (for example, deciding whether a bot room turn may raise an approval, which needs
  `com.cozylabs.bots` at version 51 or later) reads its version straight off `hello_ack` instead
  of making a separate round trip. The field and every key in it are optional; a peer that does
  not recognize `extensions`, or a given key in it, ignores it, per the usual forward-compatibility
  rule for unknown members.
- The endpoint path remains `/attach/v1`. `hello.version` is a fixed literal, not a negotiation
  knob: a hello carrying any other version is closed with `1008` and a logged reason naming the
  version it sent. There is no downgrade ladder and no reduced capability set, so a contract skew
  between the two peers is a loud connection failure rather than a surface that quietly goes dead.
  A handshake that stalls before its `hello_ack` is re-dialed once with the identical hello.
- A newer authenticated connection supersedes the older connection for that identity.

## Delivery and replay

Commands (gateway → plugin) and events (plugin → gateway) have separate monotonically increasing
sequences. Every durable frame also has a stable `commandId` or `eventId`.

Delivery is at least once. A sender retains a frame until the receiver ACKs the matching channel,
sequence, and id. The gateway commits an event to its SQLite inbox before sending its ACK. The
plugin commits commands and events to its SQLite spool before ACK/send. On reconnect, the gateway
reconciles its outbox through the authenticated plugin's durable contiguous command cursor (and
refuses a cursor beyond the issued tail), closing the lost-command-ACK window without executing a
command twice. Remaining frames replay after the peer cursor and are deduplicated by stable id.
The plugin likewise reconciles the authoritative cursors in `hello_ack`: it may fast-forward a
recreated empty spool to the gateway's durable stream, but MUST refuse an event fast-forward that
would skip locally pending work. This makes spool replacement recoverable without replaying an
already-ACKed command or creating a permanent gap loop.

The gateway's spool watchdog handles a well-formed next-sequence event that is permanently unusable
because its capability was not negotiated or its target is no longer authorized. In one transaction
the gateway journals the event as `discarded`, records a bounded reason, advances the event cursor,
and returns an event ACK with `discarded: true`. The plugin treats that ACK like any other durable
ACK, removes the local spool entry, and continues on the same connection. Discarded events are never
projected and do not count as actionable projection dead letters. Sequence conflicts still fail
closed, while transient projection failures retain the retry and ordered dead-letter behavior below.

Sequences are contiguous. A receiver that observes a future sequence sends `gap` and applies
nothing after the missing point. A sender either replays from `requestedAfter` or, after configured
retention makes that impossible, reports `earliestAvailable`/`latestAvailable`; an operator must
then reconcile from durable transcript state. Sending in both directions is bounded by negotiated
unacked-frame count, byte budget, and WebSocket buffered bytes. An ACK frees exactly one live slot;
heartbeats and new enqueue operations do not resend the existing window. Backpressure never
discards either durable outbox.

## Lifecycle

Commands are `turn`, `steer`, `interrupt`, `resolve_approval`, and `resolve_clarify`. Capability
60 additionally defines `session_deleted { sessionSha, deletion: { id, revision, at } }`: a
durable, ordered, metadata-only tombstone for the peer's bounded local search projection.
`sessionSha` is `sha256(sessionId)` and `deletion.id` is opaque; the command carries no raw
session id, transcript, title, path, device, or human label. A peer applies the command
idempotently and ACKs it through the ordinary command cursor. A
capability-free `discard` transport tombstone replaces a disconnected queued command if the
reconnecting plugin no longer negotiates its capability; it advances sequence/dedupe state but
MUST invoke no Hermes action. Stable
agent/thread/turn/message/approval/clarify ids are preserved end to end.

A `turn` command MAY carry `context`, capability-47 typed provenance the gateway fills in on ROOM
turns: `room` (`key`, `name`, `epoch`, and an optional `seq`, the highest room seq the member has
been shown, absent rather than zero when there is nothing to name),
`actors` (every room member plus the human, each with `name`, `handle`, `displayName`, and `kind`
of `member` or `user`), and `cause` (`{ kind, seq }`: what this member is being asked to answer).
It is strictly decoration. The `text` a peer receives is byte-identical with and without it, so a
peer that ignores `context` behaves exactly as it did before, and a peer that reads it gets typed
actors instead of parsing them back out of the prompt header. `context` is absent on a 1:1 turn.

Events are `draft`, `commit`, `failed`, `cancelled`, `interrupted`, `tool`, `delegation`,
`thinking`, `approval`, `clarify`, `scheduled`, `media`, and `presence`.

- A draft is full-replace decoration and may be dropped by clients.
- A `commit` projects one durable message. It also SEALS the turn unless it carries
  `continues: true`, which says the message is a reply the agent produced part-way through a run
  that is still going. An interim commit is projected exactly like any other message; the turn's
  state stays running, its tool steps keep their own lifecycle, and later `tool` and `draft` events
  for the same `turnId` are still applied. The field is additive and optional in both directions:
  a plugin that never sends it, and a gateway that does not read it, behave exactly as before.
  A turn carrying interim commits is sealed by the first `commit` without `continues`, by
  `failed`/`cancelled`/`interrupted`, or by the gateway's configured turn timeout.
- Only the plugin can mark `continues`. Every reply of a turn is the same frame on the wire, so the
  gateway has nothing to judge it by; the plugin sits next to Hermes, which marks its own final
  delivery for a turn and marks nothing else that way.
- Exactly one of `commit` (without `continues`), `failed`, `cancelled`, or `interrupted` seals a
  turn. Replays are idempotent. A later terminal or late draft is durably acknowledged but cannot
  change the sealed result.
- Every turn seals. A turn is durable, so an unsealed one reads as "thinking" on every device
  forever. Three obligations follow, and none of them adds a frame kind or a field:
  - A turn whose message the plugin's harness consumes as a slash command runs no agent turn and
    may produce no reply at all. The plugin seals it anyway: `commit` when the command has notice
    text, `cancelled` when it has none, `failed` when the command raised.
  - An `interrupt` command ALWAYS produces a terminal. When the plugin has live work to stop, its
    harness's own terminal seals the turn; when it does not, the plugin emits `interrupted` itself
    after a bounded grace, rather than acking the interrupt and leaving the turn open.
  - The gateway keeps a server-side floor for the cases no plugin can report, a plugin that hangs
    mid-command included: an active turn that has produced NO event for a bounded window seals
    `interrupted` when an interrupt was acked for it, or `timed_out` past a hard ceiling. Silence
    is the whole signal and live work is never silent (tool steps, drafts, interim commits), so a
    legitimately long run is never reaped. Both bounds are operator-configurable.
- Tool calls use a stable `callId` with `running` → `ok|error` terminal transitions.
- `delegation` (capability `delegation`) is the child lifecycle behind live delegation batch
  cards: one event is one child update carrying (batchId, childId, index, count), a bounded
  label, a closed status vocabulary, and at most a tool NAME -- never args, results, reasoning,
  or child summaries. Identity is (batchId, childId); `childId` is the Hermes child session id,
  present on both lifecycle legs, so it is the upsert key. A batch may outlive its turn (async
  dispatch), so events legitimately arrive after the turn sealed. Once the plugin learns the
  canonical Hermes delegation id from the structured `delegation_id` field of the parent
  `delegate_task` result, subsequent events for the batch carry it as an optional batch-level
  `aliasId` (typically from the finish legs onward); it never replaces (batchId, childId) as
  identity, and a gateway that predates the field ignores it. Like `draft` and `tool` it is
  EPHEMERAL rendering state: an undeliverable one is skipped after bounded retries and must
  never dead-letter the stream.
- `thinking` (capability `thinking`) is a rolling live-reasoning preview behind the turn's
  thinking shimmer: a sanitized tail of at most 280 chars (schema-enforced), a plugin-monotonic
  per-turn `seq` (lower-or-equal replays are acknowledged and dropped), and a plugin-clock
  `lastActiveAt`. Latest-only: each event replaces the previous one for its turn. It is never
  emitted after the turn's terminal, never persisted, and gone on reopen. Like `draft` and
  `tool` it is EPHEMERAL rendering state: an undeliverable one is skipped after bounded retries
  and must never dead-letter the stream.
- Approval and clarify records have stable ids. Resolution commands are idempotent; the first
  terminal outcome wins. Pending records may carry expiry times and resolve to `expired` once.
- `approval` (capability 56, `com.cozylabs.bots >= 56`) MAY carry `detail`, a short sentence
  naming what the approval concretely covers -- for example which Chrome and which profile a
  browser tool would drive. The schema bound on the wire is deliberately loose: the gateway is
  the sole authority on the DISPLAY value, which is trimmed, has every C0/C1 control character and
  Unicode "Format" (Cf) code point stripped, and is capped at 400 characters, truncating an
  overlong sentence at the last whole word and appending an ellipsis. Unlike a value a person
  types and can retype, a malformed `detail` is sanitized rather than a reason to refuse the
  frame -- the approval it describes is not dropped over one presentation field. The sanitized
  sentence is carried on the Bot Mode `bot_approval_pending` frame and the durable interaction
  record when present, and omitted (byte-identical to a pre-56 payload) when the raising event
  carried none. It never appears on the resolve path or on `bot_approval_resolved`.
- Capability 51 (`com.cozylabs.bots`). A ROOM member turn may raise `approval`, `clarify` and
  `tool` events, which the gateway previously acknowledged and dropped. Nothing on this wire
  changes: the ids, the statuses, and the `resolve_approval` / `resolve_clarify` commands the
  gateway sends back are the same ones a 1:1 turn uses, addressed to the same `threadId` (the
  gateway-owned `group:<room>:<member>` thread) and `turnId` the `turn` command carried. A peer
  therefore raises one in a room exactly as it does in a chat, `expiresAt` included: a room
  interaction runs on the same deadline a chat one does. The gateway also EXPIRES a room
  interaction still pending when its member turn seals, so a peer must not expect a resolution
  after it has sealed the turn that asked.
- `scheduled` is an unanchored durable delivery with a caller-owned occurrence key. Its target is either
  an explicit `threadId`, or `{ "kind": "canonical_home" }`. The latter is meaningful only for the
  authenticated native Bot Mode identity: admission atomically binds the delivery to that identity's
  current home session and persists the binding. A replay of the same `deliveryId` keeps that original
  binding even if `/new` subsequently selects another session. Hermes cron is the implemented producer
  and uses its cron-session key; a future trigger integration may supply its own durable key through the
  same seam. The reference plugin emits `canonical_home` for cron and preserves/derives stable
  delivery and message ids from that key. It does not require an active request turn. Gateway projection deduplicates the delivery, commits it
  directly, and invokes the existing push decision once. An explicit native Bot Mode target must equal
  the gateway's currently selected canonical/home session; a foreign or historical target is rejected
  before inbox admission.
- `presence` supplements transport health. The gateway reports online only after hello, degraded
  after missed heartbeats/backpressure, and absent after timeout/close. Clients reconnect with
  exponential backoff and jitter.

`GET /health` and `GET /ready` additionally expose one aggregate `attach` summary: configured,
online, degraded, and absent profile counts; the most recent valid heartbeat, durable event, and
terminal timestamps; plus durable command queue depth and dead-letter count. It contains no
profile ids, instance ids, frame ids, or payload content. A timestamp is `null` until observed in
the current process (heartbeat) or durable journal (event/terminal).

## Memory management lane

`memory_request` / `memory_result` is a bounded live request/reply lane, never a durable command,
event, push, transcript, or Gateway database row. Ordinary source reads and conditional item
mutations negotiate `memory_management`. Capability-42 `operation: "setup"` additionally requires
`memory_setup`; its input is the closed public `BotMemorySetupRequest` and the plugin repeats that
validation at the authenticated profile boundary. Setup is an idempotent mutation cached by
request id. It writes only the three credential-free Hermes memory settings through Hermes'
native atomic config writer and replies with a fresh `BotMemoryOverviewResponse`. A disconnected
or old plugin fails immediately; a timed-out request is not retained for reconnect.

## Bot config lane

`config_request` / `config_result` is the same bounded live request/reply shape as the memory lane
above, negotiated as `bot_config`, and it is never a durable command, event, push, transcript, or
Gateway database row. It exists for a bot served by a non-Hermes runtime (capability 45): that peer
owns its own profile, model selection and routines, and the gateway holds no Dashboard row to read
them from.

The nine operations are `profile.read`, `profile.write`, `model.read`, `model.write`,
`routines.list`, `routines.create`, `routines.update`, `routines.delete` and `routines.run`. Every
input and every result is a PUBLISHED `com.cozylabs.bots` schema rather than a lane-local
restatement, so a peer implements exactly the shapes its REST clients already read: `BotProfile`
and `BotProfilePatch`, `BotProfileConfigureResponse`, `BotModelConfig` and `BotModelConfigPatch`,
`BotRoutineListResponse`, `BotRoutineCreateRequest`, `BotRoutinePatch`, and
`BotRoutineWriteResponse`. A routine write names its routine in `input.id`, separately from the
patch body, because on REST that id is the path segment and the published patch schema has none.
`routines.delete` and `routines.run` answer `{ "ok": true }`, the one lane-local body, because
neither operation stores something to send back.

`routines.run` is RESERVED in this version. It is on the wire so a peer implements the whole set
once rather than absorbing a second wire change later, but no gateway route reaches it: nothing
sends a `routines.run` request today. A peer may answer it `invalid_request`, or implement it as a
no-op that acknowledges without running anything, until a route lands. Neither choice is observable
by a client in this version.

`not_found` means something different for a read than for a write. On the two BODYLESS reads,
`profile.read` and `model.read`, it means the peer serves the bot but has nothing stored for that
section, and the gateway answers `404 not_found` saying exactly that: the bot itself still exists.
On a write, on `routines.list`, or on `routines.create` it is the peer failing to do what it was
asked, and stays a `503`. On a routine operation carrying `input.id` it names that routine and is a
`404` about the routine.

`status` is `ok`, `not_found`, `invalid_request`, or `unavailable`, and the four are kept apart
because they are four different things an operator has to do: nothing, fix the id, fix the input,
or go and look at the peer. `ok` with a body that does not match the operation is refused rather
than cast. A disconnected peer fails immediately; a timed-out request is not retained for
reconnect; and the lane spends a bounded per-bot budget so a looping client is stopped at the
gateway rather than at the peer.

A peer that is attached but never negotiated `bot_config` is NOT reported as unavailable. It reads
exactly like a bot with no config lane at all, which is the true answer: those routes keep the
`409 unsupported_for_runtime` of capability 45, because the section is absent rather than
temporarily unreachable. Deletion, model-provider setup, and desktop-session transcripts stay on
that 409 for every runtime bot: none of the three has a peer-side equivalent.

## Bot history lane

`history_request` / `history_result` is the bot-config lane's shape again, negotiated separately as
`bot_history`, and it is likewise never a durable command, event, push, transcript, or Gateway
database row. It exists for a bot served by a non-Hermes runtime (capability 45) that checkpoints
its own workspace into git: the peer owns the repository, and the gateway stores no copy of a
checkpoint, a diff, or a working tree.

The seven operations are `list`, `diff`, `restore`, `try.start`, `try.keep`, `try.discard` and
`resolve`. Their inputs are `{since?, limit?}`, `{from, to?}`, `{checkpoint}`, `{label}`, `{}`,
`{}`, and `{choices: [{path, pick}]}`. Every result is a PUBLISHED `com.cozylabs.bots` schema, for
the same reason the config lane's are: `BotHistoryListResponse`, `BotHistoryDiffResponse`,
`BotHistoryRestoreResponse`, `BotHistoryTryStartResponse`, `BotHistoryTryKeepResponse`,
`BotHistoryTryDiscardResponse`, and `BotHistoryResolveResponse`. `try.keep` and `try.discard` name
no experiment because there is at most one in flight per bot and the peer owns which; a client that
had to name it would be a second place the answer is stored.

**Nothing content-shaped crosses this lane.** A `diff` answers with per-file line COUNTS and never
a patch, a checkpoint answers with a one-line summary and never a file, and a conflict answers with
one bounded label per side and never the two versions themselves. That is a boundary rule, not a
size limit.

`status` is `ok`, `conflict`, `not_found`, `invalid_request`, or `unavailable`. That is one more
than the config lane, because keeping an experiment has a fifth answer that is neither success nor
failure: `conflict` means the work is intact and a PERSON has to choose per file. It carries its
`BotHistoryTryKeepResponse` body exactly as an `ok` would, with `merged: false` and the `conflicts`
array populated, because that body IS the question being asked; a `conflict` that names no files is
refused, since a per-file choice with no files is a dialog with no buttons. `ok` with a body that
does not match the operation is refused rather than cast.

A disconnected peer fails immediately, and a timed-out request is not retained for reconnect. That
rule matters more here than it did for config: a `restore` that landed minutes after the person
gave up on it would silently throw away everything they did in between. The lane spends the same
bounded per-bot budget, so a Changes pane in a loop is stopped at the gateway rather than at the
peer.

A peer that is attached but never negotiated `bot_history` is NOT reported as unavailable. Those
five routes answer `409 unsupported_for_runtime`, exactly as a Hermes bot's do, because the section
is absent rather than temporarily unreachable.

This contract deliberately shipped with no thinking/reasoning/chain-of-thought event. The
`thinking` capability is a CONSCIOUS, bounded reopening of that rule (approved 2026-08):
reasoning models deliver their visible reply in one end burst, leaving the whole turn a generic
spinner. What reopened is a sanitized 280-char latest-only preview -- raw chain of thought, tool
args/results, prompts, credentials, and file paths still never cross this wire, and the preview
is never part of the transcript. Unknown and invalid frames are never projected into the
transcript.

An admitted event whose app projection transiently fails remains unapplied and is retried in
sequence by a bounded in-process exponential-backoff worker. Successful retries are idempotent.
After the configured attempt bound it becomes a durable dead letter with attempt count/error and
the identity reports degraded. That sequence is a hard stream projection barrier across restart:
no later event projects until an operator explicitly releases the earliest dead letter, which
retries that event before advancing in order.

## Scheduled delivery receipt

`GET /attach/v1/deliveries/:deliveryId` uses the same attach bearer as the WebSocket and media side
channel, but is not gated on the optional media rollout. It exposes only the requesting profile's
delivery record. It returns `404` when no delivery has reached gateway admission; plugin-local
`journaled` is therefore intentionally not represented here. A receipt is one of:

- `admitted`: the event is durably in the gateway inbox and awaits ordered projection;
- `projected`: the Bot Mode transcript commit is durable;
- `blocked`: projection reached the durable dead-letter barrier; it includes attempt count and the
  dead-letter timestamp, and may later progress to `projected` only after ordered operator release.

The route does not claim `notified`: gateway push is intentionally fire-and-forget, and a push attempt
is not proof that a device or a human received it. A plugin must report a local enqueue as `journaled`
or `accepted_pending`, not delivered, until this route reports `projected`.

A receipt additionally carries two optional fields, both added with the `delivery_receipts`
capability and both absent until the fact they describe exists:

- `displayedAt`: when a paired device reported the projected row on screen.
- `terminal`: the one terminal fact about this occurrence, as
  `{ "state": "displayed" | "failed", "stage"?, "reason"?, "at" }`. `state` above is unchanged and
  still describes the projection pipeline; `terminal` describes the OCCURRENCE. `displayed`
  outranks `failed`, states never regress, and `stage` is `authorization` (quarantined at inbox
  admission) or `projection` (dead-lettered after retries).

When the admitted `scheduled` event has a non-empty `mediaIds` array, the HTTP receipt additionally
carries these three fields together (and omits all three for text-only deliveries, preserving that
legacy response shape):

- `expectedMediaIds`: the admitted event's media IDs, in order, bounded to the protocol maximum of
  16;
- `committedMediaIds`: the `fileId` values actually present on the committed native
  `BotChatMessage`, in attachment order. It is `[]` before durable projection or when that row has
  no attachments;
- `mediaVerified`: `true` only when projection is durable and those two arrays are exactly equal,
  including order. Admission, upload, notification, and `displayedAt` are not media verification.

These are read-back-only HTTP facts. They do not enlarge the durable `delivery_receipt` command.

### `delivery_receipt` command

Negotiating `delivery_receipts` asks the gateway to push those same facts back down the ordinary
durable command channel rather than making the plugin poll:

```json
{ "kind": "delivery_receipt", "deliveryId": "...", "messageId": "...",
  "state": "displayed", "at": 0, "stage": "projection", "reason": "..." }
```

`stage` and `reason` are present only for `state: "failed"`, and `reason` is bounded at 256
characters. The gateway emits at most one command per occurrence and state, keyed
`rcpt:<deliveryId>:<state>`, so a redelivery after reconnect is the same `commandId` and a plugin
that has already applied it acks it again and does nothing. A plugin keeps the FIRST terminal
state it sees.

Three things raise a receipt: a device reporting a scheduled delivery's row displayed; a scheduled
event quarantined at admission (`failed` / `authorization`, carrying the discard reason); and a
scheduled event dead-lettered after projection retries (`failed` / `projection`, carrying the
truncated projection error). Failures before gateway admission stay plugin-local: the gateway
cannot report an event it never saw.

A plugin that never negotiates `delivery_receipts` is unaffected. A receipt is never queued for a
connected plugin that did not negotiate it, and one queued while that plugin was away is converted
to the ordinary `discard` tombstone on reconnect, exactly like any other unsupported command, so
the command sequence advances and nothing stalls.

A terminal FAILURE is also surfaced to the human: the gateway appends one marked row
(`marker: "delivery.failed"`, role `system`, ext-bots-v1 capability 31) to that bot's current
canonical chat, so a cron report that never arrived is visible instead of silently absent.

## Media

WebSocket frames carry only `mediaId`, MIME, byte count, SHA-256, safe filename, family, optional
caption/alt text, and expiry. Bytes use the authenticated HTTP side channel; base64 blobs and
Hermes host paths are forbidden.

Uploads are immutable and scoped to the authenticated identity. The gateway verifies maximum size,
sniffed family/MIME, declared size, and SHA-256 before commit. The accepted MIME set and the refusal
statuses are documented once, in contract/ext-bots-v1.md under "Canonical media allowlist" and
"Media rejection shapes"; the plugin policy table mirrors that list. Downloads support byte ranges and
expiry. A failed media item does not invalidate text or other valid media in the same committed
message; missing items are omitted from the app attachment list.

A `commit` or `scheduled` event carrying `mediaIds` MAY also carry `mediaPositions`, an array of
block indices aligned index-for-index with `mediaIds`: entry `i` is the index in that message's
normalized block array BEFORE which media `i` renders. When present it MUST have exactly the length
of `mediaIds`; a partial array is not a shape this protocol has, because it would silently claim
index `0` for every attachment it omitted. A plugin that is not certain where its attachments
belong omits the field, and the gateway then builds the unpositioned attachments it always built.
The gateway threads `mediaPositions[i]` onto the attachment built from `mediaIds[i]`; the reader
clamps an out-of-range index rather than dropping the attachment. The rendering rules live once, in
contract/ext-bots-v1.md under "Inline media ordering".

An atomic producer that abandons an occurrence removes its local descriptor events first and then
uses authenticated `DELETE` for each uploaded id. `204` is idempotent, including when a prior
cleanup already removed the id. The gateway refuses to remove a media item already referenced by a
durable commit or scheduled delivery; that object is reachable and is not an orphan. A plugin keeps
failed cleanup ids in its durable spool and retries them after reconnect.

## Bot Mode projection

Native events are translated into the ext-bots-v1 `bot_chat_delta`, `bot_chat`, `bot_chat_state`,
`bot_tool_activity`, `bot_approval_*`, capability-22 `bot_clarify_*`, authenticated attachment
downloads, transcript history, and encrypted push behavior. CozyChat still has only its existing
gateway connection; it never connects to Hermes or attach-v1.

Configuration is one identity per profile under `hermes.profiles.<profile>`, whose `tokenEnv`
names the unique attach bearer token. That same identity powers both the core `/agents` and
`/threads` surface and Bot Mode `/bots`; it is not duplicated in `agents[]`, and there are no
`shadow`, `native`, or feature-rollout modes.

There is no protocol downgrade. Peers that do not speak attach-v1 are rejected rather than routed
through a less reliable transport.

### Ephemeral Mobile Node lane

When `mobile_node` is negotiated, a plugin may send an unsequenced status `mobile_request` for
the active native Bot Mode turn only:

```json
{ "kind": "mobile_request", "requestId": "...", "command": "device.status", "threadId": "...", "turnId": "...", "expiresAt": 0, "purpose": "Report phone readiness" }
```

One-shot `location.current` additionally requires negotiated `mobile_location`; status requires
`mobile_node`. Neither capability enables a legacy status shape:

```json
{ "kind": "mobile_request", "requestId": "...", "command": "location.current", "threadId": "...", "turnId": "...", "expiresAt": 0, "purpose": "Find nearby coffee" }
```

Every mobile request `purpose` is a trimmed, normalized nonempty string no larger than 160 UTF-8 bytes and contains no
C0/C1 control characters; invalid input is rejected rather than truncated. Status and location
expire within 30 seconds. Camera, file-picker, and notification interactions expire within 120
seconds so a foreground human action can finish while remaining bounded. Success remains
commandless because the pending `requestId` binds the command:
`{ "kind": "mobile_result", "requestId": "...", "status": "ok", "result": { "latitude": 41.88, "longitude": -87.63 } }`.
Both coordinates must be finite, range-bounded (`latitude [-90,90]`, `longitude [-180,180]`), and
have no more than two decimal places. The gateway rejects an incompatible result shape.

The gateway replies directly with one unsequenced `mobile_result`. For status it forwards the
phone's closed v2 operational fields and adds `authenticatedReachable: true` and integer epoch-ms
`lastAuthenticatedPresenceAt`. Only the gateway stamps those fields, after receiving a valid result
from the selected authenticated paired-device socket; the phone status schema rejects them. The
attach status object is closed, its nested capability objects are closed with unique commands, and
the optional phone fields remain absent when unknowable. It has no version field and rejects
identifiers, serial/device/model names, SSID/BSSID/IP, and exact battery percentages.

This lane is deliberately not
an event or command envelope, has no cursor or ACK, is never entered into either durable spool,
and is dropped on reconnect. Terminal
statuses are `denied`, `expired`, `cancelled`, `device_unavailable`, `foreground_required`, and
`policy_blocked`.

A non-`ok` result MAY carry both `stage` and `reason` (never only one) for truthful terminal
diagnostics. Successful results are unchanged.

Stages are the closed set `policy`, `routing`, `dispatch`, `response`, `media`, `receipt`, and
`lifecycle`. Reasons are the closed set `no_selected_device`, `command_not_advertised`,
`selected_socket_unavailable`, `frame_send_failed`, `phone_disconnected_pending`,
`invalid_phone_payload`, `lease_mismatch`, `cross_device_result`, `receipt_persistence_failed`,
`broker_closed_pending`, `malformed_request_frame`, `request_expired_unanswered`,
`request_policy_rejected`, `selected_app_not_foreground`, `media_validation_failed`, and
`media_storage_failed`. Peers MUST reject unknown stages/reasons and MUST NOT substitute raw error
text. These fields describe only the bounded failure class: they never contain a purpose, request,
thread, turn, device or media identifier, path, coordinates, tokens, media contents, socket state,
or private payload. In particular, an unanswered dispatched request is `expired` with
`response/request_expired_unanswered`; an invalid phone result is `policy_blocked` with
`response/invalid_phone_payload`; and media validation/storage failures are `policy_blocked` with
the corresponding `media/*` reason. Status remains authoritative and no failure diagnostic may be
represented as `ok`.

The plugin may send `{ "kind": "mobile_cancel", "requestId": "..." }` to settle its own
pending tool. It is also negotiated, unsequenced, non-durable, and never replayed; a late phone
result is ignored. A gateway MUST neither accept a location request nor send a location result
without `mobile_location` negotiated. Purpose and all mobile payload fields are in-memory
request/result values only and are never put in the durable spool, transcript, storage, diagnostic
logs/traces, tool-hook details, audit, or push payloads.

For camera and file-picker media, the deadline governs admission to the authenticated upload route.
The gateway consumes the one-shot device/lease claim before reading the request body. An upload
claimed before the deadline may finish reading, validating, and storing after it; the consumed
claim remains replay-safe and cannot authorize a second upload.

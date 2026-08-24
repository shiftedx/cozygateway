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

Commands are `turn`, `steer`, `interrupt`, `resolve_approval`, and `resolve_clarify`. A
capability-free `discard` transport tombstone replaces a disconnected queued command if the
reconnecting plugin no longer negotiates its capability; it advances sequence/dedupe state but
MUST invoke no Hermes action. Stable
agent/thread/turn/message/approval/clarify ids are preserved end to end.

Events are `draft`, `commit`, `failed`, `cancelled`, `interrupted`, `tool`, `approval`, `clarify`,
`scheduled`, `media`, and `presence`.

- A draft is full-replace decoration and may be dropped by clients.
- Exactly one of `commit`, `failed`, `cancelled`, or `interrupted` seals a turn. Replays are
  idempotent. A later terminal or late draft is durably acknowledged but cannot change the sealed
  result.
- Tool calls use a stable `callId` with `running` → `ok|error` terminal transitions.
- Approval and clarify records have stable ids. Resolution commands are idempotent; the first
  terminal outcome wins. Pending records may carry expiry times and resolve to `expired` once.
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

There is deliberately no thinking, reasoning, or chain-of-thought event. Unknown and invalid
frames are never projected into the transcript.

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
sniffed family/MIME, declared size, and SHA-256 before commit. Downloads support byte ranges and
expiry. A failed media item does not invalidate text or other valid media in the same committed
message; missing items are omitted from the app attachment list.

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
{ "kind": "mobile_request", "requestId": "...", "command": "device.status", "threadId": "...", "turnId": "...", "expiresAt": 0 }
```

One-shot `location.current` additionally requires negotiated `mobile_location`; `mobile_node`
alone remains status-only for old plugin/server pairs:

```json
{ "kind": "mobile_request", "requestId": "...", "command": "location.current", "threadId": "...", "turnId": "...", "expiresAt": 0, "purpose": "Find nearby coffee" }
```

`purpose` is a trimmed, normalized nonempty string no larger than 160 UTF-8 bytes and contains no
C0/C1 control characters; invalid input is rejected rather than truncated. Location expiry is at
most 30 seconds. Success remains commandless because the pending `requestId` binds the command:
`{ "kind": "mobile_result", "requestId": "...", "status": "ok", "result": { "latitude": 41.88, "longitude": -87.63 } }`.
Both coordinates must be finite, range-bounded (`latitude [-90,90]`, `longitude [-180,180]`), and
have no more than two decimal places. The gateway rejects an incompatible result shape.

The gateway replies directly with one unsequenced `mobile_result`. This lane is deliberately not
an event or command envelope, has no cursor or ACK, is never entered into either durable spool,
and is dropped on reconnect. The only successful payload is `{ "foreground": true }`; terminal
statuses are `denied`, `expired`, `cancelled`, `device_unavailable`, `foreground_required`, and
`policy_blocked`.

The plugin may send `{ "kind": "mobile_cancel", "requestId": "..." }` to settle its own
pending tool. It is also negotiated, unsequenced, non-durable, and never replayed; a late phone
result is ignored. A gateway MUST neither accept a location request nor send a location result
without `mobile_location` negotiated. Purpose and raw coordinates are in-memory request/result values only and are
never put in the durable spool, transcript, storage, logs, traces, audit, or push payloads.

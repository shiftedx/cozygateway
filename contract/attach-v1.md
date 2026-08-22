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
- Media bytes: `POST` and `GET /attach/v1/media/:mediaId`, with the same bearer token.
- The plugin sends `hello` first. Any other first frame closes the socket. Version 1 is selected by
  the endpoint plus `hello.version: 1`; no unversioned attach endpoint exists.
- `hello` carries a stable plugin `instanceId`, supported capabilities, event/command resume
  cursors, and bounded receive limits. `hello_ack` returns the authenticated `agentId`, negotiated
  limits/capabilities, authoritative cursors, and heartbeat interval. Its capabilities are the
  intersection of the plugin offer and that identity's server-side rollout gates; neither peer
  sends a feature whose capability was not negotiated.
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
- `scheduled` is an unanchored durable delivery: its caller supplies the target thread and a durable
  cron-session occurrence key, from which the reference plugin preserves/derives stable delivery
  and message ids. It does not require an active request turn. Gateway projection deduplicates the
  delivery, commits it directly, and invokes the existing push decision once. The supplied target
  must equal the gateway's durable canonical/home session binding for that bot; a foreign target is
  rejected before inbox admission.
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

## Media

WebSocket frames carry only `mediaId`, MIME, byte count, SHA-256, safe filename, family, optional
caption/alt text, and expiry. Bytes use the authenticated HTTP side channel; base64 blobs and
Hermes host paths are forbidden.

Uploads are immutable and scoped to the authenticated identity. The gateway verifies maximum size,
sniffed family/MIME, declared size, and SHA-256 before commit. Downloads support byte ranges and
expiry. A failed media item does not invalidate text or other valid media in the same committed
message; missing items are omitted from the app attachment list.

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

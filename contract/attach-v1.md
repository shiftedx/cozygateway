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
  cursors, bounded receive limits, and may carry a bounded profile-local slash-command catalog.
  Each command has its exact slash-prefixed invocation plus presentation metadata; the catalog is
  authenticated profile state, not a negotiated attach capability, so old peers ignore it.
  `hello_ack` returns the authenticated `agentId`, negotiated
  limits/capabilities, authoritative cursors, and heartbeat interval. Its capabilities are the
  intersection of the plugin offer and that identity's server-side rollout gates; neither peer
  sends a feature whose capability was not negotiated.
- The endpoint remains `/attach/v1`; `hello.version` selects this capability grammar. A v2-aware
  plugin first sends `hello.version: 2`, which is the only hello version that may
  offer `mobile_location`. A new gateway accepts and acknowledges both v1 and v2. To remain
  compatible with a closed old v1 server, the plugin uses a bounded pre-ack timeout, closes that
  attempt, then reconnects once with `hello.version: 1` and the old capability list. The v1
  fallback is status-only: no location request is sent or replayed while it is selected.
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
- `scheduled` is an unanchored durable delivery: its caller supplies the target thread and a durable,
  caller-owned occurrence key. Hermes cron is the implemented producer and uses its cron-session key;
  a future trigger integration may supply its own durable key through the same seam. The reference plugin
  preserves/derives stable delivery and message ids from that key. It does not require an active request
  turn. Gateway projection deduplicates the delivery, commits it directly, and invokes the existing push
  decision once. For native Bot Mode, the supplied target must equal the gateway's currently selected
  canonical/home session; a foreign or historical target is rejected before inbox admission.
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

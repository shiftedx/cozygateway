# CozyRunner control stream, `runner-v1`

Status: v1, capability `com.cozylabs.bots` 49. Gateway side implemented in
`packages/gateway/src/runner/`. The runner itself lives in the CozyAgents repo and ships as
`cozyagents runner`.

This is a PRIVATE control stream between one gateway and one CozyRunner. No phone speaks it, no
client gates on it, and nothing here is published in `cozygateway-contract`: the app-facing halves
are `POST /bots {runtime: "cozyagents"}`, `GET /bots/:name/runtime`, and `DELETE /bots/:name`, all
documented in `ext-bots-v1.md`. The boundary this protocol implements is ADR 0002 (Reconcile one
fenced container runtime per Bot through CozyRunner): the gateway is the durable lifecycle
authority and CozyRunner is the only component that touches Docker.

Wave 3 implemented the smallest slice of that ADR: create and delete. Capability 52 adds pairing
codes and per-runner credentials, described below. Upgrades, restart backoff, drain windows,
isolation policy, capacity admission, and reconciliation of unknown containers remain out of scope
and are not implied by anything below.

## Transport and authentication

The runner dials OUT to the gateway. There is no inbound path to the runner and no lifecycle API
on a bot container.

```
GET /runner/v1
Upgrade: websocket
Authorization: Bearer <COZYRUNNER_TOKEN>
```

- **Per-runner token (capability 52, the current path).** `POST /pair {setupCode, deviceName,
  kind: "runner"}` mints 32 random bytes, stores only their hash on a `runners` row, and hands the
  token back once. The runner keeps it in its own `COZYRUNNER_TOKEN`. The gateway resolves the
  bearer by hashing it and looking the hash up, so a wrong token is never compared byte by byte
  against a real one. It authenticates this socket and nothing else: no chat, no device list, no
  bot creation. `DELETE /runners/:id` revokes it and closes the socket.
- **Shared token (legacy, still supported).** `COZYGATEWAY_RUNNER_TOKEN`, placed by the local admin
  and matched with the same constant-time scan every other credential on this gateway goes through.
  It keeps its old behaviour exactly: one connection, superseded by any other legacy hello. It
  appears in `GET /runners` as one row with id `legacy`, which cannot be renamed or deleted from the
  app; unsetting the variable is how it goes away.
- A wrong or missing token closes the socket `1008`. The same credential also opens `GET
  /runners/self`, which answers that one runner's row plus `attached` and, only when its current
  authenticated hello supplied it, `agentVersion`; it opens nothing else on this gateway.
- The path is always registered from 52, because a runner pairs at runtime and a lane built only for
  an operator-placed variable would leave a freshly paired runner with nowhere to dial. A gateway
  with no runner at all still accepts and stores runtime operations; they simply wait.
- **One socket per runner, not one socket.** A second authenticated hello for the SAME `runnerId`
  supersedes the first with close code `4000`, because two reconcilers against one host is exactly
  the failure the single-writer rule exists to prevent. A hello for a DIFFERENT runner is a
  different machine and gets its own socket: two runners are two hosts.
- A `hello` whose `runnerId` does not match the row its bearer resolved to closes `1008`. A runner
  may not claim another runner's identity, and that mismatch is skew or theft, never a rename.
- Every frame is one JSON object with a `kind`.
- **Additive by default.** Unknown PROPERTIES on any runner frame are ignored, never echoed and
  never persisted; a runner is free to start reporting an image digest or a measured isolation
  level without waiting for the gateway. A frame whose `kind` this gateway does not know is
  likewise ignored with a log line and the socket stays open.
- A frame whose `kind` IS known but whose shape is malformed closes the socket `1002`, as does an
  unparseable frame. That skew is in a frame the gateway acts on, so it is loud rather than a
  hang.

## Runner to gateway

### `hello` (required first frame, within 5 seconds)

```json
{
  "kind": "hello",
  "version": 1,
  "runnerId": "3f8c1b2e-6a4d-4f52-9c31-0d5a7e9b2c44",
  "name": "kyle-mbp",
  "platform": { "os": "darwin", "arch": "arm64", "release": "24.5.0" },
  "agentVersion": "0.1.0",
  "backends": ["process"],
  "inventory": [{ "botId": "sage", "specGeneration": 1, "stage": "ready" }]
}
```

`runnerId` is the gateway's own row id for a runner paired through `POST /pair {kind: "runner"}`;
the pair response carries it and the runner keeps it in `COZYRUNNER_ID`. `name`, `platform` and
`agentVersion` are capability 52, all optional, and are recorded on that row and projected by `GET
/runners` (`platform` is flattened to `os/arch/release`). `name` is recorded on EVERY hello that
carries one, so renaming a computer renames its roster row rather than leaving the name it had at
pairing time. A runner that sends none of them leaves the row's columns as they were, and a runner that sends them to a gateway below 52 has them ignored,
because unknown properties are ignored on every runner frame.

`backends` is `docker`, `process`, or both. `process` is the development shim for a macOS box
without Docker and is labelled `isolation: none` in every receipt it produces. `inventory` is
optional and is what the runner believes it already holds; wave 3 records the contact and does not
reconcile from it. A `version` other than `1` closes the socket.

### `heartbeat`

```json
{ "kind": "heartbeat", "sentAt": 1800000000000 }
```

The answer to the gateway's heartbeat. It carries nothing else: liveness is the whole message.
Every frame a runner sends, this one included, moves `lastSeenAt` on its roster row, which is what
`GET /runners` reports. The 15 second interval and the 45 second silence ceiling are unchanged, and
a runner silent past the ceiling has its own socket terminated without touching any other.

### `receipt`

```json
{
  "kind": "receipt",
  "operationId": "op_...",
  "botId": "sage",
  "specGeneration": 1,
  "stage": "starting",
  "at": 1800000000000,
  "code": "image_unavailable"
}
```

An immutable stage receipt. `stage` is one of `waiting_for_runner`, `waiting_for_capacity`,
`pulling_image`, `creating`, `starting`, `ready`, `draining`, `stopping`, `stopped`, `recovering`,
`upgrading`, `deleting`, `deleted`, `needs_attention` (ADR 0002's whole vocabulary, so a runner
that learns to stop or upgrade a runtime needs no protocol change). A delete receipts `deleting`
and then the terminal `deleted` once the container and the bot-exclusive volumes are gone. `code` is a stable, safe error identifier and
is the ONLY error channel: no secrets, no environment values, no host paths, no workspace content,
and no free-form diagnostics ever cross this frame. Protected runner-side logs keep the raw detail.

A receipt naming an operation the gateway never issued, or naming a different bot than the one the
operation was issued for, is DROPPED and logged. The gateway is the lifecycle authority; a runner
cannot assert state for a bot it was not asked about.

Two ordering guards, because a runner retries and can deliver out of order:

- A receipt that would walk the recorded stage BACKWARDS along the provisioning progression
  (`waiting_for_runner` → `waiting_for_capacity` → `pulling_image` → `creating` → `starting` →
  `ready`) records the contact and leaves the stage alone. A `creating` arriving after `ready`
  must never walk a bot backwards on somebody's screen. Every other stage is a real lifecycle
  transition rather than a step along that progression, so it always applies.
- `observedGeneration` advances ONLY on a `ready` receipt. An in-progress stage says what is being
  attempted, never what is running.

## Gateway to runner

### `hello_ack`

```json
{ "kind": "hello_ack", "version": 1, "heartbeatIntervalMs": 15000 }
```

### `heartbeat`

```json
{ "kind": "heartbeat", "sentAt": 1800000000000 }
```

Gateway-initiated, every `heartbeatIntervalMs`. Total silence past 45 seconds terminates the
socket: a runner that cannot answer is a runner that cannot be handed a mutation either.

### `command: create_runtime`

```json
{
  "kind": "command",
  "command": "create_runtime",
  "payload": {
    "operationId": "op_...",
    "botId": "sage",
    "specGeneration": 1,
    "attachToken": "<secret>",
    "image": "ghcr.io/.../cozyagents@sha256:...",
    "model": { "provider": "anthropic", "id": "...", "contextWindow": 131072, "maxTokens": 8192 },
    "resources": { "cpus": 2, "memoryMb": 2048, "pids": 512 }
  }
}
```

The runner allocates the two volumes (`cozyagents-<botId>-state`, `cozyagents-<botId>-workspace`),
creates a container from the compose defaults with a private per-bot network, injects the
`COZYAGENTS_*` environment including `attachToken`, starts it, and polls readiness, receipting each
stage.

Payload fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `operationId` | string | The operation every receipt for this work names. |
| `botId` | string | The bot id, lowercase, `[a-z0-9][a-z0-9_-]{0,63}`. |
| `specGeneration` | integer >= 1 | The desired generation this command is fenced to. |
| `attachToken` | string | The container's attach credential. Secret. |
| `image` | string | Docker backend: the image reference, digest-pinned by the operator. |
| `entrypoint` | string[] | Process backend: ARGV, not a shell string. The runner spawns it directly, so quoting rules never enter into it. |
| `model` | `{id, provider?, endpoint?, contextWindow?, maxTokens?}` | Optional. `contextWindow` and `maxTokens`, when present, are canonical positive safe decimal integers. |
| `resources` | `{cpus?: number, memoryMb?: integer, pids?: integer}` | Optional. `cpus` is fractional CPUs, `memoryMb` is mebibytes, `pids` is the process-count ceiling. |

At most one of `image` and `entrypoint` is present: an image for the Docker backend, an entrypoint
argv for the process backend. `image`, `entrypoint`, `model` and `resources` are all present only
when the operator configured them (`COZYGATEWAY_RUNNER_IMAGE`,
`COZYGATEWAY_RUNNER_ENTRYPOINT_JSON`, `COZYGATEWAY_RUNNER_MODEL_*` (including the optional
`COZYGATEWAY_RUNNER_MODEL_CONTEXT_WINDOW` and `COZYGATEWAY_RUNNER_MODEL_MAX_TOKENS`), `COZYGATEWAY_RUNNER_CPUS` /
`_MEMORY_MB` / `_PIDS`). **A missing `model` means the runner uses its own default**, exactly as a
missing `image` or `resources` means its own compose defaults: the gateway never invents an image
tag, a model id, or a ceiling it cannot verify. A malformed operator value is refused on the
create that would have used it (`400`, naming the variable) rather than dropped in silence.

#### #37 cross-repo release gate

Gateway and Runner only provision these two optional values. Do not merge or release #37 as
end-to-end support until the accepted CozyAgents P0 consumer parses
`COZYAGENTS_MODEL_CONTEXT_WINDOW` and `COZYAGENTS_MODEL_MAX_TOKENS` and passes both limits to
Pi's local provider configuration. On the integration checkout, run the Gateway runner-lane and
CozyAgents runner-backend tests, then the P0 consumer test that proves a provisioned context
window reaches Pi. Until that consumer is integrated, this contract is provisioning-only and its
end-to-end result is pending.

`attachToken` is the credential the container needs to attach back to this gateway. It exists on
this frame and nowhere else: it is never written into an operations row, a receipt, a log line, or
any app-facing response.

### `command: delete_runtime`

```json
{
  "kind": "command",
  "command": "delete_runtime",
  "payload": { "operationId": "op_...", "botId": "sage", "specGeneration": 1 }
}
```

Sent after `DELETE /bots/:name` on a runtime bot. The gateway has already revoked the bot's attach
credential and purged its own rows by the time this arrives, so the container it names can no
longer authenticate anywhere. The runner removes the container and the bot-exclusive volumes and
receipts `deleting` and then the terminal `deleted`.

The gateway keeps the operation readable while this runs: `GET /bots/:name/runtime` answers
`deletion_pending` from the moment the delete is accepted, then `deleting`, and stops answering for
the name once `deleted` lands. The bot identity itself is purged immediately, before this command
is even sent.

## Delivery and durability

Operations are durable gateway rows (`runner_operations`), not socket state.

- `POST /bots {runtime}` and `DELETE /bots/:name` accept the operation and answer immediately. The
  stage stays `waiting_for_runner` until a receipt moves it, whether or not a runner is connected.
- On every authenticated hello, every operation still waiting on its FIRST receipt is (re)sent,
  oldest first. An operation a runner has already receipted is NOT resent: resuming from the last
  verified stage is the runner's job, and a resend would repeat a mutation.
- **Capability 54: the queue is per computer.** An operation row names the runner it belongs to, and
  a runner is handed only the rows that name it, so a create, a delete and a later upgrade for one
  bot all reach one machine and no other. A row written before 54 names nobody and goes to the
  account default, or to the legacy shared credential on a gateway that never paired a runner; with
  neither it keeps waiting rather than being rebuilt on a machine nobody chose.
- A `create_runtime` for a bot that was deleted before it could be sent is dropped; its
  `delete_runtime` is already queued behind it, which is the honest reconciliation.
- A second authenticated runner supersedes the first, and the operations it is owed are handed to
  it on its hello, so a runner restart resumes reconciliation without operator action.
- The gateway never blocks a user-facing route on the runner. `GET /bots/:name/runtime` is how a
  client learns where an operation actually stands.

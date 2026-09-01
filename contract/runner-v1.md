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

Wave 3 deliberately implements the smallest slice of that ADR: create and delete. Pairing codes,
short-lived per-runner credentials, upgrades, restart backoff, drain windows, isolation policy,
capacity admission, and reconciliation of unknown containers are all out of scope and are not
implied by anything below.

## Transport and authentication

The runner dials OUT to the gateway. There is no inbound path to the runner and no lifecycle API
on a bot container.

```
GET /runner/v1
Upgrade: websocket
Authorization: Bearer <COZYGATEWAY_RUNNER_TOKEN>
```

- One token, placed by the local admin in the gateway's `COZYGATEWAY_RUNNER_TOKEN` and in the
  runner's own `COZYRUNNER_TOKEN`. It is compared with the same constant-time scan every other
  credential on this gateway goes through. A wrong or missing token closes the socket `1008`.
- A gateway with no `COZYGATEWAY_RUNNER_TOKEN` does not register the path at all. It still accepts
  and stores runtime operations; they simply wait.
- One runner at a time. A second authenticated hello supersedes the first with close code `4000`,
  because two reconcilers against one Docker host is exactly the failure the single-writer rule
  exists to prevent.
- Every frame is one JSON object with a `kind`. An unparseable or unknown frame closes the socket
  `1002` rather than being ignored, so a contract skew is loud instead of a hang.

## Runner to gateway

### `hello` (required first frame, within 5 seconds)

```json
{
  "kind": "hello",
  "version": 1,
  "runnerId": "runner-1",
  "backends": ["docker"],
  "inventory": [{ "botId": "sage", "specGeneration": 1, "stage": "ready" }]
}
```

`backends` is `docker`, `process`, or both. `process` is the development shim for a macOS box
without Docker and is labelled `isolation: none` in every receipt it produces. `inventory` is
optional and is what the runner believes it already holds; wave 3 records the contact and does not
reconcile from it. A `version` other than `1` closes the socket.

### `heartbeat`

```json
{ "kind": "heartbeat", "sentAt": 1800000000000 }
```

The answer to the gateway's heartbeat. It carries nothing else: liveness is the whole message.

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
`upgrading`, `deleting`, `needs_attention` (ADR 0002's whole vocabulary, so a runner that learns to
stop or upgrade a runtime needs no protocol change). `code` is a stable, safe error identifier and
is the ONLY error channel: no secrets, no environment values, no host paths, no workspace content,
and no free-form diagnostics ever cross this frame. Protected runner-side logs keep the raw detail.

A receipt naming an operation the gateway never issued, or naming a different bot than the one the
operation was issued for, is DROPPED and logged. The gateway is the lifecycle authority; a runner
cannot assert state for a bot it was not asked about.

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
    "model": { "provider": "anthropic", "id": "..." },
    "resources": { "cpus": 2, "memoryMb": 2048, "pids": 512 }
  }
}
```

The runner allocates the two volumes (`cozyagents-<botId>-state`, `cozyagents-<botId>-workspace`),
creates a container from the compose defaults with a private per-bot network, injects the
`COZYAGENTS_*` environment including `attachToken`, starts it, and polls readiness, receipting each
stage. Exactly one of `image` and `entrypoint` is present: an image for the Docker backend, an
entrypoint for the process backend. `model` and `resources` are present only when the operator
configured them (`COZYGATEWAY_RUNNER_*`); absent means the runner uses its own compose defaults
rather than the gateway inventing an image tag or model id it cannot verify.

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
receipts `deleting` then a terminal stage.

## Delivery and durability

Operations are durable gateway rows (`runner_operations`), not socket state.

- `POST /bots {runtime}` and `DELETE /bots/:name` accept the operation and answer immediately. The
  stage stays `waiting_for_runner` until a receipt moves it, whether or not a runner is connected.
- On every authenticated hello, every operation still waiting on its FIRST receipt is (re)sent,
  oldest first. An operation a runner has already receipted is NOT resent: resuming from the last
  verified stage is the runner's job, and a resend would repeat a mutation.
- A `create_runtime` for a bot that was deleted before it could be sent is dropped; its
  `delete_runtime` is already queued behind it, which is the honest reconciliation.
- The gateway never blocks a user-facing route on the runner. `GET /bots/:name/runtime` is how a
  client learns where an operation actually stands.

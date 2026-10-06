# Hermes remote-computer stream, `runner-v1`

Status: v1, capability `com.cozylabs.runners:1`. Gateway implementation is in
`packages/gateway/src/runner/`.

This private WebSocket lets a paired remote computer prepare and run a chat execution for an
existing Hermes profile. It is not an app-facing bot runtime API: it cannot create, configure,
or delete bots, containers, or Hermes profiles. Public bot creation remains Hermes-only.

## Transport and authentication

A computer dials out to the gateway:

```text
GET /runner/v1
Upgrade: websocket
Authorization: Bearer <computer token>
```

`POST /pair` with a setup code whose kind is `runner` returns a one-time `runnerToken`. The
gateway stores only its hash in the `runners` table. A local administrator may also provide the
legacy `COZYGATEWAY_RUNNER_TOKEN`. Either credential opens only this stream. Unknown or missing
credentials close with `1008`.

A second authenticated `hello` for the same computer supersedes its earlier socket with `4000`.
A paired token may not claim a different `runnerId`; that closes with `1008`. Unknown frame kinds
are ignored; malformed known frames and malformed JSON close with `1002`.

## Computer to gateway

The first frame, within five seconds, is `hello`:

```json
{
  "kind": "hello",
  "version": 1,
  "runnerId": "paired-computer-id",
  "name": "work-mac",
  "platform": { "os": "darwin", "arch": "arm64" },
  "agentVersion": "0.1.0",
  "backends": ["process"],
  "capabilities": { "chat_execution": 1 },
  "chatExecutionHarnesses": ["hermes"]
}
```

Only a `process` computer that reports `chat_execution: 1` and explicitly lists `hermes` is available for a
remote Hermes chat. Missing harness metadata is ineligible, so an older computer is never given work it
does not advertise. The computer may send `heartbeat`, `chat_execution_receipt`, and
`chat_workspace_result` frames. Receipts are matched to the durable execution id, source Hermes
profile, session, and selected computer before they alter an execution.

## Gateway to computer

The gateway acknowledges the hello with `hello_ack` and sends heartbeat frames at the advertised
interval. Forty-five seconds of silence terminates that socket.

The only commands are `create_chat_execution`, `delete_chat_execution`, `list_chat_projects`, and
`list_chat_branches`. A create command includes an execution-specific attach token, selected
workspace, model, and the source Hermes profile settings needed for that one execution. It never
contains a provider secret. Provider credentials, when required, travel over the execution's
existing bounded attach configuration lane.

Historical CozyAgents runner and runtime records may remain in a shared database during a split
upgrade. Public CozyGateway does not attach them, dispatch operations to them, or expose them as
bots or computers.

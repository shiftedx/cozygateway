# Attach protocol v0 (adapter-facing)

Status: v0, NOT frozen. This is the gateway's adapter-facing protocol, versioned independently
of the client wire contract (`v1.md`). It may change in breaking ways until it is declared
stable. The client contract is unaffected by anything here.

## Purpose

The `attach` backend lets an agent harness answer chat turns by dialing INTO the gateway and
holding one long-lived WebSocket connection per agent. The harness side is a small plugin (a
reference implementation ships in `integrations/attach-plugin/`). The gateway pushes turn
prompts down the connection; the plugin streams the agent's reply back as typed content.

## Transport and authentication

- Endpoint: `GET /attach` (WebSocket upgrade) on the gateway's one listener.
- Auth: `Authorization: Bearer <token>`, header only. Tokens never ride URLs or frames.
- Each configured `attach` agent has its own token, supplied to the gateway by environment
  variable (the config file names the variable via `options.tokenEnv`; it never holds the
  value). The token identifies WHICH agent the connection speaks for.
- A bad or missing token closes the socket with code 1008. Treat 1008 as fatal
  (do not redial with the same credentials in a loop).
- One live connection per agent, newest wins: a second authenticated connection for the same
  agent supersedes the first, which is closed with code 4000 ("superseded"). A superseded
  plugin instance must stop redialing. In-flight turns on the superseded connection fail.
- Gateway shutdown closes connections with code 1001.

## Frames

All frames are JSON text messages.

### Gateway to plugin

One kind, the turn start:

    {"kind": "turn", "threadId": "<id>", "turnId": "<id>", "text": "<prompt text>"}

- `threadId` is the conversation key. It is stable across turns; a plugin should key its
  harness session on it so each gateway thread maps to one persistent harness conversation.
- `turnId` correlates every frame the plugin sends back for this turn.
- `text` is the user's message rendered to plain text. Rich blocks are flattened
  (headings/lists/tables/code render markdown-ish).

The gateway may start turns on different threads concurrently. Turns within one thread are
serialized by the gateway (a thread never has two in-flight turns).

Steer (mid-turn injection into the in-flight turn):

    {"kind": "steer", "threadId": "<id>", "turnId": "<id>", "text": "<prompt text>"}

- Sent only while a turn is already in flight for `threadId`. It carries the SAME `turnId` as the
  in-flight turn; the plugin injects `text` as another inbound message so the harness steers the
  running turn natively (agent-side `busy_input_mode: steer`). The continued reply keeps streaming
  under the original `turnId`; the plugin does NOT start a new turn or seal anything for the steer.

Interrupt (hard stop of the in-flight turn):

    {"kind": "interrupt", "threadId": "<id>", "turnId": "<id>"}

- Sent to stop the in-flight turn. The plugin triggers the harness's native hard stop by injecting
  a `/stop` command message (a bypass command, so it interrupts the running turn rather than
  queueing). The gateway independently fails the turn on its side and records a `turn.interrupted`
  system message, so the plugin need only trigger the native stop; any late frames for `turnId` are
  dropped by the gateway.

### Plugin to gateway

Every frame:

    {"threadId": "<id>", "update": { ... }}

The agent identity comes from the authenticated connection, never from the frame. `update` is
a closed union; a frame that fails validation is dropped (defense in depth: the plugin
normalizes at the source, the gateway re-validates).

Draft (zero or more per turn), FULL REPLACE:

    {"kind": "draft", "turnId": "<id>",
     "blocks": [RichBlock, ...],
     "toolCalls": [{"id": "<id>", "name": "<tool>", "status": "running|ok|error", "detail": "..."}, ...]}

- `blocks` is the complete current view of the reply so far (never a delta).
- `toolCalls` is the complete current set of tool-call chips, latest state per id. Omit the
  key when empty. `id` need only be unique within the turn.
- Block shapes are the client contract's RichBlock union (`v1.md`); the `attachment` type is
  never emitted by a plugin in v0.

Done (exactly one per successful turn, after the final draft):

    {"kind": "done", "turnId": "<id>"}

`done` carries no content. The gateway seals the LATEST draft's blocks as the durable reply.
Ending a turn with no draft content is invalid; the gateway records a failed turn.

Failed (instead of done):

    {"kind": "failed", "turnId": "<id>", "message": "<short reason>"}

Send best-effort when the turn errors or produced no visible content. Never send both `failed`
and `done` for one turn.

## Failure semantics

- The gateway bounds every turn with a timeout (default 600 s, per-agent configurable). A turn
  with no `done`/`failed` by then is recorded as failed; late frames for it are dropped.
- If the connection drops mid-turn, in-flight turns on it fail immediately.
- A send while no connection is live fails immediately (the client sees the standard
  `turn.failed` marker from contract v1; presence tells it the agent is absent).

## Presence

Connection liveness IS agent presence: `online` while a connection is open for the agent,
`absent` otherwise. The gateway broadcasts contract v1 `presence` frames on transitions and
reports the same state on `GET /agents`.

## Known v0 limitations (deliberate)

- No gateway-side queue-until-attached: sends while absent fail fast; clients queue locally.
- No liveness ping on `/attach`: a half-dead connection is detected by the turn timeout, not
  by heartbeat. Revisit alongside TLS for off-box serving.
- No typing/working indicator and no command manifest in the frame union.

# attach-plugin

A reference plugin for agent harnesses that support Python platform plugins. It is the
harness side of the gateway's attach protocol (`contract/attach-v0.md`): the plugin dials
OUT to the gateway's `/attach` WebSocket, receives turn prompts, and streams the agent's
reply back as typed rich blocks with live tool-call chips.

Outbound-only: nothing listens on the agent host, so it works from behind NAT with no
port forwarding.

## Install

Copy this directory into your harness's plugin directory as `cozygateway/` content plus
`plugin.yaml` (the usual directory-plugin layout), enable it, and set two environment
variables for the harness process:

- `COZYGATEWAY_URL`: the gateway base URL (for example `http://127.0.0.1:8787`).
- `COZYGATEWAY_TOKEN`: the attach bearer token for this agent. The gateway config names
  the environment variable that holds it (`options.tokenEnv`); generate your own value
  and give it to both processes. It is presented header-only and never rides a URL.

Optional: `COZYGATEWAY_CA_FILE` (private-CA TLS, unused on the current plaintext
loopback gateway), `COZYGATEWAY_RECONNECT_INITIAL_SECONDS` (0.5),
`COZYGATEWAY_RECONNECT_MAX_SECONDS` (30).

Also set `COZYGATEWAY_HOME_CHANNEL=thread` (any non-empty value works). Some harnesses
prompt to pick a "home channel" the first time a new platform delivers a message, and that
one-time prompt would consume a turn as the committed reply. The variable name derives
from the platform name, so it marks every thread as home and suppresses the prompt.

Dependencies: Python 3.10+ and the `websockets` package.

## Behavior

- One gateway thread maps to one harness conversation (the thread id is the chat key),
  so threads keep separate memories and each thread's context persists across turns.
- Drafts are full-replace: each frame carries the complete reply so far, normalized from
  the model's markdown into the gateway's closed typed-block union (headings, lists,
  tables, fenced code, display math; inline emphasis stays literal text by design).
- Tool use streams as chips (`running`, then `ok` or `error` with a short detail
  preview) when the harness exposes tool-lifecycle hooks; without them the plugin still
  streams text and simply omits chips.
- A turn ends with `done` (the gateway seals the latest draft as the durable reply) or
  `failed` (the gateway records a failed turn the client can retry).
- Disconnects re-dial with capped, jittered backoff. Two closes are terminal: a rejected
  token (close 1008) and being superseded by a newer connection (close 4000).

## Status

Reference implementation, validated manually against a live harness. It is not covered
by this repo's CI (the gateway's protocol suite runs against a scripted fake instead).

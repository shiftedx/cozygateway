# attach-plugin

A reference plugin for agent harnesses that support Python platform plugins. It is the
harness side of the gateway's attach-v1 protocol (`contract/attach-v1.md`). It dials
`/attach/v1` with durable replay, native Bot Mode events, media, approvals, structured
clarification, and scheduled delivery. There is no legacy fallback.

When both ends advertise `desktop_session_resume`, an explicit phone adoption can bind a
gateway-owned conversation lane to one exact profile-local Hermes TUI session. The plugin verifies
the raw id in that profile's session DB, switches the resident runner, evicts its cached agent, and
confirms only then; it never treats a gateway `threadId` as a Hermes session id.

Outbound-only: nothing listens on the agent host, so it works from behind NAT with no
port forwarding.

## Hermes installer

The supported Hermes path downloads this directory as a checksum-verified
release archive, installs it into each selected Hermes profile, enables it, and
writes a distinct profile token and spool path. Use the one-paste installer in
the repository README rather than copying an incomplete subset of this plugin.

### Coordinated version upgrades

The canonical installer is the preferred upgrade path because it installs the
Gateway and attach plugin from one checksum-verified release. Do not roll a new
plugin through an old Gateway, or a new Gateway through an old or prerelease
plugin, and wait for that mixed pair to become healthy. Attach capabilities are
part of the versioned hello: v0.4.3 rejects a capability it does not know, while
tagged v0.5.2 rejects the divergent capability offer from its prerelease plugin.
Intersection applies only after both peers accept the hello; it is not a
cross-version deployment guarantee.

For a manual production upgrade, first stage the exact matching tagged Gateway
and plugin without changing the live services. Back up the current Gateway
revision or image, config, and plugin tree (outside every `plugins/` directory),
migrate and validate the config against the new Gateway, and run the plugin
deploy dry-run. Then use one bounded maintenance window to cut over the staged
Gateway and the clean plugin tree. Either mixed-version intermediate may be
unavailable; do not use it as a health gate or send work through it. Verify only
after every plugin has reconnected to the matching Gateway and the final
`hello_ack` contains the capabilities the release requires. If verification
fails, restore the captured config, Gateway, and plugin set together.

## Manual install

Copy this directory as one entry in your harness's plugin directory (it already contains the root
`__init__.py`, `plugin.yaml`, and implementation package), enable it, and set two environment
variables for the harness process:

- `COZYGATEWAY_URL`: the gateway base URL (for example `http://127.0.0.1:8787`).
- `COZYGATEWAY_TOKEN`: the attach bearer token for this agent. The gateway config names
  the environment variable that holds it (`hermes.profiles.<profile>.tokenEnv`); generate your own value
  and give it to both processes. It is presented header-only and never rides a URL.

Set `COZYGATEWAY_URL` to an `https://` origin when the gateway terminates TLS (see
`docs/tls.md`); the plugin swaps the scheme to `wss` for the attach socket by itself, so
nothing else about this setup changes.

Optional: `COZYGATEWAY_CA_FILE` (a PEM to verify a private-CA or self-signed gateway
certificate against; ignored on a plaintext gateway),
`COZYGATEWAY_RECONNECT_INITIAL_SECONDS` (0.5), `COZYGATEWAY_RECONNECT_MAX_SECONDS` (30).

Set `COZYGATEWAY_SPOOL_PATH` to a persistent writable SQLite path (default
`~/.hermes/cozygateway-attach-v1.sqlite`). Never place the spool on ephemeral container storage.

Also set `COZYGATEWAY_HOME_CHANNEL=thread` (any non-empty value works). Some harnesses
prompt to pick a "home channel" the first time a new platform delivers a message, and that
one-time prompt would consume a turn as the committed reply. The variable name derives
from the platform name, so it marks every thread as home and suppresses the prompt.

Dependencies: Python 3.10+ and the `websockets` package.

## Behavior

- One gateway thread maps to one harness conversation (the thread id is the chat key),
  so threads keep separate memories and each thread's context persists across turns.
- Hermes cron routines use `enqueue_proactive_delivery` to enqueue an unanchored `scheduled` delivery.
  The public helper is also the seam for a future deeper agent hook: its caller supplies the currently
  selected target thread plus a nonblank stable occurrence key; retries reuse that key, while distinct
  triggers use distinct keys. Blank output is treated as a successful no-delivery. This helper is
  text-only; media remains on the live native delivery path.
- Drafts are full-replace: each frame carries the complete reply so far, normalized from
  the model's markdown into the gateway's closed typed-block union (headings, lists,
  tables, fenced code, display math; inline emphasis stays literal text by design).
- Tool use streams as chips (`running`, then `ok` or `error` with a short detail
  preview) when the harness exposes tool-lifecycle hooks; without them the plugin still
  streams text and simply omits chips.
- A turn ends with `done` (the gateway seals the latest draft as the durable reply) or
  `failed` (the gateway records a failed turn the client can retry).
- The plugin journals events and accepted commands before sending/ACKing, replays after reconnect,
  deduplicates stable ids, and keeps negotiated count/byte windows for live traffic in both
  directions. It honors the capability intersection returned by `hello_ack` and does not emit a
  newly disabled feature. Hermes' native `send_clarify` callback becomes an app-visible option card; a selected
  stable option resolves the original blocking Hermes clarify primitive rather than starting a new
  chat turn. Media carries only metadata on WS and uses authenticated HTTP for bytes.
- Profile-local memory reads and item mutations negotiate `memory_management`. Capability-42
  credential-free setup additionally negotiates `memory_setup`; both names must appear in the
  `hello_ack` intersection before setup is available. The setup lane uses the version-matched
  release plugin and Hermes' native config writer, returns a fresh source projection, and never
  sends memory content through the durable event spool. After a coordinated upgrade, a missing
  negotiated capability produces a bounded unavailable response instead of accepting or retaining
  the mutation for reconnect; it is evidence that the final matched-version cutover is incomplete.
- Disconnects re-dial with capped, jittered backoff. Two closes are terminal: a rejected
  token (close 1008) and being superseded by a newer connection (close 4000).

## Status

Reference implementation. The Python unit suite covers the v1 spool, handshake,
ACK/replay, command dedupe, and media behavior; gateway integration tests cover the wire boundary.

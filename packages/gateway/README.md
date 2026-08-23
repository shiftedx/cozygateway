# cozygateway

A self-hosted gateway that turns your AI agent into a chat contact on your phone. It speaks
the cozygateway wire contract v1 and connects an agent harness through attach-v1.

Requires Node.js >= 24.

## Install

For an existing Hermes installation, use the supported one-paste installer:

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

It installs the stable operator command at
`~/.cozygateway/bin/cozygateway`. See
[`docs/agent-install.md`](../../docs/agent-install.md) for the Hermes profile
and local Dashboard setup it performs.

## Quickstart

The installer creates the Hermes-only configuration and starts its service.
To pair a device with a remote URL, run:

```sh
~/.cozygateway/bin/cozygateway pair --url https://gateway.example.com
```

This prints a JSON line like:

```json
{ "gatewayUrl": "http://127.0.0.1:8787", "setupCode": "AB3C-9XYZ" }
```

followed by a plain-language reminder that the code expires in ten minutes. The app turns
that JSON into a QR code (or lets you type the setup code by hand), scans it, and exchanges
the setup code for a device token over the REST pairing endpoint. From then on the device
talks to the gateway directly: no accounts, no intermediary server.

## The wire contract

cozygateway does not invent its own protocol ad hoc. The full request and response shapes,
the WebSocket frames, and the rich content model are frozen and documented at
[`contract/v1.md`](../../contract/v1.md) in the repo root, with a matching TypeBox package at
`cozygateway-contract`. If you are building a client or a second gateway implementation
against this contract, the `cozygateway-conformance` package is the black-box test suite that
checks an implementation against it end to end.

## Privacy model

Your threads and message history live in SQLite, on your machine, at whatever `dbPath` you
configure. The gateway reads plaintext to drive your agent and stream replies back, and it
never sends that content anywhere else: there is no cloud relay, no third-party server, and no
telemetry in the loop. By default the bundle's `~/.cozygateway/bin/cozygateway serve` binds `127.0.0.1` only, plain HTTP, and
answers on loopback alone: the gateway does not expose itself on your network by itself. The
Hermes one-paste installer deliberately overrides that bind to `0.0.0.0` for local/LAN use, but it
does not configure Tailscale, tunnels, DNS, or firewalls. Give it a
`tls` block (or `COZY_TLS_CERT_FILE` / `COZY_TLS_KEY_FILE`) and it serves HTTPS instead, with `/ws`
and `/attach/v1` becoming `wss` along with it; the app pins the certificate on first use, so a
self-signed pair on a LAN is a supported posture. See [`docs/tls.md`](../../docs/tls.md), which also
covers the shipped Caddy sidecar overlay for operators who would rather not manage a pair. A tunnel
or reverse proxy you set up and control remains a perfectly good alternative.

## Configuration reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | required | Human-readable gateway name, surfaced to clients as `GatewayInfo.name`. |
| `port` | integer | `8787` | TCP port to listen on. |
| `dbPath` | string | `cozygateway.db` | SQLite file path (or `:memory:` for ephemeral runs). |
| `turnTimeoutSeconds` | integer | `0` | Optional operator-enforced wall-clock bound, in seconds. `0` disables it (the default), allowing legitimate long-running tool use and context compaction to finish. A positive value interrupts through the ordinary manual-stop path. Applies to every interruptible backend; config-file only, not env-driven. |
| `hermes` | object | required | Hermes Dashboard control/read connection and the single attach identity for each profile: `url`, password-auth fields, and `profiles.<name>.tokenEnv`. The installer writes this object; it does not use a separate `agents` list. |
| `capabilities` | object | `{}` | Map of capability id to integer version, surfaced verbatim as `GatewayInfo.capabilities` (the `GET /health` response, the pair response, and the `ready` frame all carry it). Ids under `com.cozylabs.*` are vendor extensions, versioned independently of the contract; see contract/v1.md section 5. |
| `pushRelayUrl` | string | absent | Private relay origin shared by authenticated `/push` registration proxy calls and the gateway's own `/notify` calls. Setting it advertises `com.cozylabs.push-proxy: 1`. Overridable with `COZYGATEWAY_PUSH_RELAY_URL`. |
| `tls` | object | absent (plain HTTP) | `{ "certFile", "keyFile" }`, paths to a PEM certificate chain and its matching unencrypted key. Present means the listener serves HTTPS and `/ws` and `/attach/v1` become `wss`; absent means plain HTTP, unchanged. Overridable with `COZY_TLS_CERT_FILE` / `COZY_TLS_KEY_FILE`. Present-but-unusable (missing file, garbage PEM, encrypted key, key that does not match the certificate, only one of the two set) fails startup before the port binds rather than falling back to plaintext. See [`docs/tls.md`](../../docs/tls.md). |

## Approvals

A backend can pause a turn on a tool call that needs a human decision. The gateway announces it
as an `approval_pending` frame on the live channel, a client resolves it with
`POST /threads/:id/approvals/:toolCallId/approve` or `.../deny`, and the outcome comes back as an
`approval_resolved` frame (`approved` / `denied` / `expired`). The surface is advertised as the
core `approvals` capability and specified in contract/v1.md section 5a.

An adapter opts in by calling `handlers.onApprovalPending(...)` during a turn and implementing
`session.resolveApproval(toolCallId, decision)`; both are optional members of the adapter
interface, so a backend that never pauses needs no changes. `argSummary` carries argument key
NAMES mapped to JSON type TAGS only, never argument values, and the gateway re-validates it
against the wire schema before broadcasting: an adapter that puts a raw value there gets its
approval refused with an `invalid_request` error frame instead of leaking it to every device.
Every resolution is audit-logged (thread, turn, `toolCallId`, outcome, deciding device).

A pending approval is also pushed out of band, so a phone with no live socket still learns about
it: category `approval.pending` collapsed on the `toolCallId`, and `approval.resolved` on the same
collapse id so a resolved or expired approval replaces its own banner in place rather than leaving
a lock-screen "approve this?" for a decision already made. The category and the collapse id are the
only cleartext the relay sees; everything describing the tool call rides inside the ciphertext it
has no key for. See contract/push-v0.md.

### Approvals on the bots bridge

Bot chats (the `com.cozylabs.bots` extension) do NOT go through the adapter surface above: they are
a parallel path with no threads and no `TurnRunner`, so they carry their own mirror of this
lifecycle at capability 10 -- the `bot_approval_pending` / `bot_approval_resolved` frames and
`POST /bots/:name/approvals/:toolCallId/approve` and `.../deny`. See contract/ext-bots-v1.md.

Two things about the bridged leg are deployment facts rather than wire facts, and both are
documented in [`docs/agent-install.md`](../../docs/agent-install.md): a bridged Hermes profile MUST
pin `approvals.mode: manual` (the default `smart` lets an aux LLM approve a call with no event at
all) and MUST NOT set `security.approval.transport` (which routes approvals off the WebSocket
before this bridge can see them). The installer writes and verifies the first and refuses to
proceed on the second.

| Hermes bridge option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `hermes.chatSuggestion` | string | `Hey, tell me about yourself!` | The opener an EMPTY bot chat offers a client (capability 11). A SUGGESTION and nothing more: the gateway never submits it, and it enters the conversation only if the user chooses to send it as their own message. Set it to the empty string to offer nothing, leaving a fresh chat completely bare. |
| `hermes.approvalTimeoutSeconds` | integer | `300` | How long a pending approval waits before the gateway synthesizes `expired`. MIRRORS the Hermes `approvals.timeout`, which Hermes does not expose over its RPC surface and for which it emits no expiry event: it drops the entry silently, so the gateway runs its own timer. Out of step with Hermes, the only consequence is that the buttons stop being offered earlier or later than Hermes stops accepting a decision; the gateway never resolves anything by itself. |

## Commands

- `~/.cozygateway/bin/cozygateway serve --config <path>`: start the gateway and run until interrupted.
- `~/.cozygateway/bin/cozygateway pair --config <path>`: mint a fresh setup code against the configured
  database and print the QR payload for the app to scan.

## License

MIT

# cozygateway

A self-hosted gateway that turns your AI agent into a chat contact on your phone. It speaks
the cozygateway wire contract v1 and drives agent backends through a small adapter interface.

Requires Node.js >= 24.

## Install

```bash
npm i -g cozygateway
```

This installs the `cozygateway` command.

## Quickstart

Create a config file. This example uses the built-in `mock` backend, a deterministic echo
agent good for trying the gateway out before wiring up a real one:

`cozygateway.config.json`:

```json
{
  "name": "my-gateway",
  "port": 8787,
  "dbPath": "cozygateway.db",
  "agents": [{ "id": "echo", "name": "Echo", "backend": "mock" }]
}
```

Start the gateway:

```bash
cozygateway serve --config cozygateway.config.json
```

It prints the version and the URL it is listening on, then runs until you stop it with
Ctrl-C.

In a second terminal, pair a device:

```bash
cozygateway pair --config cozygateway.config.json
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
telemetry in the loop. By default `cozygateway serve` binds `127.0.0.1` only, plain HTTP, and
answers on loopback alone: the gateway does not expose itself on your network by itself. Give it a
`tls` block (or `COZY_TLS_CERT_FILE` / `COZY_TLS_KEY_FILE`) and it serves HTTPS instead, with `/ws`
and `/attach` becoming `wss` along with it; the app pins the certificate on first use, so a
self-signed pair on a LAN is a supported posture. See [`docs/tls.md`](../../docs/tls.md), which also
covers the shipped Caddy sidecar overlay for operators who would rather not manage a pair. A tunnel
or reverse proxy you set up and control remains a perfectly good alternative.

## Configuration reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | required | Human-readable gateway name, surfaced to clients as `GatewayInfo.name`. |
| `port` | integer | `8787` | TCP port to listen on. |
| `dbPath` | string | `cozygateway.db` | SQLite file path (or `:memory:` for ephemeral runs). |
| `turnTimeoutSeconds` | integer | `600` | Per-turn wall-clock bound, in seconds. A single agent turn that runs longer than this is interrupted server-side through the ordinary interrupt path (the same one a manual stop uses), so a device that disconnects mid-turn cannot leave the agent looping tool calls forever. `0` disables the bound. Applies to every interruptible backend; config-file only, not env-driven. Distinct from the openclaw backend's per-agent `options.turnTimeoutSeconds` below. |
| `agents` | array | required, at least one | Agents this gateway exposes, each with `id`, `name`, an optional `avatar`, a `backend`, and adapter-specific `options`. |
| `capabilities` | object | `{}` | Map of capability id to integer version, surfaced verbatim as `GatewayInfo.capabilities` (the `GET /health` response, the pair response, and the `ready` frame all carry it). Ids under `com.cozylabs.*` are vendor extensions, versioned independently of the contract; see contract/v1.md section 5. |
| `tls` | object | absent (plain HTTP) | `{ "certFile", "keyFile" }`, paths to a PEM certificate chain and its matching unencrypted key. Present means the listener serves HTTPS and `/ws` and `/attach` become `wss`; absent means plain HTTP, unchanged. Overridable with `COZY_TLS_CERT_FILE` / `COZY_TLS_KEY_FILE`. Present-but-unusable (missing file, garbage PEM, encrypted key, key that does not match the certificate, only one of the two set) fails startup before the port binds rather than falling back to plaintext. See [`docs/tls.md`](../../docs/tls.md). |

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

The built-in `mock-approval` backend implements the whole loop with no real backend behind it
(one draft, one pending approval, parked until it is resolved or its bounded window lapses); it
is what the conformance suite's optional approval hook points at.

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

## Backends

Each agent names a `backend`. Alongside the built-in backends, cozygateway works with OpenClaw:
a `backend: "openclaw"` agent dials OUT to a running OpenClaw gateway (WebSocket protocol v4,
operator role) and relays a turn's streamed reply back over the cozygateway contract.

```json5
{
  id: "sage",
  name: "Sage",
  backend: "openclaw",
  options: {
    url: "wss://host:port",        // the OpenClaw gateway's WebSocket URL
    tokenEnv: "OPENCLAW_TOKEN",    // NAME of the env var holding the operator token
    turnTimeoutSeconds: 600,        // optional, default 600
    protocolVersion: 4,             // optional, default 4
  },
}
```

**Root-token caveat.** An OpenClaw operator token is ROOT on the target OpenClaw gateway: it can
read and drive every session on it. cozygateway therefore takes the token by the NAME of an
environment variable (`tokenEnv`), never inline in the config file, fails closed at startup if
that variable is unset, logs a one-line caveat naming the agent and env var (never the token
value) when it constructs the client, and never writes the token to any log or error. Treat the
env var as a root secret.

The connection authenticates with a per-run Ed25519 device key answering the gateway's
`connect.challenge` (device-auth v3); a fresh operator device is accepted with the gateway token
and needs no pairing step. Streamed assistant text is relayed as rich blocks. Tool-call chips are
not yet surfaced for OpenClaw threads (turns are text-only for now).

The exact OpenClaw wire facts this backend depends on were pinned by a live study against a real
gateway; see `docs/specs/2026-07-08-openclaw-wire-study.md`. A non-gating live canary
(`packages/gateway/scripts/openclaw-canary.mjs`, run when `OPENCLAW_CANARY_URL` and the token env
are set) dials a real gateway and asserts a non-empty streamed reply.

## Commands

- `cozygateway serve --config <path>`: start the gateway and run until interrupted.
- `cozygateway pair --config <path>`: mint a fresh setup code against the configured
  database and print the QR payload for the app to scan.

## License

MIT

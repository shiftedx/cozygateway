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
telemetry in the loop. TLS for the phone link is planned; it is not implemented yet. In v0.1,
`cozygateway serve` binds `127.0.0.1` only, plain HTTP, and answers on loopback alone. Reaching
it from a phone requires a tunnel or reverse proxy that you set up and control; the gateway does
not expose itself on your network by itself.

## Configuration reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | required | Human-readable gateway name, surfaced to clients as `GatewayInfo.name`. |
| `port` | integer | `8787` | TCP port to listen on. |
| `dbPath` | string | `cozygateway.db` | SQLite file path (or `:memory:` for ephemeral runs). |
| `turnTimeoutSeconds` | integer | `600` | Per-turn wall-clock bound, in seconds. A single agent turn that runs longer than this is interrupted server-side through the ordinary interrupt path (the same one a manual stop uses), so a device that disconnects mid-turn cannot leave the agent looping tool calls forever. `0` disables the bound. Applies to every interruptible backend; config-file only, not env-driven. Distinct from the openclaw backend's per-agent `options.turnTimeoutSeconds` below. |
| `agents` | array | required, at least one | Agents this gateway exposes, each with `id`, `name`, an optional `avatar`, a `backend`, and adapter-specific `options`. |
| `capabilities` | object | `{}` | Map of capability id to integer version, surfaced verbatim as `GatewayInfo.capabilities` (the `GET /health` response, the pair response, and the `ready` frame all carry it). Ids under `com.cozylabs.*` are vendor extensions, versioned independently of the contract; see contract/v1.md section 5. |

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

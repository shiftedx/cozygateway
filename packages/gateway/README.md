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
| `agents` | array | required, at least one | Agents this gateway exposes, each with `id`, `name`, an optional `avatar`, a `backend`, and adapter-specific `options`. |

## Commands

- `cozygateway serve --config <path>`: start the gateway and run until interrupted.
- `cozygateway pair --config <path>`: mint a fresh setup code against the configured
  database and print the QR payload for the app to scan.

## License

MIT

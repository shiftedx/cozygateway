# cozygateway

Chat with your self-hosted AI agent from your phone, without handing your data to anyone.

cozygateway is a single self-hosted Node process you run next to your agent. It speaks a small published wire contract to chat clients and drives agent backends through a small adapter interface. Two backends ship today: a reference echo backend for trying the gateway out, and an `attach` backend that lets an agent harness dial in over a small WebSocket protocol and answer turns live.

## Install

There are two ways in. Pick the one that fits your machine.

### Simple (recommended): one line, runs as a service

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

No Docker, no git, no build tools. Needs a working Hermes install (0.20.2 or newer) plus Node 24+
(the line stops and tells you how to get either one if you do not have it). It downloads the
latest released gateway bundle, checks its sha256, installs
it to `~/.cozygateway`, and registers the gateway and the Hermes dashboard as login services
(launchd on macOS, systemd `--user` on Linux) that come back after a crash, a logout, or a reboot.
It prints a pairing code for the app when it is done. See `docs/install-service.md` for what it
does step by step, where the files live, and how to check on it later.

Uninstall:

```sh
bash ~/.cozygateway/bin/agent-install.sh --uninstall-service --gateway-dir ~/.cozygateway
```

This removes the service units only. Your config, database, and credentials stay in
`~/.cozygateway`.

### Homelab (Docker) / agent-driven

You do not install this by hand. Paste one line to an AI agent you already run (Hermes, Claude Code, anything that can read a URL and run commands) and it installs cozygateway beside your existing Hermes, wires the two together, and hands you a pairing code for the app.

```
Read https://cozylabs.ai/install and install cozygateway on this machine, following it exactly.
```

Or fetch it yourself and hand it over:

```sh
curl -fsSL https://cozylabs.ai/install
```

`https://cozylabs.ai/install` is the canonical short address: it redirects to the raw `docs/agent-install.md` on this repo's `main`, which is always the source of truth. If you cannot reach cozylabs.ai, the raw GitHub URL works directly: `https://raw.githubusercontent.com/shiftedx/cozygateway/main/docs/agent-install.md`.

The playbook is written for the agent, not for you: every step carries a check command and the output that command must produce, so the agent can tell you it worked rather than guess. It needs a working Hermes install (0.20.2 or newer) plus either Docker or Node 24. `scripts/agent-install.sh` does the mechanical half and has a `--dry-run` flag if you want to read the plan first, and the same playbook now accepts `--service` on the Node path to run supervised instead of with `nohup`.

## How push works

Self-hosted gateways use `https://push.cozylabs.ai` by default so the store app works
without APNs setup. The gateway encrypts every notification end to end before sending it.
The hosted relay sees only an opaque push ID, ciphertext, optional category and collapse
ID, and the source IP transiently for rate limiting. It never sees message content or
device identity. Override `COZYGATEWAY_PUSH_RELAY_URL` to use another relay.

A relay you host with your own APNs key cannot push to the store app because APNs keys
are scoped to the publisher team. The `local-push` Compose profile is for developers who
sign their own app with their own Apple team.

## What it does

- Pairing: scan a QR code, get a revocable device token. No accounts.
- Threads: multiple renameable DM threads per agent, each bound to its own backend session.
- Streaming: agent replies stream live as typed rich content blocks over one WebSocket.
- History: SQLite-backed message history with strict per-thread ordering and gap replay.
- Push: end-to-end encrypted notifications through the accountless CozyLabs relay by default.

## Status

- Shipped: contract v1 (frozen), reference gateway, conformance suite, attach backend adapter, hosted relay plus encrypted push origination and APNs delivery (`contract/push-v0.md`), TLS for the phone link (gateway-native, or a shipped Caddy sidecar example; `docs/tls.md`).
- Planned: additional backend adapters.

## Repo layout

- `contract/`: the human-readable, versioned wire contract spec.
- `packages/contract`: TypeBox schemas and TypeScript types for the contract (publishable as `cozygateway-contract`).
- `packages/gateway`: the gateway process, implementing contract v1.
- `packages/relay`: the push relay service (opaque push ids in, ciphertext through).
- `packages/conformance`: contract conformance suite that runs against any gateway implementation, validated against the reference gateway.
- `integrations/attach-plugin`: a reference Python platform plugin speaking attach v0 by default and the durable attach-v1 native data plane when enabled per bot; see `contract/attach-v1.md` and `docs/attach-v1-operations.md`.

## Privacy model

Your messages live in SQLite on your box. The gateway must read plaintext to drive your agent, and it never sends message content outside your box. TLS for the phone link ships two ways, gateway-native or a Caddy sidecar example, and the app pins the certificate on first use; see `docs/tls.md`. Plain HTTP remains the default, for boxes that already terminate TLS in front. Push leaves the box only as end-to-end encrypted ciphertext.

## Development

Requires Node 24+ and pnpm 10.

```sh
pnpm install
pnpm check   # typecheck + test + build
```

## License

MIT

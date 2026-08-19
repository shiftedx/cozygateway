# cozygateway

Chat with your self-hosted AI agent from your phone, without handing your data to anyone.

cozygateway is a single self-hosted Node process you run next to your agent. It speaks a small published wire contract to chat clients and drives agent backends through a small adapter interface. Two backends ship today: a reference echo backend for trying the gateway out, and an `attach` backend that lets an agent harness dial in over a small WebSocket protocol and answer turns live.

## Install with your agent

You do not install this by hand. Paste one line to an AI agent you already run (Hermes, Claude Code, anything that can read a URL and run commands) and it installs cozygateway beside your existing Hermes, wires the two together, and hands you a pairing code for the app.

```
Read https://cozylabs.ai/install and install cozygateway on this machine, following it exactly.
```

Or fetch it yourself and hand it over:

```sh
curl -fsSL https://cozylabs.ai/install
```

`https://cozylabs.ai/install` is the canonical short address: it redirects to the raw `docs/agent-install.md` on this repo's `main`, which is always the source of truth. If you cannot reach cozylabs.ai, the raw GitHub URL works directly: `https://raw.githubusercontent.com/shiftedx/cozygateway/main/docs/agent-install.md`.

The playbook is written for the agent, not for you: every step carries a check command and the output that command must produce, so the agent can tell you it worked rather than guess. It needs a working Hermes install (0.20.2 or newer) plus either Docker or Node 24. `scripts/agent-install.sh` does the mechanical half and has a `--dry-run` flag if you want to read the plan first.

## What it does

- Pairing: scan a QR code, get a revocable device token. No accounts, no cloud.
- Threads: multiple renameable DM threads per agent, each bound to its own backend session.
- Streaming: agent replies stream live as typed rich content blocks over one WebSocket.
- History: SQLite-backed message history with strict per-thread ordering and gap replay.
- Push: encrypted notifications through a ciphertext-only relay you can self-host (platform push transports land with the phone app).

## Status

- Shipped: contract v1 (frozen), reference gateway, conformance suite, attach backend adapter, push relay + encrypted push origination (`contract/push-v0.md`), TLS for the phone link (gateway-native, or a shipped Caddy sidecar example; `docs/tls.md`).
- Planned: the phone app, platform push transports (APNs), additional backend adapters.

## Repo layout

- `contract/`: the human-readable, versioned wire contract spec.
- `packages/contract`: TypeBox schemas and TypeScript types for the contract (publishable as `cozygateway-contract`).
- `packages/gateway`: the gateway process, implementing contract v1.
- `packages/relay`: the push relay service (opaque push ids in, ciphertext through).
- `packages/conformance`: contract conformance suite that runs against any gateway implementation, validated against the reference gateway.
- `integrations/attach-plugin`: a reference plugin for agent harnesses that support Python platform plugins, speaking the attach v0 protocol.

## Privacy model

Your messages live in SQLite on your box. The gateway must read plaintext to drive your agent, and it never sends your content anywhere else. TLS for the phone link ships two ways, gateway-native or a Caddy sidecar example, and the app pins the certificate on first use; see `docs/tls.md`. Plain HTTP remains the default, for boxes that already terminate TLS in front. The push relay carries ciphertext only and is open source so you can host your own.

## Development

Requires Node 24+ and pnpm 10.

```sh
pnpm install
pnpm check   # typecheck + test + build
```

## License

MIT

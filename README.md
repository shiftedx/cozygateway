# cozygateway

Chat with your self-hosted AI agent from your phone, without handing your data to anyone.

cozygateway is a single self-hosted Node process you run next to your agent. It speaks a small published wire contract to chat clients and drives agent backends through adapters. Hermes and OpenClaw adapters ship at launch (works with OpenClaw; not affiliated with or endorsed by the OpenClaw project).

## What it does

- Pairing: scan a QR code, get a revocable device token. No accounts, no cloud.
- Threads: multiple renameable DM threads per agent, each bound to its own backend session.
- Streaming: agent replies stream live as typed rich content blocks over one WebSocket.
- History: SQLite-backed message history with strict per-thread ordering and gap replay.
- Push (planned): encrypted notifications through a ciphertext-only relay you can self-host.

## Status

Pre-alpha. Contract v1 is being frozen; see `contract/` for the wire spec and `docs/plans/` for the implementation plan.

## Repo layout

- `contract/`: the human-readable, versioned wire contract spec.
- `packages/contract`: TypeBox schemas and TypeScript types for the contract (publishable as `cozygateway-contract`).
- `packages/gateway`: the gateway process (coming with contract v1).
- `packages/conformance`: contract conformance suite that runs against any gateway implementation (coming with contract v1).

## Privacy model

Your messages live in SQLite on your box. The gateway must read plaintext to drive your agent, and it never sends your content anywhere else. TLS with trust-on-first-use certificate pinning protects the phone link. The push relay, when it ships, carries ciphertext only and is open source so you can host your own.

## Development

Requires Node 24+ and pnpm 10.

```sh
pnpm install
pnpm check   # typecheck + test + build
```

## License

MIT

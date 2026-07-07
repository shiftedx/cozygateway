# cozygateway

Chat with your self-hosted AI agent from your phone, without handing your data to anyone.

cozygateway is a single self-hosted Node process you run next to your agent. It speaks a small published wire contract to chat clients and drives agent backends through a small adapter interface. A reference echo backend ships today, for trying the gateway out before wiring up a real one. Additional backend adapters are planned.

## What it does

- Pairing: scan a QR code, get a revocable device token. No accounts, no cloud.
- Threads: multiple renameable DM threads per agent, each bound to its own backend session.
- Streaming: agent replies stream live as typed rich content blocks over one WebSocket.
- History: SQLite-backed message history with strict per-thread ordering and gap replay.
- Push (planned): encrypted notifications through a ciphertext-only relay you can self-host.

## Status

Contract v1 is frozen (see `contract/v1.md`). The reference gateway and its conformance suite are built and passing. Next up: the phone app, the push relay, TLS for the phone link, and real backend adapters, all planned.

## Repo layout

- `contract/`: the human-readable, versioned wire contract spec.
- `packages/contract`: TypeBox schemas and TypeScript types for the contract (publishable as `cozygateway-contract`).
- `packages/gateway`: the gateway process, implementing contract v1.
- `packages/conformance`: contract conformance suite that runs against any gateway implementation, validated against the reference gateway.

## Privacy model

Your messages live in SQLite on your box. The gateway must read plaintext to drive your agent, and it never sends your content anywhere else. TLS with trust-on-first-use certificate pinning for the phone link is planned; see `packages/gateway/README.md` for the current, loopback-only reachability model. The push relay, when it ships, carries ciphertext only and is open source so you can host your own.

## Development

Requires Node 24+ and pnpm 10.

```sh
pnpm install
pnpm check   # typecheck + test + build
```

## License

MIT

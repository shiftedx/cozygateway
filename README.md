# cozygateway

Chat with your self-hosted AI agent from your phone, without handing your data to anyone.

cozygateway is a single self-hosted Node process you run next to your agent. It speaks a small published wire contract to chat clients and uses its `attach` data plane to let an agent harness dial in over a small WebSocket protocol and answer turns live.

## Install

There are two ways in. Pick the one that fits your machine.

### Simple (recommended): one line, runs as a service

Windows PowerShell (Hermes is installed automatically if needed, then you
choose or confirm its model and provider):

```powershell
irm https://cozylabs.ai/install.ps1 | iex
```

macOS/Linux:

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

Open a new terminal afterward and type `cozygateway` on every supported host.

No Docker or source checkout is required. The installer provisions missing Node 24 and Hermes,
then asks you to confirm a working model/provider. The
bootstrap verifies versioned release checksums for the gateway bundle, complete Hermes attach-plugin
archive, and installer payload. It discovers Hermes profile homes through the Hermes CLI, installs
one attach identity per selected profile, and supervises one shared gateway service. The default
scope is `all`; updates preserve the recorded selection. An installation with `all` also provisions newly discovered profiles. Existing Hermes
profile gateway services stay Hermes-owned. Fresh interactive installs ask once whether CozyChat
may connect over the local network; No (the default) keeps loopback (`127.0.0.1:8787`), while Yes
binds all local interfaces and puts the detected LAN address in the pairing QR. The
installer never configures Tailscale, Cloudflare, DNS, firewalls, or tunnels. See
[service installation](docs/install-service.md), [connectivity](docs/connectivity.md), and
[keeping your Gateway available](docs/reliable-operation.md).

Windows installs under `%LOCALAPPDATA%\cozygateway`, registers a current-user
`CozyGateway` Scheduled Task with a Startup-folder fallback, and normally stays
non-elevated. One scoped administrator prompt can appear only when an existing
higher-integrity Hermes Dashboard cannot be classified safely without elevated
process metadata. The final screen contains a QR and plain-text setup code.
Open a new PowerShell or Terminal window and type `cozygateway` for a small menu
that shows status, prints a fresh pairing QR, or changes the bind address and
port. `cozygateway status` names the safe next step when attention is needed;
`cozygateway repair` (or `update`) downloads the latest matched, checksummed
release and reconciles the install. Existing installs retain their saved
listener; `--bind-host` remains the non-interactive override.
Publishing the short PowerShell URL is tracked separately; before that website
change, use the `install.ps1` asset from a versioned GitHub release.

Uninstall on macOS/Linux:

```sh
bash ~/.cozygateway/bin/agent-install.sh --uninstall --gateway-dir ~/.cozygateway
```

This removes CozyGateway-owned service state, plugin copies, spools, and installer-written env keys;
Hermes profiles and Hermes services remain. It also removes the installer-owned
command entry from the user PATH.

### Existing Hermes install

The installer targets Hermes profiles already on this machine. For a narrower
selection, pass `--profiles default,ops` to the one-paste command. The command
uses the installed Hermes CLI as the source of truth for profile homes and does
not clone a repository or create a Docker deployment.

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

- Shipped: contract v1 (frozen), conformance suite, attach-v1 data plane, hosted relay plus encrypted push origination and APNs delivery (`contract/push-v0.md`), TLS for the phone link (gateway-native, or a shipped Caddy sidecar example; `docs/tls.md`).

Docker publishes the gateway on `127.0.0.1:8787` by default. Use the documented LAN overlay only
for a trusted private network, or use the Caddy or native TLS Compose overlays for off-host access.

## Repo layout

- `contract/`: the human-readable, versioned wire contract spec.
- `packages/contract`: TypeBox schemas and TypeScript types for the contract (publishable as `cozygateway-contract`).
- `packages/gateway`: the gateway process, implementing contract v1.
- `packages/relay`: the push relay service (opaque push ids in, ciphertext through).
- `packages/conformance`: contract conformance suite that runs against any gateway implementation, validated against the reference gateway.
- `integrations/attach-plugin`: the reference Python platform plugin for the durable attach-v1 data plane; see `contract/attach-v1.md` and `docs/attach-v1-operations.md`.

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

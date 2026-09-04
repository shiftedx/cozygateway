# CozyGateway

**Chat with a self-hosted AI agent from your phone while keeping the conversation on your own machine.**

CozyGateway is a Node.js gateway that runs beside your agent. It implements the published [wire contract](contract/v1.md) for chat clients and connects agent harnesses through the [attach-v1](contract/attach-v1.md) WebSocket data plane. Pair a device with a short-lived code, then talk directly to your gateway—without creating an account for the gateway itself.

[Quick start](#quickstart) · [Documentation](#documentation) · [Releases](https://github.com/shiftedx/cozygateway/releases) · [Contributing](CONTRIBUTING.md)

[CozyChat](https://github.com/shiftedx/cozychat) is the Apple client. [CozyAgents](https://github.com/shiftedx/cozyagents) runs agents on your computers. CozyGateway owns pairing, conversation state, and routing between them.

## What it provides

- **Direct, revocable device pairing.** A QR code or setup code creates a device token; no gateway account is required.
- **Live agent chat.** Typed rich-content replies stream over WebSocket, with multiple named threads and durable per-thread ordering.
- **Local state.** Conversation history is stored in SQLite on the gateway host.
- **Private notifications.** Push payloads leave the host as end-to-end encrypted ciphertext. The default relay receives an opaque push ID, ciphertext, notification metadata, and transient source IP for rate limiting—not message contents or device identity. See [the push contract](contract/push-v0.md).
- **A documented integration boundary.** The frozen v1 contract, TypeBox schemas, and black-box conformance suite support independent clients and implementations.

## Quickstart

The release bootstrap downloads one matched, checksum-verified release and installs a per-user service. It provisions a private Node.js 24 runtime when needed and can set up the Hermes integration used by the standard install path.

### macOS and Linux

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

Open a new terminal and run:

```sh
cozygateway
```

The command shows gateway status and lets you create a fresh pairing code. Scan the QR code, or enter the code in the chat client.

### Windows PowerShell

```powershell
irm https://cozylabs.ai/install.ps1 | iex
```

Open a new PowerShell or Terminal window, then run `cozygateway` to check the installation or make a pairing code.

The Windows installer is published and has automated coverage, but full Windows end-to-end qualification is still in progress. Use it with that limitation in mind; report results through [GitHub Issues](https://github.com/shiftedx/cozygateway/issues).

For installation details, profile selection, service registration, and prerequisites, see [Install as a service](docs/install-service.md).

## Network and deployment choices

Fresh installs listen on `127.0.0.1:8787` by default. The installer asks whether to make the gateway reachable on a trusted local network; choosing no preserves the loopback-only listener. It does not configure DNS, firewalls, Tailscale, Cloudflare, or a tunnel.

For remote access, keep the gateway on loopback and use a TLS endpoint you operate. The [connectivity guide](docs/connectivity.md) covers Tailscale Serve and a named Cloudflare Tunnel; [TLS and remote access](docs/tls.md) covers gateway TLS and proxy requirements. The `--public-url` installer option records the exact HTTPS origin advertised in pairing codes.

For an existing Hermes deployment or an operator-managed host, use the [runtime-only recovery path](docs/reliable-operation.md#existing-hermes-deployments). Docker is an advanced deployment path for a pre-existing Hermes configuration; start with [Docker self-hosting](docs/self-host-docker.md).

## Operate and recover

Keep the gateway host powered, awake, and connected when you want to reach your agent. The installer creates a user-level background service: launchd on macOS, a systemd user service on Linux, and a current-user Scheduled Task with a Startup-folder fallback on Windows.

```sh
cozygateway status
cozygateway repair   # `cozygateway update` is an alias
```

`status` reports the next safe action when the service needs attention. `repair` downloads and verifies one matched release while retaining the recorded listener, public origin, and selected profiles. If the command itself is unavailable, run the relevant installation command again. Do not remove the gateway directory or reset pairing as a first recovery step: that can discard the state recovery preserves. Read [reliable operation and recovery](docs/reliable-operation.md) before a host migration or deployment repair.

## Documentation

| Need | Start here |
| --- | --- |
| Install, update, remove, or inspect the service | [Service installation](docs/install-service.md) |
| LAN, Tailscale, Cloudflare Tunnel, or public HTTPS | [Connectivity](docs/connectivity.md) and [TLS](docs/tls.md) |
| Docker deployment | [Self-host with Docker](docs/self-host-docker.md) |
| Hermes/attach operations | [Attach-v1 operations](docs/attach-v1-operations.md) |
| Gateway runtime configuration and commands | [Gateway package README](packages/gateway/README.md) |
| Client and gateway protocol | [Contract v1](contract/v1.md) and [conformance suite](packages/conformance/README.md) |
| Support | [Support guide](SUPPORT.md) · [GitHub Issues](https://github.com/shiftedx/cozygateway/issues) |

## Develop

Development requires Node.js 24+ and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` builds, type-checks, and tests every workspace package. The repository contains the gateway, contract package, relay, conformance suite, and reference attach plugin:

| Path | Purpose |
| --- | --- |
| [`contract/`](contract/) | Versioned wire and extension specifications |
| [`packages/gateway/`](packages/gateway/) | Reference gateway service |
| [`packages/contract/`](packages/contract/) | TypeBox schemas and TypeScript contract types |
| [`packages/conformance/`](packages/conformance/) | Black-box contract conformance suite |
| [`packages/relay/`](packages/relay/) | Encrypted push relay |
| [`integrations/attach-plugin/`](integrations/attach-plugin/) | Reference attach-v1 plugin |

## Contributing, security, and license

For substantial changes, open an issue before writing the implementation. Keep pull requests focused, add meaningful behavior coverage, and run `pnpm check` with Node 24 before requesting review. Contract changes require an explicit migration and conformance coverage. See [CONTRIBUTING.md](CONTRIBUTING.md).

Please report vulnerabilities privately through GitHub's security advisory flow; do not include tokens, pairing codes, keys, or conversation contents. See [SECURITY.md](SECURITY.md).

CozyGateway is licensed under the [MIT License](LICENSE).

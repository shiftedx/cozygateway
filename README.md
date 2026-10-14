# CozyGateway

[![CI](https://github.com/shiftedx/cozygateway/actions/workflows/ci.yml/badge.svg)](https://github.com/shiftedx/cozygateway/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/shiftedx/cozygateway)](https://github.com/shiftedx/cozygateway/releases/latest)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Chat with your self-hosted Hermes Agent from your phone.** Pair CozyChat with
a short-lived code; stream replies and keep conversation history on your gateway.
No gateway account is required. OpenClaw is planned; CozyAgents uses its own gateway.

[Install guide](docs/install-service.md) · [Wire contract](contract/v1.md) · [Changelog](CHANGELOG.md) · [Support](SUPPORT.md)

## Install and pair

The installer verifies a matched release, provisions Node.js 26 when needed,
connects selected Hermes profiles, and installs a per-user background service.

**macOS / Linux**

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

**Windows (beta)**

```powershell
irm https://cozylabs.ai/install.ps1 | iex
```

Open a new terminal and run `cozygateway`. Scan its QR in CozyChat or enter the
setup code. Run the installer again to update while keeping settings and pairing.
Windows end-to-end qualification is ongoing; [report problems](https://github.com/shiftedx/cozygateway/issues).

## Privacy and access

- Fresh installs bind to `127.0.0.1:8787`; trusted LAN access requires opt-in.
- Remote access needs a TLS endpoint you operate. The installer does not configure DNS, firewalls, VPNs, or tunnels.
- Conversations remain in local SQLite. Push payloads are end-to-end encrypted; the relay receives opaque IDs, ciphertext, notification metadata, and transient source IP.
- Keep the gateway computer awake, powered, and connected.

[Connectivity](docs/connectivity.md) · [TLS](docs/tls.md) · [Push contract](contract/push-v0.md).

## Operate

```sh
cozygateway status
cozygateway repair
cozygateway uninstall --purge --dry-run
```

`repair` verifies a matched release and preserves deployment settings.
`uninstall --purge` permanently deletes gateway data, conversations, pairing,
and managed connections. Preview first; [recovery and migration](docs/reliable-operation.md)
cover existing Hermes deployments.

| Task | Guide |
| --- | --- |
| Install, update, uninstall, service lifecycle | [Service installation](docs/install-service.md) |
| Docker on an existing Hermes host | [Docker self-hosting](docs/self-host-docker.md) |
| Runtime settings and commands | [Gateway package](packages/gateway/README.md) |
| Hermes setup and attachment | [Installation](docs/agent-install.md) · [Attach operations](docs/attach-v1-operations.md) |
| Implement a client or gateway | [Contract v1](contract/v1.md) · [Conformance suite](packages/conformance/README.md) |

## Develop

Requires Node.js 26+ and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm check
```

The workspace contains the gateway, schemas, encrypted push relay, conformance
suite, and attach plugin. Contract changes require migration and conformance
coverage. [Contributing](CONTRIBUTING.md) · [Security reporting](SECURITY.md) · [MIT](LICENSE).

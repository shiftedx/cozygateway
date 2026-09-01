# CozyGateway Hermes install

Use the human-facing one-paste installer on a new or existing machine:

Windows PowerShell 5.1+:

```powershell
irm https://cozylabs.ai/install.ps1 | iex
```

The Windows bootstrap reuses Hermes when installed. If Hermes is absent, it
runs the official tagged NousResearch Windows installer and setup wizard. It
checks the current Hermes provider and default model before any CozyGateway
changes, and opens `hermes model` only when that setup is incomplete. It then
checksum-verifies the CozyGateway release assets and hands off through
Hermes-compatible Git Bash.

macOS/Linux:

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

If Node.js 24+ is unavailable, the Windows/macOS/Linux installer downloads the current
Node.js 24 archive from nodejs.org, verifies it against that release's official
`SHASUMS256.txt`, and installs it privately under
the CozyGateway home's `runtime/node` directory. It does not use elevation,
replace the system Node,
or change the shell PATH. If Hermes is unavailable, it verifies and runs the
official installer from the latest tagged NousResearch/hermes-agent release,
then resumes automatically. Every run gives `hermes model` control of the
terminal and requires an active provider and model before CozyGateway changes.

It discovers Hermes with `hermes -p <profile> config path`, then uses that
evidence to find the default home and named profile homes. Every discovered
profile with a `config.yaml` is configured by default; narrow the scope with
`--profiles default,ops`.

The release bootstrap downloads and SHA-256 verifies three versioned release
assets before execution: the gateway bundle, the complete Hermes attach plugin
archive, and the installer payload. It never executes the mutable raw installer
after that handoff. The checksum detects incomplete or corrupted downloads;
release authenticity still relies on GitHub Releases over TLS. Node archives
rely on nodejs.org TLS plus the release checksum manifest. The Hermes bootstrap
matches the tagged script's Git blob identity from the GitHub Contents API
before execution; downloads performed by that official installer remain under
the NousResearch installer trust boundary.

For each selected profile it installs and enables the archive, writes only the
four CozyGateway variables to that profile's mode-600 `.env`, creates a distinct
attach token and persistent spool, and restarts the profile's existing Hermes
gateway service when running, starts it when stopped, or installs it with
Hermes when absent. Hermes still owns those services: uninstall removes only a
service this installer installed or stops one this installer started; it never
removes a pre-existing service.

The generated gateway config keeps the local Hermes Dashboard URL and password
environment-variable name for its control/read plane, plus
`hermes.profiles.<profile>.tokenEnv` names for native attach. Tokens and the
local Dashboard password are in mode-600 environment files, never JSON argv,
service definitions, or installer output. One CozyGateway service is installed
for the shared gateway process; it starts or reuses the local Dashboard without
replacing any Hermes profile gateway service.

```sh
# Re-run to update the verified assets and retain existing profile tokens.
curl -fsSL https://cozylabs.ai/install.sh | bash

# The installed command performs the same verified update-and-repair flow.
cozygateway repair

# Remove only files and env keys owned by CozyGateway.
bash ~/.cozygateway/bin/agent-install.sh --uninstall --gateway-dir ~/.cozygateway
```

`cozygateway update` is an alias for `repair`. Both commands use the persisted,
checksummed release bootstrap and fetch one current matched release; they never
treat the installed bundle or a checkout as an update source. A repair retains
the recorded profile selection, listener and public origin, device/message
database, attach tokens and spools, plus supported operator-owned configuration
such as TLS. An explicit `--profiles` on the one-line installer remains the way
to change profile scope.

Near the end of a fresh interactive install, the installer asks one networking question:
`Allow CozyChat to access this Gateway over your local network? [y/N]`. Yes binds CozyGateway to
all local interfaces and makes the pairing QR advertise the machine's detected LAN address. No,
an empty answer, or a non-interactive install keeps the listener on `127.0.0.1`. An explicit
`--bind-host` skips the question, and updates preserve the listener already saved in the config.

The install (and every re-run) then finishes by minting a pairing code and printing a terminal QR
plus the gateway URL and setup code in plain text, so a fresh device goes install, scan, chatting
with no further commands when the selected listener is reachable from that device. The QR encodes
the `{"gatewayUrl":...,"setupCode":...}` payload from contract section 4; the
URL uses the configured listener unless `publicUrl` records a user-managed HTTPS origin. Codes
expire after 10 minutes; mint another with `~/.cozygateway/bin/cozygateway pair`. A configured
public origin is authoritative; `pair --url` may only repeat the same canonical origin.
IPv6 listener addresses are bracketed in generated URLs. With gateway-native
TLS, configuration keeps the existing HTTPS hostname so Hermes validates the
certificate name; private certificate authorities still use
`COZYGATEWAY_CA_FILE`.
Local CLI health checks also pin the configured leaf certificate while allowing
the bind address to differ from its DNS name.

LAN mode is plaintext and is appropriate only on a trusted private network. Explicit
listener/public URL options, saved installs, dry runs, and noninteractive installs bypass the
question; power users can still choose directly with `--bind-host`.
For a tunnel, pass `--public-url https://gateway.example.com`; the installer persists the canonical
origin and requires/sets loopback. Network reachability outside the machine is deliberately not
automated; see `docs/connectivity.md`.

To retire that public origin and return an existing install to LAN access, rerun the installer with
`--clear-public-url --bind-host 0.0.0.0`. Clearing is explicit so an ordinary update cannot silently
replace a saved HTTPS pairing origin; `--clear-public-url` and `--public-url` are mutually exclusive.

After installation, open a new terminal and run `cozygateway` for the basic
terminal menu. It shows live status, prints a fresh pairing QR, and lets a power
user change only the bind address and port. Press Enter at either configuration
prompt to retain the current value. A saved listener change atomically preserves
the rest of the config, updates the local target for every installer-managed
Hermes profile without changing its token, and restarts the gateway and those
Hermes profiles automatically. Rerunning the installer also preserves a saved
custom listener unless an explicit installer host or port option replaces it.
LAN-only bind addresses are used consistently for local Hermes attachment and
health checks. If a managed listener replacement cannot become ready, the CLI
restores the previous working listener automatically.
Readiness requires at least one configured attach profile, every configured
profile online, and zero dead letters. Pairing material is not printed first.
The non-interactive `cozygateway status`, `cozygateway pair`,
`cozygateway configure`, and `cozygateway repair` commands expose the same
focused operations directly. Status distinguishes an unreachable gateway from
an attach connection that needs attention without printing profile identities
or raw errors.

On Windows, state is under `%LOCALAPPDATA%\cozygateway`. Persistence uses the
current-user `CozyGateway` Scheduled Task with a hidden Startup-folder fallback
when policy blocks task registration. Phone-created bot auto-provisioning is not
part of the Windows installer. The installed supervisor restarts an unexpectedly
exited gateway child, including after the login task has already run.

Uninstall is deliberately independent of model selection, downloads, Node,
listener-config parsing, and the continued presence of Hermes, so a damaged
install remains removable. On macOS and
Linux the installer also exposes `cozygateway` through `~/.local/bin` in new
terminal sessions; uninstall removes only its own command entry and profile line.
Linux service units honor `XDG_CONFIG_HOME` and otherwise use
`~/.config/systemd/user`. An environment without a running systemd user manager,
such as a container or WSL instance without systemd, fails before installation
with an actionable message.

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
the CozyGateway home's `runtime/node` directory (`runtime\node\node.exe` on Windows). That private
runtime executes the installed Gateway and the bounded owned-network cleanup during uninstall. It does not use elevation,
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

On Windows, the helper is first verified in a temporary location. It rejects an install root or
immediate parent with an untrusted owner, a parent that grants an untrusted principal child
replacement, permission-change, or ownership-takeover authority, and reparse points at the root,
`bin`, runtime, or helper boundary. It then replaces inherited permissions on the
dedicated root, `bin`, verified helper, installer payload, and private runtime with a
current-user/SYSTEM-only DACL.
This applies to `%LOCALAPPDATA%\cozygateway` and to an explicit `COZYGATEWAY_HOME` custom root.
The PowerShell bootstrap checks the selected Gateway port before Hermes/model setup, release assets,
tokens, config, plugins, or login persistence. An occupied port stops installation with the owning
PID/process name and instructions to stop it or choose a free `--port`; it does not leave a partial
CozyGateway install. After verifying the temporary Windows helper, it also checks the exact Hermes
Dashboard port before model, install-root, token, state, environment, config, plugin, runtime, or
persistence mutation. It reuses only a listener proven to belong to this Hermes installation;
otherwise it reports the port, PID, process name, and a free `--dashboard-port` action.

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

# Remove only files and env keys owned by CozyGateway.
bash ~/.cozygateway/bin/agent-install.sh --uninstall --gateway-dir ~/.cozygateway
```

On Windows, the original PowerShell process next opens the resumable phone-access setup. It offers
personal Tailscale, same-Wi-Fi, later, and advanced choices. A fresh pending marker blocks pairing
until the selected final route has passed the phone connection check and the matching phrase is
confirmed on the PC. Noninteractive installation stays healthy on loopback, prints one
`cozygateway setup` resume command, and emits no QR or setup code. Updates retain completed matching
posture; older installs keep their explicit pairing compatibility while setup offers a review.

Same Wi-Fi setup keeps localized/Unicode adapter names intact and reads the selected adapter's
Windows network category plus the active firewall profile. It does not change a firewall rule. If
Windows reports `Public`, use **Settings > Network & internet > the active connection > Network
profile type > Private** only when this is a trusted home/private network. If the phone check is
blocked, keep Windows Firewall enabled and authorize only the exact CozyGateway TCP port on the
Private profile (the setup message prints the number). Use **Windows Security > Firewall & network
protection > Advanced settings > Inbound Rules**, or choose personal Tailscale; do not disable the
firewall or add an all-ports rule.
Personal Tailscale must remain active on both PC and phone. Authorized/shared tailnet peers may
reach the service when policy permits, and tailnet administrators can observe/manage the device.
Advanced setup requires a concrete hostname or IP address reachable from the phone. Loopback and
wildcard addresses are never placed in a pairing or verification QR.

On macOS and Linux, the established install finale still mints a pairing code and prints a terminal
QR plus the gateway URL and setup code. The final pairing QR encodes
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
listener/public URL options remain available as advanced intent.
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
The non-interactive `cozygateway status`, `cozygateway setup`, `cozygateway pair`, and
`cozygateway configure` commands expose the same focused operations directly.

On Windows, state is under `%LOCALAPPDATA%\cozygateway`. Persistence uses the
current-user `CozyGateway` Scheduled Task with a hidden Startup-folder fallback
when policy blocks task registration. Phone-created bot auto-provisioning is not
part of the Windows installer.

Uninstall never performs model selection or downloads. On macOS and
Linux the installer also exposes `cozygateway` through `~/.local/bin` in new
terminal sessions; uninstall removes only its own command entry and profile line.
On Windows, use the same bootstrap recovery path from PowerShell 5.1+:

```powershell
$installer = irm https://cozylabs.ai/install.ps1
& ([scriptblock]::Create($installer)) --uninstall
```

For a custom root, set `$env:COZYGATEWAY_HOME` to that exact directory first. A healthy install uses
its protected `local\network-authority.json` locator, config, SQLite database, bundle, and private
`runtime\node\node.exe` to reconcile only owned network state. When that locator proves the database
is absent, only network reconciliation is skipped: the installed `agent-install.sh --uninstall`
still removes owned plugins, profile environment keys, spools, lifecycle changes, Task/Startup
persistence, process, PATH entry, and safe files. A reconcile failure preserves Task, process, PATH,
config, SQLite, and files for retry.

If config or locator damage makes a prior external database path unknowable, PowerShell deactivates
the exact CozyGateway persistence/process and asks the healthy shell payload to deactivate recorded
Hermes lifecycle/plugin activity, but retains the entire root for recovery. It never infers that
network authority is absent. Repair requires restoring the checksum-verified bundle and helper, the
private Node runtime, readable config, protected authority locator, and its referenced SQLite
database/sidecars before retrying. Native file removal without Git Bash is reserved for a genuinely
missing shell payload with authority proven absent by the protected locator. Hermes profiles/services
remain governed by the recorded ownership rules; unrelated processes and persistence entries are
not stopped.
Linux service units honor `XDG_CONFIG_HOME` and otherwise use
`~/.config/systemd/user`. An environment without a running systemd user manager,
such as a container or WSL instance without systemd, fails before installation
with an actionable message.

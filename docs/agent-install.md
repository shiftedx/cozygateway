# CozyGateway Hermes install

Use the human-facing one-paste installer for an existing Hermes machine:

Windows PowerShell 5.1+:

```powershell
irm https://cozylabs.ai/install.ps1 | iex
```

The Windows bootstrap reuses Hermes when installed. If Hermes is absent, it
runs the official tagged NousResearch Windows installer and setup wizard. Every
run opens `hermes model` before any CozyGateway changes so the operator selects
or confirms an inference provider and default model. It then checksum-verifies
the CozyGateway release assets and hands off through Hermes-compatible Git Bash.

macOS/Linux:

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

It discovers Hermes with `hermes -p <profile> config path`, then uses that
evidence to find the default home and named profile homes. Every discovered
profile with a `config.yaml` is configured by default; narrow the scope with
`--profiles default,ops`.

The release bootstrap downloads and SHA-256 verifies three versioned release
assets before execution: the gateway bundle, the complete Hermes attach plugin
archive, and the installer payload. It never executes the mutable raw installer
after that handoff. The checksum detects incomplete or corrupted downloads;
release authenticity still relies on GitHub Releases over TLS.

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

The install (and every re-run) finishes by minting a pairing code and printing
a terminal QR plus the gateway URL and setup code in plain text, so a fresh
device goes install, scan, chatting with no further commands. The QR encodes
the `{"gatewayUrl":...,"setupCode":...}` payload from contract section 4; the
URL prefers the machine's LAN address over loopback. Codes expire after 10
minutes; mint another with `~/.cozygateway/bin/cozygateway pair`, or
`pair --url https://...` for a remote origin such as a Tailscale hostname.

The default listener is `0.0.0.0:8787` for local/LAN use. Network reachability
outside the machine is deliberately not automated; see `docs/connectivity.md`.

After installation, open a new terminal and run `cozygateway` for the basic
terminal menu. It shows live status, prints a fresh pairing QR, and lets a power
user change only the bind address and port. Press Enter at either configuration
prompt to retain the current value. A saved listener change atomically preserves
the rest of the config, updates the local target for every installer-managed
Hermes profile without changing its token, and restarts the gateway and those
Hermes profiles automatically. Rerunning the installer also preserves a saved
custom listener unless an explicit installer host or port option replaces it.
The non-interactive `cozygateway status`, `cozygateway pair`, and
`cozygateway configure` commands expose the same focused operations directly.

On Windows, state is under `%LOCALAPPDATA%\cozygateway`. Persistence uses the
current-user `CozyGateway` Scheduled Task with a hidden Startup-folder fallback
when policy blocks task registration. Phone-created bot auto-provisioning is not
part of the Windows installer.

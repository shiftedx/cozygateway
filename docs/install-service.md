# CozyGateway service

Windows PowerShell (install or update):

```powershell
irm https://cozylabs.ai/install.ps1 | iex
```

macOS/Linux:

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

The installer registers exactly one CozyGateway login service: launchd on
macOS, a systemd user service on Linux, or the current-user `CozyGateway`
Scheduled Task on Windows. If Windows policy blocks task creation, it writes a
hidden launcher to the user's Startup folder. It reads gateway tokens and the
local Dashboard password at runtime from mode-600 files; neither unit includes
a secret. The service starts or reuses the loopback Hermes Dashboard as the
control/read plane. Each selected Hermes profile gateway is restarted, started,
or installed as needed so its attach plugin is operational. Hermes keeps
ownership of those services; uninstall reverses only lifecycle work it caused.
It also makes `cozygateway` available in new terminal sessions without a global
package installation.

The Windows bootstrap installs or updates Hermes Agent and its selected attach
profiles. Unattended repair keeps the recorded Hermes profile scope and gateway
settings. An administrator shell hands setup to the same account's normal desktop
context before product changes.

On Windows, macOS, and Linux, missing Node.js 24+ is installed as a private,
checksum-verified runtime under the CozyGateway home. Missing Hermes is
installed with the verified official tagged NousResearch installer. Setup then
runs `hermes model` interactively only when the active provider/model is
incomplete, then verifies it
before installing CozyGateway or printing a pairing QR.

On Windows, the Hermes source checkout uses the same release tag as its
installer. The official installer handles Git-to-ZIP fallback and managed npm
compatibility; CozyGateway prepares the Dashboard assets before starting the
background service. Packaged applications use the physical application-data
directory, and repair corrects recognized Hermes launchers that still embed its
package-only alias so Task Scheduler can use them.

For unattended setup of an unconfigured Hermes default profile, set both
`COZYGATEWAY_HERMES_MODEL_ENDPOINT` (an HTTP(S) API base URL) and
`COZYGATEWAY_HERMES_MODEL_ID` before running the Windows installer. This uses
Hermes' custom provider and skips the upstream setup wizard. An already
configured default profile keeps its existing provider and model.

Fresh interactive installs ask whether CozyChat may access the Gateway over the local network.
No (the default) listens on `127.0.0.1:8787`; Yes listens on `0.0.0.0:8787` and makes the pairing
QR use the detected LAN address. Non-interactive installs keep loopback unless `--bind-host`
chooses otherwise. To use a tunnel, record its strict HTTPS origin with
`--public-url https://gateway.example.com`; a public origin fails closed unless the listener is
loopback. Change the port with `--port`. The attached Hermes plugins use loopback to reach the
same machine. Updates preserve the saved listener and public origin unless an explicit flag changes
the posture. Use `--clear-public-url --bind-host 0.0.0.0` to explicitly leave the public posture and
return to LAN access; `--clear-public-url` cannot be combined with `--public-url`.

Check the service:

```sh
# macOS
launchctl print gui/$UID/ai.cozylabs.cozygateway

# Linux
systemctl --user status cozygateway
```

Windows PowerShell:

```powershell
& "$env:ProgramFiles\Git\bin\bash.exe" "$env:LOCALAPPDATA\cozygateway\bin\agent-install.sh" --status --gateway-dir "$env:LOCALAPPDATA\cozygateway"
schtasks /Query /TN CozyGateway /V /FO LIST
```

On Linux the installer enables user lingering so the service survives logout
and reboot. If your host policy blocks that authorization, run
`sudo loginctl enable-linger "$USER"` once and repeat the installer.
The unit is written below `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`.
Linux without `systemctl --user`, `loginctl`, or a running user manager is not a
supported service host and is rejected before prerequisite installation.

Update or repair with `cozygateway repair` (`cozygateway update` is an alias),
or repeat the one-paste line when the installed command itself is damaged. Both
paths fetch and verify one matched release while preserving the recorded profile
scope and operator-owned gateway settings.

## Uninstall

The same command works in Terminal on macOS/Linux and PowerShell on Windows:

```sh
cozygateway uninstall --purge
```

`--purge` permanently deletes Gateway conversations, pairing credentials, configuration,
logs, caches, backups, private tools, and the install directory. The command
removes its service and PATH entry, managed Hermes plugins, generated credentials,
and attachment database files. Cleanup failures return an error and retain the
remaining files for retry; inspect the error before retrying.

Preview the cleanup without changing files or services:

```sh
cozygateway uninstall --purge --dry-run
```

Hermes and its profiles/history, shared tools and model credentials, user projects,
and other apps such as CozyChat are separate installations and remain. Runtime-only installs remove only their
Gateway; they do not claim independently managed Hermes connections.

If the command is unavailable, use the installed script (adjust the directory for
an installation in a custom location):

```sh
bash ~/.cozygateway/bin/agent-install.sh --uninstall --purge --gateway-dir ~/.cozygateway
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\cozygateway\bin\cozygateway-bootstrap.ps1" -Uninstall -Purge
```

If those scripts are missing, rerun the original install command to restore them,
then uninstall. No downloads are needed when the installed uninstall scripts and
runtimes are intact. Close and reopen your terminal to refresh its PATH afterward.

No network overlay, tunnel, DNS record, or firewall rule is created or changed.

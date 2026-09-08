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

The Windows bootstrap offers CozyAgents, Hermes Agent, or Both on interactive
installs and reruns. Selecting a second agent adds it to the same gateway and
keeps the existing agent. Both installs the Hermes attach profiles and a paired
CozyAgents runner; it asks about the listener once and prints one device pairing
QR after both are ready. Unattended repair keeps the recorded agent selection,
CozyAgents home, model settings, runner credential, and Hermes profiles.
Gateway updates reuse the recorded CozyAgents runtime when its Node executable
and bundle are present and readable. This also allows an update from an elevated
shell under the same Windows account without invoking CozyAgents' setup, which
refuses elevation. Missing or damaged runtimes go through setup from a normal
PowerShell window. Use CozyAgents' own updater to update that harness separately.
Selecting CozyAgents from an elevated shell on an existing Hermes-only gateway
updates Hermes' gateway and explicitly defers the harness addition until setup
is run from a normal PowerShell window; the installer does not record it as installed.
Uninstall removes the gateway's managed attachments and invokes CozyAgents' own
uninstaller when that runner was installed.

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
scope and operator-owned gateway settings. Remove only installer-owned state:

```sh
bash ~/.cozygateway/bin/agent-install.sh --uninstall --gateway-dir ~/.cozygateway
```

No network overlay, tunnel, DNS record, or firewall rule is created or changed.

# CozyGateway service

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

On Windows, macOS, and Linux, missing Node.js 24+ is installed as a private,
checksum-verified runtime under the CozyGateway home. Missing Hermes is
installed with the verified official tagged NousResearch installer. Setup then
runs `hermes model` interactively only when the active provider/model is
incomplete, then verifies it
before installing CozyGateway or printing a pairing QR.

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

Before Hermes/model setup or release-asset download, Windows PowerShell verifies that the selected
Gateway port is free or belongs to the same install's exact config path. A conflict reports the PID
and process name and stops before tokens, config, plugin, Scheduled Task, or Startup mutation.

On Linux the installer enables user lingering so the service survives logout
and reboot. If your host policy blocks that authorization, run
`sudo loginctl enable-linger "$USER"` once and repeat the installer.
The unit is written below `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`.
Linux without `systemctl --user`, `loginctl`, or a running user manager is not a
supported service host and is rejected before prerequisite installation.

Update by repeating the one-paste line. Remove only installer-owned state:

```sh
bash ~/.cozygateway/bin/agent-install.sh --uninstall --gateway-dir ~/.cozygateway
```

Windows PowerShell 5.1+:

```powershell
$installer = irm https://cozylabs.ai/install.ps1
& ([scriptblock]::Create($installer)) --uninstall
```

Set `$env:COZYGATEWAY_HOME` first when uninstalling a custom root. Healthy uninstall first runs the
installed bounded owned-network cleanup; any failure preserves persistence, config, SQLite, and
files for retry. Only after successful cleanup does it remove the `CozyGateway` current-user Task,
Startup fallback, exact managed process, PATH entry, and files. If bundle/config/runtime damage
prevents cleanup while a configured/default SQLite database or SQLite sidecar remains, uninstall
fails closed and asks you to repair the payload before retrying. Native PowerShell recovery works
without Git Bash or the installed shell payload only when ownership authority is definitely absent,
and warns that missing network authority cannot be reconstructed.

No firewall rule is created or changed. Same Wi-Fi setup reads the selected adapter's Windows
network category and active firewall policy. For a trusted home network reported as `Public`, change
only that connection to `Private` in Windows Settings. Keep Windows Firewall enabled; if reachability
is blocked, follow the setup message's exact port through **Windows Security > Firewall & network
protection > Advanced settings > Inbound Rules** and authorize only that TCP port on the Private
profile, or use Tailscale—never disable the firewall or create an all-ports/all-profiles rule.

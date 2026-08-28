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

Fresh installs listen on `127.0.0.1:8787`. Choose LAN access explicitly with
`--bind-host 0.0.0.0`, or record a user-managed tunnel's strict HTTPS origin with
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

Update by repeating the one-paste line. Remove only installer-owned state:

```sh
bash ~/.cozygateway/bin/agent-install.sh --uninstall --gateway-dir ~/.cozygateway
```

No network overlay, tunnel, DNS record, or firewall rule is created or changed.

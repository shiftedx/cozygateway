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
checksum-verified runtime under the CozyGateway home (`runtime\node\node.exe` on Windows). It runs
both the installed Gateway and bounded owned-network cleanup; it is not a system Node installation. Missing Hermes is
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
The checksum-verified temporary helper then verifies the Hermes Dashboard port before model or any
install-root, token, state, environment, config, plugin, runtime, Task, or Startup mutation. Only the
exact expected Hermes Dashboard owner may be reused; another owner is reported with PID/process and
an explicit free `--dashboard-port` action.

For an explicit `COZYGATEWAY_HOME`, an existing directory must be empty or already carry the exact
privately protected CozyGateway ownership marker. A random marker nonce is persisted in protected
install state and the database-authority locator before installed assets land. The installer refuses
to adopt a nonempty project, OneDrive vault, or other unrelated directory without that proof.

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

Set `$env:COZYGATEWAY_HOME` first when uninstalling a custom root. Healthy uninstall reads the
protected database-authority locator and uses the installed bundle plus private Node runtime for
bounded owned-network cleanup. If the located database is absent, it skips only that reconcile and
still runs the healthy shell uninstaller to remove owned plugins/profile variables/spools, reverse
recorded Hermes lifecycle changes, remove Task/Startup persistence and PATH, and delete safe files.
Any reconcile failure preserves the complete install for retry.

If config/locator damage makes a legacy external database path unknowable, uninstall deactivates the
exact CozyGateway persistence/process and recorded Hermes activity but retains the root with repair
guidance; it does not claim authority is absent. Repair must restore the checksum-verified helper and
bundle, `runtime\node\node.exe`, readable config, protected `local\network-authority.json`, and the
referenced SQLite database/sidecars. Native PowerShell file removal without Git Bash is used only
when the shell payload is genuinely missing and the protected locator proves network authority absent.
All native and shell uninstall fallbacks use an explicit CozyGateway file allowlist and the owned
private `runtime\node` directory; none recursively deletes the install root. The ownership marker is
validated before teardown, unrelated files are retained, and the root itself is removed only when it
is empty. A missing or invalid marker fails closed with recovery guidance rather than deleting files.

No firewall rule is created or changed. Same Wi-Fi setup reads the selected adapter's Windows
network category and active firewall policy. For a trusted home network reported as `Public`, change
only that connection to `Private` in Windows Settings. Keep Windows Firewall enabled; if reachability
is blocked, follow the setup message's exact port through **Windows Security > Firewall & network
protection > Advanced settings > Inbound Rules** and authorize only that TCP port on the Private
profile, or use Tailscale—never disable the firewall or create an all-ports/all-profiles rule.

# CozyGateway service

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

The installer registers exactly one CozyGateway login service: launchd on
macOS, or a systemd user service on Linux. It reads gateway tokens and the
local Dashboard password at runtime from mode-600 files; neither unit includes
a secret. The service starts or reuses the loopback Hermes Dashboard as the
control/read plane. Each selected Hermes profile gateway is restarted, started,
or installed as needed so its attach plugin is operational. Hermes keeps
ownership of those services; uninstall reverses only lifecycle work it caused.

The gateway listens on `0.0.0.0:8787` by default, allowing local/LAN access.
Change it with `--bind-host` or `--port` when installing. The attached Hermes
plugins use loopback to reach the same machine.

Check the service:

```sh
# macOS
launchctl print gui/$UID/ai.cozylabs.cozygateway

# Linux
systemctl --user status cozygateway
```

On Linux the installer enables user lingering so the service survives logout
and reboot. If your host policy blocks that authorization, run
`sudo loginctl enable-linger "$USER"` once and repeat the installer.

Update by repeating the one-paste line. Remove only installer-owned state:

```sh
bash ~/.cozygateway/bin/agent-install.sh --uninstall --gateway-dir ~/.cozygateway
```

No network overlay, tunnel, DNS record, or firewall rule is created or changed.

# ADR 0080: Hermes-native one-paste install

The supported one-paste path targets an existing Hermes installation. It
discovers profile homes through the Hermes CLI, installs a version-matched
attach plugin per selected profile, and runs one shared CozyGateway service.
Hermes continues to own its profile gateway services.

The separate macOS bot auto-provisioner follows the same ownership boundary but
cannot execute from a checkout under `~/Documents`: TCC denies background
LaunchAgents access without a user privacy grant. Its supported install command
is `scripts/install-bot-provisioner.sh`, which snapshots the watcher,
provisioner, and attach-plugin source under
`~/Library/Application Support/cozylabs/provisioner` and points the per-user
Aqua LaunchAgent there. The snapshot is refreshed explicitly by re-running that
command after relevant checkout updates; a background self-refresh would need
the same forbidden checkout access.

The generated gateway configuration uses one `hermes.profiles` identity per
Hermes profile. It intentionally does not create legacy `agents[]` identities
or duplicate native-data-plane identities. Tokens stay in mode-600 environment
files and configuration carries token environment-variable names only.

Network infrastructure is outside installer scope. Fresh interactive installs make LAN binding an
explicit yes/no choice whose default is loopback; non-interactive installs also keep loopback
unless `--bind-host 0.0.0.0` opts in. `--public-url` records one HTTPS origin and keeps the
listener on loopback, but Tailscale, Cloudflare named tunnels, certificates, DNS, and firewall
policy remain explicit operator work. Updates preserve an existing saved listener.

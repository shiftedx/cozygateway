# Installing cozygateway as a service

This page is for you, the human, not for an agent. If you want an AI agent to install cozygateway
for you (Docker, or a Node checkout it builds itself), send it `docs/agent-install.md` instead.

## What you need

A working Hermes install (0.20.2 or newer) and Node 24 or newer. cozygateway connects your phone
to a Hermes agent, so Hermes has to already be there; the one-liner checks for both and stops with
instructions if either is missing.

## What the one-liner does

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

1. Checks that Hermes is installed. If it cannot find it, it stops and tells you to install Hermes
   first, since cozygateway connects your phone to a Hermes agent.
2. Checks for Node 24 or newer. If it cannot find one, it stops and tells you how to get one
   (`brew install node` on macOS, your distro's package or nodejs.org on Linux).
3. Downloads the latest released `cozygateway.mjs` bundle and its `.sha256` file, and verifies the
   hash before it will run anything. A mismatch aborts with no install performed.
4. Downloads `scripts/agent-install.sh` and hands off to it with `--bundle` pointing at the
   verified bundle and `--service`.
5. `agent-install.sh` generates a dashboard password, writes the gateway config, registers the
   gateway and the Hermes dashboard as login services, starts them, and prints a pairing code for
   the phone app.

Everything lands under one directory: `~/.cozygateway`.

## Where things live

| What | Path |
| --- | --- |
| Gateway bundle | `~/.cozygateway/bin/cozygateway.mjs` |
| Install script | `~/.cozygateway/bin/agent-install.sh` |
| Generated config, credentials, logs | `~/.cozygateway/local/` |
| Gateway log | `~/.cozygateway/local/cozygateway.log` |
| Hermes dashboard log | `~/.cozygateway/local/hermes-dashboard.log` |
| Service definition, macOS | `~/Library/LaunchAgents/ai.cozylabs.cozygateway.plist` and `ai.cozylabs.hermes-dashboard.plist` |
| Service definition, Linux | `~/.config/systemd/user/cozygateway.service` and `cozygateway-hermes-dashboard.service` |

## Check status

macOS:

```sh
launchctl print gui/$UID/ai.cozylabs.cozygateway
launchctl print gui/$UID/ai.cozylabs.hermes-dashboard
```

Linux:

```sh
systemctl --user status cozygateway
systemctl --user status cozygateway-hermes-dashboard
```

## Pair another phone

The install prints one pairing code, and a code is single use and expires after 10 minutes. For the
next phone, or for the same phone again after you removed it, mint a fresh one:

```sh
bash ~/.cozygateway/bin/agent-install.sh --pair-only --gateway-dir ~/.cozygateway
```

It reads the settings of the install already running and only mints a code. It starts nothing and
changes nothing.

## View logs

```sh
tail -f ~/.cozygateway/local/cozygateway.log
tail -f ~/.cozygateway/local/hermes-dashboard.log
```

On Linux, `journalctl --user -u cozygateway -f` works too.

## Restart

The services are meant to come back on their own after a crash and at login, so you should rarely
need this. If you killed one by hand (a plain `kill`, or logging out, counts as a clean stop, not a
crash, so it does not restart itself):

macOS:

```sh
launchctl kickstart -k gui/$UID/ai.cozylabs.cozygateway
```

Linux:

```sh
systemctl --user restart cozygateway
```

## Update

Re-run the same line:

```sh
curl -fsSL https://cozylabs.ai/install.sh | bash
```

It is idempotent. It re-downloads the latest release bundle, verifies it, reuses the dashboard
password it recorded the first time, and refreshes the services in place. This is the update path,
there is no separate updater.

## Uninstall

```sh
bash ~/.cozygateway/bin/agent-install.sh --uninstall-service --gateway-dir ~/.cozygateway
```

This stops and removes the service units only. Your config, message database, and credentials stay
in `~/.cozygateway` untouched. Delete that directory yourself if you want everything gone.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Service never starts on macOS, log file is empty | Something the service runs from (Hermes' own Python, or a stray editable install) lives under `~/Documents`, `~/Desktop`, or `~/Downloads`. macOS gates those folders behind per-app consent, and a login service has no window to ask for it. The installer checks for this and names the offending path in a warning. | Move the file out of the guarded folder, or remove the stray `.pth` pointing into it, or grant Full Disk Access to `/bin/bash` in System Settings. |
| Service stops as soon as you log out, on Linux | Your user session does not linger, so systemd tears down user services at logout. | `sudo loginctl enable-linger $USER`, then re-run the one-liner. |
| You killed the process by hand and it did not come back | This is by design. The service restarts after a crash, or at login and reboot, but a deliberate stop is not treated as a crash. | Restart it yourself, see Restart above. |
| Install fails with "bundle sha256 mismatch" | The download was corrupted or interrupted, or the release asset does not match its published hash. The installer refuses to run an unverified bundle on purpose. | Re-run the one-liner. If it keeps failing, check your network and try again later; do not skip the check. |

## Security posture

The gateway and the Hermes dashboard both bind to loopback (`127.0.0.1`) by default, so nothing on
your network can reach them without going through the phone app's pairing and its own connection
path. The dashboard password lives in a mode-600 file, readable only by your user, and is never
written into the service definition itself, since those files are world-readable. The bundle you
run is the exact file whose sha256 was checked against the one published alongside the release, so
a corrupted or truncated download is refused rather than executed.

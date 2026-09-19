# Installer gaps found re-homing a Hermes install to a local gateway

Recorded 2026-09-14 from a live install on the owner's Mac (Hermes 0.21.3, CozyGateway 0.8.5). The
machine had four Hermes profiles attached to a remote CozyGateway, a dev-box provisioner LaunchAgent
that re-attached them, and a CozyChat-started loopback Dashboard. Seven runs of the one-line installer
were needed before it succeeded. Each gap below is something the installer or supervisor should handle
on its own; the manual step that worked is recorded so the fix can be tested against it.

| # | Symptom | Cause | Manual step that worked | Proposed fix |
|---|---|---|---|---|
| 1 | `…/.env targets another Gateway; use --runtime-only to preserve it` | No supported re-home path. `--runtime-only` keeps the old attachment, which is the opposite of the ask. | Strip the five `COZYGATEWAY_*` keys from each profile env and move the profile plugin folders aside. | `--replace-gateway`: stop each profile gateway, back up the old plugin folder and env keys under `~/.cozygateway/local/backups/<stamp>/`, remove them, continue. |
| 2 | The stripped keys came back seconds later. | A running Hermes gateway rewrites its profile `.env` from memory. The installer's own env writes race the same way. | Stop the profile gateways before editing env. | Stop a profile's gateway before writing its env, then start it. Verify the file after the write. |
| 3 | `…/plugins/cozygateway already exists and is not owned by this installer` | Plugin folders from an older install carry no ownership marker. | Move them aside. | Part of `--replace-gateway`; also accept a folder whose `plugin.yaml` matches a known released archive and adopt it. |
| 4 | `CozyGateway supervisor could not start.` with no reason | Existing Dashboard on 9119 rejected the token; the private fallback ran `hermes dashboard --port N` without `--isolated`, and Hermes 0.21.3's unified server routed it to the existing machine-level server, so it never listened. The supervisor swallowed the error. | Stop the foreign Dashboard. | Pass `--isolated` on the fallback launch; print the underlying error; the installer should also report the Dashboard owner (pid, command, profile) when it refuses one. |
| 5 | `Hermes Dashboard rejected the installer-owned local session token (HTTP 401)` | The profile env pinned `HERMES_DASHBOARD_SESSION_TOKEN`; Hermes loads `.env` with override, so it beat the token the supervisor passed in the process environment. | Remove the line from the profile env. | Detect the key in the active profile env; either adopt it as the Dashboard token or replace the line (with backup) and say so. CozyChat's host script should likewise defer to a gateway-owned Dashboard when one exists. |
| 6 | `Hermes attach profile count mismatch (configured=5, online=1)` | Three profile gateways were "already running with the current attach plugin and config", judged from files, while their processes were still attached to the old gateway from memory. | Restart those gateways. | Compare the live attach target (from the gateway's `/attach` roster or the plugin log) with the configured origin; restart on mismatch. Extend the readiness wait to cover the plugin's 16 s backoff. |
| 7 | A rollback left its Dashboard and a detached `gateway run --replace` running; every retry then failed at the same step. | Rollback restores the release but does not stop what the failed run started. | Kill the leftover processes by pid. | Rollback stops the Dashboard and any gateway process the run launched, using the pids it recorded. |
| 8 | `default` profile started a duplicate of the active profile; cleo's service check then failed. | On a Mac with an `active_profile`, plain `hermes gateway run` means that profile, not `default`. | `--profiles cleo,drowsy-lark,night-owl,polished-satellite`. | Resolve `default` through `hermes config path` and skip it when it aliases an already selected profile; never start a profile gateway without `--profile`. |

Also seen, outside the installer's scope but worth a note in the docs: a dev-box provisioner LaunchAgent
(`ai.cozylabs.bot-provisioner`) re-attaches profiles to the remote gateway and must be unloaded first;
and 51 orphaned `cozy-platform-supervisor` test stubs from the CozyAgents suite were still running after
nine days, so that suite needs teardown.

Suggested slices: (1) `--replace-gateway` with backups and gateway stop/start around env writes (gaps 1, 2, 3);
(2) Dashboard handling: `--isolated` fallback, owner report, token adoption (gaps 4, 5); (3) attach target
verification and rollback cleanup (gaps 6, 7); (4) `default` profile resolution (gap 8); (5) a test that replays
this machine's shape in the installer test suite.

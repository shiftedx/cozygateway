# Handoff 2026-09-05: one gateway, and what was cleaned up to get there

Written after the phone-created bot incident (v0.7.4, PR #353) and the dev-box audit that
followed. Read this before touching the dev deployment or the bot provisioner.

## The deployment that exists

One gateway: Docker `cozygateway-gateway-1` on 192.168.99.106, reachable as
`https://warm.cozylabs.ai` through the `cozylabs-tunnel` container. It runs the tagged release
(`git checkout v0.7.4` in `/home/kmcdowell/cozygateway`, then `docker compose build gateway` and
`docker compose up -d --force-recreate gateway`).

- **Live config:** `local/config/cozygateway.config.json`, bind-mounted to `/config`. The file
  `docker/cozygateway.config.json` has been stale since the v0.5.11 move; it is now renamed
  `docker/cozygateway.config.json.stale-20260905-superseded-by-local-config`. Do not resurrect it.
- **Secrets:** `/home/kmcdowell/cozygateway/.env` (compose `env_file`). One
  `COZYGATEWAY_ATTACH_TOKEN_<PROFILE>` line per Hermes profile plus `SAGE` for the runtime bot.
- **Control plane:** the Mac's Hermes dashboard on `0.0.0.0:9119` (launchd `ai.hermes.dashboard`,
  password auth as `cozybridge`). This is the only Hermes dashboard that should exist for the
  default profile.
- **Attach peers:** every Hermes profile under `~/.hermes/profiles/*` dials
  `https://warm.cozylabs.ai`; the CozyAgents runner "Kyle's Mac" and its bots (`sage`,
  `breezy-ivy`) attach to `wss://warm.cozylabs.ai/attach/v1`.
- **Default profile:** cozygateway plugin disabled, no `COZYGATEWAY_*` keys in `~/.hermes/.env`.
  The box hides `default` from the roster. Keep it that way: Hermes `profiles.create` copies the
  launch profile's `.env` into every new profile, so any gateway binding on `default` is inherited
  by every bot created from the phone.

## What was removed

- The native `~/.cozygateway` install on the Mac (launchd `ai.cozylabs.cozygateway`, listener
  `*:8787`, private dashboard on `127.0.0.1:9120`). Nothing was paired to it. Its only effect was
  writing `COZYGATEWAY_URL=http://127.0.0.1:8787` into the default profile, which every new
  profile then inherited, so new bots dialed the wrong gateway and were refused.
- Stale box entries `d14-default` and `snug-nimbus` (env lines and config entries).
- Seven Hermes dashboards leaked by installer test runs.

## The provisioner, and its three fixed bugs (PRs #354, #355)

`scripts/bot-provisioner-watch.sh` (LaunchAgent `ai.cozylabs.bot-provisioner`, staged under
`~/Library/Application Support/cozylabs/provisioner`) is the dev-box mechanism that wires a
phone-created Hermes profile to the Docker gateway. It is not shipped to users; native installs
provision through the gateway-triggered installer run (`profile-provisioner.ts`).

1. It edited the stale `docker/` config. `BOX_CONFIG_REL` now defaults to
   `local/config/cozygateway.config.json`.
2. `docker compose up -d` does not recreate on a config-only change. It now passes
   `--force-recreate`, gated on an actual env or config change so a plugin-refresh sweep does not
   bounce the live gateway once per profile.
3. It left an inherited `COZYGATEWAY_URL` alone. It now upserts the URL like the token and spool.

Refresh the staged copy after any change: `scripts/install-bot-provisioner.sh`.

## Verifying the whole thing in one minute

```sh
curl -s https://warm.cozylabs.ai/ready | jq '{ready, hermes: .bridges.hermes.online, attach: .attach | {configured, online, deadLetters}}'
for p in ~/.hermes/profiles/*; do printf '%-20s %s\n' "$(basename "$p")" "$(grep -h '^COZYGATEWAY_URL=' "$p/.env")"; done
launchctl list | grep -E 'cozy|hermes'
```

Expected: `ready: true`, `hermes: true`, `online == configured`, `deadLetters: 0`; every profile on
`warm.cozylabs.ai`; no `ai.cozylabs.cozygateway` entry.

## Open items

- `breezy-ivy` reports `needs_attention model_unavailable` because the LAN model endpoint
  `192.168.99.121:1234` was not answering. Not a gateway problem.
- Windows native installs still do not auto-provision phone-created bots (`docs/agent-install.md`).
- Fixed the same day: `HermesBridge.createBot` used to answer 404 when the post-create roster
  refresh failed, though the profile existed. It now answers 201 from the create's own data,
  patches the cached roster, and refreshes again (`bots-create-roster-refresh.test.ts`).
- The compose project warns about the orphan `cozygateway-maintenance-supervisor-1` container on
  every `up`. Harmless.

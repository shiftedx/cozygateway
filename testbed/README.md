# TB1 burner test bed

A disposable full-surface bed on one Mac: a CozyGateway in Docker, two burner Hermes
agents, a burner CozyAgents runner with two runtime bots, and a CozyChat simulator.
Everything is named `burner-` and none of it touches production.

## What it must never touch

| Production thing | Why it is at risk |
| --- | --- |
| The gateway on `192.168.99.106` / `warm.cozylabs.ai` | The bed pairs devices and creates bots. Only ever aim at the burner origin. |
| `<home>/.hermes` and its six profiles (cleo, night-owl, drowsy-lark, honeyed-tilly, polished-satellite, dewy-bayberry) | The burner home is `<home>/.hermes-burner`. Never set `HERMES_HOME` to `<home>/.hermes` here. |
| The production Hermes dashboard on `9119` (launchd `ai.hermes.dashboard`) | The burner dashboard is a second server on `9125`. |
| The production CozyAgents runner (launchd `ai.cozyagents.runner.<hash>`) | The burner runner is a foreground process with its own `COZYRUNNER_HOME`. |

**Never run `pkill -f "gateway run"`.** That pattern matches all six production Hermes
profile gateways as well as the two burners. They are launchd `KeepAlive` jobs so they
respawn, but they are bounced and every in-flight turn is lost. Kill by PID, or match on
the burner profile names (`--profile burnerhermesone`) or on `hermes-burner`.
`down.sh` does it correctly.

## Ports

| Port | What | Bind |
| --- | --- | --- |
| 8795 | burner CozyGateway (container `burner-tb1-gateway`) | `0.0.0.0`, reachable on the LAN IP |
| 9125 | burner Hermes dashboard, the gateway's control plane | `0.0.0.0` so the container reaches it via `host.docker.internal` |
| 8810 | burner CozyAgents bot `burner-ca-one` readiness | loopback |
| 8811 | burner CozyAgents bot `burner-ca-two` readiness | loopback |

Deliberately avoided: `8787` and `9119` (production), `8790` and `8796` (already in use
on this Mac). `COZYRUNNER_BASE_PORT=8810` moves the runner's readiness range off `8790`.

No Cloudflare tunnel and no TLS overlay: this is a trusted-LAN plaintext bed.

## Paths

| Path | What |
| --- | --- |
| `<home>/Documents/repos/worktrees/tb1-burner-testbed` | this worktree, branch `codex/tb1-burner-testbed` |
| `<home>/.hermes-burner` | burner `HERMES_HOME`; profiles under `profiles/burnerhermesone` and `profiles/burnerhermestwo` |
| `<scratch>/tb1/gateway/config/cozygateway.config.json` | gateway config, bind-mounted to `/config` |
| `<scratch>/tb1/gateway/secrets/cozygateway.env` | compose `env_file`, 0600 |
| `<scratch>/tb1/tokens/` | every minted token, 0600, never in the repo |
| `<scratch>/tb1/cozyagents-home/` | burner `COZYRUNNER_HOME` plus `runner.env` |
| `<scratch>/tb1/cozyagents-bin/cozyagents.mjs` | the single-file bundle copied from the CozyAgents checkout |
| `<scratch>/tb1/DerivedData` | the one CozyChat build; delete it when done |
| `<scratch>/tb1/logs/` | dashboard, profile gateway, runner and build logs |

Docker volume `burner-tb1_burner-tb1-gateway-data` holds the gateway SQLite state.

## Tokens, by environment variable name only

Values live only in `<scratch>/tb1/tokens/burner.env` and the copies the tools wrote.

| Variable | Used by |
| --- | --- |
| `COZYGATEWAY_HERMES_PASSWORD` | gateway -> dashboard login as `cozybridge`; same value as `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD` in `<home>/.hermes-burner/.env` |
| `COZYGATEWAY_ATTACH_TOKEN_BURNER_HERMES_ONE` | `burnerhermesone`'s attach bearer, also its `COZYGATEWAY_TOKEN` |
| `COZYGATEWAY_ATTACH_TOKEN_BURNER_HERMES_TWO` | `burnerhermestwo`'s attach bearer, also its `COZYGATEWAY_TOKEN` |
| `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` | `cozybridge` |
| `HERMES_DASHBOARD_BASIC_AUTH_SECRET` | signs burner dashboard sessions |
| `COZYRUNNER_TOKEN` | the burner runner's own token, in `<scratch>/tb1/cozyagents-home/runner.env` |

The paired validation device's `deviceToken` is in
`<scratch>/tb1/tokens/validation-device.json`. No launchd label was installed for any
burner service; everything runs in the foreground, so nothing survives a reboot on its own.

## Model

The LAN endpoint `http://192.168.99.121:1234/v1` did not answer (100% ping loss), so the
bed runs on mtplx: `http://127.0.0.1:8001/v1`, model id
`qwopus3.8-27b-flash-mxfp4-vision-mtplx`. It is serial and shared, so keep turns short.

CozyAgents refuses a context window over `131072`, so the runner declares `131072` even
though mtplx advertises `198000`. The Hermes profiles use the full `198000`.

## Bringing it back after a reboot

Nothing here is a service. After a reboot, start from step 1.

```sh
export TB1_SCRATCH=<scratch>/tb1
cd <home>/Documents/repos/worktrees/tb1-burner-testbed/testbed
```

**1. Build the image if it is gone** (`docker images | grep burner-cozygateway`):

```sh
cd <home>/Documents/repos/worktrees/tb1-burner-testbed
docker build -f packages/gateway/Dockerfile -t burner-cozygateway:tb1 .
```

**2. Everything else in one shot:**

```sh
./up.sh      # gateway, dashboard, both Hermes profiles, the runner
./status.sh
```

`up.sh` is idempotent: it skips anything already listening or already running.

### What `up.sh` runs, if you need to do it by hand

Burner gateway:

```sh
COZYGATEWAY_SECRETS_FILE=<scratch>/tb1/gateway/secrets/cozygateway.env \
COZYGATEWAY_CONFIG_DIR=<scratch>/tb1/gateway/config \
  docker compose -p burner-tb1 -f testbed/docker-compose.burner.yml up -d
```

Burner Hermes dashboard, from the burner home, bound wide so the container can reach it:

```sh
HERMES_HOME=<home>/.hermes-burner \
  <home>/.local/bin/hermes -p default dashboard \
    --host 0.0.0.0 --port 9125 --no-open --skip-build
```

The two burner Hermes profile gateways, one process each:

```sh
cd <home>/.hermes-burner/profiles/burnerhermesone
HERMES_HOME=<home>/.hermes-burner \
  <home>/.local/bin/hermes --profile burnerhermesone gateway run

cd <home>/.hermes-burner/profiles/burnerhermestwo
HERMES_HOME=<home>/.hermes-burner \
  <home>/.local/bin/hermes --profile burnerhermestwo gateway run
```

The burner CozyAgents runner (foreground, no service installed):

```sh
node <scratch>/tb1/cozyagents-bin/cozyagents.mjs runner \
  --env <scratch>/tb1/cozyagents-home/runner.env
```

## Rebuilding the bed from nothing

Only needed if the scratch directory or `<home>/.hermes-burner` is gone.

**Gateway config and secrets.** Write `<scratch>/tb1/gateway/config/cozygateway.config.json`
with `host: 0.0.0.0`, `port: 8795`, `dbPath: /data/cozygateway.db`, and one
`hermesEndpoints` entry pointing `url` at `ws://host.docker.internal:9125/api/ws` and
`baseUrl` at `http://host.docker.internal:9125`, `authMode: password`, `username:
cozybridge`, `passwordEnv: COZYGATEWAY_HERMES_PASSWORD`, and a `profiles` map naming
`burnerhermesone` and `burnerhermestwo` with their `tokenEnv` names. The directory must be
writable by UID 1000 (the container's `node` user) because the gateway renames the config
in place. Put the three secret values in `<scratch>/tb1/gateway/secrets/cozygateway.env`.

**Pair a validation device** (loopback or LAN; this is not production):

```sh
docker exec burner-tb1-gateway node dist/cli.js pair \
  --config /config/cozygateway.config.json --url http://<lan-ip>:8795
curl -X POST http://<lan-ip>:8795/pair -H 'content-type: application/json' \
  -d '{"setupCode":"<code>","deviceName":"burner-validation-device","kind":"device"}'
```

Save the response to `<scratch>/tb1/tokens/validation-device.json`.

**Burner Hermes home:**

```sh
export HERMES_HOME=<home>/.hermes-burner
hermes profile create burnerhermesone --no-alias
hermes profile create burnerhermestwo --no-alias
```

Then, per profile: write a `config.yaml` naming the mtplx provider, append
`COZYGATEWAY_URL`, `COZYGATEWAY_TOKEN`, `COZYGATEWAY_HOME_CHANNEL=thread` and
`COZYGATEWAY_SPOOL_PATH` to its `.env` (0600), copy
`integrations/attach-plugin` from this worktree to `<profile>/plugins/cozygateway`, and

```sh
hermes --profile <name> plugins enable cozygateway --allow-tool-override
```

The plugin is opt-in and will not load until it is enabled; `--allow-tool-override` is
required or the enable half-completes. Put the basic-auth variables in
`<home>/.hermes-burner/.env` before starting the dashboard: a non-loopback bind refuses
to start with no auth provider.

**Burner CozyAgents runner:**

```sh
cp <home>/Documents/repos/CozyAgents/dist-bundle/cozyagents.mjs <scratch>/tb1/cozyagents-bin/
docker exec burner-tb1-gateway node dist/cli.js pair \
  --config /config/cozygateway.config.json --url http://<lan-ip>:8795 --kind runner
node <scratch>/tb1/cozyagents-bin/cozyagents.mjs runner pair <code> \
  --gateway http://<lan-ip>:8795 --name burner-tb1-runner --home <scratch>/tb1/cozyagents-home
```

Then append to `runner.env`: `COZYRUNNER_BASE_PORT=8810`, `COZYRUNNER_MODEL_ID`,
`COZYRUNNER_MODEL_ENDPOINT=http://127.0.0.1:8001/v1`, `COZYRUNNER_MODEL_API_KEY`,
`COZYRUNNER_MODEL_CONTEXT_WINDOW=131072`, `COZYRUNNER_MODEL_MAX_TOKENS=1024`,
`COZYRUNNER_ATTACH_URL`, and

```
COZYRUNNER_SERVE_COMMAND_JSON='["<node>","<scratch>/tb1/cozyagents-bin/cozyagents.mjs"]'
```

That last one is required for a bundle run outside an install: the process backend
otherwise resolves `serve` as `../cli.js` relative to its own module, which does not exist
beside the single-file bundle, and every bot dies `readiness_failed` until the restart
budget is exhausted.

**Create the two runtime bots ONE AT A TIME**, waiting for the first to reach `ready`:

```sh
curl -X POST http://<lan-ip>:8795/bots -H "authorization: Bearer <deviceToken>" \
  -H 'content-type: application/json' -d '{"name":"burner-ca-one","runtime":"cozyagents"}'
```

Created together, both are assigned the same readiness port (the allocator scans for a
free port and neither has bound yet) and the second fails `child_ownership_ambiguous`.
Recovering it is not enough: the port is re-read from the stale `bot.env`, so a genuine
retry means deleting the bot, removing
`<scratch>/tb1/cozyagents-home/bots/<botId>`, restarting the runner so its in-memory
ledger drops the row, and creating again.

## CozyChat simulator

```sh
cd <home>/Documents/repos/worktrees/tb1-burner-cozychat   # detached at origin/main
xcodegen generate
xcrun simctl create cozy-burner-iphone17 \
  com.apple.CoreSimulator.SimDeviceType.iPhone-17 \
  com.apple.CoreSimulator.SimRuntime.iOS-26-5
xcodebuild -project CozyChat.xcodeproj -scheme CozyChat \
  -destination "platform=iOS Simulator,id=<udid>" \
  -derivedDataPath <scratch>/tb1/DerivedData build CODE_SIGNING_ALLOWED=NO
```

Install and launch the built `.app` from
`<scratch>/tb1/DerivedData/Build/Products/Debug-iphonesimulator`, then pair it against
`http://<lan-ip>:8795` with a fresh setup code. Delete the simulator when finished:
`xcrun simctl delete cozy-burner-iphone17`.

## Smoke

`smoke.mjs` opens the device WebSocket at `/ws`, authenticates with the device token,
drives one bot or one room, and reports whether `bot_chat_delta` frames arrived (proof the
turn streamed) and what committed. It needs the `ws` package on `NODE_PATH` or beside it.

```sh
export TB1_DEVICE_TOKEN=<deviceToken> TB1_GATEWAY=http://<lan-ip>:8795
node smoke.mjs dm   burner-ca-one   "Say exactly: TB1 SMOKE ONE"
node smoke.mjs room <roomName>      "Both of you say hello once."
```

## Tearing down

```sh
./down.sh
xcrun simctl delete cozy-burner-iphone17
rm -rf <scratch>/tb1/DerivedData
```

`down.sh` leaves `<home>/.hermes-burner`, the scratch directory and the gateway volume in
place so the bed comes back with `up.sh`. To reclaim everything:

```sh
docker volume rm burner-tb1_burner-tb1-gateway-data
docker image rm burner-cozygateway:tb1
rm -rf <home>/.hermes-burner <scratch>/tb1
git -C <home>/Documents/repos/cozychat worktree remove ../worktrees/tb1-burner-cozychat
```

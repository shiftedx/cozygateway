#!/usr/bin/env bash
# Bring the TB1 burner bed up. Everything here is disposable and burner-prefixed.
# It never touches the production gateway, ~/.hermes, or the production runner.
#
# Cold-start order matters: /ready cannot go true until the Hermes bridge
# connects, and the bridge connects to the burner dashboard and profile
# gateways, which this script has not started until the second and third
# blocks below. So the container comes up first (gated only on the container
# itself being up, not on /ready), then the dashboard, then the profile
# gateways, then the runner, and only THEN do we gate on /ready -- see F20.
#
# NEVER capture this script's output with `out=$(./up.sh)` (or backticks).
# The dashboard, profile-gateway and runner blocks each background a `nohup`
# process from inside a `( ... )` subshell; that keeps the write end of a
# command-substitution pipe open even though the backgrounded process's own
# stdout/stderr are redirected to a log file, and the substitution then hangs
# until every one of those background processes exits. Plain redirection
# (`./up.sh > log 2>&1`, or just `./up.sh` interactively) is unaffected --
# only `$(...)`/backtick capture of the whole script hits this.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./env.sh

echo "==> burner gateway (docker, ${TB1_GATEWAY})"
docker compose -p "$TB1_COMPOSE_PROJECT" -f "$TB1_COMPOSE_FILE" up -d
for _ in $(seq 1 30); do
  state="$(docker compose -p "$TB1_COMPOSE_PROJECT" -f "$TB1_COMPOSE_FILE" ps --format '{{.State}}' gateway 2>/dev/null || true)"
  [ "$state" = "running" ] && break
  sleep 2
done
state="$(docker compose -p "$TB1_COMPOSE_PROJECT" -f "$TB1_COMPOSE_FILE" ps --format '{{.State}}' gateway 2>/dev/null || true)"
[ "$state" = "running" ] || { echo "gateway container never came up"; exit 1; }

echo "==> burner Hermes dashboard (port ${TB1_DASHBOARD_PORT})"
# Bound to all interfaces on purpose: the gateway container reaches it through
# host.docker.internal, which cannot see a loopback-only listener. A public bind
# requires an auth provider, so HERMES_DASHBOARD_BASIC_AUTH_* must be set in
# $TB1_HERMES_HOME/.env before this starts.
if ! lsof -nP -iTCP:"$TB1_DASHBOARD_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  HERMES_HOME="$TB1_HERMES_HOME" nohup "$TB1_HERMES_BIN" -p default dashboard \
    --host 0.0.0.0 --port "$TB1_DASHBOARD_PORT" --no-open --skip-build \
    > "$TB1_SCRATCH/logs/burner-dashboard.log" 2>&1 &
  echo "$!" > "$TB1_SCRATCH/burner-dashboard.pid"
  sleep 20
fi
lsof -nP -iTCP:"$TB1_DASHBOARD_PORT" -sTCP:LISTEN >/dev/null 2>&1 || {
  echo "burner Hermes dashboard never came up on port $TB1_DASHBOARD_PORT (see $TB1_SCRATCH/logs/burner-dashboard.log)"
  exit 1
}

echo "==> burner Hermes profile gateways"
for p in $TB1_PROFILES; do
  if ! pgrep -f -- "--profile $p gateway run" >/dev/null 2>&1; then
    ( cd "$TB1_HERMES_HOME/profiles/$p" && \
      HERMES_HOME="$TB1_HERMES_HOME" nohup "$TB1_HERMES_BIN" --profile "$p" gateway run \
        > "$TB1_SCRATCH/logs/hermes-$p.log" 2>&1 & echo "$!" > "$TB1_SCRATCH/burner-hermes-$p.pid" )
    sleep 2
  fi
  pgrep -f -- "--profile $p gateway run" >/dev/null 2>&1 || {
    echo "burner Hermes profile gateway $p never came up (see $TB1_SCRATCH/logs/hermes-$p.log)"
    exit 1
  }
done

echo "==> burner CozyAgents runner"
if [ -f "$TB1_SCRATCH/cozyagents-home/runner.env" ]; then
  if [ -z "$(tb1_runner_pids)" ]; then
    ( cd "$TB1_SCRATCH" && nohup node "$TB1_SCRATCH/cozyagents-bin/cozyagents.mjs" runner \
        --env "$TB1_SCRATCH/cozyagents-home/runner.env" \
        >> "$TB1_SCRATCH/logs/runner-stdout.log" 2>&1 & echo "$!" > "$TB1_SCRATCH/burner-runner.pid" )
    sleep 15
  fi
  [ -n "$(tb1_runner_pids)" ] || {
    echo "burner CozyAgents runner never came up (see $TB1_SCRATCH/logs/runner-stdout.log)"
    exit 1
  }
fi

echo "==> waiting for attach peers"
sleep 30

echo "==> gating on /ready (everything above is now started)"
for _ in $(seq 1 30); do
  curl -fsS -m 3 "$TB1_GATEWAY/ready" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS -m 5 "$TB1_GATEWAY/ready" >/dev/null || { echo "gateway never became ready"; exit 1; }

./status.sh

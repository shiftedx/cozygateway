#!/usr/bin/env bash
# Tear the TB1 burner bed down. Kills ONLY burner processes.
#
# NEVER use `pkill -f "gateway run"`: that pattern also matches the six
# production Hermes profile gateways (cleo, night-owl, drowsy-lark,
# honeyed-tilly, polished-satellite, dewy-bayberry). Match on the burner
# profile names or on the hermes-burner home, or kill by recorded PID.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
. ./env.sh

echo "==> burner Hermes profile gateways"
for p in $TB1_PROFILES; do
  for pid in $(pgrep -f -- "--profile $p gateway run" 2>/dev/null); do
    echo "  kill $pid ($p)"; kill "$pid" 2>/dev/null
  done
done

echo "==> burner Hermes dashboard"
for pid in $(pgrep -f "hermes-burner" 2>/dev/null); do
  echo "  kill $pid (burner dashboard)"; kill "$pid" 2>/dev/null
done
[ -f "$TB1_SCRATCH/burner-dashboard.pid" ] && kill "$(cat "$TB1_SCRATCH/burner-dashboard.pid")" 2>/dev/null

echo "==> burner CozyAgents runner and its bot children"
for pid in $(pgrep -f "cozyagents-bin/cozyagents.mjs" 2>/dev/null); do
  echo "  kill $pid"; kill "$pid" 2>/dev/null
done

echo "==> burner gateway container"
docker compose -p "$TB1_COMPOSE_PROJECT" -f "$TB1_COMPOSE_FILE" down

echo "==> left on disk (deliberately): $TB1_HERMES_HOME, $TB1_SCRATCH, volume burner-tb1_burner-tb1-gateway-data"
echo "    remove the simulator with: xcrun simctl delete cozy-burner-iphone17"

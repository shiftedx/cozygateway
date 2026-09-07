#!/usr/bin/env bash
# Manual integration test: does `up.sh` genuinely cold-start the bed? Not run
# in CI -- this needs a real docker daemon, the real Hermes binary, and a
# reachable LAN IP, exactly like the rest of this testbed. See
# .superpowers/sdd/2026-09-05-collaboration-roadmap/followons/F20-testbed-cold-start.md.
#
# Usage: TB1_SCRATCH=<scratch dir> ./cold-start.test.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./env.sh

assert_cold() {
  local label="$1"
  if pgrep -f -- "--profile burnerhermes" >/dev/null 2>&1; then
    echo "FAIL  ($label) a burner Hermes profile gateway is still running" >&2
    pgrep -fl -- "--profile burnerhermes" >&2
    exit 1
  fi
  if lsof -nP -iTCP:"$TB1_DASHBOARD_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "FAIL  ($label) the burner dashboard is still listening on $TB1_DASHBOARD_PORT" >&2
    exit 1
  fi
  if [ -n "$(tb1_runner_pids)" ]; then
    echo "FAIL  ($label) a burner CozyAgents process is still running" >&2
    exit 1
  fi
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "burner-tb1-gateway"; then
    echo "FAIL  ($label) the burner gateway container still exists" >&2
    exit 1
  fi
  echo "PASS  ($label) bed is cold: no burner process or container remains"
}

echo "==> tearing the bed all the way down first (this test proves a COLD start)"
./down.sh || true
sleep 2
assert_cold "before up.sh"

echo "==> ./up.sh (must start the dashboard and profile gateways before gating on /ready)"
./up.sh

status="$(./status.sh)"
echo "$status"
echo "$status" | grep -q "ready: True" || { echo "FAIL  gateway did not report ready" >&2; exit 1; }
echo "$status" | grep -q "attach: 2 configured 2 online" || {
  echo "FAIL  expected attach 2 configured 2 online" >&2; exit 1;
}
echo "PASS  cold start reached ready with both burner profiles attached, first try"

echo "==> ./down.sh"
./down.sh
sleep 2
assert_cold "after down.sh"

echo "ALL PASS"

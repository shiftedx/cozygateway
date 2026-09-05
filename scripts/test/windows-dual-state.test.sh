#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
eval "$(sed -n '/^write_state() {/,/^}/p' "$root/scripts/agent-install.sh")"
DRY_RUN=0
STATE_FILE="$tmp/install-state"
SELECTED=(default)
PROFILE_SPEC=all
HERMES_ROOT=/c/hermes
HERMES_RESOLVED=/c/hermes/bin/hermes.exe
DASHBOARD_PORT=9119
NODE_RESOLVED=/c/node/node.exe
BUNDLE_PATH=/c/gateway/bin/cozygateway.mjs
SUPERVISOR=/c/gateway/local/gateway-supervisor.cjs
WINDOWS_TASK_XML=/c/gateway/local/task.xml
is_windows() { return 0; }
service_action_for() { printf preexisting; }
for prior in cozyagents both; do
  printf 'harness=%s\ncozyagents_home=/c/Users/Example User/.cozyagents\n' "$prior" > "$STATE_FILE"
  write_state
  grep -qx 'harness=both' "$STATE_FILE"
  grep -qx 'cozyagents_home=/c/Users/Example User/.cozyagents' "$STATE_FILE"
  grep -qx 'hermes_root=/c/hermes' "$STATE_FILE"
done
printf 'harness=hermes\n' > "$STATE_FILE"
write_state
grep -qx 'harness=hermes' "$STATE_FILE"
! grep -q '^cozyagents_home=' "$STATE_FILE"
printf 'PASS dual state survives Hermes installation and repair\n'

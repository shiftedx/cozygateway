#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) echo 'SKIP native Windows identity regression'; exit 0 ;; esac
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Exercise production identity loading with real Git Bash path conversion. No
# installer main, service registration, process termination or private state is run.
for function_name in to_posix_path resolve_node load_windows_state_identity preflight_windows_service_ownership; do
  sed -n "/^${function_name}() {/,/^}/p" "$repo_root/scripts/agent-install.sh" >> "$tmp/functions.sh"
done
source "$tmp/functions.sh"
is_windows() { return 0; }
have() { command -v "$1" >/dev/null 2>&1; }
die() { echo "$*" >&2; return 1; }
node_major() { "$1" -p 'process.versions.node.split(".")[0]'; }
GATEWAY_DIR="$tmp/Gateway Home With Spaces"
STATE_FILE="$tmp/install-state"
mkdir -p "$tmp/Private Node With Spaces"
cp "$(command -v node)" "$tmp/Private Node With Spaces/node.exe"
native_node="$(cygpath -w "$tmp/Private Node With Spaces/node.exe")"
expected_node="$(cygpath -u "$native_node")"
native_bundle="$(cygpath -w "$GATEWAY_DIR/bin/cozygateway.mjs")"
expected_bundle="$(cygpath -u "$native_bundle")"
NODE_BIN="$native_node" COZYGATEWAY_NODE="$native_node"
resolved="$(resolve_node)"
test "$resolved" = "$expected_node"
printf 'node_resolved=%s\nbundle_path=%s\n' "$native_node" "$native_bundle" > "$STATE_FILE"
load_windows_state_identity
test "$NODE_RESOLVED" = "$expected_node"
test "$BUNDLE_PATH" = "$expected_bundle"
# The next persisted form remains usable on another load.
printf 'node_resolved=%s\nbundle_path=%s\n' "$NODE_RESOLVED" "$BUNDLE_PATH" > "$STATE_FILE"
load_windows_state_identity
test "$NODE_RESOLVED" = "$expected_node"
for invalid in 'C:node.exe' 'node.exe' '\node.exe' '../node.exe'; do
  printf 'node_resolved=%s\nbundle_path=%s\n' "$invalid" "$expected_bundle" > "$STATE_FILE"
  if load_windows_state_identity; then echo "accepted relative identity: $invalid" >&2; exit 1; fi
done
printf 'node_resolved=%s\nnode_resolved=%s\nbundle_path=%s\n' "$native_node" "$native_node" "$expected_bundle" > "$STATE_FILE"
if load_windows_state_identity; then echo 'accepted duplicate identity' >&2; exit 1; fi
# No native task commands run. Keep the production preflight branch and verify
# that accepting historical path syntax does not skip its registration checks.
printf 'node_resolved=%s\nbundle_path=%s\n' "$native_node" "$native_bundle" > "$STATE_FILE"
WINDOWS_TASK=FixtureOnly DASHBOARD_PORT=8642
schtasks.exe() { printf '<fixture-task />'; }
windows_startup_dir() { printf '%s' "$tmp/absent-startup"; }
load_windows_wrapper_identity() { test "$NODE_RESOLVED" = "$expected_node" && test "$BUNDLE_PATH" = "$expected_bundle"; }
windows_recorded_task_is_owned() { return "$ownership_result"; }
ownership_result=0
preflight_windows_service_ownership
ownership_result=1
if (die() { echo "$*" >&2; exit 1; }; preflight_windows_service_ownership) >"$tmp/refusal.log" 2>&1; then
  echo 'accepted foreign registration after native identity conversion' >&2; exit 1
fi
grep -Fq 'Scheduled Task FixtureOnly is foreign' "$tmp/refusal.log"
echo 'PASS native absolute Node resolution, historical identity reload, canonical reload and relative/duplicate refusals'

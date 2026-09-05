#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for name in xml_unescape build_supervisor_args write_windows_task_xml windows_task_has_single_exec_action windows_task_uses_current_supervisor windows_task_is_directly_owned_by_gateway_home; do
  eval "$(sed -n "/^$name() {/,/^}/p" "$root/scripts/agent-install.sh")"
done
SERVICE_PLATFORM=Windows HARNESS=cozyagents
GATEWAY_DIR='/c/Fixture Gateway' LOCAL_DIR='/c/Fixture Gateway/local'
NODE_RESOLVED='/c/Fixture Gateway/runtime/node/node.exe'
SUPERVISOR="$LOCAL_DIR/gateway-supervisor.cjs"
GATEWAY_ENV="$LOCAL_DIR/gateway.env" BUNDLE_PATH="$GATEWAY_DIR/bin/cozygateway.mjs" CONFIG_JSON="$LOCAL_DIR/cozygateway.config.json"
MAINTENANCE_SOCKET=fixture MAINTENANCE_WORKER="$LOCAL_DIR/maintenance-worker.mjs"
WINDOWS_VBS="$LOCAL_DIR/run-gateway.vbs" WINDOWS_TASK_XML="$tmp/task.xml" WINDOWS_TASK=FixtureOnly
SYSTEMROOT='C:\Windows'
is_windows() { return 0; }
to_windows_path() { printf '%s' "$1"; }
powershell.exe() { case "$*" in *WindowsIdentity*) printf S-1-5-21-123 ;; *) printf 2026-09-05T10:00:00 ;; esac; }
die() { echo "$*" >&2; exit 1; }
write_windows_task_xml
xml="$(iconv -f UTF-16LE -t UTF-8 "$WINDOWS_TASK_XML")"
grep -Fq '<Command>C:\Windows\System32\wscript.exe</Command>' <<<"$xml"
grep -Fq '<Arguments>&quot;/c/Fixture Gateway/local/run-gateway.vbs&quot;</Arguments>' <<<"$xml"
# Check ownership from launcher content when no recorded XML is available yet.
WINDOWS_TASK_XML="$tmp/absent.xml"
fixture_xml="$xml"
schtasks.exe() { printf '%s' "$fixture_xml"; }
windows_startup_entry_is_owned() { [ "$1" = "$WINDOWS_VBS" ]; }
windows_task_uses_current_supervisor
windows_task_is_directly_owned_by_gateway_home
fixture_xml="${fixture_xml/run-gateway.vbs/foreign.vbs}"
! windows_task_uses_current_supervisor
! windows_task_is_directly_owned_by_gateway_home
printf 'PASS hidden task action and strict launcher ownership\n'

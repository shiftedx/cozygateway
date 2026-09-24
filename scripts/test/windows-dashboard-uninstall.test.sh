#!/usr/bin/env bash
# Regression for #272: with the Dashboard owner helper missing, uninstall may only proceed when
# the listener table was actually read and shows nothing on the Dashboard port. A failed
# inspection used to exit 0 and read as "no listener".
#
# Runs the production PowerShell probe under pwsh with a faked Get-NetTCPConnection, so it is
# portable. pwsh is looked for as in powershell-lock-units.sh; COZYGATEWAY_PWSH overrides.
set -euo pipefail
repo_root="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"

if [ -n "${COZYGATEWAY_PWSH:-}" ]; then pwsh_bin="$COZYGATEWAY_PWSH"
elif command -v pwsh >/dev/null 2>&1; then pwsh_bin="$(command -v pwsh)"
elif [ -x "$HOME/.local/bin/pwsh" ]; then pwsh_bin="$HOME/.local/bin/pwsh"
elif command -v powershell >/dev/null 2>&1; then pwsh_bin="$(command -v powershell)"
else
  echo "SKIP  scripts/test/windows-dashboard-uninstall.test.sh did not run: no PowerShell on this host."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
sed -n '/^stop_owned_windows_dashboard_for_uninstall() {/,/^}/p' "$repo_root/scripts/agent-install.sh" > "$tmp/functions.sh"
source "$tmp/functions.sh"
say() { printf '%s\n' "$*"; }
die() { printf 'FAIL  %s\n' "$*"; exit 1; }
SERVICE_PLATFORM=Windows DRY_RUN=0 DASHBOARD_PORT=9119 DASHBOARD_OWNER_PS1="$tmp/absent-dashboard-owner.ps1"

# Stand-in for powershell.exe -Command: prepend the fixture's Get-NetTCPConnection (or none,
# which is what a host without NetTCPIP sees) and run the production script body under pwsh.
powershell.exe() {
  local script="${*: -1}" fake
  case "$FAKE_NETTCPIP" in
    # Assumes a POSIX pwsh host, which has no NetTCPIP module to autoload; on Windows this
    # mode would reach the real inbox cmdlet instead of a missing command.
    none) fake='' ;;
    empty) fake='function Get-NetTCPConnection { [CmdletBinding()] param($State) }' ;;
    other-port) fake='function Get-NetTCPConnection { [CmdletBinding()] param($State) [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 135 } }' ;;
    listener) fake='function Get-NetTCPConnection { [CmdletBinding()] param($State) [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 9119 } }' ;;
    error) fake='function Get-NetTCPConnection { [CmdletBinding()] param($State) Write-Error -Message "CIM query failed" -Category ResourceUnavailable }' ;;
  esac
  "$pwsh_bin" -NoProfile -NonInteractive -Command "$fake
$script"
}

expect() {
  local mode="$1" expected_status="$2" expected_text="$3" precheck="${4:-}" output status
  set +e
  output="$(FAKE_NETTCPIP="$mode" stop_owned_windows_dashboard_for_uninstall 9119 $precheck 2>&1)"
  status=$?
  set -e
  if [ "$status" != "$expected_status" ] || [[ "$output" != *"$expected_text"* ]]; then
    printf 'FAIL  %s: status %s, output: %s\n' "$mode" "$status" "$output" >&2
    exit 1
  fi
}

expect empty 0 'no listener is present on port 9119'
expect other-port 0 'no listener is present on port 9119'
expect listener 1 'may still be owned'
expect error 1 'could not be inspected'
expect none 1 'could not be inspected'
expect listener 1 'Rerun the installer (or --runtime-only) to restore dashboard-owner.ps1'
expect error 1 'Get-NetTCPConnection -State Listen -LocalPort 9119'
# Before removal the Gateway's own Dashboard may still listen, so the precheck refuses only when
# it cannot inspect; the listener decision is made after the Gateway stop.
expect empty 0 '' precheck
expect listener 0 '' precheck
expect error 1 'could not be inspected' precheck
expect none 1 'could not be inspected' precheck

# The precheck runs before the task and Startup entry are deleted; the full decision runs after
# the Gateway stop.
uninstall_body="$(sed -n '/^uninstall() {/,/^}/p' "$repo_root/scripts/agent-install.sh" | sed -n '/hydrate_dashboard_port/,$p')"
line_of() { grep -nF -- "$1" <<<"$uninstall_body" | head -1 | cut -d: -f1; }
precheck_line="$(line_of 'stop_owned_windows_dashboard_for_uninstall "$dashboard_stop_port" precheck')"
delete_line="$(line_of 'schtasks.exe /Delete')"
gateway_line="$(line_of 'stop_owned_windows_gateway 0')"
decision_line="$(grep -nF 'stop_owned_windows_dashboard_for_uninstall "$dashboard_stop_port"' <<<"$uninstall_body" | grep -v precheck | head -1 | cut -d: -f1)"
[ -n "$precheck_line" ] && [ -n "$delete_line" ] && [ -n "$gateway_line" ] && [ -n "$decision_line" ] &&
  [ "$precheck_line" -lt "$delete_line" ] && [ "$gateway_line" -lt "$decision_line" ] ||
  { echo 'FAIL  uninstall must precheck before removal and decide after the Gateway stop' >&2; exit 1; }
echo 'PASS missing Dashboard owner helper fails closed with recovery guidance; inspection failure refuses before removal'

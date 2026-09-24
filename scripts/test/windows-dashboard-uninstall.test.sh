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
  local mode="$1" expected_status="$2" expected_text="$3" output status
  set +e
  output="$(FAKE_NETTCPIP="$mode" stop_owned_windows_dashboard_for_uninstall 2>&1)"
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
echo 'PASS missing Dashboard owner helper fails closed when listeners cannot be inspected'

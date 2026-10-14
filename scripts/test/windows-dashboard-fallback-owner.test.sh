#!/usr/bin/env bash
# Regression for the leaked Windows fallback Dashboard: when a foreign Dashboard holds the preferred
# port, the supervisor starts its private Dashboard on a fallback port with --isolated. Uninstall
# must find that port and the owner helper must call that exact process Owned, or uninstall leaves
# it running.
#
# Port resolution is plain bash. The ownership half runs the production classifier under pwsh
# (looked for as in powershell-lock-units.sh; COZYGATEWAY_PWSH overrides) and SKIPs without it.
set -euo pipefail
repo_root="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"
installer="$repo_root/scripts/agent-install.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

sed -n '/^hydrate_dashboard_port() {/,/^}/p' "$installer" > "$tmp/functions.sh"
source "$tmp/functions.sh"
die() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
CONFIG_JSON="$tmp/cozygateway.config.json" DASHBOARD_PORT_STATE="$tmp/dashboard-port"
NODE_RESOLVED="$(command -v node)" DASHBOARD_PORT_EXPLICIT=0

expect_port() {
  local expected="$1" label="$2"
  DASHBOARD_PORT=9119
  hydrate_dashboard_port
  [ "$DASHBOARD_PORT" = "$expected" ] || { printf 'FAIL  %s: resolved %s, expected %s\n' "$label" "$DASHBOARD_PORT" "$expected" >&2; exit 1; }
}
# The supervisor persists the fallback in the config endpoint first, then the port file.
printf '{"hermesEndpoints":[{"id":"default","url":"ws://127.0.0.1:9121/api/ws"}]}\n' > "$CONFIG_JSON"
printf '9122\n' > "$DASHBOARD_PORT_STATE"
expect_port 9121 'config endpoint wins'
rm -f "$CONFIG_JSON"
expect_port 9122 'port file without config'
printf '{"hermesEndpoints":[{"id":"default","url":"ws://127.0.0.1:9121/api/ws"}]}\n' > "$CONFIG_JSON"
NODE_RESOLVED="$tmp/removed-node" expect_port 9122 'port file when the recorded Node runtime is gone'
rm -f "$DASHBOARD_PORT_STATE" "$CONFIG_JSON"
expect_port 9119 'install-state port when nothing moved it'

# uninstall() must stop the Dashboard on the resolved port, while DASHBOARD_PORT keeps the
# install-state value the supervisor wrapper identity was written with.
uninstall_body="$(sed -n '/^uninstall() {/,/^}/p' "$installer")"
grep -Fq 'dashboard_stop_port="$( (hydrate_dashboard_port && printf' <<<"$uninstall_body" ||
  { echo 'FAIL  uninstall must resolve the Dashboard stop port without changing DASHBOARD_PORT' >&2; exit 1; }
stops="$(grep -c 'stop_owned_windows_dashboard_for_uninstall' <<<"$uninstall_body")"
[ "$stops" -ge 1 ] && [ "$(grep -c 'stop_owned_windows_dashboard_for_uninstall "$dashboard_stop_port"' <<<"$uninstall_body")" = "$stops" ] ||
  { echo 'FAIL  uninstall must stop the Dashboard on the resolved port' >&2; exit 1; }
echo 'PASS uninstall resolves the private Dashboard port from config, then the port file'

if [ -n "${COZYGATEWAY_PWSH:-}" ]; then pwsh_bin="$COZYGATEWAY_PWSH"
elif command -v pwsh >/dev/null 2>&1; then pwsh_bin="$(command -v pwsh)"
elif [ -x "$HOME/.local/bin/pwsh" ]; then pwsh_bin="$HOME/.local/bin/pwsh"
elif command -v powershell >/dev/null 2>&1; then pwsh_bin="$(command -v powershell)"
else
  echo "SKIP  fallback Dashboard ownership half did not run: no PowerShell on this host."
  exit 0
fi

# Only the pure classifier functions are loaded; the helper's Windows-native setup is not.
cat > "$tmp/owner.ps1" <<'POWERSHELL'
param([string] $Installer, [string] $Root)
$ErrorActionPreference = 'Stop'
$block = [regex]::Match([IO.File]::ReadAllText($Installer), '(?s)# COZYGATEWAY_DASHBOARD_OWNER_BEGIN\r?\n(.*?)# COZYGATEWAY_DASHBOARD_OWNER_END')
if (-not $block.Success) { throw 'embedded Dashboard ownership helper was not found' }
$ast = [Management.Automation.Language.Parser]::ParseInput($block.Groups[1].Value, [ref]$null, [ref]$null)
foreach ($name in 'Get-CozyDashboardProfileEvidence', 'Find-CozyDashboardSubcommand', 'Test-CozyDashboardOwner') {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if ($null -eq $function) { throw "missing $name" }
    . ([scriptblock]::Create($function.Extent.Text))
}
$launcher = [IO.Path]::Combine($Root, 'bin', 'hermes.exe')
# The supervisor's exact fallback argv (gateway-supervisor.cjs start(port, true) on Windows).
$argv = 'dashboard -p default --host 127.0.0.1 --port 9121 --no-open --skip-build --isolated'
$process = [pscustomobject]@{ ProcessId = 4242; ParentProcessId = 0; ExecutablePath = $launcher; CommandLine = ('"{0}" {1}' -f $launcher, $argv) }
$resolver = { param([int] $Id) $null }
$fallback = Test-CozyDashboardOwner -Process $process -ExpectedRoot $Root -ExpectedHermes $launcher -ExpectedLauncher $launcher -ExpectedPort 9121 -ResolveProcess $resolver
$preferred = Test-CozyDashboardOwner -Process $process -ExpectedRoot $Root -ExpectedHermes $launcher -ExpectedLauncher $launcher -ExpectedPort 9119 -ResolveProcess $resolver
if ($fallback -ne 'Owned') { throw "fallback Dashboard on its own port was $fallback, expected Owned" }
if ($preferred -ne 'Foreign') { throw "fallback Dashboard checked against another port was $preferred, expected Foreign" }
POWERSHELL
"$pwsh_bin" -NoProfile -NonInteractive -File "$tmp/owner.ps1" "$installer" "$tmp/Hermes Root"
echo 'PASS owner helper owns the supervisor fallback Dashboard only on its exact port'

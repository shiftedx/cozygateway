#!/usr/bin/env bash
# Run scripts/test/bootstrap-lock-units.test.ps1: the portable half of the bootstrap lock suite.
#
# The rest of the PowerShell installer suites are Windows-host steps (scripts in
# `test:installer:windows`). This one is not: it touches only the lock's own functions, so it runs
# wherever a pwsh does, including the Mac a release is cut from. The bug it pins -- an interrupted
# install holding the lock for the life of the shell -- cost a user two days of retries that
# looked like they did nothing.
#
# pwsh is looked for on PATH then at ~/.local/bin/pwsh; COZYGATEWAY_PWSH overrides both.
set -euo pipefail

root="$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)"

if [ -n "${COZYGATEWAY_PWSH:-}" ]; then pwsh_bin="$COZYGATEWAY_PWSH"
elif command -v pwsh >/dev/null 2>&1; then pwsh_bin="$(command -v pwsh)"
elif [ -x "$HOME/.local/bin/pwsh" ]; then pwsh_bin="$HOME/.local/bin/pwsh"
elif command -v powershell >/dev/null 2>&1; then pwsh_bin="$(command -v powershell)"
else
  echo "SKIP  scripts/test/bootstrap-lock-units.test.ps1 did not run: no PowerShell on this host."
  exit 0
fi

echo "==> the portable bootstrap lock suite ($pwsh_bin)"
exec "$pwsh_bin" -NoProfile -File "$root/scripts/test/bootstrap-lock-units.test.ps1"

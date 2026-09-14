#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -n "${COZYGATEWAY_PWSH:-}" ]; then pwsh_bin="$COZYGATEWAY_PWSH"
elif command -v pwsh >/dev/null 2>&1; then pwsh_bin="$(command -v pwsh)"
elif [ -x "$HOME/.local/bin/pwsh" ]; then pwsh_bin="$HOME/.local/bin/pwsh"
else echo 'SKIP  uninstall PowerShell units: PowerShell is unavailable'; exit 0
fi
exec "$pwsh_bin" -NoProfile -File "$root/scripts/test/uninstall-units.test.ps1"

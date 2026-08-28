#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cozy-provisioner-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
mkdir -p "$HOME/.local/bin" "$HOME/Library/LaunchAgents"
printf '#!/bin/sh\nexit 0\n' > "$HOME/.local/bin/hermes"
chmod +x "$HOME/.local/bin/hermes"
export PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

"$ROOT/scripts/install-bot-provisioner.sh" --stage-dir "$TMP/stage" --no-load >/dev/null
PLIST="$HOME/Library/LaunchAgents/ai.cozylabs.bot-provisioner.plist"
/usr/bin/plutil -lint "$PLIST" >/dev/null
grep -Fq "<string>$HOME/.local/bin/hermes</string>" "$PLIST"
grep -Fq "<string>$HOME/.local/bin:/opt/homebrew/bin" "$PLIST"
printf 'bot provisioner installer: ok\n'

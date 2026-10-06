#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for name in load_windows_legacy_wrapper_identity load_windows_wrapper_identity; do
  sed -n "/^${name}() {/,/^}/p" "$repo_root/scripts/agent-install.sh" >> "$tmp/functions.sh"
done
source "$tmp/functions.sh"
to_posix_path() { printf '%s' "$1"; }
resolve_node() { printf '%s' "$NODE_RESOLVED"; }
GATEWAY_ENV="$tmp/gateway.env" DASHBOARD_ENV="$tmp/dashboard.env" HERMES_ROOT="$tmp/hermes"
HERMES_RESOLVED="$tmp/hermes/hermes.exe" DASHBOARD_OWNER_PS1="$tmp/dashboard-owner.ps1"
NODE_RESOLVED="$tmp/node.exe" BUNDLE_PATH="$tmp/cozygateway.mjs" CONFIG_JSON="$tmp/config.json"
WRAPPER="$tmp/run.sh" SUPERVISOR="$tmp/absent.cjs" DASHBOARD_PORT=9119 HARNESS=hermes
mkdir -p "$HERMES_ROOT/bin"
for file in "$NODE_RESOLVED" "$GATEWAY_ENV" "$DASHBOARD_ENV" "$HERMES_RESOLVED" "$HERMES_ROOT/bin/hermes.exe" "$DASHBOARD_OWNER_PS1" "$BUNDLE_PATH" "$CONFIG_JSON"; do touch "$file"; done
write_legacy() {
  printf '#!/usr/bin/env bash\nset -euo pipefail\nexec "%s" - "%s" "%s" "%s" "%s" "%s" "%s" "%s" "%s" "%s" <<\x27NODE\x27\n' "$NODE_RESOLVED" "$GATEWAY_ENV" "$DASHBOARD_ENV" "$HERMES_ROOT" "$HERMES_RESOLVED" "$HERMES_ROOT/bin/hermes.exe" "$DASHBOARD_OWNER_PS1" "$DASHBOARD_PORT" "$BUNDLE_PATH" "$CONFIG_JSON" > "$WRAPPER"
  tr -d '\r' < "$repo_root/scripts/test/fixtures/windows-v0.6.5-supervisor.js" >> "$WRAPPER"
  printf 'NODE\n' >> "$WRAPPER"
}
write_legacy
load_windows_wrapper_identity
test "$WINDOWS_OWNED_LEGACY_INLINE" = 1
test "$WINDOWS_OWNED_NODE_RESOLVED" = "$NODE_RESOLVED"
printf '\nprocess.exit(99);\n' >> "$WRAPPER"
if load_windows_wrapper_identity; then echo 'accepted modified legacy body'; exit 1; fi
write_legacy
sed 's/exec "/exec "foreign-/' "$WRAPPER" > "$tmp/tampered"
mv "$tmp/tampered" "$WRAPPER"
if load_windows_wrapper_identity; then echo 'accepted foreign legacy runtime'; exit 1; fi
echo 'PASS exact released legacy wrapper identity and tampering refusals'
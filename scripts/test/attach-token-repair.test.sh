#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
agent_installer="${AGENT_INSTALLER_UNDER_TEST:-$repo_root/scripts/agent-install.sh}"
env_block="$(awk '
  /^env_put\(\) \{/ { capture=1 }
  /^service_action_for\(\) \{/ { exit }
  capture { print }
' "$agent_installer")"
eval "$env_block"

local_app_data="${LOCALAPPDATA-}"
temp_root="${local_app_data//\\//}/Temp"
[ -n "${LOCALAPPDATA:-}" ] || temp_root="${TMPDIR:-/tmp}"
tmp="$(mktemp -d "$temp_root/cozygateway-token-repair.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

NODE_RESOLVED="$(command -v node)"
DRY_RUN=0
HERMES_ROOT="$tmp/hermes"
LOCAL_DIR="$tmp/gateway/local"
GATEWAY_ENV="$LOCAL_DIR/gateway.env"
DASHBOARD_ENV="$LOCAL_DIR/dashboard.env"
ENV_OWNER_KEY=COZYGATEWAY_INSTALLER_OWNER
ENV_OWNER_VALUE=cozylabs-v1
SELECTED=(default copied unique)
TOKENS=()
TOKEN_ENVS=()
mkdir -p "$HERMES_ROOT/profiles/copied" "$HERMES_ROOT/profiles/unique" "$LOCAL_DIR"

die() { printf 'FAIL  %s\n' "$*" >&2; return 1; }
have() { command -v "$1" >/dev/null 2>&1; }
is_windows() { return 1; }
gateway_origin() { printf 'http://127.0.0.1:8787'; }
profile_home() { if [ "$1" = default ]; then printf '%s' "$HERMES_ROOT"; else printf '%s/profiles/%s' "$HERMES_ROOT" "$1"; fi; }

copied_token="$(printf 'a%.0s' {1..48})"
unique_token="$(printf 'b%.0s' {1..48})"
for profile in default copied unique; do
  if [ "$profile" = default ]; then
    profile_env="$HERMES_ROOT/.env"
  else
    profile_env="$HERMES_ROOT/profiles/$profile/.env"
  fi
  token="$unique_token"
  [ "$profile" = unique ] || token="$copied_token"
  printf '%s\n' \
    "$ENV_OWNER_KEY=$ENV_OWNER_VALUE" \
    "COZYGATEWAY_TOKEN=$token" \
    > "$profile_env"
done

write_gateway_env

default_after="$(env_get "$HERMES_ROOT/.env" COZYGATEWAY_TOKEN)"
copied_after="$(env_get "$HERMES_ROOT/profiles/copied/.env" COZYGATEWAY_TOKEN)"
unique_after="$(env_get "$HERMES_ROOT/profiles/unique/.env" COZYGATEWAY_TOKEN)"

[ "$default_after" = "$copied_token" ] || { echo 'the first valid existing profile token must remain stable' >&2; exit 1; }
[ "$unique_after" = "$unique_token" ] || { echo 'an already-unique valid profile token must remain stable' >&2; exit 1; }
[ "$copied_after" != "$copied_token" ] || { echo 'a copied duplicate profile token must be rotated' >&2; exit 1; }
[ "$default_after" != "$copied_after" ]
[ "$default_after" != "$unique_after" ]
[ "$copied_after" != "$unique_after" ]
for token in "$default_after" "$copied_after" "$unique_after"; do safe_secret "$token"; done

for profile in default copied unique; do
  if [ "$profile" = default ]; then
    profile_env="$HERMES_ROOT/.env"
  else
    profile_env="$HERMES_ROOT/profiles/$profile/.env"
  fi
  env_name="$(token_env_name "$profile")"
  [ "$(env_get "$GATEWAY_ENV" "$env_name")" = "$(env_get "$profile_env" COZYGATEWAY_TOKEN)" ] || {
    echo "profile $profile and gateway token environments must agree" >&2
    exit 1
  }
done

TOKENS=()
TOKEN_ENVS=()
write_gateway_env
[ "$default_after" = "$(env_get "$HERMES_ROOT/.env" COZYGATEWAY_TOKEN)" ]
[ "$copied_after" = "$(env_get "$HERMES_ROOT/profiles/copied/.env" COZYGATEWAY_TOKEN)" ]
[ "$unique_after" = "$(env_get "$HERMES_ROOT/profiles/unique/.env" COZYGATEWAY_TOKEN)" ]

TOKENS=("$copied_token")
new_token() { printf '%s' "$copied_token"; }
if profile_token '' >/dev/null 2>&1; then
  echo 'token generation must fail closed when it cannot produce a distinct value' >&2
  exit 1
fi

printf 'attach token repair tests passed\n'

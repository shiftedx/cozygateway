#!/usr/bin/env bash
# Exercises the versioned local-runtime rollback boundary without a real service
# manager, download, installer replay, or user-home mutation.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d "$HOME/.cozygateway-runtime-rollback.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

export COZYGATEWAY_HOME="$tmp/gateway"
export COZYGATEWAY_SERVICE_PLATFORM=Linux
export XDG_CONFIG_HOME="$tmp/xdg"
functions_file="$tmp/install-functions.sh"
sed '/^main "\$@"$/d' "$repo_root/scripts/install.sh" > "$functions_file"
# shellcheck disable=SC1090
source "$functions_file"
canonical_home_dir
asset_dir="$HOME_DIR/bin"
backup_dir="$HOME_DIR/.bootstrap-previous"
journal="$HOME_DIR/.bootstrap-transaction"
service_unit="$XDG_CONFIG_HOME/systemd/user/cozygateway.service"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "expected absence: $1"; }
expect_contents() { [ "$(cat "$1")" = "$2" ] || fail "unexpected contents in $1"; }
expect_mode() { [ "$(bootstrap_path_mode "$1")" = "$2" ] || fail "unexpected mode on $1"; }

fake_bin="$tmp/fake-bin"
manager_log="$tmp/systemctl.log"
mkdir -p "$fake_bin"
cat > "$fake_bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${COZYGATEWAY_TEST_SYSTEMCTL_LOG:?}"
SYSTEMCTL
chmod 700 "$fake_bin/systemctl"
export PATH="$fake_bin:$PATH"
export COZYGATEWAY_TEST_SYSTEMCTL_LOG="$manager_log"

write_assets() {
  local label="$1" asset name
  mkdir -p "$asset_dir"
  for asset in "${BOOTSTRAP_ASSETS[@]}"; do
    for name in "$asset" "$asset.sha256"; do
      printf '%s:%s\n' "$label" "$name" > "$asset_dir/$name"
    done
  done
}
write_owned_wrapper() {
  mkdir -p "$HOME_DIR/local"
  cat > "$HOME_DIR/local/run-gateway.sh" <<EOF_WRAPPER
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/node $asset_dir/gateway-supervisor.cjs
EOF_WRAPPER
  chmod 700 "$HOME_DIR/local/run-gateway.sh"
}
write_owned_unit() {
  mkdir -p "$(dirname "$service_unit")"
  printf '[Service]\nExecStart=/usr/bin/node %s\n' "$asset_dir/gateway-supervisor.cjs" > "$service_unit"
  chmod 600 "$service_unit"
}
reset_fixture() {
  rm -rf "$HOME_DIR" "$XDG_CONFIG_HOME"
  : > "$manager_log"
  write_assets old
  write_owned_wrapper
  write_owned_unit
}

# Every fixed runtime file gets either a prior regular file or an explicit
# absence. That makes a late installer failure prove both restoration modes.
reset_fixture
index=0
for item in "${BOOTSTRAP_RUNTIME_FILES[@]}"; do
  path="$(bootstrap_runtime_path "$item")"
  case "$item" in local/run-gateway.sh) index=$((index + 1)); continue ;; esac
  if [ $((index % 2)) -eq 0 ]; then
    mkdir -p "$(dirname "$path")"
    printf 'old:%s\n' "$item" > "$path"
    chmod 600 "$path"
  fi
  index=$((index + 1))
done
# The wrapper and supervisor are needed for owned registration validation.
printf 'old:local/gateway-supervisor.cjs\n' > "$HOME_DIR/local/gateway-supervisor.cjs"
chmod 700 "$HOME_DIR/local/gateway-supervisor.cjs"
write_owned_wrapper

# These are deliberately outside the transaction contract: the live database,
# logs, Hermes bindings, and CozyAgents state must never be restored or removed.
mkdir -p "$HOME_DIR/local" "$tmp/hermes/profile" "$tmp/agents"
printf 'sqlite-before\n' > "$HOME_DIR/local/cozygateway.sqlite"
printf 'log-before\n' > "$HOME_DIR/local/cozygateway.log"
printf 'hermes-before\n' > "$tmp/hermes/profile/.env"
printf 'agents-before\n' > "$tmp/agents/install.json"

begin_bootstrap_transaction "$asset_dir"
write_assets fresh
# Replace present runtime files and create every previously absent one.
for item in "${BOOTSTRAP_RUNTIME_FILES[@]}"; do
  path="$(bootstrap_runtime_path "$item")"
  mkdir -p "$(dirname "$path")"
  printf 'fresh:%s\n' "$item" > "$path"
  chmod 644 "$path"
done
cat > "$HOME_DIR/local/run-gateway.sh" <<EOF_NEW_WRAPPER
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/new-node $asset_dir/gateway-supervisor.cjs
EOF_NEW_WRAPPER
chmod 700 "$HOME_DIR/local/run-gateway.sh"
printf '[Service]\nExecStart=/usr/bin/new-node %s\n' "$asset_dir/gateway-supervisor.cjs" > "$service_unit"
chmod 644 "$service_unit"
printf 'sqlite-after\n' > "$HOME_DIR/local/cozygateway.sqlite"
printf 'log-after\n' > "$HOME_DIR/local/cozygateway.log"
printf 'hermes-after\n' > "$tmp/hermes/profile/.env"
printf 'agents-after\n' > "$tmp/agents/install.json"
# A historical installer must not be executed by recovery.
cat > "$asset_dir/agent-install.sh" <<'OLD_INSTALLER'
#!/usr/bin/env bash
printf 'replayed\n' > "${COZYGATEWAY_TEST_OLD_INSTALLER_LOG:?}"
exit 91
OLD_INSTALLER
chmod 700 "$asset_dir/agent-install.sh"
old_installer_log="$tmp/old-installer.log"
export COZYGATEWAY_TEST_OLD_INSTALLER_LOG="$old_installer_log"

recover_bootstrap_transaction "$asset_dir"
expect_absent "$old_installer_log"
expect_contents "$asset_dir/cozygateway.mjs" 'old:cozygateway.mjs'
expect_contents "$HOME_DIR/local/run-gateway.sh" "$(printf '#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node %s' "$asset_dir/gateway-supervisor.cjs")"
expect_mode "$HOME_DIR/local/run-gateway.sh" 700
expect_contents "$service_unit" "$(printf '[Service]\nExecStart=/usr/bin/node %s' "$asset_dir/gateway-supervisor.cjs")"
expect_mode "$service_unit" 600
grep -Fqx -- '--user daemon-reload' "$manager_log" || fail 'recovery did not reload the restored owned service'
grep -Fqx -- '--user restart cozygateway.service' "$manager_log" || fail 'recovery did not restart the restored owned service'
index=0
for item in "${BOOTSTRAP_RUNTIME_FILES[@]}"; do
  path="$(bootstrap_runtime_path "$item")"
  case "$item" in local/run-gateway.sh|local/gateway-supervisor.cjs) index=$((index + 1)); continue ;; esac
  if [ $((index % 2)) -eq 0 ]; then
    expect_contents "$path" "old:$item"
    expect_mode "$path" 600
  else
    expect_absent "$path"
  fi
  index=$((index + 1))
done
expect_contents "$HOME_DIR/local/cozygateway.sqlite" 'sqlite-after'
expect_contents "$HOME_DIR/local/cozygateway.log" 'log-after'
expect_contents "$tmp/hermes/profile/.env" 'hermes-after'
expect_contents "$tmp/agents/install.json" 'agents-after'
expect_absent "$journal"
expect_absent "$backup_dir"

# Existing binary-only journals predate version=2. They recover only their
# recorded assets and leave newer local runtime state untouched.
reset_fixture
write_assets prior
mkdir -p "$backup_dir"
: > "$backup_dir/inventory"
for asset in "${BOOTSTRAP_ASSETS[@]}"; do
  for name in "$asset" "$asset.sha256"; do
    printf 'present:%s\n' "$name" >> "$backup_dir/inventory"
    cp "$asset_dir/$name" "$backup_dir/$name"
  done
done
printf 'intent=replace-release-assets\n' > "$journal"
write_assets replacement
printf 'legacy-local-sentinel\n' > "$HOME_DIR/local/gateway.env"
recover_bootstrap_transaction "$asset_dir"
expect_contents "$asset_dir/cozygateway.mjs" 'prior:cozygateway.mjs'
expect_contents "$HOME_DIR/local/gateway.env" 'legacy-local-sentinel'
expect_absent "$journal"
expect_absent "$backup_dir"

printf 'bootstrap runtime rollback tests passed\n'

#!/usr/bin/env bash
# Exercises the bootstrap recovery functions directly.  The real main flow is
# deliberately not invoked: it would download release assets and register a
# service.  HOME_DIR is an isolated temporary path; HOME is never reassigned.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-bootstrap-transaction.XXXXXX")"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

export COZYGATEWAY_HOME="$tmp/gateway"
# Load the real transaction helpers without invoking install.sh's main.
functions_file="$tmp/install-functions.sh"
sed '/^main "\$@"$/d' "$repo_root/scripts/install.sh" > "$functions_file"
# shellcheck disable=SC1090
source "$functions_file"
canonical_home_dir
export COZYGATEWAY_SERVICE_PLATFORM=Linux
export XDG_CONFIG_HOME="$(cd -P "$tmp" && pwd)/xdg"
asset_dir="$HOME_DIR/bin"
backup_dir="$HOME_DIR/.bootstrap-previous"
journal="$HOME_DIR/.bootstrap-transaction"
restore_log="$tmp/service-restores"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_file() { [ -f "$1" ] || fail "expected file: $1"; }
expect_absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "expected absence: $1"; }
expect_contents() { [ "$(cat "$1")" = "$2" ] || fail "unexpected contents in $1"; }

# Recovery restarts only an already-owned registration. Keep that observable
# while avoiding a real service manager in the transaction tests below.
real_restart_existing_owned_service="$(declare -f restart_existing_owned_service)"
restart_existing_owned_service() {
  printf 'restored\n' >> "$restore_log"
}

write_asset_pair() {
  local directory="$1" label="$2" asset name
  for asset in "${BOOTSTRAP_ASSETS[@]}"; do
    for name in "$asset" "$asset.sha256"; do
      printf '%s:%s\n' "$label" "$name" > "$directory/$name"
    done
  done
}

reset_fixture() {
  rm -rf "$HOME_DIR"
  mkdir -p "$asset_dir"
  : > "$restore_log"
}

write_exact_inventory() {
  : > "$backup_dir/inventory"
  local asset name
  for asset in "${BOOTSTRAP_ASSETS[@]}"; do
    for name in "$asset" "$asset.sha256"; do
      printf 'present:%s\n' "$name" >> "$backup_dir/inventory"
    done
  done
}

make_invalid_fixture() {
  reset_fixture
  mkdir -p "$backup_dir"
  write_asset_pair "$asset_dir" live
  write_asset_pair "$backup_dir" prior
  printf 'intent=replace-release-assets\n' > "$journal"
}

expect_refusal_without_mutation() {
  local description="$1" output
  if output="$(recover_bootstrap_transaction "$asset_dir" 2>&1)"; then
    fail "$description unexpectedly recovered"
  fi
  expect_contents "$asset_dir/cozygateway.mjs" 'live:cozygateway.mjs'
  expect_contents "$asset_dir/cozygateway.mjs.sha256" 'live:cozygateway.mjs.sha256'
  expect_file "$journal"
  [ ! -s "$restore_log" ] || fail "$description restarted a service before refusing"
}

# A normal interrupted promotion rolls every asset back, including a newly
# introduced asset that did not exist in the old release.  A second recovery
# sees no journal and is a no-op.
reset_fixture
write_asset_pair "$asset_dir" prior
rm -f "$asset_dir/gateway-supervisor.cjs" "$asset_dir/gateway-supervisor.cjs.sha256"
begin_bootstrap_transaction "$asset_dir"
write_asset_pair "$asset_dir" fresh
recover_bootstrap_transaction "$asset_dir"
expect_contents "$asset_dir/cozygateway.mjs" 'prior:cozygateway.mjs'
expect_absent "$asset_dir/gateway-supervisor.cjs"
expect_absent "$asset_dir/gateway-supervisor.cjs.sha256"
expect_absent "$journal"
expect_absent "$backup_dir"
[ ! -s "$restore_log" ] || fail "fresh recovery restarted a service"
recover_bootstrap_transaction "$asset_dir"
expect_contents "$asset_dir/cozygateway.mjs" 'prior:cozygateway.mjs'
[ ! -s "$restore_log" ] || fail "idempotent fresh recovery restarted a service"

# A completed/recovered marker may survive after its backup was already
# removed.  Both are cleanup-only states and must remain idempotent.
reset_fixture
printf 'commit=installer-succeeded\n' > "$journal"
recover_bootstrap_transaction "$asset_dir"
expect_absent "$journal"
printf 'restored=previous-release\n' > "$journal"
recover_bootstrap_transaction "$asset_dir"
expect_absent "$journal"

# Every bad inventory must fail before it copies the first otherwise-valid
# entry.  These cases cover malformed records, incomplete snapshots, repeated
# paths, and traversal attempts.
make_invalid_fixture
printf 'present:cozygateway.mjs\nnot-an-inventory-record\n' > "$backup_dir/inventory"
expect_refusal_without_mutation 'malformed inventory'

make_invalid_fixture
printf 'present:cozygateway.mjs\n' > "$backup_dir/inventory"
expect_refusal_without_mutation 'incomplete inventory'

make_invalid_fixture
write_exact_inventory
printf 'present:cozygateway.mjs\n' >> "$backup_dir/inventory"
expect_refusal_without_mutation 'duplicate inventory entry'

make_invalid_fixture
printf 'present:cozygateway.mjs\npresent:../live-sentinel\n' > "$backup_dir/inventory"
expect_refusal_without_mutation 'path traversal inventory entry'

# Neither transaction metadata file can be supplied through a symlink.  The
# live assets remain exactly as they were when recovery refuses it.
make_invalid_fixture
rm -f "$journal"
printf 'intent=replace-release-assets\n' > "$tmp/outside-journal"
ln -s "$tmp/outside-journal" "$journal"
expect_refusal_without_mutation 'symlinked transaction marker'

make_invalid_fixture
write_exact_inventory
mv "$backup_dir/inventory" "$tmp/outside-inventory"
ln -s "$tmp/outside-inventory" "$backup_dir/inventory"
expect_refusal_without_mutation 'symlinked transaction inventory'

# A historical installer that does not recognize options introduced by a later
# bootstrap must never run during recovery. Recovery touches only its journal,
# release files, and the owned service manager.
reset_fixture
write_asset_pair "$asset_dir" prior
cat > "$asset_dir/agent-install.sh" <<'OLD_INSTALLER'
#!/usr/bin/env bash
printf '%s\n' "$*" > "${COZYGATEWAY_TEST_OLD_INSTALLER_LOG:?}"
exit 91
OLD_INSTALLER
chmod 700 "$asset_dir/agent-install.sh"
mkdir -p "$HOME_DIR/local"
printf 'preserve-me\n' > "$HOME_DIR/local/gateway.env"
begin_bootstrap_transaction "$asset_dir"
write_asset_pair "$asset_dir" fresh
old_installer_log="$tmp/old-installer.log"
COZYGATEWAY_TEST_OLD_INSTALLER_LOG="$old_installer_log" recover_bootstrap_transaction "$asset_dir" --no-qr
expect_absent "$old_installer_log"
expect_contents "$HOME_DIR/local/gateway.env" 'preserve-me'
expect_contents "$asset_dir/cozygateway.mjs" 'prior:cozygateway.mjs'

# A colliding systemd registration must fail closed. In particular, recovery
# must not invoke systemctl or replay the restored installer to replace it.
eval "$real_restart_existing_owned_service"
reset_fixture
write_asset_pair "$asset_dir" prior
mkdir -p "$HOME_DIR/local"
printf 'harness=hermes\n' > "$HOME_DIR/local/install-state"
begin_bootstrap_transaction "$asset_dir"
write_asset_pair "$asset_dir" fresh
fake_bin="$tmp/fake-bin"; mkdir -p "$fake_bin"
manager_log="$tmp/service-manager.log"
cat > "$fake_bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${COZYGATEWAY_TEST_SERVICE_LOG:?}"
SYSTEMCTL
chmod 700 "$fake_bin/systemctl"
foreign_xdg="$(cd -P "$tmp" && pwd)/foreign-xdg"; foreign_unit="$foreign_xdg/systemd/user/cozygateway.service"
mkdir -p "$(dirname "$foreign_unit")" "$HOME_DIR/local"
printf '[Service]\nExecStart=/usr/bin/foreign\n' > "$foreign_unit"
printf '#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node %q\n' "$asset_dir/gateway-supervisor.cjs" > "$HOME_DIR/local/run-gateway.sh"
chmod 700 "$HOME_DIR/local/run-gateway.sh"
if (PATH="$fake_bin:$PATH" XDG_CONFIG_HOME="$foreign_xdg" COZYGATEWAY_SERVICE_PLATFORM=Linux COZYGATEWAY_TEST_SERVICE_LOG="$manager_log" recover_bootstrap_transaction "$asset_dir"); then
  fail 'foreign service registration unexpectedly recovered'
fi
expect_file "$journal"
expect_absent "$manager_log"
expect_contents "$foreign_unit" $'[Service]\nExecStart=/usr/bin/foreign'

# A failed update from an installed Gateway may create a new owned service even
# when the previous install had none. Recovery unregisters it rather than
# leaving a login service for bytes it just removed.
reset_fixture
write_asset_pair "$asset_dir" prior
mkdir -p "$HOME_DIR/local"
printf 'harness=hermes\n' > "$HOME_DIR/local/install-state"
begin_bootstrap_transaction "$asset_dir"
write_asset_pair "$asset_dir" fresh
mkdir -p "$XDG_CONFIG_HOME/systemd/user"
printf '#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node %q\n' "$asset_dir/gateway-supervisor.cjs" > "$HOME_DIR/local/run-gateway.sh"
printf '[Service]\nExecStart=/usr/bin/node %s\n' "$asset_dir/gateway-supervisor.cjs" > "$XDG_CONFIG_HOME/systemd/user/cozygateway.service"
: > "$manager_log"
PATH="$fake_bin:$PATH" COZYGATEWAY_TEST_SERVICE_LOG="$manager_log" recover_bootstrap_transaction "$asset_dir"
expect_absent "$XDG_CONFIG_HOME/systemd/user/cozygateway.service"
grep -Fqx -- '--user disable --now cozygateway.service' "$manager_log" || fail 'new owned service was not unregistered'
grep -Fqx -- '--user daemon-reload' "$manager_log" || fail 'manager was not reloaded after unregistering service'

# Metadata can be missing after an interrupted legacy install while its owned
# service already exists. The registration is still a preimage and survives.
reset_fixture
write_asset_pair "$asset_dir" prior
mkdir -p "$HOME_DIR/local" "$XDG_CONFIG_HOME/systemd/user"
printf '#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node %q\n' "$asset_dir/gateway-supervisor.cjs" > "$HOME_DIR/local/run-gateway.sh"
chmod 700 "$HOME_DIR/local/run-gateway.sh"
printf '[Service]\nExecStart=/bin/bash %s\n' "$HOME_DIR/local/run-gateway.sh" > "$XDG_CONFIG_HOME/systemd/user/cozygateway.service"
begin_bootstrap_transaction "$asset_dir"
write_asset_pair "$asset_dir" fresh
printf '#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/new-node %q\n' "$asset_dir/gateway-supervisor.cjs" > "$HOME_DIR/local/run-gateway.sh"
printf '[Service]\nExecStart=/bin/bash %s\n' "$HOME_DIR/local/run-gateway.sh" > "$XDG_CONFIG_HOME/systemd/user/cozygateway.service"
: > "$manager_log"
PATH="$fake_bin:$PATH" COZYGATEWAY_TEST_SERVICE_LOG="$manager_log" recover_bootstrap_transaction "$asset_dir"
expect_contents "$XDG_CONFIG_HOME/systemd/user/cozygateway.service" "$(printf '[Service]\nExecStart=/bin/bash %s' "$HOME_DIR/local/run-gateway.sh")"
grep -Fqx -- '--user restart cozygateway.service' "$manager_log" || fail 'metadata-missing owned service was not restarted'

# Runtime destinations and snapshot parents are all validated before the first
# asset write. A redirected local tree or backup cannot yield a mixed release.
for redirect in destination snapshot; do
  reset_fixture
  write_asset_pair "$asset_dir" prior
  mkdir -p "$HOME_DIR/local"
  printf 'harness=hermes\n' > "$HOME_DIR/local/install-state"
  begin_bootstrap_transaction "$asset_dir"
  write_asset_pair "$asset_dir" fresh
  if [ "$redirect" = destination ]; then
    mv "$HOME_DIR/local" "$tmp/local-real"; ln -s "$tmp/local-real" "$HOME_DIR/local"
  else
    mv "$backup_dir/runtime/local" "$tmp/runtime-real"; ln -s "$tmp/runtime-real" "$backup_dir/runtime/local"
  fi
  if (PATH="$fake_bin:$PATH" COZYGATEWAY_TEST_SERVICE_LOG="$manager_log" recover_bootstrap_transaction "$asset_dir"); then fail "$redirect redirect unexpectedly recovered"; fi
  expect_contents "$asset_dir/cozygateway.mjs" 'fresh:cozygateway.mjs'
done

printf 'bootstrap transaction tests passed\n'

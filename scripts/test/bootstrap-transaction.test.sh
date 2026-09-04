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
asset_dir="$HOME_DIR/bin"
backup_dir="$HOME_DIR/.bootstrap-previous"
journal="$HOME_DIR/.bootstrap-transaction"
restore_log="$tmp/service-restores"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
expect_file() { [ -f "$1" ] || fail "expected file: $1"; }
expect_absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "expected absence: $1"; }
expect_contents() { [ "$(cat "$1")" = "$2" ] || fail "unexpected contents in $1"; }

# Recovery needs to re-register the previous payload.  Keep that observable
# while avoiding a real installer or service manager in this unit-level test.
restore_previous_installer() {
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
expect_contents "$restore_log" 'restored'
recover_bootstrap_transaction "$asset_dir"
expect_contents "$asset_dir/cozygateway.mjs" 'prior:cozygateway.mjs'
expect_contents "$restore_log" 'restored'

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

printf 'bootstrap transaction tests passed\n'

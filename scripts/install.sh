#!/usr/bin/env bash
# Bootstrap only: fetch versioned, checksummed release assets, verify each checksum, then
# hand off to the verified installer payload. Safe for `curl | bash` because
# main is called only after the complete script has been parsed.
set -euo pipefail
REPO="${COZYGATEWAY_INSTALL_REPO:-shiftedx/cozygateway}"
HOME_DIR="${COZYGATEWAY_HOME:-$HOME/.cozygateway}"
TAG="${COZYGATEWAY_INSTALL_TAG:-}"
ASSET_BASE="${COZYGATEWAY_INSTALL_ASSET_BASE:-}"
EXPLICIT_ASSET_BASE="$ASSET_BASE"
die() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
canonical_home_dir() {
  local parent base
  case "$HOME_DIR" in ''|/|"$HOME") die "COZYGATEWAY_HOME must name a dedicated directory, never empty, /, or $HOME" ;; esac
  case "$HOME_DIR" in /*) ;; *) HOME_DIR="$(pwd -P)/$HOME_DIR" ;; esac
  parent="$(dirname "$HOME_DIR")"; base="$(basename "$HOME_DIR")"
  [ "$base" != . ] && [ "$base" != .. ] || die "COZYGATEWAY_HOME must not resolve to . or .."
  [ -d "$parent" ] && HOME_DIR="$(cd -P "$parent" && pwd)/$base"
  case "$HOME_DIR" in /|"$HOME") die "COZYGATEWAY_HOME must name dedicated CozyGateway state" ;; esac
  case "$HOME_DIR" in *[!A-Za-z0-9_./-]*) die "COZYGATEWAY_HOME may contain only letters, digits, _, ., /, and -" ;; esac
}
sha256_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else die "sha256 tool required (shasum or sha256sum)"; fi; }
BOOTSTRAP_ASSETS=(cozygateway.mjs cozygateway-hermes-attach-plugin.tar.gz agent-install.sh gateway-supervisor.cjs cozygateway-bootstrap.sh)
bootstrap_lock=""
release_bootstrap_lock() {
  [ -z "$bootstrap_lock" ] && return
  rm -f "$bootstrap_lock/pid"
  rmdir "$bootstrap_lock" 2>/dev/null || true
}
handle_bootstrap_signal() {
  release_bootstrap_lock
  exit 128
}
valid_inventory_name() {
  local candidate="$1" asset
  for asset in "${BOOTSTRAP_ASSETS[@]}"; do
    [ "$candidate" = "$asset" ] || [ "$candidate" = "$asset.sha256" ] && return 0
  done
  return 1
}
acquire_bootstrap_lock() {
  local owner
  [ ! -L "$bootstrap_lock" ] && [ ! -L "$bootstrap_lock/pid" ] || die "refusing redirected bootstrap lock"
  if ! mkdir "$bootstrap_lock" 2>/dev/null; then
    owner="$(cat "$bootstrap_lock/pid" 2>/dev/null || true)"
    case "$owner" in *[!0-9]*|'') ;; *) kill -0 "$owner" 2>/dev/null && die "another CozyGateway bootstrap is running; wait for it to finish and rerun" ;; esac
    rm -f "$bootstrap_lock/pid"
    rmdir "$bootstrap_lock" 2>/dev/null || die "another CozyGateway bootstrap is running; wait for it to finish and rerun"
    mkdir "$bootstrap_lock" || die "could not acquire CozyGateway bootstrap lock"
  fi
  printf '%s\n' "$$" > "$bootstrap_lock/pid" || { rmdir "$bootstrap_lock" 2>/dev/null || true; die "could not record CozyGateway bootstrap lock"; }
}
prepare_owned_dir() {
  local path="$1" owner
  [ -L "$path" ] && die "refusing symlinked installer directory: $path"
  if [ -e "$path" ]; then
    [ -d "$path" ] || die "installer directory is not a directory: $path"
    owner="$(stat -c %u "$path" 2>/dev/null || stat -f %u "$path" 2>/dev/null || true)"
    [ "$owner" = "$(id -u)" ] || die "installer directory is not owned by the current user: $path"
  else
    (umask 077; mkdir -p "$path") || die "could not create installer directory: $path"
  fi
  chmod 700 "$path" || die "could not secure installer directory: $path"
}
recover_bootstrap_transaction() {
  local asset_dir="$1"; shift
  local journal="$HOME_DIR/.bootstrap-transaction" backup="$HOME_DIR/.bootstrap-previous"
  local state entry name inventory seen='' count=0
  [ ! -L "$journal" ] && [ ! -L "$journal.next" ] || die "refusing symlinked bootstrap transaction marker"
  [ ! -L "$backup" ] || die "refusing symlinked bootstrap rollback directory"
  if [ ! -e "$journal" ]; then
    [ ! -e "$backup" ] || rmdir "$backup" 2>/dev/null || die "bootstrap snapshots exist without a marker; preserve them and rerun"
    return
  fi
  [ -f "$journal" ] || die "bootstrap transaction marker is not a file"
  state="$(cat "$journal")"
  case "$state" in
    commit=installer-succeeded|restored=previous-release|prepare=replace-release-assets)
      [ ! -e "$backup" ] || rm -rf "$backup" || die "could not finish bootstrap cleanup; journal preserved"
      rm -f "$journal" || die "could not clear completed bootstrap marker"
      return ;;
    intent=replace-release-assets) ;;
    *) die "bootstrap transaction marker is invalid; preserve it and rerun" ;;
  esac
  inventory="$backup/inventory"
  [ -f "$inventory" ] && [ ! -L "$inventory" ] || die "bootstrap transaction inventory is missing or redirected"
  # Validate the complete snapshot before changing any installed file. A truncated
  # inventory must never turn a partial restore into an apparently successful one.
  while IFS= read -r entry || [ -n "$entry" ]; do
    case "$entry" in present:*|absent:*) name="${entry#*:}" ;; *) die "bootstrap transaction inventory is invalid" ;; esac
    valid_inventory_name "$name" || die "bootstrap transaction inventory is invalid"
    case "|$seen" in *"|$name|"*) die "bootstrap transaction inventory has duplicate assets" ;; esac
    seen="$seen$name|"
    count=$((count + 1))
    [ ! -L "$asset_dir/$name" ] && [ ! -L "$asset_dir/$name.recover.$$" ] || die "refusing redirected installed bootstrap asset"
    if [ "${entry%%:*}" = present ]; then
      [ -f "$backup/$name" ] && [ ! -L "$backup/$name" ] || die "bootstrap snapshot is incomplete or redirected"
    fi
  done < "$inventory"
  [ "$count" -eq "$((${#BOOTSTRAP_ASSETS[@]} * 2))" ] || die "bootstrap transaction inventory is incomplete"
  printf 'INFO  recovering an interrupted CozyGateway bootstrap before fetching a new release\n' >&2
  while IFS= read -r entry || [ -n "$entry" ]; do
    name="${entry#*:}"
    if [ "${entry%%:*}" = present ]; then
      cp "$backup/$name" "$asset_dir/$name.recover.$$" || die "could not restore $name"
      mv -f "$asset_dir/$name.recover.$$" "$asset_dir/$name" || die "could not activate restored $name"
    else
      rm -f "$asset_dir/$name" || die "could not remove incomplete bootstrap asset"
    fi
  done < "$inventory"
  if [ -f "$asset_dir/agent-install.sh" ]; then
    restore_previous_installer "$asset_dir" "$@" || die "previous assets were restored but its service restart failed; recovery journal is preserved"
    printf 'OK    restarted the previous CozyGateway service after the failed update\n' >&2
  fi
  printf 'restored=previous-release\n' > "$journal.next" && mv -f "$journal.next" "$journal" || die "could not record recovered bootstrap state"
  rm -rf "$backup" || die "could not finish bootstrap recovery; journal preserved"
  rm -f "$journal" || die "could not clear recovered bootstrap journal"
}
begin_bootstrap_transaction() {
  local asset_dir="$1" journal="$HOME_DIR/.bootstrap-transaction" backup="$HOME_DIR/.bootstrap-previous" name
  [ ! -e "$journal" ] && [ ! -e "$backup" ] || die "bootstrap recovery state already exists; rerun to recover it"
  [ ! -L "$journal" ] && [ ! -L "$journal.next" ] && [ ! -L "$backup" ] || die "refusing redirected bootstrap transaction paths"
  mkdir "$backup" || die "could not create bootstrap rollback directory"
  printf 'prepare=replace-release-assets\n' > "$journal" || { rmdir "$backup" 2>/dev/null || true; die "could not record bootstrap preparation"; }
  for asset in "${BOOTSTRAP_ASSETS[@]}"; do for name in "$asset" "$asset.sha256"; do
    [ ! -L "$asset_dir/$name" ] || die "refusing symlinked installed bootstrap asset"
    if [ -e "$asset_dir/$name" ]; then printf 'present:%s\n' "$name" >> "$backup/inventory"; cp "$asset_dir/$name" "$backup/$name" || die "could not snapshot $name"; else printf 'absent:%s\n' "$name" >> "$backup/inventory"; fi
  done; done
  printf 'intent=replace-release-assets\n' > "$journal.next" && mv -f "$journal.next" "$journal" || die "could not activate bootstrap transaction"
}
restore_previous_installer() { local asset_dir="$1"; shift; bash "$asset_dir/agent-install.sh" --gateway-dir "$HOME_DIR" --bundle "$asset_dir/cozygateway.mjs" --plugin-archive "$asset_dir/cozygateway-hermes-attach-plugin.tar.gz" "$@"; }
rollback_bootstrap_transaction() { local asset_dir="$1"; shift; recover_bootstrap_transaction "$asset_dir" "$@"; }
commit_bootstrap_transaction() { local journal="$HOME_DIR/.bootstrap-transaction" backup="$HOME_DIR/.bootstrap-previous"; printf 'commit=installer-succeeded\n' > "$journal.next" && mv -f "$journal.next" "$journal" || die "could not record bootstrap commit"; rm -rf "$backup" || die "could not remove bootstrap rollback directory"; rm -f "$journal" || die "could not clear bootstrap transaction marker"; }
record_explicit_bootstrap_source() {
  local source_file="$HOME_DIR/local/bootstrap-source" staged
  [ -n "$EXPLICIT_ASSET_BASE" ] || { rm -f "$source_file"; return; }
  case "$EXPLICIT_ASSET_BASE" in file:///*) ;; *) return ;; esac
  prepare_owned_dir "$HOME_DIR/local"
  staged="$source_file.tmp.$$"
  umask 077
  printf '%s\n' "$EXPLICIT_ASSET_BASE" > "$staged"
  chmod 600 "$staged"
  mv "$staged" "$source_file"
}
fetch_verified() {
  local asset="$1" out="$2" expected got
  curl -fsSL "$ASSET_BASE/$asset" -o "$out.new"; curl -fsSL "$ASSET_BASE/$asset.sha256" -o "$out.sha256"
  expected="$(awk '{print $1}' "$out.sha256")"; got="$(sha256_of "$out.new")"
  [ -n "$expected" ] && [ "$expected" = "$got" ] || { rm -f "$out.new"; die "$asset checksum mismatch"; }
  mv "$out.new" "$out"; chmod 700 "$out" 2>/dev/null || true; printf 'OK    verified %s\n' "$asset"
}
main() {
  local asset_dir="$HOME_DIR/bin" stage="" dry_stage="" asset installer_status=0
  # Before anything is fetched: this installs per user under $HOME and registers a user service,
  # and root would leave root-owned state in a person's home that their login cannot start.
  [ "$(id -u)" != 0 ] || die "CozyGateway installs per user under \$HOME and never needs sudo; rerun as yourself."
  command -v curl >/dev/null 2>&1 || die "curl is required"
  canonical_home_dir
  if [ "${COZYGATEWAY_INSTALL_DRYRUN:-}" = 1 ]; then
    dry_stage="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-bootstrap.XXXXXX")"; stage="$dry_stage"
  else
    prepare_owned_dir "$HOME_DIR"; prepare_owned_dir "$asset_dir"
    bootstrap_lock="$HOME_DIR/.bootstrap-lock"
    acquire_bootstrap_lock
    trap 'release_bootstrap_lock' EXIT
    trap 'handle_bootstrap_signal' HUP INT TERM
    recover_bootstrap_transaction "$asset_dir" "$@"
    stage="$(mktemp -d "$HOME_DIR/.bootstrap.XXXXXX")"
  fi
  trap '[ -z "$stage" ] || rm -rf "$stage"; release_bootstrap_lock' EXIT
  trap 'handle_bootstrap_signal' HUP INT TERM
  if [ -z "$ASSET_BASE" ]; then
    if [ -z "$TAG" ]; then TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"; [ -n "$TAG" ] || die "could not resolve latest release"; fi
    ASSET_BASE="https://github.com/$REPO/releases/download/$TAG"
  fi
  fetch_verified cozygateway.mjs "$stage/cozygateway.mjs"
  fetch_verified cozygateway-hermes-attach-plugin.tar.gz "$stage/cozygateway-hermes-attach-plugin.tar.gz"
  fetch_verified cozygateway-installer.sh "$stage/agent-install.sh"
  fetch_verified gateway-supervisor.cjs "$stage/gateway-supervisor.cjs"
  # Keep the release bootstrap that verified these assets. The installed command
  # uses it for repair so it never treats checkout files as update payloads.
  fetch_verified install.sh "$stage/cozygateway-bootstrap.sh"
  if [ -n "$dry_stage" ]; then rm -rf "$dry_stage"; stage=""; trap - EXIT HUP INT TERM; printf 'DRY   verified assets; would run installer from %s\n' "$HOME_DIR/bin/agent-install.sh"; return; fi
  begin_bootstrap_transaction "$asset_dir"
  for asset in "${BOOTSTRAP_ASSETS[@]}"; do
    mv "$stage/$asset" "$asset_dir/$asset" || { rollback_bootstrap_transaction "$asset_dir" "$@"; die "could not promote $asset; restored the previous release"; }
    mv "$stage/$asset.sha256" "$asset_dir/$asset.sha256" || { rollback_bootstrap_transaction "$asset_dir" "$@"; die "could not promote $asset checksum; restored the previous release"; }
    if [ "${COZYGATEWAY_TEST_BOOTSTRAP_KILL_AFTER_PROMOTION:-}" = "$asset" ]; then
      kill -KILL "$$"
    fi
  done
  rm -rf "$stage"
  stage=""
  if bash "$HOME_DIR/bin/agent-install.sh" --gateway-dir "$HOME_DIR" --bundle "$HOME_DIR/bin/cozygateway.mjs" --plugin-archive "$HOME_DIR/bin/cozygateway-hermes-attach-plugin.tar.gz" "$@"; then
    record_explicit_bootstrap_source
    commit_bootstrap_transaction
    trap - EXIT HUP INT TERM
    release_bootstrap_lock
    return
  else
    installer_status=$?
  fi
  rollback_bootstrap_transaction "$asset_dir" "$@" || die "installer failed and the previous release could not be restored; the recovery journal is preserved at $HOME_DIR/.bootstrap-transaction"
  die "installer failed; restored the previous CozyGateway release (exit $installer_status)"
}
main "$@"

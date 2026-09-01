#!/usr/bin/env bash
# Bootstrap only: fetch versioned, checksummed release assets, verify each checksum, then
# hand off to the verified installer payload. Safe for `curl | bash` because
# main is called only after the complete script has been parsed.
set -euo pipefail
REPO="${COZYGATEWAY_INSTALL_REPO:-shiftedx/cozygateway}"
HOME_DIR="${COZYGATEWAY_HOME:-$HOME/.cozygateway}"
TAG="${COZYGATEWAY_INSTALL_TAG:-}"
ASSET_BASE="${COZYGATEWAY_INSTALL_ASSET_BASE:-}"
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
prepare_owned_dir() {
  local path="$1" owner
  [ -L "$path" ] && die "refusing symlinked installer directory: $path"
  if [ -e "$path" ]; then
    [ -d "$path" ] || die "installer directory is not a directory: $path"
    owner="$(stat -f %u "$path" 2>/dev/null || stat -c %u "$path" 2>/dev/null || true)"
    [ "$owner" = "$(id -u)" ] || die "installer directory is not owned by the current user: $path"
  else
    (umask 077; mkdir -p "$path") || die "could not create installer directory: $path"
  fi
  chmod 700 "$path" || die "could not secure installer directory: $path"
}
fetch_verified() {
  local asset="$1" out="$2" expected got
  curl -fsSL "$ASSET_BASE/$asset" -o "$out.new"; curl -fsSL "$ASSET_BASE/$asset.sha256" -o "$out.sha256"
  expected="$(awk '{print $1}' "$out.sha256")"; got="$(sha256_of "$out.new")"
  [ -n "$expected" ] && [ "$expected" = "$got" ] || { rm -f "$out.new"; die "$asset checksum mismatch"; }
  mv "$out.new" "$out"; chmod 700 "$out" 2>/dev/null || true; printf 'OK    verified %s\n' "$asset"
}
main() {
  local asset_dir="$HOME_DIR/bin" stage="" dry_stage="" asset
  command -v curl >/dev/null 2>&1 || die "curl is required"
  canonical_home_dir
  if [ -z "$ASSET_BASE" ]; then
    if [ -z "$TAG" ]; then TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"; [ -n "$TAG" ] || die "could not resolve latest release"; fi
    ASSET_BASE="https://github.com/$REPO/releases/download/$TAG"
  fi
  if [ "${COZYGATEWAY_INSTALL_DRYRUN:-}" = 1 ]; then
    dry_stage="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-bootstrap.XXXXXX")"; stage="$dry_stage"
  else
    prepare_owned_dir "$HOME_DIR"; prepare_owned_dir "$asset_dir"
    stage="$(mktemp -d "$HOME_DIR/.bootstrap.XXXXXX")"
  fi
  trap '[ -z "$stage" ] || rm -rf "$stage"' EXIT
  fetch_verified cozygateway.mjs "$stage/cozygateway.mjs"
  fetch_verified cozygateway-hermes-attach-plugin.tar.gz "$stage/cozygateway-hermes-attach-plugin.tar.gz"
  fetch_verified cozygateway-installer.sh "$stage/agent-install.sh"
  # Keep the release bootstrap that verified these assets. The installed command
  # uses it for repair so it never treats checkout files as update payloads.
  fetch_verified install.sh "$stage/cozygateway-bootstrap.sh"
  if [ -n "$dry_stage" ]; then rm -rf "$dry_stage"; stage=""; trap - EXIT; printf 'DRY   verified assets; would run installer from %s\n' "$HOME_DIR/bin/agent-install.sh"; return; fi
  for asset in cozygateway.mjs cozygateway-hermes-attach-plugin.tar.gz agent-install.sh cozygateway-bootstrap.sh; do
    mv "$stage/$asset" "$asset_dir/$asset"; mv "$stage/$asset.sha256" "$asset_dir/$asset.sha256"
  done
  rm -rf "$stage"
  stage=""
  trap - EXIT
  exec bash "$HOME_DIR/bin/agent-install.sh" --gateway-dir "$HOME_DIR" --bundle "$HOME_DIR/bin/cozygateway.mjs" --plugin-archive "$HOME_DIR/bin/cozygateway-hermes-attach-plugin.tar.gz" "$@"
}
main "$@"

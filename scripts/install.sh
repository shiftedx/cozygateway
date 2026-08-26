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
fetch_verified() {
  local asset="$1" out="$2" expected got
  curl -fsSL "$ASSET_BASE/$asset" -o "$out.new"; curl -fsSL "$ASSET_BASE/$asset.sha256" -o "$out.sha256"
  expected="$(awk '{print $1}' "$out.sha256")"; got="$(sha256_of "$out.new")"
  [ -n "$expected" ] && [ "$expected" = "$got" ] || { rm -f "$out.new"; die "$asset checksum mismatch"; }
  mv "$out.new" "$out"; chmod 700 "$out" 2>/dev/null || true; printf 'OK    verified %s\n' "$asset"
}
main() {
  local asset_dir="$HOME_DIR/bin" dry_stage=""
  command -v curl >/dev/null 2>&1 || die "curl is required"
  canonical_home_dir
  if [ -z "$ASSET_BASE" ]; then
    if [ -z "$TAG" ]; then TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"; [ -n "$TAG" ] || die "could not resolve latest release"; fi
    ASSET_BASE="https://github.com/$REPO/releases/download/$TAG"
  fi
  if [ "${COZYGATEWAY_INSTALL_DRYRUN:-}" = 1 ]; then dry_stage="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-bootstrap.XXXXXX")"; asset_dir="$dry_stage"; trap 'rm -rf "$dry_stage"' RETURN; else mkdir -p "$asset_dir"; fi
  fetch_verified cozygateway.mjs "$asset_dir/cozygateway.mjs"
  fetch_verified cozygateway-hermes-attach-plugin.tar.gz "$asset_dir/cozygateway-hermes-attach-plugin.tar.gz"
  fetch_verified cozygateway-installer.sh "$asset_dir/agent-install.sh"
  if [ -n "$dry_stage" ]; then rm -rf "$dry_stage"; trap - RETURN; printf 'DRY   verified assets; would run installer from %s\n' "$HOME_DIR/bin/agent-install.sh"; return; fi
  exec bash "$HOME_DIR/bin/agent-install.sh" --gateway-dir "$HOME_DIR" --bundle "$HOME_DIR/bin/cozygateway.mjs" --plugin-archive "$HOME_DIR/bin/cozygateway-hermes-attach-plugin.tar.gz" "$@"
}
main "$@"

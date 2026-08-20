#!/usr/bin/env bash
#
# install.sh: the simple-track cozygateway installer.
#
#   curl -fsSL https://cozylabs.ai/install.sh | bash
#
# No Docker, no git, no build tools. It downloads the latest released
# single-file gateway bundle, verifies its sha256, and hands off to
# agent-install.sh (same tag) with --bundle --service, so the gateway and
# the hermes dashboard run as login services that survive reboots.
# Homelab users who want the container instead: https://cozylabs.ai/install
# (the Docker/agent playbook). Everything lands in ~/.cozygateway.
#
# Env overrides (testing / pinning):
#   COZYGATEWAY_INSTALL_REPO        default shiftedx/cozygateway
#   COZYGATEWAY_INSTALL_TAG         default: the latest release
#   COZYGATEWAY_INSTALL_ASSET_BASE  full URL base for the two assets, skips the
#                                   release lookup; file:///... works
#   COZYGATEWAY_HOME                default $HOME/.cozygateway
#   COZYGATEWAY_NODE                node 24+ binary to use
#   COZYGATEWAY_INSTALL_DRYRUN=1    print the agent-install.sh command instead
#                                   of running it
#
# Every extra argument is passed through to agent-install.sh, so both
#   bash install.sh --hidden-profiles default,ops
#   curl -fsSL https://cozylabs.ai/install.sh | bash -s -- --hidden-profiles default,ops
# work.
set -euo pipefail

REPO="${COZYGATEWAY_INSTALL_REPO:-shiftedx/cozygateway}"
CGW_HOME="${COZYGATEWAY_HOME:-$HOME/.cozygateway}"
say()  { printf '%s\n' "$*"; }
die()  { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

# --- Node >= 24 ------------------------------------------------------------
NODE_BIN="${COZYGATEWAY_NODE:-}"
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"; fi
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ -z "$NODE_BIN" ] || [ "$(node_major "$NODE_BIN")" -lt 24 ]; then
  # A newer node may be installed but not first on PATH (Homebrew keg, nvm).
  for cand in /opt/homebrew/opt/node/bin/node /usr/local/opt/node/bin/node \
              "$HOME"/.nvm/versions/node/v2[4-9]*/bin/node; do
    if [ -x "$cand" ] && [ "$(node_major "$cand")" -ge 24 ]; then NODE_BIN="$cand"; break; fi
  done
fi
if [ -z "$NODE_BIN" ] || [ "$(node_major "$NODE_BIN")" -lt 24 ]; then
  case "$(uname -s)" in
    Darwin) HINT="brew install node   (from https://brew.sh)" ;;
    *)      HINT="https://nodejs.org/en/download - or your distro's nodejs 24 package" ;;
  esac
  die "cozygateway needs Node.js 24 or newer. Install it, then re-run this line.
      $HINT"
fi
say "Using node: $NODE_BIN ($("$NODE_BIN" -v))"

# --- Resolve the release ---------------------------------------------------
TAG="${COZYGATEWAY_INSTALL_TAG:-}"
if [ -z "$TAG" ] && [ -z "${COZYGATEWAY_INSTALL_ASSET_BASE:-}" ]; then
  # Zero dependencies beyond curl and the standard text tools: pull the first
  # "tag_name": "..." out of the release JSON, whatever GitHub's indentation is.
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
  TAG="$(printf '%s' "$RELEASE_JSON" |
    grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
  [ -n "$TAG" ] || die "could not resolve the latest release of $REPO (offline? rate-limited? no releases yet?). Set COZYGATEWAY_INSTALL_TAG=vX.Y.Z and re-run."
fi
ASSET_BASE="${COZYGATEWAY_INSTALL_ASSET_BASE:-https://github.com/$REPO/releases/download/$TAG}"
RAW_BASE="https://raw.githubusercontent.com/$REPO/${TAG:-main}"

# --- Download + verify -----------------------------------------------------
mkdir -p "$CGW_HOME/bin"
say "Downloading cozygateway ${TAG:-} ..."
curl -fsSL "$ASSET_BASE/cozygateway.mjs" -o "$CGW_HOME/bin/cozygateway.mjs.new"
curl -fsSL "$ASSET_BASE/cozygateway.mjs.sha256" -o "$CGW_HOME/bin/cozygateway.mjs.sha256"
EXPECT="$(awk '{print $1}' "$CGW_HOME/bin/cozygateway.mjs.sha256")"
GOT="$(shasum -a 256 "$CGW_HOME/bin/cozygateway.mjs.new" 2>/dev/null | awk '{print $1}')"
[ -n "$GOT" ] || GOT="$(sha256sum "$CGW_HOME/bin/cozygateway.mjs.new" | awk '{print $1}')"
[ "$EXPECT" = "$GOT" ] || die "bundle sha256 mismatch (expected $EXPECT, got $GOT); refusing to run it"
mv "$CGW_HOME/bin/cozygateway.mjs.new" "$CGW_HOME/bin/cozygateway.mjs"
say "Verified sha256: $GOT"

curl -fsSL "$RAW_BASE/scripts/agent-install.sh" -o "$CGW_HOME/bin/agent-install.sh"

# --- Hand off --------------------------------------------------------------
if [ -n "${COZYGATEWAY_INSTALL_DRYRUN:-}" ]; then
  # Testing hook: show the exact handoff, run nothing.
  printf 'DRYRUN  env COZYGATEWAY_NODE=%s bash %s --gateway-dir %s --bundle %s --service' \
    "$NODE_BIN" "$CGW_HOME/bin/agent-install.sh" "$CGW_HOME" "$CGW_HOME/bin/cozygateway.mjs"
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\n'
  exit 0
fi

exec env COZYGATEWAY_NODE="$NODE_BIN" bash "$CGW_HOME/bin/agent-install.sh" \
  --gateway-dir "$CGW_HOME" \
  --bundle "$CGW_HOME/bin/cozygateway.mjs" \
  --service \
  "$@"

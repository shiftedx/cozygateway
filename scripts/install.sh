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
#
# The whole body lives in main(), invoked on the last line. That is deliberate:
# `curl | bash` feeds the shell a stream, and a connection cut halfway through
# would otherwise run whatever prefix arrived and exit 0. With this shape a
# truncated download never reaches the call, so a half-install cannot happen.
set -euo pipefail

say()  { printf '%s\n' "$*"; }
die()  { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

# Always answers with an integer. A node that exits 0 while printing nothing (a
# shim, a broken install) must read as 0 and be rejected, not sail through the
# `-lt 24` test on an empty string.
node_major() {
  local v
  v="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null | tail -1 | tr -dc '0-9')"
  printf '%s' "${v:-0}"
}

# Resolves a node >= 24, or dies naming how to get one.
resolve_node() {
  local node_bin hint cand
  node_bin="${COZYGATEWAY_NODE:-}"
  if [ -z "$node_bin" ] && command -v node >/dev/null 2>&1; then node_bin="$(command -v node)"; fi
  if [ -z "$node_bin" ] || [ "$(node_major "$node_bin")" -lt 24 ]; then
    # A newer node may be installed but not first on PATH (Homebrew keg, nvm).
    for cand in /opt/homebrew/opt/node/bin/node /usr/local/opt/node/bin/node \
                "$HOME"/.nvm/versions/node/v2[4-9]*/bin/node; do
      if [ -x "$cand" ] && [ "$(node_major "$cand")" -ge 24 ]; then node_bin="$cand"; break; fi
    done
  fi
  if [ -z "$node_bin" ] || [ "$(node_major "$node_bin")" -lt 24 ]; then
    case "$(uname -s)" in
      Darwin) hint="brew install node   (from https://brew.sh)" ;;
      *)      hint="https://nodejs.org/en/download - or your distro's nodejs 24 package" ;;
    esac
    die "cozygateway needs Node.js 24 or newer. Install it, then re-run this line.
      $hint"
  fi
  printf '%s' "$node_bin"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    die "no sha256 tool found (looked for shasum and sha256sum). Install coreutils on Linux, or Perl's shasum, then re-run this line."
  fi
}

main() {
  local repo cgw_home node_bin tag release_json asset_base raw_base expect got arg line

  repo="${COZYGATEWAY_INSTALL_REPO:-shiftedx/cozygateway}"
  cgw_home="${COZYGATEWAY_HOME:-$HOME/.cozygateway}"

  command -v curl >/dev/null 2>&1 || die "curl is required"

  command -v hermes >/dev/null 2>&1 || die "cozygateway connects your phone to a Hermes agent, so Hermes must be installed first. Install Hermes, then re-run this line. (Running the gateway without Hermes is an advanced setup: see https://github.com/shiftedx/cozygateway)"

  # --- Node >= 24 ----------------------------------------------------------
  node_bin="$(resolve_node)"
  say "Using node: $node_bin ($("$node_bin" -v))"

  # --- Resolve the release -------------------------------------------------
  tag="${COZYGATEWAY_INSTALL_TAG:-}"
  if [ -z "$tag" ] && [ -z "${COZYGATEWAY_INSTALL_ASSET_BASE:-}" ]; then
    # Zero dependencies beyond curl and the standard text tools: pull the first
    # "tag_name": "..." out of the release JSON, whatever the indentation is.
    release_json="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" 2>/dev/null || true)"
    tag="$(printf '%s' "$release_json" |
      grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
    [ -n "$tag" ] || die "could not resolve the latest release of $repo (offline? rate-limited? no releases yet?). Set COZYGATEWAY_INSTALL_TAG=vX.Y.Z and re-run."
  fi
  asset_base="${COZYGATEWAY_INSTALL_ASSET_BASE:-https://github.com/$repo/releases/download/$tag}"
  raw_base="https://raw.githubusercontent.com/$repo/${tag:-main}"

  # --- Download + verify ---------------------------------------------------
  mkdir -p "$cgw_home/bin"
  if [ -n "$tag" ]; then say "Downloading cozygateway $tag ..."; else say "Downloading cozygateway ..."; fi
  curl -fsSL "$asset_base/cozygateway.mjs" -o "$cgw_home/bin/cozygateway.mjs.new" 2>/dev/null ||
    die "could not download cozygateway.mjs from $asset_base (is the release published? set COZYGATEWAY_INSTALL_TAG=vX.Y.Z or check your network)"
  curl -fsSL "$asset_base/cozygateway.mjs.sha256" -o "$cgw_home/bin/cozygateway.mjs.sha256" 2>/dev/null ||
    die "could not download cozygateway.mjs.sha256 from $asset_base (is the release published? set COZYGATEWAY_INSTALL_TAG=vX.Y.Z or check your network)"

  expect="$(awk '{print $1}' "$cgw_home/bin/cozygateway.mjs.sha256")"
  got="$(sha256_of "$cgw_home/bin/cozygateway.mjs.new")"
  if [ "$expect" != "$got" ]; then
    rm -f "$cgw_home/bin/cozygateway.mjs.new"
    die "bundle sha256 mismatch (expected $expect, got $got); refusing to run it"
  fi
  mv "$cgw_home/bin/cozygateway.mjs.new" "$cgw_home/bin/cozygateway.mjs"
  say "Verified sha256: $got"

  curl -fsSL "$raw_base/scripts/agent-install.sh" -o "$cgw_home/bin/agent-install.sh" 2>/dev/null ||
    die "could not download scripts/agent-install.sh from $raw_base (is the release published? set COZYGATEWAY_INSTALL_TAG=vX.Y.Z or check your network)"

  # --- Hand off ------------------------------------------------------------
  if [ "${COZYGATEWAY_INSTALL_DRYRUN:-}" = "1" ]; then
    # Testing hook: show the exact handoff, run nothing. %q so the printed line
    # is safe to paste back into a shell.
    line="$(printf 'env COZYGATEWAY_NODE=%q bash %q --gateway-dir %q --bundle %q --service' \
      "$node_bin" "$cgw_home/bin/agent-install.sh" "$cgw_home" "$cgw_home/bin/cozygateway.mjs")"
    for arg in "$@"; do line="$line $(printf '%q' "$arg")"; done
    printf 'DRYRUN  %s\n' "$line"
    return 0
  fi

  exec env COZYGATEWAY_NODE="$node_bin" bash "$cgw_home/bin/agent-install.sh" \
    --gateway-dir "$cgw_home" \
    --bundle "$cgw_home/bin/cozygateway.mjs" \
    --service \
    "$@"
}

main "$@"

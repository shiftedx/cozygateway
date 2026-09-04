#!/usr/bin/env bash
# Install CozyGateway next to a Hermes installation.
#
# This intentionally owns only CozyGateway: one gateway service, one checked
# attach-plugin copy per selected Hermes profile, and the env keys it writes.
# Hermes' own per-profile gateway services remain Hermes-owned.
set -euo pipefail

GATEWAY_DIR="${COZYGATEWAY_HOME:-$HOME/.cozygateway}"
BUNDLE_PATH=""
PLUGIN_ARCHIVE=""
HERMES_BIN="${COZYGATEWAY_HERMES_BIN:-hermes}"
NODE_BIN="${COZYGATEWAY_NODE:-node}"
WINDOWS_POWERSHELL="${COZYGATEWAY_POWERSHELL:-}"
PROFILE_SPEC="all"
PROFILE_SPEC_EXPLICIT=0
BIND_HOST_EXPLICIT=0
PORT_EXPLICIT=0
PUBLIC_URL_EXPLICIT=0
CLEAR_PUBLIC_URL=0
if [ "${COZYGATEWAY_BIND_HOST+x}" = x ]; then BIND_HOST_EXPLICIT=1; fi
if [ "${COZYGATEWAY_PORT+x}" = x ]; then PORT_EXPLICIT=1; fi
BIND_HOST="${COZYGATEWAY_BIND_HOST:-127.0.0.1}"
PORT="${COZYGATEWAY_PORT:-8787}"
PUBLIC_URL=""
PREVIOUS_PORT=""
DASHBOARD_PORT="${COZYGATEWAY_DASHBOARD_PORT:-9119}"
WINDOWS_OWNED_IDENTITY=0
WINDOWS_OWNED_NODE_RESOLVED=""
WINDOWS_OWNED_GATEWAY_ENV=""
WINDOWS_OWNED_DASHBOARD_ENV=""
WINDOWS_OWNED_HERMES_ROOT=""
WINDOWS_OWNED_HERMES_RESOLVED=""
WINDOWS_OWNED_LAUNCHER=""
WINDOWS_OWNED_DASHBOARD_OWNER_PS1=""
WINDOWS_OWNED_DASHBOARD_PORT=""
WINDOWS_OWNED_BUNDLE_PATH=""
WINDOWS_OWNED_CONFIG_JSON=""
DRY_RUN=0
UNINSTALL=0
STATUS=0
# Which harness runs the bots. Empty until choose_harness scans the machine or --harness answers
# for it. COZYAGENTS_CHOSEN stays 0 unless a person or a recorded install actually said CozyAgents,
# because that is the only answer allowed to take a Hermes bridge out of an existing config.
HARNESS=""
HARNESS_EXPLICIT=0
COZYAGENTS_CHOSEN=0
KEPT_HERMES_BRIDGE=0
HERMES_FOUND=""
NO_QR=0
COZYAGENTS_HOME_DIR="${COZYAGENTS_HOME:-$HOME/.cozyagents}"
COZYAGENTS_INSTALL_URL_DEFAULT="https://cozylabs.ai/agents.sh"
RUNNER_MODEL_PROVIDER="${COZYGATEWAY_RUNNER_MODEL_PROVIDER:-}"
RUNNER_MODEL_ENDPOINT="${COZYGATEWAY_RUNNER_MODEL_ENDPOINT:-}"
RUNNER_MODEL_ID="${COZYGATEWAY_RUNNER_MODEL_ID:-}"
RUNNER_SHARE_HOST_MODEL_AUTH=0
RUNNER_PAIR_CODE=""
SERVICE_PLATFORM="${COZYGATEWAY_SERVICE_PLATFORM:-}"
TOKENS=()
TOKEN_ENVS=()
SERVICE_PROFILES=()
SERVICE_ACTIONS=()
# A repaired install may contain many Hermes profiles, but a loaded profile only
# needs a restart when this run replaced its attach plugin. Keep that fact per
# profile so an already-attached sibling is never restarted just because a
# different profile was interrupted mid-update.
PLUGIN_CHANGED_PROFILES=()
ENV_OWNER_KEY="COZYGATEWAY_INSTALLER_OWNER"
ENV_OWNER_VALUE="cozylabs-v1"

say() { printf '%s\n' "$*"; }
die() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then printf 'DRY   '; printf '%q ' "$@"; printf '\n'; else "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }
need_value() { [ "$#" -ge 2 ] || die "$1 needs a value"; }

usage() {
  cat <<'USAGE'
usage: agent-install.sh --bundle PATH --plugin-archive PATH [options]

  --bundle PATH           verified cozygateway.mjs release asset
  --plugin-archive PATH   verified CozyGateway Hermes plugin archive (Hermes harness only)
  --harness NAME          cozyagents or hermes; skips the harness question
  --runner-model-provider NAME  default model provider for CozyAgents bots
  --runner-model-endpoint URL   default local model endpoint for CozyAgents bots
  --runner-model-id ID          default model id for CozyAgents bots
  --no-qr                 never print a pairing QR, whatever the run is
  --gateway-dir DIR       CozyGateway-owned state directory (default ~/.cozygateway)
  --profiles all|A,B      Hermes profiles to connect (default all discovered profiles)
  --bind-host HOST        gateway listener address (skips the fresh-install LAN prompt)
  --port PORT             gateway listener port (default 8787)
  --public-url URL        advertise one HTTPS origin; requires a loopback listener
  --clear-public-url      stop advertising the saved public origin
  --dashboard-port PORT   local Hermes Dashboard control-plane port (default 9119)
  --dry-run               show discovered work without changing anything
  --service-platform OS   override service platform (Darwin, Linux, Windows)
  --status                report persistence and live gateway health
  --uninstall             remove only CozyGateway-owned service, plugins, env keys and state

The gateway and attach plugin both stay on this machine. This installer never
configures remote networking, DNS, routers, or firewalls.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) need_value "$@"; BUNDLE_PATH="$2"; shift ;;
    --plugin-archive) need_value "$@"; PLUGIN_ARCHIVE="$2"; shift ;;
    --harness) need_value "$@"; HARNESS="$2"; HARNESS_EXPLICIT=1; shift ;;
    --runner-model-provider) need_value "$@"; RUNNER_MODEL_PROVIDER="$2"; shift ;;
    --runner-model-endpoint) need_value "$@"; RUNNER_MODEL_ENDPOINT="$2"; shift ;;
    --runner-model-id) need_value "$@"; RUNNER_MODEL_ID="$2"; shift ;;
    --no-qr) NO_QR=1 ;;
    --gateway-dir) need_value "$@"; GATEWAY_DIR="$2"; shift ;;
    --profiles) need_value "$@"; PROFILE_SPEC="$2"; PROFILE_SPEC_EXPLICIT=1; shift ;;
    --bind-host) need_value "$@"; BIND_HOST="$2"; BIND_HOST_EXPLICIT=1; shift ;;
    --port) need_value "$@"; PORT="$2"; PORT_EXPLICIT=1; shift ;;
    --public-url) need_value "$@"; PUBLIC_URL="$2"; PUBLIC_URL_EXPLICIT=1; shift ;;
    --clear-public-url) CLEAR_PUBLIC_URL=1 ;;
    --dashboard-port) need_value "$@"; DASHBOARD_PORT="$2"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --service-platform) need_value "$@"; SERVICE_PLATFORM="$2"; shift ;;
    --status) STATUS=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
  shift
done

[ "$PUBLIC_URL_EXPLICIT" = 0 ] || [ "$CLEAR_PUBLIC_URL" = 0 ] || \
  die "--public-url and --clear-public-url are mutually exclusive"
case "$HARNESS" in ''|cozyagents|hermes) ;; *) die "--harness must be cozyagents or hermes" ;; esac
[ -z "$RUNNER_MODEL_PROVIDER" ] || [ -z "$RUNNER_MODEL_ENDPOINT" ] || \
  die "--runner-model-provider and --runner-model-endpoint are mutually exclusive; a bot has one model source"

# CozyAgents installs per user under $HOME and registers a user service. Root would leave
# root-owned state in a person's home and a service nobody's login can start.
[ "$(id -u)" != 0 ] || die "CozyGateway installs per user under \$HOME and never needs sudo; rerun as yourself."

normalize_service_platform() {
  [ -n "$SERVICE_PLATFORM" ] || SERVICE_PLATFORM="$(uname -s)"
  case "$SERVICE_PLATFORM" in
    Darwin|Linux) ;;
    Windows|MINGW*|MSYS*|CYGWIN*) SERVICE_PLATFORM=Windows ;;
    *) die "supported service managers are launchd (macOS), systemd --user (Linux), and Scheduled Tasks (Windows)" ;;
  esac
}
is_windows() { [ "$SERVICE_PLATFORM" = Windows ]; }
to_posix_path() {
  if is_windows; then have cygpath || die "Git Bash must provide cygpath on Windows"; cygpath -u "$1"; else printf '%s' "$1"; fi
}
to_windows_path() {
  if is_windows; then have cygpath || die "Git Bash must provide cygpath on Windows"; cygpath -w "$1"; else printf '%s' "$1"; fi
}
normalize_service_platform
if is_windows; then
  WINDOWS_POWERSHELL="${WINDOWS_POWERSHELL:-${SYSTEMROOT:-${WINDIR:-C:\\Windows}}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe}"
  case "$WINDOWS_POWERSHELL" in [A-Za-z]:\\*) ;; *) die "trusted Windows PowerShell path must be absolute" ;; esac
  case "$WINDOWS_POWERSHELL" in *['"%&|<>^!']*) die "trusted Windows PowerShell path contains unsupported characters" ;; esac
  GATEWAY_DIR="$(to_posix_path "$GATEWAY_DIR")"
  [ -z "$BUNDLE_PATH" ] || BUNDLE_PATH="$(to_posix_path "$BUNDLE_PATH")"
  [ -z "$PLUGIN_ARCHIVE" ] || PLUGIN_ARCHIVE="$(to_posix_path "$PLUGIN_ARCHIVE")"
  case "$HERMES_BIN" in [A-Za-z]:\\*|[A-Za-z]:/*) HERMES_BIN="$(to_posix_path "$HERMES_BIN")" ;; esac
fi

case "$DASHBOARD_PORT" in ''|*[!0-9]*) die "--dashboard-port must be 1-65535" ;; esac
[ "$DASHBOARD_PORT" -ge 1 ] && [ "$DASHBOARD_PORT" -le 65535 ] || die "--dashboard-port must be 1-65535"
canonical_gateway_dir() {
  local parent base physical
  case "$GATEWAY_DIR" in ''|/|"$HOME") die "--gateway-dir must name a dedicated directory, never empty, /, or $HOME" ;; esac
  case "$GATEWAY_DIR" in /*) ;; *) GATEWAY_DIR="$(pwd -P)/$GATEWAY_DIR" ;; esac
  parent="$(dirname "$GATEWAY_DIR")"; base="$(basename "$GATEWAY_DIR")"
  [ "$base" != . ] && [ "$base" != .. ] || die "--gateway-dir must not resolve to . or .."
  [ -d "$parent" ] && GATEWAY_DIR="$(cd -P "$parent" && pwd)/$base"
  if [ -d "$GATEWAY_DIR" ]; then
    physical="$(cd -P "$GATEWAY_DIR" && pwd)"
    [ "$physical" = "$GATEWAY_DIR" ] || die "--gateway-dir must not be a symlink or junction"
  fi
  case "$GATEWAY_DIR" in /|"$HOME") die "--gateway-dir must be dedicated CozyGateway state, not $GATEWAY_DIR" ;; esac
  if ! is_windows; then
    case "$GATEWAY_DIR" in *[!A-Za-z0-9_./-]*) die "--gateway-dir may contain only letters, digits, _, ., /, and - so launchd/systemd can load it safely" ;; esac
  fi
}
canonical_gateway_dir

LOCAL_DIR="$GATEWAY_DIR/local"
CONFIG_JSON="$LOCAL_DIR/cozygateway.config.json"
GATEWAY_ENV="$LOCAL_DIR/gateway.env"
DASHBOARD_ENV="$LOCAL_DIR/dashboard.env"
DASHBOARD_OWNER_PS1="$LOCAL_DIR/dashboard-owner.ps1"
DASHBOARD_ELEVATION_PS1="$LOCAL_DIR/dashboard-owner-elevate.ps1"
STATE_FILE="$LOCAL_DIR/install-state"
WRAPPER="$LOCAL_DIR/run-gateway.sh"
SUPERVISOR="$LOCAL_DIR/gateway-supervisor.cjs"
MAINTENANCE_WORKER="$GATEWAY_DIR/bin/gateway-maintenance-worker.cjs"
MAINTENANCE_SOCKET="$LOCAL_DIR/gateway-maintenance.sock"
CLI_WRAPPER="$GATEWAY_DIR/bin/cozygateway"
CLI_WINDOWS="$GATEWAY_DIR/bin/cozygateway.cmd"
POSIX_BOOTSTRAP="$GATEWAY_DIR/bin/cozygateway-bootstrap.sh"
WINDOWS_BOOTSTRAP="$GATEWAY_DIR/bin/cozygateway-bootstrap.ps1"
GW_LOG="$LOCAL_DIR/cozygateway.log"
SERVICE_LABEL="ai.cozylabs.cozygateway"
SERVICE_UNIT="cozygateway.service"
WINDOWS_TASK="CozyGateway"
WINDOWS_VBS="$LOCAL_DIR/run-gateway.vbs"
WINDOWS_TASK_XML="$LOCAL_DIR/cozygateway-task.xml"
INSTALL_ALREADY_CONFIGURED=0
[ ! -f "$CONFIG_JSON" ] || INSTALL_ALREADY_CONFIGURED=1

hydrate_listener_settings() {
  local saved remainder saved_host saved_port saved_public
  if [ ! -f "$CONFIG_JSON" ]; then return 0; fi
  saved="$("$NODE_RESOLVED" - "$CONFIG_JSON" <<'NODE'
const { readFileSync } = require('node:fs');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.stdout.write(String(config.host ?? '') + '\t' + String(config.port ?? '') + '\t' + String(config.publicUrl ?? ''));
NODE
)" || die "could not read the existing listener from $CONFIG_JSON"
  saved_host="${saved%%$'\t'*}"; remainder="${saved#*$'\t'}"
  saved_port="${remainder%%$'\t'*}"; saved_public="${remainder#*$'\t'}"
  PREVIOUS_PORT="$saved_port"
  [ "$BIND_HOST_EXPLICIT" = 1 ] || [ -z "$saved_host" ] || BIND_HOST="$saved_host"
  [ "$PORT_EXPLICIT" = 1 ] || [ -z "$saved_port" ] || PORT="$saved_port"
  if [ "$CLEAR_PUBLIC_URL" = 1 ]; then
    PUBLIC_URL=""
  elif [ "$PUBLIC_URL_EXPLICIT" = 0 ] && [ -n "$saved_public" ]; then
    PUBLIC_URL="$saved_public"
  fi
  # Opting into a public origin is a posture, not a label. Unless the operator explicitly supplied
  # another bind (which validation below will reject), move an existing LAN install back to loopback.
  [ "$PUBLIC_URL_EXPLICIT" = 0 ] || [ "$BIND_HOST_EXPLICIT" = 1 ] || BIND_HOST=127.0.0.1
}
choose_fresh_listener() {
  local input answer
  [ ! -f "$CONFIG_JSON" ] || return 0
  [ "$BIND_HOST_EXPLICIT" = 0 ] || return 0
  [ "$PUBLIC_URL_EXPLICIT" = 0 ] || return 0
  [ "$CLEAR_PUBLIC_URL" = 0 ] || return 0
  [ "$DRY_RUN" = 0 ] || return 0

  # The supported one-paste command pipes the bootstrap through stdin, so the question must use
  # the controlling terminal rather than fd 0. Without a terminal this remains safely loopback.
  input="${COZYGATEWAY_TEST_LAN_PROMPT_INPUT:-/dev/tty}"
  if [ -z "${COZYGATEWAY_TEST_LAN_PROMPT_INPUT:-}" ] && { [ ! -t 2 ] || [ ! -r /dev/tty ]; }; then return 0; fi
  [ -r "$input" ] || return 0
  exec 9<"$input" || return 0
  while true; do
    printf 'Allow CozyChat to access this Gateway over your local network? [y/N] ' >&2
    if ! IFS= read -r answer <&9; then answer=""; fi
    case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
      y|yes) BIND_HOST=0.0.0.0; break ;;
      ''|n|no) break ;;
      *) say 'Please answer y or n.' >&2 ;;
    esac
  done
  exec 9<&-
}
should_mint_pairing_code() {
  local input answer
  [ "$INSTALL_ALREADY_CONFIGURED" = 1 ] || return 0

  # The supported installer is commonly piped through stdin. Ask on the controlling terminal;
  # unattended upgrades have no terminal and therefore take the safe default without minting.
  input="${COZYGATEWAY_TEST_PAIR_PROMPT_INPUT:-/dev/tty}"
  if [ -z "${COZYGATEWAY_TEST_PAIR_PROMPT_INPUT:-}" ] && { [ ! -t 2 ] || [ ! -r /dev/tty ]; }; then return 1; fi
  [ -r "$input" ] || return 1
  exec 8<"$input" || return 1
  while true; do
    printf 'Create a new CozyChat pairing code? [y/N] ' >&2
    if ! IFS= read -r answer <&8; then answer=""; fi
    case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
      y|yes) exec 8<&-; return 0 ;;
      ''|n|no) exec 8<&-; return 1 ;;
      *) say 'Please answer y or n.' >&2 ;;
    esac
  done
}
validate_listener_settings() {
  [ -n "$BIND_HOST" ] || die "--bind-host must not be empty"
  case "$PORT" in ''|*[!0-9]*) die "--port must be 1-65535" ;; esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be 1-65535"
  "$NODE_RESOLVED" - "$BIND_HOST" <<'NODE' || die "--bind-host must be a hostname or IP address, not a URL or whitespace"
const { isIP } = require('node:net');
const host = process.argv[2];
const validName = host.length <= 253 && host.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
process.exit(isIP(host) !== 0 || validName ? 0 : 1);
NODE
  if [ -n "$PUBLIC_URL" ]; then
    PUBLIC_URL="$("$NODE_RESOLVED" - "$PUBLIC_URL" <<'NODE'
const raw = process.argv[2];
if (/[\u0000-\u0020\u007f]/.test(raw)) process.exit(1);
let url;
try { url = new URL(raw); } catch { process.exit(1); }
if (!/^https:\/\/[^/?#]+\/?$/i.test(raw) || url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '' ||
    url.pathname !== '/' || url.search !== '' || url.hash !== '') process.exit(1);
process.stdout.write(url.origin);
NODE
    )" || die "--public-url must be a strict HTTPS origin without ASCII whitespace/control characters, credentials, path, query, or fragment"
    case "$(printf '%s' "$BIND_HOST" | tr '[:upper:]' '[:lower:]')" in
      127.0.0.1|::1|localhost) ;;
      *) die "--public-url requires a loopback --bind-host (127.0.0.1, ::1, or localhost)" ;;
    esac
  fi
}
gateway_origin() {
  local host="$BIND_HOST"
  case "$host" in 0.0.0.0) host=127.0.0.1 ;; ::) host='[::1]' ;; *:*) host="[$host]" ;; esac
  printf 'http://%s:%s' "$host" "$PORT"
}

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null | tr -dc '0-9'; }
resolve_node() {
  local candidate major private="$GATEWAY_DIR/runtime/node/bin/node"
  is_windows && private="$GATEWAY_DIR/runtime/node/node.exe"
  if [ "${COZYGATEWAY_NODE+x}" != x ] && [ -x "$private" ]; then
    major="$(node_major "$private")"; [ "${major:-0}" -ge 24 ] && { printf '%s' "$private"; return; }
  fi
  candidate="$NODE_BIN"
  if case "$candidate" in */*) [ -x "$candidate" ] ;; *) have "$candidate" ;; esac; then
    major="$(node_major "$candidate")"
    if [ "${major:-0}" -ge 24 ]; then case "$candidate" in /*) printf '%s' "$candidate" ;; *) command -v "$candidate" ;; esac; return; fi
  fi
  [ "${COZYGATEWAY_NODE+x}" = x ] && return 1
  return 1
}
sha256_of() { if have shasum; then shasum -a 256 "$1" | awk '{print $1}'; elif have sha256sum; then sha256sum "$1" | awk '{print $1}'; else die "sha256 tool required (shasum or sha256sum)"; fi; }
sha1_blob_of() {
  local size
  size="$(wc -c < "$1" | tr -d ' ')"
  if have shasum; then { printf 'blob %s\0' "$size"; cat "$1"; } | shasum | awk '{print $1}'
  elif have sha1sum; then { printf 'blob %s\0' "$size"; cat "$1"; } | sha1sum | awk '{print $1}'
  else die "sha1 tool required to verify the official Hermes installer"; fi
}
copy_or_download() { if [ -f "$1" ]; then cp "$1" "$2"; else curl -fsSL "$1" -o "$2"; fi; }
node_archive_name() {
  local os arch machine extension=tar.gz
  machine="$(uname -m)"
  case "$SERVICE_PLATFORM" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    Windows)
      os=win; extension=zip
      machine="${PROCESSOR_ARCHITEW6432:-${PROCESSOR_ARCHITECTURE:-$machine}}"
      ;;
    *) die "private Node bootstrap is unavailable for $SERVICE_PLATFORM" ;;
  esac
  machine="$(printf '%s' "$machine" | tr '[:upper:]' '[:lower:]')"
  case "$machine" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "Node.js 24 is unavailable for $(uname -s) $(uname -m); install Node.js 24+ and retry" ;; esac
  if [ "$os" = linux ] && have ldd && ldd --version 2>&1 | grep -qi musl; then
    die "official Node.js binaries require glibc; install Node.js 24+ for this musl Linux system and retry"
  fi
  printf 'node-%s-%s-%s.%s' "$NODE_INSTALL_VERSION" "$os" "$arch" "$extension"
}
install_node_runtime() {
  local base="${COZYGATEWAY_NODE_DIST_BASE:-https://nodejs.org/dist}" index version_file archive expected got stage source
  have curl || die "curl is required to install Node.js"
  if is_windows; then have powershell.exe || die "Windows PowerShell is required to install Node.js"
  else have tar || die "tar is required to install Node.js"; fi
  stage="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-node.XXXXXX")"; trap 'rm -rf "$stage"' RETURN
  NODE_INSTALL_VERSION="${COZYGATEWAY_NODE_VERSION:-}"
  if [ -z "$NODE_INSTALL_VERSION" ]; then
    index="$stage/index.tab"; copy_or_download "$base/index.tab" "$index"
    NODE_INSTALL_VERSION="$(awk 'NR > 1 && $1 ~ /^v24\./ { print $1; exit }' "$index")"
  fi
  case "$NODE_INSTALL_VERSION" in v24.*) ;; *) die "could not resolve a current Node.js 24 release" ;; esac
  archive="$(node_archive_name)"; version_file="$base/$NODE_INSTALL_VERSION"
  copy_or_download "$version_file/SHASUMS256.txt" "$stage/SHASUMS256.txt"
  expected="$(awk -v file="$archive" '$2 == file { print $1; exit }' "$stage/SHASUMS256.txt")"
  [ -n "$expected" ] || die "$archive is absent from the official Node.js checksums"
  copy_or_download "$version_file/$archive" "$stage/$archive"; got="$(sha256_of "$stage/$archive")"
  [ "$expected" = "$got" ] || die "$archive checksum mismatch"
  if is_windows; then
    # PowerShell expands these environment variables. They must stay single-
    # quoted here so Bash does not interpret the PowerShell `$env:` syntax.
    # shellcheck disable=SC2016
    MSYS_NO_PATHCONV=1 \
      COZYGATEWAY_NODE_EXPAND_ARCHIVE="$(to_windows_path "$stage/$archive")" \
      COZYGATEWAY_NODE_EXPAND_DESTINATION="$(to_windows_path "$stage")" \
      powershell.exe -NoProfile -NonInteractive -Command \
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:COZYGATEWAY_NODE_EXPAND_ARCHIVE, $env:COZYGATEWAY_NODE_EXPAND_DESTINATION)'
    source="$stage/${archive%.zip}"
    [ -x "$source/node.exe" ] || die "$archive did not contain a Node.js executable"
  else
    tar -xzf "$stage/$archive" -C "$stage"
    source="$stage/${archive%.tar.gz}"
    [ -x "$source/bin/node" ] || die "$archive did not contain a Node.js executable"
  fi
  mkdir -p "$GATEWAY_DIR/runtime"; rm -rf "$GATEWAY_DIR/runtime/node"; mv "$source" "$GATEWAY_DIR/runtime/node"
  if is_windows; then NODE_RESOLVED="$GATEWAY_DIR/runtime/node/node.exe"
  else NODE_RESOLVED="$GATEWAY_DIR/runtime/node/bin/node"; fi
  say "OK    installed checksum-verified Node.js $NODE_INSTALL_VERSION for CozyGateway only"
  rm -rf "$stage"; trap - RETURN
}
find_hermes() {
  local candidate
  for candidate in "$HERMES_BIN" "$HOME/.local/bin/hermes" "${HERMES_HOME:-$HOME/.hermes}/bin/hermes"; do
    case "$candidate" in */*) [ -x "$candidate" ] && { printf '%s' "$candidate"; return; } ;; *) have "$candidate" && { command -v "$candidate"; return; } ;; esac
  done
  return 1
}
fetch_hermes_installer() {
  local out="$1" source="${COZYGATEWAY_HERMES_INSTALL_URL:-}" expected="${COZYGATEWAY_HERMES_INSTALL_SHA256:-}" tag metadata got
  if [ -n "$source" ]; then
    copy_or_download "$source" "$out"
    if [ -f "$source" ]; then [ -n "$expected" ] || expected="$(sha256_of "$source")"; fi
    [ -n "$expected" ] || die "COZYGATEWAY_HERMES_INSTALL_SHA256 is required for a remote Hermes installer override"
    [ "$(sha256_of "$out")" = "$expected" ] || die "Hermes installer checksum mismatch"
    return
  fi
  tag="$(curl -fsSL https://api.github.com/repos/NousResearch/hermes-agent/releases/latest | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  case "$tag" in ''|*[!A-Za-z0-9._-]*) die "could not resolve the latest tagged Hermes release" ;; esac
  metadata="$(curl -fsSL "https://api.github.com/repos/NousResearch/hermes-agent/contents/scripts/install.sh?ref=$tag")"
  expected="$(printf '%s' "$metadata" | sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)".*/\1/p' | head -1)"
  [ -n "$expected" ] || die "could not resolve the official Hermes installer identity for $tag"
  curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/$tag/scripts/install.sh" -o "$out"
  got="$(sha1_blob_of "$out")"; [ "$got" = "$expected" ] || die "Hermes installer identity mismatch"
  say "OK    verified the official NousResearch Hermes installer from $tag"
}
install_hermes() {
  local stage installer
  have curl || die "curl is required to install Hermes Agent"
  stage="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-hermes.XXXXXX")"; trap 'rm -rf "$stage"' RETURN
  installer="$stage/install.sh"; fetch_hermes_installer "$installer"; chmod 700 "$installer"
  say "INFO  Hermes Agent is not installed; starting the official installer."
  bash "$installer" || die "Hermes installation did not complete successfully"
  HERMES_RESOLVED="$(find_hermes)" || die "Hermes installation finished but the hermes command was not found; add it to PATH and retry"
  rm -rf "$stage"; trap - RETURN
}
confirm_hermes_model() {
  local status
  if [ "$DRY_RUN" = 1 ]; then say "DRY   verify the active Hermes provider and model; open hermes model only when either is missing"; return; fi
  status="$("$HERMES_RESOLVED" status 2>&1 || true)"
  if printf '%s\n' "$status" | grep -Eq '^[[:space:]]*(Current model|Model):[[:space:]]*[^[:space:]]' &&
     printf '%s\n' "$status" | grep -Eq '^[[:space:]]*(Active provider|Provider):[[:space:]]*[^[:space:]]'; then
    say "OK    Hermes provider and model are already configured"
    return
  fi
  say "INFO  Choose or confirm the Hermes inference provider and model."
  "$HERMES_RESOLVED" model || die "Hermes model selection did not complete successfully"
  status="$("$HERMES_RESOLVED" status 2>&1)" || die "Hermes needs an active provider and model before CozyGateway can be installed"
  printf '%s\n' "$status" | grep -Eq '^[[:space:]]*(Current model|Model):[[:space:]]*[^[:space:]]' || die "Hermes needs an active provider and model before CozyGateway can be installed"
  printf '%s\n' "$status" | grep -Eq '^[[:space:]]*(Active provider|Provider):[[:space:]]*[^[:space:]]' || die "Hermes needs an active provider and model before CozyGateway can be installed"
  say "OK    Hermes provider and model are configured"
}

# The harness is the thing that actually runs a bot. A machine that already has
# Hermes keeps it, with no question asked; a machine with none is offered CozyAgents first and
# takes it on Enter, on `--harness`, and whenever there is no terminal to ask on.
choose_harness() {
  local input answer recorded=""
  HERMES_FOUND="$(find_hermes || true)"
  if [ "$HARNESS_EXPLICIT" = 1 ]; then
    [ "$HARNESS" != cozyagents ] || COZYAGENTS_CHOSEN=1
    say "OK    harness: $HARNESS (from --harness)"
    return 0
  fi
  # A machine that answered this question once is never asked again: the recorded harness is the
  # one this install owns, and changing it is an uninstall away. An install written before the
  # harness line existed records a Hermes root instead, and that is just as binding: a Hermes
  # install whose binary has since moved must never be re-read as a CozyAgents one.
  if [ -f "$STATE_FILE" ]; then
    recorded="$(sed -n 's/^harness=//p' "$STATE_FILE" | tail -1)"
    if [ -z "$recorded" ] && grep -q '^hermes_root=' "$STATE_FILE"; then recorded=hermes; fi
  fi
  case "$recorded" in
    cozyagents) HARNESS=cozyagents; COZYAGENTS_CHOSEN=1; say "OK    harness: cozyagents (already installed here)"; return 0 ;;
    hermes) HARNESS=hermes; say "OK    harness: hermes (already installed here)"; return 0 ;;
  esac
  if [ -n "$HERMES_FOUND" ]; then
    HARNESS=hermes
    say "OK    Hermes Agent is already installed; keeping it as the harness that runs your bots"
    return 0
  fi
  # Windows keeps the harness it has always had here. The native CozyAgents installer for Windows
  # is its own one-liner, and this script has never installed a harness on Windows.
  if is_windows; then HARNESS=hermes; return 0; fi
  HARNESS=cozyagents
  # The supported one-paste command pipes this script through stdin, so the question uses the
  # controlling terminal rather than fd 0. With no terminal the recommended answer stands.
  input="${COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT:-/dev/tty}"
  if [ -z "${COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT:-}" ] && { [ ! -t 2 ] || [ ! -r /dev/tty ]; }; then return 0; fi
  [ -r "$input" ] || return 0
  exec 7<"$input" || return 0
  while true; do
    printf 'Which harness runs your bots? [1] CozyAgents (recommended) [2] Hermes Agent [1] ' >&2
    if ! IFS= read -r answer <&7; then answer=""; fi
    case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
      ''|1|c|cozyagents) HARNESS=cozyagents; COZYAGENTS_CHOSEN=1; break ;;
      2|h|hermes) HARNESS=hermes; break ;;
      *) say 'Please answer 1 or 2.' >&2 ;;
    esac
  done
  exec 7<&-
  say "OK    harness: $HARNESS"
}

# A Codex login already on this machine is the one credential a person can share with their bots
# without typing a key anywhere. Detection only: nothing is read, copied, or written.
detect_codex_login() {
  local auth="${COZYGATEWAY_CODEX_AUTH_PATH:-$HOME/.pi/agent/auth.json}" hermes_env
  [ -f "$auth" ] && { printf '%s' "$auth"; return 0; }
  hermes_env="${HERMES_HOME:-$HOME/.hermes}/.env"
  if [ -f "$hermes_env" ] && grep -Eq '^[[:space:]]*(OPENAI_CODEX_[A-Z0-9_]*|CODEX_[A-Z0-9_]*)=[^[:space:]]' "$hermes_env"; then
    printf '%s' "$hermes_env"; return 0
  fi
  return 1
}

safe_model_word() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$ ]]; }
safe_model_endpoint() { [[ "$1" =~ ^https?://[A-Za-z0-9._~:/?#@%+=-]{1,255}$ ]]; }

# The CozyAgents half of provider-and-model onboarding: the same pair of questions the Hermes path
# asks, answered once, and written to the runner env later by write_runner_model_env.
confirm_cozyagents_model() {
  local input answer codex_auth
  if [ -n "$RUNNER_MODEL_PROVIDER" ] || [ -n "$RUNNER_MODEL_ENDPOINT" ]; then
    [ -n "$RUNNER_MODEL_ID" ] || die "a model provider or endpoint needs --runner-model-id as well"
  fi
  if [ -n "$RUNNER_MODEL_ID" ] && [ -z "$RUNNER_MODEL_PROVIDER" ] && [ -z "$RUNNER_MODEL_ENDPOINT" ]; then
    die "--runner-model-id needs --runner-model-provider or --runner-model-endpoint"
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "DRY   ask for the model provider or a local endpoint, and the model id, then write COZYRUNNER_MODEL_* into $COZYAGENTS_HOME_DIR/runner.env"
    return 0
  fi
  if [ -n "$RUNNER_MODEL_PROVIDER" ] || [ -n "$RUNNER_MODEL_ENDPOINT" ]; then
    say "OK    default model for new bots: ${RUNNER_MODEL_ID} on ${RUNNER_MODEL_PROVIDER:-$RUNNER_MODEL_ENDPOINT}"
    return 0
  fi
  input="${COZYGATEWAY_TEST_MODEL_PROMPT_INPUT:-/dev/tty}"
  if [ -z "${COZYGATEWAY_TEST_MODEL_PROMPT_INPUT:-}" ] && { [ ! -t 2 ] || [ ! -r /dev/tty ]; }; then
    say "INFO  no terminal to ask about a model on; set COZYRUNNER_MODEL_PROVIDER (or COZYRUNNER_MODEL_ENDPOINT) and COZYRUNNER_MODEL_ID in $COZYAGENTS_HOME_DIR/runner.env"
    return 0
  fi
  [ -r "$input" ] || return 0
  exec 6<"$input" || return 0
  while true; do
    printf 'Which provider should new bots use? A provider name (openai-codex) or a local endpoint URL (http://127.0.0.1:1234/v1) [openai-codex] ' >&2
    if ! IFS= read -r answer <&6; then answer=""; fi
    [ -n "$answer" ] || answer=openai-codex
    case "$answer" in
      http://*|https://*)
        if safe_model_endpoint "$answer"; then RUNNER_MODEL_ENDPOINT="$answer"; break; fi
        say 'That is not a usable endpoint URL.' >&2 ;;
      *)
        if safe_model_word "$answer"; then RUNNER_MODEL_PROVIDER="$answer"; break; fi
        say 'Provider names are letters, digits, and . _ : / -' >&2 ;;
    esac
  done
  while true; do
    printf 'Which model id should new bots use? ' >&2
    if ! IFS= read -r answer <&6; then answer=""; fi
    if safe_model_word "$answer"; then RUNNER_MODEL_ID="$answer"; break; fi
    say 'Model ids are letters, digits, and . _ : / -' >&2
  done
  if [ -n "$RUNNER_MODEL_PROVIDER" ] && codex_auth="$(detect_codex_login)"; then
    while true; do
      printf 'Share the Codex login on this computer (%s) with the bots that run here, so you never paste an API key? [y/N] ' "$codex_auth" >&2
      if ! IFS= read -r answer <&6; then answer=""; fi
      case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
        y|yes) RUNNER_SHARE_HOST_MODEL_AUTH=1; break ;;
        ''|n|no) break ;;
        *) say 'Please answer y or n.' >&2 ;;
      esac
    done
  fi
  exec 6<&-
  say "OK    default model for new bots: ${RUNNER_MODEL_ID} on ${RUNNER_MODEL_PROVIDER:-$RUNNER_MODEL_ENDPOINT}"
}

# The answers land in the runner env CozyAgents already reads, next to the pairing token and
# never in this installer's own state. No key is ever written here.
write_runner_model_env() {
  local file="$COZYAGENTS_HOME_DIR/runner.env"
  [ -n "$RUNNER_MODEL_PROVIDER" ] || [ -n "$RUNNER_MODEL_ENDPOINT" ] || return 0
  [ -n "$RUNNER_MODEL_ID" ] || return 0
  if [ "$DRY_RUN" = 1 ]; then say "DRY   write COZYRUNNER_MODEL_* into $file at 0600"; return 0; fi
  env_put "$file" COZYRUNNER_MODEL_ID "$RUNNER_MODEL_ID"
  if [ -n "$RUNNER_MODEL_PROVIDER" ]; then
    env_put "$file" COZYRUNNER_MODEL_PROVIDER "$RUNNER_MODEL_PROVIDER"
  else
    env_put "$file" COZYRUNNER_MODEL_ENDPOINT "$RUNNER_MODEL_ENDPOINT"
  fi
  [ "$RUNNER_SHARE_HOST_MODEL_AUTH" = 1 ] && env_put "$file" COZYRUNNER_SHARE_HOST_MODEL_AUTH 1
  say "OK    wrote the default model for new bots to $file"
  return 0
}

# One runner pairing code, minted here through the gateway's own storage and handed straight to
# the CozyAgents installer, so nobody types a code to pair the machine they are standing at.
mint_runner_pair_code() {
  local output
  output="$("$CLI_WRAPPER" pair --config "$CONFIG_JSON" --kind runner --ttl 10)" ||
    die "could not mint a runner pairing code; the gateway is installed, so retry with: $CLI_WRAPPER pair --kind runner"
  RUNNER_PAIR_CODE="$(printf '%s\n' "$output" | sed -n 's/^Setup code:[[:space:]]*//p' | head -1)"
  [[ "$RUNNER_PAIR_CODE" =~ ^[A-Za-z0-9-]{4,64}$ ]] ||
    die "the gateway did not return a usable runner pairing code"
}

cozyagents_launcher() { printf '%s/bin/cozyagents' "$COZYAGENTS_HOME_DIR"; }

# True only when the native Windows bootstrap is driving this run and owns the harness half.
windows_harness_owner() { is_windows && [ "${COZYGATEWAY_WINDOWS_HARNESS_OWNER:-}" = 1 ]; }

# The CozyAgents half of the install: its own verified one-liner does the bundle, the private
# Node, the launcher and the user service, and this installer pairs it, because it is the one
# side that can mint a runner code without asking anybody to read one off a screen.
install_cozyagents_harness() {
  local url stage installer launcher origin name
  url="${COZYAGENTS_INSTALL_URL:-$COZYAGENTS_INSTALL_URL_DEFAULT}"
  origin="${PUBLIC_URL:-$(gateway_origin)}"
  name="$(hostname 2>/dev/null || uname -n)"; name="${name%.local}"
  if [ "$DRY_RUN" = 1 ]; then
    say "DRY   install CozyAgents from $url with --no-pair, then pair it to $origin with a runner code minted here"
    return 0
  fi
  have curl || die "curl is required to install CozyAgents"
  stage="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-agents.XXXXXX")"; trap 'rm -rf "$stage"' RETURN
  installer="$stage/agents.sh"
  copy_or_download "$url" "$installer" || die "could not fetch the CozyAgents installer from $url"
  chmod 700 "$installer"
  say "INFO  installing CozyAgents, the harness that runs your bots on this machine."
  COZYAGENTS_HOME="$COZYAGENTS_HOME_DIR" bash "$installer" --no-pair --home "$COZYAGENTS_HOME_DIR" ||
    die "the CozyAgents install did not complete successfully"
  launcher="$(cozyagents_launcher)"
  [ -x "$launcher" ] || die "CozyAgents finished but $launcher is missing"
  # The code travels in the environment, never in argv: it is a credential in waiting, and argv is
  # readable by every process on this machine. `cozyagents runner pair` reads COZYAGENTS_PAIR_CODE
  # when no code is given on the command line.
  write_runner_model_env
  # A computer that is already paired keeps the runner credential it has: a second run upgrades
  # the harness and leaves the pairing, exactly as a second run leaves device trust alone.
  if [ -n "$(env_get "$COZYAGENTS_HOME_DIR/runner.env" COZYRUNNER_TOKEN)" ]; then
    say "OK    this computer is already paired to CozyGateway as a runner; keeping that pairing"
    rm -rf "$stage"; trap - RETURN
    return 0
  fi
  mint_runner_pair_code
  COZYAGENTS_PAIR_CODE="$RUNNER_PAIR_CODE" "$launcher" runner pair --gateway "$origin" --name "$name" --home "$COZYAGENTS_HOME_DIR" ||
    die "CozyAgents is installed but pairing did not complete; mint a code with \"$CLI_WRAPPER pair --kind runner\" and run: cozyagents runner pair <code> --gateway $origin"
  say "OK    CozyAgents is paired to $origin as \"$name\"; bots you make in CozyChat run here"
  rm -rf "$stage"; trap - RETURN
}

# profile names are shell/file-safe Hermes identifiers. Reject anything that
# could turn a plugin or spool path into a path traversal before constructing it.
valid_profile() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || [ "$1" = default ]; }
hydrate_profile_scope() {
  local profiles saved_scope p
  [ "$PROFILE_SPEC_EXPLICIT" = 0 ] && [ -f "$STATE_FILE" ] || return 0
  saved_scope="$(sed -n 's/^profile_scope=//p' "$STATE_FILE" | tail -1)"
  if [ "$saved_scope" = all ]; then
    PROFILE_SPEC=all
    return 0
  fi
  profiles="$(sed -n 's/^profiles=//p' "$STATE_FILE" | tail -1)"
  [ -n "$profiles" ] || die "installer state has an unsafe profile scope; rerun with --profiles all or an explicit profile list"
  IFS=',' read -r -a SELECTED <<<"$profiles"
  [ "${#SELECTED[@]}" -gt 0 ] || die "installer state has an unsafe profile scope; rerun with --profiles all or an explicit profile list"
  for p in "${SELECTED[@]}"; do valid_profile "$p" || die "installer state has an unsafe profile scope; rerun with --profiles all or an explicit profile list"; done
  PROFILE_SPEC="$profiles"
}
hermes_config_path() {
  local path
  path="$("$HERMES_BIN" -p "$1" config path 2>/dev/null)" || return
  to_posix_path "$path"
}
discover_root() {
  local default_config
  default_config="$(hermes_config_path default)" || die "could not ask Hermes for the default profile config path"
  [ -f "$default_config" ] || die "Hermes reported a missing default config: $default_config"
  dirname "$default_config"
}
profile_home() { if [ "$1" = default ]; then printf '%s' "$HERMES_ROOT"; else printf '%s/profiles/%s' "$HERMES_ROOT" "$1"; fi; }
discover_profiles() {
  local p home actual
  DISCOVERED=()
  [ -f "$HERMES_ROOT/config.yaml" ] && DISCOVERED+=(default)
  if [ -d "$HERMES_ROOT/profiles" ]; then
    for home in "$HERMES_ROOT"/profiles/*; do
      [ -d "$home" ] && [ -f "$home/config.yaml" ] || continue
      p="${home##*/}"; valid_profile "$p" || die "unsafe Hermes profile directory: $home"
      DISCOVERED+=("$p")
    done
  fi
  [ "${#DISCOVERED[@]}" -gt 0 ] || die "no Hermes profiles with config.yaml were found under $HERMES_ROOT"
  if [ "$PROFILE_SPEC" = all ]; then SELECTED=("${DISCOVERED[@]}"); else IFS=',' read -r -a SELECTED <<<"$PROFILE_SPEC"; fi
  [ "${#SELECTED[@]}" -gt 0 ] || die "--profiles cannot be empty"
  for p in "${SELECTED[@]}"; do
    valid_profile "$p" || die "invalid Hermes profile name: $p"
    home="$(profile_home "$p")"; [ -f "$home/config.yaml" ] || die "Hermes profile $p has no config at $home/config.yaml"
    actual="$(hermes_config_path "$p")" || die "Hermes cannot resolve profile $p"
    actual="$(cd -P "$(dirname "$actual")" && pwd)/$(basename "$actual")"
    [ "$actual" = "$home/config.yaml" ] || die "Hermes profile $p resolved to $actual, not the discovered $home/config.yaml"
  done
}

# Environment values are never command arguments. Keep existing unrelated keys
# byte-for-byte and replace only an installer-owned key through a mode-600 temp.
env_put() {
  local file="$1" key="$2" value="$3" temp
  [ "$DRY_RUN" = 1 ] && { say "DRY   set $key in $file (value redacted)"; return; }
  mkdir -p "$(dirname "$file")"; umask 077; temp="$(mktemp "${file}.tmp.XXXXXX")"
  [ -f "$file" ] && grep -v -E "^${key}=" "$file" > "$temp" || true
  printf '%s=%s\n' "$key" "$value" >> "$temp"; chmod 600 "$temp"; mv "$temp" "$file"; chmod 600 "$file"
}
env_remove_owned() {
  local file="$1" temp owner
  [ -f "$file" ] || return 0
  owner="$(sed -n "s/^${ENV_OWNER_KEY}=//p" "$file" | tail -1)"
  [ "$owner" = "$ENV_OWNER_VALUE" ] || return 0
  [ "$DRY_RUN" = 1 ] && { say "DRY   remove CozyGateway env keys from $file"; return; }
  umask 077; temp="$(mktemp "${file}.tmp.XXXXXX")"
  grep -v -E '^(COZYGATEWAY_URL|COZYGATEWAY_TOKEN|COZYGATEWAY_SPOOL_PATH|COZYGATEWAY_HOME_CHANNEL|COZYGATEWAY_INSTALLER_OWNER)=' "$file" > "$temp" || true
  chmod 600 "$temp"; mv "$temp" "$file"; chmod 600 "$file"
}
# Parse dotenv files with Node rather than ever evaluating them as shell. Hermes
# credentials are user-provided and may legally contain shell metacharacters.
env_get() {
  [ -f "$1" ] || return 0
  "$NODE_RESOLVED" -e 'const { readFileSync } = require("node:fs"); const { parseEnv } = require("node:util"); const value = parseEnv(readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (value !== undefined) process.stdout.write(value);' "$1" "$2"
}
safe_secret() { [[ "$1" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; }
env_write() {
  local file="$1" key="$2" value="$3"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "unsafe environment key: $key"
  [[ "$value" =~ ^[A-Za-z0-9_-]+$ ]] || die "installer-owned credentials must use the safe generated alphabet"
  printf '%s=%s\n' "$key" "$value" >> "$file"
}
claim_profile_env() {
  local file="$1" owner
  owner="$(env_get "$file" "$ENV_OWNER_KEY")"
  [ "$owner" = "$ENV_OWNER_VALUE" ] && return
  if [ -f "$file" ] && grep -Eq '^(COZYGATEWAY_URL|COZYGATEWAY_TOKEN|COZYGATEWAY_SPOOL_PATH|COZYGATEWAY_HOME_CHANNEL)=' "$file"; then
    die "$file already has CozyGateway keys not owned by this installer; remove or rename them before installing"
  fi
  env_put "$file" "$ENV_OWNER_KEY" "$ENV_OWNER_VALUE"
}
new_token() { if have openssl; then openssl rand -hex 32; else head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-48; fi; }
token_env_name() { printf 'COZYGATEWAY_ATTACH_TOKEN_%s' "$(printf '%s' "$1" | tr '[:lower:].-' '[:upper:]__')"; }
gateway_state() {
  local status
  status="$($HERMES_BIN -p "$1" gateway status 2>&1 || true)"
  case "$status" in
    *"not installed"*|*"not configured"*|*"No gateway service"*|*"Gateway service not found"*|*"hermes gateway install"*) printf 'absent' ;;
    *"Gateway is not running"*|*"Gateway is stopped"*|*"Gateway is inactive"*|*"No gateway process detected"*|*"Service definition exists locally but launchd has not loaded it"*) printf 'stopped' ;;
    *"Gateway is supervised"*|*"Gateway is running"*|*"Gateway is active"*|*"Gateway process running"*) printf 'running' ;;
    *) die "could not determine Hermes gateway service state for profile $1: $status" ;;
  esac
}

record_plugin_change() { PLUGIN_CHANGED_PROFILES+=("$1"); }
plugin_changed_for() {
  local profile="$1" changed
  for changed in "${PLUGIN_CHANGED_PROFILES[@]:-}"; do
    [ "$changed" = "$profile" ] && return 0
  done
  return 1
}
# The profile home has already been checked against Hermes' canonical config
# path. Do not let a later `plugins` or plugin-root symlink redirect an update
# outside that validated profile, even if a marker at the redirected location
# makes it appear installer-owned.
assert_plugin_target_path() {
  local home="$1" target="$2" plugins physical_home path
  physical_home="$(cd -P "$home" && pwd)" || die "could not resolve Hermes profile home for plugin installation: $home"
  [ "$physical_home" = "$home" ] || die "refusing symlinked Hermes profile home for plugin installation: $home"
  plugins="$home/plugins"
  for path in "$plugins" "$target"; do
    [ ! -L "$path" ] || die "refusing symlinked plugin path: $path"
    [ ! -e "$path" ] || [ -d "$path" ] || die "refusing non-directory plugin path: $path"
  done
}
# Plugin equality only applies to ordinary directory/file trees. A symlink,
# FIFO, device, socket, or other special entry is not benign cache noise: it
# can redirect Hermes loading or make a staged release compare as current while
# carrying content the installer never examined.
plugin_tree_is_safe() {
  local root="$1" entry
  [ -d "$root" ] && [ ! -L "$root" ] || return 1
  while IFS= read -r -d '' entry; do
    [ ! -L "$entry" ] || return 1
    { [ -d "$entry" ] || [ -f "$entry" ]; } || return 1
  done < <(find "$root" -mindepth 1 -print0)
}
# The release archive is already checksum-verified. Compare its extracted
# plugin tree with the installer-owned copy before replacing it so a repair is
# a true no-op for an already current profile. The marker is deliberately not
# in the archive and is excluded from the comparison.
plugin_content_matches_source() {
  local source="$1" target="$2" source_files target_files rel
  plugin_tree_is_safe "$source" || die "plugin archive contains an unsafe filesystem entry"
  plugin_tree_is_safe "$target" || die "refusing unsafe filesystem entry in installer-owned plugin: $target"
  source_files="$(cd "$source" && find . -type f ! -path '*/__pycache__/*' ! -name '*.pyc' -print | LC_ALL=C sort)"
  target_files="$(cd "$target" && find . -type f ! -path '*/__pycache__/*' ! -name '*.pyc' ! -name '.cozygateway-installer-owned' -print | LC_ALL=C sort)"
  [ "$source_files" = "$target_files" ] || return 1
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    cmp -s "$source/$rel" "$target/$rel" || return 1
  done <<EOF
$source_files
EOF
}

install_plugin() {
  local profile="$1" home="$2" target stage source
  target="$home/plugins/cozygateway"
  case "$target" in "$HERMES_ROOT"/plugins/cozygateway|"$HERMES_ROOT"/profiles/*/plugins/cozygateway) ;; *) die "refusing plugin target outside the validated Hermes profile tree" ;; esac
  assert_plugin_target_path "$home" "$target"
  if [ "$DRY_RUN" = 1 ]; then
    # Dry runs cannot safely extract the supplied archive into the profile, so
    # show the conservative lifecycle plan rather than claim a no-op.
    record_plugin_change "$profile"
    say "DRY   install verified attach plugin into $target for Hermes profile $profile"
    return
  fi
  stage="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-plugin.XXXXXX")"; trap 'rm -rf "$stage"' RETURN
  tar -xzf "$PLUGIN_ARCHIVE" -C "$stage"; source="$stage/attach-plugin"
  [ -f "$source/plugin.yaml" ] && [ -f "$source/__init__.py" ] || die "plugin archive is incomplete"
  plugin_tree_is_safe "$source" || die "plugin archive contains an unsafe filesystem entry"
  if [ -e "$target" ] && [ ! -f "$target/.cozygateway-installer-owned" ]; then
    die "$target already exists and is not owned by this installer"
  fi
  if [ -f "$target/.cozygateway-installer-owned" ] && plugin_content_matches_source "$source" "$target"; then
    rm -rf "$stage"; trap - RETURN
    say "OK    attach plugin already current for Hermes profile $profile"
    return
  fi
  mkdir -p "$home/plugins"; rm -rf "$target"; mv "$source" "$target"
  printf 'installed by cozygateway agent-install.sh\n' > "$target/.cozygateway-installer-owned"
  record_plugin_change "$profile"
  rm -rf "$stage"; trap - RETURN
}
enable_plugin() {
  local profile="$1"
  if [ "$DRY_RUN" = 1 ]; then say "DRY   enable verified attach plugin for Hermes profile $profile"; return; fi
  "$HERMES_BIN" -p "$profile" plugins enable cozygateway --no-allow-tool-override >/dev/null
}
# A CozyAgents-only gateway has no Hermes bridge at all: `hermesEndpoints` is absent rather than
# empty, and the roster comes from the runtime bots the runner reports.
write_cozyagents_gateway_config() {
  [ "$DRY_RUN" = 1 ] && { say "DRY   write CozyAgents-only gateway config at $CONFIG_JSON with no Hermes endpoint"; return; }
  # Taking a Hermes bridge out of a config is destructive and irreversible from here. main hands a
  # kept bridge to the Hermes path before this runs, so reaching it with one still in the file is a
  # bug rather than a default; the check below fails closed either way.
  umask 077
  "$NODE_RESOLVED" - "$CONFIG_JSON" "$BIND_HOST" "$PORT" "$LOCAL_DIR/cozygateway.sqlite" "$PUBLIC_URL" "$COZYAGENTS_CHOSEN" <<'NODE'
const fs = require('node:fs');
const [output, host, port, dbPath, publicUrl, chosen] = process.argv.slice(2);
let existing = {};
try {
  existing = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (existing === null || Array.isArray(existing) || typeof existing !== 'object') existing = {};
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const managed = { name: 'cozygateway', host, port: Number(port), dbPath, ...(publicUrl === '' ? {} : { publicUrl }) };
delete existing.publicUrl;
if (chosen === '1') {
  delete existing.hermesEndpoints;
  delete existing.hermes;
}
const temporary = `${output}.new`;
fs.writeFileSync(temporary, JSON.stringify({ ...existing, ...managed }, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(temporary, output);
NODE
  chmod 600 "$CONFIG_JSON"
}
write_cozyagents_gateway_env() {
  [ "$DRY_RUN" = 1 ] && { say "DRY   write gateway environment at $GATEWAY_ENV (no Hermes token, no secret values)"; return; }
  umask 077; : > "$GATEWAY_ENV"
  printf '%s=%s\n' "$ENV_OWNER_KEY" "$ENV_OWNER_VALUE" >> "$GATEWAY_ENV"
  chmod 600 "$GATEWAY_ENV"
}
# A Hermes bridge in a config that no one chose to replace freezes the run: main turns it into a
# Hermes install, which records harness=hermes through write_state, so the next run cannot read
# that kept bridge back as the explicit choice nobody made.
detect_kept_hermes_bridge() {
  KEPT_HERMES_BRIDGE=0
  [ "$COZYAGENTS_CHOSEN" = 0 ] || return 0
  [ -f "$CONFIG_JSON" ] || return 0
  grep -q '"hermesEndpoints"' "$CONFIG_JSON" && KEPT_HERMES_BRIDGE=1
  return 0
}
# cozyagents_home is recorded as this shell sees it, which on Windows is the Git Bash POSIX form
# of the default %USERPROFILE%\.cozyagents. Only the POSIX uninstall reads it, and only to run the
# launcher it names; the Windows bootstrap owns the harness there and never consults this line.
write_cozyagents_state() {
  local staged="$STATE_FILE.tmp.$$"
  [ "$DRY_RUN" = 1 ] && return
  umask 077
  {
    printf 'harness=cozyagents\n'
    printf 'cozyagents_home=%s\n' "$COZYAGENTS_HOME_DIR"
    printf 'node_resolved=%s\n' "$NODE_RESOLVED"
    printf 'bundle_path=%s\n' "$BUNDLE_PATH"
    printf 'supervisor=%s\n' "$SUPERVISOR"
    if is_windows; then printf 'task_xml=%s\n' "$WINDOWS_TASK_XML"; fi
  } > "$staged" || { rm -f "$staged"; return 1; }
  chmod 600 "$staged" || { rm -f "$staged"; return 1; }
  command -v sync >/dev/null 2>&1 && sync -f "$staged" 2>/dev/null || true
  mv -f "$staged" "$STATE_FILE" || { rm -f "$staged"; return 1; }
}
write_gateway_config() {
  local map="$LOCAL_DIR/profiles.json" p env_name comma=""
  [ "$DRY_RUN" = 1 ] && { say "DRY   write Hermes-only gateway config at $CONFIG_JSON (no secret values)"; return; }
  umask 077; printf '{' > "$map"
  for p in "${SELECTED[@]}"; do env_name="$(token_env_name "$p")"; printf '%s\n' "$comma\"$p\":{\"tokenEnv\":\"$env_name\"}" >> "$map"; comma=,; done
  printf '}\n' >> "$map"
  "$NODE_RESOLVED" - "$map" "$CONFIG_JSON" "$BIND_HOST" "$PORT" "$LOCAL_DIR/cozygateway.sqlite" "$DASHBOARD_PORT" "$PUBLIC_URL" <<'NODE'
const fs = require('node:fs');
const [mapPath, output, host, port, dbPath, dashboardPort, publicUrl] = process.argv.slice(2);
const profiles = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
let existing = {};
try {
  existing = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (existing === null || Array.isArray(existing) || typeof existing !== 'object') existing = {};
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const managed = {
  name: 'cozygateway', host, port: Number(port), dbPath, ...(publicUrl === '' ? {} : { publicUrl }),
  hermesEndpoints: [{ id: 'default', url: `ws://127.0.0.1:${dashboardPort}/api/ws`, authMode: 'token', tokenEnv: 'COZYGATEWAY_HERMES_TOKEN', profile: 'default', profiles }],
};
delete existing.publicUrl;
const temporary = `${output}.new`;
fs.writeFileSync(temporary, JSON.stringify({ ...existing, ...managed }, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(temporary, output);
NODE
  chmod 600 "$CONFIG_JSON" "$map"
}
prepare_dashboard_credential() {
  DASHBOARD_SESSION_TOKEN="$(env_get "$DASHBOARD_ENV" DASHBOARD_SESSION_TOKEN)"
  safe_secret "$DASHBOARD_SESSION_TOKEN" || DASHBOARD_SESSION_TOKEN="$(new_token)"
  [ "$DRY_RUN" = 1 ] && { say "DRY   reuse or mint local Hermes Dashboard credential in $DASHBOARD_ENV (value redacted)"; return; }
  umask 077
  : > "$DASHBOARD_ENV"
  env_write "$DASHBOARD_ENV" DASHBOARD_SESSION_TOKEN "$DASHBOARD_SESSION_TOKEN"
  chmod 600 "$DASHBOARD_ENV"
}
write_gateway_env() {
  local p token env_name profile_env spool_path seen_token seen_name
  prepare_dashboard_credential
  [ "$DRY_RUN" = 1 ] && { say "DRY   write gateway token environment at $GATEWAY_ENV (values redacted)"; return; }
  umask 077; : > "$GATEWAY_ENV"
  env_write "$GATEWAY_ENV" COZYGATEWAY_HERMES_TOKEN "$DASHBOARD_SESSION_TOKEN"
  for p in "${SELECTED[@]}"; do
    profile_env="$(profile_home "$p")/.env"; claim_profile_env "$profile_env"; token="$(env_get "$profile_env" COZYGATEWAY_TOKEN)"; safe_secret "$token" || token="$(new_token)"; env_name="$(token_env_name "$p")"
    for seen_token in "${TOKENS[@]:-}"; do [ "$token" != "$seen_token" ] || die "Hermes profiles must have distinct CozyGateway attach tokens"; done
    for seen_name in "${TOKEN_ENVS[@]:-}"; do [ "$env_name" != "$seen_name" ] || die "profile names produce the same token environment variable: $env_name"; done
    TOKENS+=("$token"); TOKEN_ENVS+=("$env_name")
    env_put "$profile_env" COZYGATEWAY_URL "$(gateway_origin)"; env_put "$profile_env" COZYGATEWAY_TOKEN "$token"
    spool_path="$(profile_home "$p")/plugin-data/cozygateway/attach-v1.sqlite"
    is_windows && spool_path="$(to_windows_path "$spool_path")"
    env_put "$profile_env" COZYGATEWAY_SPOOL_PATH "$spool_path"; env_put "$profile_env" COZYGATEWAY_HOME_CHANNEL thread
    env_write "$GATEWAY_ENV" "$env_name" "$token"
  done
  chmod 600 "$GATEWAY_ENV"
}
service_action_for() {
  local profile="$1" index
  for index in "${!SERVICE_PROFILES[@]}"; do
    [ "${SERVICE_PROFILES[$index]}" = "$profile" ] && { printf '%s' "${SERVICE_ACTIONS[$index]}"; return; }
  done
  die "missing Hermes gateway lifecycle state for profile $profile"
}
prior_service_action() {
  local profile="$1" action
  [ -f "$STATE_FILE" ] || return 0
  action="$(awk -F= -v key="service_$profile" '$1 == key { value = $2 } END { if (value != "") print value }' "$STATE_FILE")"
  case "$action" in '') ;; unknown) return 0 ;; preexisting|started|installed) printf '%s' "$action" ;; *) die "invalid Hermes gateway lifecycle state for profile $profile" ;; esac
}
record_service_action() {
  local index
  for index in "${!SERVICE_PROFILES[@]}"; do
    [ "${SERVICE_PROFILES[$index]}" = "$1" ] && { SERVICE_ACTIONS[index]="$2"; return; }
  done
  SERVICE_PROFILES+=("$1"); SERVICE_ACTIONS+=("$2")
}
ensure_hermes_gateways() {
  local profile state prior action
  for profile in "${SELECTED[@]}"; do
    state="$(gateway_state "$profile")"; prior="$(prior_service_action "$profile")"
    case "$state" in
      running)
        if plugin_changed_for "$profile"; then
          run "$HERMES_BIN" -p "$profile" gateway restart
          say "OK    restarted Hermes gateway service for profile $profile"
        else
          say "OK    Hermes gateway service for profile $profile is already running with the current attach plugin"
        fi
        action="${prior:-preexisting}"
        ;;
      stopped)
        run "$HERMES_BIN" -p "$profile" gateway start
        action="${prior:-started}"
        say "OK    started existing Hermes gateway service for profile $profile"
        ;;
      absent)
        run "$HERMES_BIN" -p "$profile" gateway install --start-now --start-on-login
        action=installed
        say "OK    installed and started Hermes gateway service for profile $profile"
        ;;
    esac
    record_service_action "$profile" "$action"
  done
}
write_state() {
  local profile staged="$STATE_FILE.tmp.$$"
  [ "$DRY_RUN" = 1 ] && return
  umask 077
  {
    printf 'harness=hermes\n'
    printf 'profiles='; (IFS=,; printf '%s' "${SELECTED[*]}")
    printf '\nprofile_scope=%s' "$PROFILE_SPEC"
    printf '\nhermes_root=%s\n' "$HERMES_ROOT"
    printf 'dashboard_port=%s\n' "$DASHBOARD_PORT"
    # Keep the exact executable that performed the install. `--uninstall` may
    # run long after PATH or COZYGATEWAY_HERMES_BIN changed, and must not tear
    # down the CozyGateway service before discovering it cannot reverse the
    # Hermes work it owns.
    printf 'hermes_bin=%s\n' "$HERMES_RESOLVED"
    printf 'node_resolved=%s\n' "$NODE_RESOLVED"
    printf 'bundle_path=%s\n' "$BUNDLE_PATH"
    printf 'supervisor=%s\n' "$SUPERVISOR"
    if is_windows; then printf 'task_xml=%s\n' "$WINDOWS_TASK_XML"; fi
    for profile in "${SELECTED[@]}"; do printf 'service_%s=%s\n' "$profile" "$(service_action_for "$profile")"; done
  } > "$staged" || { rm -f "$staged"; return 1; }
  chmod 600 "$staged" || { rm -f "$staged"; return 1; }
  command -v sync >/dev/null 2>&1 && sync -f "$staged" 2>/dev/null || true
  mv -f "$staged" "$STATE_FILE" || { rm -f "$staged"; return 1; }
}
resolve_platform() { normalize_service_platform; }
preflight_service_manager() {
  resolve_platform
  [ "$DRY_RUN" = 1 ] && return
  if [ "$SERVICE_PLATFORM" = Darwin ]; then
    have launchctl || die "launchd is unavailable; CozyGateway needs a macOS user login service"
  elif [ "$SERVICE_PLATFORM" = Linux ]; then
    have systemctl || die "systemd --user is unavailable; CozyGateway cannot install persistently in this Linux environment"
    have loginctl || die "systemd-logind is unavailable; install systemd-login or use a host with user services"
    systemctl --user show-environment >/dev/null 2>&1 || die "no systemd user manager is running; containers and WSL without systemd are not supported"
  fi
}
write_cli_wrapper() {
  local node_native bundle_native local_native bootstrap_native bootstrap_b64
  [ "$DRY_RUN" = 1 ] && { say "DRY   write executable gateway CLI at $CLI_WRAPPER"; return; }
  mkdir -p "$GATEWAY_DIR/bin"
  umask 022
  cat > "$CLI_WRAPPER" <<CLI
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = repair ] || [ "\${1:-}" = update ]; then
  [ "\$#" = 1 ] || { printf 'FAIL  repair does not accept extra arguments\n' >&2; exit 1; }
  bootstrap=$(printf %q "$POSIX_BOOTSTRAP")
  checksum="\$bootstrap.sha256"
  state=$(printf %q "$STATE_FILE")
  reinstall='curl -fsSL https://cozylabs.ai/install.sh | bash'
  [ -f "\$bootstrap" ] && [ -f "\$checksum" ] || { printf 'FAIL  repair bootstrap is unavailable. Reinstall with: %s\n' "\$reinstall" >&2; exit 1; }
  [ -r "\$state" ] || { printf 'FAIL  repair metadata is unavailable. Reinstall with: %s\n' "\$reinstall" >&2; exit 1; }
  expected="\$(awk '{print \$1}' "\$checksum")"
  if command -v shasum >/dev/null 2>&1; then actual="\$(shasum -a 256 "\$bootstrap" | awk '{print \$1}')"; elif command -v sha256sum >/dev/null 2>&1; then actual="\$(sha256sum "\$bootstrap" | awk '{print \$1}')"; else printf 'FAIL  repair needs shasum or sha256sum. Reinstall with: %s\n' "\$reinstall" >&2; exit 1; fi
  [ -n "\$expected" ] && [ "\$expected" = "\$actual" ] || { printf 'FAIL  repair bootstrap checksum mismatch. Reinstall with: %s\n' "\$reinstall" >&2; exit 1; }
  harness="\$(sed -n 's/^harness=//p' "\$state" | tail -1)"
  if [ "\$harness" = cozyagents ]; then
    printf 'INFO  repair refreshes verified runtime assets, then restarts CozyGateway\n'
    exec env COZYGATEWAY_HOME=$(printf %q "$GATEWAY_DIR") bash "\$bootstrap" --harness cozyagents
  fi
  profiles="\$(sed -n 's/^profiles=//p' "\$state" | tail -1)"
  profile_scope="\$(sed -n 's/^profile_scope=//p' "\$state" | tail -1)"
  if [ "\$profile_scope" = all ]; then
    profiles=all
  else
    [[ "\$profiles" =~ ^(default|[A-Za-z0-9][A-Za-z0-9._-]{0,63})(,(default|[A-Za-z0-9][A-Za-z0-9._-]{0,63}))*\$ ]] || { printf 'FAIL  repair metadata is unavailable. Reinstall with: %s\n' "\$reinstall" >&2; exit 1; }
  fi
  printf 'INFO  repair refreshes verified runtime and plugin assets, then restarts CozyGateway and Hermes attachment\n'
  exec env COZYGATEWAY_HOME=$(printf %q "$GATEWAY_DIR") bash "\$bootstrap" --profiles "\$profiles"
fi
cd $(printf %q "$LOCAL_DIR")
exec $(printf %q "$NODE_RESOLVED") $(printf %q "$BUNDLE_PATH") "\$@"
CLI
  chmod 755 "$CLI_WRAPPER"
  if is_windows; then
    node_native="$(to_windows_path "$NODE_RESOLVED")"
    bundle_native="$(to_windows_path "$BUNDLE_PATH")"
    local_native="$(to_windows_path "$LOCAL_DIR")"
    bootstrap_native="$(to_windows_path "$WINDOWS_BOOTSTRAP")"
    bootstrap_b64="$(printf '%s' "$bootstrap_native" | base64 | tr -d '\r\n')"
    {
      printf '@echo off\r\n'
      printf 'if /I "%%~1"=="repair" goto repair\r\n'
      printf 'if /I "%%~1"=="update" goto repair\r\n'
      printf 'cd /d "%s"\r\n' "$local_native"
      printf '"%s" "%s" %%*\r\n' "$node_native" "$bundle_native"
      printf 'exit /b %%errorlevel%%\r\n'
      printf ':repair\r\n'
      printf 'if not "%%~2"=="" (echo FAIL  repair does not accept extra arguments & exit /b 1)\r\n'
      printf 'if not exist "%s" (echo FAIL  repair bootstrap is unavailable. Reinstall with: irm https://cozylabs.ai/install.ps1 ^| iex & exit /b 1)\r\n' "$bootstrap_native"
      printf 'if not exist "%s.sha256" (echo FAIL  repair bootstrap is unavailable. Reinstall with: irm https://cozylabs.ai/install.ps1 ^| iex & exit /b 1)\r\n' "$bootstrap_native"
      printf "\"%s\" -NoProfile -NonInteractive -Command \"\$ErrorActionPreference='Stop';try {\$p=[IO.Path]::GetFullPath([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('%s')));\$expected=((Get-Content -LiteralPath (\$p+'.sha256') -Raw).Trim() -split '\\s+')[0].ToLowerInvariant();\$actual=(Get-FileHash -LiteralPath \$p -Algorithm SHA256).Hash.ToLowerInvariant();if([string]::IsNullOrWhiteSpace(\$expected) -or \$expected -ne \$actual){exit 1};exit 0}catch{exit 1}\"\r\n" "$WINDOWS_POWERSHELL" "$bootstrap_b64"
      printf 'if errorlevel 1 (echo FAIL  repair bootstrap checksum mismatch. Reinstall with: irm https://cozylabs.ai/install.ps1 ^| iex & exit /b 1)\r\n'
      printf 'set "COZYGATEWAY_HOME=%s"\r\n' "$(to_windows_path "$GATEWAY_DIR")"
      printf '"%s" -NoProfile -ExecutionPolicy Bypass -File "%s" -Repair\r\n' "$WINDOWS_POWERSHELL" "$bootstrap_native"
      printf 'exit /b %%errorlevel%%\r\n'
    } > "$CLI_WINDOWS"
    chmod 755 "$CLI_WINDOWS" 2>/dev/null || true
  fi
}
CLI_PATH_LINE='export PATH="$HOME/.local/bin:$PATH" # CozyGateway CLI'
install_posix_cli() {
  local link="$HOME/.local/bin/cozygateway" profile current
  [ "$DRY_RUN" = 1 ] && { say "DRY   expose the cozygateway command through $link"; return; }
  mkdir -p "$HOME/.local/bin"
  if [ -L "$link" ]; then
    current="$(readlink "$link")"
    [ "$current" = "$CLI_WRAPPER" ] || die "refusing to replace an unrelated command at $link"
  elif [ -e "$link" ]; then
    cmp -s "$link" "$CLI_WRAPPER" || die "refusing to replace an unrelated command at $link"
  else
    ln -s "$CLI_WRAPPER" "$link"
  fi
  profile="$HOME/.profile"
  grep -Fqx "$CLI_PATH_LINE" "$profile" 2>/dev/null || printf '%s\n' "$CLI_PATH_LINE" >> "$profile"
  if [ "$SERVICE_PLATFORM" = Darwin ]; then
    profile="$HOME/.zprofile"
    grep -Fqx "$CLI_PATH_LINE" "$profile" 2>/dev/null || printf '%s\n' "$CLI_PATH_LINE" >> "$profile"
  fi
  say "OK    the cozygateway command is available in new terminal sessions"
}
remove_posix_cli() {
  local link="$HOME/.local/bin/cozygateway" profile
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$CLI_WRAPPER" ]; then rm -f "$link"; fi
  if [ -f "$link" ] && cmp -s "$link" "$CLI_WRAPPER"; then rm -f "$link"; fi
  for profile in "$HOME/.profile" "$HOME/.zprofile"; do
    [ -f "$profile" ] || continue
    (
      umask 077
      temp="$(mktemp "$profile.cozygateway.XXXXXX")"
      trap 'rm -f "$temp"' EXIT HUP INT TERM
      grep -Fvx "$CLI_PATH_LINE" "$profile" > "$temp" || true
      cat "$temp" > "$profile"
    )
  done
}
remove_windows_cli_path() {
  local bin_native
  bin_native="$(to_windows_path "$GATEWAY_DIR/bin")"
  MSYS_NO_PATHCONV=1 COZYGATEWAY_CLI_BIN="$bin_native" powershell.exe -NoProfile -NonInteractive -Command '
    $target = [IO.Path]::GetFullPath($env:COZYGATEWAY_CLI_BIN).TrimEnd("\")
    $parts = @([Environment]::GetEnvironmentVariable("PATH", "User") -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_.TrimEnd("\") -ine $target })
    [Environment]::SetEnvironmentVariable("PATH", ($parts -join ";"), "User")
  '
}
write_dashboard_owner_helper() {
  [ "$DRY_RUN" = 1 ] && return
  umask 077; cat > "$DASHBOARD_OWNER_PS1" <<'POWERSHELL_OWNER'
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$ExpectedRoot,
  [Parameter(Mandatory = $true, Position = 1)][string]$ExpectedHermes,
  [Parameter(Mandatory = $true, Position = 2)][string]$ExpectedLauncher,
  [Parameter(Mandatory = $true, Position = 3)][ValidateRange(1, 65535)][int]$ExpectedPort,
  [switch]$ElevatedChild
)
$ErrorActionPreference = "Stop"
# ElevatedChild marks the terminal scoped-UAC invocation. This ownership helper
# never launches another process or requests elevation itself.
# COZYGATEWAY_DASHBOARD_OWNER_BEGIN
function Initialize-CozyNativeDirectoryApi {
  if ($null -ne $script:CozyNativeDirectoryApi) { return }
  $assemblyName = [Reflection.AssemblyName]::new("CozyGateway.NativeDirectory." + [guid]::NewGuid().ToString("N"))
  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $moduleBuilder = $assemblyBuilder.DefineDynamicModule("NativeDirectory")
  $typeBuilder = $moduleBuilder.DefineType("CozyGatewayNativeDirectory", [Reflection.TypeAttributes] "Public, Sealed, Abstract")
  $dllImportConstructor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]] @([string]))
  $dllImportFields = [Reflection.FieldInfo[]] @(
    [Runtime.InteropServices.DllImportAttribute].GetField("EntryPoint"),
    [Runtime.InteropServices.DllImportAttribute].GetField("CharSet"),
    [Runtime.InteropServices.DllImportAttribute].GetField("CallingConvention"),
    [Runtime.InteropServices.DllImportAttribute].GetField("SetLastError"),
    [Runtime.InteropServices.DllImportAttribute].GetField("PreserveSig")
  )
  foreach ($definition in @(
    @{ Name = "GetSystemDirectoryW"; ReturnType = [uint32]; Parameters = [Type[]] @([Text.StringBuilder], [uint32]) },
    @{ Name = "GetWindowsDirectoryW"; ReturnType = [uint32]; Parameters = [Type[]] @([Text.StringBuilder], [uint32]) }
  )) {
    $method = $typeBuilder.DefineMethod(
      [string]$definition.Name, [Reflection.MethodAttributes] "Public, Static, PinvokeImpl",
      [Type]$definition.ReturnType, [Type[]]$definition.Parameters
    )
    $dllImportValues = [object[]] @(
      [string]$definition.Name,
      [Runtime.InteropServices.CharSet]::Unicode,
      [Runtime.InteropServices.CallingConvention]::Winapi,
      $true,
      $true
    )
    $dllImport = [Reflection.Emit.CustomAttributeBuilder]::new(
      $dllImportConstructor, [object[]] @("kernel32.dll"), $dllImportFields, $dllImportValues
    )
    $method.SetCustomAttribute($dllImport)
  }
  $script:CozyNativeDirectoryApi = $typeBuilder.CreateType()
}
function Get-CozyNativeDirectory {
  param([ValidateSet("System", "Windows")][string]$Kind)
  Initialize-CozyNativeDirectoryApi
  $methodName = if ($Kind -eq "System") { "GetSystemDirectoryW" } else { "GetWindowsDirectoryW" }
  $method = $script:CozyNativeDirectoryApi.GetMethod($methodName)
  $capacity = 260
  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    $buffer = [Text.StringBuilder]::new($capacity)
    $arguments = [object[]] @($buffer, [uint32]$capacity)
    $length = [uint32]$method.Invoke($null, $arguments)
    if ($length -eq 0) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "$methodName failed with Win32 error $errorCode"
    }
    if ($length -lt [uint32]$capacity) {
      $value = $buffer.ToString()
      if ($value.Length -ne [int]$length -or -not [IO.Path]::IsPathRooted($value) -or -not [IO.Directory]::Exists($value)) {
        throw "$methodName returned an invalid directory"
      }
      return [IO.Path]::GetFullPath($value)
    }
    if ($length -gt 32768) { throw "$methodName returned an invalid buffer length" }
    $capacity = [int]$length
  }
  throw "$methodName did not fit within the validated buffer limit"
}
function Resolve-CozySystemExecutable {
  param([string]$Name)
  if ([string]::IsNullOrWhiteSpace($Name) -or [IO.Path]::GetFileName($Name) -cne $Name) { throw "invalid system executable name" }
  $path = [IO.Path]::GetFullPath([IO.Path]::Combine((Get-CozyNativeDirectory "System"), $Name))
  if (-not [IO.File]::Exists($path)) { throw "trusted system executable is unavailable: $Name" }
  return $path
}
function Get-CozyDashboardProfileEvidence {
  param([object[]]$Tokens, [int]$StartIndex)
  # Keep this snapshot aligned with Hermes v2026.8.27's
  # hermes_cli._parser.top_level_value_flag_sets(). The profile pre-parser
  # skips these values before looking for -p/--profile anywhere in argv.
  $requiredValueFlags = @(
    "-z", "--oneshot", "-m", "--model", "--provider", "--reasoning",
    "-t", "--toolsets", "-r", "--resume", "-s", "--skills",
    "--usage-file", "--in"
  )
  $optionalValueFlags = @("-c", "--continue")
  $profileIndexes = New-Object 'System.Collections.Generic.HashSet[int]'
  $valueIndexes = New-Object 'System.Collections.Generic.HashSet[int]'
  $profileValue = $null
  $selectorCount = 0
  $boundaryIndex = $Tokens.Count
  $invalidSelector = $false
  $isolated = $false
  $index = $StartIndex
  while ($index -lt $Tokens.Count) {
    $token = [string]$Tokens[$index]
    if ($token -eq "--") { $boundaryIndex = $index; break }
    if ($token -in @("-p", "--profile")) {
      $selectorCount++
      [void]$profileIndexes.Add($index)
      if ($index + 1 -ge $Tokens.Count) { $invalidSelector = $true; break }
      [void]$profileIndexes.Add($index + 1)
      $candidate = [string]$Tokens[$index + 1]
      if ($candidate -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$') { $invalidSelector = $true }
      if ($selectorCount -eq 1) { $profileValue = $candidate }
      $index += 2
      continue
    }
    if ($token.StartsWith("--profile=", [StringComparison]::Ordinal)) {
      $selectorCount++
      [void]$profileIndexes.Add($index)
      $candidate = $token.Substring("--profile=".Length)
      if ($candidate -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$') { $invalidSelector = $true }
      if ($selectorCount -eq 1) { $profileValue = $candidate }
      $index++
      continue
    }
    if ($token -in $requiredValueFlags -and -not $token.Contains("=")) {
      [void]$valueIndexes.Add($index)
      if ($index + 1 -ge $Tokens.Count) { $index++; continue }
      [void]$valueIndexes.Add($index + 1)
      $index += 2
      continue
    }
    if ($token -in $optionalValueFlags -and -not $token.Contains("=")) {
      [void]$valueIndexes.Add($index)
      if ($index + 1 -lt $Tokens.Count -and -not ([string]$Tokens[$index + 1]).StartsWith("-", [StringComparison]::Ordinal)) {
        [void]$valueIndexes.Add($index + 1)
        $index += 2
      } else {
        $index++
      }
      continue
    }
    if ($token -eq "--isolated") { $isolated = $true }
    $index++
  }
  $state = if ($invalidSelector -or $selectorCount -ne 1) {
    "Ambiguous"
  } elseif ($profileValue -ceq "default") {
    "Default"
  } else {
    "Named"
  }
  return [pscustomobject]@{
    State = $state
    BoundaryIndex = $boundaryIndex
    Isolated = $isolated
    ProfileIndexes = $profileIndexes
    ValueIndexes = $valueIndexes
  }
}
function Find-CozyDashboardSubcommand {
  param([object[]]$Tokens, [int]$StartIndex, $ProfileEvidence)
  $requiredValueFlags = @(
    "-z", "--oneshot", "-m", "--model", "--provider", "--reasoning",
    "-t", "--toolsets", "-r", "--resume", "-s", "--skills",
    "--usage-file", "--in"
  )
  $optionalValueFlags = @("-c", "--continue")
  $booleanFlags = @(
    "--version", "-V", "--no-restore-cwd", "--worktree", "-w",
    "--accept-hooks", "--yolo", "--pass-session-id", "--ignore-user-config",
    "--ignore-rules", "--safe-mode", "--tui", "--cli", "--quiet", "-q",
    "--verbose", "-v", "--dev"
  )
  for ($index = $StartIndex; $index -lt $ProfileEvidence.BoundaryIndex; $index++) {
    $token = [string]$Tokens[$index]
    if ($ProfileEvidence.ProfileIndexes.Contains($index)) { continue }
    if ($ProfileEvidence.ValueIndexes.Contains($index)) {
      if ($token -in $requiredValueFlags -and ($index + 1 -ge $ProfileEvidence.BoundaryIndex -or ([string]$Tokens[$index + 1]).StartsWith("-", [StringComparison]::Ordinal))) { return -1 }
      continue
    }
    if ($token -in $booleanFlags) { continue }
    $inlineValueFlag = $false
    foreach ($flag in @($requiredValueFlags + $optionalValueFlags)) {
      if ($token.StartsWith(($flag + "="), [StringComparison]::Ordinal) -and $token.Length -gt $flag.Length + 1) { $inlineValueFlag = $true; break }
    }
    if ($inlineValueFlag) { continue }
    if ($token.StartsWith("-", [StringComparison]::Ordinal)) { return -1 }
    if ($token -ceq "dashboard") { return $index }
    return -1
  }
  return -1
}
function Test-CozyDashboardOwner {
  param(
    $Process,
    [string]$ExpectedRoot,
    [string]$ExpectedHermes,
    [string]$ExpectedLauncher,
    [int]$ExpectedPort,
    [scriptblock]$ResolveProcess
  )
  $root = [IO.Path]::GetFullPath($ExpectedRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $hermes = [IO.Path]::GetFullPath($ExpectedHermes)
  $launcher = [IO.Path]::GetFullPath($ExpectedLauncher)
  $venvLauncher = [IO.Path]::GetFullPath([IO.Path]::Combine($root, "hermes-agent", "venv", "Scripts", "hermes.exe"))
  if ($null -eq $Process -or [string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath) -or [string]::IsNullOrWhiteSpace([string]$Process.CommandLine)) {
    return "Indeterminate"
  }
  $tokens = @([regex]::Matches([string]$Process.CommandLine, "[^\s`"]+|`"[^`"]*`"") | ForEach-Object { $_.Value.Trim([char]34) })
  $dashboardIndex = -1
  $profileEvidence = $null
  $requiresRootAncestry = $false
  $scriptSuffix = [IO.Path]::DirectorySeparatorChar + "hermes_cli" + [IO.Path]::DirectorySeparatorChar + "main.py"
  $processExecutable = $null
  $firstToken = $null
  $secondToken = $null
  try { $processExecutable = [IO.Path]::GetFullPath([string]$Process.ExecutablePath) } catch { return "Foreign" }
  if ($tokens.Count -gt 0) { try { $firstToken = [IO.Path]::GetFullPath($tokens[0]) } catch {} }
  if ($tokens.Count -gt 1) { try { $secondToken = [IO.Path]::GetFullPath($tokens[1]) } catch {} }
  $firstIsExecutable = $null -ne $processExecutable -and $null -ne $firstToken -and $firstToken.Equals($processExecutable, [StringComparison]::OrdinalIgnoreCase)
  if (-not $firstIsExecutable) { return "Foreign" }
  $pythonRuntime = $firstIsExecutable -and @("python.exe", "pythonw.exe") -contains [IO.Path]::GetFileName($processExecutable).ToLowerInvariant()
  $directLauncher = $firstIsExecutable -and ($firstToken.Equals($hermes, [StringComparison]::OrdinalIgnoreCase) -or $firstToken.Equals($launcher, [StringComparison]::OrdinalIgnoreCase))
  if ($directLauncher) {
    $profileEvidence = Get-CozyDashboardProfileEvidence $tokens 1
    $dashboardIndex = Find-CozyDashboardSubcommand $tokens 1 $profileEvidence
  } elseif ($pythonRuntime -and $tokens.Count -gt 1 -and $null -ne $secondToken -and ($secondToken.Equals($hermes, [StringComparison]::OrdinalIgnoreCase) -or $secondToken.Equals($launcher, [StringComparison]::OrdinalIgnoreCase) -or $secondToken.Equals($venvLauncher, [StringComparison]::OrdinalIgnoreCase))) {
    $profileEvidence = Get-CozyDashboardProfileEvidence $tokens 2
    $dashboardIndex = Find-CozyDashboardSubcommand $tokens 2 $profileEvidence
  } elseif ($pythonRuntime -and $tokens.Count -gt 2 -and $tokens[1] -eq "-m" -and $tokens[2] -eq "hermes_cli.main") {
    $profileEvidence = Get-CozyDashboardProfileEvidence $tokens 3
    $dashboardIndex = Find-CozyDashboardSubcommand $tokens 3 $profileEvidence
    if ($dashboardIndex -ge 0) { $requiresRootAncestry = $true }
  } elseif ($pythonRuntime -and $tokens.Count -gt 1 -and $null -ne $secondToken -and $secondToken.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and $secondToken.EndsWith($scriptSuffix, [StringComparison]::OrdinalIgnoreCase)) {
    $profileEvidence = Get-CozyDashboardProfileEvidence $tokens 2
    $dashboardIndex = Find-CozyDashboardSubcommand $tokens 2 $profileEvidence
  }
  if ($dashboardIndex -lt 0) { return "Foreign" }
  if ($profileEvidence.State -ne "Default" -or $profileEvidence.Isolated -or $profileEvidence.BoundaryIndex -lt $tokens.Count) { return "Foreign" }

  if ($requiresRootAncestry) {
    $runtimeUnderRoot = $false
    $runtimeMetadataMissing = $false
    $candidate = $Process
    for ($depth = 0; $depth -lt 6 -and $null -ne $candidate; $depth++) {
      if ([string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath)) {
        $runtimeMetadataMissing = $true
      } else {
        try {
          if ([IO.Path]::GetFullPath([string]$candidate.ExecutablePath).StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
            $runtimeUnderRoot = $true
            break
          }
        } catch { return "Foreign" }
      }
      if (-not $candidate.ParentProcessId) { break }
      $candidate = & $ResolveProcess ([int]$candidate.ParentProcessId)
      if ($null -eq $candidate) { $runtimeMetadataMissing = $true; break }
    }
    if (-not $runtimeUnderRoot) {
      if ($runtimeMetadataMissing) { return "Indeterminate" }
      return "Foreign"
    }
  }

  # Validate the complete Dashboard option grammar relevant to ownership.
  # Profile tokens are removed by Hermes before argparse; other top-level
  # value flags are invalid after the subcommand and therefore fail closed.
  $portCount = 0
  $portMatches = $false
  for ($index = $dashboardIndex + 1; $index -lt $tokens.Count; $index++) {
    if ($profileEvidence.ProfileIndexes.Contains($index)) { continue }
    if ($profileEvidence.ValueIndexes.Contains($index)) { return "Foreign" }
    $token = [string]$tokens[$index]
    if ($token -eq "--port") {
      if ($index + 1 -ge $tokens.Count -or $profileEvidence.ProfileIndexes.Contains($index + 1) -or ([string]$tokens[$index + 1]).StartsWith("-", [StringComparison]::Ordinal)) { return "Foreign" }
      $portCount++
      $portMatches = ([string]$tokens[$index + 1] -ceq [string]$ExpectedPort)
      $index++
      continue
    }
    if ($token.StartsWith("--port=", [StringComparison]::Ordinal)) {
      $portCount++
      $portMatches = ($token.Substring("--port=".Length) -ceq [string]$ExpectedPort)
      continue
    }
    if ($token -in @("--host", "--open-profile")) {
      if ($index + 1 -ge $tokens.Count -or $profileEvidence.ProfileIndexes.Contains($index + 1) -or ([string]$tokens[$index + 1]).StartsWith("-", [StringComparison]::Ordinal)) { return "Foreign" }
      $index++
      continue
    }
    if ($token.StartsWith("--host=", [StringComparison]::Ordinal) -or $token.StartsWith("--open-profile=", [StringComparison]::Ordinal)) { continue }
    if ($token -in @("--insecure", "--skip-build", "--no-open", "--tui")) { continue }
    return "Foreign"
  }
  if ($portCount -eq 1 -and $portMatches) { return "Owned" }
  return "Foreign"
}

function Stop-CozyDashboardOwner {
  param(
    [string]$ExpectedRoot,
    [string]$ExpectedHermes,
    [string]$ExpectedLauncher,
    [int]$ExpectedPort,
    [scriptblock]$ResolveListener,
    [scriptblock]$ResolveProcess,
    [scriptblock]$KillTree,
    [scriptblock]$Sleep
  )
  try { $firstListener = & $ResolveListener } catch { return 43 }
  if ($null -eq $firstListener) { return 0 }
  try { $firstProcess = & $ResolveProcess ([int]$firstListener.OwningProcess) } catch { return 43 }
  if ($null -eq $firstProcess -or [int]$firstProcess.ProcessId -ne [int]$firstListener.OwningProcess) { return 43 }
  try {
    $firstOwner = Test-CozyDashboardOwner -Process $firstProcess -ExpectedRoot $ExpectedRoot -ExpectedHermes $ExpectedHermes -ExpectedLauncher $ExpectedLauncher -ExpectedPort $ExpectedPort -ResolveProcess $ResolveProcess
  } catch { return 43 }
  if ($firstOwner -eq "Foreign") { return 42 }
  if ($firstOwner -ne "Owned" -or [string]::IsNullOrWhiteSpace([string]$firstProcess.CreationDate)) { return 43 }

  try { $secondListener = & $ResolveListener } catch { return 45 }
  if ($null -eq $secondListener -or [int]$secondListener.OwningProcess -ne [int]$firstListener.OwningProcess) { return 45 }
  try { $secondProcess = & $ResolveProcess ([int]$secondListener.OwningProcess) } catch { return 45 }
  if ($null -eq $secondProcess -or [int]$secondProcess.ProcessId -ne [int]$secondListener.OwningProcess -or [string]::IsNullOrWhiteSpace([string]$secondProcess.CreationDate) -or
      -not ([string]$secondProcess.CreationDate).Equals([string]$firstProcess.CreationDate, [StringComparison]::Ordinal)) { return 45 }
  try {
    $secondOwner = Test-CozyDashboardOwner -Process $secondProcess -ExpectedRoot $ExpectedRoot -ExpectedHermes $ExpectedHermes -ExpectedLauncher $ExpectedLauncher -ExpectedPort $ExpectedPort -ResolveProcess $ResolveProcess
  } catch { return 45 }
  if ($secondOwner -ne "Owned") { return 45 }

  try { $killCode = & $KillTree ([int]$secondProcess.ProcessId) } catch { return 45 }
  if ([int]$killCode -ne 0) { return 45 }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try { $remaining = & $ResolveListener } catch { return 45 }
    if ($null -eq $remaining) { return 0 }
    & $Sleep 100
  }
  return 45
}
# COZYGATEWAY_DASHBOARD_OWNER_END
$listenerResolver = {
  Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $_.LocalAddress -eq "127.0.0.1" -and $_.LocalPort -eq $ExpectedPort } |
    Select-Object -First 1
}
$processResolver = { param([int]$processId) Get-CimInstance Win32_Process -Filter ("ProcessId=" + $processId) -ErrorAction SilentlyContinue }
$trustedModuleRoot = [IO.Path]::GetFullPath([IO.Path]::Combine((Get-CozyNativeDirectory "System"), "WindowsPowerShell", "v1.0", "Modules"))
$trustedNetTCPIPManifest = [IO.Path]::Combine($trustedModuleRoot, "NetTCPIP", "NetTCPIP.psd1")
$trustedCimCmdletsManifest = [IO.Path]::Combine($trustedModuleRoot, "CimCmdlets", "CimCmdlets.psd1")
if (-not [IO.File]::Exists($trustedNetTCPIPManifest) -or -not [IO.File]::Exists($trustedCimCmdletsManifest)) {
  exit 43
}
$env:PSModulePath = $trustedModuleRoot
try {
  Import-Module -Name $trustedNetTCPIPManifest -Force -ErrorAction Stop
  Import-Module -Name $trustedCimCmdletsManifest -Force -ErrorAction Stop
  $PSModuleAutoLoadingPreference = "None"
} catch {
  exit 43
}
$taskkillExecutable = Resolve-CozySystemExecutable "taskkill.exe"
$treeKiller = {
  param([int]$processId)
  & $taskkillExecutable /PID ([string]$processId) /T /F | Out-Null
  return $LASTEXITCODE
}
$sleeper = { param([int]$milliseconds) Start-Sleep -Milliseconds $milliseconds }
exit (Stop-CozyDashboardOwner -ExpectedRoot $ExpectedRoot -ExpectedHermes $ExpectedHermes -ExpectedLauncher $ExpectedLauncher -ExpectedPort $ExpectedPort -ResolveListener $listenerResolver -ResolveProcess $processResolver -KillTree $treeKiller -Sleep $sleeper)
POWERSHELL_OWNER
  chmod 600 "$DASHBOARD_OWNER_PS1"
}
write_dashboard_elevation_helper() {
  is_windows || return 0
  [ "$DRY_RUN" = 1 ] && return
  umask 077; cat > "$DASHBOARD_ELEVATION_PS1" <<'POWERSHELL_ELEVATION'
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$ExpectedRoot,
  [Parameter(Mandatory = $true, Position = 1)][string]$ExpectedHermes,
  [Parameter(Mandatory = $true, Position = 2)][string]$ExpectedLauncher,
  [Parameter(Mandatory = $true, Position = 3)][ValidateRange(1, 65535)][int]$ExpectedPort,
  [Parameter(Mandatory = $true, Position = 4)][string]$OwnerHelper
)
$ErrorActionPreference = "Stop"
function Initialize-CozyNativeDirectoryApi {
  if ($null -ne $script:CozyNativeDirectoryApi) { return }
  $assemblyName = [Reflection.AssemblyName]::new("CozyGateway.NativeDirectory." + [guid]::NewGuid().ToString("N"))
  $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $moduleBuilder = $assemblyBuilder.DefineDynamicModule("NativeDirectory")
  $typeBuilder = $moduleBuilder.DefineType("CozyGatewayNativeDirectory", [Reflection.TypeAttributes] "Public, Sealed, Abstract")
  $dllImportConstructor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([Type[]] @([string]))
  $dllImportFields = [Reflection.FieldInfo[]] @(
    [Runtime.InteropServices.DllImportAttribute].GetField("EntryPoint"),
    [Runtime.InteropServices.DllImportAttribute].GetField("CharSet"),
    [Runtime.InteropServices.DllImportAttribute].GetField("CallingConvention"),
    [Runtime.InteropServices.DllImportAttribute].GetField("SetLastError"),
    [Runtime.InteropServices.DllImportAttribute].GetField("PreserveSig")
  )
  foreach ($definition in @(
    @{ Name = "GetSystemDirectoryW"; ReturnType = [uint32]; Parameters = [Type[]] @([Text.StringBuilder], [uint32]) },
    @{ Name = "GetWindowsDirectoryW"; ReturnType = [uint32]; Parameters = [Type[]] @([Text.StringBuilder], [uint32]) },
    @{ Name = "SetEnvironmentVariableW"; ReturnType = [bool]; Parameters = [Type[]] @([string], [string]) }
  )) {
    $method = $typeBuilder.DefineMethod(
      [string]$definition.Name, [Reflection.MethodAttributes] "Public, Static, PinvokeImpl",
      [Type]$definition.ReturnType, [Type[]]$definition.Parameters
    )
    $dllImportValues = [object[]] @(
      [string]$definition.Name,
      [Runtime.InteropServices.CharSet]::Unicode,
      [Runtime.InteropServices.CallingConvention]::Winapi,
      $true,
      $true
    )
    $dllImport = [Reflection.Emit.CustomAttributeBuilder]::new(
      $dllImportConstructor, [object[]] @("kernel32.dll"), $dllImportFields, $dllImportValues
    )
    $method.SetCustomAttribute($dllImport)
  }
  $script:CozyNativeDirectoryApi = $typeBuilder.CreateType()
}
function Get-CozyNativeDirectory {
  param([ValidateSet("System", "Windows")][string]$Kind)
  Initialize-CozyNativeDirectoryApi
  $methodName = if ($Kind -eq "System") { "GetSystemDirectoryW" } else { "GetWindowsDirectoryW" }
  $method = $script:CozyNativeDirectoryApi.GetMethod($methodName)
  $capacity = 260
  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    $buffer = [Text.StringBuilder]::new($capacity)
    $arguments = [object[]] @($buffer, [uint32]$capacity)
    $length = [uint32]$method.Invoke($null, $arguments)
    if ($length -eq 0) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "$methodName failed with Win32 error $errorCode"
    }
    if ($length -lt [uint32]$capacity) {
      $value = $buffer.ToString()
      if ($value.Length -ne [int]$length -or -not [IO.Path]::IsPathRooted($value) -or -not [IO.Directory]::Exists($value)) {
        throw "$methodName returned an invalid directory"
      }
      return [IO.Path]::GetFullPath($value)
    }
    if ($length -gt 32768) { throw "$methodName returned an invalid buffer length" }
    $capacity = [int]$length
  }
  throw "$methodName did not fit within the validated buffer limit"
}
function ConvertTo-CozyNativeArgument {
  param([string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
function Set-CozyProcessEnvironmentVariable {
  param([string]$Name, $Value)
  Initialize-CozyNativeDirectoryApi
  $method = $script:CozyNativeDirectoryApi.GetMethod("SetEnvironmentVariableW")
  if (-not [bool]$method.Invoke($null, [object[]] @($Name, $Value))) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "SetEnvironmentVariableW failed with Win32 error $errorCode"
  }
}
function Clear-CozyProcessEnvironment {
  foreach ($name in @([Environment]::GetEnvironmentVariables("Process").Keys)) {
    Set-CozyProcessEnvironmentVariable ([string]$name) $null
  }
}
try {
  $trustedSystemDirectory = Get-CozyNativeDirectory "System"
  $trustedWindowsDirectory = Get-CozyNativeDirectory "Windows"
  $trustedModuleRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($trustedSystemDirectory, "WindowsPowerShell", "v1.0", "Modules"))
  $powerShellExecutable = [IO.Path]::GetFullPath([IO.Path]::Combine($trustedSystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"))
  if (-not [IO.File]::Exists($powerShellExecutable) -or -not [IO.Directory]::Exists($trustedModuleRoot)) {
    throw "trusted Windows PowerShell runtime is unavailable"
  }
} catch {
  exit 46
}
$originalEnvironment = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables("Process").GetEnumerator()) {
  $originalEnvironment[[string]$entry.Key] = [string]$entry.Value
}
$startProcessCommand = Get-Command Start-Process -ErrorAction Stop
$launchEnvironment = @{
  "SystemRoot" = $trustedWindowsDirectory
  "WINDIR" = $trustedWindowsDirectory
  "PSModulePath" = $trustedModuleRoot
}
$childArguments = @(
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  (ConvertTo-CozyNativeArgument $OwnerHelper),
  (ConvertTo-CozyNativeArgument $ExpectedRoot),
  (ConvertTo-CozyNativeArgument $ExpectedHermes),
  (ConvertTo-CozyNativeArgument $ExpectedLauncher),
  [string]$ExpectedPort,
  "-ElevatedChild"
)
try {
  Clear-CozyProcessEnvironment
  foreach ($name in $launchEnvironment.Keys) {
    Set-CozyProcessEnvironmentVariable ([string]$name) ([string]$launchEnvironment[$name])
  }
  $child = & $startProcessCommand $powerShellExecutable -WorkingDirectory $trustedSystemDirectory -Verb RunAs -Wait -PassThru -ArgumentList $childArguments
  exit ([int]$child.ExitCode)
} catch {
  exit 46
} finally {
  Clear-CozyProcessEnvironment
  foreach ($name in $originalEnvironment.Keys) {
    Set-CozyProcessEnvironmentVariable ([string]$name) ([string]$originalEnvironment[$name])
  }
}
POWERSHELL_ELEVATION
  chmod 600 "$DASHBOARD_ELEVATION_PS1"
}
install_supervisor() {
  local source="${COZYGATEWAY_SUPERVISOR_SOURCE:-$(dirname "$BUNDLE_PATH")/gateway-supervisor.cjs}"
  [ "$DRY_RUN" = 1 ] && { say "DRY   install 0700 gateway supervisor at $SUPERVISOR"; return; }
  [ -f "$source" ] || die "verified gateway supervisor is unavailable: $source"
  atomic_copy "$source" "$SUPERVISOR" 700
}
atomic_copy() {
  local source="$1" destination="$2" mode="$3" staged
  staged="$destination.tmp.$$"
  cp "$source" "$staged" || { rm -f "$staged"; return 1; }
  chmod "$mode" "$staged" || { rm -f "$staged"; return 1; }
  mv -f "$staged" "$destination"
}
build_supervisor_args() {
  local platform="$SERVICE_PLATFORM" gateway_env="$GATEWAY_ENV" bundle="$BUNDLE_PATH" config="$CONFIG_JSON"
  local socket="$MAINTENANCE_SOCKET" worker="$MAINTENANCE_WORKER" database="$LOCAL_DIR/cozygateway.sqlite"
  local dashboard_env= hermes_root= hermes= launcher= owner_helper=
  if [ "${HARNESS:-}" = hermes ]; then
    dashboard_env="$DASHBOARD_ENV"; hermes_root="${HERMES_ROOT:-}"; hermes="${HERMES_RESOLVED:-}"
    launcher="${HERMES_ROOT:-}/bin/hermes.exe"; owner_helper="$DASHBOARD_OWNER_PS1"
  fi
  if is_windows; then
    gateway_env="$(to_windows_path "$gateway_env")"; bundle="$(to_windows_path "$bundle")"; config="$(to_windows_path "$config")"
    socket='\\.\pipe\cozygateway-maintenance'; worker="$(to_windows_path "$worker")"; database="$(to_windows_path "$database")"
    if [ "${HARNESS:-}" = hermes ]; then
      dashboard_env="$(to_windows_path "$dashboard_env")"; hermes_root="$(to_windows_path "$hermes_root")"
      hermes="$(to_windows_path "$hermes")"; launcher="$(to_windows_path "$launcher")"; owner_helper="$(to_windows_path "$owner_helper")"
    fi
  fi
  SUPERVISOR_ARGS=(--platform "$platform" --gateway-env "$gateway_env" --bundle "$bundle" --config "$config" --maintenance-socket "$socket" --maintenance-worker "$worker" --database "$database")
  if [ "${HARNESS:-}" = hermes ]; then
    SUPERVISOR_ARGS+=(--dashboard-env "$dashboard_env" --hermes-root "$hermes_root" --hermes "$hermes" --hermes-launcher "$launcher" --owner-helper "$owner_helper" --dashboard-port "$DASHBOARD_PORT")
    if is_windows; then SUPERVISOR_ARGS+=(--windows-dashboard-profile); fi
  fi
}
write_wrapper() {
  [ "$DRY_RUN" = 1 ] && { say "DRY   write 0700 gateway wrapper that executes $SUPERVISOR"; return; }
  build_supervisor_args
  umask 077
  local staged="$WRAPPER.tmp.$$"
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\nexec '
    printf '%q ' "$NODE_RESOLVED" "$SUPERVISOR" "${SUPERVISOR_ARGS[@]}"
    printf '\n'
  } > "$staged"
  chmod 700 "$staged"; mv -f "$staged" "$WRAPPER"
}
vbs_quote() {
  local value="$1"
  case "$value" in *$'\r'*|*$'\n'*) die "refusing a Windows launcher path containing a line break" ;; esac
  value="${value//\"/\"\"}"
  printf '"%s"' "$value"
}
windows_startup_dir() {
  local native="${APPDATA:-}"
  [ -n "$native" ] || native="$(to_windows_path "$HOME")\\AppData\\Roaming"
  to_posix_path "$native\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"
}
windows_startup_entry_uses_current_wrapper() {
  local entry="$1" wrapper_native prefix separator suffix command rest bash_path wrapper_path
  [ -f "$entry" ] || return 1
  wrapper_native="$(to_windows_path "$WRAPPER")"
  [ "$(tr -d '\r' < "$entry" | awk 'END { print NR }')" = 7 ] || return 1
  [ "$(sed -n '1p' "$entry" | tr -d '\r')" = 'Set shell = CreateObject("WScript.Shell")' ] || return 1
  [ "$(sed -n '3,7p' "$entry" | tr -d '\r')" = $'For attempt = 0 To 3\n  code = shell.Run(command, 0, True)\n  If code = 0 Then Exit For\n  If attempt < 3 Then WScript.Sleep 60000\nNext' ] || return 1
  command="$(sed -n '2p' "$entry" | tr -d '\r')"
  prefix='command = """'; separator='"" ""'; suffix='"""'
  rest="${command#"$prefix"}"; [ "$rest" != "$command" ] || return 1
  bash_path="${rest%%"$separator"*}"; rest="${rest#*"$separator"}"
  [ "$rest" != "$bash_path" ] || return 1
  wrapper_path="${rest%"$suffix"}"; [ "$wrapper_path" != "$rest" ] || return 1
  [ "$rest" = "$wrapper_path$suffix" ] && [ -n "$bash_path" ] && [ "$wrapper_path" = "$wrapper_native" ]
}
windows_startup_entry_uses_legacy_wrapper() {
  local entry="$1" wrapper_native prefix separator suffix command rest bash_path wrapper_path line_count
  [ -f "$entry" ] || return 1
  wrapper_native="$(to_windows_path "$WRAPPER")"
  case "$wrapper_native" in *'"'*|*$'\r'*|*$'\n'*) return 1 ;; esac
  line_count="$(tr -d '\r' < "$entry" | awk 'END { print NR }')"
  [ "$line_count" = 3 ] || return 1
  [ "$(sed -n '1p' "$entry" | tr -d '\r')" = 'Set shell = CreateObject("WScript.Shell")' ] || return 1
  [ "$(sed -n '3p' "$entry" | tr -d '\r')" = 'shell.Run command, 0, False' ] || return 1
  command="$(sed -n '2p' "$entry" | tr -d '\r')"
  prefix='command = """'; separator='"" ""'; suffix='"""'
  rest="${command#"$prefix"}"; [ "$rest" != "$command" ] || return 1
  bash_path="${rest%%"$separator"*}"; rest="${rest#*"$separator"}"
  [ "$rest" != "$bash_path" ] || return 1
  wrapper_path="${rest%"$suffix"}"; [ "$wrapper_path" != "$rest" ] || return 1
  [ "$rest" = "$wrapper_path$suffix" ] && [ -n "$bash_path" ] && [ "$wrapper_path" = "$wrapper_native" ]
}
windows_startup_entry_uses_legacy_direct_wrapper() {
  local entry="$1" wrapper_native expected actual
  [ -f "$entry" ] || return 1
  wrapper_native="$(to_windows_path "$WRAPPER")"
  case "$wrapper_native" in *'"'*|*$'\r'*|*$'\n'*) return 1 ;; esac
  expected="$(printf 'Set shell = CreateObject("WScript.Shell")\ncommand = "%s"\nFor attempt = 0 To 3\n  code = shell.Run(command, 0, True)\n  If code = 0 Then Exit For\n  If attempt < 3 Then WScript.Sleep 60000\nNext' "$wrapper_native")"
  actual="$(tr -d '\r' < "$entry")"
  [ "$actual" = "$expected" ]
}
windows_startup_entry_is_owned() {
  windows_startup_entry_uses_current_wrapper "$1" ||
    windows_startup_entry_uses_legacy_wrapper "$1" ||
    windows_startup_entry_uses_legacy_direct_wrapper "$1"
}
write_windows_launcher() {
  local bash_posix bash_native wrapper_native command staged="$WINDOWS_VBS.tmp.$$"
  bash_posix="${COZYGATEWAY_GIT_BASH:-$(command -v bash)}"
  bash_posix="$(to_posix_path "$bash_posix")"
  [ -f "$bash_posix" ] || die "Git Bash executable is unavailable: $bash_posix"
  bash_native="$(to_windows_path "$bash_posix")"
  wrapper_native="$(to_windows_path "$WRAPPER")"
  command="$(vbs_quote "\"$bash_native\" \"$wrapper_native\"")"
  [ "$DRY_RUN" = 1 ] && { say "DRY   write hidden Windows launcher at $WINDOWS_VBS"; return; }
  {
    printf 'Set shell = CreateObject("WScript.Shell")\r\n'
    printf 'command = %s\r\n' "$command"
    printf 'For attempt = 0 To 3\r\n'
    printf '  code = shell.Run(command, 0, True)\r\n'
    printf '  If code = 0 Then Exit For\r\n'
    printf '  If attempt < 3 Then WScript.Sleep 60000\r\n'
    printf 'Next\r\n'
  } > "$staged"
  chmod 600 "$staged" 2>/dev/null || { rm -f "$staged"; return 1; }
  mv -f "$staged" "$WINDOWS_VBS"
}
load_windows_wrapper_identity() {
  local line expected='exec ' value quoted
  [ -r "$WRAPPER" ] && [ -r "$SUPERVISOR" ] || return 1
  [ "$(tr -d '\r' < "$WRAPPER" | awk 'END { print NR }')" = 3 ] || return 1
  [ "$(sed -n '1p' "$WRAPPER" | tr -d '\r')" = '#!/usr/bin/env bash' ] || return 1
  [ "$(sed -n '2p' "$WRAPPER" | tr -d '\r')" = 'set -euo pipefail' ] || return 1
  build_supervisor_args
  for value in "$NODE_RESOLVED" "$SUPERVISOR" "${SUPERVISOR_ARGS[@]}"; do
    printf -v quoted '%q' "$value"
    expected="$expected$quoted "
  done
  line="$(sed -n '3p' "$WRAPPER" | tr -d '\r')"
  [ "$line" = "$expected" ] || return 1
  WINDOWS_OWNED_NODE_RESOLVED="$NODE_RESOLVED"
  WINDOWS_OWNED_GATEWAY_ENV="$GATEWAY_ENV"
  WINDOWS_OWNED_DASHBOARD_ENV=
  WINDOWS_OWNED_HERMES_ROOT=
  WINDOWS_OWNED_HERMES_RESOLVED=
  WINDOWS_OWNED_LAUNCHER=
  WINDOWS_OWNED_DASHBOARD_OWNER_PS1=
  WINDOWS_OWNED_DASHBOARD_PORT=
  if [ "${HARNESS:-}" = hermes ]; then
    WINDOWS_OWNED_DASHBOARD_ENV="$DASHBOARD_ENV"
    WINDOWS_OWNED_HERMES_ROOT="${HERMES_ROOT:-}"
    WINDOWS_OWNED_HERMES_RESOLVED="${HERMES_RESOLVED:-}"
    WINDOWS_OWNED_LAUNCHER="${HERMES_ROOT:-}/bin/hermes.exe"
    WINDOWS_OWNED_DASHBOARD_OWNER_PS1="$DASHBOARD_OWNER_PS1"
    WINDOWS_OWNED_DASHBOARD_PORT="$DASHBOARD_PORT"
  fi
  WINDOWS_OWNED_BUNDLE_PATH="$BUNDLE_PATH"
  WINDOWS_OWNED_CONFIG_JSON="$CONFIG_JSON"
  WINDOWS_OWNED_IDENTITY=1
}
load_windows_state_identity() {
  local node_count bundle_count
  node_count="$(grep -c '^node_resolved=' "$STATE_FILE" || true)"
  bundle_count="$(grep -c '^bundle_path=' "$STATE_FILE" || true)"
  if [ "$node_count" = 0 ] && [ "$bundle_count" = 0 ]; then
    NODE_RESOLVED="$GATEWAY_DIR/runtime/node/node.exe"
    BUNDLE_PATH="$GATEWAY_DIR/bin/cozygateway.mjs"
    return 0
  fi
  [ "$node_count" = 1 ] && [ "$bundle_count" = 1 ] || return 1
  NODE_RESOLVED="$(sed -n 's/^node_resolved=//p' "$STATE_FILE")"
  BUNDLE_PATH="$(sed -n 's/^bundle_path=//p' "$STATE_FILE")"
  [ -n "$NODE_RESOLVED" ] && [ -n "$BUNDLE_PATH" ] || return 1
  case "$NODE_RESOLVED" in /*) ;; *) return 1 ;; esac
  case "$BUNDLE_PATH" in /*) ;; *) return 1 ;; esac
}
preflight_windows_service_ownership() {
  local desired_node="$NODE_RESOLVED" desired_bundle="$BUNDLE_PATH" desired_dashboard_port="$DASHBOARD_PORT" task_xml startup_entry state_dashboard_port
  [ -f "$STATE_FILE" ] || {
    task_xml="$(MSYS_NO_PATHCONV=1 schtasks.exe /Query /TN "$WINDOWS_TASK" /XML 2>/dev/null || true)"
    [ -z "$task_xml" ] || windows_task_is_directly_owned_by_gateway_home || die "Scheduled Task $WINDOWS_TASK is foreign; leaving it untouched"
    startup_entry="$(windows_startup_dir)/$WINDOWS_TASK.vbs"
    [ ! -f "$startup_entry" ] || windows_startup_entry_is_owned "$startup_entry" || die "Startup entry $startup_entry is foreign; leaving it untouched"
    return 0
  }
  load_windows_state_identity || die "installer state has conflicting Windows supervisor identity"
  state_dashboard_port="$(sed -n 's/^dashboard_port=//p' "$STATE_FILE" | tail -1)"
  [ -z "$state_dashboard_port" ] || DASHBOARD_PORT="$state_dashboard_port"
  task_xml="$(MSYS_NO_PATHCONV=1 schtasks.exe /Query /TN "$WINDOWS_TASK" /XML 2>/dev/null || true)"
  startup_entry="$(windows_startup_dir)/$WINDOWS_TASK.vbs"
  if [ -n "$task_xml" ] || [ -f "$startup_entry" ]; then
    load_windows_wrapper_identity || die "could not verify the existing Windows CozyGateway supervisor identity"
  fi
  [ -z "$task_xml" ] || windows_recorded_task_is_owned || die "Scheduled Task $WINDOWS_TASK is foreign; leaving it untouched"
  [ ! -f "$startup_entry" ] || windows_startup_entry_is_owned "$startup_entry" || die "Startup entry $startup_entry is foreign; leaving it untouched"
  NODE_RESOLVED="$desired_node"; BUNDLE_PATH="$desired_bundle"; DASHBOARD_PORT="$desired_dashboard_port"
}
stop_owned_windows_gateway() {
  local config_native gateway_env_native dashboard_env_native node_native bundle_native hermes_root_native hermes_native launcher_native owner_helper_native worker_native database_native code release_code attempt expected_port check_target_port="${1:-1}"
  if [ "${WINDOWS_OWNED_IDENTITY:-0}" != 1 ] && ! load_windows_wrapper_identity; then
    [ "$check_target_port" = 0 ] && return 1
    windows_gateway_ports_are_free
    return 1
  fi
  config_native="$(to_windows_path "$WINDOWS_OWNED_CONFIG_JSON")"
  gateway_env_native="$(to_windows_path "$WINDOWS_OWNED_GATEWAY_ENV")"
  dashboard_env_native=; hermes_root_native=; hermes_native=; launcher_native=; owner_helper_native=
  node_native="$(to_windows_path "$WINDOWS_OWNED_NODE_RESOLVED")"
  bundle_native="$(to_windows_path "$WINDOWS_OWNED_BUNDLE_PATH")"
  if [ -n "$WINDOWS_OWNED_DASHBOARD_ENV" ]; then
    [ -n "$WINDOWS_OWNED_HERMES_ROOT" ] && [ -n "$WINDOWS_OWNED_HERMES_RESOLVED" ] && [ -n "$WINDOWS_OWNED_LAUNCHER" ] && [ -n "$WINDOWS_OWNED_DASHBOARD_OWNER_PS1" ] && [ -n "$WINDOWS_OWNED_DASHBOARD_PORT" ] || die "persisted Hermes supervisor identity is incomplete"
    dashboard_env_native="$(to_windows_path "$WINDOWS_OWNED_DASHBOARD_ENV")"
    hermes_root_native="$(to_windows_path "$WINDOWS_OWNED_HERMES_ROOT")"
    hermes_native="$(to_windows_path "$WINDOWS_OWNED_HERMES_RESOLVED")"
    launcher_native="$(to_windows_path "$WINDOWS_OWNED_LAUNCHER")"
    owner_helper_native="$(to_windows_path "$WINDOWS_OWNED_DASHBOARD_OWNER_PS1")"
  fi
  worker_native="$(to_windows_path "$MAINTENANCE_WORKER")"
  database_native="$(to_windows_path "$LOCAL_DIR/cozygateway.sqlite")"
  set +e
  MSYS_NO_PATHCONV=1 COZYGATEWAY_EXPECTED_CONFIG="$config_native" COZYGATEWAY_EXPECTED_GATEWAY_ENV="$gateway_env_native" COZYGATEWAY_EXPECTED_DASHBOARD_ENV="$dashboard_env_native" COZYGATEWAY_EXPECTED_NODE="$node_native" COZYGATEWAY_EXPECTED_SUPERVISOR="$(to_windows_path "$SUPERVISOR")" COZYGATEWAY_EXPECTED_BUNDLE="$bundle_native" COZYGATEWAY_EXPECTED_WORKER="$worker_native" COZYGATEWAY_EXPECTED_DATABASE="$database_native" COZYGATEWAY_EXPECTED_HERMES_ROOT="$hermes_root_native" COZYGATEWAY_EXPECTED_HERMES="$hermes_native" COZYGATEWAY_EXPECTED_LAUNCHER="$launcher_native" COZYGATEWAY_EXPECTED_OWNER_HELPER="$owner_helper_native" COZYGATEWAY_EXPECTED_DASHBOARD_PORT="$WINDOWS_OWNED_DASHBOARD_PORT" powershell.exe -NoProfile -NonInteractive -Command '
    $ErrorActionPreference = "Stop"
    function Same-Path([string] $Candidate, [string] $Expected) {
      if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Expected)) { return $false }
      try { return [IO.Path]::GetFullPath($Candidate).TrimEnd([char]92).Equals([IO.Path]::GetFullPath($Expected).TrimEnd([char]92), [StringComparison]::OrdinalIgnoreCase) } catch { return $false }
    }
    function Command-Tokens([string] $Command) {
      return @([regex]::Matches($Command, "[^\s`"]+|`"[^`"]*`"") | ForEach-Object { $_.Value.Trim([char]34) })
    }
    function Is-ManagedGatewayChild($Process) {
      $tokens = Command-Tokens ([string]$Process.CommandLine)
      return $tokens.Count -eq 5 -and (Same-Path $tokens[0] $env:COZYGATEWAY_EXPECTED_NODE) -and (Same-Path $tokens[1] $env:COZYGATEWAY_EXPECTED_BUNDLE) -and $tokens[2] -eq "serve" -and $tokens[3] -eq "--config" -and (Same-Path $tokens[4] $env:COZYGATEWAY_EXPECTED_CONFIG)
    }
    function Is-ManagedGatewaySupervisor($Process) {
      $tokens = Command-Tokens ([string]$Process.CommandLine)
      $expected = @($env:COZYGATEWAY_EXPECTED_NODE, $env:COZYGATEWAY_EXPECTED_SUPERVISOR,
        "--platform", "Windows", "--gateway-env", $env:COZYGATEWAY_EXPECTED_GATEWAY_ENV,
        "--bundle", $env:COZYGATEWAY_EXPECTED_BUNDLE, "--config", $env:COZYGATEWAY_EXPECTED_CONFIG,
        "--maintenance-socket", "\\.\pipe\cozygateway-maintenance", "--maintenance-worker", $env:COZYGATEWAY_EXPECTED_WORKER,
        "--database", $env:COZYGATEWAY_EXPECTED_DATABASE)
      if (-not [string]::IsNullOrWhiteSpace($env:COZYGATEWAY_EXPECTED_DASHBOARD_ENV)) {
        $expected += @("--dashboard-env", $env:COZYGATEWAY_EXPECTED_DASHBOARD_ENV, "--hermes-root", $env:COZYGATEWAY_EXPECTED_HERMES_ROOT,
          "--hermes", $env:COZYGATEWAY_EXPECTED_HERMES, "--hermes-launcher", $env:COZYGATEWAY_EXPECTED_LAUNCHER,
          "--owner-helper", $env:COZYGATEWAY_EXPECTED_OWNER_HELPER, "--dashboard-port", $env:COZYGATEWAY_EXPECTED_DASHBOARD_PORT,
          "--windows-dashboard-profile")
      }
      if ($tokens.Count -ne $expected.Count) { return $false }
      $pathIndexes = @(0, 1, 5, 7, 9, 13, 15, 17, 19, 21, 23, 25)
      for ($index = 0; $index -lt $expected.Count; $index += 1) {
        if ($pathIndexes -contains $index) { if (-not (Same-Path $tokens[$index] $expected[$index])) { return $false } }
        elseif ($tokens[$index] -cne $expected[$index]) { return $false }
      }
      return $true
    }
    function Managed-GatewayProcesses {
      $all = @(Get-CimInstance Win32_Process)
      return @($all | Where-Object { (Is-ManagedGatewaySupervisor $_) -or (Is-ManagedGatewayChild $_) })
    }
    $managed = @(Managed-GatewayProcesses)
    if ($managed.Count -eq 0) {
      exit 3
    }
    $taskkill = Join-Path ([Environment]::SystemDirectory) "taskkill.exe"
    if (-not [IO.File]::Exists($taskkill)) { throw "trusted taskkill.exe is unavailable" }
    function Stop-ManagedGatewayProcess([int] $ProcessId) {
      $previousPreference = $ErrorActionPreference
      try {
        $ErrorActionPreference = "SilentlyContinue"
        & $taskkill /PID ([string]$ProcessId) /T /F *> $null
      } finally {
        $ErrorActionPreference = $previousPreference
      }
    }
    $stopped = [Collections.Generic.HashSet[int]]::new()
    foreach ($process in $managed | Sort-Object { if (Is-ManagedGatewaySupervisor $_) { 0 } else { 1 } }) {
      if ($stopped.Add([int]$process.ProcessId)) { Stop-ManagedGatewayProcess $process.ProcessId }
    }
    Start-Sleep -Milliseconds 1200
    for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
      $remaining = @(Managed-GatewayProcesses)
      if ($remaining.Count -eq 0) { break }
      foreach ($process in $remaining) {
        if ($stopped.Add([int]$process.ProcessId)) { Stop-ManagedGatewayProcess $process.ProcessId }
      }
      Start-Sleep -Seconds 1
    }
    if (@(Managed-GatewayProcesses).Count -ne 0) { exit 45 }
    exit 0
  ' >/dev/null 2>&1
  code=$?
  set -e
  case "$code" in
    0) ;;
    3)
      [ "$check_target_port" = 0 ] && return 1
      windows_gateway_ports_are_free
      return 1
      ;;
    45) die "the previous CozyGateway process did not exit after termination" ;;
    *) die "Windows gateway ownership cleanup failed (code $code)" ;;
  esac
  [ "$check_target_port" = 0 ] && return 0
  windows_gateway_ports_are_free
  for _ in $(seq 1 10); do gateway_ready || return 0; sleep 1; done
  die "the previous CozyGateway process stayed listening on port $PORT"
}
windows_gateway_ports_are_free() {
  local expected_port release_code attempt
  local -a ports=("$PORT")
  [ -z "$PREVIOUS_PORT" ] || [ "$PREVIOUS_PORT" = "$PORT" ] || ports+=("$PREVIOUS_PORT")
  for expected_port in "${ports[@]}"; do
    release_code=1
    for attempt in $(seq 1 10); do
      set +e
      MSYS_NO_PATHCONV=1 COZYGATEWAY_EXPECTED_PORT="$expected_port" powershell.exe -NoProfile -NonInteractive -Command '
        $listener = Get-NetTCPConnection -State Listen -LocalPort ([int]$env:COZYGATEWAY_EXPECTED_PORT) -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $listener) { exit 0 }
        exit 1
      ' >/dev/null 2>&1
      release_code=$?
      set -e
      [ "$release_code" -eq 0 ] && break
      sleep 1
    done
    [ "$release_code" -eq 0 ] || die "port $expected_port is owned by a process this installer cannot safely stop"
  done
}
windows_task_uses_current_supervisor() {
  local xml recorded_xml recorded_command recorded_arguments actual_command actual_arguments vbs_native
  xml="$(MSYS_NO_PATHCONV=1 schtasks.exe /Query /TN "$WINDOWS_TASK" /XML 2>/dev/null || true)"
  [ -z "$xml" ] && return 1
  windows_task_has_single_exec_action "$xml" || return 1
  actual_command="$(sed -n 's:.*<Command>\([^<]*\)</Command>.*:\1:p' <<<"$xml")"
  actual_arguments="$(sed -n 's:.*<Arguments>\([^<]*\)</Arguments>.*:\1:p' <<<"$xml")"
  if [ -f "$WINDOWS_TASK_XML" ]; then
    recorded_xml="$(iconv -f UTF-16LE -t UTF-8 "$WINDOWS_TASK_XML" | sed '1s/^\xef\xbb\xbf//')" || return 1
    recorded_command="$(sed -n 's:.*<Command>\([^<]*\)</Command>.*:\1:p' <<<"$recorded_xml")"
    recorded_arguments="$(sed -n 's:.*<Arguments>\([^<]*\)</Arguments>.*:\1:p' <<<"$recorded_xml")"
    [ -n "$recorded_command" ] && [ -n "$recorded_arguments" ] &&
      [ "$actual_command" = "$recorded_command" ] && [ "$actual_arguments" = "$recorded_arguments" ] && return 0
  fi
  vbs_native="$(to_windows_path "$WINDOWS_VBS")"
  [ "$actual_command" = wscript.exe ] &&
    { [ "$actual_arguments" = "&quot;$vbs_native&quot;" ] || [ "$actual_arguments" = "\"$vbs_native\"" ]; } &&
    windows_startup_entry_is_owned "$WINDOWS_VBS"
}
windows_task_has_single_exec_action() {
  local xml="$1" compact actions remainder
  compact="$(tr -d '\r\n' <<<"$xml")"
  [ "$(grep -o '<Actions[^>]*>' <<<"$compact" | wc -l | tr -d ' ')" = 1 ] || return 1
  actions="$(sed -n 's:.*<Actions[^>]*>\(.*\)</Actions>.*:\1:p' <<<"$compact")"
  [ -n "$actions" ] || return 1
  [ "$(grep -o '<Exec>' <<<"$actions" | wc -l | tr -d ' ')" = 1 ] || return 1
  remainder="$(sed 's:<Exec>.*</Exec>::' <<<"$actions" | tr -d '[:space:]')"
  [ -z "$remainder" ]
}
windows_recorded_task_is_owned() {
  windows_task_uses_current_supervisor
}
windows_task_is_directly_owned_by_gateway_home() {
  local xml command arguments node_native supervisor_native rest token flag value index
  local gateway_env bundle config worker database dashboard_env owner_helper hermes_root hermes launcher dashboard_port
  local -a tokens
  local -A seen
  xml="$(MSYS_NO_PATHCONV=1 schtasks.exe /Query /TN "$WINDOWS_TASK" /XML 2>/dev/null || true)"
  [ -n "$xml" ] || return 1
  windows_task_has_single_exec_action "$xml" || return 1
  command="$(sed -n 's:.*<Command>\([^<]*\)</Command>.*:\1:p' <<<"$xml")"
  arguments="$(sed -n 's:.*<Arguments>\([^<]*\)</Arguments>.*:\1:p' <<<"$xml")"
  node_native="$(to_windows_path "$GATEWAY_DIR/runtime/node/node.exe")"
  supervisor_native="$(to_windows_path "$SUPERVISOR")"
  [ "$command" = "$node_native" ] || return 1
  rest="$arguments"
  while [ -n "$rest" ]; do
    case "$rest" in '&quot;'*) rest="${rest#'&quot;'}" ;; *) return 1 ;; esac
    token="${rest%%'&quot;'*}"; [ "$token" != "$rest" ] || return 1
    rest="${rest#*'&quot;'}"
    token="${token//&lt;/<}"; token="${token//&gt;/>}"; token="${token//&amp;/\&}"
    tokens+=("$token")
    [ -z "$rest" ] || { case "$rest" in ' '*) rest="${rest# }" ;; *) return 1 ;; esac; }
  done
  [ "${tokens[0]:-}" = "$supervisor_native" ] || return 1
  for ((index=1; index<${#tokens[@]}; index+=1)); do
    flag="${tokens[index]}"
    if [ "$flag" = --windows-dashboard-profile ]; then
      [ -z "${seen[$flag]+x}" ] || return 1
      seen[$flag]=true
      continue
    fi
    [ $((index + 1)) -lt ${#tokens[@]} ] || return 1
    value="${tokens[index+1]}"; index=$((index + 1))
    case "$flag" in
      --platform|--gateway-env|--bundle|--config|--maintenance-socket|--maintenance-worker|--database|--dashboard-env|--hermes-root|--hermes|--hermes-launcher|--owner-helper|--dashboard-port) ;;
      *) return 1 ;;
    esac
    [ -z "${seen[$flag]+x}" ] || return 1
    seen[$flag]="$value"
  done
  gateway_env="$(to_windows_path "$GATEWAY_ENV")"; bundle="$(to_windows_path "$GATEWAY_DIR/bin/cozygateway.mjs")"
  config="$(to_windows_path "$CONFIG_JSON")"; worker="$(to_windows_path "$MAINTENANCE_WORKER")"
  database="$(to_windows_path "$LOCAL_DIR/cozygateway.sqlite")"
  [ "${seen[--platform]:-}" = Windows ] && [ "${seen[--gateway-env]:-}" = "$gateway_env" ] &&
    [ "${seen[--bundle]:-}" = "$bundle" ] && [ "${seen[--config]:-}" = "$config" ] &&
    [ "${seen[--maintenance-socket]:-}" = '\\.\pipe\cozygateway-maintenance' ] &&
    [ "${seen[--maintenance-worker]:-}" = "$worker" ] && [ "${seen[--database]:-}" = "$database" ] || return 1
  dashboard_env="${seen[--dashboard-env]:-}"; owner_helper="${seen[--owner-helper]:-}"
  hermes_root="${seen[--hermes-root]:-}"; hermes="${seen[--hermes]:-}"; launcher="${seen[--hermes-launcher]:-}"; dashboard_port="${seen[--dashboard-port]:-}"
  if [ -n "$dashboard_env$owner_helper$hermes_root$hermes$launcher$dashboard_port" ]; then
    [ "$dashboard_env" = "$(to_windows_path "$DASHBOARD_ENV")" ] &&
      [ "$owner_helper" = "$(to_windows_path "$DASHBOARD_OWNER_PS1")" ] && [[ "$hermes_root" =~ ^[A-Za-z]:\\ ]] &&
      [[ "$hermes" =~ ^[A-Za-z]:\\ ]] && [ "$launcher" = "$hermes_root\\bin\\hermes.exe" ] &&
      [ "${seen[--windows-dashboard-profile]:-}" = true ] &&
      [[ "$dashboard_port" =~ ^[0-9]+$ ]] && [ "$dashboard_port" -ge 1 ] && [ "$dashboard_port" -le 65535 ] || return 1
  elif [ -n "${seen[--windows-dashboard-profile]:-}" ]; then
    return 1
  fi
  return 0
}
xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"; value="${value//</&lt;}"; value="${value//>/&gt;}"
  printf '%s' "$value"
}
xml_unescape() {
  local value="$1"
  value="${value//&lt;/<}"; value="${value//&gt;/>}"; value="${value//&amp;/\&}"
  printf '%s' "$value"
}
write_windows_task_xml() {
  local node_native supervisor_native arguments='' value escaped user_sid task_start staged="$WINDOWS_TASK_XML.tmp.$$" utf8="$WINDOWS_TASK_XML.tmp.$$.utf8"
  build_supervisor_args
  user_sid="$(powershell.exe -NoProfile -NonInteractive -Command '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value')"
  user_sid="$(tr -d '\r\n' <<<"$user_sid")"
  [[ "$user_sid" =~ ^S-[0-9]+(-[0-9]+)+$ ]] || die "could not resolve the current Windows user SID for Scheduled Task ownership"
  task_start="$(powershell.exe -NoProfile -NonInteractive -Command '(Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")')"
  task_start="$(tr -d '\r\n' <<<"$task_start")"
  [[ "$task_start" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$ ]] || die "could not resolve the current time for the Scheduled Task heartbeat"
  node_native="$(to_windows_path "$NODE_RESOLVED")"; supervisor_native="$(to_windows_path "$SUPERVISOR")"
  for value in "$supervisor_native" "${SUPERVISOR_ARGS[@]}"; do
    case "$value" in *'"'*|*$'\r'*|*$'\n'*) die "refusing an unsafe Scheduled Task argument" ;; esac
    arguments="${arguments}${arguments:+ }&quot;${value//&/&amp;}&quot;"
  done
  escaped="${node_native//&/&amp;}"
  umask 077
  cat > "$utf8" <<TASK_XML
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$user_sid</UserId></LogonTrigger><TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>$task_start</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers><Principals><Principal id="Author"><UserId>$user_sid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>$escaped</Command><Arguments>$arguments</Arguments></Exec></Actions></Task>
TASK_XML
  printf '\377\376' > "$staged"
  iconv -f UTF-8 -t UTF-16LE "$utf8" >> "$staged" || { rm -f "$utf8" "$staged"; return 1; }
  rm -f "$utf8"
  chmod 600 "$staged" 2>/dev/null || { rm -f "$staged"; return 1; }
  mv -f "$staged" "$WINDOWS_TASK_XML"
}
install_windows_service() {
  local task_xml_native output code startup entry existing startup_foreign=0
  [ "$DRY_RUN" = 1 ] && { say "DRY   register current-user Scheduled Task $WINDOWS_TASK with Startup-folder fallback"; return; }
  startup="$(windows_startup_dir)"; entry="$startup/$WINDOWS_TASK.vbs"
  if [ -f "$entry" ] && ! windows_startup_entry_is_owned "$entry"; then
    startup_foreign=1
  fi
  existing="$(MSYS_NO_PATHCONV=1 schtasks.exe /Query /TN "$WINDOWS_TASK" /XML 2>/dev/null || true)"
  if [ -n "$existing" ] && ! windows_task_uses_current_supervisor; then
    die "Scheduled Task $WINDOWS_TASK is foreign; leaving it untouched"
  fi
  [ "$startup_foreign" = 0 ] || die "Startup entry $entry is foreign; leaving it untouched"
  if stop_owned_windows_gateway; then
    say "OK    stopped the previous CozyGateway process for an in-place update"
  fi
  install_supervisor
  write_wrapper
  write_windows_launcher
  write_windows_task_xml
  task_xml_native="$(to_windows_path "$WINDOWS_TASK_XML")"
  set +e
  output="$(MSYS_NO_PATHCONV=1 schtasks.exe /Create /F /TN "$WINDOWS_TASK" /XML "$task_xml_native" 2>&1)"
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    mkdir -p "$startup"; cp "$WINDOWS_VBS" "$entry"
    say "INFO  Scheduled Task unavailable ($output); installed current-user Startup fallback: $entry"
    wscript.exe "$(to_windows_path "$WINDOWS_VBS")"
  else
    say "OK    registered current-user Scheduled Task $WINDOWS_TASK"
    if [ -f "$entry" ] && windows_startup_entry_is_owned "$entry"; then rm -f "$entry"; fi
    MSYS_NO_PATHCONV=1 schtasks.exe /Run /TN "$WINDOWS_TASK" >/dev/null || die "Scheduled Task $WINDOWS_TASK did not start"
  fi
}
gateway_ready() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$(gateway_origin)/health" 2>/dev/null || true)"
  [ "$code" = 200 ]
}
wait_gateway_ready() {
  if [ "$DRY_RUN" = 1 ]; then
    if [ "$HARNESS" = cozyagents ]; then say "DRY   wait for CozyGateway health before installing the harness"
    else say "DRY   wait for CozyGateway health before starting Hermes attach"; fi
    return
  fi
  local attempt
  for attempt in $(seq 1 30); do gateway_ready && return; sleep 1; done
  die "CozyGateway did not become healthy on $(gateway_origin)"
}
attach_health() {
  curl -fsS --max-time 3 "$(gateway_origin)/health" 2>/dev/null
}
attach_ready() {
  attach_health |
    "$NODE_RESOLVED" -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{const h=JSON.parse(b).attach,c=h?.configured,o=h?.online,d=h?.deadLetters;process.exit([c,o,d].every(Number.isInteger)&&c>0&&o>=0&&d>=0&&o===c&&d===0?0:1)}catch{process.exit(1)}})'
}
attach_health_diagnosis() {
  attach_health |
    "$NODE_RESOLVED" -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const unreadable=()=>process.stdout.write("Hermes attach health could not be read");try{const h=JSON.parse(b).attach,c=h?.configured,o=h?.online,d=h?.deadLetters;if(![c,o,d].every(Number.isInteger)||c<0||o<0||d<0)return unreadable();const counts=`configured=${c}, online=${o}, deadLetters=${d}`;if(c===0)return process.stdout.write(`Hermes attach has no configured profiles (${counts})`);if(o!==c)return process.stdout.write(`Hermes attach profile count mismatch (${counts})`);if(d!==0)return process.stdout.write(`Hermes attach retained dead letters (${counts})`);return process.stdout.write("__cozygateway_attach_healthy__")}catch{return unreadable()}})'
}
wait_attach_ready() {
  [ "$DRY_RUN" = 1 ] && { say "DRY   require attach.configured > 0, attach.online == attach.configured, and zero dead letters"; return; }
  local attempt diagnosis
  for attempt in $(seq 1 30); do attach_ready && return; sleep 1; done
  diagnosis="$(attach_health_diagnosis || true)"
  [ "$diagnosis" = __cozygateway_attach_healthy__ ] && return
  [ -n "$diagnosis" ] || diagnosis="Hermes attach health could not be read"
  die "$diagnosis"
}
systemd_service_is_owned() {
  local unit="$1" line wrapper_line count
  [ -f "$unit" ] || return 1
  count="$(grep -c '^ExecStart=' "$unit" || true)"; [ "$count" = 1 ] || return 1
  line="$(grep '^ExecStart=' "$unit")"
  [ "$line" = "ExecStart=/bin/bash $WRAPPER" ] && return 0
  [ -f "$WRAPPER" ] || return 1
  wrapper_line="$(sed -n '3p' "$WRAPPER" | tr -d '\r')"
  [ "$(tr -d '\r' < "$WRAPPER" | awk 'END { print NR }')" = 3 ] &&
    [ "$(sed -n '1p' "$WRAPPER" | tr -d '\r')" = '#!/usr/bin/env bash' ] &&
    [ "$(sed -n '2p' "$WRAPPER" | tr -d '\r')" = 'set -euo pipefail' ] &&
    [ "$line" = "ExecStart=${wrapper_line#exec }" ]
}
launchd_service_is_owned() {
  local plist="$1" actual reconstructed value count wrapper_line
  [ -f "$plist" ] || return 1
  count="$(grep -o '<key>ProgramArguments</key>' "$plist" | wc -l | tr -d ' ')"; [ "$count" = 1 ] || return 1
  actual="$(awk '{ if (!on && match($0, /<key>ProgramArguments<\/key><array>/)) { on=1; $0=substr($0, RSTART+RLENGTH) } if (on) { done=($0 ~ /<\/array>/); if (done) sub(/<\/array>.*/, "", $0); while (match($0, /<string>[^<]*<\/string>/)) { print substr($0, RSTART+8, RLENGTH-17); $0=substr($0, RSTART+RLENGTH) } if (done) exit } }' "$plist" | while IFS= read -r value; do xml_unescape "$value"; printf '\n'; done)"
  if [ "$actual" = "$(printf '/bin/bash\n%s' "$WRAPPER")" ]; then return 0; fi
  [ -f "$WRAPPER" ] || return 1
  reconstructed='exec '
  while IFS= read -r value; do printf -v reconstructed '%s%q ' "$reconstructed" "$value"; done <<<"$actual"
  wrapper_line="$(sed -n '3p' "$WRAPPER" | tr -d '\r')"
  [ "$(tr -d '\r' < "$WRAPPER" | awk 'END { print NR }')" = 3 ] &&
    [ "$(sed -n '1p' "$WRAPPER" | tr -d '\r')" = '#!/usr/bin/env bash' ] &&
    [ "$(sed -n '2p' "$WRAPPER" | tr -d '\r')" = 'set -euo pipefail' ] &&
    [ "$reconstructed" = "$wrapper_line" ]
}
posix_service_is_owned_or_absent() {
  local path="$1"
  [ ! -e "$path" ] && return 0
  if [ "$SERVICE_PLATFORM" = Darwin ]; then launchd_service_is_owned "$path"; else systemd_service_is_owned "$path"; fi
}
remove_owned_posix_service() {
  local path="$1"
  if [ -e "$path" ] && ! posix_service_is_owned_or_absent "$path"; then
    say "WARN  CozyGateway service ownership could not be verified; leaving it untouched"
    return 1
  fi
  if [ "$SERVICE_PLATFORM" = Darwin ]; then
    launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true; rm -f "$path"
  else
    systemctl --user disable --now "$SERVICE_UNIT" >/dev/null 2>&1 || true; rm -f "$path"; systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}
install_service() {
  resolve_platform
  if [ "$DRY_RUN" = 1 ]; then
    write_wrapper
    if [ "$HARNESS" = cozyagents ]; then
      say "DRY   install one CozyGateway $SERVICE_PLATFORM service; it supervises the gateway alone, with no Hermes control plane"
    else
      say "DRY   install one CozyGateway $SERVICE_PLATFORM service; it reuses/starts Hermes Dashboard as local control plane"
    fi
    return
  fi
  if [ "$SERVICE_PLATFORM" = Windows ]; then
    install_windows_service
  elif [ "$SERVICE_PLATFORM" = Darwin ]; then
    local plist="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist" staged loaded=0; mkdir -p "$HOME/Library/LaunchAgents"
    posix_service_is_owned_or_absent "$plist" || die "$plist is foreign; leaving it untouched"
    install_supervisor
    write_wrapper
    build_supervisor_args
    staged="$plist.tmp.$$"
    {
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$(xml_escape "$SERVICE_LABEL")</string><key>ProgramArguments</key><array><string>$(xml_escape "$NODE_RESOLVED")</string><string>$(xml_escape "$SUPERVISOR")</string>
PLIST
    for value in "${SUPERVISOR_ARGS[@]}"; do printf '<string>%s</string>\n' "$(xml_escape "$value")"; done
    cat <<PLIST
</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>$(xml_escape "$GW_LOG")</string><key>StandardErrorPath</key><string>$(xml_escape "$GW_LOG")</string><key>ThrottleInterval</key><integer>10</integer></dict></plist>
PLIST
    } > "$staged"
    chmod 600 "$staged"; mv -f "$staged" "$plist"
    launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true
    for _ in $(seq 1 10); do
      if launchctl bootstrap "gui/$(id -u)" "$plist"; then loaded=1; break; fi
      sleep 1
    done
    [ "$loaded" = 1 ] || die "launchd did not accept the CozyGateway service after 10 attempts"
  else
    local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user" unit staged; mkdir -p "$unit_dir"
    unit="$unit_dir/$SERVICE_UNIT"
    posix_service_is_owned_or_absent "$unit" || die "$unit is foreign; leaving it untouched"
    install_supervisor
    write_wrapper
    build_supervisor_args
    have loginctl || die "Linux logout/reboot persistence needs loginctl; install systemd-login or run CozyGateway as a system service"
    if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
      loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || die "Linux logout/reboot persistence needs lingering; run: sudo loginctl enable-linger $(id -un)"
    fi
    staged="$unit.tmp.$$"
    {
    cat <<UNIT
[Unit]
Description=CozyGateway
[Service]
UNIT
    printf 'ExecStart=%q %q ' "$NODE_RESOLVED" "$SUPERVISOR"
    printf '%q ' "${SUPERVISOR_ARGS[@]}"
    cat <<UNIT

Restart=always
RestartSec=5
StandardOutput=append:$GW_LOG
StandardError=append:$GW_LOG
[Install]
WantedBy=default.target
UNIT
    } > "$staged"
    chmod 600 "$staged"; mv -f "$staged" "$unit"
    systemctl --user daemon-reload; systemctl --user enable --now "$SERVICE_UNIT"
  fi
}
dashboard_ready() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$DASHBOARD_PORT/api/health" 2>/dev/null || true)"
  [ "$code" = 200 ] || [ "$code" = 401 ]
}
dashboard_credentials_status() {
  local code
  code="$(
    printf 'X-Hermes-Session-Token: %s\n' "$DASHBOARD_SESSION_TOKEN" |
      curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$DASHBOARD_PORT/api/config" -H @- 2>/dev/null || true
  )"
  printf '%s' "$code"
}
dashboard_credentials_work() {
  [ "$(dashboard_credentials_status)" = 200 ]
}
launch_dashboard() {
  local hermes_root_arg="$HERMES_ROOT" windows_dashboard_profile=0
  if is_windows; then hermes_root_arg="$(to_windows_path "$hermes_root_arg")"; windows_dashboard_profile=1; fi
  "$NODE_RESOLVED" - "$DASHBOARD_ENV" "$hermes_root_arg" "$HERMES_RESOLVED" "$DASHBOARD_PORT" "$windows_dashboard_profile" <<'NODE'
const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { parseEnv } = require('node:util');
const [dashboardEnvPath, hermesRoot, hermes, dashboardPort, windowsDashboardProfile] = process.argv.slice(2);
const dashboard = parseEnv(readFileSync(dashboardEnvPath, 'utf8'));
const dashboardArgs = ['dashboard', ...(windowsDashboardProfile === '1' ? ['-p', 'default'] : []), '--host', '127.0.0.1', '--port', dashboardPort, '--no-open', '--skip-build'];
const child = spawn(hermes, dashboardArgs, {
  detached: true,
  windowsHide: process.platform === 'win32',
  stdio: 'ignore',
  env: { ...process.env, HERMES_HOME: hermesRoot, HERMES_DASHBOARD_SESSION_TOKEN: dashboard.DASHBOARD_SESSION_TOKEN },
});
child.unref();
NODE
}
stop_stubborn_windows_dashboard() {
  local hermes_native launcher_native owner_helper_native elevation_helper_native root_native code
  hermes_native="$(to_windows_path "$HERMES_RESOLVED")"
  launcher_native="$(to_windows_path "$HERMES_ROOT/bin/hermes.exe")"
  owner_helper_native="$(to_windows_path "$DASHBOARD_OWNER_PS1")"
  elevation_helper_native="$(to_windows_path "$DASHBOARD_ELEVATION_PS1")"
  root_native="$(to_windows_path "$HERMES_ROOT")"
  set +e
  MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$owner_helper_native" "$root_native" "$hermes_native" "$launcher_native" "$DASHBOARD_PORT" >/dev/null 2>&1
  code=$?
  set -e
  case "$code" in
    0) return ;;
    42) die "Dashboard port $DASHBOARD_PORT is owned by a process this installer cannot safely stop" ;;
    43) say "INFO  Dashboard ownership metadata requires one scoped UAC recovery helper" ;;
    *) die "Dashboard recovery could not safely stop a verified Dashboard on port $DASHBOARD_PORT" ;;
  esac
  set +e
  MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$elevation_helper_native" "$root_native" "$hermes_native" "$launcher_native" "$DASHBOARD_PORT" "$owner_helper_native" >/dev/null 2>&1
  code=$?
  set -e
  case "$code" in
    0) return ;;
    42) die "Dashboard port $DASHBOARD_PORT is owned by a process this installer cannot safely stop" ;;
    43|46) die "the scoped Dashboard recovery helper could not inspect or stop the elevated Dashboard; close the Hermes Dashboard manually and rerun this installer" ;;
    *) die "Dashboard recovery could not safely stop a verified Dashboard on port $DASHBOARD_PORT" ;;
  esac
}
stop_owned_windows_dashboard_for_uninstall() {
  [ "$SERVICE_PLATFORM" = Windows ] || return 0
  [ "$DRY_RUN" = 1 ] && { say "DRY   stop only a verified Hermes Dashboard on 127.0.0.1:$DASHBOARD_PORT before removing its owner helper"; return; }
  if [ ! -f "$DASHBOARD_OWNER_PS1" ]; then
    local listener_code
    set +e
    MSYS_NO_PATHCONV=1 COZYGATEWAY_EXPECTED_PORT="$DASHBOARD_PORT" COZYGATEWAY_CHECK_TARGET_PORT=1 powershell.exe -NoProfile -NonInteractive -Command '
      $listener = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq "127.0.0.1" -and $_.LocalPort -eq [int]$env:COZYGATEWAY_EXPECTED_PORT } |
        Select-Object -First 1
      if ($null -eq $listener) { exit 0 }; exit 42
    ' >/dev/null 2>&1
    listener_code=$?
    set -e
    [ "$listener_code" -eq 0 ] && { say "INFO  Dashboard owner helper is missing, but no listener is present on port $DASHBOARD_PORT"; return; }
    die "Dashboard owner helper is missing; refusing to remove recovery state while port $DASHBOARD_PORT may still be owned"
  fi
  local root_native hermes_native launcher_native owner_helper_native elevation_helper_native code
  root_native="$(to_windows_path "$HERMES_ROOT")"
  hermes_native="$(to_windows_path "$HERMES_RESOLVED")"
  launcher_native="$(to_windows_path "$HERMES_ROOT/bin/hermes.exe")"
  owner_helper_native="$(to_windows_path "$DASHBOARD_OWNER_PS1")"
  elevation_helper_native="$(to_windows_path "$DASHBOARD_ELEVATION_PS1")"
  set +e
  MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$owner_helper_native" "$root_native" "$hermes_native" "$launcher_native" "$DASHBOARD_PORT" >/dev/null 2>&1
  code=$?
  set -e
  case "$code" in
    0) say "OK    stopped the verified Hermes Dashboard started for CozyGateway"; return ;;
    42) say "INFO  Dashboard port $DASHBOARD_PORT is foreign; leaving it untouched"; return ;;
    43) ;;
    *) die "could not safely stop the verified Hermes Dashboard during uninstall" ;;
  esac
  [ -f "$DASHBOARD_ELEVATION_PS1" ] || die "Dashboard ownership needs elevated inspection, but its scoped helper is missing"
  say "INFO  Dashboard ownership metadata requires one scoped UAC cleanup helper"
  set +e
  MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$elevation_helper_native" "$root_native" "$hermes_native" "$launcher_native" "$DASHBOARD_PORT" "$owner_helper_native" >/dev/null 2>&1
  code=$?
  set -e
  case "$code" in
    0) say "OK    stopped the verified elevated Hermes Dashboard started for CozyGateway" ;;
    42) say "INFO  Dashboard port $DASHBOARD_PORT is foreign; leaving it untouched" ;;
    43|46) die "the scoped Dashboard cleanup helper could not inspect or stop the elevated Dashboard" ;;
    *) die "could not safely stop the verified elevated Hermes Dashboard during uninstall" ;;
  esac
}
start_dashboard() {
  local hermes_root_arg="$HERMES_ROOT" code
  is_windows && hermes_root_arg="$(to_windows_path "$hermes_root_arg")"
  [ "$DRY_RUN" = 1 ] && { say "DRY   start/reuse Hermes Dashboard at 127.0.0.1:$DASHBOARD_PORT as the control/read plane"; return; }
  if dashboard_ready; then
    dashboard_credentials_work && return
    say "INFO  existing Hermes Dashboard rejected the configured local session token; restarting it with the installer-owned token"
    if is_windows; then
      HERMES_HOME="$hermes_root_arg" "$HERMES_RESOLVED" dashboard -p default --stop >/dev/null 2>&1 || die "could not stop the Dashboard that rejected the local credential"
    else
      HERMES_HOME="$hermes_root_arg" "$HERMES_RESOLVED" dashboard --stop >/dev/null 2>&1 || die "could not stop the Dashboard that rejected the local credential"
    fi
    for _ in $(seq 1 5); do dashboard_ready || break; sleep 1; done
    if dashboard_ready && is_windows; then
      stop_stubborn_windows_dashboard
      for _ in $(seq 1 10); do dashboard_ready || break; sleep 1; done
    fi
    dashboard_ready && die "Dashboard stayed listening after stop; refusing to launch with an unverified credential"
  fi
  launch_dashboard
  for _ in $(seq 1 90); do dashboard_ready && break; sleep 1; done
  dashboard_ready || die "Hermes Dashboard did not start listening on 127.0.0.1:$DASHBOARD_PORT"
  code="$(dashboard_credentials_status)"
  case "$code" in
    200) return ;;
    401|403) die "Hermes Dashboard rejected the installer-owned local session token (HTTP $code)" ;;
    *) die "Hermes Dashboard session-token verification failed with HTTP ${code:-000} on 127.0.0.1:$DASHBOARD_PORT" ;;
  esac
}
# A CozyAgents uninstall takes back exactly what this installer put there: the gateway service and
# its state here, and the harness through CozyAgents' own uninstaller, which owns its launcher, its
# PATH line, its service and its runner state.
uninstall_cozyagents() {
  local home launcher
  home="$(sed -n 's/^cozyagents_home=//p' "$STATE_FILE" | tail -1)"
  [ -n "$home" ] || home="$COZYAGENTS_HOME_DIR"
  load_windows_state_identity || die "installer state has conflicting Windows supervisor identity"
  case "$home" in /*) ;; *) die "installer state has an unsafe CozyAgents home" ;; esac
  resolve_platform
  HARNESS=cozyagents
  if [ "$SERVICE_PLATFORM" = Darwin ]; then
    if [ "$DRY_RUN" = 1 ]; then run launchctl bootout "gui/$(id -u)/$SERVICE_LABEL"; run rm -f "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
    else remove_owned_posix_service "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist" && remove_posix_cli || true; fi
  elif [ "$SERVICE_PLATFORM" = Linux ]; then
    if [ "$DRY_RUN" = 1 ]; then run systemctl --user disable --now "$SERVICE_UNIT"; run rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_UNIT"; run systemctl --user daemon-reload
    else remove_owned_posix_service "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_UNIT" && remove_posix_cli || true; fi
  elif windows_harness_owner; then
    # The native bootstrap installed the harness and removes it through the CozyAgents Windows
    # uninstaller; what is left here is the gateway task, its Startup fallback and its PATH entry.
    local startup_entry task_xml
    startup_entry="$(windows_startup_dir)/$WINDOWS_TASK.vbs"
    if [ "$DRY_RUN" = 1 ]; then
      say "DRY   delete Scheduled Task $WINDOWS_TASK and Startup entry $startup_entry"
    else
      task_xml="$(MSYS_NO_PATHCONV=1 schtasks.exe /Query /TN "$WINDOWS_TASK" /XML 2>/dev/null || true)"
      if [ -n "$task_xml" ] || [ -f "$startup_entry" ]; then
        load_windows_wrapper_identity || die "CozyGateway supervisor ownership could not be verified; preserving installed Gateway state"
      fi
      [ -z "$task_xml" ] || windows_recorded_task_is_owned || die "CozyGateway Scheduled Task ownership could not be verified; preserving installed Gateway state"
      [ ! -f "$startup_entry" ] || windows_startup_entry_is_owned "$startup_entry" || die "CozyGateway Startup entry ownership could not be verified; preserving installed Gateway state"
      [ -z "$task_xml" ] || MSYS_NO_PATHCONV=1 schtasks.exe /Delete /F /TN "$WINDOWS_TASK" >/dev/null 2>&1 || true
      [ ! -f "$startup_entry" ] || rm -f "$startup_entry"
      stop_owned_windows_gateway 0 || true
      remove_windows_cli_path
    fi
  else
    die "the CozyAgents harness is not installed by this script on Windows"
  fi
  launcher="$home/bin/cozyagents"
  if windows_harness_owner; then
    say "INFO  the Windows bootstrap removes the CozyAgents harness through its own uninstaller"
  elif [ -x "$launcher" ]; then
    run "$launcher" uninstall --home "$home" --yes
    say "OK    removed the CozyAgents harness through its own uninstaller"
  else
    say "WARN  the cozyagents command is gone; leaving $home untouched"
  fi
  run rm -rf "$GATEWAY_DIR"
  say "OK    removed only CozyGateway-owned state; nothing else on this machine was changed"
}
uninstall() {
  local profiles root hermes_bin dashboard_port p home plugin spool action hermes_available=1
  if [ ! -f "$STATE_FILE" ]; then
    resolve_platform
    say "WARN  CozyGateway install state is missing; removing recoverable current-user files only"
    if [ "$DRY_RUN" = 1 ]; then run rm -rf "$GATEWAY_DIR"; return; fi
    if [ "$SERVICE_PLATFORM" = Windows ]; then
      local startup_entry task_xml owned=0 task_owned=0 startup_owned=0
      startup_entry="$(windows_startup_dir)/$WINDOWS_TASK.vbs"
      task_xml="$(MSYS_NO_PATHCONV=1 schtasks.exe /Query /TN "$WINDOWS_TASK" /XML 2>/dev/null || true)"
      if [ -n "$task_xml" ] && { windows_recorded_task_is_owned || windows_task_is_directly_owned_by_gateway_home; }; then task_owned=1
      elif [ -n "$task_xml" ]; then die "CozyGateway Scheduled Task ownership could not be verified; preserving partial Gateway state"; fi
      if [ -f "$startup_entry" ] && windows_startup_entry_is_owned "$startup_entry"; then startup_owned=1
      elif [ -f "$startup_entry" ]; then die "CozyGateway Startup entry ownership could not be verified; preserving partial Gateway state"; fi
      if [ "$task_owned" = 1 ]; then
        MSYS_NO_PATHCONV=1 schtasks.exe /Delete /F /TN "$WINDOWS_TASK" >/dev/null 2>&1 || true; owned=1
      fi
      if [ "$startup_owned" = 1 ]; then rm -f "$startup_entry"; owned=1; fi
      if [ "$owned" = 1 ]; then remove_windows_cli_path
      else say "WARN  CozyGateway Windows launcher ownership could not be verified; leaving task, Startup entry, and PATH untouched"; fi
    elif [ "$SERVICE_PLATFORM" = Darwin ]; then
      posix_service_is_owned_or_absent "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist" || die "CozyGateway launchd ownership could not be verified; preserving partial Gateway state"
      remove_owned_posix_service "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist" && remove_posix_cli || true
    elif [ "$SERVICE_PLATFORM" = Linux ]; then
      posix_service_is_owned_or_absent "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_UNIT" || die "CozyGateway systemd ownership could not be verified; preserving partial Gateway state"
      remove_owned_posix_service "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_UNIT" && remove_posix_cli || true
    fi
    rm -rf "$GATEWAY_DIR"; say "OK    removed partial CozyGateway state; Hermes was not changed"
    return
  fi
  # install-state contains only profile names, paths, and lifecycle state; no secrets.
  if [ "$(sed -n 's/^harness=//p' "$STATE_FILE" | tail -1)" = cozyagents ]; then uninstall_cozyagents; return; fi
  root="$(sed -n 's/^hermes_root=//p' "$STATE_FILE" | tail -1)"
  hermes_bin="$(sed -n 's/^hermes_bin=//p' "$STATE_FILE" | tail -1)"
  load_windows_state_identity || die "installer state has conflicting Windows supervisor identity"
  if grep -q '^dashboard_port=' "$STATE_FILE"; then
    dashboard_port="$(sed -n 's/^dashboard_port=//p' "$STATE_FILE" | tail -1)"
    [ -n "$dashboard_port" ] || die "installer state has an unsafe Dashboard port"
  else
    dashboard_port="$DASHBOARD_PORT"
  fi
  profiles="$(sed -n 's/^profiles=//p' "$STATE_FILE" | tail -1)"
  [ -n "$root" ] && [ -n "$hermes_bin" ] && [ -n "$profiles" ] || die "install state is incomplete"
  case "$hermes_bin" in /*) ;; *) die "installer state has an unsafe Hermes executable path" ;; esac
  [ -f "$hermes_bin" ] && [ -x "$hermes_bin" ] || hermes_available=0
  HERMES_RESOLVED="$hermes_bin"; HERMES_ROOT="$root"
  case "$dashboard_port" in ''|*[!0-9]*) die "installer state has an unsafe Dashboard port" ;; esac
  [ "$dashboard_port" -ge 1 ] && [ "$dashboard_port" -le 65535 ] || die "installer state has an unsafe Dashboard port"
  DASHBOARD_PORT="$dashboard_port"
  resolve_platform
  HARNESS=hermes
  if [ "$SERVICE_PLATFORM" = Windows ]; then
    local startup_entry task_xml
    startup_entry="$(windows_startup_dir)/$WINDOWS_TASK.vbs"
    if [ "$DRY_RUN" = 1 ]; then
      say "DRY   delete Scheduled Task $WINDOWS_TASK and Startup entry $startup_entry"
    else
      task_xml="$(MSYS_NO_PATHCONV=1 schtasks.exe /Query /TN "$WINDOWS_TASK" /XML 2>/dev/null || true)"
      if [ -n "$task_xml" ] || [ -f "$startup_entry" ]; then
        load_windows_wrapper_identity || die "CozyGateway supervisor ownership could not be verified; preserving installed Gateway state"
      fi
      [ -z "$task_xml" ] || windows_recorded_task_is_owned || die "CozyGateway Scheduled Task ownership could not be verified; preserving installed Gateway state"
      [ ! -f "$startup_entry" ] || windows_startup_entry_is_owned "$startup_entry" || die "CozyGateway Startup entry ownership could not be verified; preserving installed Gateway state"
      [ -z "$task_xml" ] || MSYS_NO_PATHCONV=1 schtasks.exe /Delete /F /TN "$WINDOWS_TASK" >/dev/null 2>&1 || true
      [ ! -f "$startup_entry" ] || rm -f "$startup_entry"
      stop_owned_windows_gateway 0 || true
    fi
    stop_owned_windows_dashboard_for_uninstall
    [ "$DRY_RUN" = 1 ] || remove_windows_cli_path
  elif [ "$SERVICE_PLATFORM" = Darwin ]; then
    if [ "$DRY_RUN" = 1 ]; then run launchctl bootout "gui/$(id -u)/$SERVICE_LABEL"; run rm -f "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
    else remove_owned_posix_service "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist" && remove_posix_cli || true; fi
  else
    if [ "$DRY_RUN" = 1 ]; then run systemctl --user disable --now "$SERVICE_UNIT"; run rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_UNIT"; run systemctl --user daemon-reload
    else remove_owned_posix_service "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_UNIT" && remove_posix_cli || true; fi
  fi
  IFS=',' read -r -a SELECTED <<<"$profiles"
  for p in "${SELECTED[@]}"; do
    valid_profile "$p" || die "unsafe profile in installer state"; home="$(profile_home "$p")"; plugin="$home/plugins/cozygateway"; spool="$home/plugin-data/cozygateway/attach-v1.sqlite"
    action="$(prior_service_action "$p")"
    case "$action" in installed|started|preexisting|unknown) ;; '') die "missing Hermes gateway lifecycle state for profile $p" ;; *) die "unsafe Hermes gateway lifecycle state for profile $p" ;; esac
    if [ "$hermes_available" = 1 ]; then
      case "$action" in
        installed) run "$HERMES_RESOLVED" -p "$p" gateway uninstall; say "OK    removed Hermes gateway service installed by CozyGateway for profile $p" ;;
        started) run "$HERMES_RESOLVED" -p "$p" gateway stop; say "OK    stopped Hermes gateway service started by CozyGateway for profile $p" ;;
        preexisting|unknown) ;;
      esac
      if [ -f "$plugin/.cozygateway-installer-owned" ]; then run "$HERMES_RESOLVED" -p "$p" plugins disable cozygateway; fi
    else
      say "INFO  Hermes executable is unavailable; removing CozyGateway files without invoking Hermes lifecycle commands"
    fi
    [ -f "$plugin/.cozygateway-installer-owned" ] && run rm -rf "$plugin"
    env_remove_owned "$home/.env"
    if [ "$DRY_RUN" = 1 ]; then
      run rm -f "$spool" "$spool-wal" "$spool-shm"
    elif ! rm -f "$spool" "$spool-wal" "$spool-shm" 2>/dev/null; then
      [ "$SERVICE_PLATFORM" = Windows ] && [ "$hermes_available" = 1 ] || die "could not remove the CozyGateway spool for profile $p"
      case "$action" in
        preexisting)
          say "INFO  restarting the pre-existing Hermes gateway for profile $p to release the disabled CozyGateway spool"
          "$HERMES_RESOLVED" -p "$p" gateway restart >/dev/null || die "could not restart the pre-existing Hermes gateway for profile $p during cleanup"
          rm -f "$spool" "$spool-wal" "$spool-shm" || die "Hermes restarted, but the CozyGateway spool for profile $p is still in use"
          ;;
        installed|started)
          say "INFO  stopping the installer-owned Hermes gateway for profile $p to release the disabled CozyGateway spool"
          "$HERMES_RESOLVED" -p "$p" gateway stop >/dev/null || die "could not stop the installer-owned Hermes gateway for profile $p during cleanup"
          rm -f "$spool" "$spool-wal" "$spool-shm" || die "Hermes stopped, but the CozyGateway spool for profile $p is still in use"
          ;;
        *) die "could not remove the CozyGateway spool for profile $p" ;;
      esac
    fi
  done
  run rm -rf "$GATEWAY_DIR"; say "OK    removed only CozyGateway-owned state; Hermes profiles and Hermes services remain"
}
# What a CozyAgents harness has instead of attach health: the runner's own row, asked for with the
# runner's own token, which is the only thing that token opens. The token goes in through stdin, not
# argv, so it never appears in this machine's process list.
status_runner() {
  local home token origin answer name
  home="$(sed -n 's/^cozyagents_home=//p' "$STATE_FILE" | tail -1)"
  [ -n "$home" ] || home="$COZYAGENTS_HOME_DIR"
  token="$(env_get "$home/runner.env" COZYRUNNER_TOKEN)"
  name="$(env_get "$home/runner.env" COZYRUNNER_NAME)"
  origin="$(env_get "$home/runner.env" COZYRUNNER_GATEWAY_URL)"
  [ -n "$origin" ] || origin="${PUBLIC_URL:-$(gateway_origin)}"
  if [ -z "$token" ]; then
    say "FAIL  no runner is paired on this computer; run: cozyagents runner pair <code>"
    return 1
  fi
  answer="$(printf 'Authorization: Bearer %s\n' "$token" |
    curl -s --max-time 5 "$origin/runners/self" -H @- 2>/dev/null |
    "$NODE_RESOLVED" -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{const r=JSON.parse(b);if(typeof r?.name!=="string")return process.exit(1);const seen=typeof r.lastSeenAt==="number"?new Date(r.lastSeenAt).toISOString():"never";process.stdout.write(`runner "${r.name}", last seen ${seen}, ${r.attached===true?"attached":"not attached"}`)}catch{process.exit(1)}})' 2>/dev/null || true)"
  if [ -n "$answer" ]; then
    say "OK    $answer"
    return 0
  fi
  say "WARN  the gateway did not answer /runners/self; reporting the local runner state instead"
  say "INFO  runner \"${name:-unnamed}\" is paired to $origin on this computer"
  return 0
}
status_install() {
  local persisted=0 live=0 startup_entry code harness=""
  resolve_platform
  [ ! -f "$STATE_FILE" ] || harness="$(sed -n 's/^harness=//p' "$STATE_FILE" | tail -1)"
  if [ -z "$harness" ] && [ -f "$STATE_FILE" ] && grep -q '^hermes_root=' "$STATE_FILE"; then harness=hermes; fi
  case "$harness" in
    cozyagents) say "OK    harness: CozyAgents (bots run here under the CozyAgents runner)"; status_runner || true ;;
    hermes) say "OK    harness: Hermes Agent" ;;
  esac
  if [ "$SERVICE_PLATFORM" = Windows ]; then
    startup_entry="$(windows_startup_dir)/$WINDOWS_TASK.vbs"
    MSYS_NO_PATHCONV=1 schtasks.exe /Query /TN "$WINDOWS_TASK" >/dev/null 2>&1 && { say "OK    Scheduled Task registered: $WINDOWS_TASK"; persisted=1; }
    [ -f "$startup_entry" ] && { say "OK    Startup login item registered: $startup_entry"; persisted=1; }
  elif [ "$SERVICE_PLATFORM" = Darwin ]; then
    launchctl print "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 && { say "OK    launchd service registered: $SERVICE_LABEL"; persisted=1; }
  else
    systemctl --user is-enabled "$SERVICE_UNIT" >/dev/null 2>&1 && { say "OK    systemd user service registered: $SERVICE_UNIT"; persisted=1; }
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$(gateway_origin)/health" 2>/dev/null || true)"
  [ "$code" = 200 ] && { say "OK    CozyGateway health endpoint is live"; live=1; }
  [ "$persisted" = 1 ] || say "FAIL  CozyGateway login persistence is absent"
  [ "$live" = 1 ] || say "FAIL  CozyGateway health endpoint is not responding"
  [ "$persisted" = 1 ] && [ "$live" = 1 ]
}
announce_listener() {
  if [ -n "$PUBLIC_URL" ]; then
    say "OK    CozyGateway listens on $BIND_HOST:$PORT and advertises $PUBLIC_URL. HTTPS exposure is user-managed."
  elif [ "$BIND_HOST" = 0.0.0.0 ] || [ "$BIND_HOST" = :: ]; then
    say "OK    CozyGateway listens on $BIND_HOST:$PORT for devices on your local network."
    say "WARN  LAN access is plaintext; use it only on a trusted private network."
    say "INFO  for remote access, switch to Tailscale: https://cozylabs.ai/docs/access/"
  else
    say "OK    CozyGateway listens on $BIND_HOST:$PORT. External exposure is user-managed and requires HTTPS."
  fi
}
# First setup ends ready to scan. Updates preserve existing device trust and ask before creating
# any new credential; unattended updates take the default No, and --no-qr never prints one at all.
pairing_and_finish() {
  if [ "$NO_QR" = 1 ]; then
    say "INFO  no pairing QR was printed (--no-qr); run $CLI_WRAPPER pair when you want to add a device"
  elif [ "$DRY_RUN" = 1 ]; then
    if [ "$INSTALL_ALREADY_CONFIGURED" = 1 ]; then say "DRY   ask before minting a new pairing code (default: no)"
    else say "DRY   mint pairing code and QR with $CLI_WRAPPER pair"
    fi
  elif should_mint_pairing_code; then
    "$CLI_WRAPPER" pair --config "$CONFIG_JSON"
  else
    say "INFO  no new pairing code created; run $CLI_WRAPPER pair when you want to add a device"
  fi
  say "INFO  codes expire after 10 minutes; mint a fresh QR and code with: $CLI_WRAPPER pair"
  say "INFO  for a tunnel, rerun the installer with: --public-url https://gateway.example.com"
}
# The CozyAgents branch: the same gateway, with no Hermes discovery, no plugin, no profiles, no
# Hermes Dashboard and no attach-health wait, plus the harness and its pairing.
#
# On Windows the harness half belongs to the native bootstrap: scripts/install.ps1 asks the model
# and network questions, runs the CozyAgents PowerShell installer, writes the runner model keys,
# mints the runner code and prints the QR. It says so with COZYGATEWAY_WINDOWS_HARNESS_OWNER=1,
# and this script then owns the gateway alone. Without that, Windows still has no CozyAgents
# harness to install from here.
install_with_cozyagents() {
  local prerequisite_missing="$1"
  if ! windows_harness_owner; then
    is_windows && die "on Windows the CozyAgents harness has its own one-liner: irm https://cozylabs.ai/agents.ps1 | iex"
  fi
  say "OK    harness: CozyAgents; your bots run on this computer under the CozyAgents runner"
  windows_harness_owner || confirm_cozyagents_model
  if [ "$prerequisite_missing" = 1 ]; then
    say "DRY   after prerequisites, configure CozyGateway with no Hermes endpoint, install CozyAgents, and pair it"
    return
  fi
  choose_fresh_listener
  validate_listener_settings
  is_windows && preflight_windows_service_ownership
  [ "$DRY_RUN" = 1 ] || mkdir -p "$LOCAL_DIR"
  write_cozyagents_state
  write_cozyagents_gateway_env
  write_cozyagents_gateway_config
  write_cli_wrapper
  install_service
  wait_gateway_ready
  is_windows || install_posix_cli
  if windows_harness_owner; then
    announce_listener
    say "INFO  the Windows bootstrap installs and pairs the CozyAgents harness from here"
    return
  fi
  install_cozyagents_harness
  announce_listener
  pairing_and_finish
}
main() {
  local prerequisite_missing=0 profile action
  if [ "$UNINSTALL" = 1 ]; then uninstall; return; fi
  preflight_service_manager
  if NODE_RESOLVED="$(resolve_node)"; then say "OK    using Node.js $("$NODE_RESOLVED" -p 'process.versions.node') at $NODE_RESOLVED"
  elif [ "$DRY_RUN" = 1 ]; then say "DRY   install the current Node.js 24 release under $GATEWAY_DIR/runtime/node from checksum-verified nodejs.org assets"; prerequisite_missing=1
  else install_node_runtime
  fi
  [ "$prerequisite_missing" = 1 ] || hydrate_listener_settings
  if [ "$STATUS" = 1 ]; then validate_listener_settings; status_install; return; fi
  [ -n "$BUNDLE_PATH" ] && [ -f "$BUNDLE_PATH" ] || die "--bundle must name the verified release bundle"
  # Step 1 of the approved order: the harness, before anything is installed.
  choose_harness
  if [ "$HARNESS" = cozyagents ]; then
    # A bridge nobody asked to remove decides the whole run, not just the config write: this stays
    # a Hermes install end to end, with no CozyAgents harness, no runner pairing and no runner
    # model keys, until someone passes --harness cozyagents or answers the question.
    detect_kept_hermes_bridge
    if [ "$KEPT_HERMES_BRIDGE" = 1 ]; then
      say "WARN  this config already has a Hermes endpoint and no one chose CozyAgents here; keeping it. Rerun with --harness cozyagents to replace it."
      say "INFO  continuing as a Hermes install; nothing CozyAgents-owned is installed, paired, or configured here."
      HARNESS=hermes
    else
      install_with_cozyagents "$prerequisite_missing"; return
    fi
  fi
  [ -n "$PLUGIN_ARCHIVE" ] && [ -f "$PLUGIN_ARCHIVE" ] || die "--plugin-archive must name the verified release archive"
  if [ -n "$HERMES_FOUND" ]; then HERMES_RESOLVED="$HERMES_FOUND"; say "OK    using Hermes at $HERMES_RESOLVED"
  elif [ "$DRY_RUN" = 1 ]; then say "DRY   install Hermes Agent with the verified official tagged NousResearch installer, then resume CozyGateway setup"; prerequisite_missing=1
  elif is_windows; then die "Hermes must already be installed"
  else install_hermes
  fi
  is_windows || confirm_hermes_model
  if [ "$prerequisite_missing" = 1 ]; then
    say "DRY   after prerequisites, configure CozyGateway and require healthy attach state before printing pairing material"
    return
  fi
  choose_fresh_listener
  validate_listener_settings
  HERMES_BIN="$HERMES_RESOLVED"; HERMES_ROOT="$(cd -P "$(discover_root)" && pwd)"; hydrate_profile_scope; discover_profiles
  say "Using Hermes root: $HERMES_ROOT"; say "Profiles: ${SELECTED[*]}"; [ "$DRY_RUN" = 1 ] || mkdir -p "$LOCAL_DIR"
  is_windows && preflight_windows_service_ownership
  for profile in "${SELECTED[@]}"; do action="$(prior_service_action "$profile")"; record_service_action "$profile" "${action:-unknown}"; done
  write_state; write_gateway_env
  # Stage every profile before enabling any of them. Hermes can materialize inherited global
  # plugins into profile-local directories when the default profile is enabled; enabling first
  # would create an unowned legacy copy and make the next profile fail closed.
  for profile in "${SELECTED[@]}"; do install_plugin "$profile" "$(profile_home "$profile")"; done
  for profile in "${SELECTED[@]}"; do enable_plugin "$profile"; done
  write_gateway_config; write_cli_wrapper; write_dashboard_owner_helper; is_windows && write_dashboard_elevation_helper; start_dashboard; install_service; wait_gateway_ready
  ensure_hermes_gateways; write_state; wait_attach_ready
  is_windows || install_posix_cli
  announce_listener
  pairing_and_finish
}
main

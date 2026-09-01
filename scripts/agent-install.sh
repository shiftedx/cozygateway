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
DRY_RUN=0
UNINSTALL=0
STATUS=0
SERVICE_PLATFORM="${COZYGATEWAY_SERVICE_PLATFORM:-}"
TOKENS=()
TOKEN_ENVS=()
SERVICE_PROFILES=()
SERVICE_ACTIONS=()
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
  --plugin-archive PATH   verified CozyGateway Hermes plugin archive
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
  local parent base
  case "$GATEWAY_DIR" in ''|/|"$HOME") die "--gateway-dir must name a dedicated directory, never empty, /, or $HOME" ;; esac
  case "$GATEWAY_DIR" in /*) ;; *) GATEWAY_DIR="$(pwd -P)/$GATEWAY_DIR" ;; esac
  parent="$(dirname "$GATEWAY_DIR")"; base="$(basename "$GATEWAY_DIR")"
  [ "$base" != . ] && [ "$base" != .. ] || die "--gateway-dir must not resolve to . or .."
  [ -d "$parent" ] && GATEWAY_DIR="$(cd -P "$parent" && pwd)/$base"
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
CLI_WRAPPER="$GATEWAY_DIR/bin/cozygateway"
CLI_WINDOWS="$GATEWAY_DIR/bin/cozygateway.cmd"
POSIX_BOOTSTRAP="$GATEWAY_DIR/bin/cozygateway-bootstrap.sh"
WINDOWS_BOOTSTRAP="$GATEWAY_DIR/bin/cozygateway-bootstrap.ps1"
GW_LOG="$LOCAL_DIR/cozygateway.log"
SERVICE_LABEL="ai.cozylabs.cozygateway"
SERVICE_UNIT="cozygateway.service"
WINDOWS_TASK="CozyGateway"
WINDOWS_VBS="$LOCAL_DIR/run-gateway.vbs"

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

install_plugin() {
  local profile="$1" home="$2" target stage source
  target="$home/plugins/cozygateway"
  case "$target" in "$HERMES_ROOT"/plugins/cozygateway|"$HERMES_ROOT"/profiles/*/plugins/cozygateway) ;; *) die "refusing plugin target outside the validated Hermes profile tree" ;; esac
  if [ "$DRY_RUN" = 1 ]; then say "DRY   install verified attach plugin into $target for Hermes profile $profile"; return; fi
  stage="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-plugin.XXXXXX")"; trap 'rm -rf "$stage"' RETURN
  tar -xzf "$PLUGIN_ARCHIVE" -C "$stage"; source="$stage/attach-plugin"
  [ -f "$source/plugin.yaml" ] && [ -f "$source/__init__.py" ] || die "plugin archive is incomplete"
  if [ -e "$target" ] && [ ! -f "$target/.cozygateway-installer-owned" ]; then
    die "$target already exists and is not owned by this installer"
  fi
  mkdir -p "$home/plugins"; rm -rf "$target"; mv "$source" "$target"
  printf 'installed by cozygateway agent-install.sh\n' > "$target/.cozygateway-installer-owned"
  rm -rf "$stage"; trap - RETURN
}
enable_plugin() {
  local profile="$1"
  if [ "$DRY_RUN" = 1 ]; then say "DRY   enable verified attach plugin for Hermes profile $profile"; return; fi
  "$HERMES_BIN" -p "$profile" plugins enable cozygateway --no-allow-tool-override >/dev/null
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
const existingEndpoint = Array.isArray(existing.hermesEndpoints)
  ? existing.hermesEndpoints.find((endpoint) => endpoint?.id === 'default')
  : undefined;
const hiddenProfiles = [...new Set([
  'default',
  ...(Array.isArray(existingEndpoint?.hiddenProfiles) ? existingEndpoint.hiddenProfiles : []),
])];
const managed = {
  name: 'cozygateway', host, port: Number(port), dbPath, ...(publicUrl === '' ? {} : { publicUrl }),
  hermesEndpoints: [{ id: 'default', url: `ws://127.0.0.1:${dashboardPort}/api/ws`, authMode: 'token', tokenEnv: 'COZYGATEWAY_HERMES_TOKEN', profile: 'default', hiddenProfiles, profiles }],
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
        run "$HERMES_BIN" -p "$profile" gateway restart
        action="${prior:-preexisting}"
        say "OK    restarted Hermes gateway service for profile $profile"
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
  local profile
  [ "$DRY_RUN" = 1 ] && return
  umask 077
  {
    printf 'profiles='; (IFS=,; printf '%s' "${SELECTED[*]}")
    printf '\nprofile_scope=%s' "$PROFILE_SPEC"
    printf '\nhermes_root=%s\n' "$HERMES_ROOT"
    printf 'dashboard_port=%s\n' "$DASHBOARD_PORT"
    # Keep the exact executable that performed the install. `--uninstall` may
    # run long after PATH or COZYGATEWAY_HERMES_BIN changed, and must not tear
    # down the CozyGateway service before discovering it cannot reverse the
    # Hermes work it owns.
    printf 'hermes_bin=%s\n' "$HERMES_RESOLVED"
    for profile in "${SELECTED[@]}"; do printf 'service_%s=%s\n' "$profile" "$(service_action_for "$profile")"; done
  } > "$STATE_FILE"
  chmod 600 "$STATE_FILE"
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
write_wrapper() {
  local gateway_env_arg dashboard_env_arg hermes_root_arg hermes_arg launcher_arg owner_helper_arg bundle_arg config_arg windows_dashboard_profile=0
  [ "$DRY_RUN" = 1 ] && { say "DRY   write 0700 gateway wrapper that reads $GATEWAY_ENV at runtime"; return; }
  gateway_env_arg="$GATEWAY_ENV"; dashboard_env_arg="$DASHBOARD_ENV"; hermes_root_arg="$HERMES_ROOT"
  hermes_arg="$HERMES_RESOLVED"; launcher_arg="$HERMES_ROOT/bin/hermes.exe"; owner_helper_arg="$DASHBOARD_OWNER_PS1"; bundle_arg="$BUNDLE_PATH"; config_arg="$CONFIG_JSON"
  if is_windows; then
    windows_dashboard_profile=1
    gateway_env_arg="$(to_windows_path "$gateway_env_arg")"
    dashboard_env_arg="$(to_windows_path "$dashboard_env_arg")"
    hermes_root_arg="$(to_windows_path "$hermes_root_arg")"
    hermes_arg="$(to_windows_path "$hermes_arg")"
    launcher_arg="$(to_windows_path "$launcher_arg")"
    owner_helper_arg="$(to_windows_path "$owner_helper_arg")"
    bundle_arg="$(to_windows_path "$bundle_arg")"
    config_arg="$(to_windows_path "$config_arg")"
  fi
  # shellcheck disable=SC2016,SC2086,SC2154
  umask 077; cat > "$WRAPPER" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
exec "$NODE_RESOLVED" - "$gateway_env_arg" "$dashboard_env_arg" "$hermes_root_arg" "$hermes_arg" "$launcher_arg" "$owner_helper_arg" "$DASHBOARD_PORT" "$bundle_arg" "$config_arg" <<'NODE'
const { readFileSync, unwatchFile, watchFile } = require('node:fs');
const { spawn } = require('node:child_process');
const { parseEnv } = require('node:util');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function stopOwnedDashboard(child, dashboardPort, hermesRoot, hermes, launcher, ownerHelper) {
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) {
      const taskkill = (process.env.SystemRoot || process.env.WINDIR) + '\\System32\\taskkill.exe';
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      await new Promise((resolve) => { killer.once('error', resolve); killer.once('exit', resolve); });
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await wait(100);
    }
    const cleanupPort = Number(dashboardPort);
    if (!Number.isInteger(cleanupPort) || cleanupPort < 1 || cleanupPort > 65535) throw new Error('invalid Hermes Dashboard cleanup port');
    const listenerCleanup = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ownerHelper,
      hermesRoot, hermes, launcher, String(cleanupPort),
    ], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => { listenerCleanup.once('error', resolve); listenerCleanup.once('exit', resolve); });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  await wait(1000);
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function main() {
const [gatewayEnvPath, dashboardEnvPath, hermesRoot, hermes, launcher, ownerHelper, dashboardPort, bundle, config] = process.argv.slice(2);
const gatewayEnv = parseEnv(readFileSync(gatewayEnvPath, 'utf8'));
const dashboard = parseEnv(readFileSync(dashboardEnvPath, 'utf8'));
const dashboardEnv = {
  ...process.env,
  HERMES_HOME: hermesRoot,
  HERMES_DASHBOARD_SESSION_TOKEN: dashboard.DASHBOARD_SESSION_TOKEN,
};
const health = await fetch('http://127.0.0.1:' + dashboardPort + '/api/health', { signal: AbortSignal.timeout(2000) })
  .then((response) => response.status === 200 || response.status === 401)
  .catch(() => false);
let dashboardChild;
if (!health) {
  const dashboardArgs = ['dashboard', ...($windows_dashboard_profile === 1 ? ['-p', 'default'] : []), '--host', '127.0.0.1', '--port', dashboardPort, '--no-open', '--skip-build'];
  dashboardChild = spawn(hermes, dashboardArgs, { detached: true, stdio: 'ignore', env: dashboardEnv });
  await new Promise((resolve, reject) => { dashboardChild.once('spawn', resolve); dashboardChild.once('error', reject); });
}
try {
  let probe;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    probe = await fetch('http://127.0.0.1:' + dashboardPort + '/api/config', {
      headers: { 'x-hermes-session-token': dashboard.DASHBOARD_SESSION_TOKEN },
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
    if (probe?.status === 200) break;
    if (probe?.status === 401 || probe?.status === 403) throw new Error('Hermes Dashboard rejected the configured local session token');
    await wait(1000);
  }
  if (probe?.status !== 200) throw new Error('Hermes Dashboard did not become ready for authenticated local access');
} catch (error) {
  if (dashboardChild) await stopOwnedDashboard(dashboardChild, dashboardPort, hermesRoot, hermes, launcher, ownerHelper);
  throw error;
}
if (dashboardChild) dashboardChild.unref();
let child;
let restarting = false;
let shuttingDown = false;
let crashRestartTimer;
let configBytes = readFileSync(config);
const restartAfterCrash = () => {
  if (shuttingDown || crashRestartTimer) return;
  crashRestartTimer = setTimeout(() => {
    crashRestartTimer = undefined;
    if (!shuttingDown) spawnGateway();
  }, 1000);
};
const spawnGateway = () => {
  child = spawn(process.execPath, [bundle, 'serve', '--config', config], { stdio: 'inherit', env: { ...process.env, ...gatewayEnv } });
  child.on('error', (error) => { console.error(error); restartAfterCrash(); });
  child.on('exit', (code, signal) => {
    if (shuttingDown) process.exit(code ?? (signal ? 1 : 0));
    if (restarting) {
      if (crashRestartTimer) { clearTimeout(crashRestartTimer); crashRestartTimer = undefined; }
      restarting = false;
      spawnGateway();
      return;
    }
    console.error('CozyGateway exited unexpectedly (' + (code ?? signal ?? 'unknown') + '); restarting');
    restartAfterCrash();
  });
};
const restartGateway = () => {
  if (shuttingDown || restarting) return;
  if (crashRestartTimer) { clearTimeout(crashRestartTimer); crashRestartTimer = undefined; }
  restarting = true;
  if (child && child.exitCode === null) child.kill('SIGTERM');
  else { restarting = false; spawnGateway(); }
};
watchFile(config, { interval: 500 }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs) return;
  const next = readFileSync(config);
  if (next.equals(configBytes)) return;
  configBytes = next;
  restartGateway();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  shuttingDown = true;
  if (crashRestartTimer) clearTimeout(crashRestartTimer);
  unwatchFile(config);
  if (child && child.exitCode === null) child.kill(signal);
  else process.exit(0);
});
spawnGateway();
}
main();
NODE
WRAPPER
  chmod 700 "$WRAPPER"
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
write_windows_launcher() {
  local bash_posix bash_native wrapper_native command
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
    printf 'shell.Run command, 0, False\r\n'
  } > "$WINDOWS_VBS"
  chmod 600 "$WINDOWS_VBS" 2>/dev/null || true
}
stop_owned_windows_gateway() {
  local config_native code check_target_port="${1:-1}"
  config_native="$(to_windows_path "$CONFIG_JSON")"
  set +e
  MSYS_NO_PATHCONV=1 COZYGATEWAY_EXPECTED_CONFIG="$config_native" COZYGATEWAY_EXPECTED_PORT="$PORT" COZYGATEWAY_CHECK_TARGET_PORT="$check_target_port" powershell.exe -NoProfile -NonInteractive -Command '
    $ErrorActionPreference = "Stop"
    $expected = [IO.Path]::GetFullPath($env:COZYGATEWAY_EXPECTED_CONFIG)
    $managed = Get-CimInstance Win32_Process | Where-Object {
      $command = [string]$_.CommandLine
      if (-not $command.Contains("cozygateway.mjs") -or -not $command.Contains(" serve ")) { return $false }
      $tokens = @([regex]::Matches($command, "[^\s`"]+|`"[^`"]*`"") | ForEach-Object { $_.Value.Trim([char]34) })
      $candidate = $null
      for ($index = 0; $index -lt $tokens.Count; $index++) {
        if ($tokens[$index] -eq "--config" -and $index + 1 -lt $tokens.Count) { $candidate = $tokens[$index + 1]; break }
        if ($tokens[$index].StartsWith("--config=")) { $candidate = $tokens[$index].Substring(9); break }
      }
      if ([string]::IsNullOrWhiteSpace($candidate)) { return $false }
      try { [IO.Path]::GetFullPath($candidate).Equals($expected, [StringComparison]::OrdinalIgnoreCase) } catch { $false }
    } | Select-Object -First 1
    if ($null -ne $managed) {
      Stop-Process -Id $managed.ProcessId -Force
      exit 0
    }
    if ($env:COZYGATEWAY_CHECK_TARGET_PORT -ne "1") { exit 3 }
    $connection = Get-NetTCPConnection -State Listen -LocalPort ([int]$env:COZYGATEWAY_EXPECTED_PORT) -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $connection) { exit 42 }
    exit 3
  ' >/dev/null 2>&1
  code=$?
  set -e
  [ "$code" -eq 3 ] && return 1
  [ "$code" -eq 0 ] || die "port $PORT is owned by a process this installer cannot safely stop"
  [ "$check_target_port" = 0 ] && return 0
  for _ in $(seq 1 10); do gateway_ready || return 0; sleep 1; done
  die "the previous CozyGateway process stayed listening on port $PORT"
}
install_windows_service() {
  local vbs_native task_command output code startup entry
  write_windows_launcher
  [ "$DRY_RUN" = 1 ] && { say "DRY   register current-user Scheduled Task $WINDOWS_TASK with Startup-folder fallback"; return; }
  vbs_native="$(to_windows_path "$WINDOWS_VBS")"
  task_command="wscript.exe \"$vbs_native\""
  set +e
  output="$(MSYS_NO_PATHCONV=1 schtasks.exe /Create /F /SC ONLOGON /RL LIMITED /TN "$WINDOWS_TASK" /TR "$task_command" 2>&1)"
  code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    startup="$(windows_startup_dir)"; entry="$startup/$WINDOWS_TASK.vbs"
    mkdir -p "$startup"; cp "$WINDOWS_VBS" "$entry"
    say "INFO  Scheduled Task unavailable ($output); installed current-user Startup fallback: $entry"
  else
    say "OK    registered current-user Scheduled Task $WINDOWS_TASK"
  fi
  if stop_owned_windows_gateway; then
    say "OK    stopped the previous CozyGateway process for an in-place update"
  fi
  wscript.exe "$vbs_native"
}
gateway_ready() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$(gateway_origin)/health" 2>/dev/null || true)"
  [ "$code" = 200 ]
}
wait_gateway_ready() {
  [ "$DRY_RUN" = 1 ] && { say "DRY   wait for CozyGateway health before starting Hermes attach"; return; }
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
install_service() {
  resolve_platform; write_wrapper
  if [ "$DRY_RUN" = 1 ]; then say "DRY   install one CozyGateway $SERVICE_PLATFORM service; it reuses/starts Hermes Dashboard as local control plane"; return; fi
  if [ "$SERVICE_PLATFORM" = Windows ]; then
    install_windows_service
  elif [ "$SERVICE_PLATFORM" = Darwin ]; then
    local plist="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist" loaded=0; mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$SERVICE_LABEL</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>$WRAPPER</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>$GW_LOG</string><key>StandardErrorPath</key><string>$GW_LOG</string><key>ThrottleInterval</key><integer>10</integer></dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true
    for _ in $(seq 1 10); do
      if launchctl bootstrap "gui/$(id -u)" "$plist"; then loaded=1; break; fi
      sleep 1
    done
    [ "$loaded" = 1 ] || die "launchd did not accept the CozyGateway service after 10 attempts"
  else
    local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$unit_dir"
    have loginctl || die "Linux logout/reboot persistence needs loginctl; install systemd-login or run CozyGateway as a system service"
    if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
      loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || die "Linux logout/reboot persistence needs lingering; run: sudo loginctl enable-linger $(id -un)"
    fi
    cat > "$unit_dir/$SERVICE_UNIT" <<UNIT
[Unit]
Description=CozyGateway
[Service]
ExecStart=/bin/bash $WRAPPER
Restart=always
RestartSec=5
StandardOutput=append:$GW_LOG
StandardError=append:$GW_LOG
[Install]
WantedBy=default.target
UNIT
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
uninstall() {
  local profiles root hermes_bin dashboard_port p home plugin spool action hermes_available=1
  if [ ! -f "$STATE_FILE" ]; then
    resolve_platform
    say "WARN  CozyGateway install state is missing; removing recoverable current-user files only"
    if [ "$DRY_RUN" = 1 ]; then run rm -rf "$GATEWAY_DIR"; return; fi
    if [ "$SERVICE_PLATFORM" = Windows ]; then
      local startup_entry wrapper_native vbs_native task_xml
      startup_entry="$(windows_startup_dir)/$WINDOWS_TASK.vbs"
      wrapper_native="$(to_windows_path "$WRAPPER")"; vbs_native="$(to_windows_path "$WINDOWS_VBS")"
      if [ -f "$WINDOWS_VBS" ] && grep -Fq "$wrapper_native" "$WINDOWS_VBS"; then
        task_xml="$(MSYS_NO_PATHCONV=1 schtasks.exe /Query /TN "$WINDOWS_TASK" /XML 2>/dev/null || true)"
        if grep -Fq "$vbs_native" <<<"$task_xml"; then MSYS_NO_PATHCONV=1 schtasks.exe /Delete /F /TN "$WINDOWS_TASK" >/dev/null 2>&1 || true
        else say "WARN  CozyGateway Scheduled Task ownership could not be verified; leaving it untouched"; fi
        if [ -f "$startup_entry" ] && cmp -s "$startup_entry" "$WINDOWS_VBS"; then rm -f "$startup_entry"
        elif [ -f "$startup_entry" ]; then say "WARN  CozyGateway Startup entry ownership could not be verified; leaving it untouched"; fi
        remove_windows_cli_path
      else say "WARN  CozyGateway Windows launcher ownership could not be verified; leaving task, Startup entry, and PATH untouched"; fi
    elif [ "$SERVICE_PLATFORM" = Darwin ]; then launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"; remove_posix_cli
    elif [ "$SERVICE_PLATFORM" = Linux ]; then systemctl --user disable --now "$SERVICE_UNIT" >/dev/null 2>&1 || true; rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_UNIT"; systemctl --user daemon-reload >/dev/null 2>&1 || true; remove_posix_cli
    fi
    rm -rf "$GATEWAY_DIR"; say "OK    removed partial CozyGateway state; Hermes was not changed"
    return
  fi
  # install-state contains only profile names, paths, and lifecycle state; no secrets.
  root="$(sed -n 's/^hermes_root=//p' "$STATE_FILE" | tail -1)"
  hermes_bin="$(sed -n 's/^hermes_bin=//p' "$STATE_FILE" | tail -1)"
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
  if [ "$SERVICE_PLATFORM" = Windows ]; then
    local startup_entry
    startup_entry="$(windows_startup_dir)/$WINDOWS_TASK.vbs"
    if [ "$DRY_RUN" = 1 ]; then
      say "DRY   delete Scheduled Task $WINDOWS_TASK and Startup entry $startup_entry"
    else
      MSYS_NO_PATHCONV=1 schtasks.exe /Delete /F /TN "$WINDOWS_TASK" >/dev/null 2>&1 || true
      rm -f "$startup_entry"
      stop_owned_windows_gateway 0 || true
    fi
    stop_owned_windows_dashboard_for_uninstall
    [ "$DRY_RUN" = 1 ] || remove_windows_cli_path
  elif [ "$SERVICE_PLATFORM" = Darwin ]; then
    if [ "$DRY_RUN" = 1 ]; then run launchctl bootout "gui/$(id -u)/$SERVICE_LABEL"; run rm -f "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
    else launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"; remove_posix_cli; fi
  else
    if [ "$DRY_RUN" = 1 ]; then run systemctl --user disable --now "$SERVICE_UNIT"; run rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_UNIT"; run systemctl --user daemon-reload
    else systemctl --user disable --now "$SERVICE_UNIT" >/dev/null 2>&1 || true; rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_UNIT"; systemctl --user daemon-reload >/dev/null 2>&1 || true; remove_posix_cli; fi
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
status_install() {
  local persisted=0 live=0 startup_entry code
  resolve_platform
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
  [ -n "$PLUGIN_ARCHIVE" ] && [ -f "$PLUGIN_ARCHIVE" ] || die "--plugin-archive must name the verified release archive"
  if HERMES_RESOLVED="$(find_hermes)"; then say "OK    using Hermes at $HERMES_RESOLVED"
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
  if [ -n "$PUBLIC_URL" ]; then
    say "OK    CozyGateway listens on $BIND_HOST:$PORT and advertises $PUBLIC_URL. HTTPS exposure is user-managed."
  elif [ "$BIND_HOST" = 0.0.0.0 ] || [ "$BIND_HOST" = :: ]; then
    say "OK    CozyGateway listens on $BIND_HOST:$PORT for devices on your local network."
    say "WARN  LAN access is plaintext; use it only on a trusted private network."
    say "INFO  for remote access, switch to Tailscale: https://cozylabs.ai/docs/access/"
  else
    say "OK    CozyGateway listens on $BIND_HOST:$PORT. External exposure is user-managed and requires HTTPS."
  fi
  # The finale: mint a pairing code and print the QR so install -> scan -> chatting needs no
  # further commands. A rerun on an installed gateway lands here too, with a fresh code.
  if [ "$DRY_RUN" = 0 ]; then "$CLI_WRAPPER" pair --config "$CONFIG_JSON"; else say "DRY   mint pairing code and QR with $CLI_WRAPPER pair"; fi
  say "INFO  codes expire after 10 minutes; mint a fresh QR and code with: $CLI_WRAPPER pair"
  say "INFO  for a tunnel, rerun the installer with: --public-url https://gateway.example.com"
}
main

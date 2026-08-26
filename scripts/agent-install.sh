#!/usr/bin/env bash
# Install CozyGateway next to an existing Hermes installation.
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
PROFILE_SPEC="all"
BIND_HOST="${COZYGATEWAY_BIND_HOST:-0.0.0.0}"
PORT="${COZYGATEWAY_PORT:-8787}"
DASHBOARD_PORT="${COZYGATEWAY_DASHBOARD_PORT:-9119}"
DRY_RUN=0
UNINSTALL=0
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
  --bind-host HOST        gateway listener address (default 0.0.0.0: local/LAN)
  --port PORT             gateway listener port (default 8787)
  --dashboard-port PORT   local Hermes Dashboard control-plane port (default 9119)
  --dry-run               show discovered work without changing anything
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
    --profiles) need_value "$@"; PROFILE_SPEC="$2"; shift ;;
    --bind-host) need_value "$@"; BIND_HOST="$2"; shift ;;
    --port) need_value "$@"; PORT="$2"; shift ;;
    --dashboard-port) need_value "$@"; DASHBOARD_PORT="$2"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
  shift
done

case "$PORT" in ''|*[!0-9]*) die "--port must be 1-65535" ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be 1-65535"
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
  case "$GATEWAY_DIR" in *[!A-Za-z0-9_./-]*) die "--gateway-dir may contain only letters, digits, _, ., /, and - so launchd/systemd can load it safely" ;; esac
}
canonical_gateway_dir

LOCAL_DIR="$GATEWAY_DIR/local"
CONFIG_JSON="$LOCAL_DIR/cozygateway.config.json"
GATEWAY_ENV="$LOCAL_DIR/gateway.env"
DASHBOARD_ENV="$LOCAL_DIR/dashboard.env"
STATE_FILE="$LOCAL_DIR/install-state"
WRAPPER="$LOCAL_DIR/run-gateway.sh"
CLI_WRAPPER="$GATEWAY_DIR/bin/cozygateway"
GW_LOG="$LOCAL_DIR/cozygateway.log"
SERVICE_LABEL="ai.cozylabs.cozygateway"
SERVICE_UNIT="cozygateway.service"

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null | tr -dc '0-9'; }
resolve_node() {
  local candidate major
  candidate="$NODE_BIN"
  case "$candidate" in */*) [ -x "$candidate" ] || die "node executable not found: $candidate" ;; *) have "$candidate" || die "Node.js 24+ is required" ;; esac
  major="$(node_major "$candidate")"
  [ "${major:-0}" -ge 24 ] || die "Node.js 24+ is required (found ${major:-unknown})"
  case "$candidate" in /*) printf '%s' "$candidate" ;; *) command -v "$candidate" ;; esac
}
resolve_hermes() {
  case "$HERMES_BIN" in
    /*) [ -x "$HERMES_BIN" ] || die "Hermes executable not found: $HERMES_BIN"; printf '%s' "$HERMES_BIN" ;;
    *) command -v "$HERMES_BIN" || die "Hermes must already be installed" ;;
  esac
}

# profile names are shell/file-safe Hermes identifiers. Reject anything that
# could turn a plugin or spool path into a path traversal before constructing it.
valid_profile() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || [ "$1" = default ]; }
hermes_config_path() { "$HERMES_BIN" -p "$1" config path 2>/dev/null; }
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
    *"not installed"*|*"not configured"*|*"No gateway service"*|*"Gateway service not found"*) printf 'absent' ;;
    *"Gateway is not running"*|*"Gateway is stopped"*|*"Gateway is inactive"*) printf 'stopped' ;;
    *"Gateway is supervised"*|*"Gateway is running"*|*"Gateway is active"*) printf 'running' ;;
    *) die "could not determine Hermes gateway service state for profile $1: $status" ;;
  esac
}

install_plugin() {
  local profile="$1" home="$2" target stage source
  target="$home/plugins/cozygateway"
  case "$target" in "$HERMES_ROOT"/plugins/cozygateway|"$HERMES_ROOT"/profiles/*/plugins/cozygateway) ;; *) die "refusing plugin target outside the validated Hermes profile tree" ;; esac
  if [ "$DRY_RUN" = 1 ]; then say "DRY   install verified attach plugin into $target and enable it for Hermes profile $profile"; return; fi
  stage="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-plugin.XXXXXX")"; trap 'rm -rf "$stage"' RETURN
  tar -xzf "$PLUGIN_ARCHIVE" -C "$stage"; source="$stage/attach-plugin"
  [ -f "$source/plugin.yaml" ] && [ -f "$source/__init__.py" ] || die "plugin archive is incomplete"
  if [ -e "$target" ] && [ ! -f "$target/.cozygateway-installer-owned" ]; then
    die "$target already exists and is not owned by this installer"
  fi
  mkdir -p "$home/plugins"; rm -rf "$target"; mv "$source" "$target"
  printf 'installed by cozygateway agent-install.sh\n' > "$target/.cozygateway-installer-owned"
  "$HERMES_BIN" -p "$profile" plugins enable cozygateway --no-allow-tool-override >/dev/null
  rm -rf "$stage"; trap - RETURN
}
write_gateway_config() {
  local map="$LOCAL_DIR/profiles.json" p env_name comma=""
  [ "$DRY_RUN" = 1 ] && { say "DRY   write Hermes-only gateway config at $CONFIG_JSON (no secret values)"; return; }
  umask 077; printf '{' > "$map"
  for p in "${SELECTED[@]}"; do env_name="$(token_env_name "$p")"; printf '%s\n' "$comma\"$p\":{\"tokenEnv\":\"$env_name\"}" >> "$map"; comma=,; done
  printf '}\n' >> "$map"
  "$NODE_RESOLVED" - "$map" "$CONFIG_JSON" "$BIND_HOST" "$PORT" "$LOCAL_DIR/cozygateway.sqlite" "$DASHBOARD_PORT" "$DASHBOARD_USER" <<'NODE'
const fs = require('node:fs');
const [mapPath, output, host, port, dbPath, dashboardPort, dashboardUser] = process.argv.slice(2);
const profiles = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const baseUrl = `http://127.0.0.1:${dashboardPort}`;
fs.writeFileSync(output, JSON.stringify({
  name: 'cozygateway', host, port: Number(port), dbPath,
  hermes: { url: `ws://127.0.0.1:${dashboardPort}/api/ws`, authMode: 'password', username: dashboardUser, passwordEnv: 'COZYGATEWAY_HERMES_PASSWORD', baseUrl, profile: 'default', profiles },
}, null, 2) + '\n', { mode: 0o600 });
NODE
  chmod 600 "$CONFIG_JSON" "$map"
}
prepare_dashboard_credential() {
  DASHBOARD_USER=cozygateway
  DASHBOARD_PASSWORD="$(env_get "$DASHBOARD_ENV" DASHBOARD_PASSWORD)"
  safe_secret "$DASHBOARD_PASSWORD" || DASHBOARD_PASSWORD="$(new_token)"
  [ "$DRY_RUN" = 1 ] && { say "DRY   reuse or mint local Hermes Dashboard credential in $DASHBOARD_ENV (value redacted)"; return; }
  umask 077
  : > "$DASHBOARD_ENV"
  env_write "$DASHBOARD_ENV" DASHBOARD_USERNAME "$DASHBOARD_USER"
  env_write "$DASHBOARD_ENV" DASHBOARD_PASSWORD "$DASHBOARD_PASSWORD"
  chmod 600 "$DASHBOARD_ENV"
}
write_gateway_env() {
  local p token env_name profile_env seen_token seen_name
  prepare_dashboard_credential
  [ "$DRY_RUN" = 1 ] && { say "DRY   write gateway token environment at $GATEWAY_ENV (values redacted)"; return; }
  umask 077; : > "$GATEWAY_ENV"
  env_write "$GATEWAY_ENV" COZYGATEWAY_HERMES_PASSWORD "$DASHBOARD_PASSWORD"
  for p in "${SELECTED[@]}"; do
    profile_env="$(profile_home "$p")/.env"; claim_profile_env "$profile_env"; token="$(env_get "$profile_env" COZYGATEWAY_TOKEN)"; safe_secret "$token" || token="$(new_token)"; env_name="$(token_env_name "$p")"
    for seen_token in "${TOKENS[@]:-}"; do [ "$token" != "$seen_token" ] || die "Hermes profiles must have distinct CozyGateway attach tokens"; done
    for seen_name in "${TOKEN_ENVS[@]:-}"; do [ "$env_name" != "$seen_name" ] || die "profile names produce the same token environment variable: $env_name"; done
    TOKENS+=("$token"); TOKEN_ENVS+=("$env_name")
    env_put "$profile_env" COZYGATEWAY_URL "http://127.0.0.1:$PORT"; env_put "$profile_env" COZYGATEWAY_TOKEN "$token"
    env_put "$profile_env" COZYGATEWAY_SPOOL_PATH "$(profile_home "$p")/plugin-data/cozygateway/attach-v1.sqlite"; env_put "$profile_env" COZYGATEWAY_HOME_CHANNEL thread
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
  case "$action" in ''|preexisting|started|installed) printf '%s' "$action" ;; *) die "invalid Hermes gateway lifecycle state for profile $profile" ;; esac
}
record_service_action() { SERVICE_PROFILES+=("$1"); SERVICE_ACTIONS+=("$2"); }
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
    printf '\nhermes_root=%s\n' "$HERMES_ROOT"
    # Keep the exact executable that performed the install. `--uninstall` may
    # run long after PATH or COZYGATEWAY_HERMES_BIN changed, and must not tear
    # down the CozyGateway service before discovering it cannot reverse the
    # Hermes work it owns.
    printf 'hermes_bin=%s\n' "$HERMES_RESOLVED"
    for profile in "${SELECTED[@]}"; do printf 'service_%s=%s\n' "$profile" "$(service_action_for "$profile")"; done
  } > "$STATE_FILE"
  chmod 600 "$STATE_FILE"
}
resolve_platform() { [ -n "$SERVICE_PLATFORM" ] || SERVICE_PLATFORM="$(uname -s)"; case "$SERVICE_PLATFORM" in Darwin|Linux) ;; *) die "supported service managers are launchd (macOS) and systemd --user (Linux)" ;; esac; }
write_cli_wrapper() {
  [ "$DRY_RUN" = 1 ] && { say "DRY   write executable gateway CLI at $CLI_WRAPPER"; return; }
  mkdir -p "$GATEWAY_DIR/bin"
  umask 022
  printf '#!/usr/bin/env bash\nset -euo pipefail\ncd %q\nexec %q %q "$@"\n' "$LOCAL_DIR" "$NODE_RESOLVED" "$BUNDLE_PATH" > "$CLI_WRAPPER"
  chmod 755 "$CLI_WRAPPER"
}
write_wrapper() {
  [ "$DRY_RUN" = 1 ] && { say "DRY   write 0700 gateway wrapper that reads $GATEWAY_ENV at runtime"; return; }
  # shellcheck disable=SC2016,SC2086,SC2154
  umask 077; cat > "$WRAPPER" <<WRAPPER
#!/usr/bin/env bash
set -euo pipefail
exec "$NODE_RESOLVED" - "$GATEWAY_ENV" "$DASHBOARD_ENV" "$HERMES_ROOT" "$HERMES_RESOLVED" "$DASHBOARD_PORT" "$CLI_WRAPPER" "$CONFIG_JSON" <<'NODE'
const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { parseEnv } = require('node:util');
async function main() {
const [gatewayEnvPath, dashboardEnvPath, hermesRoot, hermes, dashboardPort, cli, config] = process.argv.slice(2);
const gatewayEnv = parseEnv(readFileSync(gatewayEnvPath, 'utf8'));
const dashboard = parseEnv(readFileSync(dashboardEnvPath, 'utf8'));
const dashboardEnv = {
  ...process.env,
  HERMES_HOME: hermesRoot,
  HERMES_DASHBOARD_BASIC_AUTH_USERNAME: dashboard.DASHBOARD_USERNAME,
  HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: dashboard.DASHBOARD_PASSWORD,
};
const health = await fetch('http://127.0.0.1:' + dashboardPort + '/api/health', { signal: AbortSignal.timeout(2000) })
  .then((response) => response.status === 200 || response.status === 401)
  .catch(() => false);
if (!health) spawn(hermes, ['dashboard', '--host', '127.0.0.1', '--port', dashboardPort, '--no-open', '--skip-build'], { detached: true, stdio: 'ignore', env: dashboardEnv }).unref();
if (health) {
  const login = await fetch('http://127.0.0.1:' + dashboardPort + '/auth/password-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'basic', username: dashboard.DASHBOARD_USERNAME, password: dashboard.DASHBOARD_PASSWORD }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  if (login?.status !== 200) throw new Error('Hermes Dashboard rejected the configured local credential');
}
const child = spawn(cli, ['serve', '--config', config], { stdio: 'inherit', env: { ...process.env, ...gatewayEnv } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
main();
NODE
WRAPPER
  chmod 700 "$WRAPPER"
}
install_service() {
  resolve_platform; write_wrapper
  if [ "$DRY_RUN" = 1 ]; then say "DRY   install one CozyGateway $SERVICE_PLATFORM service; it reuses/starts Hermes Dashboard as local control plane"; return; fi
  if [ "$SERVICE_PLATFORM" = Darwin ]; then
    local plist="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"; mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>$SERVICE_LABEL</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>$WRAPPER</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>$GW_LOG</string><key>StandardErrorPath</key><string>$GW_LOG</string><key>ThrottleInterval</key><integer>10</integer></dict></plist>
PLIST
    launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true; launchctl bootstrap "gui/$(id -u)" "$plist"
  else
    local unit_dir="$HOME/.config/systemd/user"; mkdir -p "$unit_dir"
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
dashboard_credentials_work() {
  local code
  code="$(
    DASHBOARD_USERNAME="$DASHBOARD_USER" DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD" "$NODE_RESOLVED" -e 'process.stdout.write(JSON.stringify({provider:"basic", username:process.env.DASHBOARD_USERNAME, password:process.env.DASHBOARD_PASSWORD}))' |
      curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST "http://127.0.0.1:$DASHBOARD_PORT/auth/password-login" -H 'content-type: application/json' --data-binary @- 2>/dev/null || true
  )"
  [ "$code" = 200 ]
}
enable_dashboard_basic_plugin() {
  [ "$DRY_RUN" = 1 ] && { say "DRY   enable bundled Hermes dashboard_auth/basic for the root Dashboard profile"; return; }
  "$HERMES_RESOLVED" -p default plugins enable basic --no-allow-tool-override >/dev/null
}
launch_dashboard() {
  "$NODE_RESOLVED" - "$DASHBOARD_ENV" "$HERMES_ROOT" "$HERMES_RESOLVED" "$DASHBOARD_PORT" <<'NODE'
const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { parseEnv } = require('node:util');
const [dashboardEnvPath, hermesRoot, hermes, dashboardPort] = process.argv.slice(2);
const dashboard = parseEnv(readFileSync(dashboardEnvPath, 'utf8'));
const child = spawn(hermes, ['dashboard', '--host', '127.0.0.1', '--port', dashboardPort, '--no-open', '--skip-build'], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, HERMES_HOME: hermesRoot, HERMES_DASHBOARD_BASIC_AUTH_USERNAME: dashboard.DASHBOARD_USERNAME, HERMES_DASHBOARD_BASIC_AUTH_PASSWORD: dashboard.DASHBOARD_PASSWORD },
});
child.unref();
NODE
}
start_dashboard() {
  enable_dashboard_basic_plugin
  [ "$DRY_RUN" = 1 ] && { say "DRY   start/reuse Hermes Dashboard at 127.0.0.1:$DASHBOARD_PORT as the control/read plane"; return; }
  if dashboard_ready; then
    dashboard_credentials_work && return
    say "INFO  existing Hermes Dashboard rejected the configured local credential; restarting it with the installer-owned runtime credential"
    HERMES_HOME="$HERMES_ROOT" "$HERMES_RESOLVED" dashboard --stop >/dev/null 2>&1 || die "could not stop the Dashboard that rejected the local credential"
    for _ in $(seq 1 5); do dashboard_ready || break; sleep 1; done
    dashboard_ready && die "Dashboard stayed listening after stop; refusing to launch with an unverified credential"
  fi
  launch_dashboard
  for _ in $(seq 1 30); do dashboard_credentials_work && return; sleep 1; done
  die "Hermes Dashboard did not accept the local control-plane credential on 127.0.0.1:$DASHBOARD_PORT"
}
uninstall() {
  local profiles root hermes_bin p home plugin spool action
  [ -f "$STATE_FILE" ] || die "no CozyGateway install state at $STATE_FILE"
  # install-state contains only profile names, paths, and lifecycle state; no secrets.
  root="$(sed -n 's/^hermes_root=//p' "$STATE_FILE" | tail -1)"
  hermes_bin="$(sed -n 's/^hermes_bin=//p' "$STATE_FILE" | tail -1)"
  profiles="$(sed -n 's/^profiles=//p' "$STATE_FILE" | tail -1)"
  [ -n "$root" ] && [ -n "$hermes_bin" ] && [ -n "$profiles" ] || die "install state is incomplete"
  case "$hermes_bin" in /*) ;; *) die "installer state has an unsafe Hermes executable path" ;; esac
  [ -f "$hermes_bin" ] && [ -x "$hermes_bin" ] || die "Hermes executable from installer state is unavailable: $hermes_bin"
  HERMES_RESOLVED="$hermes_bin"
  resolve_platform
  if [ "$SERVICE_PLATFORM" = Darwin ]; then
    if [ "$DRY_RUN" = 1 ]; then run launchctl bootout "gui/$(id -u)/$SERVICE_LABEL"; run rm -f "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
    else launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"; fi
  else
    if [ "$DRY_RUN" = 1 ]; then run systemctl --user disable --now "$SERVICE_UNIT"; run rm -f "$HOME/.config/systemd/user/$SERVICE_UNIT"; run systemctl --user daemon-reload
    else systemctl --user disable --now "$SERVICE_UNIT" >/dev/null 2>&1 || true; rm -f "$HOME/.config/systemd/user/$SERVICE_UNIT"; systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
  fi
  IFS=',' read -r -a SELECTED <<<"$profiles"; HERMES_ROOT="$root"
  for p in "${SELECTED[@]}"; do
    valid_profile "$p" || die "unsafe profile in installer state"; home="$(profile_home "$p")"; plugin="$home/plugins/cozygateway"; spool="$home/plugin-data/cozygateway/attach-v1.sqlite"
    action="$(prior_service_action "$p")"
    case "$action" in
      installed) run "$HERMES_RESOLVED" -p "$p" gateway uninstall; say "OK    removed Hermes gateway service installed by CozyGateway for profile $p" ;;
      started) run "$HERMES_RESOLVED" -p "$p" gateway stop; say "OK    stopped Hermes gateway service started by CozyGateway for profile $p" ;;
      preexisting) ;;
      '') die "missing Hermes gateway lifecycle state for profile $p" ;;
    esac
    if [ -f "$plugin/.cozygateway-installer-owned" ]; then run "$HERMES_RESOLVED" -p "$p" plugins disable cozygateway; run rm -rf "$plugin"; fi
    env_remove_owned "$home/.env"; run rm -f "$spool" "$spool-wal" "$spool-shm"
  done
  run rm -rf "$GATEWAY_DIR"; say "OK    removed only CozyGateway-owned state; Hermes profiles and Hermes services remain"
}
main() {
  if [ "$UNINSTALL" = 1 ]; then uninstall; return; fi
  [ -n "$BUNDLE_PATH" ] && [ -f "$BUNDLE_PATH" ] || die "--bundle must name the verified release bundle"
  [ -n "$PLUGIN_ARCHIVE" ] && [ -f "$PLUGIN_ARCHIVE" ] || die "--plugin-archive must name the verified release archive"
  have "$HERMES_BIN" || die "Hermes must already be installed"; NODE_RESOLVED="$(resolve_node)"; HERMES_RESOLVED="$(resolve_hermes)"; HERMES_ROOT="$(cd -P "$(discover_root)" && pwd)"; discover_profiles
  say "Using Hermes root: $HERMES_ROOT"; say "Profiles: ${SELECTED[*]}"; mkdir -p "$LOCAL_DIR"; write_gateway_env
  for profile in "${SELECTED[@]}"; do install_plugin "$profile" "$(profile_home "$profile")"; done
  write_gateway_config; ensure_hermes_gateways; write_state; write_cli_wrapper; start_dashboard; install_service
  say "OK    CozyGateway listens on $BIND_HOST:$PORT. Remote exposure is user-managed."
  # The finale: mint a pairing code and print the QR so install -> scan -> chatting needs no
  # further commands. A rerun on an installed gateway lands here too, with a fresh code.
  if [ "$DRY_RUN" = 0 ]; then "$CLI_WRAPPER" pair --config "$CONFIG_JSON"; else say "DRY   mint pairing code and QR with $CLI_WRAPPER pair"; fi
  say "INFO  codes expire after 10 minutes; mint a fresh QR and code with: $CLI_WRAPPER pair"
  say "INFO  pair a remote URL with: $CLI_WRAPPER pair --url https://gateway.example.com"
}
main

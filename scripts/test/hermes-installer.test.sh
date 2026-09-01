#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
fake_node="$repo_root/scripts/test/fake-node24.sh"
real_node="$(command -v node)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-installer-test.XXXXXX")"
tmp="$(cd -P "$tmp" && pwd)"
stop_test_pid() {
  local pid="${1:-}" taskkill
  [ -n "$pid" ] || return 0
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      taskkill="$(cygpath -u "$WINDIR/System32/taskkill.exe")"
      MSYS2_ARG_CONV_EXCL='*' "$taskkill" /PID "$pid" /T /F >/dev/null 2>&1 || true
      ;;
    *) kill "$pid" 2>/dev/null || true ;;
  esac
}
trap 'stop_test_pid "${supervisor_pid:-}"; stop_test_pid "${mock_dashboard_pid:-}"; stop_test_pid "${failed_dashboard_pid:-}"; stop_test_pid "${foreign_dashboard_pid:-}"; rm -rf "$tmp"' EXIT
# Under `set -e` a bare assertion dies with no output at all, so a failure on a machine you cannot
# reach reads as "it stopped somewhere". Name the line and the command that failed.
trap 'status=$?; [ "$status" -eq 0 ] || printf "FAIL  line %s exited %s: %s\n" "$LINENO" "$status" "$BASH_COMMAND" >&2' ERR

# An assertion that greps a captured string and fails prints only the line number, which says
# nothing about what the string actually contained. This shows it.
expect_contains() {
  local haystack="$1" needle="$2"
  if ! grep -q "$needle" <<<"$haystack"; then
    printf 'FAIL  expected output to contain: %s\n--- actual output ---\n%s\n--- end ---\n' \
      "$needle" "$haystack" >&2
    return 1
  fi
}
mkdir -p "$tmp/hermes/profiles/ops" "$tmp/hermes/profiles/active" "$tmp/bin"
printf '{}\n' > "$tmp/hermes/config.yaml"
printf '{}\n' > "$tmp/hermes/profiles/ops/config.yaml"
printf '{}\n' > "$tmp/hermes/profiles/active/config.yaml"
credential_marker="$tmp/dashboard-credential-was-evaluated"
# shellcheck disable=SC2016
printf '%s\n' \
  'HERMES_DASHBOARD_BASIC_AUTH_USERNAME="cozy user"' \
  'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="spaces $dollar `touch '"$credential_marker"'` $(touch '"$credential_marker"') \\"quote\\""' \
  > "$tmp/hermes/.env"
cat > "$tmp/bin/hermes" <<'HERMES'
#!/usr/bin/env bash
root="${COZYGATEWAY_TEST_HERMES_ROOT:?}"
profile="${2:-}"
state_file="$root/gateway-$profile.state"
state() { [ -f "$state_file" ] && cat "$state_file" || printf 'absent'; }
set_state() { printf '%s\n' "$1" > "$state_file"; }
log() { printf '%s\n' "$profile:gateway:$1" >> "${COZYGATEWAY_TEST_COMMAND_LOG:?}"; }
if { [ "$1" = dashboard ] && [ "${2:-}" = --stop ]; } || { [ "$1" = dashboard ] && [ "${2:-}" = -p ] && [ "${3:-}" = default ] && [ "${4:-}" = --stop ]; }; then
  [ -n "${COZYGATEWAY_TEST_DASHBOARD_STOP_HOME_LOG:-}" ] || exit 0
  printf '%s\n' "${HERMES_HOME:-}" > "$COZYGATEWAY_TEST_DASHBOARD_STOP_HOME_LOG"
  [ "${HERMES_HOME:-}" = "${COZYGATEWAY_TEST_EXPECTED_DASHBOARD_HOME:?}" ] || exit 42
fi
if [ "$1" = model ]; then
  printf 'model\n' >> "${COZYGATEWAY_TEST_COMMAND_LOG:?}"
  [ "${COZYGATEWAY_TEST_MODEL_DECLINE:-}" = 1 ] && exit 1
  exit 0
fi
if [ "$1" = status ]; then
  if [ -n "${COZYGATEWAY_TEST_MODEL_UNCONFIGURED_ONCE_FILE:-}" ] && [ ! -f "$COZYGATEWAY_TEST_MODEL_UNCONFIGURED_ONCE_FILE" ]; then
    : > "$COZYGATEWAY_TEST_MODEL_UNCONFIGURED_ONCE_FILE"
    printf 'Current model: \nActive provider: \n'
    exit 0
  fi
  if [ "${COZYGATEWAY_TEST_MODEL_UNCONFIGURED:-}" = 1 ]; then
    printf 'Current model: \nActive provider: \n'
    exit 0
  fi
  printf 'Current model: test/model\nActive provider: test-provider\n'
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "config" ] && [ "$4" = "path" ]; then
  [ "$2" = default ] && printf '%s/config.yaml\n' "$root" || printf '%s/profiles/%s/config.yaml\n' "$root" "$2"
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "config" ] && [ "$4" = "get" ] && [ "$5" = "plugins.disabled" ]; then
  if [ -n "${COZYGATEWAY_TEST_DISABLED_PLUGINS_FILE:-}" ]; then
    cat "$COZYGATEWAY_TEST_DISABLED_PLUGINS_FILE"
  else
    printf '[]\n'
  fi
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "config" ] && [ "$4" = "set" ] && [ "$5" = "plugins.disabled" ]; then
  [ -n "${COZYGATEWAY_TEST_DISABLED_PLUGINS_FILE:-}" ] || exit 2
  # Match pre-July Hermes: structured command-line values were stored as
  # strings. The installer must not use this path to repair a typed list.
  "$COZYGATEWAY_TEST_REAL_NODE" -e 'process.stdout.write(JSON.stringify(process.argv[1]) + "\n")' "$6" > "$COZYGATEWAY_TEST_DISABLED_PLUGINS_FILE"
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "config" ] && [ "$4" = "unset" ] && [[ "$5" = plugins.disabled.* ]]; then
  [ -n "${COZYGATEWAY_TEST_DISABLED_PLUGINS_FILE:-}" ] || exit 2
  "$COZYGATEWAY_TEST_REAL_NODE" - "$COZYGATEWAY_TEST_DISABLED_PLUGINS_FILE" "${5##*.}" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const [path, rawIndex] = process.argv.slice(2);
const disabled = JSON.parse(readFileSync(path, 'utf8'));
const index = Number(rawIndex);
if (!Array.isArray(disabled) || !Number.isSafeInteger(index) || index < 0 || index >= disabled.length) process.exit(2);
disabled.splice(index, 1);
writeFileSync(path, JSON.stringify(disabled) + '\n');
NODE
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "gateway" ] && [ "$4" = "status" ]; then
  if [ "${COZYGATEWAY_TEST_WINDOWS_STATUS:-}" = 1 ] && [ "$profile" = active ]; then
    printf '✓ Scheduled Task registered: Hermes_Gateway\n  Status: Ready\n✓ Gateway process running (PID: 33036)\n'
    exit 0
  fi
  case "$(state)" in
    absent) printf '✗ Gateway is not running\n\nTo start:\n  hermes gateway run      # Run in foreground\n  hermes gateway install  # Install as user service\n' ;;
    stopped) printf 'Gateway is not running\n' ;;
    running) printf 'Gateway is supervised\n' ;;
  esac
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "gateway" ]; then
  case "$4" in
    restart)
      [ "$(state)" = running ] || exit 2
      log restart
      set_state running
      if [ -n "${COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER:-}" ] && [ "$profile" = "${COZYGATEWAY_TEST_LOCKED_SPOOL_PROFILE:-}" ]; then
        : > "$COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER.unlocked"
      fi
      ;;
    start) [ "$(state)" = stopped ] || exit 2; log start; set_state running ;;
    install) [ "$(state)" = absent ] || exit 2; [ "$5" = --start-now ] && [ "$6" = --start-on-login ] || exit 2; log install; set_state running ;;
    stop)
      [ "$(state)" = running ] || exit 2
      log stop
      if [ "${COZYGATEWAY_TEST_STOP_LEAVES_RUNNING_ONCE:-}" = 1 ] && [ "$profile" = "${COZYGATEWAY_TEST_LOCKED_SPOOL_PROFILE:-}" ] && [ ! -f "$COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER.stop-attempted" ]; then
        : > "$COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER.stop-attempted"
      else
        set_state stopped
        if [ -n "${COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER:-}" ] && [ "$profile" = "${COZYGATEWAY_TEST_LOCKED_SPOOL_PROFILE:-}" ]; then
          : > "$COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER.unlocked"
        fi
      fi
      ;;
    uninstall)
      [ "$(state)" = running ] || exit 2
      log uninstall
      if [ "${COZYGATEWAY_TEST_UNINSTALL_LEAVES_RUNNING:-}" != 1 ] || [ "$profile" != "${COZYGATEWAY_TEST_LOCKED_SPOOL_PROFILE:-}" ]; then
        set_state absent
      fi
      ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "plugins" ] && [ "$4" = "enable" ]; then
  printf '%s\n' "$2:$5" >> "${COZYGATEWAY_TEST_COMMAND_LOG:?}"
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "plugins" ] && [ "$4" = "disable" ]; then
  if [ -n "${COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER:-}" ] && [ "$profile" = "${COZYGATEWAY_TEST_LOCKED_SPOOL_PROFILE:-}" ]; then
    : > "$COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER"
  fi
  exit 0
fi
exit 0
HERMES
chmod 700 "$tmp/bin/hermes" "$fake_node"
# Git Bash ships cygpath and the installer rightly refuses to guess without it, but these cases
# drive the Windows path from macOS and from the Linux CI runner, where it does not exist. The
# stub converts the two ways the installer asks: `-u` is already POSIX here, and `-w` produces a
# recognisably Windows-shaped path so an assertion about one cannot pass by accident.
cat > "$tmp/bin/cygpath" <<'CYGPATH'
#!/usr/bin/env bash
mode="$1"; shift
path="$1"
case "$mode" in
  -u) path="${path//\\//}"; printf '%s' "${path#[A-Za-z]:}" ;;
  -w) printf 'C:%s' "${path//\//\\}" ;;
  *) printf '%s' "$path" ;;
esac
CYGPATH
chmod 700 "$tmp/bin/cygpath"
printf 'absent\n' > "$tmp/hermes/gateway-default.state"
printf 'stopped\n' > "$tmp/hermes/gateway-ops.state"
printf 'running\n' > "$tmp/hermes/gateway-active.state"
tar -czf "$tmp/plugin.tar.gz" -C "$repo_root/integrations" attach-plugin
cat > "$tmp/gateway.mjs" <<'BUNDLE'
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pair') {
  const configAt = args.indexOf('--config');
  const config = configAt === -1 ? 'cozygateway.config.json' : args[configAt + 1];
  if (!existsSync(config)) process.exit(2);
  const urlAt = args.indexOf('--url');
  const configured = JSON.parse(readFileSync(config, 'utf8'));
  const wildcard = configured.host === '0.0.0.0' || configured.host === '::';
  const host = wildcard ? (process.env.COZYGATEWAY_TEST_PAIRING_LAN_ADDRESS ?? '127.0.0.1') : configured.host;
  const gatewayUrl = urlAt === -1 ? (configured.publicUrl ?? `http://${host}:${configured.port}`) : args[urlAt + 1];
  process.stdout.write('█▀▀▀▀▀█ fake-qr █▀▀▀▀▀█\n');
  process.stdout.write(JSON.stringify({ gatewayUrl, setupCode: 'TEST-CODE' }) + '\n');
  process.stdout.write('Gateway URL: ' + gatewayUrl + '\n');
  process.stdout.write('Setup code:  TEST-CODE\n');
}
BUNDLE

# The curl bootstrap still verifies all release assets in dry-run mode, but it
# stages them outside COZYGATEWAY_HOME and leaves the requested home untouched.
mkdir -p "$tmp/release-assets"
cp "$tmp/gateway.mjs" "$tmp/release-assets/cozygateway.mjs"
cp "$tmp/plugin.tar.gz" "$tmp/release-assets/cozygateway-hermes-attach-plugin.tar.gz"
cp "$repo_root/scripts/agent-install.sh" "$tmp/release-assets/cozygateway-installer.sh"
for asset in cozygateway.mjs cozygateway-hermes-attach-plugin.tar.gz cozygateway-installer.sh; do
  if command -v shasum >/dev/null 2>&1; then asset_sha="$(shasum -a 256 "$tmp/release-assets/$asset" | awk '{print $1}')"; else asset_sha="$(sha256sum "$tmp/release-assets/$asset" | awk '{print $1}')"; fi
  printf '%s  %s\n' "$asset_sha" "$asset" > "$tmp/release-assets/$asset.sha256"
done
release_asset_base="file://$tmp/release-assets"
case "$OSTYPE" in
  msys*|cygwin*)
    release_assets_windows="$(cygpath -w "$tmp/release-assets")"
    release_asset_base="file:///${release_assets_windows//\\//}"
    ;;
esac
bootstrap_dry_output="$(COZYGATEWAY_HOME="$tmp/bootstrap-dry-home" COZYGATEWAY_INSTALL_ASSET_BASE="$release_asset_base" COZYGATEWAY_INSTALL_DRYRUN=1 bash "$repo_root/scripts/install.sh")"
grep -Fq 'DRY   verified assets' <<<"$bootstrap_dry_output"
test ! -e "$tmp/bootstrap-dry-home"

for platform in Darwin Linux Windows; do
  windows_status=; [ "$platform" = Windows ] && windows_status=1
  output="$(PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_WINDOWS_STATUS="$windows_status" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM="$platform" bash "$repo_root/scripts/agent-install.sh" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-$platform")"
  grep -q 'Profiles: default active ops' <<<"$output"
  grep -q "one CozyGateway $platform service" <<<"$output"
  grep -q 'Hermes Dashboard as local control plane' <<<"$output"
  grep -q 'mint pairing code and QR' <<<"$output"
  grep -Fq -- '--public-url https://gateway.example.com' <<<"$output"
  grep -Fq "gateway install --start-now --start-on-login" <<<"$output"
  grep -Fq "gateway start" <<<"$output"
  grep -Fq "gateway restart" <<<"$output"
  grep -Fq 'using Node.js 24' <<<"$output"
  [ "$platform" = Windows ] || grep -Fq 'open hermes model' <<<"$output"
  test ! -e "$tmp/gateway-$platform"
done
# Existing Node and Hermes are reused. POSIX dry-runs report the interactive
# model step but do not run it or mutate either prerequisite.
[ ! -f "$tmp/commands" ] || ! grep -q '^model$' "$tmp/commands"

# Missing prerequisites remain a non-mutating dry-run and describe both
# bootstraps without attempting any download.
missing_dry_output="$(HOME="$tmp/missing-dry-home" HERMES_HOME="$tmp/missing-hermes-home" LOCALAPPDATA="$tmp/missing-localappdata" PATH="$tmp/bin:$PATH" COZYGATEWAY_HERMES_BIN="$tmp/missing-hermes" COZYGATEWAY_NODE="$tmp/missing-node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-missing-dry")"
grep -Fq 'install the current Node.js 24 release' <<<"$missing_dry_output"
grep -Fq 'install Hermes Agent with the verified official tagged NousResearch installer' <<<"$missing_dry_output"
test ! -e "$tmp/gateway-missing-dry"
if PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --bind-host 'http://not-a-host' --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-invalid-host" >/dev/null 2>&1; then
  echo 'expected URL syntax in --bind-host to fail' >&2
  exit 1
fi
if PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --public-url 'http://gateway.example.com' --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-invalid-public" >/dev/null 2>&1; then
  echo 'expected a non-HTTPS --public-url to fail' >&2
  exit 1
fi
for invalid_public_url in $'https://gateway.example.com\t' $'https://gateway.example.com\r' $'https://gateway.example.com\n'; do
  if PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --public-url "$invalid_public_url" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-invalid-public-control" >/dev/null 2>&1; then
    echo 'expected ASCII whitespace in --public-url to fail' >&2
    exit 1
  fi
done
if PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --public-url 'https://gateway.example.com' --bind-host '0.0.0.0' --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-invalid-public-bind" >/dev/null 2>&1; then
  echo 'expected --public-url with a non-loopback explicit bind to fail' >&2
  exit 1
fi
if conflicting_public_output="$(PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --public-url 'https://gateway.example.com' --clear-public-url --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-conflicting-public" 2>&1)"; then
  echo 'expected --public-url and --clear-public-url together to fail' >&2
  exit 1
fi
grep -Fq 'mutually exclusive' <<<"$conflicting_public_output"

# A non-dry macOS-path run proves the installer writes the Hermes-only config
# and secret files without needing a real launchd or Hermes process. Keep the
# service-manager fake separate from Hermes so uninstall can prove it uses the
# executable persisted in installer state instead of whichever `hermes` PATH
# happens to contain later.
mkdir -p "$tmp/service-bin" "$tmp/darwin-home"
cat > "$tmp/service-bin/launchctl" <<'LAUNCHCTL'
#!/usr/bin/env bash
if [ "${1:-}" = bootstrap ] && [ -n "${COZYGATEWAY_TEST_LAUNCHCTL_RETRY_MARKER:-}" ] && [ ! -f "$COZYGATEWAY_TEST_LAUNCHCTL_RETRY_MARKER" ]; then
  : > "$COZYGATEWAY_TEST_LAUNCHCTL_RETRY_MARKER"
  exit 5
fi
exit 0
LAUNCHCTL
chmod 700 "$tmp/service-bin/launchctl"

# Declining or aborting `hermes model` stops before CozyGateway mutation and
# never prints pairing material.
if declined_output="$(HOME="$tmp/model-declined-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/model-declined-commands" COZYGATEWAY_TEST_MODEL_UNCONFIGURED=1 COZYGATEWAY_TEST_MODEL_DECLINE=1 COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-model-declined" 2>&1)"; then
  echo 'expected a declined Hermes model selection to fail' >&2
  exit 1
fi
grep -Fq 'Hermes model selection did not complete successfully' <<<"$declined_output"
if grep -Fq 'fake-qr' <<<"$declined_output"; then echo 'declined model selection printed pairing material' >&2; exit 1; fi
test ! -e "$tmp/gateway-model-declined"
cat > "$tmp/bin/curl" <<'CURL'
#!/usr/bin/env bash
[ -z "${COZYGATEWAY_TEST_CURL_LOG:-}" ] || printf '%s\n' "$*" >> "$COZYGATEWAY_TEST_CURL_LOG"
case "$*" in
  *127.0.0.1:8787/health*|*127.0.0.1:9000/health*|*192.0.2.10:8787/health*)
    if [ -n "${COZYGATEWAY_TEST_GATEWAY_MARKER:-}" ] && [ ! -f "$COZYGATEWAY_TEST_GATEWAY_MARKER" ]; then
      if [[ "$*" == *"-o /dev/null"* ]]; then printf '000'; else printf '{"attach":{"configured":1,"online":0,"deadLetters":0}}'; fi
      exit 0
    fi
    if [[ "$*" == *"-o /dev/null"* ]]; then printf '200'
    elif [ -n "${COZYGATEWAY_TEST_ATTACH_HEALTH:-}" ]; then printf '%s' "$COZYGATEWAY_TEST_ATTACH_HEALTH"
    elif [ "${COZYGATEWAY_TEST_ZERO_ATTACH:-}" = 1 ]; then printf '{"attach":{"configured":0,"online":0,"deadLetters":0}}'
    else printf '{"attach":{"configured":1,"online":1,"deadLetters":0}}'; fi
    ;;
  *api/health*)
    if [ -n "${COZYGATEWAY_TEST_DASHBOARD_READY_COUNTER:-}" ]; then
      count=0
      [ ! -f "$COZYGATEWAY_TEST_DASHBOARD_READY_COUNTER" ] || count="$(cat "$COZYGATEWAY_TEST_DASHBOARD_READY_COUNTER")"
      count=$((count + 1)); printf '%s\n' "$count" > "$COZYGATEWAY_TEST_DASHBOARD_READY_COUNTER"
      if [ "$count" -le "${COZYGATEWAY_TEST_DASHBOARD_READY_AFTER_CALL:?}" ]; then printf '000'; else printf '401'; fi
    elif [ -n "${COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER:-}" ] && [ -f "$COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER" ]; then printf '000'; else printf '%s' "${COZYGATEWAY_TEST_DASHBOARD_HEALTH_CODE:-401}"; fi
    ;;
  *api/config*)
    cat >/dev/null
    if [ -n "${COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER:-}" ] && [ -f "$COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER" ]; then printf '401'
    else printf '%s' "${COZYGATEWAY_TEST_DASHBOARD_TOKEN_CODE:-200}"; fi
    ;;
  *password-login*)
    cat >/dev/null
    if [ -n "${COZYGATEWAY_TEST_DASHBOARD_MISSING_PROVIDER_MARKER:-}" ] && [ -f "$COZYGATEWAY_TEST_DASHBOARD_MISSING_PROVIDER_MARKER" ]; then printf '404'
    elif [ -n "${COZYGATEWAY_TEST_DISABLED_PLUGINS_FILE:-}" ] && grep -Eq '"(basic|dashboard_auth/basic)"' "$COZYGATEWAY_TEST_DISABLED_PLUGINS_FILE"; then printf '404'
    elif [ -n "${COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER:-}" ] && [ -f "$COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER" ]; then printf '401'
    else printf '%s' "${COZYGATEWAY_TEST_DASHBOARD_LOGIN_CODE:-200}"; fi
    ;;
  *) printf '401' ;;
esac
CURL
chmod 700 "$tmp/bin/curl"

# Official Node archives and the official Hermes installer are represented by
# local, checksum-verified fixtures. This run starts with neither command,
# installs both, resumes in the same process, confirms the model, and reaches QR.
node_version=v24.99.0
case "$(uname -m)" in x86_64|amd64) node_arch=x64 ;; arm64|aarch64) node_arch=arm64 ;; *) echo 'unsupported test architecture' >&2; exit 1 ;; esac
node_name="node-$node_version-darwin-$node_arch"
mkdir -p "$tmp/node-dist/$node_version" "$tmp/node-build/$node_name/bin"
cp "$fake_node" "$tmp/node-build/$node_name/bin/node"
tar -czf "$tmp/node-dist/$node_version/$node_name.tar.gz" -C "$tmp/node-build" "$node_name"
if command -v shasum >/dev/null 2>&1; then node_sha="$(shasum -a 256 "$tmp/node-dist/$node_version/$node_name.tar.gz" | awk '{print $1}')"; else node_sha="$(sha256sum "$tmp/node-dist/$node_version/$node_name.tar.gz" | awk '{print $1}')"; fi
printf '%s  %s.tar.gz\n' "$node_sha" "$node_name" > "$tmp/node-dist/$node_version/SHASUMS256.txt"
cat > "$tmp/hermes-official-installer.sh" <<'HERMES_INSTALLER'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.local/bin"
cp "${COZYGATEWAY_TEST_HERMES_FIXTURE:?}" "$HOME/.local/bin/hermes"
chmod 700 "$HOME/.local/bin/hermes"
HERMES_INSTALLER
chmod 700 "$tmp/hermes-official-installer.sh"
if command -v shasum >/dev/null 2>&1; then hermes_installer_sha="$(shasum -a 256 "$tmp/hermes-official-installer.sh" | awk '{print $1}')"; else hermes_installer_sha="$(sha256sum "$tmp/hermes-official-installer.sh" | awk '{print $1}')"; fi
printf 'yes\n' > "$tmp/lan-yes"
live_output="$(HOME="$tmp/darwin-home" HERMES_HOME="$tmp/missing-hermes-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_LAUNCHCTL_RETRY_MARKER="$tmp/launchctl-retried" COZYGATEWAY_TEST_LAN_PROMPT_INPUT="$tmp/lan-yes" COZYGATEWAY_TEST_PAIRING_LAN_ADDRESS=192.0.2.10 COZYGATEWAY_TEST_CURL_LOG="$tmp/curl.log" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_MODEL_UNCONFIGURED_ONCE_FILE="$tmp/model-status-probed" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_TEST_HERMES_FIXTURE="$tmp/bin/hermes" COZYGATEWAY_HERMES_BIN="$tmp/missing-hermes" COZYGATEWAY_HERMES_INSTALL_URL="$tmp/hermes-official-installer.sh" COZYGATEWAY_HERMES_INSTALL_SHA256="$hermes_installer_sha" COZYGATEWAY_NODE="$tmp/missing-node" COZYGATEWAY_NODE_VERSION="$node_version" COZYGATEWAY_NODE_DIST_BASE="$tmp/node-dist" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live" 2>&1)"
test -f "$tmp/launchctl-retried"
test -x "$tmp/gateway-live/runtime/node/bin/node"
grep -Fq 'installed checksum-verified Node.js' <<<"$live_output"
grep -Fq 'Hermes Agent is not installed; starting the official installer.' <<<"$live_output"
grep -Fq 'Hermes provider and model are configured' <<<"$live_output"
grep -Fq 'Allow CozyChat to access this Gateway over your local network? [y/N]' <<<"$live_output"
grep -Fq 'for devices on your local network' <<<"$live_output"
grep -q '^model$' "$tmp/commands"

# A fresh Hermes install can spend more than 30 seconds importing and warming
# the Dashboard on a small Linux host. Model that boundary without making this
# test slow: the endpoint becomes ready only after the initial probe plus 31
# failed launch probes, and the fake sleep keeps the loop sub-second.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    mkdir -p "$tmp/delayed-bin"
    cat > "$tmp/delayed-bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
exit 0
SLEEP
    chmod 700 "$tmp/delayed-bin/sleep"
    if ! delayed_dashboard_output="$(HOME="$tmp/delayed-home" PATH="$tmp/delayed-bin:$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_DASHBOARD_READY_COUNTER="$tmp/delayed-dashboard-count" COZYGATEWAY_TEST_DASHBOARD_READY_AFTER_CALL=32 COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/delayed-commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bind-host 127.0.0.1 --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-delayed-dashboard" 2>&1)"; then
      printf 'expected a cold Dashboard that becomes ready after the legacy 30-poll window to install successfully\n%s\n' "$delayed_dashboard_output" >&2
      exit 1
    fi
    test "$(cat "$tmp/delayed-dashboard-count")" -ge 33
    grep -Fq 'fake-qr' <<<"$delayed_dashboard_output"
    ;;
esac

# A one-paste rerun with an already-configured Hermes provider/model must not
# reopen the interactive picker. Its stdin is the curl pipe in production, so
# invoking `hermes model` here would make the documented one-line command fail
# even though no model choice is needed.
configured_rerun_output="$(HOME="$tmp/darwin-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/configured-rerun-commands" COZYGATEWAY_TEST_MODEL_DECLINE=1 COZYGATEWAY_HERMES_BIN="$tmp/darwin-home/.local/bin/hermes" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live" 2>&1)"
grep -Fq 'Hermes provider and model are already configured' <<<"$configured_rerun_output"
! grep -q '^model$' "$tmp/configured-rerun-commands"
private_rerun_output="$(HOME="$tmp/darwin-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_HERMES_BIN="$tmp/darwin-home/.local/bin/hermes" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
grep -Fq "using Node.js 24 at $tmp/gateway-live/runtime/node/bin/node" <<<"$private_rerun_output"

# A syntactically healthy endpoint with zero configured attach profiles is not
# ready and cannot reach the pairing finale.
mkdir -p "$tmp/zero-hermes" "$tmp/one-attempt-bin"
printf '{}\n' > "$tmp/zero-hermes/config.yaml"
printf 'absent\n' > "$tmp/zero-hermes/gateway-default.state"
cat > "$tmp/one-attempt-bin/seq" <<'ONE_ATTEMPT'
#!/usr/bin/env bash
printf '1\n'
ONE_ATTEMPT
chmod 700 "$tmp/one-attempt-bin/seq"
if zero_attach_output="$(HOME="$tmp/zero-home" PATH="$tmp/one-attempt-bin:$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_ZERO_ATTACH=1 COZYGATEWAY_TEST_HERMES_ROOT="$tmp/zero-hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/zero-commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-zero-attach" 2>&1)"; then
  echo 'expected zero configured attach profiles to fail readiness' >&2
  exit 1
fi
grep -Fq 'Hermes attach has no configured profiles (configured=0, online=0, deadLetters=0)' <<<"$zero_attach_output"
if grep -Fq 'fake-qr' <<<"$zero_attach_output"; then echo 'unhealthy attach state printed pairing material' >&2; exit 1; fi
grep -Fq '"host": "127.0.0.1"' "$tmp/gateway-zero-attach/local/cozygateway.config.json"

# The exact Windows failure (two configured profiles, only one online) must
# identify the failed invariant and safe aggregate counts. The old combined
# error made a profile lifecycle failure indistinguishable from dead letters.
mkdir -p "$tmp/mismatch-hermes"
printf '{}\n' > "$tmp/mismatch-hermes/config.yaml"
printf 'absent\n' > "$tmp/mismatch-hermes/gateway-default.state"
if mismatch_output="$(HOME="$tmp/mismatch-home" PATH="$tmp/one-attempt-bin:$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_ATTACH_HEALTH='{"attach":{"configured":2,"online":1,"deadLetters":0}}' COZYGATEWAY_TEST_HERMES_ROOT="$tmp/mismatch-hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/mismatch-commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-mismatch-attach" 2>&1)"; then
  echo 'expected configured/online attach mismatch to fail readiness' >&2
  exit 1
fi
expect_contains "$mismatch_output" 'Hermes attach profile count mismatch (configured=2, online=1, deadLetters=0)'
if grep -Fq 'configured must be positive, online must equal configured, and dead letters must be zero' <<<"$mismatch_output"; then
  echo 'attach mismatch returned the opaque combined error' >&2
  exit 1
fi
if grep -Fq 'fake-qr' <<<"$mismatch_output"; then echo 'attach mismatch printed pairing material' >&2; exit 1; fi
# shellcheck disable=SC2016
if grep -Fq 'spaces $dollar' <<<"$live_output"; then
  echo 'installer output must not contain credentials' >&2
  exit 1
fi
# The install finishes on the pairing finale: QR, payload JSON, and the re-mint one-liner.
grep -Fq 'fake-qr' <<<"$live_output"
grep -Fq '"gatewayUrl":"http://192.0.2.10:8787"' <<<"$live_output"
grep -Fq '"setupCode":"TEST-CODE"' <<<"$live_output"
grep -Fq "mint a fresh QR and code with: $tmp/gateway-live/bin/cozygateway pair" <<<"$live_output"
grep -q '"profiles"' "$tmp/gateway-live/local/cozygateway.config.json"
grep -q '"agents"' "$tmp/gateway-live/local/cozygateway.config.json" && exit 1
grep -Fq '"authMode": "token"' "$tmp/gateway-live/local/cozygateway.config.json"
grep -Fq '"tokenEnv": "COZYGATEWAY_HERMES_TOKEN"' "$tmp/gateway-live/local/cozygateway.config.json"
grep -Fq '"host": "0.0.0.0"' "$tmp/gateway-live/local/cozygateway.config.json"
grep -Fq 'COZYGATEWAY_URL=http://127.0.0.1:8787' "$tmp/hermes/.env"
grep -Fq 'http://127.0.0.1:8787/health' "$tmp/curl.log"

# On util-linux hosts, exercise the public one-paste shape with installer stdin
# occupied by a pipe while a separate controlling terminal supplies the LAN
# answer. A regression to `read` from fd 0 skips this prompt and stays loopback.
if script --version 2>&1 | grep -qi util-linux; then
  pty_output="$({ sleep 1; printf 'yes\n'; } | script -qec "printf 'bootstrap-stdin\\n' | env HOME='$tmp/pty-home' PATH='$tmp/service-bin:$tmp/bin:$PATH' COZYGATEWAY_TEST_PAIRING_LAN_ADDRESS=192.0.2.11 COZYGATEWAY_TEST_HERMES_ROOT='$tmp/hermes' COZYGATEWAY_TEST_COMMAND_LOG='$tmp/pty-hermes-commands' COZYGATEWAY_TEST_REAL_NODE='$real_node' COZYGATEWAY_HERMES_BIN='$tmp/bin/hermes' COZYGATEWAY_NODE='$fake_node' COZYGATEWAY_SERVICE_PLATFORM=Darwin bash '$repo_root/scripts/agent-install.sh' --bundle '$tmp/gateway.mjs' --plugin-archive '$tmp/plugin.tar.gz' --gateway-dir '$tmp/gateway-pty'" /dev/null)"
  grep -Fq 'Allow CozyChat to access this Gateway over your local network? [y/N]' <<<"$pty_output"
  grep -Fq '"gatewayUrl":"http://192.0.2.11:8787"' <<<"$pty_output"
  grep -Fq '"host": "0.0.0.0"' "$tmp/gateway-pty/local/cozygateway.config.json"

  # Keep a real controlling terminal present for the explicit-bind case too;
  # otherwise the no-TTY guard could hide a regression in explicit suppression.
  #
  # Do not feed this one an answer. The case asserts that an explicit bind host
  # SKIPS the prompt, so the installer never reads the terminal, `script` exits as
  # soon as the install finishes, and the writer then takes SIGPIPE on a closed
  # pipe. Under `pipefail` that surfaced as exit 141 and failed the whole run.
  # It raced the install: slower machines wrote before `script` exited and passed,
  # CI runners finished in under a second and failed every time. `script` still
  # allocates the pty, which is the only thing this case needs from it.
  pty_explicit_output="$(script -qec "env HOME='$tmp/pty-explicit-home' PATH='$tmp/service-bin:$tmp/bin:$PATH' COZYGATEWAY_TEST_HERMES_ROOT='$tmp/hermes' COZYGATEWAY_TEST_COMMAND_LOG='$tmp/pty-explicit-hermes-commands' COZYGATEWAY_TEST_REAL_NODE='$real_node' COZYGATEWAY_HERMES_BIN='$tmp/bin/hermes' COZYGATEWAY_NODE='$fake_node' COZYGATEWAY_SERVICE_PLATFORM=Darwin bash '$repo_root/scripts/agent-install.sh' --bind-host 127.0.0.1 --port 9000 --bundle '$tmp/gateway.mjs' --plugin-archive '$tmp/plugin.tar.gz' --gateway-dir '$tmp/gateway-pty-explicit'" /dev/null </dev/null)"
  grep -Fq 'CozyGateway listens on 127.0.0.1:9000' <<<"$pty_explicit_output"
  if grep -Fq 'Allow CozyChat to access this Gateway' <<<"$pty_explicit_output"; then
    echo 'an explicit bind host must skip the LAN prompt' >&2
    exit 1
  fi
fi
mode_of() {
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" ;;
    MINGW*|MSYS*|CYGWIN*) printf '600\n' ;; # NTFS ACLs, not POSIX mode bits, protect Windows secrets.
    *) stat -c '%a' "$1" ;;
  esac
}
test "$(mode_of "$tmp/gateway-live/local/gateway.env")" = 600
test "$(mode_of "$tmp/hermes/.env")" = 600
"$real_node" - "$tmp/gateway-live/local/dashboard.env" "$tmp/gateway-live/local/gateway.env" <<'NODE'
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const [dashboardPath, gatewayPath] = process.argv.slice(2);
const dashboard = parseEnv(readFileSync(dashboardPath, 'utf8'));
const gateway = parseEnv(readFileSync(gatewayPath, 'utf8'));
if (!/^[A-Za-z0-9_-]{32,128}$/.test(dashboard.DASHBOARD_SESSION_TOKEN) ||
    gateway.COZYGATEWAY_HERMES_TOKEN !== dashboard.DASHBOARD_SESSION_TOKEN ||
    dashboard.DASHBOARD_USERNAME !== undefined || dashboard.DASHBOARD_PASSWORD !== undefined ||
    gateway.COZYGATEWAY_HERMES_PASSWORD !== undefined) process.exit(1);
NODE
if grep -Fq 'DASHBOARD_PASSWORD' "$repo_root/scripts/agent-install.sh"; then
  echo 'fresh-install credential setup must not retain the v0.3.7 password migration path' >&2
  exit 1
fi
! grep -q '^default:basic$' "$tmp/commands"
grep -q '^default:gateway:install$' "$tmp/commands"
grep -q '^ops:gateway:start$' "$tmp/commands"
grep -q '^active:gateway:restart$' "$tmp/commands"
grep -q '^service_default=installed$' "$tmp/gateway-live/local/install-state"
grep -q '^service_ops=started$' "$tmp/gateway-live/local/install-state"
grep -q '^service_active=preexisting$' "$tmp/gateway-live/local/install-state"
grep -Fq "hermes_bin=$tmp/darwin-home/.local/bin/hermes" "$tmp/gateway-live/local/install-state"
test ! -e "$credential_marker"
test -x "$tmp/gateway-live/bin/cozygateway"
if [[ "$(uname -s)" = MINGW* ]]; then
  cmp -s "$tmp/darwin-home/.local/bin/cozygateway" "$tmp/gateway-live/bin/cozygateway"
else
  test "$(readlink "$tmp/darwin-home/.local/bin/cozygateway")" = "$tmp/gateway-live/bin/cozygateway"
fi
grep -Fqx 'export PATH="$HOME/.local/bin:$PATH" # CozyGateway CLI' "$tmp/darwin-home/.profile"
grep -Fqx 'export PATH="$HOME/.local/bin:$PATH" # CozyGateway CLI' "$tmp/darwin-home/.zprofile"
if grep -Eq 'COZYGATEWAY_(HERMES_PASSWORD|HERMES_TOKEN|ATTACH_TOKEN)' "$tmp/gateway-live/bin/cozygateway"; then
  echo 'gateway CLI wrapper must not contain secrets' >&2
  exit 1
fi
grep -Fq 'watchFile(config' "$tmp/gateway-live/local/run-gateway.sh"
grep -Fq 'restartGateway' "$tmp/gateway-live/local/run-gateway.sh"
remote_pair="$(COZYGATEWAY_TEST_REAL_NODE="$real_node" "$tmp/gateway-live/bin/cozygateway" pair --url https://gateway.example.com)"
grep -q '"gatewayUrl":"https://gateway.example.com"' <<<"$remote_pair"
grep -Fq 'parseEnv(readFileSync(gatewayEnvPath' "$tmp/gateway-live/local/run-gateway.sh"
grep -Fq 'HERMES_DASHBOARD_SESSION_TOKEN' "$tmp/gateway-live/local/run-gateway.sh"
grep -Fq "'x-hermes-session-token'" "$tmp/gateway-live/local/run-gateway.sh"
if grep -Fq '/auth/password-login' "$tmp/gateway-live/local/run-gateway.sh"; then
  echo 'loopback Dashboard wrapper must use Hermes session-token auth, not password auth' >&2
  exit 1
fi
if grep -Fq '/auth/password-login' "$repo_root/scripts/agent-install.sh"; then
  echo 'installer source must not contain /auth/password-login' >&2
  exit 1
fi
grep -Fq 'spawn(process.execPath, [bundle' "$tmp/gateway-live/local/run-gateway.sh"
sed -n "/<<'NODE'/,/^NODE$/p" "$tmp/gateway-live/local/run-gateway.sh" | sed '1d;$d' | "$real_node" --check -
if grep -Fq '. "' "$tmp/gateway-live/local/run-gateway.sh"; then
  echo 'gateway wrapper must not source credential files' >&2
  exit 1
fi

# Exercise the generated supervisor rather than only checking its source. This
# is a true cold start: the supervisor must spawn Hermes with the exact
# Dashboard arguments and token environment, Hermes launches a delayed
# Dashboard, and Gateway cannot start until authenticated /api/config succeeds.
# An atomic config replacement must then terminate the first gateway child and
# launch a second child that reads the new listener port.
sed -n "/<<'NODE'/,/^NODE$/p" "$tmp/gateway-live/local/run-gateway.sh" | sed '1d;$d' > "$tmp/supervisor.cjs"
cat > "$tmp/reload-gateway.mjs" <<'RELOAD_GATEWAY'
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
if (!existsSync(process.env.COZYGATEWAY_TEST_DASHBOARD_AUTH_MARKER)) process.exit(2);
const configAt = process.argv.indexOf('--config');
const config = JSON.parse(readFileSync(process.argv[configAt + 1], 'utf8'));
appendFileSync(process.env.COZYGATEWAY_TEST_RELOAD_LOG, `${process.pid}:${config.port}\n`);
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => process.exit(0), 5000);
RELOAD_GATEWAY
cat > "$tmp/mock-dashboard.mjs" <<'MOCK_DASHBOARD'
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const expectedToken = process.env.HERMES_DASHBOARD_SESSION_TOKEN;
const [port, authMarker, pidFile] = process.argv.slice(2);
const readyAt = Date.now() + Number(process.env.COZYGATEWAY_TEST_DASHBOARD_READY_DELAY_MS ?? 750);
const server = createServer((request, response) => {
  if (Date.now() < readyAt) {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"detail":"starting"}\n');
    return;
  }
  const authenticated = process.env.COZYGATEWAY_TEST_DASHBOARD_REJECT !== '1' && request.url === '/api/config' && request.headers['x-hermes-session-token'] === expectedToken;
  if (authenticated) writeFileSync(authMarker, `${expectedToken}\n`);
  response.writeHead(authenticated ? 200 : 401, { 'content-type': 'application/json' });
  response.end(authenticated ? '{}\n' : '{"detail":"unauthorized"}\n');
});
server.listen(Number(port), '127.0.0.1', () => writeFileSync(pidFile, String(process.pid)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
MOCK_DASHBOARD
mkdir -p "$tmp/hermes/hermes-agent/venv/Scripts" "$tmp/hermes/hermes-agent/hermes_cli"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    cp "$real_node" "$tmp/hermes/hermes-agent/venv/Scripts/python.exe"
    chmod 700 "$tmp/hermes/hermes-agent/venv/Scripts/python.exe"
    ;;
  *)
    ln -s "$real_node" "$tmp/hermes/hermes-agent/venv/Scripts/python.exe"
    "$tmp/hermes/hermes-agent/venv/Scripts/python.exe" --version >/dev/null
    ;;
esac
cat > "$tmp/hermes/hermes-agent/hermes_cli/main.py" <<'OWNED_DASHBOARD'
const { writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const args = process.argv.slice(2);
const portAt = args.indexOf('--port');
if (args[0] !== 'dashboard' || portAt === -1) process.exit(2);
const expectedToken = process.env.HERMES_DASHBOARD_SESSION_TOKEN;
const readyAt = Date.now() + Number(process.env.COZYGATEWAY_TEST_DASHBOARD_READY_DELAY_MS ?? 750);
const server = createServer((request, response) => {
  if (Date.now() < readyAt) {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"detail":"starting"}\n');
    return;
  }
  const authenticated = process.env.COZYGATEWAY_TEST_DASHBOARD_REJECT !== '1' && request.url === '/api/config' && request.headers['x-hermes-session-token'] === expectedToken;
  if (authenticated) writeFileSync(process.env.COZYGATEWAY_TEST_DASHBOARD_AUTH_MARKER, `${expectedToken}\n`);
  response.writeHead(authenticated ? 200 : 401, { 'content-type': 'application/json' });
  response.end(authenticated ? '{}\n' : '{"detail":"unauthorized"}\n');
});
server.listen(Number(args[portAt + 1]), '127.0.0.1', () => writeFileSync(process.env.COZYGATEWAY_TEST_DASHBOARD_PID_FILE, String(process.pid)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
OWNED_DASHBOARD
cat > "$tmp/hermes-stub.cjs" <<'HERMES_STUB'
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const childProcess = require('node:child_process');
const { basename, resolve } = require('node:path');
const { parseEnv } = require('node:util');
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (process.env.COZYGATEWAY_TEST_TASKKILL_LOG && args?.[0] === '/PID') {
    appendFileSync(process.env.COZYGATEWAY_TEST_TASKKILL_LOG, `${JSON.stringify(args)}\n`);
  }
  return originalSpawn.call(this, command, args, options);
};
const { spawn } = childProcess;
const hermesArgs = [basename(process.argv[1] || ''), ...process.argv.slice(2)];
if (hermesArgs[0] === 'dashboard') {
  const windowsLauncher = process.platform === 'win32';
  // gateway-live is intentionally generated with service platform Darwin,
  // even when this fixture itself runs on Windows.
  const expectedLauncherArgs = ['dashboard', '--host', '127.0.0.1', '--port', process.env.COZYGATEWAY_TEST_DASHBOARD_PORT, '--no-open', '--skip-build'];
  const descendantProfileArgs = windowsLauncher ? ['-p', 'default'] : [];
  const descendantArgs = [process.env.COZYGATEWAY_TEST_DASHBOARD_SCRIPT, 'dashboard', ...descendantProfileArgs, '--host', '127.0.0.1', '--port', process.env.COZYGATEWAY_TEST_DASHBOARD_PORT, '--no-open', '--skip-build'];
  const expectedToken = parseEnv(readFileSync(process.env.COZYGATEWAY_TEST_DASHBOARD_ENV, 'utf8')).DASHBOARD_SESSION_TOKEN;
  const homeMatches = resolve(process.env.HERMES_HOME) === resolve(process.env.COZYGATEWAY_TEST_EXPECTED_HERMES_HOME);
  writeFileSync(process.env.COZYGATEWAY_TEST_HERMES_STUB_TRACE, JSON.stringify({
    args: hermesArgs,
    descendantArgs,
    launcherPid: process.pid,
    launcherMode: windowsLauncher ? 'exited-descendant' : 'live-process-group',
    tokenMatches: process.env.HERMES_DASHBOARD_SESSION_TOKEN === expectedToken,
    homeMatches,
  }) + '\n');
  if (JSON.stringify(hermesArgs) !== JSON.stringify(expectedLauncherArgs)) process.exit(41);
  if (process.env.HERMES_DASHBOARD_SESSION_TOKEN !== expectedToken) process.exit(42);
  if (!homeMatches) process.exit(43);
  writeFileSync(process.env.COZYGATEWAY_TEST_HERMES_STUB_MARKER, `${hermesArgs.join(' ')}\n`);
  const dashboardChild = spawn(process.env.COZYGATEWAY_TEST_DASHBOARD_RUNTIME, descendantArgs, { detached: windowsLauncher, stdio: 'ignore', env: process.env });
  if (windowsLauncher) {
    dashboardChild.unref();
    process.exit(0);
  }
  dashboardChild.once('error', () => process.exit(44));
  dashboardChild.once('exit', (code) => process.exit(code ?? 1));
}
HERMES_STUB
dashboard_auth_marker="$tmp/mock-dashboard-authenticated"
mock_dashboard_port="$("$real_node" -e "const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>{process.stdout.write(String(server.address().port));server.close()})")"
mkdir -p "$tmp/Hermes Bin"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) hermes_stub="$tmp/Hermes Bin/hermes-stub.exe" ;; *) hermes_stub="$tmp/Hermes Bin/hermes-stub" ;; esac
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    cp "$real_node" "$hermes_stub"
    chmod 700 "$hermes_stub"
    ;;
  *)
    # Homebrew's Node binary loads libnode via a path relative to itself.
    # Keep the fixture's requested name while resolving that dependency from
    # the installed runtime rather than copying only the executable.
    ln -s "$real_node" "$hermes_stub"
    # The fixture is executed by the generated supervisor. Verify that its
    # executable can load before attributing a failed cold start to readiness.
    "$hermes_stub" --version >/dev/null
    ;;
esac
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    reload_log="$(cygpath -w "$tmp/reload.log")"
    dashboard_auth_marker_env="$(cygpath -w "$dashboard_auth_marker")"
    dashboard_env="$(cygpath -w "$tmp/gateway-live/local/dashboard.env")"
    dashboard_runtime="$(cygpath -w "$tmp/hermes/hermes-agent/venv/Scripts/python.exe")"
    dashboard_script="$(cygpath -w "$tmp/hermes/hermes-agent/hermes_cli/main.py")"
    dashboard_pid_file="$(cygpath -w "$tmp/mock-dashboard.pid")"
    hermes_stub_marker="$(cygpath -w "$tmp/hermes-stub-invoked")"
    hermes_stub_trace="$(cygpath -w "$tmp/hermes-stub-trace")"
    expected_hermes_home="$(cygpath -w "$tmp/hermes")"
    node_options_preload="$(cygpath -w "$tmp/hermes-stub.cjs")"
    hermes_stub_arg="$(cygpath -w "$hermes_stub")"
    expected_launcher="$(cygpath -w "$tmp/hermes/bin/hermes.exe")"
    owner_helper="$(cygpath -w "$tmp/gateway-live/local/dashboard-owner.ps1")"
    taskkill_log="$(cygpath -w "$tmp/supervisor-taskkill.log")"
    ;;
  *)
    reload_log="$tmp/reload.log"
    dashboard_auth_marker_env="$dashboard_auth_marker"
    dashboard_env="$tmp/gateway-live/local/dashboard.env"
    dashboard_runtime="$tmp/hermes/hermes-agent/venv/Scripts/python.exe"
    dashboard_script="$tmp/hermes/hermes-agent/hermes_cli/main.py"
    dashboard_pid_file="$tmp/mock-dashboard.pid"
    hermes_stub_marker="$tmp/hermes-stub-invoked"
    hermes_stub_trace="$tmp/hermes-stub-trace"
    expected_hermes_home="$tmp/hermes"
    node_options_preload="$tmp/hermes-stub.cjs"
    hermes_stub_arg="$hermes_stub"
    expected_launcher="$tmp/hermes/bin/hermes.exe"
    owner_helper="$tmp/gateway-live/local/dashboard-owner.ps1"
    taskkill_log="$tmp/supervisor-taskkill.log"
    ;;
esac
NODE_OPTIONS="--require=$node_options_preload" COZYGATEWAY_TEST_RELOAD_LOG="$reload_log" COZYGATEWAY_TEST_DASHBOARD_AUTH_MARKER="$dashboard_auth_marker_env" \
  COZYGATEWAY_TEST_DASHBOARD_RUNTIME="$dashboard_runtime" \
  COZYGATEWAY_TEST_DASHBOARD_ENV="$dashboard_env" COZYGATEWAY_TEST_DASHBOARD_SCRIPT="$dashboard_script" \
  COZYGATEWAY_TEST_DASHBOARD_PID_FILE="$dashboard_pid_file" COZYGATEWAY_TEST_DASHBOARD_PORT="$mock_dashboard_port" \
  COZYGATEWAY_TEST_HERMES_STUB_MARKER="$hermes_stub_marker" COZYGATEWAY_TEST_HERMES_STUB_TRACE="$hermes_stub_trace" \
  COZYGATEWAY_TEST_EXPECTED_HERMES_HOME="$expected_hermes_home" \
  "$real_node" "$tmp/supervisor.cjs" \
  "$tmp/gateway-live/local/gateway.env" "$tmp/gateway-live/local/dashboard.env" "$tmp/hermes" \
  "$hermes_stub_arg" "$expected_launcher" "$owner_helper" "$mock_dashboard_port" "$tmp/reload-gateway.mjs" "$tmp/gateway-live/local/cozygateway.config.json" \
  >"$tmp/supervisor.log" 2>&1 &
supervisor_pid=$!
for _ in $(seq 1 50); do [ -s "$tmp/reload.log" ] && break; sleep 0.1; done
if [ ! -s "$tmp/reload.log" ]; then
  printf '%s\n' 'generated supervisor did not launch its gateway child' >&2
  cat "$tmp/supervisor.log" >&2
  [ ! -f "$tmp/hermes-stub-trace" ] || cat "$tmp/hermes-stub-trace" >&2
  exit 1
fi
if [ ! -s "$tmp/hermes-stub-invoked" ]; then
  printf '%s\n' 'generated supervisor did not spawn Hermes during a cold Dashboard start' >&2
  exit 1
fi
"$real_node" - "$tmp/hermes-stub-trace" "$mock_dashboard_port" <<'NODE'
const { readFileSync } = require('node:fs');
const trace = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const expectedLauncherArgs = ['dashboard', '--host', '127.0.0.1', '--port', process.argv[3], '--no-open', '--skip-build'];
const descendantProfileArgs = process.platform === 'win32' ? ['-p', 'default'] : [];
const expectedDescendantArgs = [trace.descendantArgs[0], 'dashboard', ...descendantProfileArgs, '--host', '127.0.0.1', '--port', process.argv[3], '--no-open', '--skip-build'];
if (JSON.stringify(trace.args) !== JSON.stringify(expectedLauncherArgs)) {
  console.error(`Hermes launcher fixture argv was ${JSON.stringify(trace.args)}; expected ${JSON.stringify(expectedLauncherArgs)}`);
  process.exit(1);
}
if (JSON.stringify(trace.descendantArgs) !== JSON.stringify(expectedDescendantArgs)) {
  console.error(`Dashboard descendant fixture argv was ${JSON.stringify(trace.descendantArgs)}; expected ${JSON.stringify(expectedDescendantArgs)}`);
  process.exit(1);
}
const expected = process.platform === 'win32' ? 'exited-descendant' : 'live-process-group';
if (trace.launcherMode !== expected) {
  console.error(`Hermes launcher fixture mode was ${String(trace.launcherMode)}; expected ${expected}`);
  process.exit(1);
}
NODE
test -s "$tmp/mock-dashboard.pid"
mock_dashboard_pid="$(cat "$tmp/mock-dashboard.pid")"
"$real_node" - "$tmp/gateway-live/local/cozygateway.config.json" <<'NODE'
const { readFileSync, renameSync, writeFileSync } = require('node:fs');
const path = process.argv[2];
const replacement = path + '.probe';
writeFileSync(replacement, readFileSync(path));
renameSync(replacement, path);
NODE
sleep 1
test "$(wc -l < "$tmp/reload.log")" -eq 1
"$real_node" - "$tmp/gateway-live/local/cozygateway.config.json" <<'NODE'
const { readFileSync, renameSync, writeFileSync } = require('node:fs');
const path = process.argv[2];
const replacement = path + '.replacement';
const config = JSON.parse(readFileSync(path, 'utf8'));
config.port = 8998;
writeFileSync(replacement, JSON.stringify(config));
renameSync(replacement, path);
NODE
for _ in $(seq 1 50); do [ "$(wc -l < "$tmp/reload.log")" -ge 2 ] && break; sleep 0.1; done
kill "$supervisor_pid" 2>/dev/null || true
wait "$supervisor_pid" 2>/dev/null || true
supervisor_pid=
"$real_node" -e 'try { process.kill(Number(process.argv[1]), 0); process.exit(0) } catch { process.exit(1) }' "$mock_dashboard_pid"
stop_test_pid "$mock_dashboard_pid"
mock_dashboard_pid=
test "$(wc -l < "$tmp/reload.log")" -ge 2
"$real_node" - "$tmp/gateway-live/local/dashboard.env" "$dashboard_auth_marker" <<'NODE'
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');
const expected = parseEnv(readFileSync(process.argv[2], 'utf8')).DASHBOARD_SESSION_TOKEN;
if (readFileSync(process.argv[3], 'utf8').trim() !== expected) process.exit(1);
NODE
sed -n '1p' "$tmp/reload.log" | grep -Eq '^[0-9]+:8787$'
sed -n '2p' "$tmp/reload.log" | grep -Eq '^[0-9]+:8998$'
test "$(cut -d: -f1 "$tmp/reload.log" | sed -n '1p')" != "$(cut -d: -f1 "$tmp/reload.log" | sed -n '2p')"

# A foreign process can bind the target port after the supervisor's initial
# health decision but before authenticated readiness. Failed readiness must not
# turn the dedicated port into authority to kill that non-Hermes listener.
foreign_dashboard_port="$("$real_node" -e "const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>{process.stdout.write(String(server.address().port));server.close()})")"
rm -f "$tmp/foreign-dashboard.pid" "$tmp/foreign-reload.log" "$tmp/mock-dashboard.pid"
COZYGATEWAY_TEST_DASHBOARD_READY_DELAY_MS=3000 COZYGATEWAY_TEST_DASHBOARD_REJECT=1 HERMES_DASHBOARD_SESSION_TOKEN=foreign \
  "$real_node" "$tmp/mock-dashboard.mjs" "$foreign_dashboard_port" "$tmp/foreign-auth" "$tmp/foreign-dashboard.pid" \
  >"$tmp/foreign-dashboard.log" 2>&1 &
foreign_dashboard_pid=$!
for _ in $(seq 1 50); do [ -s "$tmp/foreign-dashboard.pid" ] && break; sleep 0.1; done
test -s "$tmp/foreign-dashboard.pid"
foreign_dashboard_pid="$(cat "$tmp/foreign-dashboard.pid")"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) foreign_reload_log="$(cygpath -w "$tmp/foreign-reload.log")" ;; *) foreign_reload_log="$tmp/foreign-reload.log" ;; esac
set +e
foreign_supervisor_status=0
(trap - ERR; NODE_OPTIONS="--require=$node_options_preload" COZYGATEWAY_TEST_RELOAD_LOG="$foreign_reload_log" \
  COZYGATEWAY_TEST_DASHBOARD_RUNTIME="$dashboard_runtime" \
  COZYGATEWAY_TEST_DASHBOARD_AUTH_MARKER="$dashboard_auth_marker_env" COZYGATEWAY_TEST_DASHBOARD_ENV="$dashboard_env" \
  COZYGATEWAY_TEST_DASHBOARD_SCRIPT="$dashboard_script" COZYGATEWAY_TEST_DASHBOARD_PID_FILE="$dashboard_pid_file" \
  COZYGATEWAY_TEST_DASHBOARD_PORT="$foreign_dashboard_port" COZYGATEWAY_TEST_HERMES_STUB_MARKER="$hermes_stub_marker" \
  COZYGATEWAY_TEST_HERMES_STUB_TRACE="$hermes_stub_trace" COZYGATEWAY_TEST_EXPECTED_HERMES_HOME="$expected_hermes_home" \
  "$real_node" "$tmp/supervisor.cjs" \
  "$tmp/gateway-live/local/gateway.env" "$tmp/gateway-live/local/dashboard.env" "$tmp/hermes" \
  "$hermes_stub_arg" "$expected_launcher" "$owner_helper" "$foreign_dashboard_port" "$tmp/reload-gateway.mjs" "$tmp/gateway-live/local/cozygateway.config.json" \
  >"$tmp/foreign-supervisor.log" 2>&1) || foreign_supervisor_status=$?
set -e
test "$foreign_supervisor_status" -ne 0
test ! -e "$tmp/foreign-reload.log"
if ! "$real_node" -e 'try { process.kill(Number(process.argv[1]), 0); process.exit(0) } catch { process.exit(1) }' "$foreign_dashboard_pid"; then
  echo 'failed readiness killed a non-owned loopback listener' >&2
  exit 1
fi
stop_test_pid "$foreign_dashboard_pid"
foreign_dashboard_pid=

# A Dashboard spawned by this supervisor remains owned until authenticated
# readiness. Rejection must stop its detached process tree before the
# supervisor exits; the successful cold start above remains detached.
failed_dashboard_port="$("$real_node" -e "const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>{process.stdout.write(String(server.address().port));server.close()})")"
rm -f "$tmp/mock-dashboard.pid" "$tmp/supervisor-taskkill.log"
set +e
failed_supervisor_status=0
(trap - ERR; NODE_OPTIONS="--require=$node_options_preload" COZYGATEWAY_TEST_DASHBOARD_READY_DELAY_MS=1000 \
  COZYGATEWAY_TEST_DASHBOARD_REJECT=1 COZYGATEWAY_TEST_RELOAD_LOG="$reload_log" \
  COZYGATEWAY_TEST_DASHBOARD_RUNTIME="$dashboard_runtime" \
  COZYGATEWAY_TEST_DASHBOARD_AUTH_MARKER="$dashboard_auth_marker_env" COZYGATEWAY_TEST_DASHBOARD_ENV="$dashboard_env" \
  COZYGATEWAY_TEST_DASHBOARD_SCRIPT="$dashboard_script" COZYGATEWAY_TEST_DASHBOARD_PID_FILE="$dashboard_pid_file" \
  COZYGATEWAY_TEST_DASHBOARD_PORT="$failed_dashboard_port" COZYGATEWAY_TEST_HERMES_STUB_MARKER="$hermes_stub_marker" \
  COZYGATEWAY_TEST_HERMES_STUB_TRACE="$hermes_stub_trace" COZYGATEWAY_TEST_EXPECTED_HERMES_HOME="$expected_hermes_home" \
  COZYGATEWAY_TEST_TASKKILL_LOG="$taskkill_log" \
  "$real_node" "$tmp/supervisor.cjs" \
  "$tmp/gateway-live/local/gateway.env" "$tmp/gateway-live/local/dashboard.env" "$tmp/hermes" \
  "$hermes_stub_arg" "$expected_launcher" "$owner_helper" "$failed_dashboard_port" "$tmp/reload-gateway.mjs" "$tmp/gateway-live/local/cozygateway.config.json" \
  >"$tmp/failed-supervisor.log" 2>&1) || failed_supervisor_status=$?
set -e
test "$failed_supervisor_status" -ne 0
if [ ! -s "$tmp/mock-dashboard.pid" ]; then
  echo 'failed-readiness Hermes fixture did not start' >&2
  cat "$tmp/failed-supervisor.log" >&2
  [ ! -f "$tmp/hermes-stub-trace" ] || cat "$tmp/hermes-stub-trace" >&2
  exit 1
fi
failed_dashboard_pid="$(cat "$tmp/mock-dashboard.pid")"
failed_launcher_pid="$("$real_node" -e "process.stdout.write(String(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).launcherPid))" "$tmp/hermes-stub-trace")"
test "$failed_launcher_pid" != "$failed_dashboard_pid"
if "$real_node" -e 'try { process.kill(Number(process.argv[1]), 0); process.exit(0) } catch { process.exit(1) }' "$failed_launcher_pid"; then
  echo 'failed-readiness Hermes launcher did not exit before descendant cleanup' >&2
  exit 1
fi
for _ in $(seq 1 50); do
  if ! "$real_node" -e 'try { process.kill(Number(process.argv[1]), 0); process.exit(0) } catch { process.exit(1) }' "$failed_dashboard_pid"; then break; fi
  sleep 0.1
done
if "$real_node" -e 'try { process.kill(Number(process.argv[1]), 0); process.exit(0) } catch { process.exit(1) }' "$failed_dashboard_pid"; then
  echo 'failed authenticated readiness left the spawned Dashboard running' >&2
  exit 1
fi
if [ -s "$tmp/supervisor-taskkill.log" ]; then
  echo 'exited Hermes launcher PID was passed to taskkill' >&2
  exit 1
fi
failed_dashboard_pid=

# Update runs retain a power user's saved listener unless an explicit installer
# flag asks to replace it.
"$real_node" - "$tmp/gateway-live/local/cozygateway.config.json" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const path = process.argv[2];
const config = JSON.parse(readFileSync(path, 'utf8'));
config.host = '127.0.0.1';
config.port = 8999;
writeFileSync(path, JSON.stringify(config));
NODE
preserved_listener_output="$(HOME="$tmp/darwin-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
grep -Fq 'CozyGateway listens on 127.0.0.1:8999' <<<"$preserved_listener_output"
overridden_listener_output="$(HOME="$tmp/darwin-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --bind-host 0.0.0.0 --port 9000 --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
grep -Fq 'CozyGateway listens on 0.0.0.0:9000' <<<"$overridden_listener_output"

# Restore the fixture listener for the live rerun checks below.
"$real_node" - "$tmp/gateway-live/local/cozygateway.config.json" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const path = process.argv[2];
const config = JSON.parse(readFileSync(path, 'utf8'));
config.host = '0.0.0.0';
config.port = 8787;
writeFileSync(path, JSON.stringify(config));
NODE

# A rerun sees all services running, preserves the installer-owned lifecycle
# records and attach tokens, and never tries to install a second Hermes service.
default_token="$(sed -n 's/^COZYGATEWAY_TOKEN=//p' "$tmp/hermes/.env")"
ops_token="$(sed -n 's/^COZYGATEWAY_TOKEN=//p' "$tmp/hermes/profiles/ops/.env")"
install_count_before="$(grep -c '^default:gateway:install$' "$tmp/commands")"
rerun_output="$(HOME="$tmp/darwin-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
# Rerunning on an installed gateway still lands on the pairing finale with a minted code.
grep -Fq 'fake-qr' <<<"$rerun_output"
grep -Fq '"setupCode":"TEST-CODE"' <<<"$rerun_output"
if grep -Fq 'Allow CozyChat to access this Gateway' <<<"$rerun_output"; then
  echo 'an update must preserve its saved listener without prompting again' >&2
  exit 1
fi
test "$default_token" = "$(sed -n 's/^COZYGATEWAY_TOKEN=//p' "$tmp/hermes/.env")"
test "$ops_token" = "$(sed -n 's/^COZYGATEWAY_TOKEN=//p' "$tmp/hermes/profiles/ops/.env")"
test "$install_count_before" = "$(grep -c '^default:gateway:install$' "$tmp/commands")"
test "$(grep -c '^default:gateway:restart$' "$tmp/commands")" = 1

# Opting into a public origin moves an existing LAN listener back to loopback,
# persists the canonical HTTPS origin, and advertises it in the automatic pairing finale.
public_output="$(HOME="$tmp/darwin-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --public-url 'HTTPS://Gateway.Example:443/' --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
grep -Fq '"gatewayUrl":"https://gateway.example"' <<<"$public_output"
"$real_node" - "$tmp/gateway-live/local/cozygateway.config.json" <<'NODE'
const { readFileSync } = require('node:fs');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (config.host !== '127.0.0.1' || config.publicUrl !== 'https://gateway.example') process.exit(1);
NODE

preserved_public_output="$(HOME="$tmp/darwin-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
grep -Fq '"gatewayUrl":"https://gateway.example"' <<<"$preserved_public_output"

# Leaving the managed public posture is explicit: clear the saved origin and choose the LAN bind in
# the same update. The config no longer advertises the retired tunnel on later pair commands.
lan_output="$(HOME="$tmp/darwin-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --clear-public-url --bind-host 0.0.0.0 --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
grep -Fq 'CozyGateway listens on 0.0.0.0:8787' <<<"$lan_output"
grep -Fq '"gatewayUrl":"http://127.0.0.1:8787"' <<<"$lan_output"
"$real_node" - "$tmp/gateway-live/local/cozygateway.config.json" <<'NODE'
const { readFileSync } = require('node:fs');
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (config.host !== '0.0.0.0' || Object.hasOwn(config, 'publicUrl')) process.exit(1);
NODE

# A failed delete outside Windows is not evidence of an open-file lock. It must
# fail without restarting an unrelated pre-existing Hermes gateway.
mkdir -p "$tmp/locked-spool-bin"
cat > "$tmp/locked-spool-bin/rm" <<'LOCKED_RM'
#!/usr/bin/env bash
if [[ "$*" == *attach-v1.sqlite* ]] && [ -n "${COZYGATEWAY_TEST_LOCKED_SPOOL_RM_LOG:-}" ]; then
  printf '%s\n' "$*" >> "$COZYGATEWAY_TEST_LOCKED_SPOOL_RM_LOG"
fi
if [[ "$*" == *attach-v1.sqlite* ]] && [ -f "${COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER:?}" ] && { [ "${COZYGATEWAY_TEST_LOCKED_SPOOL_PERSISTS:-}" = 1 ] || [ ! -f "$COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER.unlocked" ]; }; then
  printf 'Device or resource busy\n' >&2
  exit 1
fi
exec /bin/rm "$@"
LOCKED_RM
chmod 700 "$tmp/locked-spool-bin/rm"
mkdir -p "$tmp/hermes/profiles/locked-nonwindows/plugins/cozygateway" "$tmp/hermes/profiles/locked-nonwindows/plugin-data/cozygateway" "$tmp/gateway-nonwindows-locked/local"
: > "$tmp/hermes/profiles/locked-nonwindows/plugins/cozygateway/.cozygateway-installer-owned"
: > "$tmp/hermes/profiles/locked-nonwindows/plugin-data/cozygateway/attach-v1.sqlite"
printf 'running\n' > "$tmp/hermes/gateway-locked-nonwindows.state"
cat > "$tmp/gateway-nonwindows-locked/local/install-state" <<NONWINDOWS_STATE
profiles=locked-nonwindows
hermes_root=$tmp/hermes
hermes_bin=$tmp/bin/hermes
service_locked-nonwindows=preexisting
NONWINDOWS_STATE
nonwindows_spool_marker="$tmp/nonwindows-spool.locked"
if HOME="$tmp/darwin-home" PATH="$tmp/locked-spool-bin:$tmp/service-bin:/usr/bin:/bin" COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER="$nonwindows_spool_marker" COZYGATEWAY_TEST_LOCKED_SPOOL_PROFILE=locked-nonwindows COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/nonwindows-locked-commands" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-nonwindows-locked" >/dev/null 2>&1; then
  echo 'a non-Windows spool deletion failure must not trigger lock recovery' >&2
  exit 1
fi
[ ! -f "$tmp/nonwindows-locked-commands" ] || ! grep -q '^locked-nonwindows:gateway:restart$' "$tmp/nonwindows-locked-commands"

# Normal uninstall reverses only lifecycle work owned by CozyGateway: its
# installed default service is removed, its started existing service is stopped,
# and the pre-existing active service remains running without a restart.
# Deliberately omit COZYGATEWAY_HERMES_BIN: uninstall must use the absolute
# executable captured at install time.
active_restarts_before_uninstall="$(grep -c '^active:gateway:restart$' "$tmp/commands")"
HOME="$tmp/darwin-home" PATH="$tmp/service-bin:/usr/bin:/bin" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-live" >/dev/null
grep -q '^default:gateway:uninstall$' "$tmp/commands"
grep -q '^ops:gateway:stop$' "$tmp/commands"
test "$(grep -c '^active:gateway:restart$' "$tmp/commands")" = "$active_restarts_before_uninstall"
! grep -q '^active:gateway:\(stop\|uninstall\)$' "$tmp/commands"
test "$(cat "$tmp/hermes/gateway-default.state")" = absent
test "$(cat "$tmp/hermes/gateway-ops.state")" = stopped
test "$(cat "$tmp/hermes/gateway-active.state")" = running
test ! -e "$tmp/darwin-home/.local/bin/cozygateway"
! grep -Fq '# CozyGateway CLI' "$tmp/darwin-home/.profile"
! grep -Fq '# CozyGateway CLI' "$tmp/darwin-home/.zprofile"

# Exercise the real Linux unit path with fake systemd tools: lingering is
# enabled and the generated unit points at the validated wrapper.
mkdir -p "$tmp/linux-hermes" "$tmp/linux-home" "$tmp/linux-bin"
printf '{}\n' > "$tmp/linux-hermes/config.yaml"
printf 'absent\n' > "$tmp/linux-hermes/gateway-default.state"
cat > "$tmp/linux-bin/loginctl" <<'LOGINCTL'
#!/usr/bin/env bash
if [ "$1" = show-user ]; then printf 'no\n'; else printf '%s\n' "$*" >> "${COZYGATEWAY_TEST_SYSTEM_LOG:?}"; fi
LOGINCTL
cat > "$tmp/linux-bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${COZYGATEWAY_TEST_SYSTEM_LOG:?}"
SYSTEMCTL
chmod 700 "$tmp/linux-bin/loginctl" "$tmp/linux-bin/systemctl"
printf 'no\n' > "$tmp/lan-no"
linux_output="$(HOME="$tmp/linux-home" XDG_CONFIG_HOME="$tmp/linux-xdg" PATH="$tmp/linux-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_LAN_PROMPT_INPUT="$tmp/lan-no" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/linux-hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/linux-commands" COZYGATEWAY_TEST_SYSTEM_LOG="$tmp/system-commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Linux bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-linux-live" 2>&1)"
grep -Fq 'Allow CozyChat to access this Gateway over your local network? [y/N]' <<<"$linux_output"
grep -Fq 'CozyGateway listens on 127.0.0.1:8787' <<<"$linux_output"
grep -Fq '"host": "127.0.0.1"' "$tmp/gateway-linux-live/local/cozygateway.config.json"
grep -q '^enable-linger ' "$tmp/system-commands"
grep -q '^--user enable --now cozygateway.service$' "$tmp/system-commands"
grep -Fq "ExecStart=/bin/bash $tmp/gateway-linux-live/local/run-gateway.sh" "$tmp/linux-xdg/systemd/user/cozygateway.service"
if [[ "$(uname -s)" = MINGW* ]]; then
  cmp -s "$tmp/linux-home/.local/bin/cozygateway" "$tmp/gateway-linux-live/bin/cozygateway"
else
  test "$(readlink "$tmp/linux-home/.local/bin/cozygateway")" = "$tmp/gateway-linux-live/bin/cozygateway"
fi
grep -Fqx 'export PATH="$HOME/.local/bin:$PATH" # CozyGateway CLI' "$tmp/linux-home/.profile"

# Exercise Windows persistence with fake native tools. The task is current-user,
# limited privilege, starts immediately through the hidden VBS launcher, reports
# merged persistence/health status, and falls back to Startup when schtasks fails.
mkdir -p "$tmp/windows-bin" "$tmp/windows-appdata"
cat > "$tmp/windows-bin/schtasks.exe" <<'SCHTASKS'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${COZYGATEWAY_TEST_WINDOWS_LOG:?}"
if [ "${COZYGATEWAY_TEST_SCHTASKS_FAIL_CREATE:-}" = 1 ] && [ "$1" = /Create ]; then
  printf 'ERROR: Access is denied.\n' >&2
  exit 1
fi
exit 0
SCHTASKS
cat > "$tmp/windows-bin/wscript.exe" <<'WSCRIPT'
#!/usr/bin/env bash
printf 'wscript %s\n' "$*" >> "${COZYGATEWAY_TEST_WINDOWS_LOG:?}"
[ -z "${COZYGATEWAY_TEST_GATEWAY_MARKER:-}" ] || : > "$COZYGATEWAY_TEST_GATEWAY_MARKER"
exit 0
WSCRIPT
cat > "$tmp/windows-bin/powershell.exe" <<'POWERSHELL'
#!/usr/bin/env bash
printf 'powershell %s\n' "$*" >> "${COZYGATEWAY_TEST_WINDOWS_LOG:?}"
if [ -n "${COZYGATEWAY_NODE_EXPAND_DESTINATION:-}" ]; then
  destination="$(cygpath -u "$COZYGATEWAY_NODE_EXPAND_DESTINATION")"
  mkdir -p "$destination/${COZYGATEWAY_TEST_NODE_DIRECTORY:?}"
  cp "${COZYGATEWAY_TEST_NODE_FIXTURE:?}" "$destination/$COZYGATEWAY_TEST_NODE_DIRECTORY/node.exe"
  chmod 700 "$destination/$COZYGATEWAY_TEST_NODE_DIRECTORY/node.exe"
  exit 0
fi
if [ "${COZYGATEWAY_TEST_UNRELATED_LISTENER:-}" = 1 ] && [ "${COZYGATEWAY_CHECK_TARGET_PORT:-}" = 1 ]; then exit 42; fi
if [ "${COZYGATEWAY_TEST_DASHBOARD_MODULE_OWNER:-}" = 1 ] && [[ "${6:-}" == *dashboard-owner.ps1 ]]; then
  [ "$5" = -File ] || exit 42
  helper="$(cygpath -u "$6")"
  grep -Fq 'Test-CozyDashboardOwner' "$helper" || exit 42
  [ -n "${7:-}" ] && [ -n "${8:-}" ] && [ -n "${9:-}" ] && [ -n "${10:-}" ] || exit 42
fi
if [ -n "${COZYGATEWAY_TEST_EXPECT_DASHBOARD_OWNER_PORT:-}" ] && [[ "${6:-}" == *dashboard-owner*.ps1 ]]; then
  [ "${10:-}" = "$COZYGATEWAY_TEST_EXPECT_DASHBOARD_OWNER_PORT" ] || exit 42
fi
if [ -n "${COZYGATEWAY_TEST_DASHBOARD_OWNER_CODE_FILE:-}" ] && [[ "${6:-}" == *dashboard-owner*.ps1 ]]; then
  code="$(sed -n '1p' "$COZYGATEWAY_TEST_DASHBOARD_OWNER_CODE_FILE")"
  sed '1d' "$COZYGATEWAY_TEST_DASHBOARD_OWNER_CODE_FILE" > "$COZYGATEWAY_TEST_DASHBOARD_OWNER_CODE_FILE.next"
  mv "$COZYGATEWAY_TEST_DASHBOARD_OWNER_CODE_FILE.next" "$COZYGATEWAY_TEST_DASHBOARD_OWNER_CODE_FILE"
  exit "${code:-99}"
fi
if [ "${COZYGATEWAY_TEST_DASHBOARD_FOREIGN:-}" = 1 ] && [[ "${6:-}" == *dashboard-owner.ps1 ]]; then exit 42; fi
if [ -n "${COZYGATEWAY_TEST_OWNER_STOP_MARKER:-}" ] && [[ "${6:-}" == *dashboard-owner.ps1 ]]; then : > "$COZYGATEWAY_TEST_OWNER_STOP_MARKER"; fi
rm -f "${COZYGATEWAY_TEST_GATEWAY_MARKER:-}"
[ -z "${COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER:-}" ] || rm -f "$COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER"
[ -z "${COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER:-}" ] || : > "$COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER"
exit 0
POWERSHELL
chmod 700 "$tmp/windows-bin/schtasks.exe" "$tmp/windows-bin/wscript.exe" "$tmp/windows-bin/powershell.exe"

# Windows cannot unlink SQLite files held by a pre-existing Hermes gateway.
# After the installer-owned plugin is disabled, uninstall restarts exactly that
# profile once, retries cleanup, and leaves its service running.
mkdir -p "$tmp/hermes/profiles/locked-windows/plugins/cozygateway" "$tmp/hermes/profiles/locked-windows/plugin-data/cozygateway" "$tmp/gateway-windows-locked/local"
mkdir -p "$tmp/hermes/profiles/unrelated/plugin-data/unrelated"
: > "$tmp/hermes/profiles/locked-windows/plugins/cozygateway/.cozygateway-installer-owned"
: > "$tmp/hermes/profiles/locked-windows/plugin-data/cozygateway/attach-v1.sqlite"
printf 'running\n' > "$tmp/hermes/gateway-locked-windows.state"
printf 'running\n' > "$tmp/hermes/gateway-unrelated.state"
printf 'preserve-me\n' > "$tmp/hermes/profiles/unrelated/plugin-data/unrelated/sentinel"
cat > "$tmp/gateway-windows-locked/local/install-state" <<WINDOWS_LOCKED_STATE
profiles=locked-windows
hermes_root=$tmp/hermes
hermes_bin=$tmp/bin/hermes
service_locked-windows=preexisting
WINDOWS_LOCKED_STATE
windows_spool_marker="$tmp/windows-spool.locked"
HOME="$tmp/windows-locked-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/locked-spool-bin:$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER="$windows_spool_marker" COZYGATEWAY_TEST_LOCKED_SPOOL_PROFILE=locked-windows COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-locked-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-locked-native-commands" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-windows-locked" >/dev/null
test "$(grep -Fxc 'locked-windows:gateway:restart' "$tmp/windows-locked-commands")" = 1
! grep -q '^locked-windows:gateway:\(stop\|uninstall\)$' "$tmp/windows-locked-commands"
test "$(cat "$tmp/hermes/gateway-locked-windows.state")" = running
test "$(cat "$tmp/hermes/gateway-unrelated.state")" = running
test "$(cat "$tmp/hermes/profiles/unrelated/plugin-data/unrelated/sentinel")" = preserve-me
! grep -q '^unrelated:' "$tmp/windows-locked-commands"
test ! -e "$tmp/gateway-windows-locked"
test ! -e "$tmp/hermes/profiles/locked-windows/plugin-data/cozygateway/attach-v1.sqlite"

# Hermes can report a successful service uninstall while its directly spawned
# gateway remains alive and keeps the SQLite spool locked. Recover only for the
# exact installer-owned profile; unowned profiles remain untouched.
mkdir -p "$tmp/hermes/profiles/locked-installed/plugins/cozygateway" "$tmp/hermes/profiles/locked-installed/plugin-data/cozygateway" "$tmp/gateway-windows-installed-locked/local"
: > "$tmp/hermes/profiles/locked-installed/plugins/cozygateway/.cozygateway-installer-owned"
: > "$tmp/hermes/profiles/locked-installed/plugin-data/cozygateway/attach-v1.sqlite"
printf 'running\n' > "$tmp/hermes/gateway-locked-installed.state"
cat > "$tmp/gateway-windows-installed-locked/local/install-state" <<WINDOWS_INSTALLED_LOCKED_STATE
profiles=locked-installed
hermes_root=$tmp/hermes
hermes_bin=$tmp/bin/hermes
service_locked-installed=installed
WINDOWS_INSTALLED_LOCKED_STATE
windows_installed_spool_marker="$tmp/windows-installed-spool.locked"
HOME="$tmp/windows-installed-locked-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/locked-spool-bin:$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER="$windows_installed_spool_marker" COZYGATEWAY_TEST_LOCKED_SPOOL_PROFILE=locked-installed COZYGATEWAY_TEST_UNINSTALL_LEAVES_RUNNING=1 COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-installed-locked-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-installed-locked-native-commands" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-windows-installed-locked" >/dev/null
test "$(grep -Fxc 'locked-installed:gateway:uninstall' "$tmp/windows-installed-locked-commands")" = 1
test "$(grep -Fxc 'locked-installed:gateway:stop' "$tmp/windows-installed-locked-commands")" = 1
test "$(sed -n '1p' "$tmp/windows-installed-locked-commands")" = 'locked-installed:gateway:uninstall'
test "$(sed -n '2p' "$tmp/windows-installed-locked-commands")" = 'locked-installed:gateway:stop'
test "$(cat "$tmp/hermes/gateway-locked-installed.state")" = stopped
test ! -e "$tmp/gateway-windows-installed-locked"
test ! -e "$tmp/hermes/profiles/locked-installed/plugin-data/cozygateway/attach-v1.sqlite"

mkdir -p "$tmp/hermes/profiles/locked-installed-stuck/plugins/cozygateway" "$tmp/hermes/profiles/locked-installed-stuck/plugin-data/cozygateway" "$tmp/gateway-windows-installed-stuck/local"
: > "$tmp/hermes/profiles/locked-installed-stuck/plugins/cozygateway/.cozygateway-installer-owned"
: > "$tmp/hermes/profiles/locked-installed-stuck/plugin-data/cozygateway/attach-v1.sqlite"
printf 'running\n' > "$tmp/hermes/gateway-locked-installed-stuck.state"
cat > "$tmp/gateway-windows-installed-stuck/local/install-state" <<WINDOWS_INSTALLED_STUCK_STATE
profiles=locked-installed-stuck
hermes_root=$tmp/hermes
hermes_bin=$tmp/bin/hermes
service_locked-installed-stuck=installed
WINDOWS_INSTALLED_STUCK_STATE
windows_installed_stuck_marker="$tmp/windows-installed-spool-stuck.locked"
if windows_installed_stuck_output="$(HOME="$tmp/windows-installed-stuck-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/locked-spool-bin:$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER="$windows_installed_stuck_marker" COZYGATEWAY_TEST_LOCKED_SPOOL_PROFILE=locked-installed-stuck COZYGATEWAY_TEST_LOCKED_SPOOL_PERSISTS=1 COZYGATEWAY_TEST_UNINSTALL_LEAVES_RUNNING=1 COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-installed-stuck-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-installed-stuck-native-commands" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-windows-installed-stuck" 2>&1)"; then
  windows_installed_stuck_status=0
else
  windows_installed_stuck_status=$?
fi
test "$windows_installed_stuck_status" -ne 0
grep -Fq 'Hermes stopped, but the CozyGateway spool for profile locked-installed-stuck is still in use' <<<"$windows_installed_stuck_output"
test "$(grep -Fxc 'locked-installed-stuck:gateway:stop' "$tmp/windows-installed-stuck-commands")" = 1
test -e "$tmp/gateway-windows-installed-stuck/local/install-state"
test -e "$tmp/hermes/profiles/locked-installed-stuck/plugin-data/cozygateway/attach-v1.sqlite"

run_locked_windows_fixture() {
  local profile="$1" action="$2"
  shift 2
  locked_gateway_dir="$tmp/gateway-windows-$profile"
  locked_command_log="$tmp/windows-$profile-commands"
  locked_spool="$tmp/hermes/profiles/$profile/plugin-data/cozygateway/attach-v1.sqlite"
  locked_marker="$tmp/windows-$profile-spool.locked"
  locked_rm_log="$tmp/windows-$profile-rm-attempts"
  locked_install_state="$locked_gateway_dir/local/install-state"
  mkdir -p "$tmp/hermes/profiles/$profile/plugins/cozygateway" "$(dirname "$locked_spool")" "$(dirname "$locked_install_state")"
  : > "$tmp/hermes/profiles/$profile/plugins/cozygateway/.cozygateway-installer-owned"
  : > "$locked_spool"
  : > "$locked_marker"
  printf 'running\n' > "$tmp/hermes/gateway-$profile.state"
  {
    printf 'profiles=%s\n' "$profile"
    printf 'hermes_root=%s\n' "$tmp/hermes"
    printf 'hermes_bin=%s\n' "$tmp/bin/hermes"
    printf 'service_%s=%s\n' "$profile" "$action"
  } > "$locked_install_state"
  if locked_output="$(env HOME="$tmp/windows-$profile-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/locked-spool-bin:$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_LOCKED_SPOOL_MARKER="$locked_marker" COZYGATEWAY_TEST_LOCKED_SPOOL_PROFILE="$profile" COZYGATEWAY_TEST_LOCKED_SPOOL_RM_LOG="$locked_rm_log" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$locked_command_log" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-$profile-native-commands" COZYGATEWAY_GIT_BASH="$(command -v bash)" "$@" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$locked_gateway_dir" 2>&1)"; then
    locked_status=0
  else
    locked_status=$?
  fi
}

# Unknown lifecycle state is selected and locked, but never grants authority to
# stop, restart, or uninstall that Hermes profile.
run_locked_windows_fixture locked-unknown unknown
test "$locked_status" -ne 0
[ ! -f "$locked_command_log" ] || ! grep -q '^locked-unknown:gateway:\(stop\|restart\|uninstall\)$' "$locked_command_log"
test -e "$locked_spool"
test -e "$locked_install_state"

# A started service can likewise report a successful stop while its direct
# process remains alive. Cleanup stops only that profile once more and retries
# spool removal exactly once.
run_locked_windows_fixture locked-started started COZYGATEWAY_TEST_STOP_LEAVES_RUNNING_ONCE=1
test "$locked_status" -eq 0
test "$(grep -Fxc 'locked-started:gateway:stop' "$locked_command_log")" = 2
! grep -q '^locked-started:gateway:\(restart\|uninstall\)$' "$locked_command_log"
test "$(wc -l < "$locked_rm_log")" -eq 2
test "$(cat "$tmp/hermes/gateway-locked-started.state")" = stopped
test ! -e "$locked_spool"
test ! -e "$locked_gateway_dir"

run_locked_windows_fixture locked-started-stuck started COZYGATEWAY_TEST_STOP_LEAVES_RUNNING_ONCE=1 COZYGATEWAY_TEST_LOCKED_SPOOL_PERSISTS=1
test "$locked_status" -ne 0
grep -Fq 'Hermes stopped, but the CozyGateway spool for profile locked-started-stuck is still in use' <<<"$locked_output"
test "$(grep -Fxc 'locked-started-stuck:gateway:stop' "$locked_command_log")" = 2
! grep -q '^locked-started-stuck:gateway:\(restart\|uninstall\)$' "$locked_command_log"
test "$(wc -l < "$locked_rm_log")" -eq 2
test "$(cat "$tmp/hermes/gateway-locked-started-stuck.state")" = stopped
test -e "$locked_spool"
test -e "$locked_install_state"

# A machine with Hermes and Git Bash but no Node receives a private, checksum-
# verified Windows Node 24 runtime and resumes installation in the same process.
windows_node_version=v24.99.0
windows_node_directory="node-$windows_node_version-win-x64"
windows_node_archive="$windows_node_directory.zip"
mkdir -p "$tmp/windows-node-dist/$windows_node_version"
printf 'fixture Windows Node archive\n' > "$tmp/windows-node-dist/$windows_node_version/$windows_node_archive"
if command -v shasum >/dev/null 2>&1; then windows_node_sha="$(shasum -a 256 "$tmp/windows-node-dist/$windows_node_version/$windows_node_archive" | awk '{print $1}')"; else windows_node_sha="$(sha256sum "$tmp/windows-node-dist/$windows_node_version/$windows_node_archive" | awk '{print $1}')"; fi
printf '%s  %s\n' "$windows_node_sha" "$windows_node_archive" > "$tmp/windows-node-dist/$windows_node_version/SHASUMS256.txt"
windows_node_output="$(HOME="$tmp/windows-node-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" PROCESSOR_ARCHITECTURE=AMD64 COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-node-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-node-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-node-gateway-ready" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_TEST_NODE_FIXTURE="$fake_node" COZYGATEWAY_TEST_NODE_DIRECTORY="$windows_node_directory" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$tmp/missing-node" COZYGATEWAY_NODE_VERSION="$windows_node_version" COZYGATEWAY_NODE_DIST_BASE="$tmp/windows-node-dist" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-node")"
test -x "$tmp/gateway-windows-node/runtime/node/node.exe"
grep -Fq 'installed checksum-verified Node.js' <<<"$windows_node_output"
grep -Fq '[IO.Compression.ZipFile]::ExtractToDirectory' "$tmp/windows-node-commands"
grep -Fq "using Node.js 24 at $tmp/gateway-windows-node/runtime/node/node.exe" <<<"$(HOME="$tmp/windows-node-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-node-commands" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --status --gateway-dir "$tmp/gateway-windows-node")"

windows_native_hermes="$("$tmp/bin/cygpath" -w "$tmp/bin/hermes")"
windows_output="$(HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-gateway-ready" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$windows_native_hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-live")"
grep -Fqx "hermes_bin=$tmp/bin/hermes" "$tmp/gateway-windows-live/local/install-state"
grep -Fq "const dashboardArgs = ['dashboard', ...(1 === 1 ? ['-p', 'default'] : [])" "$tmp/gateway-windows-live/local/run-gateway.sh"
grep -Fq "windowsDashboardProfile === '1' ? ['-p', 'default'] : []" "$repo_root/scripts/agent-install.sh"

# A fresh interactive install can opt into same-LAN access. Invalid input repeats
# the one question; the affirmative answer persists the wildcard listener and
# prints the temporary/private-network guidance before pairing.
printf 'maybe\ny\n' > "$tmp/windows-lan-answer"
windows_lan_output="$(HOME="$tmp/windows-lan-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_LAN_PROMPT_INPUT="$tmp/windows-lan-answer" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-lan-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-lan-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-lan-gateway-ready" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-lan" 2>&1)"
grep -Fq 'Please answer y or n.' <<<"$windows_lan_output"
grep -Fq 'trusted private network' <<<"$windows_lan_output"
grep -Fq 'Tailscale' <<<"$windows_lan_output"
grep -Fq '"host": "0.0.0.0"' "$tmp/gateway-windows-lan/local/cozygateway.config.json"

grep -Fq '/Create /F /SC ONLOGON /RL LIMITED /TN CozyGateway' "$tmp/windows-commands"
grep -Fq 'wscript ' "$tmp/windows-commands"
grep -Fq 'fake-qr' <<<"$windows_output"
test -f "$tmp/gateway-windows-live/bin/cozygateway.cmd"
grep -Fq 'gateway.mjs' "$tmp/gateway-windows-live/bin/cozygateway.cmd"
if grep -Fq -- '--config' "$tmp/gateway-windows-live/bin/cozygateway.cmd"; then
  echo 'Windows command shim must allow an explicit --config override' >&2
  exit 1
fi
grep -Fq 'shell.Run command, 0, False' "$tmp/gateway-windows-live/local/run-gateway.vbs"
grep -Fq 'command = """' "$tmp/gateway-windows-live/local/run-gateway.vbs"
grep -Eq '^COZYGATEWAY_SPOOL_PATH=[A-Za-z]:\\' "$tmp/hermes/.env"
file "$tmp/gateway-windows-live/local/run-gateway.vbs" | grep -Fq 'CRLF'
# A native Windows Hermes child must receive a native HERMES_HOME. Git Bash's
# /c/... form points native Hermes at the wrong root and makes credential login
# fail after launch.
dashboard_home_log="$tmp/windows-dashboard-home.log"
dashboard_stopped_marker="$tmp/windows-native-dashboard-stopped"
expected_windows_hermes_home="$("$tmp/bin/cygpath" -w "$tmp/hermes")"
: > "$dashboard_stopped_marker"
COZYGATEWAY_TEST_EXPECT_WINDOWS_HIDE=1 COZYGATEWAY_TEST_EXPECTED_DASHBOARD_HOME="$expected_windows_hermes_home" COZYGATEWAY_TEST_DASHBOARD_HOME_LOG="$dashboard_home_log" COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER="$dashboard_stopped_marker" HOME="$tmp/windows-native-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-native-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-native-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-native-gateway-ready" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-native" >/dev/null
grep -Fxq "$expected_windows_hermes_home" "$dashboard_home_log"

# Loopback session-token auth is built into Hermes and must not mutate the
# operator's dashboard-auth plugin allow/deny configuration.
dashboard_stale_disabled_marker="$tmp/windows-dashboard-stale-disabled-stopped"
dashboard_disabled_plugins="$tmp/windows-dashboard-disabled-plugins.json"
: > "$dashboard_stale_disabled_marker"
printf '["basic","dashboard_auth/basic","keep-disabled"]\n' > "$dashboard_disabled_plugins"
COZYGATEWAY_TEST_EXPECT_WINDOWS_HIDE=1 COZYGATEWAY_TEST_EXPECTED_DASHBOARD_HOME="$expected_windows_hermes_home" COZYGATEWAY_TEST_DASHBOARD_HOME_LOG="$tmp/windows-dashboard-stale-disabled-home.log" COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER="$dashboard_stale_disabled_marker" COZYGATEWAY_TEST_DISABLED_PLUGINS_FILE="$dashboard_disabled_plugins" HOME="$tmp/windows-stale-disabled-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-stale-disabled-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-stale-disabled-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-stale-disabled-gateway-ready" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-stale-disabled" >/dev/null
grep -Fxq '["basic","dashboard_auth/basic","keep-disabled"]' "$dashboard_disabled_plugins"

# A newly launched Dashboard must accept the exact loopback session token the
# installer supplied; a healthy public endpoint alone is not enough.
dashboard_missing_provider_marker="$tmp/windows-dashboard-missing-provider-stopped"
dashboard_missing_provider_auth_marker="$tmp/windows-dashboard-missing-provider-auth"
: > "$dashboard_missing_provider_marker"
: > "$dashboard_missing_provider_auth_marker"
if dashboard_missing_provider_output="$(COZYGATEWAY_TEST_EXPECT_WINDOWS_HIDE=1 COZYGATEWAY_TEST_EXPECTED_DASHBOARD_HOME="$expected_windows_hermes_home" COZYGATEWAY_TEST_DASHBOARD_HOME_LOG="$tmp/windows-dashboard-missing-provider-home.log" COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER="$dashboard_missing_provider_marker" COZYGATEWAY_TEST_DASHBOARD_TOKEN_CODE=401 HOME="$tmp/windows-missing-provider-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-missing-provider-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-missing-provider-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-missing-provider-gateway-ready" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-missing-provider" 2>&1)"; then
  echo 'expected rejected Dashboard session token to fail' >&2
  exit 1
fi
expect_contains "$dashboard_missing_provider_output" 'rejected the installer-owned local session token (HTTP 401)'
# A rerun stops only the validated listener and starts the newly installed bundle.
HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-gateway-ready" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-live"
grep -Fq 'powershell -NoProfile -NonInteractive -Command' "$tmp/windows-commands"
grep -Fq 'GetFullPath($candidate)' "$repo_root/scripts/agent-install.sh"
HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-commands" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --status --gateway-dir "$tmp/gateway-windows-live" | grep -Fq 'health endpoint is live'

# An explicit port update must stop the process selected by its managed config,
# even though the replacement port cannot be healthy until the new child starts.
rm -f "$tmp/windows-gateway-ready"
windows_stop_count="$(grep -c '^powershell ' "$tmp/windows-commands")"
HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-gateway-ready" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --port 9000 --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-live" >/dev/null
test "$(grep -c '^powershell ' "$tmp/windows-commands")" -gt "$windows_stop_count"

HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-fallback-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-fallback-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-fallback-gateway-ready" COZYGATEWAY_TEST_SCHTASKS_FAIL_CREATE=1 COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-fallback" >/dev/null
test -f "$tmp/windows-appdata/Microsoft/Windows/Start Menu/Programs/Startup/CozyGateway.vbs"

# Hermes Dashboard 0.20.x can report a successful `dashboard --stop` on Windows
# while its Python child still owns the port. The fallback is allowed to stop
# only that validated Hermes Dashboard listener, then installation continues.
: > "$tmp/windows-dashboard-wrong"
dashboard_stop_home_log="$tmp/windows-dashboard-stop-home.log"
dashboard_relaunch_home_log="$tmp/windows-dashboard-relaunch-home.log"
set +e
dashboard_fallback_output="$(PATH="$tmp/windows-bin:$tmp/bin:$PATH" HOME="$tmp/windows-dashboard-home" APPDATA="$tmp/windows-appdata" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_EXPECT_WINDOWS_HIDE=1 COZYGATEWAY_TEST_EXPECTED_DASHBOARD_HOME="$expected_windows_hermes_home" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-dashboard-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-dashboard-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-dashboard-gateway-ready" COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER="$tmp/windows-dashboard-wrong" COZYGATEWAY_TEST_DASHBOARD_MODULE_OWNER=1 COZYGATEWAY_TEST_EXPECT_DASHBOARD_OWNER_PORT=19119 COZYGATEWAY_TEST_EXPECT_DASHBOARD_LAUNCH_PORT=19119 COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER="$tmp/windows-dashboard-stopped" COZYGATEWAY_TEST_DASHBOARD_STOP_HOME_LOG="$dashboard_stop_home_log" COZYGATEWAY_TEST_DASHBOARD_HOME_LOG="$dashboard_relaunch_home_log" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --dashboard-port 19119 --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-dashboard" 2>&1)"
dashboard_fallback_status=$?
set -e
if [ "$dashboard_fallback_status" -ne 0 ]; then
  printf '%s\n--- powershell log ---\n' "$dashboard_fallback_output" >&2
  cat "$tmp/windows-dashboard-commands" >&2
fi
test "$dashboard_fallback_status" -eq 0
grep -Fxq "$expected_windows_hermes_home" "$dashboard_stop_home_log"
grep -Fxq "$expected_windows_hermes_home" "$dashboard_relaunch_home_log"
grep -Fq 'dashboard-owner.ps1' "$tmp/windows-dashboard-commands"
grep -Fq "$expected_windows_hermes_home" "$tmp/windows-dashboard-commands"
grep -Fq 'COZYGATEWAY_DASHBOARD_OWNER_BEGIN' "$repo_root/scripts/agent-install.sh"
test ! -e "$tmp/windows-dashboard-wrong"
if grep -Fq 'Dashboard stayed listening after stop' <<<"$dashboard_fallback_output"; then
  echo 'Windows Dashboard fallback did not release the validated listener' >&2
  exit 1
fi

# Windows uninstall must stop a Dashboard started by the managed wrapper before
# removing the strict owner helper, while preserving the persisted install port.
grep -Fxq 'dashboard_port=19119' "$tmp/gateway-windows-dashboard/local/install-state"
dashboard_owner_calls_before_uninstall="$(grep -Fc 'dashboard-owner.ps1' "$tmp/windows-dashboard-commands")"
owner_stop_marker="$tmp/windows-dashboard-uninstall-owner-stopped"
HOME="$tmp/windows-dashboard-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-dashboard-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-dashboard-commands" COZYGATEWAY_TEST_DASHBOARD_MODULE_OWNER=1 COZYGATEWAY_TEST_EXPECT_DASHBOARD_OWNER_PORT=19119 COZYGATEWAY_TEST_OWNER_STOP_MARKER="$owner_stop_marker" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-windows-dashboard" >/dev/null
test "$(grep -Fc 'dashboard-owner.ps1' "$tmp/windows-dashboard-commands")" -gt "$dashboard_owner_calls_before_uninstall"
test -f "$owner_stop_marker"
test ! -e "$tmp/gateway-windows-dashboard"

# Indeterminate uninstall ownership gets exactly one scoped elevation. A failed
# elevated inspection and a missing helper both preserve state for recovery.
for case_name in elevated-success elevated-failure missing-helper empty-port; do
  case_dir="$tmp/gateway-windows-uninstall-$case_name"
  mkdir -p "$case_dir/local"
  [ "$case_name" = missing-helper ] || {
    printf '# owner helper fixture\n' > "$case_dir/local/dashboard-owner.ps1"
    printf '# elevation helper fixture\n' > "$case_dir/local/dashboard-owner-elevate.ps1"
  }
  persisted_port=19220
  [ "$case_name" = empty-port ] && persisted_port=
  cat > "$case_dir/local/install-state" <<WINDOWS_DASHBOARD_UNINSTALL_STATE
profiles=uac-cleanup
hermes_root=$tmp/hermes
dashboard_port=$persisted_port
hermes_bin=$tmp/bin/hermes
service_uac-cleanup=preexisting
WINDOWS_DASHBOARD_UNINSTALL_STATE
done
printf '43\n0\n' > "$tmp/windows-uninstall-elevated-success.codes"
HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-uninstall-elevated-success-hermes.log" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-uninstall-elevated-success.log" COZYGATEWAY_TEST_DASHBOARD_OWNER_CODE_FILE="$tmp/windows-uninstall-elevated-success.codes" COZYGATEWAY_TEST_EXPECT_DASHBOARD_OWNER_PORT=19220 COZYGATEWAY_NODE=false COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-windows-uninstall-elevated-success" >/dev/null
test "$(grep -Ec -- '-File .*dashboard-owner\.ps1 ' "$tmp/windows-uninstall-elevated-success.log")" = 1
test "$(grep -Ec -- '-File .*dashboard-owner-elevate\.ps1 ' "$tmp/windows-uninstall-elevated-success.log")" = 1
test ! -s "$tmp/windows-uninstall-elevated-success.codes"
test ! -e "$tmp/gateway-windows-uninstall-elevated-success"

printf '43\n46\n' > "$tmp/windows-uninstall-elevated-failure.codes"
if HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-uninstall-elevated-failure-hermes.log" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-uninstall-elevated-failure.log" COZYGATEWAY_TEST_DASHBOARD_OWNER_CODE_FILE="$tmp/windows-uninstall-elevated-failure.codes" COZYGATEWAY_TEST_EXPECT_DASHBOARD_OWNER_PORT=19220 COZYGATEWAY_NODE=false COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-windows-uninstall-elevated-failure" >/dev/null 2>&1; then
  echo 'expected failed elevated Dashboard cleanup to abort uninstall' >&2
  exit 1
fi
test -f "$tmp/gateway-windows-uninstall-elevated-failure/local/install-state"
test "$(grep -Ec -- '-File .*dashboard-owner\.ps1 ' "$tmp/windows-uninstall-elevated-failure.log")" = 1
test "$(grep -Ec -- '-File .*dashboard-owner-elevate\.ps1 ' "$tmp/windows-uninstall-elevated-failure.log")" = 1

for fail_case in missing-helper empty-port; do
  unrelated_listener=; [ "$fail_case" = missing-helper ] && unrelated_listener=1
  if HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-uninstall-$fail_case-hermes.log" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-uninstall-$fail_case.log" COZYGATEWAY_TEST_UNRELATED_LISTENER="$unrelated_listener" COZYGATEWAY_NODE=false COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-windows-uninstall-$fail_case" >/dev/null 2>&1; then
    echo "expected $fail_case Dashboard cleanup state to abort uninstall" >&2
    exit 1
  fi
  test -f "$tmp/gateway-windows-uninstall-$fail_case/local/install-state"
done

# Removal is a recovery path: it must work from persisted install state even
# when the listener config is corrupt and Node cannot be resolved.
printf '{not-json\n' > "$tmp/gateway-windows-fallback/local/cozygateway.config.json"
# Not `sed -i`: BSD sed requires a backup suffix for it and reads the expression as one, so the
# in-place form runs on the Linux runner and fails on the Mac this is written on.
sed "s|^hermes_bin=.*|hermes_bin=$tmp/missing-hermes|" "$tmp/gateway-windows-fallback/local/install-state" > "$tmp/install-state.rewritten"
mv "$tmp/install-state.rewritten" "$tmp/gateway-windows-fallback/local/install-state"
curl_count_before_uninstall="$(wc -l < "$tmp/curl.log")"
fallback_owner_calls_before_uninstall="$(grep -Fc 'dashboard-owner.ps1' "$tmp/windows-fallback-commands" || true)"
HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:/usr/bin:/bin" COZYGATEWAY_TEST_CURL_LOG="$tmp/curl.log" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-fallback-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-fallback-commands" COZYGATEWAY_TEST_UNRELATED_LISTENER=1 COZYGATEWAY_TEST_DASHBOARD_FOREIGN=1 COZYGATEWAY_NODE=false COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-windows-fallback" >/dev/null
test "$(wc -l < "$tmp/curl.log")" = "$curl_count_before_uninstall"
test "$(grep -Fc 'dashboard-owner.ps1' "$tmp/windows-fallback-commands")" -gt "$fallback_owner_calls_before_uninstall"
test ! -e "$tmp/gateway-windows-fallback"

# A listener alone is not sufficient: an existing Dashboard that rejects the
# credential must be stopped/restarted or fail loudly, never silently accepted.
if wrong_output="$(HOME="$tmp/wrong-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_TEST_DASHBOARD_TOKEN_CODE=401 COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-wrong" 2>&1)"; then
  echo 'expected wrong Dashboard credential to fail' >&2
  exit 1
fi
expect_contains "$wrong_output" 'Dashboard stayed listening after stop'
test ! -e "$tmp/wrong-home/.local/bin/cozygateway"
[ ! -f "$tmp/wrong-home/.profile" ] || ! grep -Fq '# CozyGateway CLI' "$tmp/wrong-home/.profile"
[ ! -f "$tmp/wrong-home/.zprofile" ] || ! grep -Fq '# CozyGateway CLI' "$tmp/wrong-home/.zprofile"

if bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir / >/dev/null 2>&1; then
  echo 'expected unsafe gateway directory to be rejected' >&2
  exit 1
fi
if COZYGATEWAY_HOME=/ COZYGATEWAY_INSTALL_DRYRUN=1 bash "$repo_root/scripts/install.sh" >/dev/null 2>&1; then
  echo 'expected unsafe bootstrap home to be rejected before downloading assets' >&2
  exit 1
fi

# A bootstrap interrupted before install-state exists is still removable with
# no Node, Hermes, or config. The dedicated directory is the recovery boundary.
mkdir -p "$tmp/partial-home" "$tmp/gateway-partial/runtime/node"
printf 'partial\n' > "$tmp/gateway-partial/runtime/node/marker"
HOME="$tmp/partial-home" PATH="$tmp/service-bin:/usr/bin:/bin" COZYGATEWAY_NODE=false COZYGATEWAY_HERMES_BIN=false COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-partial" >/dev/null
test ! -e "$tmp/gateway-partial"

# A container or WSL-like Linux environment with binaries but no running user
# manager is rejected before Node, Hermes, or CozyGateway can be installed.
mkdir -p "$tmp/no-systemd-bin"
cat > "$tmp/no-systemd-bin/systemctl" <<'SYSTEMCTL_MISSING'
#!/usr/bin/env bash
exit 1
SYSTEMCTL_MISSING
cat > "$tmp/no-systemd-bin/loginctl" <<'LOGINCTL_PRESENT'
#!/usr/bin/env bash
exit 0
LOGINCTL_PRESENT
chmod 700 "$tmp/no-systemd-bin/systemctl" "$tmp/no-systemd-bin/loginctl"
if no_systemd_output="$(HOME="$tmp/no-systemd-home" PATH="$tmp/no-systemd-bin:/usr/bin:/bin" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_SERVICE_PLATFORM=Linux bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-no-systemd" 2>&1)"; then
  echo 'expected Linux without a systemd user manager to fail' >&2
  exit 1
fi
grep -Fq 'no systemd user manager is running' <<<"$no_systemd_output"
test ! -e "$tmp/gateway-no-systemd"

echo 'hermes installer dry-run tests passed'

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
fake_node="$repo_root/scripts/test/fake-node24.sh"
real_node="$(command -v node)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-installer-test.XXXXXX")"
tmp="$(cd -P "$tmp" && pwd)"
trap 'rm -rf "$tmp"' EXIT
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
if [ "$1" = model ]; then
  printf 'model\n' >> "${COZYGATEWAY_TEST_COMMAND_LOG:?}"
  [ "${COZYGATEWAY_TEST_MODEL_DECLINE:-}" = 1 ] && exit 1
  exit 0
fi
if [ "$1" = status ]; then
  printf 'Current model: test/model\nActive provider: test-provider\n'
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "config" ] && [ "$4" = "path" ]; then
  [ "$2" = default ] && printf '%s/config.yaml\n' "$root" || printf '%s/profiles/%s/config.yaml\n' "$root" "$2"
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "gateway" ] && [ "$4" = "status" ]; then
  if [ "${COZYGATEWAY_TEST_WINDOWS_STATUS:-}" = 1 ] && [ "$profile" = active ]; then
    printf '✓ Scheduled Task registered: Hermes_Gateway\n  Status: Ready\n✓ Gateway process running (PID: 33036)\n'
    exit 0
  fi
  case "$(state)" in
    absent) printf 'Gateway is not installed\n' ;;
    stopped) printf 'Gateway is not running\n' ;;
    running) printf 'Gateway is supervised\n' ;;
  esac
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "gateway" ]; then
  case "$4" in
    restart) [ "$(state)" = running ] || exit 2; log restart; set_state running ;;
    start) [ "$(state)" = stopped ] || exit 2; log start; set_state running ;;
    install) [ "$(state)" = absent ] || exit 2; [ "$5" = --start-now ] && [ "$6" = --start-on-login ] || exit 2; log install; set_state running ;;
    stop) [ "$(state)" = running ] || exit 2; log stop; set_state stopped ;;
    uninstall) [ "$(state)" = running ] || exit 2; log uninstall; set_state absent ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "plugins" ] && [ "$4" = "enable" ]; then
  printf '%s\n' "$2:$5" >> "${COZYGATEWAY_TEST_COMMAND_LOG:?}"
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
const args = process.argv.slice(2);
if (args[0] === 'pair') {
  const configAt = args.indexOf('--config');
  const config = configAt === -1 ? 'cozygateway.config.json' : args[configAt + 1];
  if (!existsSync(config)) process.exit(2);
  const urlAt = args.indexOf('--url');
  const gatewayUrl = urlAt === -1 ? 'http://127.0.0.1:8787' : args[urlAt + 1];
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
bootstrap_dry_output="$(COZYGATEWAY_HOME="$tmp/bootstrap-dry-home" COZYGATEWAY_INSTALL_ASSET_BASE="file://$tmp/release-assets" COZYGATEWAY_INSTALL_DRYRUN=1 bash "$repo_root/scripts/install.sh")"
grep -Fq 'DRY   verified assets' <<<"$bootstrap_dry_output"
test ! -e "$tmp/bootstrap-dry-home"

for platform in Darwin Linux Windows; do
  windows_status=; [ "$platform" = Windows ] && windows_status=1
  output="$(PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_WINDOWS_STATUS="$windows_status" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM="$platform" bash "$repo_root/scripts/agent-install.sh" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-$platform")"
  grep -q 'Profiles: default active ops' <<<"$output"
  grep -q "one CozyGateway $platform service" <<<"$output"
  grep -q 'Hermes Dashboard as local control plane' <<<"$output"
  grep -q 'mint pairing code and QR' <<<"$output"
  grep -Fq "$tmp/gateway-$platform/bin/cozygateway pair --url https://gateway.example.com" <<<"$output"
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
missing_dry_output="$(HOME="$tmp/missing-dry-home" PATH="$tmp/bin:$PATH" COZYGATEWAY_HERMES_BIN="$tmp/missing-hermes" COZYGATEWAY_NODE="$tmp/missing-node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-missing-dry")"
grep -Fq 'install the current Node.js 24 release' <<<"$missing_dry_output"
grep -Fq 'install Hermes Agent with the verified official tagged NousResearch installer' <<<"$missing_dry_output"
test ! -e "$tmp/gateway-missing-dry"
if PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --dry-run --bind-host 'http://not-a-host' --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-invalid-host" >/dev/null 2>&1; then
  echo 'expected URL syntax in --bind-host to fail' >&2
  exit 1
fi

# A non-dry macOS-path run proves the installer writes the Hermes-only config
# and secret files without needing a real launchd or Hermes process. Keep the
# service-manager fake separate from Hermes so uninstall can prove it uses the
# executable persisted in installer state instead of whichever `hermes` PATH
# happens to contain later.
mkdir -p "$tmp/service-bin" "$tmp/darwin-home"
cat > "$tmp/service-bin/launchctl" <<'LAUNCHCTL'
#!/usr/bin/env bash
exit 0
LAUNCHCTL
chmod 700 "$tmp/service-bin/launchctl"

# Declining or aborting `hermes model` stops before CozyGateway mutation and
# never prints pairing material.
if declined_output="$(HOME="$tmp/model-declined-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/model-declined-commands" COZYGATEWAY_TEST_MODEL_DECLINE=1 COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-model-declined" 2>&1)"; then
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
    elif [ "${COZYGATEWAY_TEST_ZERO_ATTACH:-}" = 1 ]; then printf '{"attach":{"configured":0,"online":0,"deadLetters":0}}'
    else printf '{"attach":{"configured":1,"online":1,"deadLetters":0}}'; fi
    ;;
  *api/health*)
    if [ -n "${COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER:-}" ] && [ -f "$COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER" ]; then printf '000'; else printf '401'; fi
    ;;
  *password-login*)
    cat >/dev/null
    if [ -n "${COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER:-}" ] && [ -f "$COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER" ]; then printf '401'; else printf '%s' "${COZYGATEWAY_TEST_DASHBOARD_LOGIN_CODE:-200}"; fi
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
live_output="$(HOME="$tmp/darwin-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_CURL_LOG="$tmp/curl.log" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_TEST_HERMES_FIXTURE="$tmp/bin/hermes" COZYGATEWAY_HERMES_BIN="$tmp/missing-hermes" COZYGATEWAY_HERMES_INSTALL_URL="$tmp/hermes-official-installer.sh" COZYGATEWAY_HERMES_INSTALL_SHA256="$hermes_installer_sha" COZYGATEWAY_NODE="$tmp/missing-node" COZYGATEWAY_NODE_VERSION="$node_version" COZYGATEWAY_NODE_DIST_BASE="$tmp/node-dist" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bind-host 192.0.2.10 --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
test -x "$tmp/gateway-live/runtime/node/bin/node"
grep -Fq 'installed checksum-verified Node.js' <<<"$live_output"
grep -Fq 'Hermes Agent is not installed; starting the official installer.' <<<"$live_output"
grep -Fq 'Hermes provider and model are configured' <<<"$live_output"
grep -q '^model$' "$tmp/commands"
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
grep -Fq 'configured must be positive' <<<"$zero_attach_output"
if grep -Fq 'fake-qr' <<<"$zero_attach_output"; then echo 'unhealthy attach state printed pairing material' >&2; exit 1; fi
# shellcheck disable=SC2016
if grep -Fq 'spaces $dollar' <<<"$live_output"; then
  echo 'installer output must not contain credentials' >&2
  exit 1
fi
# The install finishes on the pairing finale: QR, payload JSON, and the re-mint one-liner.
grep -Fq 'fake-qr' <<<"$live_output"
grep -Fq '"setupCode":"TEST-CODE"' <<<"$live_output"
grep -Fq "mint a fresh QR and code with: $tmp/gateway-live/bin/cozygateway pair" <<<"$live_output"
grep -q '"profiles"' "$tmp/gateway-live/local/cozygateway.config.json"
grep -q '"agents"' "$tmp/gateway-live/local/cozygateway.config.json" && exit 1
grep -Fq 'COZYGATEWAY_URL=http://192.0.2.10:8787' "$tmp/hermes/.env"
grep -Fq 'http://192.0.2.10:8787/health' "$tmp/curl.log"
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
if (dashboard.DASHBOARD_USERNAME !== 'cozygateway' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(dashboard.DASHBOARD_PASSWORD) ||
    gateway.COZYGATEWAY_HERMES_PASSWORD !== dashboard.DASHBOARD_PASSWORD) process.exit(1);
NODE
grep -q '^default:basic$' "$tmp/commands"
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
if grep -Eq 'COZYGATEWAY_(HERMES_PASSWORD|ATTACH_TOKEN)' "$tmp/gateway-live/bin/cozygateway"; then
  echo 'gateway CLI wrapper must not contain secrets' >&2
  exit 1
fi
grep -Fq 'watchFile(config' "$tmp/gateway-live/local/run-gateway.sh"
grep -Fq 'restartGateway' "$tmp/gateway-live/local/run-gateway.sh"
remote_pair="$(COZYGATEWAY_TEST_REAL_NODE="$real_node" "$tmp/gateway-live/bin/cozygateway" pair --url https://gateway.example.com)"
grep -q '"gatewayUrl":"https://gateway.example.com"' <<<"$remote_pair"
grep -Fq 'parseEnv(readFileSync(gatewayEnvPath' "$tmp/gateway-live/local/run-gateway.sh"
grep -Fq '/auth/password-login' "$tmp/gateway-live/local/run-gateway.sh"
grep -Fq 'spawn(process.execPath, [bundle' "$tmp/gateway-live/local/run-gateway.sh"
sed -n "/<<'NODE'/,/^NODE$/p" "$tmp/gateway-live/local/run-gateway.sh" | sed '1d;$d' | "$real_node" --check -
if grep -Fq '. "' "$tmp/gateway-live/local/run-gateway.sh"; then
  echo 'gateway wrapper must not source credential files' >&2
  exit 1
fi

# Exercise the generated supervisor rather than only checking its source. An
# atomic config replacement must terminate the first gateway child and launch
# a second child that reads the new listener port.
sed -n "/<<'NODE'/,/^NODE$/p" "$tmp/gateway-live/local/run-gateway.sh" | sed '1d;$d' > "$tmp/supervisor.cjs"
cat > "$tmp/reload-gateway.mjs" <<'RELOAD_GATEWAY'
import { appendFileSync, readFileSync } from 'node:fs';
const configAt = process.argv.indexOf('--config');
const config = JSON.parse(readFileSync(process.argv[configAt + 1], 'utf8'));
appendFileSync(process.env.COZYGATEWAY_TEST_RELOAD_LOG, `${process.pid}:${config.port}\n`);
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => process.exit(0), 5000);
RELOAD_GATEWAY
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) reload_log="$(cygpath -w "$tmp/reload.log")"; spawnable_hermes="$(command -v cmd.exe)" ;;
  *) reload_log="$tmp/reload.log"; spawnable_hermes="$(command -v true)" ;;
esac
COZYGATEWAY_TEST_RELOAD_LOG="$reload_log" "$real_node" "$tmp/supervisor.cjs" \
  "$tmp/gateway-live/local/gateway.env" "$tmp/gateway-live/local/dashboard.env" "$tmp/hermes" \
  "$spawnable_hermes" 19119 "$tmp/reload-gateway.mjs" "$tmp/gateway-live/local/cozygateway.config.json" \
  >"$tmp/supervisor.log" 2>&1 &
supervisor_pid=$!
for _ in $(seq 1 50); do [ -s "$tmp/reload.log" ] && break; sleep 0.1; done
test -s "$tmp/reload.log"
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
test "$(wc -l < "$tmp/reload.log")" -ge 2
sed -n '1p' "$tmp/reload.log" | grep -Eq '^[0-9]+:8787$'
sed -n '2p' "$tmp/reload.log" | grep -Eq '^[0-9]+:8998$'
test "$(cut -d: -f1 "$tmp/reload.log" | sed -n '1p')" != "$(cut -d: -f1 "$tmp/reload.log" | sed -n '2p')"

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
rerun_output="$(HOME="$tmp/darwin-home" PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
# Rerunning on an installed gateway still lands on the pairing finale with a minted code.
grep -Fq 'fake-qr' <<<"$rerun_output"
grep -Fq '"setupCode":"TEST-CODE"' <<<"$rerun_output"
test "$default_token" = "$(sed -n 's/^COZYGATEWAY_TOKEN=//p' "$tmp/hermes/.env")"
test "$ops_token" = "$(sed -n 's/^COZYGATEWAY_TOKEN=//p' "$tmp/hermes/profiles/ops/.env")"
test "$install_count_before" = "$(grep -c '^default:gateway:install$' "$tmp/commands")"
test "$(grep -c '^default:gateway:restart$' "$tmp/commands")" = 1

# Uninstall reverses only lifecycle work owned by CozyGateway: its installed
# default service is removed, its started existing service is stopped, and the
# pre-existing active service is left untouched.
# Deliberately remove the fake Hermes directory and omit COZYGATEWAY_HERMES_BIN:
# uninstall must use the absolute executable captured at install time.
HOME="$tmp/darwin-home" PATH="$tmp/service-bin:/usr/bin:/bin" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-live" >/dev/null
grep -q '^default:gateway:uninstall$' "$tmp/commands"
grep -q '^ops:gateway:stop$' "$tmp/commands"
if grep -q '^active:gateway:\(stop\|uninstall\)$' "$tmp/commands"; then
  echo 'uninstall must not alter a pre-existing Hermes service' >&2
  exit 1
fi
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
HOME="$tmp/linux-home" XDG_CONFIG_HOME="$tmp/linux-xdg" PATH="$tmp/linux-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/linux-hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/linux-commands" COZYGATEWAY_TEST_SYSTEM_LOG="$tmp/system-commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Linux bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-linux-live" >/dev/null
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
if [ "${COZYGATEWAY_TEST_UNRELATED_LISTENER:-}" = 1 ] && [ "${COZYGATEWAY_CHECK_TARGET_PORT:-}" = 1 ]; then exit 42; fi
rm -f "${COZYGATEWAY_TEST_GATEWAY_MARKER:-}"
[ -z "${COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER:-}" ] || rm -f "$COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER"
[ -z "${COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER:-}" ] || : > "$COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER"
exit 0
POWERSHELL
chmod 700 "$tmp/windows-bin/schtasks.exe" "$tmp/windows-bin/wscript.exe" "$tmp/windows-bin/powershell.exe"
windows_output="$(HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-gateway-ready" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-live")"
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
# A rerun stops only the validated listener and starts the newly installed bundle.
HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-gateway-ready" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-live"
grep -Fq 'powershell -NoProfile -NonInteractive -Command' "$tmp/windows-commands"
grep -Fq 'GetFullPath($candidate)' "$repo_root/scripts/agent-install.sh"
HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-commands" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --status --gateway-dir "$tmp/gateway-windows-live" | grep -Fq 'health endpoint is live'

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
set +e
dashboard_fallback_output="$(PATH="$tmp/windows-bin:$tmp/bin:$PATH" HOME="$tmp/windows-dashboard-home" APPDATA="$tmp/windows-appdata" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-dashboard-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-dashboard-commands" COZYGATEWAY_TEST_GATEWAY_MARKER="$tmp/windows-dashboard-gateway-ready" COZYGATEWAY_TEST_DASHBOARD_WRONG_MARKER="$tmp/windows-dashboard-wrong" COZYGATEWAY_TEST_DASHBOARD_STOPPED_MARKER="$tmp/windows-dashboard-stopped" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-windows-dashboard" 2>&1)"
set -e
grep -Fq 'COZYGATEWAY_EXPECTED_DASHBOARD_PORT' "$tmp/windows-dashboard-commands"
grep -Fq 'COZYGATEWAY_EXPECTED_DASHBOARD_LAUNCHER' "$tmp/windows-dashboard-commands"
grep -Fq 'GetFullPath($token)' "$repo_root/scripts/agent-install.sh"
test ! -e "$tmp/windows-dashboard-wrong"
if grep -Fq 'Dashboard stayed listening after stop' <<<"$dashboard_fallback_output"; then
  echo 'Windows Dashboard fallback did not release the validated listener' >&2
  exit 1
fi

# Removal is a recovery path: it must work from persisted install state even
# when the listener config is corrupt and Node cannot be resolved.
printf '{not-json\n' > "$tmp/gateway-windows-fallback/local/cozygateway.config.json"
# Not `sed -i`: BSD sed requires a backup suffix for it and reads the expression as one, so the
# in-place form runs on the Linux runner and fails on the Mac this is written on.
sed "s|^hermes_bin=.*|hermes_bin=$tmp/missing-hermes|" "$tmp/gateway-windows-fallback/local/install-state" > "$tmp/install-state.rewritten"
mv "$tmp/install-state.rewritten" "$tmp/gateway-windows-fallback/local/install-state"
curl_count_before_uninstall="$(wc -l < "$tmp/curl.log")"
HOME="$tmp/windows-home" APPDATA="$tmp/windows-appdata" PATH="$tmp/windows-bin:$tmp/bin:/usr/bin:/bin" COZYGATEWAY_TEST_CURL_LOG="$tmp/curl.log" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/windows-fallback-hermes-commands" COZYGATEWAY_TEST_WINDOWS_LOG="$tmp/windows-fallback-commands" COZYGATEWAY_TEST_UNRELATED_LISTENER=1 COZYGATEWAY_NODE=false COZYGATEWAY_GIT_BASH="$(command -v bash)" COZYGATEWAY_SERVICE_PLATFORM=Windows bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-windows-fallback" >/dev/null
test "$(wc -l < "$tmp/curl.log")" = "$curl_count_before_uninstall"
test ! -e "$tmp/gateway-windows-fallback"

# A listener alone is not sufficient: an existing Dashboard that rejects the
# credential must be stopped/restarted or fail loudly, never silently accepted.
if wrong_output="$(HOME="$tmp/wrong-home" PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_TEST_DASHBOARD_LOGIN_CODE=401 COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-wrong" 2>&1)"; then
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

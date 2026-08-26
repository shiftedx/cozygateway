#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
fake_node="$repo_root/scripts/test/fake-node24.sh"
real_node="$(command -v node)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-installer-test.XXXXXX")"
tmp="$(cd -P "$tmp" && pwd)"
trap 'rm -rf "$tmp"' EXIT
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
if [ "$1" = "-p" ] && [ "$3" = "config" ] && [ "$4" = "path" ]; then
  [ "$2" = default ] && printf '%s/config.yaml\n' "$root" || printf '%s/profiles/%s/config.yaml\n' "$root" "$2"
  exit 0
fi
if [ "$1" = "-p" ] && [ "$3" = "gateway" ] && [ "$4" = "status" ]; then
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

for platform in Darwin Linux; do
  output="$(PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM="$platform" bash "$repo_root/scripts/agent-install.sh" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-$platform")"
  grep -q 'Profiles: default active ops' <<<"$output"
  grep -q "one CozyGateway $platform service" <<<"$output"
  grep -q 'Hermes Dashboard as local control plane' <<<"$output"
  grep -q 'mint pairing code and QR' <<<"$output"
  grep -Fq "$tmp/gateway-$platform/bin/cozygateway pair --url https://gateway.example.com" <<<"$output"
  grep -Fq "gateway install --start-now --start-on-login" <<<"$output"
  grep -Fq "gateway start" <<<"$output"
  grep -Fq "gateway restart" <<<"$output"
done

# A non-dry macOS-path run proves the installer writes the Hermes-only config
# and secret files without needing a real launchd or Hermes process. Keep the
# service-manager fake separate from Hermes so uninstall can prove it uses the
# executable persisted in installer state instead of whichever `hermes` PATH
# happens to contain later.
mkdir -p "$tmp/service-bin"
cat > "$tmp/service-bin/launchctl" <<'LAUNCHCTL'
#!/usr/bin/env bash
exit 0
LAUNCHCTL
chmod 700 "$tmp/service-bin/launchctl"
cat > "$tmp/bin/curl" <<'CURL'
#!/usr/bin/env bash
case "$*" in
  *password-login*) cat >/dev/null; printf '%s' "${COZYGATEWAY_TEST_DASHBOARD_LOGIN_CODE:-200}" ;;
  *) printf '401' ;;
esac
CURL
chmod 700 "$tmp/bin/curl"
live_output="$(PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
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
mode_of() {
  case "$(uname -s)" in
    Darwin) stat -f '%Lp' "$1" ;;
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
grep -Fq "hermes_bin=$tmp/bin/hermes" "$tmp/gateway-live/local/install-state"
test ! -e "$credential_marker"
test -x "$tmp/gateway-live/bin/cozygateway"
if grep -Eq 'COZYGATEWAY_(HERMES_PASSWORD|ATTACH_TOKEN)' "$tmp/gateway-live/bin/cozygateway"; then
  echo 'gateway CLI wrapper must not contain secrets' >&2
  exit 1
fi
remote_pair="$(COZYGATEWAY_TEST_REAL_NODE="$real_node" "$tmp/gateway-live/bin/cozygateway" pair --url https://gateway.example.com)"
grep -q '"gatewayUrl":"https://gateway.example.com"' <<<"$remote_pair"
grep -Fq 'parseEnv(readFileSync(gatewayEnvPath' "$tmp/gateway-live/local/run-gateway.sh"
grep -Fq '/auth/password-login' "$tmp/gateway-live/local/run-gateway.sh"
sed -n "/<<'NODE'/,/^NODE$/p" "$tmp/gateway-live/local/run-gateway.sh" | sed '1d;$d' | "$real_node" --check -
if grep -Fq '. "' "$tmp/gateway-live/local/run-gateway.sh"; then
  echo 'gateway wrapper must not source credential files' >&2
  exit 1
fi

# A rerun sees all services running, preserves the installer-owned lifecycle
# records and attach tokens, and never tries to install a second Hermes service.
default_token="$(sed -n 's/^COZYGATEWAY_TOKEN=//p' "$tmp/hermes/.env")"
ops_token="$(sed -n 's/^COZYGATEWAY_TOKEN=//p' "$tmp/hermes/profiles/ops/.env")"
install_count_before="$(grep -c '^default:gateway:install$' "$tmp/commands")"
rerun_output="$(PATH="$tmp/service-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-live")"
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
PATH="$tmp/service-bin:/usr/bin:/bin" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir "$tmp/gateway-live" >/dev/null
grep -q '^default:gateway:uninstall$' "$tmp/commands"
grep -q '^ops:gateway:stop$' "$tmp/commands"
if grep -q '^active:gateway:\(stop\|uninstall\)$' "$tmp/commands"; then
  echo 'uninstall must not alter a pre-existing Hermes service' >&2
  exit 1
fi
test "$(cat "$tmp/hermes/gateway-default.state")" = absent
test "$(cat "$tmp/hermes/gateway-ops.state")" = stopped
test "$(cat "$tmp/hermes/gateway-active.state")" = running

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
HOME="$tmp/linux-home" PATH="$tmp/linux-bin:$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/linux-hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/linux-commands" COZYGATEWAY_TEST_SYSTEM_LOG="$tmp/system-commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Linux bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-linux-live" >/dev/null
grep -q '^enable-linger ' "$tmp/system-commands"
grep -q '^--user enable --now cozygateway.service$' "$tmp/system-commands"
grep -Fq "ExecStart=/bin/bash $tmp/gateway-linux-live/local/run-gateway.sh" "$tmp/linux-home/.config/systemd/user/cozygateway.service"

# A listener alone is not sufficient: an existing Dashboard that rejects the
# credential must be stopped/restarted or fail loudly, never silently accepted.
if wrong_output="$(PATH="$tmp/bin:$PATH" COZYGATEWAY_TEST_HERMES_ROOT="$tmp/hermes" COZYGATEWAY_TEST_COMMAND_LOG="$tmp/commands" COZYGATEWAY_TEST_REAL_NODE="$real_node" COZYGATEWAY_TEST_DASHBOARD_LOGIN_CODE=401 COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_NODE="$fake_node" COZYGATEWAY_SERVICE_PLATFORM=Darwin bash "$repo_root/scripts/agent-install.sh" --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$tmp/gateway-wrong" 2>&1)"; then
  echo 'expected wrong Dashboard credential to fail' >&2
  exit 1
fi
grep -q 'Dashboard stayed listening after stop' <<<"$wrong_output"

if bash "$repo_root/scripts/agent-install.sh" --uninstall --gateway-dir / >/dev/null 2>&1; then
  echo 'expected unsafe gateway directory to be rejected' >&2
  exit 1
fi
if COZYGATEWAY_HOME=/ COZYGATEWAY_INSTALL_DRYRUN=1 bash "$repo_root/scripts/install.sh" >/dev/null 2>&1; then
  echo 'expected unsafe bootstrap home to be rejected before downloading assets' >&2
  exit 1
fi

echo 'hermes installer dry-run tests passed'

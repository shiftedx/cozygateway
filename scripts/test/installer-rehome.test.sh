#!/usr/bin/env bash
# Re-homing a Hermes install from a remote CozyGateway to a local one.
#
# Every case here runs against temp directories and fakes: a fake `hermes`, a
# fake `curl`, a fake `launchctl`, and fake `lsof`/`ps` for Dashboard ownership.
# Nothing in this file may read or write a real Hermes root, a real
# ~/.cozygateway, a real LaunchAgent, or a real service.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
installer="$repo_root/scripts/agent-install.sh"
fake_node="$repo_root/scripts/test/fake-node24.sh"
real_node="$(command -v node)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-rehome-test.XXXXXX")"
tmp="$(cd -P "$tmp" && pwd)"
trap 'rm -rf "$tmp"' EXIT

expect_contains() {
  local haystack="$1" needle="$2"
  if ! grep -Fq -- "$needle" <<<"$haystack"; then
    printf 'FAIL  expected output to contain: %s\n--- actual output ---\n%s\n--- end ---\n' "$needle" "$haystack" >&2
    exit 1
  fi
}
expect_absent() {
  local haystack="$1" needle="$2"
  if grep -Fq -- "$needle" <<<"$haystack"; then
    printf 'FAIL  expected output NOT to contain: %s\n--- actual output ---\n%s\n--- end ---\n' "$needle" "$haystack" >&2
    exit 1
  fi
}
fail() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

mkdir -p "$tmp/bin"

# Deterministic fakes for the installer's retry loops: no real seconds pass.
cat > "$tmp/bin/sleep" <<'SLEEP'
#!/usr/bin/env bash
exit 0
SLEEP
chmod 700 "$tmp/bin/sleep"

# A Hermes stand-in with exactly the surface this installer drives. Its gateway
# lifecycle is a per-profile state file, so stop/start ordering is observable.
#
# COZYGATEWAY_TEST_PROVISIONER_PROFILES: profiles whose RUNNING gateway rewrites
# its own .env from memory on every hermes invocation, which is what the live
# dev-box provisioner and a loaded Hermes gateway both do. Stopping the profile
# before writing its env is the only thing that makes the write stick.
cat > "$tmp/bin/hermes" <<'HERMES'
#!/usr/bin/env bash
root="${COZYGATEWAY_TEST_HERMES_ROOT:?}"
log_command() { printf '%s\n' "$1" >> "${COZYGATEWAY_TEST_COMMAND_LOG:?}"; }
profile_home() { if [ "$1" = default ]; then printf '%s' "$root"; else printf '%s/profiles/%s' "$root" "$1"; fi; }
state_file() { printf '%s/gateway-%s.state' "$root" "$1"; }
state() { [ -f "$(state_file "$1")" ] && cat "$(state_file "$1")" || printf 'absent'; }
set_state() { printf '%s\n' "$2" > "$(state_file "$1")"; }
# A loaded gateway holds the target it read at startup and writes THAT back
# over its .env, whatever the file says now. The snapshot below is that memory.
remember_target() {
  local name="$1" home url
  home="$(profile_home "$name")"
  url="${COZYGATEWAY_TEST_REMOTE_ORIGIN:-https://warm.example.test}"
  [ ! -f "$home/.env" ] || url="$(sed -n 's/^COZYGATEWAY_URL=//p' "$home/.env" | tail -1)"
  [ -n "$url" ] || url="${COZYGATEWAY_TEST_REMOTE_ORIGIN:-https://warm.example.test}"
  printf '%s\n' "$url" > "$root/gateway-$name.target"
}
rewrite_env() {
  local name="$1" home url
  case " ${COZYGATEWAY_TEST_PROVISIONER_PROFILES:-} " in *" $name "*) ;; *) return 0 ;; esac
  [ "$(state "$name")" = running ] || return 0
  home="$(profile_home "$name")"
  [ -f "$home/.env" ] || return 0
  if [ -f "$root/gateway-$name.target" ]; then url="$(cat "$root/gateway-$name.target")"
  else url="${COZYGATEWAY_TEST_REMOTE_ORIGIN:-https://warm.example.test}"; fi
  grep -v -E '^COZYGATEWAY_URL=' "$home/.env" > "$home/.env.provisioner" || true
  printf 'COZYGATEWAY_URL=%s\n' "$url" >> "$home/.env.provisioner"
  mv "$home/.env.provisioner" "$home/.env"
  printf '%s\n' "$name:provisioner-rewrote-env" >> "${COZYGATEWAY_TEST_COMMAND_LOG:?}"
}

if [ "$1" = config ] && [ "$2" = path ]; then
  # No -p: the ACTIVE profile, which is what a plain `hermes gateway run` means.
  if [ -n "${COZYGATEWAY_TEST_ACTIVE_PROFILE:-}" ]; then
    printf '%s/config.yaml\n' "$(profile_home "$COZYGATEWAY_TEST_ACTIVE_PROFILE")"
  fi
  exit 0
fi
if [ "$1" = status ]; then printf 'Current model: test/model\nActive provider: test-provider\n'; exit 0; fi
if [ "$1" = dashboard ]; then
  # Hermes 0.17+ lists --isolated; the installer probes for it before passing it.
  if [ "${2:-}" = --help ]; then printf '  --isolated\n'; exit 0; fi
  [ -z "${COZYGATEWAY_TEST_DASHBOARD_LAUNCH_MARKER:-}" ] || printf '%s\n' "$*" > "$COZYGATEWAY_TEST_DASHBOARD_LAUNCH_MARKER"
  exit 0
fi

if [ "$1" = "-p" ]; then
  profile="$2"
  rewrite_env "$profile"
  if [ "$3" = config ] && [ "$4" = path ]; then printf '%s/config.yaml\n' "$(profile_home "$profile")"; exit 0; fi
  if [ "$3" = config ] && [ "$4" = get ]; then printf '[]\n'; exit 0; fi
  if [ "$3" = config ] && [ "$4" = set ]; then log_command "$profile:config-set:$5=$6"; exit 0; fi
  if [ "$3" = plugins ]; then log_command "$profile:plugins:$4"; exit 0; fi
  if [ "$3" = gateway ]; then
    case "$4" in
      status)
        case "$(state "$profile")" in
          absent) printf '✗ Gateway is not running\n\nTo start:\n  hermes gateway install  # Install as user service\n' ;;
          stopped) printf 'Gateway is not running\n' ;;
          running) printf 'Gateway is supervised\n✓ Gateway process running (PID: %s)\n' "${COZYGATEWAY_TEST_GATEWAY_PID:-4242}" ;;
        esac
        ;;
      stop) [ "$(state "$profile")" = running ] || exit 2; log_command "$profile:gateway:stop"; set_state "$profile" stopped ;;
      start) [ "$(state "$profile")" = stopped ] || exit 2; log_command "$profile:gateway:start"; remember_target "$profile"; set_state "$profile" running ;;
      restart) [ "$(state "$profile")" = running ] || exit 2; log_command "$profile:gateway:restart"; remember_target "$profile"; set_state "$profile" running ;;
      install) [ "$(state "$profile")" = absent ] || exit 2; log_command "$profile:gateway:install"; remember_target "$profile"; set_state "$profile" running ;;
      *) exit 2 ;;
    esac
    exit 0
  fi
fi
exit 0
HERMES
chmod 700 "$tmp/bin/hermes"

# The gateway and Dashboard endpoints the installer probes.
cat > "$tmp/bin/curl" <<'CURL'
#!/usr/bin/env bash
# Snapshot the installer's process ledger the first time the gateway is probed:
# a finished run deletes it, and the test still has to see what it held.
if [ -n "${COZYGATEWAY_TEST_PID_SNAPSHOT:-}" ] && [ -f "${COZYGATEWAY_TEST_PID_SOURCE:-}" ]; then
  cp "$COZYGATEWAY_TEST_PID_SOURCE" "$COZYGATEWAY_TEST_PID_SNAPSHOT"
fi
case "$*" in
  *8787/health*)
    if [[ "$*" == *"-o /dev/null"* ]]; then printf '200'
    else printf '%s' "${COZYGATEWAY_TEST_ATTACH_HEALTH:-{\"attach\":{\"configured\":4,\"online\":4,\"deadLetters\":0}}}"; fi
    ;;
  *api/health*)
    if [ -n "${COZYGATEWAY_TEST_DASHBOARD_LAUNCH_MARKER:-}" ] && [ ! -f "$COZYGATEWAY_TEST_DASHBOARD_LAUNCH_MARKER" ]; then printf '000'
    else printf '%s' "${COZYGATEWAY_TEST_DASHBOARD_HEALTH_CODE:-401}"; fi
    ;;
  *api/config*) cat >/dev/null; printf '%s' "${COZYGATEWAY_TEST_DASHBOARD_TOKEN_CODE:-200}" ;;
  *) printf '401' ;;
esac
CURL
chmod 700 "$tmp/bin/curl"

mkdir -p "$tmp/service-bin"
cat > "$tmp/service-bin/launchctl" <<'LAUNCHCTL'
#!/usr/bin/env bash
exit 0
LAUNCHCTL
chmod 700 "$tmp/service-bin/launchctl"

# Dashboard ownership evidence. A foreign listener is identified by pid, command
# line and profile; the installer must never guess from the port alone.
cat > "$tmp/bin/lsof" <<'LSOF'
#!/usr/bin/env bash
[ -n "${COZYGATEWAY_TEST_DASHBOARD_OWNER_PID:-}" ] || exit 1
printf '%s\n' "$COZYGATEWAY_TEST_DASHBOARD_OWNER_PID"
LSOF
chmod 700 "$tmp/bin/lsof"
cat > "$tmp/bin/ps" <<'PS'
#!/usr/bin/env bash
if [ "${1:-}" = -o ] && [ -n "${COZYGATEWAY_TEST_DASHBOARD_OWNER_COMMAND:-}" ]; then
  printf '%s\n' "$COZYGATEWAY_TEST_DASHBOARD_OWNER_COMMAND"
  exit 0
fi
exec /bin/ps "$@"
PS
chmod 700 "$tmp/bin/ps"

# The verified release payloads: the real attach plugin archive, and a bundle
# that only has to answer `pair`.
tar -czf "$tmp/plugin.tar.gz" -C "$repo_root/integrations" attach-plugin
cat > "$tmp/gateway.mjs" <<'BUNDLE'
import { existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pair') {
  const configAt = args.indexOf('--config');
  const config = configAt === -1 ? 'cozygateway.config.json' : args[configAt + 1];
  if (!existsSync(config)) process.exit(2);
  const configured = JSON.parse(readFileSync(config, 'utf8'));
  process.stdout.write('█▀▀▀▀▀█ fake-qr █▀▀▀▀▀█\n');
  process.stdout.write(JSON.stringify({ gatewayUrl: `http://${configured.host}:${configured.port}`, setupCode: 'TEST-CODE' }) + '\n');
}
BUNDLE
cp "$repo_root/scripts/gateway-supervisor.cjs" "$tmp/gateway-supervisor.cjs"

REMOTE_ORIGIN='https://warm.example.test'

# Four profiles attached to a remote gateway, exactly as the live machine had
# them: two carrying this installer's marker with a foreign URL, two carrying
# bare CozyGateway keys nobody claims.
make_rehome_root() {
  local root="$1" profile home
  mkdir -p "$root"
  printf 'model: test/model\ndisplay:\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming: true\nstreaming:\n  edit_interval: 0.05\n  buffer_threshold: 1\n' > "$root/config.yaml"
  printf 'absent\n' > "$root/gateway-default.state"
  for profile in cleo drowsy-lark night-owl polished-satellite; do
    home="$root/profiles/$profile"
    mkdir -p "$home"
    cp "$root/config.yaml" "$home/config.yaml"
    printf 'running\n' > "$root/gateway-$profile.state"
    case "$profile" in
      cleo|drowsy-lark)
        printf '%s\n' \
          'COZYGATEWAY_INSTALLER_OWNER=cozylabs-v1' \
          "COZYGATEWAY_URL=$REMOTE_ORIGIN" \
          'COZYGATEWAY_TOKEN=remote-token-for-the-old-gateway' \
          "COZYGATEWAY_SPOOL_PATH=$home/plugin-data/cozygateway/attach-v1.sqlite" \
          'COZYGATEWAY_HOME_CHANNEL=thread' \
          > "$home/.env"
        ;;
      *)
        printf '%s\n' \
          "COZYGATEWAY_URL=$REMOTE_ORIGIN" \
          'COZYGATEWAY_TOKEN=unowned-remote-token' \
          > "$home/.env"
        ;;
    esac
  done
}

run_installer() {
  local root="$1" gateway="$2" home="$3"; shift 3
  local qr_flag=(--no-qr)
  # One case has to reach the pairing finale; every other case keeps its output
  # free of pairing material.
  [ -z "${INSTALLER_QR:-}" ] || qr_flag=()
  HOME="$home" \
    PATH="$tmp/service-bin:$tmp/bin:$PATH" \
    COZYGATEWAY_TEST_HERMES_ROOT="$root" \
    COZYGATEWAY_TEST_COMMAND_LOG="${COMMAND_LOG:-$tmp/commands}" \
    COZYGATEWAY_TEST_REAL_NODE="$real_node" \
    COZYGATEWAY_TEST_REMOTE_ORIGIN="$REMOTE_ORIGIN" \
    COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" \
    COZYGATEWAY_NODE="$fake_node" \
    COZYGATEWAY_SERVICE_PLATFORM=Darwin \
    bash "$installer" ${qr_flag[@]+"${qr_flag[@]}"} --bundle "$tmp/gateway.mjs" \
      --plugin-archive "$tmp/plugin.tar.gz" --gateway-dir "$gateway" "$@" 2>&1
}

##############################################################################
# Gap 1: no supported re-home path.
##############################################################################

# Without the flag the refusals stay, and they now name the two supported ways
# out rather than only the one that keeps the old attachment.
make_rehome_root "$tmp/refusal-hermes"
COMMAND_LOG="$tmp/refusal-commands"
if refusal_output="$(run_installer "$tmp/refusal-hermes" "$tmp/refusal-gateway" "$tmp/refusal-home" --profiles cleo)"; then
  fail "an owned profile env targeting another Gateway must still fail closed:\n$refusal_output"
fi
expect_contains "$refusal_output" 'targets another Gateway'
expect_contains "$refusal_output" '--replace-gateway'
expect_contains "$refusal_output" '--runtime-only'
test ! -e "$tmp/refusal-gateway/local/install-state" || fail 'a refused run wrote installer state'
test "$(sed -n 's/^COZYGATEWAY_URL=//p' "$tmp/refusal-hermes/profiles/cleo/.env")" = "$REMOTE_ORIGIN" \
  || fail 'a refused run changed a profile env'

# The unowned-keys refusal says the same two things.
COMMAND_LOG="$tmp/refusal-unowned-commands"
if unowned_output="$(run_installer "$tmp/refusal-hermes" "$tmp/refusal-unowned-gateway" "$tmp/refusal-unowned-home" --profiles night-owl)"; then
  fail "an unowned profile env with Gateway keys must still fail closed:\n$unowned_output"
fi
expect_contains "$unowned_output" 'has an existing Gateway configuration'
expect_contains "$unowned_output" '--replace-gateway'
expect_contains "$unowned_output" '--runtime-only'

# With the flag, each selected profile's gateway is stopped, its plugin folder
# and its five CozyGateway env keys are backed up under the gateway dir, the
# keys are removed, and the run carries on to a healthy install.
make_rehome_root "$tmp/replace-hermes"
for profile in cleo drowsy-lark night-owl polished-satellite; do
  mkdir -p "$tmp/replace-hermes/profiles/$profile/plugins/cozygateway"
  printf 'name: cozygateway\n# an older install, with no ownership marker\n' \
    > "$tmp/replace-hermes/profiles/$profile/plugins/cozygateway/plugin.yaml"
done
COMMAND_LOG="$tmp/replace-commands"
if ! replace_output="$(run_installer "$tmp/replace-hermes" "$tmp/replace-gateway" "$tmp/replace-home" \
    --replace-gateway --profiles cleo,drowsy-lark,night-owl,polished-satellite)"; then
  fail "--replace-gateway must re-home the selected profiles:\n$replace_output"
fi
backup_stamp="$(ls "$tmp/replace-gateway/local/backups")"
test -n "$backup_stamp" || fail 'no backup directory was created'
for profile in cleo drowsy-lark night-owl polished-satellite; do
  backup="$tmp/replace-gateway/local/backups/$backup_stamp/profiles/$profile"
  test -f "$backup/env-keys" || fail "no env backup for profile $profile"
  grep -Fq "COZYGATEWAY_URL=$REMOTE_ORIGIN" "$backup/env-keys" || fail "env backup for $profile lost the old URL"
  test -f "$backup/plugins/cozygateway/plugin.yaml" || fail "no plugin backup for profile $profile"
  grep -Fq 'COZYGATEWAY_URL=http://127.0.0.1:8787' "$tmp/replace-hermes/profiles/$profile/.env" \
    || fail "profile $profile was not re-homed to the local gateway"
  grep -Fq 'installed by cozygateway agent-install.sh' \
    "$tmp/replace-hermes/profiles/$profile/plugins/cozygateway/.cozygateway-installer-owned" \
    || fail "profile $profile did not get an installer-owned plugin"
done
expect_contains "$replace_output" 'backed up'
expect_contains "$replace_output" 'CozyGateway listens on'

##############################################################################
# Gap 2: a running Hermes gateway rewrites its profile .env from memory.
##############################################################################

# Every profile gateway here rewrites its own .env back to the remote origin on
# any hermes invocation while it is running. The installer must stop the profile
# before writing, so the write survives the rest of the run.
make_rehome_root "$tmp/race-hermes"
COMMAND_LOG="$tmp/race-commands"
if ! race_output="$(COZYGATEWAY_TEST_PROVISIONER_PROFILES='cleo drowsy-lark night-owl polished-satellite' \
    run_installer "$tmp/race-hermes" "$tmp/race-gateway" "$tmp/race-home" \
    --replace-gateway --profiles cleo,drowsy-lark,night-owl,polished-satellite)"; then
  fail "a profile whose running gateway rewrites its env must still be re-homed:\n$race_output"
fi
for profile in cleo drowsy-lark night-owl polished-satellite; do
  test "$(sed -n 's/^COZYGATEWAY_URL=//p' "$tmp/race-hermes/profiles/$profile/.env")" = 'http://127.0.0.1:8787' \
    || fail "profile $profile kept the remote origin a running gateway rewrote"
done
grep -Fq 'cleo:gateway:stop' "$tmp/race-commands" || fail 'the profile gateway was not stopped before its env was written'

# A write that does not survive is a failure, not a silent partial install.
# The check itself is exercised directly: nothing else can make a write vanish
# between the write and the read back without racing this test.
extract_function() {
  awk -v marker="$1() {" '
    $0 == marker { capture = 1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$installer"
}
(
  set +e
  eval "$(extract_function env_get)"
  eval "$(extract_function profile_env_needs_rewrite)"
  eval "$(extract_function verify_profile_env)"
  ENV_OWNER_KEY=COZYGATEWAY_INSTALLER_OWNER
  ENV_OWNER_VALUE=cozylabs-v1
  NODE_RESOLVED="$real_node"
  DRY_RUN=0
  gateway_origin() { printf 'http://127.0.0.1:8787'; }
  die() { printf 'FAIL  %s\n' "$*" >&2; exit 9; }
  mkdir -p "$tmp/verify"
  printf 'COZYGATEWAY_INSTALLER_OWNER=cozylabs-v1\nCOZYGATEWAY_URL=http://127.0.0.1:8787\nCOZYGATEWAY_TOKEN=abc\nCOZYGATEWAY_SPOOL_PATH=/spool\nCOZYGATEWAY_HOME_CHANNEL=thread\n' > "$tmp/verify/.env"
  verify_profile_env cleo "$tmp/verify/.env" abc /spool >/dev/null 2>&1 || exit 1
  printf 'COZYGATEWAY_INSTALLER_OWNER=cozylabs-v1\nCOZYGATEWAY_URL=%s\nCOZYGATEWAY_TOKEN=abc\nCOZYGATEWAY_SPOOL_PATH=/spool\nCOZYGATEWAY_HOME_CHANNEL=thread\n' "$REMOTE_ORIGIN" > "$tmp/verify/.env"
  message="$(verify_profile_env cleo "$tmp/verify/.env" abc /spool 2>&1)"
  case "$message" in *'did not keep the CozyGateway keys'*) exit 0 ;; *) printf '%s\n' "$message" >&2; exit 2 ;; esac
) || fail 'an env write that did not survive must fail loudly'

##############################################################################
# Gap 3: an unowned plugin folder from an older install.
##############################################################################

# A folder whose plugin.yaml is byte-identical to the shipped archive's is this
# release's plugin without a marker. Adopt it rather than demanding a flag.
make_rehome_root "$tmp/adopt-hermes"
rm -f "$tmp/adopt-hermes/profiles/cleo/.env"
mkdir -p "$tmp/adopt-hermes/profiles/cleo/plugins"
cp -R "$repo_root/integrations/attach-plugin" "$tmp/adopt-hermes/profiles/cleo/plugins/cozygateway"
rm -f "$tmp/adopt-hermes/profiles/cleo/plugins/cozygateway/.cozygateway-installer-owned"
COMMAND_LOG="$tmp/adopt-commands"
if ! adopt_output="$(run_installer "$tmp/adopt-hermes" "$tmp/adopt-gateway" "$tmp/adopt-home" --profiles cleo)"; then
  fail "an unowned plugin matching the shipped archive must be adopted:\n$adopt_output"
fi
expect_contains "$adopt_output" 'adopted the existing attach plugin'
test -f "$tmp/adopt-hermes/profiles/cleo/plugins/cozygateway/.cozygateway-installer-owned" \
  || fail 'the adopted plugin did not get an ownership marker'

# A folder that is something else still fails closed, and says which flag
# re-homes it.
make_rehome_root "$tmp/foreign-plugin-hermes"
rm -f "$tmp/foreign-plugin-hermes/profiles/cleo/.env"
mkdir -p "$tmp/foreign-plugin-hermes/profiles/cleo/plugins/cozygateway"
printf 'name: something-else\n' > "$tmp/foreign-plugin-hermes/profiles/cleo/plugins/cozygateway/plugin.yaml"
COMMAND_LOG="$tmp/foreign-plugin-commands"
if foreign_plugin_output="$(run_installer "$tmp/foreign-plugin-hermes" "$tmp/foreign-plugin-gateway" \
    "$tmp/foreign-plugin-home" --profiles cleo)"; then
  fail "an unowned foreign plugin folder must fail closed:\n$foreign_plugin_output"
fi
expect_contains "$foreign_plugin_output" 'not owned by this installer'
expect_contains "$foreign_plugin_output" '--replace-gateway'

##############################################################################
# Gap 4: a foreign Dashboard on the port, refused with no evidence.
##############################################################################

# The supervisor's private fallback must ask Hermes for a SEPARATE server.
# Without --isolated, Hermes 0.21.3 routes `hermes dashboard --port N` to the
# existing machine-level server and the fallback never listens.
grep -Fq "'--isolated'" "$repo_root/scripts/gateway-supervisor.cjs" \
  || fail 'the supervisor fallback does not pass --isolated'
"$real_node" - "$repo_root/scripts/gateway-supervisor.cjs" <<'NODE' || fail 'the supervisor fallback launch is not the isolated one'
const { readFileSync } = require('node:fs');
const source = readFileSync(process.argv[2], 'utf8');
// The private fallback is always isolated; the preferred port is too, except under
// the Windows ownership proof, which treats an isolated Dashboard as foreign.
if (!/child = await start\(port, true\);/.test(source)) process.exit(1);
if (!/child = await start\(preferred, !options\.windowsDashboardProfile\);/.test(source)) process.exit(1);
NODE
# A supervisor that cannot start says why.
grep -Fq 'CozyGateway supervisor could not start: ' "$repo_root/scripts/gateway-supervisor.cjs" \
  || fail 'the supervisor still swallows the underlying error'

# The installer names the process holding the Dashboard port instead of only
# reporting that it refused one.
make_rehome_root "$tmp/foreign-dashboard-hermes"
rm -f "$tmp/foreign-dashboard-hermes/profiles/cleo/.env"
COMMAND_LOG="$tmp/foreign-dashboard-commands"
if ! foreign_dashboard_output="$(COZYGATEWAY_TEST_DASHBOARD_TOKEN_CODE=401 \
    COZYGATEWAY_TEST_DASHBOARD_OWNER_PID=31337 \
    COZYGATEWAY_TEST_DASHBOARD_OWNER_COMMAND='/opt/hermes/bin/hermes dashboard -p polished-satellite --port 9119' \
    run_installer "$tmp/foreign-dashboard-hermes" "$tmp/foreign-dashboard-gateway" "$tmp/foreign-dashboard-home" \
    --profiles cleo)"; then
  fail "a foreign Dashboard must be preserved, not fatal:\n$foreign_dashboard_output"
fi
expect_contains "$foreign_dashboard_output" 'preserving it and letting the CozyGateway supervisor provision a private loopback Dashboard'
expect_contains "$foreign_dashboard_output" 'pid 31337'
expect_contains "$foreign_dashboard_output" 'profile polished-satellite'
expect_contains "$foreign_dashboard_output" 'hermes dashboard -p polished-satellite --port 9119'

##############################################################################
# Gap 5: a session token pinned in the active profile env.
##############################################################################

# Hermes loads .env with override, so a token handed to it in the process
# environment loses to that line and every authenticated probe gets a 401.
# Adopt the pinned token as the Dashboard token instead, and say so.
make_rehome_root "$tmp/pinned-hermes"
rm -f "$tmp/pinned-hermes/profiles/cleo/.env"
printf 'HERMES_DASHBOARD_SESSION_TOKEN=pinned-token-0123456789abcdef\n' > "$tmp/pinned-hermes/profiles/cleo/.env"
COMMAND_LOG="$tmp/pinned-commands"
if ! pinned_output="$(COZYGATEWAY_TEST_ACTIVE_PROFILE=cleo run_installer "$tmp/pinned-hermes" \
    "$tmp/pinned-gateway" "$tmp/pinned-home" --profiles cleo)"; then
  fail "a pinned Dashboard session token must be adopted:\n$pinned_output"
fi
expect_contains "$pinned_output" 'adopted the Hermes Dashboard session token pinned in'
expect_contains "$pinned_output" 'loads .env with override'
grep -Fq 'DASHBOARD_SESSION_TOKEN=pinned-token-0123456789abcdef' "$tmp/pinned-gateway/local/dashboard.env" \
  || fail 'the adopted token did not reach the supervisor Dashboard environment'

# A pinned value this installer cannot put in an environment file unquoted is
# reported rather than silently ignored or unsafely written.
make_rehome_root "$tmp/pinned-unsafe-hermes"
rm -f "$tmp/pinned-unsafe-hermes/profiles/cleo/.env"
printf 'HERMES_DASHBOARD_SESSION_TOKEN="a token with spaces"\n' > "$tmp/pinned-unsafe-hermes/profiles/cleo/.env"
COMMAND_LOG="$tmp/pinned-unsafe-commands"
if ! pinned_unsafe_output="$(COZYGATEWAY_TEST_ACTIVE_PROFILE=cleo run_installer "$tmp/pinned-unsafe-hermes" \
    "$tmp/pinned-unsafe-gateway" "$tmp/pinned-unsafe-home" --profiles cleo)"; then
  fail "an unusable pinned token must not fail the install:\n$pinned_unsafe_output"
fi
expect_contains "$pinned_unsafe_output" 'pins HERMES_DASHBOARD_SESSION_TOKEN'
expect_absent "$pinned_unsafe_output" 'a token with spaces'

##############################################################################
# Gap 6: a running profile still attached to the old gateway from memory.
##############################################################################

# Three profiles were "already running with the current attach plugin and
# config", judged from files, while their processes were still serving the
# remote gateway. The log the plugin writes on every dial is the evidence.
make_rehome_root "$tmp/stale-attach-hermes"
for profile in cleo drowsy-lark; do
  home="$tmp/stale-attach-hermes/profiles/$profile"
  rm -f "$home/.env"
  mkdir -p "$home/logs"
  printf 'attach-v1: connected and writable at %s\n' "$REMOTE_ORIGIN" > "$home/logs/gateway.log"
done
# This one is already serving the local gateway and must not be interrupted.
home="$tmp/stale-attach-hermes/profiles/night-owl"
rm -f "$home/.env"
mkdir -p "$home/logs"
printf 'attach-v1: connected and writable at http://127.0.0.1:8787\n' > "$home/logs/gateway.log"
rm -f "$tmp/stale-attach-hermes/profiles/polished-satellite/.env"
# Give every profile an owned, current plugin so nothing restarts for a plugin
# change: the only reason to restart here is the live attach target.
for profile in cleo drowsy-lark night-owl polished-satellite; do
  home="$tmp/stale-attach-hermes/profiles/$profile"
  mkdir -p "$home/plugins"
  cp -R "$repo_root/integrations/attach-plugin" "$home/plugins/cozygateway"
  printf 'installed by cozygateway agent-install.sh\n' > "$home/plugins/cozygateway/.cozygateway-installer-owned"
done
COMMAND_LOG="$tmp/stale-attach-commands"
: > "$COMMAND_LOG"
if ! stale_attach_output="$(run_installer "$tmp/stale-attach-hermes" "$tmp/stale-attach-gateway" \
    "$tmp/stale-attach-home" --profiles cleo,drowsy-lark,night-owl,polished-satellite)"; then
  fail "a profile still attached elsewhere must be restarted, not skipped:\n$stale_attach_output"
fi
expect_contains "$stale_attach_output" "its live attach target was $REMOTE_ORIGIN"
grep -Fxq 'cleo:gateway:restart' "$COMMAND_LOG" || fail 'the stale cleo gateway was not restarted'
grep -Fxq 'drowsy-lark:gateway:restart' "$COMMAND_LOG" || fail 'the stale drowsy-lark gateway was not restarted'
grep -Fxq 'night-owl:gateway:restart' "$COMMAND_LOG" \
  && fail 'a profile already attached to this gateway was restarted anyway'
expect_contains "$stale_attach_output" 'Hermes gateway service for profile night-owl is already running'
# No log at all is no evidence, and never a reason to bounce a profile.
expect_contains "$stale_attach_output" 'Hermes gateway service for profile polished-satellite is already running'

# The readiness window has to outlast the plugin's backoff, whose steps reach
# 16 seconds before the 30-second cap.
grep -Fq 'for attempt in $(seq 1 45); do attach_ready && return; sleep 1; done' "$installer" \
  || fail 'the attach readiness window is still the 30-second one'

##############################################################################
# Gap 7: a rollback that leaves the failed run's processes holding the ports.
##############################################################################

# The installer records an identity-bound Dashboard child. Bootstrap recovery
# must stop that child without signalling its shell's process group.
(
  set +e
  eval "$(awk '
    $0 == "record_run_pid() {" { capture = 1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$installer")"
  eval "$(awk '
    $0 == "stop_recorded_run_processes() {" { capture = 1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$repo_root/scripts/install.sh")"
  HOME_DIR="$tmp/rollback-home"
  LOCAL_DIR="$HOME_DIR/local"
  RUN_PIDS_FILE="$LOCAL_DIR/run-pids"
  DRY_RUN=0
  mkdir -p "$LOCAL_DIR"
  sleep 300 &
  victim=$!
  record_run_pid dashboard "$victim"
  awk -F '\t' -v pid="$victim" '$1 == "dashboard" && $2 == pid && $3 ~ /^[0-9]+$/ && length($4) > 0 { found = 1 } END { exit found ? 0 : 1 }' "$RUN_PIDS_FILE" || exit 1
  printf 'legacy=not-a-pid\n' >> "$RUN_PIDS_FILE"
  report="$(stop_recorded_run_processes 2>&1)"
  case "$report" in *"stopped the dashboard process (pid $victim)"*) ;; *) printf '%s\n' "$report" >&2; exit 2 ;; esac
  [ -e "$HOME_DIR/local/run-pids" ] && exit 3
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$victim" 2>/dev/null || exit 0; sleep 0.2; done
  kill -KILL "$victim" 2>/dev/null
  exit 4
) || fail 'the recorded processes of a failed run were not stopped'
grep -Fq 'stop_recorded_run_processes; recover_bootstrap_transaction' "$repo_root/scripts/install.sh" \
  || fail 'the bootstrap rollback does not stop the failed run processes'

# A PID from a crashed run can be reused. Its stale identity must not signal the
# live foreign process that inherited the number.
(
  set +e
  eval "$(awk '
    $0 == "stop_recorded_run_processes() {" { capture = 1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$repo_root/scripts/install.sh")"
  HOME_DIR="$tmp/stale-pid-home"
  mkdir -p "$HOME_DIR/local"
  sleep 300 &
  survivor=$!
  survivor_pgid="$(ps -o pgid= -p "$survivor" | tr -d '[:space:]')"
  # A v0.8.6-pre-fix ledger had only a PID. Its row is no authority to stop a
  # currently live process, even if the number happens to match.
  printf 'dashboard=%s\n' "$survivor" > "$HOME_DIR/local/run-pids"
  stop_recorded_run_processes >/dev/null 2>&1
  kill -0 "$survivor" 2>/dev/null || exit 2
  printf 'dashboard\t%s\t%s\tstale-start-time\n' "$survivor" "$survivor_pgid" > "$HOME_DIR/local/run-pids"
  report="$(stop_recorded_run_processes 2>&1)"
  case "$report" in *"skipped stale dashboard process record for pid $survivor"*) ;; *) printf '%s\n' "$report" >&2; exit 3 ;; esac
  kill -0 "$survivor" 2>/dev/null || exit 4
  kill -TERM "$survivor" 2>/dev/null || exit 5
  exit 0
) || fail 'a stale PID record was allowed to signal a foreign process'

# A run records a detached Dashboard identity but never claims Hermes' own
# profile services. A finished run clears the ledger before a later rollback.
make_rehome_root "$tmp/pids-hermes"
rm -f "$tmp/pids-hermes/profiles/cleo/.env"
COMMAND_LOG="$tmp/pids-commands"
if ! pids_output="$(COZYGATEWAY_TEST_DASHBOARD_LAUNCH_MARKER="$tmp/dashboard-launched" \
    run_installer "$tmp/pids-hermes" "$tmp/pids-gateway" "$tmp/pids-home" --profiles cleo)"; then
  fail "the Dashboard-launching run failed:\n$pids_output"
fi
test -f "$tmp/dashboard-launched" || fail 'the run did not launch a Dashboard'
# A plain `dashboard --port N` is routed to a machine-level `hermes serve` on another
# port and never listens on N, so the installer's own launch must be isolated too.
grep -Fq -- '--isolated' "$tmp/dashboard-launched" || fail "the installer's Dashboard launch did not pass --isolated: $(cat "$tmp/dashboard-launched")"
grep -Fq 'record_run_pid dashboard "$dashboard_pid"' "$installer" || fail 'the launched Dashboard identity was not recorded'
if grep -Fq 'record_profile_gateway_pid' "$installer" || grep -Fq 'record_run_pid "gateway-' "$installer"; then
  fail 'the rollback ledger must not claim Hermes-owned profile gateways'
fi
test ! -e "$tmp/pids-gateway/local/run-pids" || fail 'a finished run left its process ledger behind'

##############################################################################
# Gap 8: `default` aliasing the active profile.
##############################################################################

# A profile gateway service runs `hermes gateway run`, which on a machine with
# an active_profile means THAT profile, not `default`. Selecting both installs a
# second gateway for the active profile and breaks its own service check.
make_rehome_root "$tmp/alias-hermes"
for profile in cleo drowsy-lark night-owl polished-satellite; do
  rm -f "$tmp/alias-hermes/profiles/$profile/.env"
done
COMMAND_LOG="$tmp/alias-commands"
: > "$COMMAND_LOG"
if ! alias_output="$(COZYGATEWAY_TEST_ACTIVE_PROFILE=cleo run_installer "$tmp/alias-hermes" \
    "$tmp/alias-gateway" "$tmp/alias-home" --profiles all)"; then
  fail "an install whose default profile aliases the active one failed:\n$alias_output"
fi
expect_contains "$alias_output" 'Profiles: cleo drowsy-lark night-owl polished-satellite'
expect_contains "$alias_output" "Hermes' active profile is cleo"
grep -q '^default:gateway:' "$COMMAND_LOG" && fail 'a gateway was installed for the aliased default profile'
grep -Fq 'COZYGATEWAY_URL=' "$tmp/alias-hermes/.env" 2>/dev/null \
  && fail 'the aliased default profile was configured anyway'

# With no active profile, or with the default profile itself active, `default`
# is an ordinary profile and stays selected.
make_rehome_root "$tmp/no-alias-hermes"
for profile in cleo drowsy-lark night-owl polished-satellite; do
  rm -f "$tmp/no-alias-hermes/profiles/$profile/.env"
done
COMMAND_LOG="$tmp/no-alias-commands"
: > "$COMMAND_LOG"
if ! no_alias_output="$(run_installer "$tmp/no-alias-hermes" "$tmp/no-alias-gateway" \
    "$tmp/no-alias-home" --profiles all)"; then
  fail "an install with no active profile failed:\n$no_alias_output"
fi
expect_contains "$no_alias_output" 'Profiles: default cleo drowsy-lark night-owl polished-satellite'
grep -Fxq 'default:gateway:install' "$COMMAND_LOG" || fail 'the default profile gateway was not installed'

# Every profile gateway command names its profile. A bare `hermes gateway ...`
# would be the active profile, whichever profile the installer meant.
"$real_node" - "$installer" <<'NODE' || fail 'a profile gateway command is missing -p'
const { readFileSync } = require('node:fs');
const source = readFileSync(process.argv[2], 'utf8');
for (const line of source.split('\n')) {
  if (!/HERMES_BIN"? gateway /.test(line)) continue;
  if (!/-p "\$profile"/.test(line)) { console.error(line); process.exit(1); }
}
NODE

##############################################################################
# The whole machine, in one run.
##############################################################################

# 2026-09-14, the owner's Mac: four profiles attached to a remote CozyGateway, a
# provisioner rewriting one of their envs, an unowned plugin folder from an
# older install, an active profile that `default` aliases, somebody else's
# Dashboard on 9119, and a session token pinned in the active profile's env.
# Seven runs of the installer were needed. This is the one run that has to work.
machine="$tmp/machine-hermes"
make_rehome_root "$machine"
# The active profile, with a pinned Dashboard session token beside its old keys.
printf 'HERMES_DASHBOARD_SESSION_TOKEN=pinned-session-token-abcdef01\n' >> "$machine/profiles/cleo/.env"
# An older install's plugin folder, with no ownership marker.
mkdir -p "$machine/profiles/night-owl/plugins/cozygateway"
printf 'name: cozygateway\n# from an install made before the ownership marker\n' \
  > "$machine/profiles/night-owl/plugins/cozygateway/plugin.yaml"
# One profile whose running gateway keeps rewriting its .env from memory.
COMMAND_LOG="$tmp/machine-commands"
: > "$COMMAND_LOG"
if ! machine_output="$(INSTALLER_QR=1 \
    COZYGATEWAY_TEST_ACTIVE_PROFILE=cleo \
    COZYGATEWAY_TEST_PROVISIONER_PROFILES='drowsy-lark' \
    COZYGATEWAY_TEST_DASHBOARD_TOKEN_CODE=401 \
    COZYGATEWAY_TEST_DASHBOARD_OWNER_PID=31337 \
    COZYGATEWAY_TEST_DASHBOARD_OWNER_COMMAND='/opt/hermes/bin/hermes dashboard -p cleo --port 9119' \
    run_installer "$machine" "$tmp/machine-gateway" "$tmp/machine-home" \
    --replace-gateway --profiles cleo,drowsy-lark,night-owl,polished-satellite)"; then
  fail "the whole-machine re-home run failed:"$'\n'"$machine_output"
fi
# It finishes on the pairing finale.
expect_contains "$machine_output" 'fake-qr'
expect_contains "$machine_output" '"setupCode":"TEST-CODE"'
expect_contains "$machine_output" '"gatewayUrl":"http://127.0.0.1:8787"'
# Every selected profile is attached here, with its old state kept.
machine_stamp="$(ls "$tmp/machine-gateway/local/backups")"
for profile in cleo drowsy-lark night-owl polished-satellite; do
  test "$(sed -n 's/^COZYGATEWAY_URL=//p' "$machine/profiles/$profile/.env")" = 'http://127.0.0.1:8787' \
    || fail "profile $profile is not attached to the local gateway"
  grep -Fq "COZYGATEWAY_URL=$REMOTE_ORIGIN" \
    "$tmp/machine-gateway/local/backups/$machine_stamp/profiles/$profile/env-keys" \
    || fail "profile $profile has no backup of its previous attachment"
done
test -f "$tmp/machine-gateway/local/backups/$machine_stamp/profiles/night-owl/plugins/cozygateway/plugin.yaml" \
  || fail 'the unowned plugin folder was not backed up'
grep -Fq 'from an install made before the ownership marker' \
  "$tmp/machine-gateway/local/backups/$machine_stamp/profiles/night-owl/plugins/cozygateway/plugin.yaml" \
  || fail 'the backed-up plugin folder is not the one that was there'
# The default profile aliases cleo and was never configured or started.
grep -q '^default:gateway:' "$COMMAND_LOG" && fail 'the aliased default profile got a gateway'
grep -Fq 'COZYGATEWAY_URL=' "$machine/.env" 2>/dev/null && fail 'the aliased default profile was configured'
# The pinned token became the Dashboard token, and the foreign Dashboard was
# preserved and named rather than fought over.
expect_contains "$machine_output" 'adopted the Hermes Dashboard session token pinned in'
grep -Fq 'DASHBOARD_SESSION_TOKEN=pinned-session-token-abcdef01' "$tmp/machine-gateway/local/dashboard.env" \
  || fail 'the pinned token did not reach the supervisor Dashboard environment'
expect_contains "$machine_output" 'pid 31337'
# The provisioner did rewrite an env during the run, and the run still ended
# with that profile attached here.
grep -Fq 'drowsy-lark:provisioner-rewrote-env' "$COMMAND_LOG" \
  || fail 'the provisioner fixture never ran, so this case proves nothing'
# A finished run leaves no process ledger for a later rollback to act on.
test ! -e "$tmp/machine-gateway/local/run-pids" || fail 'the finished run left a process ledger'

printf 'installer re-home tests passed\n'

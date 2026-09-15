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
rewrite_env() {
  local name="$1" home
  case " ${COZYGATEWAY_TEST_PROVISIONER_PROFILES:-} " in *" $name "*) ;; *) return 0 ;; esac
  [ "$(state "$name")" = running ] || return 0
  home="$(profile_home "$name")"
  [ -f "$home/.env" ] || return 0
  grep -v -E '^COZYGATEWAY_URL=' "$home/.env" > "$home/.env.provisioner" || true
  printf 'COZYGATEWAY_URL=%s\n' "${COZYGATEWAY_TEST_REMOTE_ORIGIN:-https://warm.example.test}" >> "$home/.env.provisioner"
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
if [ "$1" = dashboard ]; then exit 0; fi

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
      start) [ "$(state "$profile")" = stopped ] || exit 2; log_command "$profile:gateway:start"; set_state "$profile" running ;;
      restart) [ "$(state "$profile")" = running ] || exit 2; log_command "$profile:gateway:restart"; set_state "$profile" running ;;
      install) [ "$(state "$profile")" = absent ] || exit 2; log_command "$profile:gateway:install"; set_state "$profile" running ;;
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
case "$*" in
  *8787/health*)
    if [[ "$*" == *"-o /dev/null"* ]]; then printf '200'
    else printf '%s' "${COZYGATEWAY_TEST_ATTACH_HEALTH:-{\"attach\":{\"configured\":4,\"online\":4,\"deadLetters\":0}}}"; fi
    ;;
  *api/health*) printf '%s' "${COZYGATEWAY_TEST_DASHBOARD_HEALTH_CODE:-401}" ;;
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
  HOME="$home" \
    PATH="$tmp/service-bin:$tmp/bin:$PATH" \
    COZYGATEWAY_TEST_HERMES_ROOT="$root" \
    COZYGATEWAY_TEST_COMMAND_LOG="${COMMAND_LOG:-$tmp/commands}" \
    COZYGATEWAY_TEST_REAL_NODE="$real_node" \
    COZYGATEWAY_TEST_REMOTE_ORIGIN="$REMOTE_ORIGIN" \
    COZYGATEWAY_HERMES_BIN="$tmp/bin/hermes" \
    COZYGATEWAY_NODE="$fake_node" \
    COZYGATEWAY_SERVICE_PLATFORM=Darwin \
    bash "$installer" --no-qr --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/plugin.tar.gz" \
      --gateway-dir "$gateway" "$@" 2>&1
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
  eval "$(extract_function verify_profile_env)"
  NODE_RESOLVED="$real_node"
  DRY_RUN=0
  gateway_origin() { printf 'http://127.0.0.1:8787'; }
  die() { printf 'FAIL  %s\n' "$*" >&2; exit 9; }
  mkdir -p "$tmp/verify"
  printf 'COZYGATEWAY_URL=http://127.0.0.1:8787\nCOZYGATEWAY_TOKEN=abc\nCOZYGATEWAY_SPOOL_PATH=/spool\nCOZYGATEWAY_HOME_CHANNEL=thread\n' > "$tmp/verify/.env"
  verify_profile_env cleo "$tmp/verify/.env" abc /spool >/dev/null 2>&1 || exit 1
  printf 'COZYGATEWAY_URL=%s\nCOZYGATEWAY_TOKEN=abc\nCOZYGATEWAY_SPOOL_PATH=/spool\nCOZYGATEWAY_HOME_CHANNEL=thread\n' "$REMOTE_ORIGIN" > "$tmp/verify/.env"
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

printf 'installer re-home tests passed\n'

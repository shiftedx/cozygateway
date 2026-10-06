#!/usr/bin/env bash
# scripts/hermes-host.sh against scripted answers from Hermes' control verbs. The real snippets run;
# only gateway.control_socket is the stand-in in fixtures/hermes-control (see its docstring).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cozy-hermes-host-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

HERMES_HOME_ROOT="$TMP/hermes"
mkdir -p "$HERMES_HOME_ROOT/profiles/alpha"
PYTHON="$(command -v python3)"
HERMES_BIN=false
export PYTHONPATH="$ROOT/scripts/test/fixtures/hermes-control"
export COZY_TEST_CONTROL_LOG="$TMP/control.log"
# shellcheck source=../hermes-host.sh
. "$ROOT/scripts/hermes-host.sh"

# Each case starts from a clean log and fresh answer counters.
scripted() {
  rm -f "$COZY_TEST_CONTROL_LOG"
  export COZY_TEST_CONTROL_STATE="$TMP/state-$RANDOM$RANDOM"
  export COZY_TEST_CONTROL_ANSWERS="$1"
}
calls() { tr '\n' ';' < "$COZY_TEST_CONTROL_LOG"; }

# rescan-profiles: Hermes answers `pending` once its 5 s bound passes while an adapter still connects
# (gateway/run.py `_rescan_profiles_handler`: "not an error"). That is an answer, not a failure.
scripted '{"rescan-profiles": [{"multiplex": true, "pending": true, "served_profiles": ["default", "alpha"]}]}'
host_control rescan-profiles || fail 'a pending rescan was treated as a failure'
scripted '{"rescan-profiles": [{"multiplex": false, "served_profiles": ["default"]}]}'
if host_control rescan-profiles; then fail 'a standalone gateway answer was treated as a multiplexer rescan'; fi
scripted '{"rescan-profiles": [null]}'
if host_control rescan-profiles; then fail 'no answer was treated as a rescan'; fi

# reload-plugins for a home the host does not serve yet (run_plugin_rewire.py): rescan, then retry once.
scripted '{"reload-plugins": [{"reloaded": false, "error": "home is not served by this gateway"}, {"reloaded": true}]}'
host_control reload-plugins alpha || fail 'reload-plugins was not retried after a rescan'
[ "$(calls)" = "reload-plugins alpha env-scoped=0;rescan-profiles;reload-plugins alpha env-scoped=0;" ] \
  || fail "unexpected reload sequence: $(calls)"
scripted '{"reload-plugins": [{"reloaded": false, "error": "home is not served by this gateway"}]}'
if host_control reload-plugins alpha; then fail 'a second unserved answer was treated as a reload'; fi

# unserve-profile: only `unserved == name` (hermes_cli/gateway_profile_lifecycle.py `_confirmed`) or a
# profile the host does not serve is safe to delete. `pending` (a teardown still running past the
# verb's 5 s bound) is followed until the host's served set no longer lists the profile.
export HOST_UNSERVE_WAIT_SECONDS=3 HOST_UNSERVE_POLL_SECONDS=0.1
scripted '{"unserve-profile": [{"unserved": "alpha", "served_profiles": ["default"]}]}'
host_unserve alpha || fail 'a confirmed unserve was refused'
scripted '{"unserve-profile": [{"error": "profile '"'alpha'"' is not served"}]}'
host_unserve alpha || fail 'a profile the host does not serve was refused'
scripted '{"unserve-profile": [{"pending": true, "served_profiles": ["default", "alpha"]}], "rescan-profiles": [{"multiplex": true, "served_profiles": ["default", "alpha"]}, {"multiplex": true, "served_profiles": ["default"]}]}'
host_unserve alpha || fail 'a pending unserve that completed was refused'
[ "$(calls)" = "unserve-profile alpha dir-present=1;rescan-profiles;rescan-profiles;" ] || fail "unexpected unserve polling: $(calls)"
scripted '{"unserve-profile": [{"pending": true, "served_profiles": ["default", "alpha"]}], "rescan-profiles": [{"multiplex": true, "served_profiles": ["default", "alpha"]}]}'
rc=0; host_unserve alpha || rc=$?
[ "$rc" = 1 ] || fail "a profile still served after the wait must refuse the delete (rc=$rc)"
scripted '{"unserve-profile": [{"unserved": "beta"}]}'
rc=0; host_unserve alpha || rc=$?
[ "$rc" = 1 ] || fail "an unserve confirming another profile must refuse the delete (rc=$rc)"
scripted '{"unserve-profile": [{"error": "host multiplexer is not ready"}]}'
rc=0; host_unserve alpha || rc=$?
[ "$rc" = 1 ] || fail "an unserve error must refuse the delete (rc=$rc)"
scripted '{"unserve-profile": [null]}'
rc=0; host_unserve alpha || rc=$?
[ "$rc" = 4 ] || fail "no answer is its own outcome (rc=$rc)"

printf 'hermes host: ok\n'

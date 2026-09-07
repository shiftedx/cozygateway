#!/usr/bin/env bash
# F20: testbed/up.sh must cold-start the TB1 burner bed in dependency order --
# the gateway container, then the burner Hermes dashboard, then both burner
# Hermes profile gateways -- and only then gate on /ready. Gating on /ready
# before the dashboard and profile gateways exist can never pass on a cold
# bed, since /ready depends on the Hermes bridge those processes provide.
#
# Everything here is faked: no real docker, no real Hermes binary, no real
# network. See testbed/up.sh and
# .superpowers/sdd/2026-09-05-collaboration-roadmap/followons/F20-testbed-cold-start.md.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
testbed_dir="$repo_root/testbed"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-testbed-coldstart.XXXXXX")"
tmp="$(cd -P "$tmp" && pwd)"

expect_contains() {
  local haystack="$1" needle="$2"
  if ! grep -Fq -e "$needle" <<<"$haystack"; then
    printf 'FAIL  expected output to contain: %s\n--- actual output ---\n%s\n--- end ---\n' "$needle" "$haystack" >&2
    return 1
  fi
}
expect_missing() {
  local haystack="$1" needle="$2"
  if grep -Fq -e "$needle" <<<"$haystack"; then
    printf 'FAIL  expected output NOT to contain: %s\n--- actual output ---\n%s\n--- end ---\n' "$needle" "$haystack" >&2
    return 1
  fi
}

# The fake dashboard binds the real testbed dashboard port to prove up.sh's
# idempotent lsof check against a warm bed; refuse to clobber a real listener.
if lsof -nP -iTCP:9125 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "SKIP  port 9125 is already in use on this machine; cannot run this test safely" >&2
  exit 1
fi

export FAKE_STATE_DIR="$tmp/state"
mkdir -p "$FAKE_STATE_DIR" "$tmp/bin" \
  "$tmp/hermes-home/profiles/burnerhermesone" "$tmp/hermes-home/profiles/burnerhermestwo" \
  "$tmp/scratch/logs"

kill_fakes() { pkill -f "$tmp/fakehermes" 2>/dev/null || true; }
trap 'kill_fakes; rm -rf "$tmp"' EXIT
trap 'status=$?; [ "$status" -eq 0 ] || printf "FAIL  line %s exited %s: %s\n" "$LINENO" "$status" "$BASH_COMMAND" >&2' ERR

cat > "$tmp/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
STATE_DIR="$FAKE_STATE_DIR"
if [[ "${1:-}" == "compose" ]]; then
  shift
  for a in "$@"; do
    case "$a" in
      up) touch "$STATE_DIR/container_running"; exit 0 ;;
      down) rm -f "$STATE_DIR/container_running"; exit 0 ;;
      ps) [[ -f "$STATE_DIR/container_running" ]] && echo running || echo ""; exit 0 ;;
    esac
  done
fi
exit 0
DOCKER
chmod +x "$tmp/bin/docker"

cat > "$tmp/bin/curl" <<'CURL'
#!/usr/bin/env bash
STATE_DIR="$FAKE_STATE_DIR"
url="${@: -1}"
if [[ "$url" == *"/ready" ]]; then
  present=""
  for m in container_running dashboard_up profile_burnerhermesone_up profile_burnerhermestwo_up; do
    [[ -f "$STATE_DIR/$m" ]] && present="$present $m"
  done
  echo "ready-check markers:$present" >> "$STATE_DIR/curl-ready-calls.log"
  if [[ -f "$STATE_DIR/container_running" && -f "$STATE_DIR/dashboard_up" \
        && -f "$STATE_DIR/profile_burnerhermesone_up" && -f "$STATE_DIR/profile_burnerhermestwo_up" ]]; then
    echo '{"ready":true,"bridges":{"hermes":{"online":true}},"attach":{"configured":2,"online":2,"degraded":0,"absent":0}}'
    exit 0
  fi
  exit 22
fi
exit 22
CURL
chmod +x "$tmp/bin/curl"

cat > "$tmp/fakehermes" <<'HERMES'
#!/usr/bin/env bash
STATE_DIR="$FAKE_STATE_DIR"
cleanup() { jobs -p | xargs -r kill 2>/dev/null; }
trap cleanup EXIT TERM INT
if [[ "${1:-}" == "-p" ]]; then
  touch "$STATE_DIR/dashboard_up"
  python3 -c "
import socket, time
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('0.0.0.0', 9125))
s.listen(5)
time.sleep(600)
" &
  wait
elif [[ "${1:-}" == "--profile" ]]; then
  touch "$STATE_DIR/profile_${2}_up"
  sleep 600 &
  wait
fi
HERMES
chmod +x "$tmp/fakehermes"

export PATH="$tmp/bin:$PATH"
export TB1_SCRATCH="$tmp/scratch"
export TB1_HERMES_HOME="$tmp/hermes-home"
export TB1_HERMES_BIN="$tmp/fakehermes"
export TB1_LAN_IP="127.0.0.1"

# --- RED (was): a cold bed used to gate on /ready before the dashboard or the
# profile gateways existed, so it always exited 1 with "gateway never became
# ready" -- see F20-testbed-cold-start.md, quoting tb2-report.md defect 6.
# --- GREEN (now): the container-up gate runs first, then the dependencies
# start, then a SECOND /ready gate runs last.
#
# NOTE: up.sh's own output is captured to a FILE, never via `$(...)`.
# up.sh backgrounds `nohup ... &` inside a subshell; a background job like
# that keeps the write end of a `$(...)` command-substitution pipe open even
# after redirecting its own stdout/stderr to a log file, which hangs the
# substitution until the background job exits. Real invocations
# (`./up.sh` from a terminal) never hit this, only piping its output through
# a substitution does.
run_log="$tmp/up-run-1.log"
"$testbed_dir/up.sh" > "$run_log" 2>&1
out="$(cat "$run_log")"
echo "$out"
expect_contains "$out" "burner gateway (docker"
expect_contains "$out" "burner Hermes dashboard"
expect_contains "$out" "burner Hermes profile gateways"
expect_contains "$out" "gating on /ready"
expect_missing "$out" "gateway never became ready"

[ -f "$FAKE_STATE_DIR/curl-ready-calls.log" ] || { echo "FAIL  /ready was never checked" >&2; exit 1; }
while IFS= read -r line; do
  expect_contains "$line" "container_running"
  expect_contains "$line" "dashboard_up"
  expect_contains "$line" "profile_burnerhermesone_up"
  expect_contains "$line" "profile_burnerhermestwo_up"
done < "$FAKE_STATE_DIR/curl-ready-calls.log"

[ -f "$FAKE_STATE_DIR/container_running" ] || { echo "FAIL  container never came up" >&2; exit 1; }
[ -f "$FAKE_STATE_DIR/dashboard_up" ] || { echo "FAIL  dashboard never came up" >&2; exit 1; }
[ -f "$FAKE_STATE_DIR/profile_burnerhermesone_up" ] || { echo "FAIL  profile one never came up" >&2; exit 1; }
[ -f "$FAKE_STATE_DIR/profile_burnerhermestwo_up" ] || { echo "FAIL  profile two never came up" >&2; exit 1; }
echo "PASS  cold start: up.sh brought the bed up in dependency order, every /ready check saw every dependency already up, and it still gated on /ready last"

# --- RED / GREEN: a warm bed (everything already running) stays idempotent. ---
before_dashboard_pid="$(pgrep -f -- "$tmp/fakehermes -p default dashboard" | head -1)"
before_profile_pids="$(pgrep -f -- "$tmp/fakehermes --profile" | sort | tr '\n' ' ')"
run_log2="$tmp/up-run-2.log"
"$testbed_dir/up.sh" > "$run_log2" 2>&1
out2="$(cat "$run_log2")"
echo "$out2"
after_dashboard_pid="$(pgrep -f -- "$tmp/fakehermes -p default dashboard" | head -1)"
after_profile_pids="$(pgrep -f -- "$tmp/fakehermes --profile" | sort | tr '\n' ' ')"
[ -n "$before_dashboard_pid" ] || { echo "FAIL  no dashboard pid recorded before the warm run" >&2; exit 1; }
[ "$before_dashboard_pid" = "$after_dashboard_pid" ] || { echo "FAIL  warm run restarted the dashboard" >&2; exit 1; }
[ "$before_profile_pids" = "$after_profile_pids" ] || { echo "FAIL  warm run restarted a profile gateway" >&2; exit 1; }
expect_missing "$out2" "gateway never became ready"
echo "PASS  warm start: up.sh is an idempotent no-op and still exits 0"

kill_fakes
echo "ALL PASS"

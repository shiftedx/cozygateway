#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
agent_installer="${AGENT_INSTALLER_UNDER_TEST:-$repo_root/scripts/agent-install.sh}"
health_block="$(awk '
  /^attach_health\(\) \{/ { capture=1; saw_health=1 }
  /^attach_ready\(\) \{/ && !saw_health { capture=1 }
  /^install_service\(\) \{/ { exit }
  capture { print }
' "$agent_installer")"
eval "$health_block"

NODE_RESOLVED="$(command -v node)"
DRY_RUN=0
gateway_origin() { printf 'http://127.0.0.1:8787'; }
curl() {
  if [ -n "${HEALTH_COUNTER_FILE:-}" ]; then
    local count
    count="$(<"$HEALTH_COUNTER_FILE")"
    printf '%s\n' "$((count + 1))" > "$HEALTH_COUNTER_FILE"
    if [ "$count" -gt 0 ]; then printf '%s' '{"attach":{"configured":2,"online":2,"deadLetters":0}}'; return; fi
  fi
  printf '%s' "$HEALTH_JSON"
}
seq() { printf '1\n'; }
sleep() { :; }
die() { printf 'FAIL  %s\n' "$*" >&2; return 1; }

assert_diagnosis() {
  HEALTH_JSON="$1"
  local expected="$2" output
  output="$(wait_attach_ready 2>&1 || true)"
  if ! grep -Fq "$expected" <<<"$output"; then
    printf '%s\n' "$output" >&2
    return 1
  fi
  if grep -Fq 'configured must be positive, online must equal configured, and dead letters must be zero' <<<"$output"; then
    echo 'attach health returned the opaque combined error' >&2
    exit 1
  fi
}

assert_diagnosis '{"attach":{"configured":2,"online":1,"deadLetters":0,"profiles":["must-not-leak"]}}' 'Hermes attach profile count mismatch (configured=2, online=1, deadLetters=0)'
if HEALTH_JSON='{"attach":{"configured":2,"online":1,"deadLetters":0,"profiles":["must-not-leak"]}}' wait_attach_ready 2>&1 | grep -Fq 'must-not-leak'; then
  echo 'attach health diagnosis exposed a non-aggregate field' >&2
  exit 1
fi
assert_diagnosis '{"attach":{"configured":0,"online":0,"deadLetters":0}}' 'Hermes attach has no configured profiles (configured=0, online=0, deadLetters=0)'
assert_diagnosis '{"attach":{"configured":1,"online":1,"deadLetters":3}}' 'Hermes attach retained dead letters (configured=1, online=1, deadLetters=3)'
assert_diagnosis '{"attach":{"configured":1.5,"online":1.5,"deadLetters":0}}' 'Hermes attach health could not be read'
assert_diagnosis 'not-json' 'Hermes attach health could not be read'
late_counter="${TMPDIR:-/tmp}/cozygateway-attach-health-counter.$$"
printf '0\n' > "$late_counter"
trap 'rm -f "$late_counter"' EXIT
if ! late_output="$(HEALTH_JSON='{"attach":{"configured":2,"online":1,"deadLetters":0}}' HEALTH_COUNTER_FILE="$late_counter" wait_attach_ready 2>&1)"; then
  printf '%s\n' "$late_output" >&2
  echo 'a final healthy attach snapshot must satisfy readiness' >&2
  exit 1
fi
printf 'attach health diagnosis tests passed\n'

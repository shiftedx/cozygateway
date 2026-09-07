#!/usr/bin/env bash
# F20 fix round 1 (Critical) + round 2 (the round-1 fix was itself a no-op):
# the burner CozyAgents runner kill/idempotency check must be anchored to
# $TB1_SCRATCH (or another burner-only marker), never a bare relative path
# fragment like `cozyagents-bin/cozyagents.mjs`. That fragment is just this
# packet's own bundling convention (see testbed/README.md's "the single-file
# bundle copied from the CozyAgents checkout"), and nothing stops a
# production runner bundled the same way elsewhere on the machine from
# carrying the exact same fragment.
#
# Round 1 anchored the match through a sed-based ERE escaper
# (`tb1_ere_escape`) whose bracket class was malformed and escaped NOTHING,
# so a scratch root containing a regex metacharacter (".", "+", etc.) broke
# the anchor silently. Round 2 replaces the whole mechanism: env.sh now
# prefers the pid file up.sh itself wrote (tb1_runner_pid_from_file) as the
# PRIMARY source of truth, and verifies/sweeps with a PLAIN BASH GLOB
# comparison (tb1_runner_cmd_matches, `case "$cmd" in *"$TB1_SCRATCH"/...*
# )`) -- never a regex -- so nothing in $TB1_SCRATCH needs escaping no matter
# what characters it contains.
#
# This test plants a look-alike runner process OUTSIDE the scratch root and
# proves down.sh leaves it alone, and a real one INSIDE the scratch root
# (with the pid file up.sh would have written) and proves down.sh still
# kills it -- the anchor must narrow the match, not just remove it -- and
# runs the whole thing three times: a plain scratch root, one containing a
# "+" (the exact character that broke round 1), and one containing a space.
set -uo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
testbed_dir="$repo_root/testbed"

command -v node >/dev/null 2>&1 || { echo "SKIP  node not on PATH" >&2; exit 1; }

overall_status=0

run_case() {
  local case_name="$1" scratch_leaf="$2"
  local tmp lookalike_pid="" real_pid=""

  cleanup() {
    [ -n "$lookalike_pid" ] && { kill "$lookalike_pid" 2>/dev/null || true; }
    [ -n "$real_pid" ] && { kill "$real_pid" 2>/dev/null || true; }
    [ -n "${tmp:-}" ] && rm -rf "$tmp"
  }
  trap cleanup RETURN

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-runner-kill-scope.XXXXXX")" || return 1
  tmp="$(cd -P "$tmp" && pwd)" || return 1

  local scratch="$tmp/$scratch_leaf"
  mkdir -p "$tmp/bin" "$scratch/gateway/config" "$scratch/gateway/secrets" "$scratch/logs" \
    "$tmp/hermes-home/profiles" "$tmp/production-lookalike/cozyagents-bin" "$scratch/cozyagents-bin" \
    || return 1

  cat > "$tmp/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
exit 0
DOCKER
  chmod +x "$tmp/bin/docker"

  : > "$scratch/gateway/secrets/cozygateway.env"

  export PATH="$tmp/bin:$PATH"
  export TB1_SCRATCH="$scratch"
  export TB1_HERMES_HOME="$tmp/hermes-home"
  export TB1_HERMES_BIN="$tmp/bin/does-not-exist-hermes"
  export TB1_LAN_IP="127.0.0.1"

  # A look-alike PRODUCTION-style runner, bundled the exact same way
  # (`cozyagents-bin/cozyagents.mjs`), living entirely OUTSIDE $TB1_SCRATCH.
  cat > "$tmp/production-lookalike/cozyagents-bin/cozyagents.mjs" <<'EOF'
setInterval(() => {}, 1000);
EOF
  node "$tmp/production-lookalike/cozyagents-bin/cozyagents.mjs" runner &
  lookalike_pid=$!
  sleep 1
  kill -0 "$lookalike_pid" 2>/dev/null || {
    echo "FAIL  [$case_name] could not start the look-alike process" >&2
    return 1
  }

  # The REAL burner runner, bundled the same way, INSIDE $TB1_SCRATCH, with
  # the pid file up.sh itself would have written -- exercising the PRIMARY
  # (pid-file) lookup, not just the anchored sweep.
  cat > "$scratch/cozyagents-bin/cozyagents.mjs" <<'EOF'
setInterval(() => {}, 1000);
EOF
  node "$scratch/cozyagents-bin/cozyagents.mjs" runner &
  real_pid=$!
  echo "$real_pid" > "$scratch/burner-runner.pid"
  sleep 1
  kill -0 "$real_pid" 2>/dev/null || {
    echo "FAIL  [$case_name] could not start the real burner runner" >&2
    return 1
  }

  "$testbed_dir/down.sh" > "$tmp/down.log" 2>&1
  sed "s/^/  [$case_name] /" "$tmp/down.log"

  sleep 1
  if ! kill -0 "$lookalike_pid" 2>/dev/null; then
    echo "FAIL  [$case_name] down.sh killed a look-alike process OUTSIDE \$TB1_SCRATCH -- the runner match is not anchored" >&2
    return 1
  fi
  echo "PASS  [$case_name] down.sh left the outside-scratch look-alike process alone"

  if kill -0 "$real_pid" 2>/dev/null; then
    echo "FAIL  [$case_name] down.sh left the REAL burner runner (inside \$TB1_SCRATCH) running" >&2
    return 1
  fi
  echo "PASS  [$case_name] down.sh still kills the real burner runner inside \$TB1_SCRATCH"
  return 0
}

run_case "plain scratch root" "scratch" || overall_status=1
run_case "scratch root containing a plus (the exact char that broke round 1's sed escaper)" "scr+atch" || overall_status=1
run_case "scratch root containing a space" "scr atch" || overall_status=1

if [ "$overall_status" -eq 0 ]; then
  echo "ALL PASS"
else
  echo "FAIL  one or more cases failed" >&2
fi
exit "$overall_status"

#!/usr/bin/env bash
# F20 fix round 1 (Critical): the burner CozyAgents runner kill/idempotency
# pattern must be anchored to $TB1_SCRATCH (or another burner-only marker),
# never a bare relative path fragment like `cozyagents-bin/cozyagents.mjs`.
# That fragment is just this packet's own bundling convention (see
# testbed/README.md's "the single-file bundle copied from the CozyAgents
# checkout"), and nothing stops a production runner bundled the same way
# elsewhere on the machine from carrying the exact same fragment.
#
# This test plants a look-alike runner process OUTSIDE the scratch root and
# proves down.sh leaves it alone, and a real one INSIDE the scratch root and
# proves down.sh still kills it -- the anchor must narrow the match, not just
# remove it.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
testbed_dir="$repo_root/testbed"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-runner-kill-scope.XXXXXX")"
tmp="$(cd -P "$tmp" && pwd)"

command -v node >/dev/null 2>&1 || { echo "SKIP  node not on PATH" >&2; exit 1; }

lookalike_pid=""
real_pid=""
cleanup() {
  [ -n "$lookalike_pid" ] && { kill "$lookalike_pid" 2>/dev/null || true; }
  [ -n "$real_pid" ] && { kill "$real_pid" 2>/dev/null || true; }
  rm -rf "$tmp"
  return 0
}
trap cleanup EXIT
trap 'status=$?; [ "$status" -eq 0 ] || printf "FAIL  line %s exited %s: %s\n" "$LINENO" "$status" "$BASH_COMMAND" >&2' ERR

mkdir -p "$tmp/bin" "$tmp/scratch/gateway/config" "$tmp/scratch/gateway/secrets" "$tmp/scratch/logs" \
  "$tmp/hermes-home/profiles" "$tmp/production-lookalike/cozyagents-bin" "$tmp/scratch/cozyagents-bin"

cat > "$tmp/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
exit 0
DOCKER
chmod +x "$tmp/bin/docker"

: > "$tmp/scratch/gateway/secrets/cozygateway.env"

export PATH="$tmp/bin:$PATH"
export TB1_SCRATCH="$tmp/scratch"
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
kill -0 "$lookalike_pid" 2>/dev/null || { echo "FAIL  could not start the look-alike process" >&2; exit 1; }

# The REAL burner runner, bundled the same way, INSIDE $TB1_SCRATCH.
cat > "$tmp/scratch/cozyagents-bin/cozyagents.mjs" <<'EOF'
setInterval(() => {}, 1000);
EOF
node "$tmp/scratch/cozyagents-bin/cozyagents.mjs" runner &
real_pid=$!
sleep 1
kill -0 "$real_pid" 2>/dev/null || { echo "FAIL  could not start the real burner runner" >&2; exit 1; }

"$testbed_dir/down.sh" > "$tmp/down.log" 2>&1 || true
cat "$tmp/down.log"

sleep 1
if ! kill -0 "$lookalike_pid" 2>/dev/null; then
  echo "FAIL  down.sh killed a look-alike process OUTSIDE \$TB1_SCRATCH -- the runner pattern is not anchored" >&2
  exit 1
fi
echo "PASS  down.sh left the outside-scratch look-alike process alone"

if kill -0 "$real_pid" 2>/dev/null; then
  echo "FAIL  down.sh left the REAL burner runner (inside \$TB1_SCRATCH) running" >&2
  exit 1
fi
echo "PASS  down.sh still kills the real burner runner inside \$TB1_SCRATCH"

echo "ALL PASS"

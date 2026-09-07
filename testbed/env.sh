#!/usr/bin/env bash
# TB1 burner test bed: shared settings. Source this, never commit a token.
# SCRATCH holds every secret and all disposable state. Override it if your
# scratch directory differs; nothing under it belongs in the repo.
: "${TB1_SCRATCH:?set TB1_SCRATCH to the scratch directory holding tokens/ and gateway/}"

export TB1_LAN_IP="${TB1_LAN_IP:-$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1)}"
export TB1_GATEWAY_PORT=8795
export TB1_DASHBOARD_PORT=9125
export TB1_GATEWAY="http://${TB1_LAN_IP}:${TB1_GATEWAY_PORT}"

export TB1_HERMES_HOME="${TB1_HERMES_HOME:-$HOME/.hermes-burner}"
export TB1_HERMES_BIN="${TB1_HERMES_BIN:-$HOME/.local/bin/hermes}"
export TB1_PROFILES="burnerhermesone burnerhermestwo"
export TB1_CA_BOTS="burner-ca-one burner-ca-two"

export COZYGATEWAY_SECRETS_FILE="$TB1_SCRATCH/gateway/secrets/cozygateway.env"
export COZYGATEWAY_CONFIG_DIR="$TB1_SCRATCH/gateway/config"
export TB1_COMPOSE_PROJECT=burner-tb1
TB1_TESTBED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TB1_COMPOSE_FILE="$TB1_TESTBED_DIR/docker-compose.burner.yml"

# The device token minted by `POST /pair`, kept only in the scratch directory.
tb1_device_token() {
  python3 -c "import json;print(json.load(open('$TB1_SCRATCH/tokens/validation-device.json'))['deviceToken'])"
}

# True (exit 0) if a process's own command line ($1, from `ps -o command=`)
# really does invoke THIS bed's runner bundle: contains the literal, absolute
# path "$TB1_SCRATCH/cozyagents-bin/cozyagents.mjs" as a substring (the
# command is typically "node <that path> runner" or "... serve ...", so it is
# never a PREFIX of the command line -- the interpreter comes first). The
# comparison is a PLAIN BASH GLOB, never a regex: quoting $TB1_SCRATCH inside
# the pattern forces every character in it to compare literally, so a
# scratch root containing a space, ".", "+", "[", "]", "(", ")", "$", etc.
# all still match correctly with no escaping at all.
tb1_runner_cmd_matches() {
  case "$1" in
    *"$TB1_SCRATCH"/cozyagents-bin/cozyagents.mjs*) return 0 ;;
  esac
  return 1
}

# The burner CozyAgents runner's PID, from the file up.sh itself wrote --
# THE PRIMARY source of truth, not a pattern match. Verified live (`kill -0`)
# and re-checked against its own command line (see tb1_runner_cmd_matches)
# before being trusted. Prints the pid and returns 0 on success; prints
# nothing and returns 1 otherwise.
tb1_runner_pid_from_file() {
  local pidfile="$TB1_SCRATCH/burner-runner.pid" pid cmd
  [ -f "$pidfile" ] || return 1
  pid="$(cat "$pidfile" 2>/dev/null)" || return 1
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps -p "$pid" -o command= 2>/dev/null)" || return 1
  tb1_runner_cmd_matches "$cmd" || return 1
  printf '%s\n' "$pid"
}

# PIDs of the burner CozyAgents runner AND its bot children, anchored to the
# absolute $TB1_SCRATCH path. This is a VERIFICATION sweep, not the primary
# lookup (see tb1_runner_pid_from_file): `pgrep -f cozyagents.mjs` is a
# deliberately broad, over-matching prefilter (it cannot miss a true
# positive, since every real candidate really does contain that literal
# substring), and every candidate it returns is then checked with the same
# plain bash glob comparison (tb1_runner_cmd_matches) -- never a regex, so
# nothing in $TB1_SCRATCH needs escaping. `cozyagents-bin/cozyagents.mjs`
# alone is just this packet's own bundling convention (see README.md), not a
# burner-only marker, so an unanchored match could also hit a production
# runner bundled the same way elsewhere on the machine -- anchoring to
# $TB1_SCRATCH is what keeps this scoped to processes this bed itself
# started.
tb1_runner_pids() {
  local pid cmd
  for pid in $(pgrep -f "cozyagents.mjs" 2>/dev/null); do
    cmd="$(ps -p "$pid" -o command= 2>/dev/null)" || continue
    tb1_runner_cmd_matches "$cmd" && printf '%s\n' "$pid"
  done
}

# True (exit 0) if the burner CozyAgents runner is up, checking the pid file
# first and the anchored sweep second.
tb1_runner_running() {
  tb1_runner_pid_from_file >/dev/null && return 0
  [ -n "$(tb1_runner_pids)" ]
}

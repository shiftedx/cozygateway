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

# Escape ERE metacharacters so a path can be dropped into a `pgrep -f`/`grep -E`
# pattern literally. $TB1_SCRATCH is a filesystem path, not a regex, and may
# contain characters (".", "+", etc.) that would otherwise change what matches.
tb1_ere_escape() {
  printf '%s' "$1" | sed 's/[.^$*+?()[\]{}|\\]/\\&/g'
}

# PIDs of the burner CozyAgents runner AND its bot children, anchored to the
# absolute $TB1_SCRATCH path. `cozyagents-bin/cozyagents.mjs` alone is just
# this packet's own bundling convention (see README.md); it is NOT a
# burner-only marker, so matching on it unanchored could also match a
# production runner bundled the same way elsewhere on the machine. Anchoring
# to $TB1_SCRATCH keeps this scoped to processes this bed itself started,
# the same discipline down.sh already applies to the Hermes gateway patterns.
tb1_runner_pids() {
  local anchor
  anchor="$(tb1_ere_escape "$TB1_SCRATCH")"
  pgrep -f -- "${anchor}/cozyagents-bin/cozyagents\.mjs" 2>/dev/null
}

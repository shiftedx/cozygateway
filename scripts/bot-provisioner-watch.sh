#!/usr/bin/env bash
# One sweep of the bot provisioner. Meant to be run on a launchd interval, so
# a bot created from the phone becomes chattable without anyone at a terminal.
#
# WHAT IT LOOKS FOR
#   A Hermes profile that has OPTED IN (its config.yaml lists cozygateway in
#   plugins.enabled, which the gateway's create-time seed writes) but is not
#   yet WIRED: no synced plugin dir, or a .env still holding the launch
#   profile's inherited attach settings rather than its own, or no launchd
#   gateway service. Any one of those is enough, because all three have to be
#   true before a turn can reach the phone.
#
#   Everything else is left alone. A profile that is fully wired is not
#   re-provisioned, which is what keeps the six live bots' tokens and services
#   untouched by a sweep that runs every 30 seconds.
#
# WHY A SWEEP AND NOT A HOOK
#   The create happens inside the gateway container on the box; the wiring has
#   to happen on this Mac, where Hermes and launchd live. There is no channel
#   from one to the other that survives a reboot, and a sweep over real state
#   is repairable in a way a missed event is not: if a run dies halfway, the
#   next one finishes the job rather than leaving a half-provisioned bot.
#
# CONCURRENCY
#   A flock guard means a slow sweep (the provisioner waits up to 90s for the
#   attach hello) never overlaps the next tick.
#
# INSTALLATION
#   launchd must execute this from the self-contained staged payload installed
#   by install-bot-provisioner.sh. A checkout under ~/Documents is readable in
#   Terminal but denied to background LaunchAgents by macOS TCC.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVISION="$SCRIPT_DIR/provision-bot.sh"

HERMES_HOME_ROOT="${HERMES_HOME_ROOT:-$HOME/.hermes}"
LOG_FILE="${COZY_PROVISIONER_LOG:-$HOME/Library/Logs/cozylabs-bot-provisioner.log}"
LOCK_FILE="${COZY_PROVISIONER_LOCK:-${TMPDIR:-/tmp}/cozylabs-bot-provisioner.lock}"
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1; shift ;;
    --hermes-home) HERMES_HOME_ROOT="$2"; shift 2 ;;
    --log) LOG_FILE="$2"; shift 2 ;;
    -h|--help)
      cat <<USAGE
usage: bot-provisioner-watch.sh [-n|--dry-run] [--hermes-home DIR] [--log FILE]

One sweep: provision every opted-in but unwired Hermes profile.
Log: $LOG_FILE
USAGE
      exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$LOG_FILE")"
log() { printf '%s  %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG_FILE"; }

# Serialize sweeps. Without flock (a bare macOS box has none) fall back to an
# mkdir lock, which is atomic everywhere and good enough for one writer.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || { log "sweep skipped: another sweep still running"; exit 0; }
else
  if ! mkdir "$LOCK_FILE.d" 2>/dev/null; then
    log "sweep skipped: another sweep still running"
    exit 0
  fi
  trap 'rmdir "$LOCK_FILE.d" 2>/dev/null || true' EXIT
fi

PYTHON="$HERMES_HOME_ROOT/hermes-agent/venv/bin/python"
[ -x "$PYTHON" ] || PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || { log "sweep aborted: no python3"; exit 1; }

# Opted in: config.yaml lists the plugin. Structural, not a grep, because the
# bare name appears in the disabled list too.
opted_in() {
  "$PYTHON" - "$1" <<'PY'
import sys
try:
    import yaml
except ImportError:
    sys.exit(2)
from pathlib import Path
path = Path(sys.argv[1]) / "config.yaml"
if not path.exists():
    sys.exit(1)
try:
    data = yaml.safe_load(path.read_text()) or {}
except Exception:
    sys.exit(1)
sys.exit(0 if "cozygateway" in ((data.get("plugins") or {}).get("enabled") or []) else 1)
PY
}

# Wired: all three halves present. Reported as a reason string so the log says
# WHY a profile was picked up, which is the first question at 3am.
missing_reason() {
  local dir="$1" profile="$2"
  [ -d "$dir/plugins/cozygateway" ] || { printf 'no synced plugin dir'; return 0; }
  # NOT a bare test for COZYGATEWAY_TOKEN: a fresh profile arrives with a COPY
  # of the launch profile's .env, token included, so its presence proves
  # nothing. A spool path pointing INTO this profile's own directory is the
  # marker only the provisioner writes, and the inherited value (the global
  # ~/.hermes/plugin-data/... path) fails it.
  grep -q "^COZYGATEWAY_SPOOL_PATH=$dir/" "$dir/.env" 2>/dev/null \
    || { printf 'env not scoped to this profile'; return 0; }
  launchctl print "gui/$(id -u)/ai.hermes.gateway-$profile" >/dev/null 2>&1 \
    || { printf 'no launchd gateway service'; return 0; }
  return 1
}

# ── Deprovision sweep ────────────────────────────────────────────────────────
# A launchd gateway service whose Hermes profile no longer exists is the residue
# of a deleted bot. `DELETE /bots/:name` removes the profile and purges the
# gateway's own state, but it runs in a container and cannot reach this Mac's
# launchd, the box config, or the box .env. That residue used to be REPORTED to
# whoever pressed Delete, which put an operator's chore in front of a person who
# just wanted the bot gone (Kyle, 2026-08-26). This sweep does it instead.
#
# The profile directory being absent is the whole test, and it is a safe one: a
# live bot always has its directory, and Hermes deletes that directory itself as
# the last step of a profile delete.
DEPROVISION="$SCRIPT_DIR/deprovision-bot.sh"
orphans=()
if [ -x "$DEPROVISION" ]; then
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    profile="${label#ai.hermes.gateway-}"
    [ "$profile" != "$label" ] || continue
    [ -d "$HERMES_HOME_ROOT/profiles/$profile" ] && continue
    orphans+=("$profile")
    log "orphaned: $profile (launchd service with no profile directory)"
  done <<ORPHANS
$(launchctl list 2>/dev/null | awk '{ print $3 }' | grep '^ai\.hermes\.gateway-' || true)
ORPHANS
fi

if [ "${#orphans[@]}" -gt 0 ]; then
  for profile in ${orphans[@]+"${orphans[@]}"}; do
    dargs=()
    [ "$DRY_RUN" = 1 ] && dargs+=(--dry-run)
    if "$DEPROVISION" ${dargs[@]+"${dargs[@]}"} "$profile" >> "$LOG_FILE" 2>&1; then
      log "deprovisioned: $profile"
    else
      log "deprovision FAILED for $profile (see the output above)"
    fi
  done
fi

pending=()
for dir in "$HERMES_HOME_ROOT"/profiles/*/; do
  [ -d "$dir" ] || continue
  profile="$(basename "$dir")"
  rc=0
  opted_in "${dir%/}" || rc=$?
  if [ "$rc" = 2 ]; then log "sweep aborted: no PyYAML available to $PYTHON"; exit 1; fi
  [ "$rc" = 0 ] || continue
  if reason="$(missing_reason "${dir%/}" "$profile")"; then
    pending+=("$profile")
    log "pending: $profile ($reason)"
  fi
done

if [ "${#pending[@]}" -eq 0 ]; then
  # Deliberately quiet: this is the steady state and it runs every 30 seconds.
  exit 0
fi

log "provisioning: ${pending[*]}"
args=()
[ "$DRY_RUN" = 1 ] && args+=(--dry-run)
if "$PROVISION" ${args[@]+"${args[@]}"} "${pending[@]}" >> "$LOG_FILE" 2>&1; then
  log "sweep done: ${pending[*]} provisioned"
else
  log "sweep FAILED for one or more of: ${pending[*]} (see the output above)"
  exit 1
fi

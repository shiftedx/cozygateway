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
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$REPO_ROOT/integrations/attach-plugin"
# Kept overridable for the isolated shell regression test. The installed
# LaunchAgent does not set it and always runs the staged provisioner.
PROVISION="${COZY_PROVISION_COMMAND:-$SCRIPT_DIR/provision-bot.sh}"

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
[ -d "$SRC_DIR" ] || { log "sweep aborted: staged attach plugin is missing: $SRC_DIR"; exit 1; }

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

# The display keys Hermes reads before it will stream a reply, printed one per
# line when the profile does not carry them.
#
# Hermes' own default is silence: `StreamingConfig.enabled` is false
# (gateway/config.py) and `_setup_stream_consumer` asks the runner for stream
# deltas only when `display.platforms.<platform>.streaming` resolves true for
# the turn's platform. `cozygateway` has no per-platform default of its own, so
# a profile that names neither key never emits a single draft frame and the
# phone only ever receives the finished message.
#
# Structural, not a grep: only a parse can tell an absent key from one an
# operator deliberately set to false, and only the absent ones may be written.
# PyYAML does that when the interpreter has it, which the Hermes venv always
# does because Hermes itself depends on it. It is NOT a requirement: a host
# whose python has no PyYAML (a hosted CI runner, a plain system python) falls
# back to a conservative stdlib probe that answers only when the file is simple
# enough to be certain, and otherwise says the keys are present so nothing is
# written.
streaming_keys_absent() {
  "$PYTHON" - --streaming-keys "$1" <<'PY'
import re
import sys
from pathlib import Path

WANTED = (("display", "streaming"), ("display", "platforms", "cozygateway", "streaming"))
KEY = re.compile(r"^(?P<indent> *)(?P<key>[A-Za-z0-9_][A-Za-z0-9_.\-]*):(?P<rest>[ \t].*|)$")
BLOCK_SCALAR = re.compile(r"^[|>][0-9+-]*$")


def block(parent, key):
    value = parent.get(key) if isinstance(parent, dict) else None
    return value if isinstance(value, dict) else {}


def absent_with_yaml(text, yaml):
    data = yaml.safe_load(text) or {}
    display = block(data, "display")
    platform = block(block(display, "platforms"), "cozygateway")
    absent = []
    if display.get("streaming") is None:
        absent.append("display.streaming")
    if platform.get("streaming") is None:
        absent.append("display.platforms.cozygateway.streaming")
    return absent


def on_the_way(path):
    """True when `path` is a prefix of a key this probe is looking for, so an
    unjudgeable line there could hide one."""
    return any(wanted[: len(path)] == path for wanted in WANTED)


def absent_without_yaml(text):
    """Conservative block-mapping probe for a host with no PyYAML.

    Returns the wanted keys this file certainly does not carry, or None when it
    uses something this probe cannot judge WHERE ONE OF THOSE KEYS COULD BE (a
    flow mapping, an anchor, a merge key, a sequence, a line it cannot parse),
    or anywhere at all for a tab or a second document. None means "assume they
    are present", so the caller writes nothing: the only safe way to be unsure
    about somebody's config file. Everything outside `display` is skipped rather
    than judged, since nothing there can carry these keys.
    """
    stack = []
    present = set()
    seen_top = set()
    inside_block_scalar_at = None
    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        leading = line[: len(line) - len(line.lstrip())]
        indent = len(leading)
        if inside_block_scalar_at is not None:
            # A block scalar's body is text, not structure: skip it wholesale
            # rather than read a line of prose as a key.
            if indent > inside_block_scalar_at:
                continue
            inside_block_scalar_at = None
        if "\t" in leading:
            return None
        if stripped.startswith("---") or stripped.startswith("..."):
            return None
        while stack and indent <= stack[-1][0]:
            stack.pop()
        path = tuple(key for _, key in stack)
        if stripped.startswith("-"):
            # A sequence where one of the wanted keys would be a mapping.
            if on_the_way(path):
                return None
            continue
        match = KEY.match(line)
        if match is None:
            if on_the_way(path):
                return None
            continue
        key = match.group("key")
        value = match.group("rest").strip()
        if value.startswith("#"):
            value = ""
        here = path + (key,)
        if BLOCK_SCALAR.match(value):
            if on_the_way(here):
                return None
            inside_block_scalar_at = indent
            continue
        if value in ("{}", "[]"):
            value = "empty"
        elif value[:1] in ("{", "[", "&", "*") or key == "<<":
            if on_the_way(here):
                return None
            value = "unjudged"
        if indent == 0:
            if key in seen_top:
                return None
            seen_top.add(key)
        if here in WANTED and value != "":
            present.add(here)
        if value == "":
            stack.append((indent, key))
    return [".".join(name) for name in WANTED if name not in present]


def main():
    path = Path(sys.argv[2]) / "config.yaml"
    try:
        text = path.read_text()
    except Exception:
        sys.exit(1)
    try:
        import yaml
    except ImportError:
        yaml = None
    if yaml is None:
        absent = absent_without_yaml(text)
        if absent is None:
            return
    else:
        try:
            absent = absent_with_yaml(text, yaml)
        except Exception:
            sys.exit(1)
    for name in absent:
        print(name)


main()
PY
}

# A profile can have all of its wiring while still running an old plugin: the
# watcher must compare content (not timestamps or merely plugin.yaml's version)
# so an already-loaded Hermes service is upgraded after every staged release.
# Newline-bearing filenames are not a supported plugin asset shape; the source
# tree is versioned and the plugin loader cannot address such paths either.
plugin_content_matches_source() {
  local dest="$1" source_files installed_files rel
  [ -d "$dest" ] || return 1
  source_files="$(cd "$SRC_DIR" && find . -type f ! -path '*/__pycache__/*' ! -path '*/.pytest_cache/*' ! -name '*.pyc' -print | LC_ALL=C sort)"
  installed_files="$(cd "$dest" && find . -type f ! -path '*/__pycache__/*' ! -path '*/.pytest_cache/*' ! -name '*.pyc' -print | LC_ALL=C sort)"
  [ "$source_files" = "$installed_files" ] || return 1
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    cmp -s "$SRC_DIR/$rel" "$dest/$rel" || return 1
  done <<EOF
$source_files
EOF
}

# Wired: all three halves plus the current staged plugin. Reported as a reason
# string so the log says WHY a profile was picked up, which is the first
# question at 3am.
missing_reason() {
  local dir="$1" profile="$2"
  [ -d "$dir/plugins/cozygateway" ] || { printf 'no synced plugin dir'; return 0; }
  plugin_content_matches_source "$dir/plugins/cozygateway" \
    || { printf 'plugin content differs from staged source'; return 0; }
  # NOT a bare test for COZYGATEWAY_TOKEN: a fresh profile arrives with a COPY
  # of the launch profile's .env, token included, so its presence proves
  # nothing. A spool path pointing INTO this profile's own directory is the
  # marker only the provisioner writes, and the inherited value (the global
  # ~/.hermes/plugin-data/... path) fails it.
  grep -q "^COZYGATEWAY_SPOOL_PATH=$dir/" "$dir/.env" 2>/dev/null \
    || { printf 'env not scoped to this profile'; return 0; }
  launchctl print "gui/$(id -u)/ai.hermes.gateway-$profile" >/dev/null 2>&1 \
    || { printf 'no launchd gateway service'; return 0; }
  # Wired but mute: every profile created before the gateway's seed wrote these
  # keys is fully reachable and still never streams. An unreadable or
  # unjudgeable config answers "no keys absent", so an uncertain sweep leaves
  # the profile alone rather than provisioning it every tick.
  [ -z "$(streaming_keys_absent "$dir")" ] \
    || { printf 'streaming is off in config.yaml'; return 0; }
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
  # Residue shows up in TWO shapes and the second one is the common one.
  #
  #  1. A launchd gateway service whose profile directory is gone.
  #  2. A BOX CONFIG entry whose profile is gone. When a bot is deleted from the phone, the
  #     gateway removes the Hermes profile and Hermes stops and removes the service with it, so
  #     shape 1 never appears and only the box's hermes.profiles entry and token env line linger
  #     (observed 2026-08-26: 6 real profiles, 9 configured, 3 absent).
  #
  # Shape 1 is free to check. Shape 2 costs one ssh, so it runs on a slow cadence rather than
  # every 30 second tick; residue is not urgent, it is just untidy.
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

  # Shape 2, at most once every RECONCILE_SECONDS, tracked by a stamp file.
  RECONCILE_SECONDS="${COZY_PROVISIONER_RECONCILE_SECONDS:-600}"
  STAMP="${TMPDIR:-/tmp}/cozylabs-bot-provisioner.reconcile"
  now_epoch="$(date +%s)"
  last_epoch=0
  [ -f "$STAMP" ] && last_epoch="$(cat "$STAMP" 2>/dev/null || printf 0)"
  case "$last_epoch" in ''|*[!0-9]*) last_epoch=0 ;; esac
  if [ "$(( now_epoch - last_epoch ))" -ge "$RECONCILE_SECONDS" ]; then
    printf '%s' "$now_epoch" > "$STAMP" 2>/dev/null || true
    configured="$("$DEPROVISION" --list-configured 2>/dev/null || true)"
    for profile in $configured; do
      [ -n "$profile" ] || continue
      [ -d "$HERMES_HOME_ROOT/profiles/$profile" ] && continue
      case " ${orphans[*]+${orphans[*]}} " in *" $profile "*) continue ;; esac
      orphans+=("$profile")
      log "orphaned: $profile (box config entry with no profile directory)"
    done
  fi
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

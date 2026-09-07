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

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# NOTE on PyYAML: this read, unlike the streaming read below, still REQUIRES
# PyYAML and stops the run without it. That is deliberate and unchanged: these
# two scripts are the dev-box provisioner (docs/plans/2026-09-05-auto-provision-
# phone-created-bots.md), they run beside a Hermes venv that always has PyYAML,
# and "is this profile opted in" decides whether a bot is touched at all, which
# is not a question to answer conservatively from a partial parse. The
# host-PyYAML-free guarantee covers the shipped installer and the streaming keys.
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

# The keys Hermes reads before it will stream a reply, and before it will stream
# one often enough to look like a stream, printed one `key=value` per line when
# the profile does not carry them.
#
# Hermes' own default is silence: `StreamingConfig.enabled` is false
# (gateway/config.py) and `_setup_stream_consumer` asks the runner for stream
# deltas only when `display.platforms.<platform>.streaming` resolves true for
# the turn's platform. `cozygateway` has no per-platform default of its own, so
# a profile that names neither key never emits a single draft frame and the
# phone only ever receives the finished message.
#
# Cadence is the second half, and a separate top-level key. `_should_edit`
# flushes at most one frame per `streaming.edit_interval` (0.8s) unless
# `streaming.buffer_threshold` (24) is reached, which is Telegram's
# one-edit-a-second envelope and turns a minute-long reply into a couple of
# frames on the wire. Both are read by `StreamingConfig.from_dict`, so seeding
# them is a value Hermes already understands, not a change to any Hermes source.
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
  "$PYTHON" - --streaming-keys "$1" <<'PY' | tr -d '\r'
import re
import sys
from pathlib import Path

# Each entry is a config path and the value to write when the profile does not
# carry it. The two `display` keys turn streaming ON at all; the two top-level
# `streaming` keys decide how OFTEN an in-flight reply is pushed. Hermes'
# defaults there are a 0.8 second edit interval and a 24 codepoint buffer
# threshold (gateway/config.py), which is Telegram's one-edit-a-second envelope
# and shows up on a phone as two frames for a minute-long answer instead of a
# stream. Both are read by `StreamingConfig.from_dict`, so this is a value
# Hermes already understands and not a change to any Hermes source.
WANTED = (
    (("display", "streaming"), "true"),
    (("display", "platforms", "cozygateway", "streaming"), "true"),
    (("streaming", "edit_interval"), "0.05"),
    (("streaming", "buffer_threshold"), "1"),
)
WANTED_PATHS = tuple(path for path, _ in WANTED)
KEY = re.compile(r"^(?P<indent> *)(?P<key>[A-Za-z0-9_][A-Za-z0-9_.\-]*):(?P<rest>[ \t].*|)$")
BLOCK_SCALAR = re.compile(r"^[|>][0-9+-]*$")


def block(parent, key):
    value = parent.get(key) if isinstance(parent, dict) else None
    return value if isinstance(value, dict) else {}


def report(path, value):
    """One line of the answer: the dotted key, then the value to write for it."""
    return ".".join(path) + "=" + value


def absent_with_yaml(text, yaml):
    data = yaml.safe_load(text) or {}
    absent = []
    for path, value in WANTED:
        parent = data
        for segment in path[:-1]:
            parent = block(parent, segment)
        if not isinstance(parent, dict) or parent.get(path[-1]) is None:
            absent.append(report(path, value))
    return absent


def on_the_way(path):
    """True when `path` is a prefix of a key this probe is looking for, so an
    unjudgeable line there could hide one."""
    return any(wanted[: len(path)] == path for wanted in WANTED_PATHS)


def absent_without_yaml(text):
    """Conservative block-mapping probe for a host with no PyYAML.

    Returns the wanted keys this file certainly does not carry, or None when it
    uses something this probe cannot judge WHERE ONE OF THOSE KEYS COULD BE (a
    flow mapping, an anchor, a tag, a sequence, or any line it cannot parse,
    which is what a merge key or a quoted key arrives as),
    or anywhere at all for a tab or a second document. None means "assume they
    are present", so the caller writes nothing: the only safe way to be unsure
    about somebody's config file. Everything outside the top-level sections that
    could hold a wanted key is skipped rather than judged.
    """
    stack = []
    present = set()
    containers = set()
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
        # Every mapping that has a key under it. A wanted key written as
        # `streaming:` with its value on the following, more indented lines has
        # an EMPTY value here and is still present: PyYAML reads a dict, not
        # None. Without this the probe would call it absent and the caller would
        # replace the operator's block with a boolean.
        containers.add(path)
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
        elif value[:1] in ("{", "[", "&", "*", "!"):
            if on_the_way(here):
                return None
            value = "unjudged"
        if indent == 0:
            if key in seen_top:
                return None
            seen_top.add(key)
        if here in WANTED_PATHS and value != "":
            present.add(here)
        if value == "":
            stack.append((indent, key))
    return [
        report(name, value)
        for name, value in WANTED
        if name not in present and name not in containers
    ]


# Never nerf Hermes. `streaming.edit_interval` and `streaming.buffer_threshold`
# are TOP-LEVEL keys: Hermes has no per-platform override for either one and no
# adapter seam for them, so tightening them on a profile that also runs Telegram
# or Discord pushes those bots' edits at the same rate and straight into their
# flood limits. A profile that serves anything but cozygateway therefore keeps
# the cadence its operator has, and is told so. The two `display` switches are
# unaffected: those ARE per-platform and only ever turn cozygateway on.
#
# "Serves anything but cozygateway" is answered two ways, both stdlib and both
# identical with or without PyYAML so the two reader modes cannot disagree here:
#
#   * one of Hermes' first-party platform tokens is set in the profile's `.env`
#     or the Hermes home's `.env`. `_PLATFORM_ENABLE_ENV_VARS` in
#     hermes_cli/tools_config.py is that list, and env is where Hermes decides
#     this, not config.yaml.
#   * a plugin directory in the profile declares `kind: platform` and is not
#     this one. Deliberately NOT filtered by `plugins.enabled`: a platform
#     plugin sitting in the profile is enough to leave an operator's cadence
#     alone, and reading the enabled list would need a YAML sequence parse the
#     two modes could answer differently.
#
# Unsure reads as "another platform", which is the direction that writes nothing.
# So does a token assigned in the HOME `.env` that the profile `.env` blanks:
# the union is over names ASSIGNED anywhere, not over the value the profile
# finally resolves to, so such a profile keeps its own cadence. That is the
# withholding direction, and cheaper than reimplementing Hermes' env precedence.
#
# The two cadence keys are also seeded only TOGETHER. They are one setting read
# as a disjunction (`(elapsed >= edit_interval and acc) or len(acc) >= threshold`),
# so writing a threshold of 1 beside an operator's deliberate 2.0 second interval
# makes that interval unreachable: every tick flushes anyway. An operator who set
# either half therefore keeps both, and is told so.
PLATFORM_ENV_VARS = (
    "TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN",
    "WHATSAPP_ENABLED", "QQ_APP_ID",
)
CADENCE_PREFIX = "streaming."
CADENCE_KEYS = tuple(
    ".".join(path) for path, _ in WANTED if path and path[0] == "streaming")


def env_names(path):
    """Names assigned a non-empty value in a dotenv file; empty when unreadable."""
    names = set()
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return names
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        if value.strip().strip("\"'"):
            names.add(name.strip().removeprefix("export").strip())
    return names


def other_chat_platform(profile_dir):
    """Name of another chat platform this profile serves, or "" when only this one."""
    homes = [profile_dir]
    if profile_dir.parent.name == "profiles":
        homes.append(profile_dir.parent.parent)
    assigned = set()
    for home in homes:
        assigned |= env_names(home / ".env")
    for name in PLATFORM_ENV_VARS:
        if name in assigned:
            return name
    try:
        entries = sorted(
            entry for entry in (profile_dir / "plugins").iterdir() if entry.is_dir())
    except Exception:
        entries = []
    for entry in entries:
        if entry.name == "cozygateway":
            continue
        try:
            manifest = (entry / "plugin.yaml").read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for raw in manifest.splitlines():
            line = raw.strip()
            if not line.startswith("kind:"):
                continue
            if line.split(":", 1)[1].strip().strip("\"'") == "platform":
                return entry.name
    return ""


def main():
    profile_dir = Path(sys.argv[2])
    path = profile_dir / "config.yaml"
    try:
        text = path.read_text(encoding="utf-8")
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
    cadence = [entry for entry in absent if entry.startswith(CADENCE_PREFIX)]
    if cadence:
        # A leading "!" marks a line the caller SAYS; it is never a key to write.
        note = ""
        if len(cadence) < len(CADENCE_KEYS):
            missing = {entry.split("=", 1)[0] for entry in cadence}
            note = "!cadence-partly-set:" + ",".join(
                name for name in CADENCE_KEYS if name not in missing)
        else:
            other = other_chat_platform(profile_dir)
            if other:
                note = "!another-chat-platform:" + other
        if note:
            absent = [note] + [
                entry for entry in absent if not entry.startswith(CADENCE_PREFIX)
            ]
    # Written as BYTES on purpose. A Windows interpreter translates "\n" into
    # CRLF on a text stream, and the caller would then carry a "\r" inside every
    # key name it went on to write.
    sys.stdout.buffer.write("".join(name + "\n" for name in absent).encode("utf-8"))


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
  [ ! -f "$dir/.cozygateway-provision-pending" ] || { printf 'previous provisioning incomplete'; return 0; }
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
  # Wired but mute, or wired and streaming at Telegram's one-edit-a-second
  # envelope: every profile created before the gateway's seed wrote these keys
  # is fully reachable and either never streams or shows a minute-long answer as
  # a couple of frames. An unreadable or unjudgeable config answers "no keys
  # absent", so an uncertain sweep leaves the profile alone rather than
  # provisioning it every tick.
  # A "!" line is a note the provisioner prints, not a key it writes, so it must
  # never read as pending work: a profile that serves another chat platform
  # keeps its own cadence forever and would otherwise be swept every tick.
  [ -z "$(streaming_keys_absent "$dir" | grep -v '^!' || true)" ] \
    || { printf 'streaming settings are incomplete in config.yaml'; return 0; }
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
[ -x "$DEPROVISION" ] || { log "sweep aborted: staged deprovisioner is missing: $DEPROVISION"; exit 1; }
# An unavailable profile root is not evidence that every bot was deleted.
[ -d "$HERMES_HOME_ROOT/profiles" ] && [ -r "$HERMES_HOME_ROOT/profiles" ] && [ -x "$HERMES_HOME_ROOT/profiles" ] \
  || { log "sweep aborted: Hermes profiles root unavailable"; exit 1; }
export HERMES_HOME_ROOT
orphans=()
add_orphan() {
  local profile="$1"
  [[ "$profile" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || return 0
  case "$profile" in hermes|default|test|tmp|root|sudo) return 0 ;; esac
  [ -e "$HERMES_HOME_ROOT/profiles/$profile" ] && return 0
  [ -L "$HERMES_HOME_ROOT/profiles/$profile" ] && return 0
  case " ${orphans[*]+${orphans[*]}} " in *" $profile "*) return 0 ;; esac
  orphans+=("$profile")
  log "orphaned: $profile"
}
while IFS= read -r label; do
  [ -n "$label" ] || continue
  add_orphan "${label#ai.hermes.gateway-}"
done <<ORPHANS
$(launchctl list 2>/dev/null | awk '{ print $3 }' | grep '^ai\.hermes\.gateway-' || true)
ORPHANS
# Unloaded plists also need removal (a reboot could otherwise reload them).
for plist in "$HOME/Library/LaunchAgents"/ai.hermes.gateway-*.plist; do
  [ -f "$plist" ] || continue
  profile="${plist##*/ai.hermes.gateway-}"
  add_orphan "${profile%.plist}"
done

RECONCILE_SECONDS="${COZY_PROVISIONER_RECONCILE_SECONDS:-30}"
STAMP="${COZY_PROVISIONER_RECONCILE_STAMP:-$LOCK_FILE.reconcile}"
case "$RECONCILE_SECONDS" in ''|*[!0-9]*) log "invalid reconciliation interval"; exit 1 ;; esac
now_epoch="$(date +%s)"
last_epoch=0
[ -f "$STAMP" ] && last_epoch="$(cat "$STAMP" 2>/dev/null || printf 0)"
case "$last_epoch" in ''|*[!0-9]*) last_epoch=0 ;; esac
reconciled=0
if [ "$(( now_epoch - last_epoch ))" -ge "$RECONCILE_SECONDS" ]; then
  if ! configured="$("$DEPROVISION" --list-configured 2>> "$LOG_FILE")"; then
    log "sweep aborted: box reconciliation failed; next sweep will retry"
    exit 1
  fi
  while IFS= read -r profile; do add_orphan "$profile"; done <<< "$configured"
  reconciled=1
fi
if [ "${#orphans[@]}" -gt 0 ]; then
  dargs=(--orphans-only)
  [ "$DRY_RUN" = 1 ] && dargs+=(--dry-run)
  if "$DEPROVISION" "${dargs[@]}" "${orphans[@]}" >> "$LOG_FILE" 2>&1; then
    log "deprovisioned: ${orphans[*]}"
  else
    log "deprovision FAILED for ${orphans[*]}; next sweep will retry"
    # Even a custom slow interval must retry failed work on the next tick.
    rm -f "$STAMP"
    exit 1
  fi
fi
if [ "$reconciled" = 1 ] && [ "$DRY_RUN" != 1 ]; then
  printf '%s' "$now_epoch" > "$STAMP"
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

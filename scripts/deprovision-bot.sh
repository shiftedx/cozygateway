#!/usr/bin/env bash
# Remove every trace a provisioned bot left on this Mac and on the box.
#
# THE INVERSE OF provision-bot.sh
#   DELETE /bots/:name (capability 37) does the two halves a gateway can reach
#   from where it runs: it asks Hermes to delete the profile directory, and it
#   purges its own tables. Three things are deliberately outside that reach,
#   and they are exactly what the route's `residue` list names:
#
#     1. The box gateway endpoint profile entry. Still there, the
#        next gateway boot rebuilds an agent row for a bot that no longer
#        exists, and startup FAILS CLOSED if its token env var is missing.
#     2. The box .env line COZYGATEWAY_ATTACH_TOKEN_<P>. Dead as a credential
#        the moment the roster row died (the gateway revokes it in-process),
#        but it is still a secret sitting in a file.
#     3. The per-profile launchd service ai.hermes.gateway-<p> on this Mac.
#        Hermes' own delete_profile stops and cleans it up, so on the happy
#        path this script finds nothing; it is checked anyway because a delete
#        that never reached Hermes leaves the job running and respawning.
#
#   This script is that sweep. Run it after the route, or on its own for a bot
#   deleted some other way.
#
# IDEMPOTENCE
#   Every step is a check-then-act against real state, so a second run is a
#   no-op that reports "already gone" rather than failing, and a run
#   interrupted halfway is repaired by the next one.
#
# SAFETY
#   Reserved profile names are refused outright, and "default" doubly so: the
#   default profile is ~/.hermes itself, and removing its directory would take
#   the whole Hermes install with it.
set -euo pipefail

HERMES_HOME_ROOT="${HERMES_HOME_ROOT:-$HOME/.hermes}"
BOX_SSH="${BOX_SSH:-kmcdowell@192.168.99.106}"
BOX_REPO="${BOX_REPO:-/home/kmcdowell/cozygateway}"
BOX_CONFIG_REL="${BOX_CONFIG_REL:-local/config/cozygateway.config.json}"
GATEWAY_URL="${GATEWAY_URL:-https://warm.cozylabs.ai}"
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-90}"
# Names that are never a deletable bot. Mirrors RESERVED_PROFILE_NAMES in
# packages/gateway/src/hermes-bridge/crud.ts, which refuses the same set on the
# route, so the script and the API agree on what cannot be deleted.
RESERVED_NAMES="hermes default test tmp root sudo"
DRY_RUN=0
SKIP_VERIFY=0
ORPHANS_ONLY=0
PROFILES=()

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
die()  { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<USAGE
usage: deprovision-bot.sh [options] <profile> [profile ...]

Sweeps every trace a provisioned bot left behind: the per-profile launchd
service, the profile directory, the box gateway config entry and its token env
line, then recreates the box gateway once and verifies the configured count.

Idempotent. Safe to re-run. Refuses reserved profile names.

  -n, --dry-run          print every step, change nothing
  --no-verify            skip the configured-count verification at the end
  --orphans-only         refuse any profile whose live directory still exists
  --gateway-url URL      gateway base URL (default $GATEWAY_URL)
  --box HOST             ssh target for the gateway box (default $BOX_SSH)
  --box-repo DIR         repo checkout on the box (default $BOX_REPO)
  --hermes-home DIR      hermes home (default \$HERMES_HOME_ROOT or ~/.hermes)
  --verify-timeout SEC   how long to wait for the final count (default $VERIFY_TIMEOUT)
  --list-configured      print the profile names the box configures, one per line, and exit
  -h, --help             show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1; shift ;;
    --no-verify) SKIP_VERIFY=1; shift ;;
    --orphans-only) ORPHANS_ONLY=1; shift ;;
    --gateway-url) GATEWAY_URL="$2"; shift 2 ;;
    --box) BOX_SSH="$2"; shift 2 ;;
    --box-repo) BOX_REPO="$2"; shift 2 ;;
    --hermes-home) HERMES_HOME_ROOT="$2"; shift 2 ;;
    --verify-timeout) VERIFY_TIMEOUT="$2"; shift 2 ;;
    --list-configured) LIST_CONFIGURED=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option: $1" ;;
    *) PROFILES+=("$1"); shift ;;
  esac
done
for arg in ${@+"$@"}; do PROFILES+=("$arg"); done

# Quote each remote argument for the SSH login shell (including custom paths).
shell_quote() { local value="$1"; value=${value//\'/\'\\\'\'}; printf "'%s'" "$value"; }

# One structural edit for the whole batch. The journal is written BEFORE either
# file changes and remains until recreate and verification succeed. A later
# sweep can therefore discover work even after the last config entry is gone.
box_state() {
  local action="$1" command arg
  shift
  command="python3 - $(shell_quote "$BOX_REPO/$BOX_CONFIG_REL") $(shell_quote "$BOX_REPO/.env") $(shell_quote "$action")"
  for arg in "$@"; do command="$command $(shell_quote "$arg")"; done
  ssh -o BatchMode=yes "$BOX_SSH" "$command" <<'PYREMOTE'
import json, os, re, stat, sys, tempfile
from pathlib import Path

path, env_path = map(Path, sys.argv[1:3])
action, names = sys.argv[3], set(sys.argv[4:])
journal = path.with_name(path.name + ".deprovision-pending.json")
reserved = {"hermes", "default", "test", "tmp", "root", "sudo"}
def valid(name):
    return isinstance(name, str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", name) and name not in reserved
def load_unique(p):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate config key")
            result[key] = value
        return result
    return json.loads(p.read_text(), object_pairs_hook=unique)
def atomic(p, text):
    mode = stat.S_IMODE(p.stat().st_mode) if p.exists() else 0o600
    fd, tmp = tempfile.mkstemp(prefix=p.name + ".tmp-", dir=p.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
def save(p, value):
    atomic(p, json.dumps(value, indent=2) + "\n")
try:
    data = load_unique(path)
    endpoints = data.get("hermesEndpoints") if isinstance(data, dict) else None
    if not isinstance(endpoints, list) or len(endpoints) != 1 or not isinstance(endpoints[0], dict):
        raise ValueError("requires exactly one Hermes endpoint")
    profiles = endpoints[0].get("profiles")
    if not isinstance(profiles, dict):
        raise ValueError("profiles must be an object")
    for name, entry in profiles.items():
        if not isinstance(entry, dict) or not isinstance(entry.get("tokenEnv"), str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", entry["tokenEnv"]):
            raise ValueError("invalid profile tokenEnv")
    pending = load_unique(journal) if journal.exists() else {}
    if (not isinstance(pending, dict) or not all(valid(name) for name in pending)
        or not all(isinstance(keys, list) and all(isinstance(key, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) for key in keys) for keys in pending.values())):
        raise ValueError("invalid deprovision journal")
    if not all(valid(name) for name in names):
        raise ValueError("invalid or reserved profile name")
    if action == "list":
        # Reserved profiles can be valid keepers but can never be sweep targets.
        for name in sorted(set(profiles) | set(pending)):
            if valid(name):
                print(name)
    elif action == "clean":
        env = env_path.read_text()  # Failure is not equivalent to absence.
        owned = {}
        for name in names:
            keys = set(pending.get(name, []))
            keys.add("COZYGATEWAY_ATTACH_TOKEN_" + re.sub(r"[^A-Z0-9]", "_", name.upper()).rstrip("_"))
            if name in profiles:
                keys.add(profiles[name]["tokenEnv"])
            owned[name] = sorted(keys)
        keys = {key for values in owned.values() for key in values}
        # A shared key belongs to surviving profiles too; never remove it.
        keys -= {entry["tokenEnv"] for n, entry in profiles.items() if n not in names}
        filtered = "".join(line for line in env.splitlines(keepends=True)
                           if not any(re.match(r"^\s*(?:export\s+)?" + re.escape(key) + r"\s*=", line) for key in keys))
        changed_config = bool(names & set(profiles))
        changed_env = filtered != env
        if changed_config or changed_env or names & set(pending):
            # Capture custom tokenEnv names before config removal, so a crash
            # between the two atomic writes cannot lose the credential key.
            pending.update(owned)
            save(journal, pending)
        if changed_config:
            for name in names:
                profiles.pop(name, None)
            save(path, data)
        if changed_env:
            atomic(env_path, filtered)
        print(len(profiles), int(bool(names & set(pending))))
    elif action == "complete":
        remaining = {name: keys for name, keys in pending.items() if name not in names}
        if remaining:
            save(journal, remaining)
        elif journal.exists():
            journal.unlink()
    else:
        raise ValueError("unknown action")
except Exception as exc:
    # Never include file contents or token values in diagnostics.
    print("deprovision state refused: " + type(exc).__name__, file=sys.stderr)
    sys.exit(1)
PYREMOTE
}

have ssh || die "ssh not found on PATH"
if [ "${LIST_CONFIGURED:-0}" = 1 ]; then box_state list; exit $?; fi
[ "${#PROFILES[@]}" -gt 0 ] || { usage >&2; die "no profile named"; }
case "$VERIFY_TIMEOUT" in ''|*[!0-9]*) die "invalid verification timeout" ;; esac
# Validate the entire batch before any service, file or remote state is changed.
for profile in "${PROFILES[@]}"; do
  [[ "$profile" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || die "invalid profile name"
  case " $RESERVED_NAMES " in *" $profile "*) die "reserved profile name: $profile" ;; esac
  if [ "$ORPHANS_ONLY" = 1 ] && { [ -e "$HERMES_HOME_ROOT/profiles/$profile" ] || [ -L "$HERMES_HOME_ROOT/profiles/$profile" ]; }; then
    die "[$profile] live profile path exists; refusing orphan cleanup"
  fi
done

# --- steps ----------------------------------------------------------------

# Bring the per-profile launchd job down for good. Boot it OUT first: an
# uninstall that only removes the plist leaves a loaded job that KeepAlive
# happily respawns, which is the same "cheerful success, nothing changed" trap
# provision-bot.sh documents on the install side.
remove_service() {
  local profile="$1"
  if [ "$ORPHANS_ONLY" = 1 ] && { [ -e "$HERMES_HOME_ROOT/profiles/$profile" ] || [ -L "$HERMES_HOME_ROOT/profiles/$profile" ]; }; then
    warn "[$profile] profile reappeared; refusing service cleanup"
    return 1
  fi
  local label="ai.hermes.gateway-$profile"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  local loaded=0

  have launchctl || { say "  launchctl not available, skipping service"; return 0; }
  launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && loaded=1

  if [ "$loaded" = 0 ] && [ ! -f "$plist" ]; then
    say "  service $label already gone"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  DRY  bootout and remove $label"
    return 0
  fi

  if [ "$loaded" = 1 ]; then
    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    say "  service $label booted out"
  fi
  if [ -f "$plist" ]; then
    rm -f "$plist" || return 1
    say "  service plist removed: $plist"
  fi
  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    warn "[$profile] $label is STILL loaded after bootout"
    return 1
  fi
  say "  service $label gone"
}

# Hermes' own delete_profile removes this directory, so on the happy path there
# is nothing here. When there is, it holds the profile's config, API keys,
# memories, sessions and the synced plugin's .env with its token: precisely the
# traces this whole lane exists to remove.
remove_profile_dir() {
  local profile="$1" dir="$2"
  if [ ! -e "$dir" ]; then
    say "  profile dir already gone"
    return 0
  fi
  # A guard against a mis-derived path taking out something that is not a
  # profile. The directory must live under the profiles root and be named for
  # the profile; anything else is refused rather than removed.
  case "$dir" in
    "$HERMES_HOME_ROOT/profiles/$profile") ;;
    *) die "[$profile] refusing to remove an unexpected path: $dir" ;;
  esac
  if [ "$DRY_RUN" = 1 ]; then say "  DRY  rm -rf $dir"; return 0; fi
  rm -rf "$dir"
  say "  profile dir removed: $dir"
}

# --- batch cleanup ---------------------------------------------------------
# Read the expected final count from the edited config, not an earlier /ready
# response: startup may already have applied some of the removal by then.
verify_configured() {
  local expected="$1" deadline now
  if [ "$SKIP_VERIFY" = 1 ]; then say "  (verification skipped)"; return 0; fi
  have curl || { warn "curl not found, cannot verify configured count"; return 1; }
  have python3 || { warn "python3 not found, cannot verify configured count"; return 1; }
  deadline=$(( $(date +%s) + VERIFY_TIMEOUT ))
  while :; do
    now="$(curl -fsS --max-time 5 "$GATEWAY_URL/ready" 2>/dev/null | python3 -c \
      'import json,sys; print(json.load(sys.stdin).get("attach",{}).get("hermes",{}).get("configured",""))' 2>/dev/null || true)"
    if [ "$now" = "$expected" ]; then say "  VERIFIED: attach.hermes.configured=$expected"; return 0; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      warn "attach.hermes.configured did not reach $expected within ${VERIFY_TIMEOUT}s (now: ${now:-unreadable})"
      return 1
    fi
    sleep 5
  done
}

if [ "$DRY_RUN" = 1 ]; then
  for profile in "${PROFILES[@]}"; do
    remove_service "$profile"
    [ "$ORPHANS_ONLY" = 1 ] || remove_profile_dir "$profile" "$HERMES_HOME_ROOT/profiles/$profile"
  done
  say "DRY  remove box config/token entries for ${PROFILES[*]}; recreate gateway once if needed"
  exit 0
fi

# A failed parse/read prevents local teardown as well as remote mutation.
result="$(box_state clean "${PROFILES[@]}")" || die "box cleanup failed; next sweep will retry"
[[ "$result" =~ ^[0-9]+\ [01]$ ]] || die "unexpected box cleanup response; pending work retained"
read -r expected needs_restart <<< "$result"
overall_rc=0
for profile in "${PROFILES[@]}"; do
  say "=== $profile ==="
  remove_service "$profile" || overall_rc=1
  # In automatic mode a recreated directory is never removed, even if it
  # appeared after orphan discovery. The next sweep will provision it again.
  [ "$ORPHANS_ONLY" = 1 ] || remove_profile_dir "$profile" "$HERMES_HOME_ROOT/profiles/$profile"
done
if [ "$needs_restart" = 1 ]; then
  ssh -o BatchMode=yes "$BOX_SSH" "cd $(shell_quote "$BOX_REPO") && docker compose up -d --force-recreate gateway" >/dev/null \
    || die "gateway recreate failed; pending cleanup retained for retry"
  verify_configured "$expected" || exit 1
fi
[ "$overall_rc" = 0 ] || exit "$overall_rc"
box_state complete "${PROFILES[@]}" || die "could not acknowledge completed cleanup"
say "deprovision-bot: all profiles swept"

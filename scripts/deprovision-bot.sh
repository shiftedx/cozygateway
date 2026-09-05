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
line, then recreates the box gateway and verifies the attach count dropped.

Idempotent. Safe to re-run. Refuses reserved profile names.

  -n, --dry-run          print every step, change nothing
  --no-verify            skip the attach-count verification at the end
  --gateway-url URL      gateway base URL (default $GATEWAY_URL)
  --box HOST             ssh target for the gateway box (default $BOX_SSH)
  --box-repo DIR         repo checkout on the box (default $BOX_REPO)
  --hermes-home DIR      hermes home (default \$HERMES_HOME_ROOT or ~/.hermes)
  --verify-timeout SEC   how long to wait for the count to drop (default $VERIFY_TIMEOUT)
  --list-configured      print the profile names the box configures, one per line, and exit
  -h, --help             show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1; shift ;;
    --no-verify) SKIP_VERIFY=1; shift ;;
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

# The reconciliation half of the provisioner sweep needs to know what the BOX still configures,
# because a bot deleted from the phone takes its profile and its launchd service with it and
# leaves only a config entry behind. Printing that list is a read, so it takes none of the
# teardown path below.
if [ "${LIST_CONFIGURED:-0}" = 1 ]; then
  have ssh || die "ssh not found on PATH"
  ssh -o BatchMode=yes "$BOX_SSH" \
    "python3 - '$BOX_REPO/$BOX_CONFIG_REL'" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        config = json.load(handle)
except Exception:
    sys.exit(0)
endpoints = config.get("hermesEndpoints") or []
profiles = endpoints[0].get("profiles", {}) if len(endpoints) == 1 else {}
if isinstance(profiles, dict):
    for name in profiles:
        print(name)
PY
  exit 0
fi

[ "${#PROFILES[@]}" -gt 0 ] || { usage >&2; die "no profile named"; }
have ssh || die "ssh not found on PATH"
have python3 || die "python3 not found on PATH"

# Same derivation provision-bot.sh used to CREATE the name, so this script
# removes the same line rather than a near miss: upper-cased, every
# non-alphanumeric run folded to one _.
token_env_name() {
  printf 'COZYGATEWAY_ATTACH_TOKEN_%s\n' \
    "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -c '[:alnum:]' '_' | sed 's/_*$//')"
}

is_reserved() {
  local name="$1" reserved
  for reserved in $RESERVED_NAMES; do
    [ "$name" = "$reserved" ] && return 0
  done
  return 1
}

# --- steps ----------------------------------------------------------------

# Bring the per-profile launchd job down for good. Boot it OUT first: an
# uninstall that only removes the plist leaves a loaded job that KeepAlive
# happily respawns, which is the same "cheerful success, nothing changed" trap
# provision-bot.sh documents on the install side.
remove_service() {
  local profile="$1"
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
    rm -f "$plist"
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

# Deletes the profile from the configured Hermes endpoint. A json edit rather than a text
# removal for the same reason provision-bot.sh inserted it with one: the file
# is a single object and a sed would have to guess at formatting. Prints
# "removed" or "already absent" so the caller can tell whether the attach count
# has any reason to move.
remove_box_config_entry() {
  local profile="$1"
  if [ "$DRY_RUN" = 1 ]; then
    # "dry-run" rather than a guessed outcome: the caller keys the verification
    # off this word, and a dry run must not claim the entry was or was not there.
    printf 'dry-run\n'
    return 0
  fi
  ssh -o BatchMode=yes "$BOX_SSH" \
    "python3 - '$BOX_REPO/$BOX_CONFIG_REL' '$profile'" <<'PY'
import json, os, sys
path, profile = sys.argv[1], sys.argv[2]
with open(path) as fh:
    data = json.load(fh)
endpoints = data.get("hermesEndpoints") or []
if len(endpoints) != 1:
    raise SystemExit("deprovision-bot requires exactly one Hermes endpoint")
profiles = endpoints[0].get("profiles", {})
if profile not in profiles:
    print("already absent")
    sys.exit(0)
del profiles[profile]
tmp = path + ".deprovision-tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
os.replace(tmp, path)
print("removed")
PY
}

# Drops the token line from the box .env. The value is never echoed, printed or
# passed on a command line: the remote filter only ever matches on the KEY.
remove_box_env_line() {
  local key="$1"
  # The dry-run check comes FIRST, before the probe: a run that changes nothing
  # should also reach nothing, so --dry-run works with the box unreachable.
  if [ "$DRY_RUN" = 1 ]; then say "  DRY  remove $key from $BOX_SSH:$BOX_REPO/.env"; return 0; fi
  if ! ssh -o BatchMode=yes "$BOX_SSH" "grep -q '^${key}=' '$BOX_REPO/.env'" 2>/dev/null; then
    say "  box env $key already absent"
    return 0
  fi
  ssh -o BatchMode=yes "$BOX_SSH" \
    "cd '$BOX_REPO' && grep -v '^${key}=' .env > .env.deprovision-tmp && chmod 600 .env.deprovision-tmp && mv .env.deprovision-tmp .env"
  say "  box env $key removed"
}

recreate_box_gateway() {
  if [ "$DRY_RUN" = 1 ]; then say "  DRY  docker compose up -d --force-recreate gateway on $BOX_SSH"; return 0; fi
  # up -d, not --build: the image is unchanged, only the env and the mounted
  # config moved, and a recreate is what re-reads both.
  ssh -o BatchMode=yes "$BOX_SSH" "cd '$BOX_REPO' && docker compose up -d --force-recreate gateway" >/dev/null
  say "  box gateway recreated"
}

# attach.configured is built at BOOT from the endpoint profiles, so it is the one
# number that proves the box no longer holds an identity for this bot.
attach_configured() {
  curl -fsS --max-time 5 "$GATEWAY_URL/ready" 2>/dev/null | python3 -c \
    'import json,sys; print(json.load(sys.stdin).get("attach",{}).get("configured",""))' 2>/dev/null
}

verify_configured_dropped() {
  local profile="$1" before="$2" deadline now
  if [ "$DRY_RUN" = 1 ] || [ "$SKIP_VERIFY" = 1 ]; then
    say "  (verification skipped)"
    return 0
  fi
  if ! have curl; then
    warn "[$profile] curl not found, cannot verify the attach count"
    return 1
  fi
  if [ -z "$before" ]; then
    warn "[$profile] no attach count was read before the sweep, cannot verify the drop"
    return 1
  fi
  deadline=$(( $(date +%s) + VERIFY_TIMEOUT ))
  while :; do
    now="$(attach_configured || true)"
    if [ -n "$now" ] && [ "$now" -lt "$before" ] 2>/dev/null; then
      say "  VERIFIED: attach.configured dropped $before -> $now"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      warn "[$profile] attach.configured did not drop below $before within ${VERIFY_TIMEOUT}s (now: ${now:-unreadable})"
      return 1
    fi
    sleep 5
  done
}

# --- main -----------------------------------------------------------------

overall_rc=0
for profile in ${PROFILES[@]+"${PROFILES[@]}"}; do
  say ""
  say "=== $profile ==="

  if is_reserved "$profile"; then
    warn "[$profile] reserved profile name, refusing to deprovision"
    overall_rc=1
    continue
  fi

  profile_dir="$HERMES_HOME_ROOT/profiles/$profile"
  env_name="$(token_env_name "$profile")"
  say "  box token env var: $env_name"

  # Read BEFORE anything moves: the verification at the end is a comparison,
  # and a count read after the recreate has nothing to compare against.
  configured_before=""
  if [ "$SKIP_VERIFY" != 1 ] && [ "$DRY_RUN" != 1 ] && have curl; then
    configured_before="$(attach_configured || true)"
    say "  attach.configured before: ${configured_before:-unreadable}"
  fi

  remove_service "$profile" || overall_rc=1
  remove_profile_dir "$profile" "$profile_dir"

  config_result="$(remove_box_config_entry "$profile" | tail -n 1)"
  say "  box config entry: $config_result"
  remove_box_env_line "$env_name"
  recreate_box_gateway

  if [ "$config_result" = "removed" ]; then
    verify_configured_dropped "$profile" "$configured_before" || overall_rc=1
  else
    say "  box never knew this profile, nothing for the attach count to drop"
  fi
done

say ""
if [ "$overall_rc" = 0 ]; then say "deprovision-bot: all profiles swept"; fi
exit "$overall_rc"

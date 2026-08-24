#!/usr/bin/env bash
# Deploy the checked-in CozyGateway attach plugin into local Hermes profiles,
# without SIGTERM-ing an agent mid-turn.
#
# Background: a plain "cp + launchctl kickstart -k" deploy restarts a
# profile's gateway process immediately, which kills whatever turn that
# process is in the middle of sending. This script (1) syncs plugin source
# into every profile's plugins/cozygateway dir plus the global
# ~/.hermes/plugins/cozygateway dir, (2) waits for each profile to go quiet
# before kicking it, (3) kickstarts the profile's launchd gateway job, and
# (4) polls the gateway's /ready endpoint to confirm every profile
# reconnected.
#
# QUIESCE HEURISTIC AND ITS LIMITS
#   There is no local signal for "a turn is active" -- that state lives on
#   the gateway side (bot_native_chats active_turn), not in anything this
#   machine can read. The attach-v1 spool
#   (~/.hermes/profiles/<p>/plugin-data/cozygateway/attach-v1.sqlite -- the
#   LIVE spool the resident writes; the profile also carries a stale, no
#   longer written .cozygateway/attach-v1.sqlite copy, which this script
#   deliberately does not touch) also does not timestamp its rows, so "no
#   event_outbox row in the last N seconds" cannot be a literal SQL WHERE
#   clause here.
#
#   What this script does instead: it samples max(sequence) from
#   event_outbox on an interval and tracks how long that value has gone
#   unchanged. Once it has been unchanged for --quiet-window seconds, the
#   profile is treated as quiescent. This is a heuristic, not a guarantee:
#     - FALSE QUIET: a turn that produces no outbound events for a long
#       stretch (a slow tool call, a long thinking block) looks quiescent
#       even though it is not. --quiet-window exists to tune this risk down;
#       it cannot remove it.
#     - FALSE BUSY: unrelated outbox writes (a scheduled message, another
#       concurrent conversation on the same profile) reset the quiet timer
#       even with no send in flight, which only ever makes this script wait
#       longer, never shorter.
#   If a profile never quiesces within --max-wait seconds, the script stops
#   and asks for --force rather than guessing. This is the honest simple
#   version described in the task: least machinery, real spool data, no
#   attempt to fabricate a signal the gateway does not expose locally.
#
# SHADOW-DIR TRAP (see repo memory: hermes-plugin-shadow-dir-gotcha)
#   Hermes discovers ANY directory under plugins/ that contains a
#   plugin.yaml and loads it by manifest `name:`, deduped across dirs by
#   scan-order luck. A leftover backup dir such as
#   plugins/cozygateway.pre-20260823-185151/ still carries `name: cozygateway`
#   and can silently win over the real plugins/cozygateway/ dir on every
#   restart. This script refuses to run if it finds any *.pre-* directory
#   inside a plugins/ dir it is about to touch; move backups OUTSIDE
#   plugins/ (e.g. ~/Documents/backups/hermes-plugin-backups-<date>/).
#
# Idempotent and safe to re-run. Use -n/--dry-run to see the plan with zero
# side effects (no file writes, no launchctl, no network).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$REPO_ROOT/integrations/attach-plugin"

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
DEFAULT_PROFILES=(cleo dewy-candle glowing-pixel night-owl polished-satellite rustic-squirrel)
PROFILES=()

QUIET_WINDOW=20      # seconds the event_outbox sequence must hold steady
POLL_INTERVAL=2       # seconds between spool samples
MAX_WAIT=180           # seconds before giving up and asking for --force
READY_URL="https://warm.cozylabs.ai/ready"
READY_COUNT=6
READY_TIMEOUT=30
FORCE=0
DRY_RUN=0

say() { printf '%s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
die() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf 'DRY   '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

usage() {
  cat <<USAGE
usage: deploy-plugin-local.sh [options] [profile ...]

Syncs the checked-in CozyGateway attach plugin into local Hermes profiles,
waits for each profile to quiesce, kickstarts its gateway, and verifies
reconnect.

  profile ...             profiles to deploy (default: ${DEFAULT_PROFILES[*]})
  -n, --dry-run            print the plan, make no changes
  --quiet-window SECONDS   how long event_outbox must hold steady (default $QUIET_WINDOW)
  --poll-interval SECONDS  spool sample interval while quiescing (default $POLL_INTERVAL)
  --max-wait SECONDS       give up waiting and prompt for --force (default $MAX_WAIT)
  --force                  kickstart even if a profile never quiesced
  --ready-url URL          gateway ready endpoint (default $READY_URL)
  --ready-count N          required attach.online count (default $READY_COUNT)
  --ready-timeout SECONDS  how long to poll the ready endpoint (default $READY_TIMEOUT)
  --hermes-home DIR        Hermes home dir (default \$HERMES_HOME or ~/.hermes)
  -h, --help               show this help
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1; shift ;;
    --quiet-window) QUIET_WINDOW="$2"; shift 2 ;;
    --poll-interval) POLL_INTERVAL="$2"; shift 2 ;;
    --max-wait) MAX_WAIT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --ready-url) READY_URL="$2"; shift 2 ;;
    --ready-count) READY_COUNT="$2"; shift 2 ;;
    --ready-timeout) READY_TIMEOUT="$2"; shift 2 ;;
    --hermes-home) HERMES_HOME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option: $1" ;;
    *) PROFILES+=("$1"); shift ;;
  esac
done
# Remaining positional args after --
for arg in "$@"; do PROFILES+=("$arg"); done

if [ "${#PROFILES[@]}" -eq 0 ]; then
  PROFILES=("${DEFAULT_PROFILES[@]}")
fi

have sqlite3 || die "sqlite3 not found on PATH"
have python3 || die "python3 not found on PATH"
[ -d "$SRC_DIR" ] || die "plugin source not found: $SRC_DIR"

GLOBAL_PLUGIN_DIR="$HERMES_HOME/plugins/cozygateway"

# --- shadow-dir guard --------------------------------------------------
# Refuse to run if any *.pre-* dir sits inside a plugins/ dir we are about
# to touch. See header comment for why this matters.
check_shadow_dir() {
  plugins_dir="$1"
  [ -d "$plugins_dir" ] || return 0
  for entry in "$plugins_dir"/*.pre-*; do
    [ -d "$entry" ] || continue
    die "shadow-dir trap: backup dir found inside plugins/: $entry
      Hermes loads any dir under plugins/ with a matching plugin.yaml name,
      by scan-order luck, and this backup can silently win over the real
      plugin. Move it outside plugins/ (e.g.
      ~/Documents/backups/hermes-plugin-backups-\$(date +%Y%m%d)/) and re-run."
  done
}

say "Checking for shadow-dir backups before touching anything..."
check_shadow_dir "$HERMES_HOME/plugins"
for p in "${PROFILES[@]}"; do
  check_shadow_dir "$HERMES_HOME/profiles/$p/plugins"
done
say "  clear"

# --- sync ----------------------------------------------------------------
sync_plugin() {
  dest="$1"
  label="$2"
  if [ "$DRY_RUN" = 1 ]; then
    say "DRY   sync $SRC_DIR/ -> $dest/ ($label)"
    return 0
  fi
  mkdir -p "$dest"
  rsync -a --delete \
    --exclude '__pycache__/' \
    --exclude '.pytest_cache/' \
    --exclude '*.pyc' \
    "$SRC_DIR/" "$dest/"
  find "$dest" -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
  say "  synced -> $dest ($label)"
}

say ""
say "Syncing global plugin dir..."
sync_plugin "$GLOBAL_PLUGIN_DIR" "global"

# --- quiesce ---------------------------------------------------------------
# Prints progress to stderr; the LAST line on stdout is the result token
# (quiet-immediately | quiet-after-<n>s | no-db | timed-out-forced), meant to
# be captured via command substitution.
quiesce_profile() {
  p="$1"
  db="$HERMES_HOME/profiles/$p/plugin-data/cozygateway/attach-v1.sqlite"
  if [ ! -f "$db" ]; then
    say "  [$p] no spool db at $db, nothing to quiesce against, proceeding" >&2
    echo "no-db"
    return 0
  fi

  last_seq="$(sqlite3 -readonly "$db" 'select coalesce(max(sequence), -1) from event_outbox;' 2>/dev/null || echo -1)"
  last_change=$(date +%s)
  start=$last_change
  elapsed=0

  while :; do
    now=$(date +%s)
    elapsed=$((now - start))
    cur_seq="$(sqlite3 -readonly "$db" 'select coalesce(max(sequence), -1) from event_outbox;' 2>/dev/null || echo "$last_seq")"
    if [ "$cur_seq" != "$last_seq" ]; then
      last_seq="$cur_seq"
      last_change=$now
    fi
    quiet_for=$((now - last_change))
    if [ "$quiet_for" -ge "$QUIET_WINDOW" ]; then
      if [ "$elapsed" -le "$QUIET_WINDOW" ]; then
        say "  [$p] quiescent immediately (event_outbox steady at seq=$last_seq)" >&2
        echo "quiet-immediately"
      else
        say "  [$p] quiescent after ${elapsed}s (event_outbox held at seq=$last_seq for ${QUIET_WINDOW}s)" >&2
        echo "quiet-after-${elapsed}s"
      fi
      return 0
    fi
    if [ "$elapsed" -ge "$MAX_WAIT" ]; then
      if [ "$FORCE" = 1 ]; then
        warn "[$p] never quiesced after ${MAX_WAIT}s (last seq change ${quiet_for}s ago); --force set, proceeding anyway"
        echo "timed-out-forced"
        return 0
      fi
      warn "[$p] did not quiesce within --max-wait ${MAX_WAIT}s (event_outbox still moving, last change ${quiet_for}s ago). Skipping kickstart for this profile; re-run with --force once you've confirmed it's safe to interrupt it."
      echo "timed-out"
      return 1
    fi
    sleep "$POLL_INTERVAL"
  done
}

# --- verify ------------------------------------------------------------
poll_ready() {
  if [ "$DRY_RUN" = 1 ]; then
    say "DRY   poll $READY_URL for attach.online >= $READY_COUNT (timeout ${READY_TIMEOUT}s)"
    return 0
  fi
  have curl || { warn "curl not found, skipping ready-endpoint verification"; return 1; }
  deadline=$(( $(date +%s) + READY_TIMEOUT ))
  while :; do
    body="$(curl -fsS --max-time 5 "$READY_URL" 2>/dev/null || true)"
    online="$(printf '%s' "$body" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("attach", {}).get("online", -1))
except Exception:
    print(-1)
' 2>/dev/null || echo -1)"
    if [ "$online" != "-1" ] && [ "$online" -ge "$READY_COUNT" ] 2>/dev/null; then
      say "  ready: attach.online=$online (>= $READY_COUNT)"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      warn "ready endpoint did not report attach.online >= $READY_COUNT within ${READY_TIMEOUT}s (last seen: ${online:-unknown})"
      return 1
    fi
    sleep 2
  done
}

# --- main loop -----------------------------------------------------------
declare -a SUMMARY
overall_rc=0

for p in "${PROFILES[@]}"; do
  say ""
  say "=== $p ==="
  profile_dir="$HERMES_HOME/profiles/$p"
  if [ ! -d "$profile_dir" ]; then
    warn "[$p] no profile dir at $profile_dir, skipping"
    SUMMARY+=("$p: SKIPPED (no profile dir)")
    continue
  fi

  sync_plugin "$profile_dir/plugins/cozygateway" "$p"

  say "Quiescing $p (quiet-window=${QUIET_WINDOW}s, max-wait=${MAX_WAIT}s)..."
  quiesce_rc=0
  if [ "$DRY_RUN" = 1 ]; then
    db="$profile_dir/plugin-data/cozygateway/attach-v1.sqlite"
    if [ -f "$db" ]; then
      cur="$(sqlite3 -readonly "$db" 'select coalesce(max(sequence), -1) from event_outbox;' 2>/dev/null || echo -1)"
      say "DRY   would poll $db (currently max(sequence)=$cur) until steady for ${QUIET_WINDOW}s, max ${MAX_WAIT}s"
    else
      say "DRY   no spool db at $db, would proceed without quiescing"
    fi
    quiesce_result="dry-run"
  else
    quiesce_result="$(quiesce_profile "$p")" || quiesce_rc=$?
  fi

  if [ "$quiesce_rc" -ne 0 ]; then
    SUMMARY+=("$p: synced, quiesce=$quiesce_result, NOT kickstarted (re-run with --force)")
    overall_rc=1
    continue
  fi

  label="ai.hermes.gateway-$p"
  say "Kickstarting $label..."
  if [ "$DRY_RUN" = 1 ]; then
    run launchctl kickstart -k "gui/$(id -u)/$label"
    SUMMARY+=("$p: synced, quiesce=$quiesce_result, kickstarted=$label")
  elif launchctl kickstart -k "gui/$(id -u)/$label"; then
    SUMMARY+=("$p: synced, quiesce=$quiesce_result, kickstarted=$label")
  else
    warn "[$p] launchctl kickstart failed for $label"
    SUMMARY+=("$p: synced, quiesce=$quiesce_result, KICKSTART FAILED for $label")
    overall_rc=1
  fi
done

say ""
say "Verifying reconnect via $READY_URL ..."
if ! poll_ready; then
  overall_rc=1
fi

say ""
say "=== summary ==="
for line in "${SUMMARY[@]}"; do
  say "  $line"
done
if [ "$DRY_RUN" = 1 ]; then
  say ""
  say "(dry run: no files were changed, no launchctl commands were run, no network calls were made)"
fi

exit "$overall_rc"

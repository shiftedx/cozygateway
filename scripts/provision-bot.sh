#!/usr/bin/env bash
# Make a freshly created bot actually chattable.
#
# THE PROBLEM (issue #183)
#   POST /bots creates a Hermes profile and a roster row, and that is where it
#   stopped. Chat rides a NATIVE attach binding that has three halves, none of
#   which POST /bots could create:
#
#     1. The gateway (docker, on the box) builds its nativeBots set at BOOT from
#        hermes.profiles in the mounted config. A profile absent from that map
#        has no attach identity, and its token env var has to exist too.
#     2. The Mac side needs the cozygateway attach plugin SYNCED into
#        ~/.hermes/profiles/<p>/plugins/ and a token in the profile's .env.
#     3. A per-profile launchd gateway process (ai.hermes.gateway-<p>) has to be
#        running, because that process is what dials the attach stream.
#
#   The six working bots were hand-provisioned across earlier waves. This script
#   is that hand work, written down and made idempotent.
#
# WHAT IT ASSUMES
#   Profile config already names the plugin (plugins.enabled contains
#   cozygateway). The gateway seed writes that at create time
#   (packages/gateway/src/hermes-bridge/blank-slate-seed.ts). A profile without
#   it is skipped rather than converted: opting a profile into the phone surface
#   is a decision, and this script executes decisions, it does not make them.
#
# IDEMPOTENCE
#   Every step is a check-then-act against real state, so a second run is a
#   no-op and a run interrupted halfway is repaired by the next one. In
#   particular an EXISTING token is never rotated: a profile that already has
#   COZYGATEWAY_TOKEN keeps it, which is what keeps the six live bots untouched
#   when the watcher sweeps every 30 seconds.
#
# SHADOW-DIR TRAP (repo memory: hermes-plugin-shadow-dir-gotcha)
#   Hermes loads ANY dir under plugins/ carrying a plugin.yaml, by manifest name
#   and scan-order luck, so a backup left inside plugins/ can silently win over
#   the real one. This script refuses to touch a plugins/ dir containing one.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The installer preserves this repository-relative layout in its staged
# payload. Do not change SRC_DIR back to the checkout: a LaunchAgent cannot read
# a checkout under ~/Documents because macOS TCC blocks background access.
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$REPO_ROOT/integrations/attach-plugin"

HERMES_HOME_ROOT="${HERMES_HOME_ROOT:-$HOME/.hermes}"
HERMES_BIN="${HERMES_BIN:-hermes}"
BOX_SSH="${BOX_SSH:-kmcdowell@192.168.99.106}"
BOX_REPO="${BOX_REPO:-/home/kmcdowell/cozygateway}"
BOX_CONFIG_REL="${BOX_CONFIG_REL:-docker/cozygateway.config.json}"
GATEWAY_URL="${GATEWAY_URL:-https://warm.cozylabs.ai}"
HOME_CHANNEL="${HOME_CHANNEL:-thread}"
INSTALLER_OWNER="${INSTALLER_OWNER:-cozylabs-v1}"
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-90}"
# Credentials a fresh profile inherits that only ONE gateway may hold at a time.
# See unclaim_inherited_platforms for what goes wrong when two do.
SINGLE_HOLDER_CREDENTIALS=(DISCORD_BOT_TOKEN)
DRY_RUN=0
SKIP_VERIFY=0
PROFILES=()

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
die()  { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<USAGE
usage: provision-bot.sh [options] <profile> [profile ...]

Binds a Hermes profile to the CozyGateway attach surface so its bot is
chattable from the phone: plugin sync, token mint, box config + env entry,
gateway recreate, per-profile launchd service, live verification.

Idempotent. Safe to re-run. Never rotates a token that already exists.

  -n, --dry-run          print every step, change nothing
  --no-verify            skip the live attach verification at the end
  --gateway-url URL      gateway base URL (default $GATEWAY_URL)
  --box HOST             ssh target for the gateway box (default $BOX_SSH)
  --box-repo DIR         repo checkout on the box (default $BOX_REPO)
  --hermes-home DIR      hermes home (default \$HERMES_HOME_ROOT or ~/.hermes)
  --verify-timeout SEC   how long to wait for the profile to attach (default $VERIFY_TIMEOUT)
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
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) die "unknown option: $1" ;;
    *) PROFILES+=("$1"); shift ;;
  esac
done
for arg in "$@"; do PROFILES+=("$arg"); done

[ "${#PROFILES[@]}" -gt 0 ] || { usage >&2; die "no profile named"; }
have python3 || die "python3 not found on PATH"
have openssl || die "openssl not found on PATH"
have rsync || die "rsync not found on PATH"
have ssh || die "ssh not found on PATH"
[ -d "$SRC_DIR" ] || die "plugin source not found: $SRC_DIR"

# The venv python is the one that certainly has PyYAML, because it is the
# interpreter Hermes itself runs under. Fall back to the system one so a
# --dry-run on a machine without a Hermes install still reports honestly.
PYTHON="$HERMES_HOME_ROOT/hermes-agent/venv/bin/python"
[ -x "$PYTHON" ] || PYTHON="$(command -v python3)"

# The env-var name the gateway config points at, derived the way the six live
# entries were: upper-cased, every non-alphanumeric run folded to one _.
token_env_name() {
  printf 'COZYGATEWAY_ATTACH_TOKEN_%s\n' \
    "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -c '[:alnum:]' '_' | sed 's/_*$//')"
}

# --- profile-side reads ---------------------------------------------------

# True when the profile's own config names the attach plugin. Parsed with YAML
# rather than grep because "is cozygateway in plugins.enabled" is a structural
# question and a grep for the bare name matches the disabled list just as well.
profile_wants_plugin() {
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
plugins = data.get("plugins") or {}
enabled = plugins.get("enabled") or []
sys.exit(0 if "cozygateway" in enabled else 1)
PY
}

# Reads one key out of an env file without ever echoing another one.
env_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 1
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

# Blanks the inherited credentials that only one gateway may hold.
#
#   THE THRASH THIS PREVENTS, observed live while building this script:
#   provcheck inherited cleo's DISCORD_BOT_TOKEN from the launch profile's
#   .env. Both gateways then claimed the same Discord session, each taking it
#   with an explicit --replace handoff that SIGTERMs the other, whose launchd
#   job restarts it and takes it back. The two processes ping-ponged every ~30
#   seconds, and each takeover tore down the attach adapter with it, so the new
#   bot reported connectivity_lost / attach_lost on every turn and a LIVE bot
#   was destabilised alongside it.
#
#   A bot created from the phone is a CozyGateway bot. It has no claim on the
#   launch profile's messaging accounts, so the inherited values are blanked
#   rather than left to fight. Blanked and not deleted, so the file still says
#   out loud that this was decided.
#
#   Only ever on a FIRST provisioning. A profile the box already knows may have
#   been given these credentials deliberately since, and taking them back on a
#   30-second sweep would be the provisioner picking its own fight.
unclaim_inherited_platforms() {
  local file="$1" key value
  for key in "${SINGLE_HOLDER_CREDENTIALS[@]}"; do
    value="$(env_value "$file" "$key" || true)"
    [ -n "$value" ] || continue
    say "  unclaiming inherited $key (only one gateway may hold it)"
    set_env_line "$file" "$key" ""
  done
}

# Whether the box's .env already names this profile's token env var, which is
# the only durable record of "this profile has been provisioned before".
box_knows_profile() {
  ssh -o BatchMode=yes "$BOX_SSH" "grep -q '^${1}=' '$BOX_REPO/.env'" 2>/dev/null
}

check_shadow_dir() {
  local plugins_dir="$1" entry
  [ -d "$plugins_dir" ] || return 0
  for entry in "$plugins_dir"/*.pre-* "$plugins_dir"/*.bak*; do
    [ -d "$entry" ] || continue
    die "shadow-dir trap: backup dir inside plugins/: $entry
      Hermes loads any dir under plugins/ with a matching plugin.yaml name, by
      scan-order luck, so this backup can silently win over the real plugin.
      Move it OUTSIDE plugins/ and re-run."
  done
}

# --- steps ----------------------------------------------------------------

sync_plugin() {
  local dest="$1"
  if [ "$DRY_RUN" = 1 ]; then say "  DRY  rsync $SRC_DIR/ -> $dest/"; return 0; fi
  mkdir -p "$dest"
  rsync -a --delete \
    --exclude '__pycache__/' --exclude '.pytest_cache/' --exclude '*.pyc' \
    "$SRC_DIR/" "$dest/"
  find "$dest" -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true
  say "  plugin synced -> $dest"
}

# Appends KEY=VALUE only when KEY is absent, so a re-run never rotates a secret
# and never leaves a duplicate line for the loader to pick between.
ensure_env_line() {
  local file="$1" key="$2" value="$3"
  if [ -f "$file" ] && grep -q "^${key}=" "$file"; then
    say "  env $key already set, left alone"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then say "  DRY  append $key to $file"; return 0; fi
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || : > "$file"
  # A file not ending in a newline would otherwise glue two vars together.
  [ -s "$file" ] && [ "$(tail -c 1 "$file")" != "" ] && printf '\n' >> "$file"
  printf '%s=%s\n' "$key" "$value" >> "$file"
  chmod 600 "$file"
  say "  env $key written"
}

# Upsert. For the handful of values that must be EXACTLY right rather than
# merely present, because a fresh profile arrives holding a copy of the launch
# profile's .env and an inherited value there is wrong, not pre-existing.
set_env_line() {
  local file="$1" key="$2" value="$3"
  if [ -f "$file" ] && [ "$(env_value "$file" "$key" || true)" = "$value" ]; then
    say "  env $key already correct"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then say "  DRY  set $key in $file"; return 0; fi
  mkdir -p "$(dirname "$file")"
  [ -f "$file" ] || : > "$file"
  local tmp="$file.provision-tmp"
  grep -v "^${key}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
  say "  env $key set"
}

# Same append-if-absent rule, over ssh, against the box's .env.
ensure_box_env_line() {
  local key="$1" value="$2"
  if ssh -o BatchMode=yes "$BOX_SSH" "grep -q '^${key}=' '$BOX_REPO/.env'" 2>/dev/null; then
    say "  box env $key already set, left alone"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then say "  DRY  append $key to $BOX_SSH:$BOX_REPO/.env"; return 0; fi
  # The value goes in on stdin, never on the command line, so it stays out of
  # the remote process table and out of any shell history.
  printf '%s\n' "$value" | ssh -o BatchMode=yes "$BOX_SSH" \
    "read -r v; printf '%s=%s\n' '$key' \"\$v\" >> '$BOX_REPO/.env'"
  say "  box env $key written"
}

# Inserts hermes.profiles.<name> = {tokenEnv} if absent. A json edit rather
# than a text append because the file is a single object and a sed would have
# to guess at formatting; python rewrites it whole and stays valid either way.
ensure_box_config_entry() {
  local profile="$1" env_name="$2"
  if [ "$DRY_RUN" = 1 ]; then
    say "  DRY  ensure hermes.profiles.$profile.tokenEnv=$env_name in $BOX_CONFIG_REL"
    return 0
  fi
  local out
  out="$(ssh -o BatchMode=yes "$BOX_SSH" \
    "python3 - '$BOX_REPO/$BOX_CONFIG_REL' '$profile' '$env_name'" <<'PY'
import json, sys
path, profile, env_name = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as fh:
    data = json.load(fh)
profiles = data.setdefault("hermes", {}).setdefault("profiles", {})
if profiles.get(profile, {}).get("tokenEnv") == env_name:
    print("already present")
    sys.exit(0)
profiles[profile] = {"tokenEnv": env_name}
tmp = path + ".provision-tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
import os
os.replace(tmp, path)
print("inserted")
PY
)"
  say "  box config entry: $out"
}

recreate_box_gateway() {
  if [ "$DRY_RUN" = 1 ]; then say "  DRY  docker compose up -d gateway on $BOX_SSH"; return 0; fi
  # up -d, not --build: the image is unchanged, only the env and the mounted
  # config moved, and a recreate is what re-reads both.
  ssh -o BatchMode=yes "$BOX_SSH" "cd '$BOX_REPO' && docker compose up -d gateway" >/dev/null
  say "  box gateway recreated"
}

# Two separate facts, checked separately: whether the plist EXISTS and whether
# launchd has it LOADED.
#
#   `hermes gateway install` is a no-op when the plist is already on disk, so a
#   profile whose service was booted out (a previous run, a manual stop, an
#   uninstall that left the file) gets a cheerful "installed" and stays dead.
#   Observed live: install reported success, launchctl print reported nothing,
#   and the attach never came up. So the load is asserted here rather than
#   assumed from the installer's exit code.
ensure_service() {
  local profile="$1"
  local label="ai.hermes.gateway-$profile"
  local plist="$HOME/Library/LaunchAgents/$label.plist"

  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    say "  service $label already loaded"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "  DRY  install and bootstrap $label"
    return 0
  fi

  if [ ! -f "$plist" ]; then
    "$HERMES_BIN" --profile "$profile" gateway install --start-now --start-on-login >/dev/null
    say "  service $label installed"
  fi
  [ -f "$plist" ] || die "[$profile] gateway install left no plist at $plist"

  if ! launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    launchctl bootstrap "gui/$(id -u)" "$plist"
    say "  service $label bootstrapped"
  fi
  launchctl kickstart "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 \
    || die "[$profile] $label still not loaded after bootstrap"
  say "  service $label running"
}

# The only proof that matters: the box says this profile negotiated an attach
# hello. /ready alone would only say the fleet count moved, which a concurrent
# reconnect could also explain.
verify_attached() {
  local profile="$1" deadline
  if [ "$DRY_RUN" = 1 ] || [ "$SKIP_VERIFY" = 1 ]; then
    say "  (verification skipped)"
    return 0
  fi
  deadline=$(( $(date +%s) + VERIFY_TIMEOUT ))
  while :; do
    if ssh -o BatchMode=yes "$BOX_SSH" \
      "docker logs --since 10m cozygateway-gateway-1 2>&1 | grep -q 'attach-v1: profile \"$profile\" negotiated hello'"; then
      say "  VERIFIED: box logged an attach hello for \"$profile\""
      curl -fsS --max-time 5 "$GATEWAY_URL/ready" 2>/dev/null \
        | "$PYTHON" -c 'import json,sys; a=json.load(sys.stdin).get("attach",{}); print("  ready: attach.configured=%s online=%s" % (a.get("configured"), a.get("online")))' \
        2>/dev/null || true
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      warn "[$profile] no attach hello in the box log within ${VERIFY_TIMEOUT}s"
      return 1
    fi
    sleep 5
  done
}

# --- main -----------------------------------------------------------------

overall_rc=0
for profile in "${PROFILES[@]}"; do
  say ""
  say "=== $profile ==="
  profile_dir="$HERMES_HOME_ROOT/profiles/$profile"

  if [ ! -d "$profile_dir" ]; then
    warn "[$profile] no profile dir at $profile_dir, skipping"
    overall_rc=1
    continue
  fi

  rc=0
  profile_wants_plugin "$profile_dir" || rc=$?
  if [ "$rc" = 2 ]; then
    die "no PyYAML available to $PYTHON, cannot read profile config safely"
  elif [ "$rc" != 0 ]; then
    say "  config.yaml does not list cozygateway in plugins.enabled, skipping"
    continue
  fi

  check_shadow_dir "$profile_dir/plugins"

  sync_plugin "$profile_dir/plugins/cozygateway"

  env_file="$profile_dir/.env"
  env_name="$(token_env_name "$profile")"
  say "  box token env var: $env_name"

  # WHOSE TOKEN IS THIS?
  #   A fresh Hermes profile arrives holding a COPY of the launch profile's
  #   .env, and that copy already contains a COZYGATEWAY_TOKEN. It is not this
  #   profile's: it is the one it was cloned from, and every bot created this
  #   way would inherit the SAME one and attach as the same identity. So the
  #   presence of a token locally proves nothing.
  #
  #   The box is the authority. If it already names a token env var for this
  #   profile, this profile has been provisioned before and its local token is
  #   the real one, which is what keeps a 30-second sweep from rotating the six
  #   live bots out from under themselves. If it does not, whatever is in the
  #   file is inherited and gets replaced by a freshly minted one.
  if box_knows_profile "$env_name"; then
    token="$(env_value "$env_file" COZYGATEWAY_TOKEN || true)"
    [ -n "$token" ] || die "[$profile] the box names $env_name but $env_file holds no token"
    say "  already known to the box, keeping this profile's token"
  else
    # Same shape as the six live tokens: 32 random bytes, hex.
    token="$(openssl rand -hex 32)"
    say "  first provisioning, minted a fresh attach token"
    unclaim_inherited_platforms "$env_file"
  fi

  ensure_env_line "$env_file" COZYGATEWAY_URL "$GATEWAY_URL"
  ensure_env_line "$env_file" COZYGATEWAY_HOME_CHANNEL "$HOME_CHANNEL"
  ensure_env_line "$env_file" COZYGATEWAY_INSTALLER_OWNER "$INSTALLER_OWNER"
  set_env_line "$env_file" COZYGATEWAY_TOKEN "$token"
  # Upserted, not merely ensured: the inherited copy points at the GLOBAL spool
  # (~/.hermes/plugin-data/...), so two profiles that both kept it would read
  # and ack each other's events out of one file.
  set_env_line "$env_file" COZYGATEWAY_SPOOL_PATH \
    "$profile_dir/plugin-data/cozygateway/attach-v1.sqlite"
  ensure_box_env_line "$env_name" "$token"
  ensure_box_config_entry "$profile" "$env_name"
  recreate_box_gateway
  ensure_service "$profile"
  verify_attached "$profile" || overall_rc=1
done

say ""
if [ "$overall_rc" = 0 ]; then say "provision-bot: all profiles provisioned"; fi
exit "$overall_rc"

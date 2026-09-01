#!/usr/bin/env bash
# Stage and install the macOS bot provisioner outside TCC-protected folders.
#
# Run this manually from the checkout. Terminal has access to ~/Documents;
# launchd does not. The installed LaunchAgent executes only the staged payload.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGE_ROOT="${COZY_PROVISIONER_HOME:-$HOME/Library/Application Support/cozylabs/provisioner}"
PLIST_TEMPLATE="$REPO_ROOT/docs/ai.cozylabs.bot-provisioner.plist"
LABEL="ai.cozylabs.bot-provisioner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOAD=1

say() { printf '%s\n' "$*"; }
die() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
usage() {
  cat <<USAGE
usage: scripts/install-bot-provisioner.sh [--stage-dir DIR] [--no-load]

Copies the complete runtime payload to a TCC-free per-user directory, installs
its LaunchAgent, and reloads it in the current Aqua user session.

  --stage-dir DIR  payload root (default: $STAGE_ROOT)
  --no-load        stage and render the plist without calling launchctl

Re-run this same command after updating the checkout to refresh the staged copy.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage-dir) [ "$#" -ge 2 ] || die "--stage-dir needs a value"; STAGE_ROOT="$2"; shift 2 ;;
    --no-load) LOAD=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$STAGE_ROOT" in
  "") die "stage directory must not be empty" ;;
  /|"$HOME") die "stage directory must be a dedicated subdirectory" ;;
  /*) ;;
  *) STAGE_ROOT="$(pwd -P)/$STAGE_ROOT" ;;
esac

have rsync || die "rsync not found"
[ -n "${HERMES_BIN:-}" ] || HERMES_BIN="$(command -v hermes || true)"
[ -n "$HERMES_BIN" ] || die "hermes not found; install Hermes or set HERMES_BIN to its executable"
case "$HERMES_BIN" in
  /*) ;;
  *) HERMES_BIN="$(cd "$(dirname "$HERMES_BIN")" && pwd)/$(basename "$HERMES_BIN")" ;;
esac
[ -x "$HERMES_BIN" ] || die "Hermes executable is not runnable: $HERMES_BIN"
validate_plist() {
  if [ -x /usr/bin/plutil ]; then
    /usr/bin/plutil -lint "$1" >/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import plistlib, sys; plistlib.load(open(sys.argv[1], "rb"))' "$1"
  else
    die "neither /usr/bin/plutil nor python3 is available to validate the LaunchAgent"
  fi
}
[ -f "$SCRIPT_DIR/bot-provisioner-watch.sh" ] || die "watcher missing from checkout"
[ -f "$SCRIPT_DIR/provision-bot.sh" ] || die "provisioner missing from checkout"
[ -d "$REPO_ROOT/integrations/attach-plugin" ] || die "attach plugin missing from checkout"
[ -f "$PLIST_TEMPLATE" ] || die "LaunchAgent template missing from checkout"

umask 077
# Resolve symlinks before enforcing the TCC boundary. A custom path that merely
# points into Documents is just as protected as a lexical Documents path.
mkdir -p "$STAGE_ROOT"
STAGE_ROOT="$(cd -P "$STAGE_ROOT" && pwd)"
HOME_REAL="$(cd -P "$HOME" && pwd)"
case "$STAGE_ROOT" in
  "$HOME_REAL"|"$HOME_REAL/Documents"|"$HOME_REAL/Documents/"*|\
  "$HOME_REAL/Desktop"|"$HOME_REAL/Desktop/"*|\
  "$HOME_REAL/Downloads"|"$HOME_REAL/Downloads/"*)
    die "stage directory must be outside macOS TCC-protected user folders: $STAGE_ROOT" ;;
esac

install_lock="$STAGE_ROOT/.install.lock"
if ! mkdir "$install_lock" 2>/dev/null; then
  old_pid="$(sed -n '1p' "$install_lock/pid" 2>/dev/null || true)"
  case "$old_pid" in ''|*[!0-9]*) old_pid="" ;; esac
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    die "another provisioner install is running (pid $old_pid)"
  fi
  rm -rf "$install_lock"
  mkdir "$install_lock" 2>/dev/null || die "could not acquire installer lock"
fi
printf '%s\n' "$$" > "$install_lock/pid"

release_name="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
releases="$STAGE_ROOT/releases"
staging="$releases/.staging-$release_name"
release="$releases/$release_name"
current="$STAGE_ROOT/current"
next="$STAGE_ROOT/.current-$release_name"
plist_tmp="$PLIST.tmp.$$"
cleanup() { rm -rf "$staging" "$next"; rm -f "$plist_tmp"; rm -rf "$install_lock"; }
trap cleanup EXIT

mkdir -p "$staging/scripts" "$staging/integrations/attach-plugin" "$(dirname "$PLIST")"
rsync -a "$SCRIPT_DIR/bot-provisioner-watch.sh" "$SCRIPT_DIR/provision-bot.sh" "$staging/scripts/"
rsync -a --delete \
  --exclude '__pycache__/' --exclude '.pytest_cache/' --exclude '*.pyc' \
  "$REPO_ROOT/integrations/attach-plugin/" "$staging/integrations/attach-plugin/"
chmod 700 "$staging/scripts/bot-provisioner-watch.sh" "$staging/scripts/provision-bot.sh"
{
  printf 'STAGED_AT_UTC=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'SOURCE_REPO=%s\n' "$REPO_ROOT"
  if have git && git -C "$REPO_ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
    printf 'SOURCE_REVISION=%s\n' "$(git -C "$REPO_ROOT" rev-parse HEAD)"
    if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
      printf 'SOURCE_DIRTY=1\n'
    else
      printf 'SOURCE_DIRTY=0\n'
    fi
  else
    printf 'SOURCE_REVISION=unknown\n'
    printf 'SOURCE_DIRTY=unknown\n'
  fi
} > "$staging/STAGED_FROM"
mv "$staging" "$release"

# Render and validate before disturbing the currently loaded agent. XML-escape
# the path first, then escape sed replacement metacharacters.
xml_stage="$(printf '%s' "$STAGE_ROOT" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
escaped_stage="$(printf '%s' "$xml_stage" | sed 's/[&|]/\\&/g')"
xml_hermes="$(printf '%s' "$HERMES_BIN" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
escaped_hermes="$(printf '%s' "$xml_hermes" | sed 's/[&|]/\\&/g')"
hermes_dir="$(dirname "$HERMES_BIN")"
xml_hermes_dir="$(printf '%s' "$hermes_dir" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
escaped_hermes_dir="$(printf '%s' "$xml_hermes_dir" | sed 's/[&|]/\\&/g')"
sed -e "s|REPLACE_ME_PAYLOAD|$escaped_stage|g" \
    -e "s|REPLACE_ME_HERMES_BIN|$escaped_hermes|g" \
    -e "s|REPLACE_ME_HERMES_DIR|$escaped_hermes_dir|g" \
    "$PLIST_TEMPLATE" > "$plist_tmp"
validate_plist "$plist_tmp"

# A relative target keeps the symlink valid if the provisioner tree is copied as
# a unit. Renaming the prepared symlink makes refresh atomic for future starts;
# BSD mv's -h prevents dereferencing the existing current directory symlink.
ln -s "releases/$release_name" "$next"
if mv --help 2>&1 | grep -q -- '--no-target-directory'; then
  mv -fT "$next" "$current"
else
  # BSD mv follows a destination symlink unless -h is present.
  mv -fh "$next" "$current"
fi
mv "$plist_tmp" "$PLIST"

if [ "$LOAD" = 1 ]; then
  uid="$(id -u)"
  launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$uid" "$PLIST"
  launchctl kickstart "gui/$uid/$LABEL"
  launchctl print "gui/$uid/$LABEL" >/dev/null \
    || die "LaunchAgent did not load: $LABEL"
fi

# The old payload cannot be in use after bootout. Keep only current so repeated
# loaded refreshes do not grow this directory forever. With --no-load, retain
# old releases because an already-running agent may still refer to one.
if [ "$LOAD" = 1 ]; then
  for old in "$releases"/*; do
    [ -d "$old" ] || continue
    [ "$old" = "$release" ] || rm -rf "$old"
  done
fi

say "Bot provisioner staged at $current"
say "LaunchAgent installed at $PLIST"
if [ "$LOAD" = 1 ]; then
  say "LaunchAgent loaded: gui/$(id -u)/$LABEL"
else
  say "LaunchAgent load skipped (--no-load)"
fi
say "Refresh after a checkout update by re-running: scripts/install-bot-provisioner.sh"

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
[ -f "$SCRIPT_DIR/deprovision-bot.sh" ] || die "deprovisioner missing from checkout"
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

# Upgrade ownership is structural, not a label/prefix guess. Legacy staged
# releases have STAGED_FROM but may lack the deprovision helper; they are the
# exact old shape this migration repairs. Unknown stages/services stay intact.
have python3 || die "python3 is required to validate installed provisioner ownership"
prior_target="$(python3 - "$STAGE_ROOT" "$PLIST" "$LABEL" <<'PYOWN'
import os, plistlib, re, sys
from pathlib import Path
root, plist, label = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
def regular(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_uid != os.getuid():
        raise ValueError("unowned file")
def metadata(release):
    regular(release / "STAGED_FROM")
    values = {}
    for line in (release / "STAGED_FROM").read_text().splitlines():
        key, sep, value = line.partition("=")
        if not sep or key in values:
            raise ValueError("invalid staging metadata")
        values[key] = value
    if not re.fullmatch(r"[a-f0-9]{40}|unknown", values.get("SOURCE_REVISION", "")) or not values.get("SOURCE_REPO", "").startswith("/"):
        raise ValueError("missing source identity")
    for name in ("bot-provisioner-watch.sh", "provision-bot.sh"):
        regular(release / "scripts" / name)
    if (release / "scripts").is_symlink() or (release / "integrations").is_symlink() or (release / "integrations/attach-plugin").is_symlink() or not (release / "integrations/attach-plugin").is_dir():
        raise ValueError("redirected payload")
    return values
try:
    if root.stat().st_uid != os.getuid() or (root / "releases").is_symlink():
        raise ValueError("unowned staging root")
    current = root / "current"
    target = ""
    values = None
    if current.exists() or current.is_symlink():
        if not current.is_symlink():
            raise ValueError("current is not a staged symlink")
        target = os.readlink(current)
        if not re.fullmatch(r"releases/[0-9]{8}T[0-9]{6}Z-[0-9]+", target):
            raise ValueError("unknown release target")
        release = root / target
        if release.is_symlink() or not release.is_dir():
            raise ValueError("redirected release")
        values = metadata(release)
    if plist.exists() or plist.is_symlink():
        regular(plist)
        data = plistlib.loads(plist.read_bytes())
        allowed = [str(root / "current/scripts/bot-provisioner-watch.sh")]
        if values:
            allowed += [str(root / target / "scripts/bot-provisioner-watch.sh"), values["SOURCE_REPO"] + "/scripts/bot-provisioner-watch.sh"]
        args = data.get("ProgramArguments")
        if not values or data.get("Label") != label or not isinstance(args, list) or len(args) != 2 or args[0] != "/bin/bash" or args[1] not in allowed:
            raise ValueError("service ownership mismatch")
        expected_cwd = str(Path(args[1]).parent.parent)
        if data.get("WorkingDirectory") != expected_cwd:
            raise ValueError("service working directory mismatch")
    print(target)
except Exception:
    print("Installed provisioner ownership is ambiguous; existing payload and service were preserved. Inspect the configured stage and LaunchAgent before retrying this installer.", file=sys.stderr)
    sys.exit(1)
PYOWN
)" || die "automatic provisioner repair stopped safely"

# The kernel owns lock lifetime, including a killed installer. Legacy mkdir
# locks are left untouched and cannot prevent a newer repair from running.
install_lock="$STAGE_ROOT/.install-advisory.lock"
if [ "${COZY_PROVISIONER_INSTALL_LOCK_PID:-}" != "$$" ]; then
  [ ! -L "$install_lock" ] || die "refusing redirected installer lock"
  exec 8>>"$install_lock"
  export COZY_PROVISIONER_INSTALL_LOCK_PID="$$" HERMES_BIN
  exec python3 - "$SCRIPT_DIR/install-bot-provisioner.sh" "$STAGE_ROOT" "$LOAD" <<'PYLOCK'
import fcntl, os, sys
try:
    fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("FAIL  another provisioner install is running; retry after it finishes", file=sys.stderr)
    sys.exit(1)
os.set_inheritable(8, True)
args = ["/bin/bash", sys.argv[1], "--stage-dir", sys.argv[2]]
if sys.argv[3] == "0":
    args.append("--no-load")
os.execv(args[0], args)
PYLOCK
fi
: >&8

release_name="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
releases="$STAGE_ROOT/releases"
staging="$releases/.staging-$release_name"
release="$releases/$release_name"
current="$STAGE_ROOT/current"
next="$STAGE_ROOT/.current-$release_name"
plist_tmp="$PLIST.tmp.$$"
prior_plist="$STAGE_ROOT/.prior-plist-$release_name"
[ ! -f "$PLIST" ] || cp -p "$PLIST" "$prior_plist"
cleanup() { rm -rf "$staging" "$next"; rm -f "$plist_tmp" "$prior_plist"; }
trap cleanup EXIT

mkdir -p "$staging/scripts" "$staging/integrations/attach-plugin" "$(dirname "$PLIST")"
rsync -a "$SCRIPT_DIR/bot-provisioner-watch.sh" "$SCRIPT_DIR/provision-bot.sh" "$SCRIPT_DIR/deprovision-bot.sh" "$staging/scripts/"
rsync -a --delete \
  --exclude '__pycache__/' --exclude '.pytest_cache/' --exclude '*.pyc' \
  "$REPO_ROOT/integrations/attach-plugin/" "$staging/integrations/attach-plugin/"
chmod 700 "$staging/scripts/bot-provisioner-watch.sh" "$staging/scripts/provision-bot.sh" "$staging/scripts/deprovision-bot.sh"
{
  printf 'INSTALL_HYGIENE_PROTOCOL=1\n'
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
  if ! launchctl bootstrap "gui/$uid" "$PLIST" \
    || ! launchctl kickstart "gui/$uid/$LABEL" \
    || ! launchctl print "gui/$uid/$LABEL" >/dev/null; then
    # Roll back only the previously verified payload/service. Keep both release
    # directories, so an interrupted repair never consumes its recovery copy.
    launchctl bootout "gui/$uid/$LABEL" >/dev/null 2>&1 || true
    if [ -n "$prior_target" ]; then
      ln -s "$prior_target" "$next"
      if mv --help 2>&1 | grep -q -- '--no-target-directory'; then mv -fT "$next" "$current"; else mv -fh "$next" "$current"; fi
    fi
    if [ -f "$prior_plist" ]; then
      cp -p "$prior_plist" "$PLIST"
      launchctl bootstrap "gui/$uid" "$PLIST" >/dev/null 2>&1 || true
    fi
    die "provisioner activation failed; prior owned configuration was restored when available and release copies were retained. Retry scripts/install-bot-provisioner.sh from this release"
  fi
fi

# Retired releases are recovery payloads, not live state. Preserve them rather
# than deleting directories from a caller-selected stage root by glob/prefix.
# The verified current symlink is the sole execution target for future sweeps.

say "Bot provisioner staged at $current"
say "LaunchAgent installed at $PLIST"
if [ "$LOAD" = 1 ]; then
  say "LaunchAgent loaded: gui/$(id -u)/$LABEL"
else
  say "LaunchAgent load skipped (--no-load)"
fi
say "Refresh after a checkout update by re-running: scripts/install-bot-provisioner.sh"

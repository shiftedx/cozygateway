#!/usr/bin/env bash
#
# agent-install.sh: the mechanical half of docs/agent-install.md.
#
# This is a TOOL for the installing agent, not a replacement for the playbook. It does the parts
# that are pure mechanism (clone, hash a password, merge dashboard.basic_auth, write a gateway
# config, start things, mint a pairing code) and it prints a loud, checkable line for every one of
# them. The agent still reads docs/agent-install.md, still runs the verification commands there,
# and still decides what to do when a check fails.
#
# Every phase is idempotent: re-running the script on a half-finished box finishes it, and
# re-running it on a finished box changes nothing.
#
# What it writes, and nothing else:
#   - <gateway-dir>/local/*            everything generated, git-ignored, mode 600
#   - <gateway-dir>/.env               MERGED key by key. It only ever adds or updates the three
#                                      keys it owns (COZYGATEWAY_ATTACH_TOKEN,
#                                      COZYGATEWAY_HERMES_PASSWORD, COZYGATEWAY_PORT). Every other
#                                      line, including APNS_* and COZY_RELAY_PORT for the relay,
#                                      is preserved byte for byte.
#   - <hermes-home>/config.yaml        MERGED (never replaced) after a timestamped backup. The
#                                      whole file is reserialized by the YAML parser, so comments
#                                      and anchors do not survive; the backup does.
#
# Usage:
#   bash scripts/agent-install.sh --dry-run
#   bash scripts/agent-install.sh
#
# Flags: --help prints them all.
#
# State for the playbook: every value a later step of docs/agent-install.md needs is written to
# <gateway-dir>/local/install-env.sh (mode 600) and <gateway-dir>/local/dashboard-credentials.txt
# (mode 600). The playbook sources those files; it never relies on a shell variable surviving
# between commands, because an agent runs each command in a fresh shell.
#
set -euo pipefail

# ---------------------------------------------------------------------------- defaults

DRY_RUN=0
GATEWAY_DIR="${COZYGATEWAY_DIR:-$HOME/cozygateway}"
REPO_URL="${COZYGATEWAY_REPO:-https://github.com/shiftedx/cozygateway.git}"
HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
# Empty means "decide from the runtime in the preflight". Loopback is the default everywhere it
# works; anything wider has to be asked for.
DASHBOARD_HOST=""
EXPOSE_DASHBOARD_LAN=0
DASHBOARD_PORT="9119"
GATEWAY_PORT="8787"
BRIDGE_USER="cozybridge"
BRIDGE_PASSWORD=""
RUNTIME="auto"
RUNTIME_EXPLICIT=""
# The no-docker, no-clone path: a prebuilt single-file gateway (dist-bundle/cozygateway.mjs, built
# by `pnpm bundle`) run straight by node. Empty means the bundle runtime was not asked for.
BUNDLE_PATH=""
COZY_NODE="${COZYGATEWAY_NODE:-node}"
HIDDEN_PROFILES="default"
GATEWAY_NAME="cozy-bots"
SKIP_DASHBOARD=0
NO_START=0
PAIR_ONLY=0
# Supervision. nohup gives a process that dies with the terminal and never comes back after a
# crash or a reboot; --service hands the same two processes to the OS service manager instead.
SERVICE=0
UNINSTALL_SERVICE=0

usage() {
  cat <<'USAGE'
usage: bash scripts/agent-install.sh [flags]

  --dry-run                 print every action, change nothing
  --gateway-dir DIR         where the repo lives / is cloned (default: $HOME/cozygateway)
  --repo URL                git remote to clone (default: the public cozygateway repo)
  --hermes-home DIR         Hermes home holding config.yaml (default: $HERMES_HOME or ~/.hermes)
  --dashboard-host HOST     dashboard bind host (default: 127.0.0.1, or the docker bridge address
                            on the docker path; auth is mandatory off loopback)
  --expose-dashboard-lan    bind the dashboard to 0.0.0.0. This publishes the human's whole Hermes
                            dashboard (config, API keys, sessions) to the LAN over plaintext HTTP
                            behind basic auth. Needed only when the gateway runs on a DIFFERENT
                            machine than Hermes, or on Docker Desktop, where a container cannot
                            reach the host's loopback.
  --dashboard-port PORT     dashboard port (default: 9119)
  --gateway-port PORT       gateway port (default: 8787)
  --username NAME           dashboard/bridge username (default: cozybridge)
  --password VALUE          dashboard password (default: generated, '$'-free)
  --hidden-profiles A,B     Hermes profiles kept off the bots roster (default: default)
  --gateway-name NAME       gateway display name (default: cozy-bots)
  --runtime docker|node|bundle
                            force a runtime (default: auto, docker when present)
  --bundle PATH             run a prebuilt single-file gateway (dist-bundle/cozygateway.mjs) at
                            PATH instead of cloning and building. Implies --runtime bundle; needs
                            node 24+ (set COZYGATEWAY_NODE to name a different node) and no pnpm.
  --skip-dashboard          do not touch config.yaml and do not start `hermes dashboard`
  --no-start                configure everything, start nothing
  --pair-only               skip straight to minting a pairing code against a running gateway
  --service                 supervise the gateway (and the dashboard, unless --skip-dashboard)
                            with the OS service manager instead of nohup, so both survive a crash,
                            a logout and a reboot. macOS: launchd LaunchAgents. Linux: systemd
                            --user units. Not for --runtime docker, which supervises itself.
  --uninstall-service       stop and remove the service units this script installed, print what
                            went, and exit. Needs neither hermes nor docker.
  -h, --help                this text

Everything it generates lands in <gateway-dir>/local (git-ignored) plus <gateway-dir>/.env.
USAGE
}

# need_value: a value-taking flag given last would otherwise hit "$2" under `set -u` and abort with
# bash's own `unbound variable`, which reads like a bug in the script rather than a usage error.
need_value() { [ "$2" -ge 2 ] || { printf 'FAIL  %s needs a value\n' "$1" >&2; usage >&2; exit 2; }; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --gateway-dir) need_value "$1" $#; GATEWAY_DIR="$2"; shift ;;
    --repo) need_value "$1" $#; REPO_URL="$2"; shift ;;
    --hermes-home) need_value "$1" $#; HERMES_HOME_DIR="$2"; shift ;;
    --dashboard-host) need_value "$1" $#; DASHBOARD_HOST="$2"; shift ;;
    --expose-dashboard-lan) EXPOSE_DASHBOARD_LAN=1 ;;
    --dashboard-port) need_value "$1" $#; DASHBOARD_PORT="$2"; shift ;;
    --gateway-port) need_value "$1" $#; GATEWAY_PORT="$2"; shift ;;
    --username) need_value "$1" $#; BRIDGE_USER="$2"; shift ;;
    --password) need_value "$1" $#; BRIDGE_PASSWORD="$2"; shift ;;
    --hidden-profiles) need_value "$1" $#; HIDDEN_PROFILES="$2"; shift ;;
    --gateway-name) need_value "$1" $#; GATEWAY_NAME="$2"; shift ;;
    --runtime) need_value "$1" $#; RUNTIME="$2"; RUNTIME_EXPLICIT="$2"; shift ;;
    --bundle)
      need_value "$1" $#
      # An EMPTY value is not the same as no flag at all. Left alone it reads as "--bundle was
      # never passed", RUNTIME stays auto, and the run quietly clones and builds under docker:
      # the opposite of what was asked for, with nothing said out loud.
      [ -n "$2" ] || { printf 'FAIL  --bundle needs a path, got an empty value\n' >&2; exit 2; }
      BUNDLE_PATH="$2"; shift ;;
    --skip-dashboard) SKIP_DASHBOARD=1 ;;
    --no-start) NO_START=1 ;;
    --pair-only) PAIR_ONLY=1 ;;
    --service) SERVICE=1 ;;
    --uninstall-service) UNINSTALL_SERVICE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# --bundle IS the runtime choice, so it forces RUNTIME=bundle. Saying both and disagreeing is a
# typo worth stopping for, not something to silently resolve one way or the other.
if [ -n "$BUNDLE_PATH" ]; then
  if [ -n "$RUNTIME_EXPLICIT" ] && [ "$RUNTIME_EXPLICIT" != "bundle" ]; then
    printf 'FAIL  --bundle implies --runtime bundle, but --runtime %s was also given\n' \
      "$RUNTIME_EXPLICIT" >&2
    exit 2
  fi
  RUNTIME="bundle"
elif [ "$RUNTIME" = "bundle" ]; then
  printf 'FAIL  --runtime bundle needs --bundle PATH naming the prebuilt cozygateway.mjs\n' >&2
  exit 2
fi

for pair in "--gateway-port:$GATEWAY_PORT" "--dashboard-port:$DASHBOARD_PORT"; do
  flag="${pair%%:*}"; value="${pair#*:}"
  case "$value" in
    ''|*[!0-9]*) printf 'FAIL  %s must be a number, got %s\n' "$flag" "$value" >&2; exit 2 ;;
  esac
  [ "$value" -ge 1 ] && [ "$value" -le 65535 ] || {
    printf 'FAIL  %s must be 1-65535, got %s\n' "$flag" "$value" >&2; exit 2; }
done

# Does THIS install start the dashboard, or does it only point at somebody else's?
#
# The distinction has teeth at uninstall time. --skip-dashboard means the operator owns the
# dashboard and merely told us its port; --no-start and --pair-only start nothing at all. In every
# one of those cases the dashboard on $DASHBOARD_PORT is a stranger's, and anything this script does
# to it is vandalism. The answer is knowable here, from the flags alone, so it is recorded in
# install-env.sh rather than re-guessed later from a port that cannot tell you who owns it.
DASHBOARD_OWNED=1
if [ "$SKIP_DASHBOARD" = "1" ] || [ "$NO_START" = "1" ] || [ "$PAIR_ONLY" = "1" ]; then
  DASHBOARD_OWNED=0
fi

LOCAL_DIR="$GATEWAY_DIR/local"
CONFIG_JSON="$LOCAL_DIR/cozygateway.config.json"
ENV_FILE="$GATEWAY_DIR/.env"
CRED_FILE="$LOCAL_DIR/dashboard-credentials.txt"
# Every value the playbook's later steps need, in a form a fresh shell can `.` (source).
INSTALL_ENV="$LOCAL_DIR/install-env.sh"
DASH_LOG="$LOCAL_DIR/hermes-dashboard.log"
GW_LOG="$LOCAL_DIR/cozygateway.log"
OVERRIDE_REL="docker/agent-install.override.yml"

# ---------------------------------------------------------------------------- output helpers

step() { printf '\n==> %s\n' "$*"; }
ok()   { printf 'OK    %s\n' "$*"; }
info() { printf '      %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
die()  { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

# run: execute a command, or narrate it under --dry-run.
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'DRY   %s\n' "$*"
    return 0
  fi
  "$@"
}

# dry: true when a later step depends on the effect of a skipped one.
dry() { [ "$DRY_RUN" = "1" ]; }

have() { command -v "$1" >/dev/null 2>&1; }

# port_listening PORT: is anything holding a listening socket on it. The honest question when the
# question is "can a unit bind this", which HTTP health cannot answer: a socket in the wrong state,
# or a process wedged after its HTTP stack died, still keeps the next bind out.
port_listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# ---------------------------------------------------------------------------- supervision
#
# --service replaces the nohup starts in phases 5 and 7 with real OS-supervised units. The unit
# never carries the dashboard password: unit files and launchd plists are world-readable, so each
# unit execs a WRAPPER in $LOCAL_DIR (mode 700) that sources $INSTALL_ENV and reads the password out
# of the mode-600 credentials file at exec time.
#
# The wrapper also cannot rely on this shell's PATH. launchd hands a job /usr/bin:/bin:/usr/sbin:
# /sbin and nothing else, so `hermes` and a Homebrew `node` are both absent there; every interpreter
# and binary the wrappers exec is therefore resolved to an absolute path at WRITE time.

# Binding names. macOS reverse-DNS labels, Linux unit filenames; they are what --uninstall-service
# looks for, so they must never drift from what the writers below install.
SERVICE_LABEL_GATEWAY="ai.cozylabs.cozygateway"
SERVICE_LABEL_DASHBOARD="ai.cozylabs.hermes-dashboard"
SERVICE_UNIT_GATEWAY="cozygateway.service"
SERVICE_UNIT_DASHBOARD="cozygateway-hermes-dashboard.service"
SERVICE_PLATFORM=""

# resolve_service_platform: launchd or systemd, or a clear stop. Called by both --service and
# --uninstall-service, and by nothing else, so an install that never asks for supervision never
# cares what init system this box runs.
resolve_service_platform() {
  case "$(uname -s)" in
    Darwin) SERVICE_PLATFORM="launchd" ;;
    Linux)  SERVICE_PLATFORM="systemd" ;;
    *) die "--service supports macOS (launchd) and Linux (systemd --user); this box reports '$(uname -s)'. Start the gateway by hand, or drop --service to use nohup." ;;
  esac
}

# service_unit_name KIND: the platform's name for the gateway or dashboard unit.
service_unit_name() {
  case "$SERVICE_PLATFORM:$1" in
    launchd:gateway)   printf '%s' "$SERVICE_LABEL_GATEWAY" ;;
    launchd:dashboard) printf '%s' "$SERVICE_LABEL_DASHBOARD" ;;
    systemd:gateway)   printf '%s' "$SERVICE_UNIT_GATEWAY" ;;
    systemd:dashboard) printf '%s' "$SERVICE_UNIT_DASHBOARD" ;;
    *) die "internal: no unit name for '$1' on '$SERVICE_PLATFORM'" ;;
  esac
}

# service_write_gateway_wrapper: $LOCAL_DIR/run-gateway.sh, mode 700.
#
# It branches on COZY_RUNTIME, not on whether COZY_BUNDLE_PATH looks empty: install-env.sh records
# that variable unconditionally, empty included, so emptiness means nothing on its own.
service_write_gateway_wrapper() {
  local wrapper="$LOCAL_DIR/run-gateway.sh" node_bin="$COZY_NODE"
  # The node runtime never canonicalized $COZY_NODE (only the bundle preflight does), and a bare
  # `node` is not on launchd's PATH. Resolve it here or the unit dies with "command not found".
  case "$node_bin" in
    /*) : ;;
    *) node_bin="$(command -v "$node_bin" 2>/dev/null || printf '%s' "$node_bin")" ;;
  esac
  if dry; then
    printf 'DRY   write %s (mode 700): sources %s, reads the password from %s at exec time, execs the %s runtime\n' \
      "$wrapper" "$INSTALL_ENV" "$CRED_FILE" "$RUNTIME"
    return 0
  fi
  umask 077
  cat > "$wrapper" <<WRAPPER
#!/usr/bin/env bash
# Generated by agent-install.sh --service. Reads the dashboard password at exec
# time so it never sits in the unit file (which is world-readable).
set -euo pipefail
. "$INSTALL_ENV"
COZYGATEWAY_HERMES_PASSWORD="\${COZYGATEWAY_HERMES_PASSWORD:-}"
# --skip-dashboard installs can legitimately have no credentials file: the operator owns the
# dashboard elsewhere and passes the password in through the environment.
if [ -f "\$COZY_CRED_FILE" ]; then
  COZYGATEWAY_HERMES_PASSWORD="\$(sed -n '/^password=/{s///p;q;}' "\$COZY_CRED_FILE")"
fi
export COZYGATEWAY_HERMES_PASSWORD
# Both branches cd first: launchd starts a job in /, so anything either runtime resolves relative
# to the working directory would land at the filesystem root without this.
if [ "\$COZY_RUNTIME" = "bundle" ]; then
  cd "\$COZY_GATEWAY_DIR" && exec "\$COZY_NODE" "\$COZY_BUNDLE_PATH" serve --config "\$COZY_CONFIG_JSON"
else
  cd "\$COZY_GATEWAY_DIR" && exec $(printf '%q' "$node_bin") packages/gateway/dist/cli.js serve --config "\$COZY_CONFIG_JSON"
fi
WRAPPER
  chmod 700 "$wrapper"
  ok "wrote $wrapper (mode 700); the unit execs it, and it reads the password from $CRED_FILE"
}

# service_write_dashboard_wrapper: $LOCAL_DIR/run-dashboard.sh, mode 700. Only ever called when
# SKIP_DASHBOARD=0, which is also the only case in which `hermes` is guaranteed present.
service_write_dashboard_wrapper() {
  local wrapper="$LOCAL_DIR/run-dashboard.sh" hermes_bin
  hermes_bin="$(command -v hermes 2>/dev/null || true)"
  [ -n "$hermes_bin" ] || die "--service needs an absolute path to hermes for the dashboard unit (launchd's PATH is minimal), and 'hermes' is not on PATH"
  if dry; then
    printf 'DRY   write %s (mode 700): exec %s dashboard --host %s --port %s --no-open --skip-build\n' \
      "$wrapper" "$hermes_bin" "$DASHBOARD_HOST" "$DASHBOARD_PORT"
    return 0
  fi
  umask 077
  cat > "$wrapper" <<WRAPPER
#!/usr/bin/env bash
# Generated by agent-install.sh --service.
set -euo pipefail
. "$INSTALL_ENV"
export HERMES_HOME="\$COZY_HERMES_HOME"
# launchd starts a job in /, and systemd --user in the user's home only by default. The nohup path
# deliberately runs \`hermes dashboard\` from \$HOME; match it, so anything hermes resolves relative
# to the working directory resolves to the same place under supervision as it does without it.
cd "\$HOME"
exec $(printf '%q' "$hermes_bin") dashboard --host "\$COZY_DASHBOARD_HOST" --port "\$COZY_DASHBOARD_PORT" --no-open --skip-build
WRAPPER
  chmod 700 "$wrapper"
  ok "wrote $wrapper (mode 700); the unit execs it with HERMES_HOME=$HERMES_HOME_DIR"
}

# service_install_launchd LABEL WRAPPER LOG: write the plist and (re)bootstrap the job.
#
# KeepAlive/SuccessfulExit=false is "restart unless it exited 0": a crash or a kill comes back, a
# clean shutdown stays down. ThrottleInterval caps the restart rate at one per 10s so a unit that
# cannot start at all does not spin.
service_install_launchd() {
  local label="$1" wrapper="$2" log="$3"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$wrapper</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
PLIST
  # Bootout first so a re-run replaces the loaded job rather than colliding with it. Both calls are
  # tolerant: bootout fails when nothing is loaded, and bootstrap is unavailable on very old macOS,
  # where load -w is the equivalent.
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load -w "$plist"
  ok "launchd: $label bootstrapped from $plist (RunAtLoad, KeepAlive on non-zero exit, log $log)"
}

# service_install_systemd UNIT WRAPPER LOG: write the unit file and (re)enable it.
#
# StandardOutput/StandardError=append:$log gives systemd the same job launchd's StandardOutPath/
# StandardErrorPath does: the failure paths in phases 5 and 7 (`tail -30 "$DASH_LOG"` / "$GW_LOG")
# read real content on Linux instead of an empty file, and journalctl --user -u UNIT still works on
# top of it.
#
# Restart=on-failure + RestartSec=5 mirrors launchd's KeepAlive-on-nonzero-exit + 10s
# ThrottleInterval closely enough: both come back after a crash, both leave a clean exit down.
service_install_systemd() {
  local unit="$1" wrapper="$2" log="$3" dir="$HOME/.config/systemd/user" desc err
  case "$unit" in
    "$SERVICE_UNIT_GATEWAY")   desc="CozyGateway" ;;
    "$SERVICE_UNIT_DASHBOARD") desc="CozyGateway Hermes dashboard" ;;
    *) desc="$unit" ;;
  esac
  mkdir -p "$dir"
  cat > "$dir/$unit" <<UNIT
[Unit]
Description=$desc

[Service]
ExecStart=/bin/bash $wrapper
Restart=on-failure
RestartSec=5
StandardOutput=append:$log
StandardError=append:$log

[Install]
WantedBy=default.target
UNIT
  # A user unit needs a user D-Bus session, which some SSH setups never start (no login session, no
  # lingering). Both calls below are the honest test for that: fail here, loudly, with the fix,
  # rather than leaving a unit file on disk that nothing ever loads.
  if ! err="$(systemctl --user daemon-reload 2>&1)"; then
    die "systemctl --user daemon-reload failed: $err. This usually means no systemd --user D-Bus session is available (common over a plain SSH command, without a full login). Run: sudo loginctl enable-linger $USER, log in with a real session (or ssh -t), then re-run with --service."
  fi
  if ! err="$(systemctl --user enable --now "$unit" 2>&1)"; then
    die "systemctl --user enable --now $unit failed: $err. This usually means no systemd --user D-Bus session is available. Run: sudo loginctl enable-linger $USER, log in with a real session (or ssh -t), then re-run with --service."
  fi
  loginctl enable-linger "$USER" 2>/dev/null || \
    warn "could not enable lingering; the service stops at logout. Run: sudo loginctl enable-linger $USER"
  ok "systemd --user: $unit enabled and started from $dir/$unit (log: $log, or journalctl --user -u $unit -f)"
}

# service_install_unit KIND WRAPPER LOG
service_install_unit() {
  local kind="$1" wrapper="$2" log="$3" name
  name="$(service_unit_name "$kind")"
  if dry; then
    if [ "$SERVICE_PLATFORM" = "launchd" ]; then
      printf 'DRY   write ~/Library/LaunchAgents/%s.plist (exec /bin/bash %s, RunAtLoad, KeepAlive, log %s)\n' "$name" "$wrapper" "$log"
      printf 'DRY   launchctl bootout gui/%s/%s ; launchctl bootstrap gui/%s ~/Library/LaunchAgents/%s.plist\n' \
        "$(id -u)" "$name" "$(id -u)" "$name"
    else
      printf 'DRY   install and start the systemd --user unit %s (exec %s, log %s)\n' "$name" "$wrapper" "$log"
    fi
    return 0
  fi
  case "$SERVICE_PLATFORM" in
    launchd) service_install_launchd "$name" "$wrapper" "$log" ;;
    systemd) service_install_systemd "$name" "$wrapper" "$log" ;;
    *) die "internal: no service platform resolved" ;;
  esac
}

# service_stop_unit KIND: unload the unit if it is loaded, and say nothing if it is not.
#
# This exists for one reason: KeepAlive. Any attempt to stop a supervised process from OUTSIDE its
# supervisor is a race the supervisor wins, so `hermes dashboard --stop` against a loaded unit stops
# a process that launchd immediately starts again, and the caller's "wait for the port to free" loop
# then times out on a dashboard that never went away. The unit has to be unloaded FIRST.
service_stop_unit() {
  local kind="$1" name
  name="$(service_unit_name "$kind")"
  case "$SERVICE_PLATFORM" in
    launchd)
      launchctl print "gui/$(id -u)/$name" >/dev/null 2>&1 || return 0
      if dry; then
        printf 'DRY   launchctl bootout gui/%s/%s (unload before stopping, so KeepAlive cannot restart it)\n' "$(id -u)" "$name"
        return 0
      fi
      launchctl bootout "gui/$(id -u)/$name" 2>/dev/null || true
      info "unloaded the existing $name unit so it cannot restart under us"
      ;;
    systemd)
      have systemctl || return 0
      systemctl --user cat "$name" >/dev/null 2>&1 || return 0
      if dry; then
        printf 'DRY   systemctl --user stop %s (stop before restarting, so Restart= cannot race)\n' "$name"
        return 0
      fi
      systemctl --user stop "$name" >/dev/null 2>&1 || true
      info "stopped the existing $name unit so it cannot restart under us"
      ;;
  esac
}

# adopt_unsupervised_gateway: free $GATEWAY_PORT so the unit can actually have it.
#
# The same defect the dashboard had, in the gateway's clothes, and quieter. An earlier non-service
# run leaves a nohup'd gateway holding the port. Install a unit on top and the unit crash-loops on
# EADDRINUSE forever, while `GET /health` answers 200 from the UNSUPERVISED process the whole time:
# the 90s poll passes, the capability check passes, the roster check passes, the run ends green, and
# nothing is supervised. Every symptom says success.
#
# Called only after `service_stop_unit gateway`, so anything still on the port is by definition not
# ours. It is still a cozygateway serving this install's config and database, so stopping it is
# adoption, not a coin flip -- but it is a kill by pid, so it says so at the top of its voice first.
adopt_unsupervised_gateway() {
  local pids pid waited=0
  port_listening "$GATEWAY_PORT" || return 0
  if dry; then
    printf 'DRY   stop whatever still holds port %s after the unit is unloaded, so the unit can bind it\n' "$GATEWAY_PORT"
    return 0
  fi
  pids="$(lsof -nP -iTCP:"$GATEWAY_PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  [ -n "$pids" ] || return 0
  warn "port $GATEWAY_PORT is still held after the $SERVICE_PLATFORM unit was unloaded, so an UNSUPERVISED gateway is running (a nohup start from an earlier run). Left alone, the unit would crash-loop on EADDRINUSE while /health answered 200 from that process, and this run would end green with nothing supervised. Stopping it so the unit can own the port."
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    info "  stopping pid $pid ($(ps -p "$pid" -o command= 2>/dev/null | cut -c1-90 || true))"
    kill "$pid" 2>/dev/null || true
  done <<EOF
$pids
EOF
  while [ "$waited" -lt 20 ]; do
    port_listening "$GATEWAY_PORT" || { ok "the unsupervised gateway is stopped and port $GATEWAY_PORT is free"; return 0; }
    sleep 1
    waited=$((waited + 1))
  done
  warn "the unsupervised gateway ignored SIGTERM for 20s; sending SIGKILL"
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    kill -9 "$pid" 2>/dev/null || true
  done <<EOF
$pids
EOF
  waited=0
  while [ "$waited" -lt 10 ]; do
    port_listening "$GATEWAY_PORT" || { ok "port $GATEWAY_PORT is free"; return 0; }
    sleep 1
    waited=$((waited + 1))
  done
  die "port $GATEWAY_PORT is still held by something that will not stop. Free it by hand (\`lsof -nP -iTCP:$GATEWAY_PORT -sTCP:LISTEN\`) and re-run, or pass --gateway-port."
}

# uninstall_services: stop and remove both units, say what actually went, and never fail because
# something was already absent. It deliberately touches nothing else: the config, the credentials,
# the database and the wrapper scripts all survive, so re-running with --service is a one-liner.
uninstall_services() {
  local removed=0 dash_removed=0 this_removed=0 label plist unit unit_file uid
  case "$SERVICE_PLATFORM" in
    launchd)
      uid="$(id -u)"
      for label in "$SERVICE_LABEL_GATEWAY" "$SERVICE_LABEL_DASHBOARD"; do
        this_removed=0
        plist="$HOME/Library/LaunchAgents/$label.plist"
        if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
          if dry; then
            printf 'DRY   launchctl bootout gui/%s/%s\n' "$uid" "$label"
          else
            launchctl bootout "gui/$uid/$label" 2>/dev/null || launchctl unload -w "$plist" 2>/dev/null || true
            # bootout returns before the job is gone when the job still has live children, and a
            # job that is still registered is one a later `--service` run would collide with. Give
            # it a moment and say the second word if the first was not heard.
            for _ in 1 2 3 4 5; do
              launchctl print "gui/$uid/$label" >/dev/null 2>&1 || break
              sleep 1
              launchctl bootout "gui/$uid/$label" 2>/dev/null || true
            done
            ok "booted out $label"
          fi
          removed=1; this_removed=1
        fi
        if [ -f "$plist" ]; then
          if dry; then
            printf 'DRY   rm %s\n' "$plist"
          else
            rm -f "$plist"
            ok "removed $plist"
          fi
          removed=1; this_removed=1
        fi
        if [ "$label" = "$SERVICE_LABEL_DASHBOARD" ] && [ "$this_removed" = "1" ]; then
          dash_removed=1
        fi
      done
      ;;
    systemd)
      for unit in "$SERVICE_UNIT_GATEWAY" "$SERVICE_UNIT_DASHBOARD"; do
        this_removed=0
        unit_file="$HOME/.config/systemd/user/$unit"
        # `systemctl --user cat` succeeds only for a unit systemd can actually see, which is the
        # honest test for "is there something here to stop", file on disk or not.
        if have systemctl && systemctl --user cat "$unit" >/dev/null 2>&1; then
          if dry; then
            printf 'DRY   systemctl --user disable --now %s\n' "$unit"
          else
            systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
            ok "stopped and disabled $unit"
          fi
          removed=1; this_removed=1
        fi
        if [ -f "$unit_file" ]; then
          if dry; then
            printf 'DRY   rm %s\n' "$unit_file"
          else
            rm -f "$unit_file"
            ok "removed $unit_file"
          fi
          removed=1; this_removed=1
        fi
        if [ "$unit" = "$SERVICE_UNIT_DASHBOARD" ] && [ "$this_removed" = "1" ]; then
          dash_removed=1
        fi
      done
      if [ "$removed" = "1" ] && ! dry && have systemctl; then
        systemctl --user daemon-reload >/dev/null 2>&1 || true
        info "systemctl --user daemon-reload"
      fi
      ;;
  esac
  if [ "$removed" = "0" ]; then
    info "nothing to remove: no cozygateway service units were installed for this user"
  fi
  # Only after a dashboard unit was ACTUALLY removed. An uninstall that removed nothing has no
  # business stopping anything, and the "nothing to remove" path used to reach the sweep too.
  if [ "$dash_removed" = "1" ]; then
    stop_detached_dashboard
  fi
}

# stop_detached_dashboard: the half of the dashboard the unit does not own.
#
# `hermes dashboard` does not BECOME the server; it starts a detached backend and the unit's process
# tree does not contain it. So removing the unit leaves the port still listening, which is a wrong
# answer from something called --uninstall-service, and it is the port the next --service run needs.
# Observed live: after a clean uninstall, lsof still showed two listeners on the dashboard port.
#
# Narrow on purpose, and narrowed further after review pointed out that a listening port names
# nothing. Three conditions, all required:
#
#   1. A dashboard UNIT was actually removed by the call above (the caller checks this).
#   2. install-env.sh says COZY_DASHBOARD_OWNED=1, i.e. this install STARTS the dashboard. A
#      --skip-dashboard install records the operator's port without owning what listens on it, and
#      --no-start / --pair-only start nothing; in all three cases the process on that port belongs
#      to somebody else and stopping it is vandalism.
#   3. Something is still listening on that exact port after the unit is gone.
#
# Older install-env.sh files predate the ownership key. A missing key reads as NOT owned, so the
# sweep declines rather than guessing: the cost of declining is a stray listener the operator can
# see and stop, and the cost of guessing wrong is killing a dashboard we never started.
stop_detached_dashboard() {
  local dash_port hermes_home owned waited=0
  [ -f "$INSTALL_ENV" ] || return 0
  # Read in a SUBSHELL: install-env.sh exports COZY_* names this script also uses.
  # shellcheck source=/dev/null
  dash_port="$( . "$INSTALL_ENV" >/dev/null 2>&1 && printf '%s' "${COZY_DASHBOARD_PORT:-}" )"
  # shellcheck source=/dev/null
  hermes_home="$( . "$INSTALL_ENV" >/dev/null 2>&1 && printf '%s' "${COZY_HERMES_HOME:-}" )"
  # shellcheck source=/dev/null
  owned="$( . "$INSTALL_ENV" >/dev/null 2>&1 && printf '%s' "${COZY_DASHBOARD_OWNED:-0}" )"
  if [ "${owned:-0}" != "1" ]; then
    info "not touching whatever listens on the dashboard port: this install does not own it (--skip-dashboard, --no-start or an install-env.sh written before ownership was recorded)"
    return 0
  fi
  case "${dash_port:-}" in ''|*[!0-9]*) return 0 ;; esac
  lsof -nP -iTCP:"$dash_port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
  if dry; then
    printf 'DRY   hermes dashboard --stop (something is still listening on %s; the unit does not parent the backend)\n' "$dash_port"
    return 0
  fi
  if ! have hermes; then
    warn "a dashboard is still listening on 127.0.0.1:$dash_port and hermes is not on PATH to stop it. The unit is gone, but the server it started is not: stop it by hand."
    return 0
  fi
  info "a dashboard is still listening on 127.0.0.1:$dash_port: hermes runs the server as a detached backend that the unit never parented. Stopping it."
  HERMES_HOME="${hermes_home:-$HERMES_HOME_DIR}" hermes dashboard --stop >/dev/null 2>&1 || \
    warn "hermes dashboard --stop returned an error"
  while [ "$waited" -lt 20 ]; do
    lsof -nP -iTCP:"$dash_port" -sTCP:LISTEN >/dev/null 2>&1 || {
      ok "the detached dashboard backend is stopped; nothing is listening on $dash_port"
      return 0
    }
    sleep 1
    waited=$((waited + 1))
  done
  warn "something is STILL listening on 127.0.0.1:$dash_port after hermes dashboard --stop. \`hermes dashboard --status\` names the processes; stop it by hand."
}

if [ "$UNINSTALL_SERVICE" = "1" ]; then
  step "--uninstall-service"
  resolve_service_platform
  info "service manager: $SERVICE_PLATFORM"
  uninstall_services
  info "the config, credentials, database and wrapper scripts under $LOCAL_DIR were left alone"
  ok "done; re-run with --service to put the units back"
  exit 0
fi

# write_install_env: the handoff to docs/agent-install.md.
#
# The playbook's commands each run in a FRESH SHELL, one per tool call, so nothing can be handed
# between its steps in a variable: an agent that follows the doc literally would lose $PASSWORD,
# $HASH and $HERMES_PY between steps and then, told never to invent a value, invent one. So every
# value a later step needs is written here instead, and every command in the playbook sources this
# file first. The password is deliberately NOT here: it stays in the credentials file, which the
# few steps that need it read on the spot.
#
# Called twice: once as soon as the local directory exists (so the playbook's own manual path has
# it) and again after the gateway config is written (so it carries the final values).
write_install_env() {
  if dry; then
    printf 'DRY   write %s (ports, hosts, runtime, paths) for docs/agent-install.md to source\n' "$INSTALL_ENV"
    return 0
  fi
  umask 077
  {
    printf '# Generated by scripts/agent-install.sh. Source it, do not edit it:\n'
    printf '#   . %s\n' "$INSTALL_ENV"
    printf '# The password is NOT here; it lives in %s.\n' "$CRED_FILE"
    printf 'COZY_GATEWAY_DIR=%q\n' "$GATEWAY_DIR"
    printf 'COZY_LOCAL_DIR=%q\n' "$LOCAL_DIR"
    printf 'COZY_CONFIG_JSON=%q\n' "$CONFIG_JSON"
    printf 'COZY_ENV_FILE=%q\n' "$ENV_FILE"
    printf 'COZY_CRED_FILE=%q\n' "$CRED_FILE"
    printf 'COZY_GATEWAY_PORT=%q\n' "$GATEWAY_PORT"
    printf 'COZY_DASHBOARD_PORT=%q\n' "$DASHBOARD_PORT"
    printf 'COZY_DASHBOARD_HOST=%q\n' "$DASHBOARD_HOST"
    # 1 only when this install actually starts the dashboard on that port. --uninstall-service
    # refuses to touch the port otherwise.
    printf 'COZY_DASHBOARD_OWNED=%q\n' "$DASHBOARD_OWNED"
    printf 'COZY_BRIDGE_USER=%q\n' "$BRIDGE_USER"
    printf 'COZY_RUNTIME=%q\n' "$RUNTIME"
    # Always recorded, empty included: a later step that reads an unset variable under `set -u`
    # dies with bash's own message instead of the empty string that honestly means "not the
    # bundle path". Task 3's service unit execs exactly "$COZY_NODE" "$COZY_BUNDLE_PATH".
    printf 'COZY_BUNDLE_PATH=%q\n' "$BUNDLE_PATH"
    printf 'COZY_NODE=%q\n' "$COZY_NODE"
    printf 'COZY_HERMES_PY=%q\n' "$HERMES_PY"
    printf 'COZY_HERMES_HOME=%q\n' "$HERMES_HOME_DIR"
    printf 'COZY_GW_LOG=%q\n' "$GW_LOG"
    printf 'COZY_DASH_LOG=%q\n' "$DASH_LOG"
    printf 'export COZY_GATEWAY_DIR COZY_LOCAL_DIR COZY_CONFIG_JSON COZY_ENV_FILE COZY_CRED_FILE\n'
    printf 'export COZY_GATEWAY_PORT COZY_DASHBOARD_PORT COZY_DASHBOARD_HOST COZY_BRIDGE_USER\n'
    printf 'export COZY_DASHBOARD_OWNED\n'
    printf 'export COZY_RUNTIME COZY_HERMES_PY COZY_HERMES_HOME COZY_GW_LOG COZY_DASH_LOG\n'
    printf 'export COZY_BUNDLE_PATH COZY_NODE\n'
  } > "$INSTALL_ENV"
  chmod 600 "$INSTALL_ENV"
  ok "recorded the install's ports, hosts and paths in $INSTALL_ENV (mode 600); the playbook sources this"
}

# gen_secret N: N random alphanumeric characters.
#
# The bound is on the SOURCE, not on the sink. The obvious `tr -dc ... </dev/urandom | head -c N`
# makes head close the pipe under tr, tr dies of SIGPIPE, and `set -o pipefail` turns that into a
# 141 that kills the whole script. Bounding /dev/urandom with head instead means every stage reads
# its input to EOF and nothing is ever signalled.
gen_secret() {
  local n="$1"
  head -c "$((n * 8))" /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-"$n"
}

# mint_pair: ask the gateway's own CLI for a setup code. Defined here because --pair-only calls it
# long before the install phases that would otherwise be its home.
mint_pair_raw() {
  if [ "$RUNTIME" = "docker" ]; then
    ( cd "$GATEWAY_DIR" && docker compose -f docker-compose.yml -f "$OVERRIDE_REL" \
      exec -T gateway node dist/cli.js pair --config /app/cozygateway.config.json )
  elif [ "$RUNTIME" = "bundle" ]; then
    "$COZY_NODE" "$BUNDLE_PATH" pair --config "$CONFIG_JSON"
  else
    ( cd "$GATEWAY_DIR" && node packages/gateway/dist/cli.js pair --config "$CONFIG_JSON" )
  fi
}

# mint_pair_json: just the machine-readable first line, for checks that pair rather than print.
mint_pair_json() { mint_pair_raw | head -1; }

mint_pair() {
  if dry; then
    printf 'DRY   mint a pairing code via the cozygateway CLI\n'
    return 0
  fi
  local out=""
  out="$(mint_pair_raw)"
  [ -n "$out" ] || die "the pair command produced no output"
  printf '%s\n' "$out"
  ok "pairing code minted (single use, valid 10 minutes; re-run with --pair-only for another)"
}

# ---------------------------------------------------------------------------- 1. preflight

step "1/8 preflight"

for tool in git curl; do
  have "$tool" || die "$tool is required and was not found on PATH"
done
ok "git and curl present"

if have hermes; then
  HERMES_VERSION="$(hermes --version 2>&1 | tr -d '\r' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [ -n "$HERMES_VERSION" ]; then
    LOWEST="$(printf '0.20.2\n%s\n' "$HERMES_VERSION" | sort -V | head -1)"
    if [ "$LOWEST" = "0.20.2" ]; then
      ok "hermes $HERMES_VERSION (>= 0.20.2, has Bot Mode)"
    else
      warn "hermes $HERMES_VERSION is older than 0.20.2; Bot Mode conventions may be missing"
    fi
  else
    warn "could not parse a version out of 'hermes --version'; continuing"
  fi
elif [ "$SKIP_DASHBOARD" = "0" ]; then
  die "hermes is not on PATH. Install Hermes first, or pass --skip-dashboard to wire a remote one."
else
  warn "hermes not on PATH (--skip-dashboard given, continuing)"
fi

# The interpreter Hermes itself runs under is the one that can import yaml and
# plugins.dashboard_auth.basic. Finding it is the step most likely to go wrong, so it is resolved by
# trying candidates and PROVING each one with a real import rather than by testing that a file
# exists. The reference install is the case that broke the naive guess: `hermes` is a bash wrapper
# whose shebang is `#!/usr/bin/env bash` and whose last line execs the venv's own `hermes`, so the
# shebang names a shell and the system python3 has no `yaml`.
#
# Candidates, in order:
#   1. $COZYGATEWAY_HERMES_PY, if set (the operator's explicit answer).
#   2. `hermes --version` prints "Install directory: <dir>"; try <dir>/venv/bin/python3 and
#      <dir>/.venv/bin/python3.
#   3. the wrapper's exec'ed target: `exec "<dir>/bin/hermes"` gives <dir>/bin/python3.
#   4. a shebang that really does name a python.
#   5. python3 on PATH, as a last resort.
hermes_py_works() {
  [ -n "${1:-}" ] || return 1
  { [ -x "$1" ] || have "$1"; } || return 1
  "$1" -c 'import yaml' >/dev/null 2>&1 || return 1
  return 0
}

HERMES_PY=""
HERMES_PY_CANDIDATES=""
add_candidate() { [ -n "${1:-}" ] && HERMES_PY_CANDIDATES="$HERMES_PY_CANDIDATES$1
"; }

if [ -n "${COZYGATEWAY_HERMES_PY:-}" ]; then
  add_candidate "$COZYGATEWAY_HERMES_PY"
elif have hermes; then
  HERMES_INSTALL_DIR="$(hermes --version 2>&1 | sed -n 's/^Install directory:[[:space:]]*//p' | head -1 || true)"
  if [ -n "${HERMES_INSTALL_DIR:-}" ]; then
    add_candidate "$HERMES_INSTALL_DIR/venv/bin/python3"
    add_candidate "$HERMES_INSTALL_DIR/.venv/bin/python3"
  fi
  HERMES_BIN="$(command -v hermes)"
  EXEC_TARGET="$(sed -n 's/^[[:space:]]*exec[[:space:]]*"\{0,1\}\([^" ]*\)"\{0,1\}.*/\1/p' "$HERMES_BIN" 2>/dev/null | head -1 || true)"
  if [ -n "${EXEC_TARGET:-}" ]; then
    add_candidate "$(dirname "$EXEC_TARGET")/python3"
  fi
  SHEBANG="$(head -1 "$HERMES_BIN" 2>/dev/null | sed -n 's/^#!\(.*\)$/\1/p' | awk '{print $NF}')"
  case "${SHEBANG:-}" in *python*) add_candidate "$SHEBANG" ;; esac
fi
add_candidate "python3"

while IFS= read -r cand; do
  [ -n "$cand" ] || continue
  if hermes_py_works "$cand"; then HERMES_PY="$cand"; break; fi
done <<EOF
$HERMES_PY_CANDIDATES
EOF

if [ -z "$HERMES_PY" ]; then
  if [ "$SKIP_DASHBOARD" = "1" ]; then
    warn "no python with 'import yaml' found; --skip-dashboard means nothing here needs one"
    HERMES_PY="python3"
  else
    printf 'FAIL  no python that can "import yaml" was found. Tried:\n' >&2
    printf '%s' "$HERMES_PY_CANDIDATES" | sed 's/^/        /' >&2
    die "set COZYGATEWAY_HERMES_PY to the python Hermes runs under (\`hermes --version\` prints its Install directory; the interpreter is <dir>/venv/bin/python3) and re-run."
  fi
else
  ok "python for hermes helpers: $HERMES_PY (import yaml verified)"
  # The hasher is the other import this python owes us, and it is only needed when we merge.
  if [ "$SKIP_DASHBOARD" = "0" ]; then
    if "$HERMES_PY" - <<'PY' >/dev/null 2>&1
import os, sys
try:
    from plugins.dashboard_auth.basic import hash_password  # noqa: F401
except ModuleNotFoundError:
    import hermes_cli
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(hermes_cli.__file__))))
    from plugins.dashboard_auth.basic import hash_password  # noqa: F401
PY
    then
      ok "plugins.dashboard_auth.basic imports; this python can hash the password"
    else
      die "$HERMES_PY cannot import plugins.dashboard_auth.basic, so it cannot hash the dashboard password. Set COZYGATEWAY_HERMES_PY to the python inside the Hermes install directory (\`hermes --version\` prints it) and re-run."
    fi
  fi
fi

if [ "$RUNTIME" = "auto" ]; then
  if have docker && docker compose version >/dev/null 2>&1; then
    RUNTIME="docker"
  elif have node; then
    RUNTIME="node"
  else
    die "neither 'docker compose' nor 'node' is available; install one of them"
  fi
fi

# --service supervises a PROCESS this script started. Under docker the restart policy in
# docker-compose.yml already does that job, and a launchd unit on top of it would be a second
# supervisor fighting the first. The check sits here, after the auto-resolution above, so it fires
# on the runtime that will actually be used rather than on the flag that was typed.
if [ "$SERVICE" = "1" ]; then
  if [ "$RUNTIME" = "docker" ]; then
    [ -n "$RUNTIME_EXPLICIT" ] || \
      info "docker was chosen by autodetection, not asked for; --runtime node or --bundle PATH selects the supervised path"
    die "docker already supervises the gateway; --service is for the no-docker path"
  fi
  # --service's whole job is to install units AND start them. --no-start starts nothing and
  # --pair-only leaves before either start phase, so both would end green having installed no unit
  # at all, after a preflight line promising supervision. Refuse rather than lie.
  if [ "$NO_START" = "1" ]; then
    die "--service installs and starts the service units, so it cannot be combined with --no-start. Drop one of them."
  fi
  if [ "$PAIR_ONLY" = "1" ]; then
    die "--pair-only only mints a code against an already-running gateway; it never reaches the start phases, so --service would install nothing. Drop one of them."
  fi
  resolve_service_platform
  if [ "$SKIP_DASHBOARD" = "1" ]; then
    ok "supervision: $SERVICE_PLATFORM (--service); the gateway restarts after a crash and at login"
  else
    ok "supervision: $SERVICE_PLATFORM (--service); the gateway and the dashboard restart after a crash and at login"
  fi
fi

case "$RUNTIME" in
  docker)
    have docker || die "--runtime docker but docker is not installed"
    docker compose version >/dev/null 2>&1 || die "docker is installed but 'docker compose' is not"
    # Under --dry-run the whole point is to READ the plan without starting anything, so a stopped
    # daemon is a warning there and a hard stop only for a real run.
    if ! docker info >/dev/null 2>&1; then
      if dry; then
        warn "the docker daemon is not reachable; --dry-run continues, but a real run needs it started"
      else
        die "the docker daemon is not reachable; start Docker and retry"
      fi
    fi
    ok "runtime: docker ($(docker compose version | head -1))"
    ;;
  node)
    have node || die "--runtime node but node is not installed"
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$NODE_MAJOR" -ge 24 ] || die "node $NODE_MAJOR is too old; the gateway requires node 24 or newer"
    have pnpm || die "pnpm is required for the node path (npm i -g pnpm@10)"
    ok "runtime: node $(node -v) with $(pnpm --version)"
    ;;
  bundle)
    # Nothing is cloned and nothing is built on this path, so git/pnpm/docker are all beside the
    # point. The two things that have to be true are the file and the interpreter, and the version
    # check runs against $COZY_NODE (which COZYGATEWAY_NODE names) rather than whatever `node` on
    # PATH happens to be: a box whose PATH node is 22 can still run the bundle under a 24+ binary.
    [ -f "$BUNDLE_PATH" ] || die "--bundle $BUNDLE_PATH does not exist. Build it with 'pnpm bundle' in a cozygateway checkout and copy dist-bundle/cozygateway.mjs here."
    # Canonicalize to an ABSOLUTE path before anything records it. A relative --bundle resolves
    # correctly here, against the cwd this script was invoked from, and then wrong everywhere
    # afterwards: the service unit Tasks 3/4 write execs "$COZY_NODE" "$COZY_BUNDLE_PATH" from the
    # service manager's cwd, which is /, so a relative path yields a unit that cannot start and a
    # preflight that said nothing. `readlink -f` is not portable to macOS, so the dirname is
    # resolved by cd'ing into it. A path that is ALREADY absolute is left exactly as given: it
    # needs no fixing, and rewriting it would resolve the operator's symlinks behind their back
    # (/opt/homebrew/opt/node/bin/node is a deliberately stable alias; the Cellar path it points at
    # names one version and disappears on the next upgrade).
    case "$BUNDLE_PATH" in
      /*) : ;;
      *)  BUNDLE_PATH="$(cd "$(dirname "$BUNDLE_PATH")" && pwd -P)/$(basename "$BUNDLE_PATH")" ;;
    esac
    [ -f "$BUNDLE_PATH" ] || die "could not resolve --bundle to an absolute path (got $BUNDLE_PATH)"
    # Same argument for the interpreter, and for the same consumer. A bare name is resolved through
    # PATH here rather than left as a name, because the service manager's PATH is not this shell's.
    case "$COZY_NODE" in
      /*)
        [ -x "$COZY_NODE" ] || die "node binary '$COZY_NODE' is not an executable file (set COZYGATEWAY_NODE to an absolute path to node 24+)"
        ;;
      */*)
        [ -x "$COZY_NODE" ] || die "node binary '$COZY_NODE' is not an executable file (set COZYGATEWAY_NODE to an absolute path to node 24+)"
        COZY_NODE="$(cd "$(dirname "$COZY_NODE")" && pwd -P)/$(basename "$COZY_NODE")"
        ;;
      *)
        have "$COZY_NODE" || die "node binary '$COZY_NODE' not found on PATH (set COZYGATEWAY_NODE to an absolute path to node 24+)"
        COZY_NODE="$(command -v "$COZY_NODE")"
        ;;
    esac
    BUNDLE_NODE_MAJOR="$("$COZY_NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    case "${BUNDLE_NODE_MAJOR:-}" in
      ''|*[!0-9]*) die "could not read a version out of '$COZY_NODE -p process.versions.node'" ;;
    esac
    [ "$BUNDLE_NODE_MAJOR" -ge 24 ] || die "$COZY_NODE is node $BUNDLE_NODE_MAJOR; the gateway requires node 24 or newer. Set COZYGATEWAY_NODE to a node 24+ binary and re-run."
    ok "runtime: bundle $BUNDLE_PATH under $COZY_NODE ($("$COZY_NODE" -v)); no clone, no pnpm"
    ;;
  *) die "--runtime must be 'docker', 'node' or 'bundle', got '$RUNTIME'" ;;
esac

# TCC: the one --service failure that gives you NOTHING to read.
#
# macOS gates ~/Desktop, ~/Documents and ~/Downloads behind per-app consent. A Terminal has usually
# been granted it; a launchd agent has not, and it has no UI to ask through. So a unit whose code or
# state lives in one of those folders blocks forever inside the very first open(), before a single
# line reaches the log: `launchctl print` says `state = running`, the log file is zero bytes, the
# port never opens, and the 90s /health poll below dies with nothing to show for it. Observed
# firsthand on this box with the bundle under ~/Documents.
#
# A warning rather than a hard stop: consent CAN be granted (System Settings > Privacy & Security >
# Files and Folders, or Full Disk Access for /bin/bash), and only the operator knows whether it has
# been. But it is said loudly, before the silence starts.
#
# macOS only: there is no such gate on Linux, and running the loop there would be noise.
# $HERMES_HOME_DIR is in the list because the dashboard unit reads config.yaml out of it and hangs
# in exactly the same way.
tcc_check() { # $1 path  $2 what it is  $3 how to fix it
  local guarded
  [ -n "${1:-}" ] || return 0
  for guarded in "$HOME/Desktop" "$HOME/Documents" "$HOME/Downloads"; do
    case "$1" in
      "$guarded"/*)
        warn "--service: $2 is $1, inside $guarded, which macOS gates behind per-folder consent that a launchd agent cannot ask for. The unit will start, open nothing, log nothing and never answer its health check. $3 Or grant Full Disk Access to /bin/bash first."
        return 0
        ;;
    esac
  done
}

if [ "$SERVICE" = "1" ] && [ "$SERVICE_PLATFORM" = "launchd" ]; then
  tcc_check "$GATEWAY_DIR" "the install directory" "Move it somewhere unguarded (~/cozygateway is the default for a reason)."
  tcc_check "$BUNDLE_PATH" "the gateway bundle" "Copy it somewhere unguarded and re-run with that --bundle path."
  if [ "$SKIP_DASHBOARD" = "0" ]; then
    tcc_check "$HERMES_HOME_DIR" "the Hermes home the dashboard unit reads" "Point --hermes-home at a directory outside it."
    # And the subtler one, which cost an afternoon on this very box: the dashboard unit runs
    # $HERMES_PY, and CPython lists EVERY sys.path entry during startup while site.py processes
    # .pth files. A single unrelated editable install whose .pth adds a ~/Documents path is enough
    # to hang the interpreter before hermes' own code runs, so the failure looks identical to ours
    # and has nothing to do with this install at all. Asking the interpreter for its own sys.path
    # is the only way to see it, and it answers instantly from this (consented) shell.
    while IFS= read -r syspath_entry; do
      tcc_check "$syspath_entry" "a sys.path entry of $HERMES_PY" "Remove the .pth or editable install that adds it (grep -rl '$HOME/Documents' \"\$($HERMES_PY -c 'import site;print(site.getsitepackages()[0])')\"), or move that project out of the guarded folder."
    done <<EOF
$("$HERMES_PY" -c 'import sys; print("\n".join(p for p in sys.path if p))' 2>/dev/null || true)
EOF
  fi
fi

# ws host the CONTAINER (or process) uses to reach the dashboard on this machine.
if [ "$RUNTIME" = "docker" ]; then
  HERMES_WS_HOST="host.docker.internal"
else
  HERMES_WS_HOST="127.0.0.1"
fi
info "bridge will dial ws://$HERMES_WS_HOST:$DASHBOARD_PORT/api/ws"

# Where the dashboard binds. This is the single largest attack-surface decision in the install:
# 0.0.0.0 publishes the human's whole Hermes dashboard (config, API keys, sessions) to the LAN over
# plaintext HTTP behind basic auth. So loopback is the default and anything wider is opt-in.
#
# The node and bundle paths never need more than loopback: the bridge is a local process.
# The docker path needs an address the CONTAINER can dial. On Linux that is the docker bridge
# gateway (usually 172.17.0.1), which the host really does own and the LAN cannot reach. On Docker
# Desktop that address lives inside the VM, not on the host, so there is nothing narrower than
# 0.0.0.0 and the operator has to say so out loud.
host_owns_addr() {
  local addr="$1"
  if have ifconfig; then
    ifconfig 2>/dev/null | grep -qw "$addr" && return 0
  fi
  if have ip; then
    ip -o addr show 2>/dev/null | grep -qw "$addr" && return 0
  fi
  return 1
}

docker_bridge_addr() {
  have docker || return 1
  docker network inspect bridge \
    --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null | head -1
}

if [ "$EXPOSE_DASHBOARD_LAN" = "1" ]; then
  [ -n "$DASHBOARD_HOST" ] && die "pass either --dashboard-host or --expose-dashboard-lan, not both"
  DASHBOARD_HOST="0.0.0.0"
  warn "--expose-dashboard-lan: the Hermes dashboard will be reachable from the whole LAN over plaintext HTTP (basic auth only). Prefer a tunnel or Tailscale over an untrusted network."
elif [ -n "$DASHBOARD_HOST" ]; then
  info "dashboard bind: $DASHBOARD_HOST (explicit --dashboard-host)"
  case "$DASHBOARD_HOST" in
    0.0.0.0|::) warn "--dashboard-host $DASHBOARD_HOST publishes the dashboard to the whole LAN over plaintext HTTP." ;;
  esac
elif [ "$RUNTIME" = "node" ] || [ "$RUNTIME" = "bundle" ]; then
  DASHBOARD_HOST="127.0.0.1"
  ok "dashboard bind: 127.0.0.1 (loopback; the $RUNTIME bridge is a local process and needs nothing wider)"
else
  BRIDGE_ADDR="$(docker_bridge_addr || true)"
  if [ -n "${BRIDGE_ADDR:-}" ] && host_owns_addr "$BRIDGE_ADDR"; then
    DASHBOARD_HOST="$BRIDGE_ADDR"
    ok "dashboard bind: $BRIDGE_ADDR (the docker bridge address; reachable from the container, not from the LAN)"
  else
    BIND_ADVICE="on the docker path a container cannot reach the host's loopback, and no host-owned docker bridge address was found (Docker Desktop keeps it inside its VM). Re-run with --expose-dashboard-lan to bind 0.0.0.0 (this publishes the dashboard to the LAN behind basic auth), or with --dashboard-host <address> to name a narrower interface, or with --runtime node to keep everything on loopback."
    if dry; then
      # --dry-run exists to be readable without starting anything, so narrate the rest of the plan
      # with the bind the operator would have to choose rather than stopping here.
      warn "$BIND_ADVICE"
      DASHBOARD_HOST="0.0.0.0"
      info "--dry-run: narrating the remaining plan as if --expose-dashboard-lan had been given"
    else
      die "$BIND_ADVICE"
    fi
  fi
fi

# ---------------------------------------------------------------------------- 2. the repo

step "2/8 get the gateway source"

if [ "$RUNTIME" = "bundle" ]; then
  # There is no source to get: the bundle IS the gateway. $GATEWAY_DIR degrades from "a checkout"
  # to "the directory the install's state lives in", which is all the later phases ever ask of it.
  info "--bundle: no clone and no build; $GATEWAY_DIR only holds this install's state"
  run mkdir -p "$GATEWAY_DIR"
elif [ -d "$GATEWAY_DIR/.git" ]; then
  ok "repo already at $GATEWAY_DIR"
  run git -C "$GATEWAY_DIR" fetch --quiet origin || warn "git fetch failed; using the checkout as-is"
else
  run git clone --quiet "$REPO_URL" "$GATEWAY_DIR" || die "clone failed"
  dry || ok "cloned $REPO_URL into $GATEWAY_DIR"
fi

run mkdir -p "$LOCAL_DIR"
# A self-ignoring generated directory: no root .gitignore edit needed, and nothing generated here
# can ever be committed by accident. Under --bundle $GATEWAY_DIR is normally not a checkout at all,
# and a .gitignore in a directory git has never heard of is just litter, so it is written only when
# there is a git checkout to ignore things from.
if [ "$RUNTIME" = "bundle" ] && [ ! -d "$GATEWAY_DIR/.git" ]; then
  info "generated artifacts directory: $LOCAL_DIR (no .gitignore: $GATEWAY_DIR is not a git checkout)"
elif dry; then
  printf 'DRY   write %s/.gitignore so nothing generated here can be committed\n' "$LOCAL_DIR"
else
  [ -f "$LOCAL_DIR/.gitignore" ] || printf '*\n!.gitignore\n' > "$LOCAL_DIR/.gitignore"
  ok "generated artifacts directory: $LOCAL_DIR (self-ignoring)"
fi

write_install_env

if [ "$PAIR_ONLY" = "1" ]; then
  step "8/8 pairing code (--pair-only)"
  mint_pair
  exit 0
fi

# ---------------------------------------------------------------------------- 3. credential

step "3/8 dashboard credential"

if [ "$SKIP_DASHBOARD" = "1" ]; then
  info "--skip-dashboard: not generating or merging anything Hermes-side"
  [ -n "$BRIDGE_PASSWORD" ] || die "--skip-dashboard needs --password (the existing dashboard password)"
  # The nohup starts hand the gateway COZYGATEWAY_HERMES_PASSWORD out of this shell's environment,
  # so --skip-dashboard never needed the credentials file. A supervised unit has no such shell to
  # inherit from: launchd starts it at login from a clean environment, and the password must not go
  # in the plist, which is world-readable. So --service writes the file the wrapper reads. Without
  # it the gateway exits 1 with "COZYGATEWAY_HERMES_PASSWORD is not set" and KeepAlive turns that
  # into a ten-second crash loop.
  if [ "$SERVICE" = "1" ]; then
    if dry; then
      printf 'DRY   record username/password in %s (mode 600) so the supervised unit can read it\n' "$CRED_FILE"
    else
      umask 077
      {
        printf 'username=%s\n' "$BRIDGE_USER"
        printf 'password=%s\n' "$BRIDGE_PASSWORD"
      } > "$CRED_FILE"
      chmod 600 "$CRED_FILE"
      ok "recorded the supplied password in $CRED_FILE (mode 600); --service needs it there, not in the unit file"
    fi
  fi
else
  RECORDED_HASH=""
  RECORDED_PASSWORD=""
  if [ -f "$CRED_FILE" ]; then
    RECORDED_PASSWORD="$(sed -n 's/^password=//p' "$CRED_FILE" | head -1)"
  fi
  if [ -z "$BRIDGE_PASSWORD" ] && [ -n "$RECORDED_PASSWORD" ]; then
    BRIDGE_PASSWORD="$RECORDED_PASSWORD"
    # Reuse the recorded hash too. Re-hashing the same password mints a new salt, which would
    # rewrite config.yaml on every run and make a no-op run indistinguishable from a real change.
    RECORDED_HASH="$(sed -n 's/^password_hash=//p' "$CRED_FILE" | head -1)"
    ok "reusing the password already recorded in $CRED_FILE"
  elif [ -n "$BRIDGE_PASSWORD" ] && [ "$BRIDGE_PASSWORD" = "$RECORDED_PASSWORD" ]; then
    # --password with the SAME password is still a no-op run. Without this, re-hashing mints a
    # fresh salt and every invocation rewrites config.yaml and drops another timestamped backup,
    # which is exactly what --skip-dashboard's mandatory --password used to guarantee.
    RECORDED_HASH="$(sed -n 's/^password_hash=//p' "$CRED_FILE" | head -1)"
    [ -n "$RECORDED_HASH" ] && ok "the supplied password matches the recorded one; reusing its hash"
  fi
  if [ -z "$BRIDGE_PASSWORD" ]; then
    # Alphanumeric by construction, so it carries no '$'. A '$' in a compose .env value is eaten by
    # interpolation unless doubled, and a silently truncated secret reads as a 401 much later.
    BRIDGE_PASSWORD="$(gen_secret 32)"
    ok "generated a 32-character password (no '\$', so compose interpolation cannot mangle it)"
  fi

  case "$BRIDGE_PASSWORD" in
    *'$'*) warn "the password contains '\$'. In $ENV_FILE it MUST be written as '\$\$' or compose will truncate it." ;;
  esac

  if [ -n "${RECORDED_HASH:-}" ]; then
    PASSWORD_HASH="$RECORDED_HASH"
    ok "reusing the recorded hash (${#PASSWORD_HASH} chars); no re-hash, so this run is a true no-op"
  elif dry; then
    printf 'DRY   %s -c "from plugins.dashboard_auth.basic import hash_password; print(hash_password(...))"\n' "$HERMES_PY"
    PASSWORD_HASH="scrypt\$DRYRUN"
  else
    # The password goes in through the ENVIRONMENT, never as argv: argv is world-readable in
    # `ps auxww` for the lifetime of the process.
    PASSWORD_HASH="$(
      DASHBOARD_BASIC_PASSWORD="$BRIDGE_PASSWORD" "$HERMES_PY" - <<'PY' 2>/dev/null || true
import os
import sys
try:
    from plugins.dashboard_auth.basic import hash_password
except ModuleNotFoundError:
    # Not importable from the CWD: find the install root next to hermes_cli and retry.
    import hermes_cli
    root = os.path.dirname(os.path.dirname(os.path.abspath(hermes_cli.__file__)))
    sys.path.insert(0, root)
    from plugins.dashboard_auth.basic import hash_password
print(hash_password(os.environ["DASHBOARD_BASIC_PASSWORD"]))
PY
    )"
    [ -n "$PASSWORD_HASH" ] || die "could not hash the password with $HERMES_PY. Run the hash_password one-liner from docs/agent-install.md by hand from the Hermes install directory."
    ok "hashed the password with the bundled scrypt hasher (${#PASSWORD_HASH} chars)"
  fi

  if dry; then
    printf 'DRY   record username/password/password_hash in %s (mode 600)\n' "$CRED_FILE"
  else
    umask 077
    {
      printf 'username=%s\n' "$BRIDGE_USER"
      printf 'password=%s\n' "$BRIDGE_PASSWORD"
      printf 'password_hash=%s\n' "$PASSWORD_HASH"
    } > "$CRED_FILE"
    chmod 600 "$CRED_FILE"
    ok "recorded the credential in $CRED_FILE (mode 600)"
  fi
fi

# ---------------------------------------------------------------------------- 4. config.yaml

step "4/8 merge dashboard.basic_auth and the approval pin into the Hermes config"

if [ "$SKIP_DASHBOARD" = "1" ]; then
  info "skipped"
else
  CONFIG_YAML="$HERMES_HOME_DIR/config.yaml"
  info "target: $CONFIG_YAML"
  if dry; then
    printf 'DRY   merge dashboard.basic_auth {username, password_hash} and approvals.mode=manual into %s\n' "$CONFIG_YAML"
  else
    mkdir -p "$HERMES_HOME_DIR"
    # Refuse BEFORE the backup, not after: a file we will not touch should not leave a backup
    # behind either. This is the duplicate-key and symlink gate; the merge below repeats both
    # checks because it is the thing that actually writes.
    "$HERMES_PY" - "$CONFIG_YAML" <<'PY' || die "refusing to merge into $CONFIG_YAML (nothing was written and no backup was taken)"
import os
import sys

import yaml


class StrictLoader(yaml.SafeLoader):
    pass


def _no_duplicates(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            mark = key_node.start_mark
            raise yaml.YAMLError(
                f"duplicate key {key!r} at line {mark.line + 1}, column {mark.column + 1}"
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _no_duplicates)

path = sys.argv[1]
if os.path.islink(path):
    raise SystemExit(
        f"agent-install: {path} is a symlink to {os.path.realpath(path)}. Refusing to write "
        "through it, because that would replace the link and change the target's mode. Point "
        "--hermes-home at the directory holding the real file, or merge by hand."
    )
try:
    with open(path, "r", encoding="utf-8") as fh:
        cfg = yaml.load(fh, Loader=StrictLoader) or {}
except FileNotFoundError:
    cfg = {}
except yaml.YAMLError as exc:
    raise SystemExit(
        f"agent-install: {path}: {exc}\n"
        "        If this names a duplicate key, the file has two blocks with the same top-level\n"
        "        name (a second `dashboard:` is the usual one). yaml.safe_load keeps only the LAST\n"
        "        of them, so merging here would silently delete the other one's settings and leave\n"
        "        a file whose `grep -c '^dashboard:'` reassuringly prints 1. Open the file, fold\n"
        "        the duplicates into a single block by hand, confirm with `grep -n '^dashboard:'`,\n"
        "        then re-run this script."
    )
if not isinstance(cfg, dict):
    raise SystemExit(f"agent-install: {path} is not a YAML mapping; refusing to overwrite it")

# The one approval setting this script will not decide for the human. `security.approval.transport`
# routes every approval prompt to a registered plugin BEFORE the gateway branch is reached, so
# approvals never reach the dashboard WebSocket and the phone's approve/deny surface is
# permanently blind (cozygateway#19). Deleting somebody's security setting behind their back is not
# this script's call, so it refuses and names the choice.
security = cfg.get("security")
approval = security.get("approval") if isinstance(security, dict) else None
transport = approval.get("transport") if isinstance(approval, dict) else None
if transport is not None and str(transport) != "builtin":
    raise SystemExit(
        f"agent-install: {path} sets security.approval.transport: {transport!r}.\n"
        "        That routes tool-call approvals to a plugin instead of the dashboard WebSocket,\n"
        "        so the cozygateway bridge never sees one and mobile approve/deny is silently\n"
        "        dead. Remove the key (or set it to builtin) and re-run, or pass\n"
        "        --skip-dashboard and own this file yourself."
    )
PY
    # Back up only when the merge can actually change something. A re-run on a finished box would
    # otherwise litter the human's Hermes home with a new backup every time.
    # Two things can need writing now, so "does the file already carry the hash" is no longer the
    # whole question: a re-run on a box installed before the approval pin existed carries the hash
    # and still needs a write. Ask the file what the merge below would actually change.
    NEEDS_WRITE=0
    if [ ! -f "$CONFIG_YAML" ]; then
      NEEDS_WRITE=1
    elif ! grep -qF "$PASSWORD_HASH" "$CONFIG_YAML"; then
      NEEDS_WRITE=1
    elif ! "$HERMES_PY" - "$CONFIG_YAML" <<'PY'
import sys

import yaml

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    cfg = yaml.safe_load(fh) or {}
approvals = cfg.get("approvals")
mode = approvals.get("mode") if isinstance(approvals, dict) else None
# Exit 0 means "already pinned", i.e. no write needed.
raise SystemExit(0 if mode == "manual" else 1)
PY
    then
      NEEDS_WRITE=1
    fi
    if [ -f "$CONFIG_YAML" ] && [ "$NEEDS_WRITE" = "1" ]; then
      BACKUP="$CONFIG_YAML.bak-agent-install-$(date +%Y%m%d%H%M%S)"
      cp "$CONFIG_YAML" "$BACKUP"
      ok "backed up the existing config to $BACKUP"
    fi
    DASHBOARD_BASIC_USER="$BRIDGE_USER" DASHBOARD_BASIC_PASSWORD_HASH="$PASSWORD_HASH" \
      "$HERMES_PY" - "$CONFIG_YAML" <<'PY'
import os
import sys

import yaml


class StrictLoader(yaml.SafeLoader):
    """SafeLoader that REFUSES duplicate mapping keys instead of keeping the last one.

    yaml.safe_load silently drops all but the last of a duplicated key. On a config.yaml that
    already carries two top-level `dashboard:` blocks, a plain load-merge-dump therefore DELETES
    the first block's settings and leaves a file whose `grep -c '^dashboard:'` prints a reassuring
    1. That is the worst possible failure: destructive and invisible. Refuse instead.
    """


def _no_duplicates(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            mark = key_node.start_mark
            raise yaml.YAMLError(
                f"duplicate key {key!r} at line {mark.line + 1}, column {mark.column + 1}"
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _no_duplicates)

path = sys.argv[1]

# chmod and the tmp-file replace both do the wrong thing through a symlink: chmod would silently
# retighten the TARGET's permissions, and os.replace would sever the link after copying the
# target's content into a new file. Neither is ours to do, so refuse and say what to do instead.
if os.path.islink(path):
    raise SystemExit(
        f"agent-install: {path} is a symlink to {os.path.realpath(path)}. Refusing to write "
        "through it, because that would replace the link and change the target's mode. Point "
        "--hermes-home at the directory holding the real file, or merge by hand."
    )

try:
    with open(path, "r", encoding="utf-8") as fh:
        cfg = yaml.load(fh, Loader=StrictLoader) or {}
except FileNotFoundError:
    cfg = {}
except yaml.YAMLError as exc:
    raise SystemExit(
        f"agent-install: refusing to touch {path}: {exc}\n"
        "        If this names a duplicate key, the file has two blocks with the same top-level\n"
        "        name (a second `dashboard:` is the usual one). Merging it here would silently\n"
        "        delete one of them. Open the file, fold the duplicates into a single block by\n"
        "        hand, confirm with `grep -n '^dashboard:'`, then re-run this script."
    )
if not isinstance(cfg, dict):
    raise SystemExit(f"agent-install: {path} is not a YAML mapping; refusing to overwrite it")

before = yaml.safe_dump(cfg, sort_keys=True)

# MERGE into whatever `dashboard:` block is already there. Appending a second top-level
# `dashboard:` key to this file is what breaks the YAML, and the breakage surfaces as a dashboard
# that will not start rather than as a parse error anybody reads.
dashboard = cfg.get("dashboard")
if not isinstance(dashboard, dict):
    dashboard = {}
basic = dashboard.get("basic_auth")
if not isinstance(basic, dict):
    basic = {}
basic["username"] = os.environ["DASHBOARD_BASIC_USER"]
basic["password_hash"] = os.environ["DASHBOARD_BASIC_PASSWORD_HASH"]
# A plaintext `password` next to a hash would be a second, weaker credential at rest.
basic.pop("password", None)
dashboard["basic_auth"] = basic
cfg["dashboard"] = dashboard

# PIN approvals.mode = manual, for exactly the reason the dashboard credential is merged: the
# bridge cannot work without it and the default is against us. Hermes 0.20.x defaults
# `approvals.mode` to "smart", an aux-LLM guardian that can APPROVE a dangerous tool call with NO
# event emitted at all, so the phone is never asked and the mobile approve/deny surface reads as
# intermittently broken rather than absent (cozygateway#19). `manual` is the only mode under which
# every approval reaches a human.
#
# MERGED into whatever `approvals:` block is already there, and `timeout` is deliberately left
# alone: it is the human's number, and the gateway MIRRORS it through the config file's
# `hermes.approvalTimeoutSeconds` rather than overriding it here.
approvals = cfg.get("approvals")
if not isinstance(approvals, dict):
    approvals = {}
approvals["mode"] = "manual"
cfg["approvals"] = approvals

after = yaml.safe_dump(cfg, sort_keys=True)
if after != before:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        yaml.safe_dump(cfg, fh, sort_keys=False, default_flow_style=False)
    os.replace(tmp, path)
    print(f"      merged dashboard.basic_auth into {path}")
else:
    print(f"      {path} already carries this credential (no write)")
os.chmod(path, 0o600)
PY
    # Verify by READING the file back, not by trusting the writer. This is the check that would
    # have caught a merge that wrote the wrong key, or a file some other process rewrote underneath
    # us: it re-parses the YAML, refuses duplicates again, and compares the hash byte for byte.
    DASHBOARD_BASIC_USER="$BRIDGE_USER" DASHBOARD_BASIC_PASSWORD_HASH="$PASSWORD_HASH" \
      "$HERMES_PY" - "$CONFIG_YAML" <<'PY' || die "the post-merge verification of $CONFIG_YAML failed"
import os
import sys

import yaml

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    cfg = yaml.safe_load(fh) or {}
basic = ((cfg.get("dashboard") or {}).get("basic_auth")) or {}
problems = []
if basic.get("username") != os.environ["DASHBOARD_BASIC_USER"]:
    problems.append(f"username is {basic.get('username')!r}, expected {os.environ['DASHBOARD_BASIC_USER']!r}")
if basic.get("password_hash") != os.environ["DASHBOARD_BASIC_PASSWORD_HASH"]:
    problems.append("password_hash does not match the hash this run computed")
if "password" in basic:
    problems.append("a plaintext `password` key is present next to the hash; remove it")
approvals = cfg.get("approvals") or {}
if approvals.get("mode") != "manual":
    problems.append(f"approvals.mode is {approvals.get('mode')!r}, expected 'manual'")
security = cfg.get("security") or {}
transport = (security.get("approval") or {}).get("transport")
if transport is not None and str(transport) != "builtin":
    problems.append(f"security.approval.transport is {transport!r}; it must be unset or builtin")
top = 0
with open(path, "r", encoding="utf-8") as fh:
    for line in fh:
        if line.startswith("dashboard:"):
            top += 1
if top != 1:
    problems.append(f"{top} top-level `dashboard:` keys, expected exactly 1")
if problems:
    for p in problems:
        print(f"      {p}", file=sys.stderr)
    raise SystemExit(1)
print("      verified: exactly one dashboard.basic_auth, username and password_hash match, no plaintext password")
PY
    ok "config.yaml carries exactly one dashboard.basic_auth block, approvals.mode: manual, no diverted approval transport, mode 600"
    info "note for the human: the merge reserializes the whole file, so YAML comments and anchors do not survive. Their original file is in the .bak-agent-install-* backup beside it."
  fi
fi

# ---------------------------------------------------------------------------- 5. dashboard

step "5/8 start the hermes dashboard"

dashboard_answering() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://127.0.0.1:$DASHBOARD_PORT/api/health" 2>/dev/null || echo 000)"
  # A process is listening and speaking HTTP. This says nothing about WHICH config it loaded.
  [ "$code" = "200" ] || [ "$code" = "401" ]
}

# dashboard_credential_works: the only check that proves Step 4 took effect. It is byte for byte
# the request the bridge makes (packages/gateway/src/hermes-bridge/client.ts), and the password
# goes in on stdin so it never appears in `ps`.
dashboard_credential_works() {
  local code
  code="$(
    printf '{"provider":"basic","username":"%s","password":"%s","next":"/"}' \
      "$BRIDGE_USER" "$BRIDGE_PASSWORD" |
      curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        -X POST "http://127.0.0.1:$DASHBOARD_PORT/auth/password-login" \
        -H 'content-type: application/json' --data-binary @- 2>/dev/null || echo 000
  )"
  [ "$code" = "200" ]
}

start_dashboard() {
  if lsof -nP -iTCP:"$DASHBOARD_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $DASHBOARD_PORT is taken by something that is not a healthy dashboard. Free it or pass --dashboard-port."
  fi
  if [ "$SERVICE" = "1" ]; then
    # Supervised start. There is no --skip-build retry here on purpose: the unit is long-lived, so
    # a first run that has to build the web UI simply takes longer inside the same poll rather than
    # needing a second, differently-flagged launch.
    service_write_dashboard_wrapper
    service_install_unit dashboard "$LOCAL_DIR/run-dashboard.sh" "$DASH_LOG"
    info "supervised as $(service_unit_name dashboard); waiting up to 120s for /api/health"
    local waited=0
    while [ "$waited" -lt 120 ]; do
      dashboard_answering && return 0
      sleep 1
      waited=$((waited + 1))
    done
    if [ -s "$DASH_LOG" ]; then
      warn "the supervised dashboard did not answer; last 30 log lines follow"
      tail -30 "$DASH_LOG" >&2 || true
    else
      # An EMPTY log with a unit that launchctl still calls "running" is the TCC signature, and it
      # is worth naming, because the obvious next move (read the log) has nothing to show.
      warn "the supervised dashboard did not answer and $DASH_LOG is EMPTY. A unit that runs, logs nothing and opens no port is blocked in its first directory read, which on macOS means a folder gated behind per-folder consent that a launchd agent cannot ask for. Check the --service warnings printed in the preflight above, and remember the interpreter's own sys.path counts."
    fi
    die "the $SERVICE_PLATFORM-supervised dashboard never answered on 127.0.0.1:$DASHBOARD_PORT (see $DASH_LOG). Re-run with --uninstall-service to remove the unit."
  fi
  # --skip-build: its own help text recommends it for non-interactive contexts where npm may not be
  # available, which is exactly this one. If the web UI has never been built, `hermes dashboard`
  # without it will build on first run; we retry that way once before giving up.
  ( cd "$HOME" && HERMES_HOME="$HERMES_HOME_DIR" nohup hermes dashboard \
      --host "$DASHBOARD_HOST" --port "$DASHBOARD_PORT" --no-open --skip-build >"$DASH_LOG" 2>&1 & )
  info "started (--skip-build); waiting up to 60s for /api/health"
  local i
  for i in $(seq 1 60); do
    dashboard_answering && return 0
    sleep 1
  done
  warn "no answer with --skip-build; retrying without it, which builds the web UI (slow)"
  ( cd "$HOME" && HERMES_HOME="$HERMES_HOME_DIR" nohup hermes dashboard \
      --host "$DASHBOARD_HOST" --port "$DASHBOARD_PORT" --no-open >>"$DASH_LOG" 2>&1 & )
  for i in $(seq 1 180); do
    dashboard_answering && return 0
    sleep 1
  done
  warn "dashboard did not become healthy; last 30 log lines follow"
  tail -30 "$DASH_LOG" >&2 || true
  die "hermes dashboard did not come up (see $DASH_LOG). \`hermes dashboard --status\` lists running servers."
}

if [ "$SKIP_DASHBOARD" = "1" ] || [ "$NO_START" = "1" ]; then
  info "skipped (--skip-dashboard or --no-start)"
elif dry; then
  if [ "$SERVICE" = "1" ]; then
    service_stop_unit dashboard
    printf 'DRY   stop any dashboard already answering on 127.0.0.1:%s, supervised or not, so the unit can own the port\n' "$DASHBOARD_PORT"
    service_write_dashboard_wrapper
    service_install_unit dashboard "$LOCAL_DIR/run-dashboard.sh" "$DASH_LOG"
  else
    printf 'DRY   nohup hermes dashboard --host %s --port %s --no-open --skip-build > %s 2>&1 &\n' \
      "$DASHBOARD_HOST" "$DASHBOARD_PORT" "$DASH_LOG"
  fi
  printf 'DRY   POST /auth/password-login as %s to prove the merged credential loaded\n' "$BRIDGE_USER"
elif [ "$SERVICE" = "1" ]; then
  # ADOPT, unconditionally. Everything --service prints promises that the dashboard comes back after
  # a crash and at login, and only a unit can keep that promise. The tempting shortcut, "a dashboard
  # is already answering and its credential works, so leave it alone", is exactly the case that
  # breaks the promise: Hermes runs ONE machine-level dashboard by default, so an already-running
  # unsupervised one is the COMMON case, not the edge case, and skipping it would end the run green
  # with a nohup'd dashboard and a claim of supervision that is simply false.
  #
  # So the sequence is always the same, and it is ordered the only way that works:
  #   1. unload our own unit, if any, so KeepAlive cannot restart what step 2 stops;
  #   2. stop whatever is still answering, supervised or not, and wait for the port;
  #   3. install the unit and let it own the port from here on.
  service_stop_unit dashboard
  if dashboard_answering; then
    if dashboard_credential_works; then
      info "a dashboard is already answering on 127.0.0.1:$DASHBOARD_PORT and its credential works. Nothing supervises it now (any unit of ours was just unloaded), so it is stopped and restarted under the $SERVICE_PLATFORM unit rather than left holding the port."
    else
      warn "a dashboard is already running with the PREVIOUS config; the credential merged in step 4 has not loaded. Stopping it so the $SERVICE_PLATFORM unit can own it."
    fi
    if HERMES_HOME="$HERMES_HOME_DIR" hermes dashboard --stop >>"$DASH_LOG" 2>&1; then
      info "hermes dashboard --stop returned; waiting for the port to free"
    else
      warn "hermes dashboard --stop failed; see $DASH_LOG"
    fi
    # Wait for the SOCKET, not just for HTTP. start_dashboard's first act is an lsof LISTEN check
    # that dies with "port taken by something that is not a healthy dashboard", so a process whose
    # HTTP stack has died while it still holds the socket would sail past a health-only wait and
    # then abort the run with a message describing the wrong problem.
    for i in $(seq 1 30); do
      dashboard_answering || port_listening "$DASHBOARD_PORT" || break
      sleep 1
    done
    if dashboard_answering || port_listening "$DASHBOARD_PORT"; then
      die "port $DASHBOARD_PORT is still held after \`hermes dashboard --stop\`, so the unit cannot take it. Stop it by hand (\`hermes dashboard --status\` names the processes, \`lsof -nP -iTCP:$DASHBOARD_PORT -sTCP:LISTEN\` names the socket) and re-run."
    fi
    ok "the unsupervised dashboard is stopped and the port is free"
  fi
  start_dashboard
  if ! dashboard_credential_works; then
    warn "last 30 dashboard log lines follow"
    tail -30 "$DASH_LOG" >&2 || true
    die "POST /auth/password-login as $BRIDGE_USER did not return 200 against the supervised dashboard, so the bridge will not log in either. Check $HERMES_HOME_DIR/config.yaml, then re-run."
  fi
  ok "dashboard healthy on 127.0.0.1:$DASHBOARD_PORT, supervised as $(service_unit_name dashboard), and the bridge credential logs in (log: $DASH_LOG)"
else
  if dashboard_answering; then
    # A dashboard was ALREADY up. Hermes runs one machine-level server by default, so this is the
    # common case, not the edge case, and that process is still holding the config it read at
    # startup: the basic_auth block merged a moment ago is not in it. A 200 from /api/health proves
    # only that something is listening. Only a login proves the new credential loaded.
    if dashboard_credential_works; then
      ok "a dashboard was already answering on 127.0.0.1:$DASHBOARD_PORT and the merged credential logs in"
    else
      warn "a dashboard was already running with the PREVIOUS config; the credential merged in step 4 has not loaded. Restarting it."
      if run hermes dashboard --stop >>"$DASH_LOG" 2>&1; then
        info "hermes dashboard --stop returned; waiting for the port to free"
      else
        warn "hermes dashboard --stop failed; see $DASH_LOG"
      fi
      for i in $(seq 1 30); do
        dashboard_answering || break
        sleep 1
      done
      dashboard_answering && die "the old dashboard is still answering after --stop. Stop it by hand (\`hermes dashboard --status\` names the processes) and re-run."
      start_dashboard
    fi
  else
    start_dashboard
  fi

  if ! dashboard_credential_works; then
    warn "last 30 dashboard log lines follow"
    tail -30 "$DASH_LOG" >&2 || true
    die "POST /auth/password-login as $BRIDGE_USER did not return 200, so the bridge will not log in either. The dashboard is running with a config that does not carry this credential: check $HERMES_HOME_DIR/config.yaml, then \`hermes dashboard --stop\` and re-run."
  fi
  ok "dashboard healthy on 127.0.0.1:$DASHBOARD_PORT and the bridge credential logs in (log: $DASH_LOG)"
fi

# ---------------------------------------------------------------------------- 6. gateway config

step "6/8 write the gateway config"

if [ "$RUNTIME" = "docker" ]; then
  DB_PATH="/data/cozygateway.db"
  BIND_HOST="0.0.0.0"
else
  DB_PATH="$LOCAL_DIR/cozygateway.db"
  BIND_HOST="0.0.0.0"
fi

# Built by json.dumps, not by interpolating into a heredoc. A gateway name containing a quote, a
# --gateway-dir containing a backslash, or a profile name with either would otherwise emit a JSON
# file the gateway refuses to load, and the error would point at the config rather than the flag.
CONFIG_BODY="$(
  CFG_NAME="$GATEWAY_NAME" CFG_PORT="$GATEWAY_PORT" CFG_HOST="$BIND_HOST" CFG_DB="$DB_PATH" \
  CFG_WS="ws://$HERMES_WS_HOST:$DASHBOARD_PORT/api/ws" CFG_USER="$BRIDGE_USER" \
  CFG_HIDDEN="$HIDDEN_PROFILES" "$HERMES_PY" - <<'PY'
import json
import os

hidden = [p.strip() for p in os.environ["CFG_HIDDEN"].split(",") if p.strip()]
print(json.dumps({
    "name": os.environ["CFG_NAME"],
    "port": int(os.environ["CFG_PORT"]),
    "host": os.environ["CFG_HOST"],
    "dbPath": os.environ["CFG_DB"],
    "agents": [],
    "hermes": {
        "url": os.environ["CFG_WS"],
        "authMode": "password",
        "username": os.environ["CFG_USER"],
        "passwordEnv": "COZYGATEWAY_HERMES_PASSWORD",
        "hiddenProfiles": hidden,
    },
}, indent=2))
PY
)"
[ -n "$CONFIG_BODY" ] || die "could not render the gateway config JSON with $HERMES_PY"

if dry; then
  printf 'DRY   write %s:\n%s\n' "$CONFIG_JSON" "$CONFIG_BODY"
else
  printf '%s\n' "$CONFIG_BODY" > "$CONFIG_JSON"
  ok "wrote $CONFIG_JSON (agents: [], hermes block present)"
fi

# .env: compose reads it, and every value in it goes through interpolation.
#
# This file is SHARED. docker-compose.yml reads COZY_RELAY_PORT and five APNS_* variables from it
# for the push relay, and the human may keep anything else there too. So the installer owns exactly
# three keys and MERGES them in: every other line survives byte for byte, in place, including
# comments and blank lines.
if dry; then
  printf 'DRY   merge COZYGATEWAY_ATTACH_TOKEN, COZYGATEWAY_HERMES_PASSWORD and COZYGATEWAY_PORT into %s, preserving every other key\n' "$ENV_FILE"
else
  ATTACH_TOKEN=""
  if [ -f "$ENV_FILE" ]; then
    ATTACH_TOKEN="$(sed -n 's/^COZYGATEWAY_ATTACH_TOKEN=//p' "$ENV_FILE" | head -1)"
  fi
  if [ -z "$ATTACH_TOKEN" ]; then
    ATTACH_TOKEN="$(gen_secret 48)"
  fi
  # Double every '$' so compose interpolation hands the container the literal value. This is the
  # exact failure that produced a 401 bridge login on our own box: a scrypt hash lost everything
  # from its first '$' onward and arrived 36 characters long.
  ESCAPED_PASSWORD="${BRIDGE_PASSWORD//\$/\$\$}"
  umask 077
  ENV_PATH="$ENV_FILE" ENV_ATTACH_TOKEN="$ATTACH_TOKEN" ENV_HERMES_PASSWORD="$ESCAPED_PASSWORD" \
    ENV_GATEWAY_PORT="$GATEWAY_PORT" "$HERMES_PY" - <<'PY' || die "could not update $ENV_FILE"
import os

path = os.environ["ENV_PATH"]
owned = {
    "COZYGATEWAY_ATTACH_TOKEN": os.environ["ENV_ATTACH_TOKEN"],
    "COZYGATEWAY_HERMES_PASSWORD": os.environ["ENV_HERMES_PASSWORD"],
    "COZYGATEWAY_PORT": os.environ["ENV_GATEWAY_PORT"],
}

try:
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
except FileNotFoundError:
    lines = [
        "# Generated by scripts/agent-install.sh. Values here are interpolated by compose:",
        "# any literal $ must be written as $$.",
    ]

seen = set()
out = []
for line in lines:
    key = line.split("=", 1)[0].strip() if "=" in line else None
    if key in owned and key not in seen:
        out.append(f"{key}={owned[key]}")
        seen.add(key)
    elif key in owned:
        # A duplicate of a key we own: the later one wins in compose, so dropping it keeps the file
        # honest rather than leaving a stale shadow behind.
        continue
    else:
        out.append(line)
for key, value in owned.items():
    if key not in seen:
        out.append(f"{key}={value}")

tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.write("\n".join(out).rstrip("\n") + "\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
kept = len([l for l in lines if "=" in l and l.split("=", 1)[0].strip() not in owned])
print(f"      merged 3 owned keys into {path}; {kept} other assignment(s) preserved")
PY
  chmod 600 "$ENV_FILE"
  ok "updated $ENV_FILE (mode 600, '\$' doubled for compose, unrelated keys untouched)"
fi

write_install_env

# ---------------------------------------------------------------------------- 7. start gateway

step "7/8 start the gateway"

gateway_health() {
  curl -fsS --max-time 5 "http://127.0.0.1:$GATEWAY_PORT/health" 2>/dev/null
}

if [ "$NO_START" = "1" ]; then
  info "--no-start: configured but not started"
elif dry; then
  if [ "$SERVICE" = "1" ]; then
    if [ "$RUNTIME" = "node" ]; then
      printf 'DRY   (cd %s && pnpm install && pnpm build)\n' "$GATEWAY_DIR"
    fi
    service_stop_unit gateway
    adopt_unsupervised_gateway
    service_write_gateway_wrapper
    service_install_unit gateway "$LOCAL_DIR/run-gateway.sh" "$GW_LOG"
  elif [ "$RUNTIME" = "docker" ]; then
    printf 'DRY   (cd %s && docker compose -f docker-compose.yml -f %s up -d --build gateway)\n' \
      "$GATEWAY_DIR" "$OVERRIDE_REL"
  elif [ "$RUNTIME" = "bundle" ]; then
    printf 'DRY   %s %s serve --config %s   (no pnpm install, no build)\n' \
      "$COZY_NODE" "$BUNDLE_PATH" "$CONFIG_JSON"
  else
    printf 'DRY   (cd %s && pnpm install && pnpm build && node packages/gateway/dist/cli.js serve --config %s)\n' \
      "$GATEWAY_DIR" "$CONFIG_JSON"
  fi
elif [ "$SERVICE" = "1" ]; then
  # Supervised start, bundle or node. The health poll, the capability check and the roster probe
  # below are untouched: they ask the running gateway the same questions either way -- which is
  # exactly why the port has to be OURS before they run. A green poll answered by an unsupervised
  # process is indistinguishable from a green poll answered by the unit.
  if [ "$RUNTIME" = "node" ]; then
    ( cd "$GATEWAY_DIR" && pnpm install --frozen-lockfile && pnpm build )
  fi
  service_stop_unit gateway
  adopt_unsupervised_gateway
  service_write_gateway_wrapper
  service_install_unit gateway "$LOCAL_DIR/run-gateway.sh" "$GW_LOG"
  ok "the gateway is supervised by $SERVICE_PLATFORM as $(service_unit_name gateway) (log: $GW_LOG)"
elif [ "$RUNTIME" = "docker" ]; then
  [ -f "$GATEWAY_DIR/$OVERRIDE_REL" ] || die "missing $OVERRIDE_REL in the checkout; pull a newer main"
  ( cd "$GATEWAY_DIR" && docker compose -f docker-compose.yml -f "$OVERRIDE_REL" up -d --build gateway )
  ok "compose brought up the gateway service"
elif [ "$RUNTIME" = "bundle" ]; then
  ( COZYGATEWAY_HERMES_PASSWORD="$BRIDGE_PASSWORD" nohup "$COZY_NODE" \
      "$BUNDLE_PATH" serve --config "$CONFIG_JSON" >"$GW_LOG" 2>&1 & )
  ok "started the gateway from the bundle (log: $GW_LOG)"
else
  ( cd "$GATEWAY_DIR" && pnpm install --frozen-lockfile && pnpm build )
  ( cd "$GATEWAY_DIR" && COZYGATEWAY_HERMES_PASSWORD="$BRIDGE_PASSWORD" nohup node \
      packages/gateway/dist/cli.js serve --config "$CONFIG_JSON" >"$GW_LOG" 2>&1 & )
  ok "started the gateway with node (log: $GW_LOG)"
fi

if [ "$NO_START" = "0" ] && ! dry; then
  info "waiting up to 90s for /health"
  HEALTH=""
  for i in $(seq 1 90); do
    HEALTH="$(gateway_health || true)"
    [ -n "$HEALTH" ] && break
    if [ "$i" = "90" ]; then die "gateway /health never answered on 127.0.0.1:$GATEWAY_PORT"; fi
    sleep 1
  done
  ok "GET /health -> $HEALTH"
  case "$HEALTH" in
    *com.cozylabs.bots*) ok "the com.cozylabs.bots capability is advertised; the bridge is configured" ;;
    *) die "no com.cozylabs.bots in /health: the hermes block did not load. Check the gateway logs." ;;
  esac

  # Prove the roster surface for real. /bots sits behind requireDevice (packages/gateway/src/http.ts),
  # so an unauthenticated GET is a 401 no matter how healthy the bridge is: a check that reads its
  # body and shrugs at an empty-looking result would pass on a completely broken install. So pair a
  # throwaway device, call /bots with its token, assert the status code, and revoke the device
  # again. Nothing survives this check.
  ROSTER_JSON="$(mint_pair_json || true)"
  SETUP_CODE="$(printf '%s' "$ROSTER_JSON" | sed -n 's/.*"setupCode":"\([^"]*\)".*/\1/p')"
  if [ -z "$SETUP_CODE" ]; then
    warn "could not mint a setup code for the roster check; skipping it (the capability check above still passed)"
  else
    PAIR_RESPONSE="$(printf '{"setupCode":"%s","deviceName":"install-check"}' "$SETUP_CODE" |
      curl -sS --max-time 10 -X POST "http://127.0.0.1:$GATEWAY_PORT/pair" \
        -H 'content-type: application/json' --data-binary @- 2>/dev/null || true)"
    DEVICE_TOKEN="$(printf '%s' "$PAIR_RESPONSE" | sed -n 's/.*"deviceToken":"\([^"]*\)".*/\1/p')"
    DEVICE_ID="$(printf '%s' "$PAIR_RESPONSE" | sed -n 's/.*"device":{"id":"\([^"]*\)".*/\1/p')"
    [ -n "$DEVICE_TOKEN" ] || die "POST /pair with a freshly minted code did not return a device token: $PAIR_RESPONSE"
    BOTS_BODY="$(curl -sS --max-time 10 -w '\n%{http_code}' \
      -H "authorization: Bearer $DEVICE_TOKEN" "http://127.0.0.1:$GATEWAY_PORT/bots" 2>/dev/null || true)"
    BOTS_CODE="$(printf '%s' "$BOTS_BODY" | tail -1)"
    BOTS_JSON="$(printf '%s' "$BOTS_BODY" | sed '$d')"
    if [ -n "$DEVICE_ID" ]; then
      curl -sS -o /dev/null --max-time 10 -X DELETE \
        -H "authorization: Bearer $DEVICE_TOKEN" \
        "http://127.0.0.1:$GATEWAY_PORT/devices/$DEVICE_ID" 2>/dev/null || \
        warn "could not revoke the throwaway install-check device $DEVICE_ID; delete it from the app's device list"
    fi
    [ "$BOTS_CODE" = "200" ] || die "GET /bots as a paired device returned $BOTS_CODE, not 200: $BOTS_JSON"
    ok "GET /bots as a paired device -> 200; the throwaway install-check device was revoked"
    info "roster: $BOTS_JSON"
    case "$BOTS_JSON" in
      '{"bots":[]'*) info "the roster is EMPTY. That is a real 200, not a failure: the human has no visible bot profiles yet, or they are all in hiddenProfiles ($HIDDEN_PROFILES)." ;;
    esac
  fi
fi

# ---------------------------------------------------------------------------- 8. pairing

step "8/8 pairing code"

if [ "$NO_START" = "1" ]; then
  info "--no-start: nothing to pair against yet"
else
  mint_pair
fi

step "done"

# The phone cannot reach the gateway's loopback, so print the address the human actually types.
# `hostname` is NOT a fallback: it printed a bare LAN hostname here that no phone could resolve,
# which is worse than admitting we do not know. Try the real interfaces, then say so.
lan_address() {
  local addr=""
  if have ipconfig; then
    local iface
    iface="$(route -n get default 2>/dev/null | sed -n 's/.*interface: *//p' | head -1 || true)"
    for candidate in ${iface:-} en0 en1 en2; do
      addr="$(ipconfig getifaddr "$candidate" 2>/dev/null || true)"
      [ -n "$addr" ] && { printf '%s' "$addr"; return 0; }
    done
  fi
  if have hostname; then
    addr="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    [ -n "$addr" ] && { printf '%s' "$addr"; return 0; }
  fi
  if have ip; then
    addr="$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1 || true)"
    [ -n "$addr" ] && { printf '%s' "$addr"; return 0; }
  fi
  return 1
}

LAN_ADDR="$(lan_address || true)"
if [ -n "${LAN_ADDR:-}" ]; then
  info "Gateway:   http://$LAN_ADDR:$GATEWAY_PORT  (the address the app pairs against, not 127.0.0.1)"
else
  warn "could not determine this machine's LAN address. Do NOT give the human 127.0.0.1 or the bare hostname: find the address with 'ifconfig' / 'ip -4 addr' and hand them http://<that address>:$GATEWAY_PORT."
fi
info "Dashboard: http://$DASHBOARD_HOST:$DASHBOARD_PORT  (user $BRIDGE_USER; reachable on 127.0.0.1:$DASHBOARD_PORT from this machine)"
if [ "$SERVICE" = "1" ]; then
  if [ "$SERVICE_PLATFORM" = "launchd" ]; then
    info "Supervised by launchd: \`launchctl print gui/$(id -u)/$SERVICE_LABEL_GATEWAY\` shows state and pid. Remove both units with \`bash scripts/agent-install.sh --uninstall-service\`."
  else
    info "Supervised by systemd --user: \`systemctl --user status $SERVICE_UNIT_GATEWAY\`. Remove both units with \`bash scripts/agent-install.sh --uninstall-service\`."
  fi
fi
info "State the playbook reads: $INSTALL_ENV and $CRED_FILE (both mode 600)"
info "Read docs/agent-install.md for the verification steps this script does not do."

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
# re-running it on a finished box changes nothing. Nothing here is destructive; the one file it
# rewrites outside its own directory is the Hermes config.yaml, and that is merged (never
# replaced) after a timestamped backup.
#
# Usage:
#   bash scripts/agent-install.sh --dry-run
#   bash scripts/agent-install.sh
#
# Flags: --help prints them all.
#
set -euo pipefail

# ---------------------------------------------------------------------------- defaults

DRY_RUN=0
GATEWAY_DIR="${COZYGATEWAY_DIR:-$HOME/cozygateway}"
REPO_URL="${COZYGATEWAY_REPO:-https://github.com/shiftedx/cozygateway.git}"
HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
DASHBOARD_HOST="0.0.0.0"
DASHBOARD_PORT="9119"
GATEWAY_PORT="8787"
BRIDGE_USER="cozybridge"
BRIDGE_PASSWORD=""
RUNTIME="auto"
HIDDEN_PROFILES="default"
GATEWAY_NAME="cozy-bots"
SKIP_DASHBOARD=0
NO_START=0
PAIR_ONLY=0

usage() {
  cat <<'USAGE'
usage: bash scripts/agent-install.sh [flags]

  --dry-run                 print every action, change nothing
  --gateway-dir DIR         where the repo lives / is cloned (default: $HOME/cozygateway)
  --repo URL                git remote to clone (default: the public cozygateway repo)
  --hermes-home DIR         Hermes home holding config.yaml (default: $HERMES_HOME or ~/.hermes)
  --dashboard-host HOST     dashboard bind host (default: 0.0.0.0; auth is mandatory off loopback)
  --dashboard-port PORT     dashboard port (default: 9119)
  --gateway-port PORT       gateway port (default: 8787)
  --username NAME           dashboard/bridge username (default: cozybridge)
  --password VALUE          dashboard password (default: generated, '$'-free)
  --hidden-profiles A,B     Hermes profiles kept off the bots roster (default: default)
  --gateway-name NAME       gateway display name (default: cozy-bots)
  --runtime docker|node     force a runtime (default: auto, docker when present)
  --skip-dashboard          do not touch config.yaml and do not start `hermes dashboard`
  --no-start                configure everything, start nothing
  --pair-only               skip straight to minting a pairing code against a running gateway
  -h, --help                this text

Everything it generates lands in <gateway-dir>/local (git-ignored) plus <gateway-dir>/.env.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --gateway-dir) GATEWAY_DIR="$2"; shift ;;
    --repo) REPO_URL="$2"; shift ;;
    --hermes-home) HERMES_HOME_DIR="$2"; shift ;;
    --dashboard-host) DASHBOARD_HOST="$2"; shift ;;
    --dashboard-port) DASHBOARD_PORT="$2"; shift ;;
    --gateway-port) GATEWAY_PORT="$2"; shift ;;
    --username) BRIDGE_USER="$2"; shift ;;
    --password) BRIDGE_PASSWORD="$2"; shift ;;
    --hidden-profiles) HIDDEN_PROFILES="$2"; shift ;;
    --gateway-name) GATEWAY_NAME="$2"; shift ;;
    --runtime) RUNTIME="$2"; shift ;;
    --skip-dashboard) SKIP_DASHBOARD=1 ;;
    --no-start) NO_START=1 ;;
    --pair-only) PAIR_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

LOCAL_DIR="$GATEWAY_DIR/local"
CONFIG_JSON="$LOCAL_DIR/cozygateway.config.json"
ENV_FILE="$GATEWAY_DIR/.env"
CRED_FILE="$LOCAL_DIR/dashboard-credentials.txt"
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
mint_pair() {
  if dry; then
    printf 'DRY   mint a pairing code via the cozygateway CLI\n'
    return 0
  fi
  local out=""
  if [ "$RUNTIME" = "docker" ]; then
    out="$( cd "$GATEWAY_DIR" && docker compose -f docker-compose.yml -f "$OVERRIDE_REL" \
      exec -T gateway node dist/cli.js pair --config /app/cozygateway.config.json )"
  else
    out="$( cd "$GATEWAY_DIR" && node packages/gateway/dist/cli.js pair --config "$CONFIG_JSON" )"
  fi
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

# The interpreter Hermes itself runs under is the one that can import plugins.dashboard_auth.basic.
# COZYGATEWAY_HERMES_PY overrides the guess, for an install whose `hermes` is a wrapper script
# rather than a console entry point (its shebang then names a shell, not a python).
HERMES_PY="${COZYGATEWAY_HERMES_PY:-python3}"
if [ -z "${COZYGATEWAY_HERMES_PY:-}" ] && have hermes; then
  SHEBANG="$(head -1 "$(command -v hermes)" 2>/dev/null | sed -n 's/^#!\(.*\)$/\1/p' | awk '{print $NF}')"
  if [ -n "${SHEBANG:-}" ] && [ -x "$SHEBANG" ]; then
    HERMES_PY="$SHEBANG"
  fi
fi
have "$HERMES_PY" || [ -x "$HERMES_PY" ] || die "no usable python3 found (needed for the password hash and the config merge)"
ok "python for hermes helpers: $HERMES_PY"

if [ "$RUNTIME" = "auto" ]; then
  if have docker && docker compose version >/dev/null 2>&1; then
    RUNTIME="docker"
  elif have node; then
    RUNTIME="node"
  else
    die "neither 'docker compose' nor 'node' is available; install one of them"
  fi
fi
case "$RUNTIME" in
  docker)
    have docker || die "--runtime docker but docker is not installed"
    docker compose version >/dev/null 2>&1 || die "docker is installed but 'docker compose' is not"
    docker info >/dev/null 2>&1 || die "the docker daemon is not reachable; start Docker and retry"
    ok "runtime: docker ($(docker compose version | head -1))"
    ;;
  node)
    have node || die "--runtime node but node is not installed"
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$NODE_MAJOR" -ge 24 ] || die "node $NODE_MAJOR is too old; the gateway requires node 24 or newer"
    have pnpm || die "pnpm is required for the node path (npm i -g pnpm@10)"
    ok "runtime: node $(node -v) with $(pnpm --version)"
    ;;
  *) die "--runtime must be 'docker' or 'node', got '$RUNTIME'" ;;
esac

# ws host the CONTAINER (or process) uses to reach the dashboard on this machine.
if [ "$RUNTIME" = "docker" ]; then
  HERMES_WS_HOST="host.docker.internal"
else
  HERMES_WS_HOST="127.0.0.1"
fi
info "bridge will dial ws://$HERMES_WS_HOST:$DASHBOARD_PORT/api/ws"

# ---------------------------------------------------------------------------- 2. the repo

step "2/8 get the gateway source"

if [ -d "$GATEWAY_DIR/.git" ]; then
  ok "repo already at $GATEWAY_DIR"
  run git -C "$GATEWAY_DIR" fetch --quiet origin || warn "git fetch failed; using the checkout as-is"
else
  run git clone --quiet "$REPO_URL" "$GATEWAY_DIR" || die "clone failed"
  dry || ok "cloned $REPO_URL into $GATEWAY_DIR"
fi

run mkdir -p "$LOCAL_DIR"
# A self-ignoring generated directory: no root .gitignore edit needed, and nothing generated here
# can ever be committed by accident.
if dry; then
  printf 'DRY   write %s/.gitignore so nothing generated here can be committed\n' "$LOCAL_DIR"
else
  [ -f "$LOCAL_DIR/.gitignore" ] || printf '*\n!.gitignore\n' > "$LOCAL_DIR/.gitignore"
  ok "generated artifacts directory: $LOCAL_DIR (self-ignoring)"
fi

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
else
  RECORDED_HASH=""
  if [ -z "$BRIDGE_PASSWORD" ] && [ -f "$CRED_FILE" ]; then
    BRIDGE_PASSWORD="$(sed -n 's/^password=//p' "$CRED_FILE" | head -1)"
    if [ -n "$BRIDGE_PASSWORD" ]; then
      # Reuse the recorded hash too. Re-hashing the same password mints a new salt, which would
      # rewrite config.yaml on every run and make a no-op run indistinguishable from a real change.
      RECORDED_HASH="$(sed -n 's/^password_hash=//p' "$CRED_FILE" | head -1)"
      ok "reusing the password already recorded in $CRED_FILE"
    fi
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
    PASSWORD_HASH="$(
      "$HERMES_PY" - "$BRIDGE_PASSWORD" <<'PY' 2>/dev/null || true
import sys
try:
    from plugins.dashboard_auth.basic import hash_password
except ModuleNotFoundError:
    # Not importable from the CWD: find the install root next to hermes_cli and retry.
    import os
    import hermes_cli
    root = os.path.dirname(os.path.dirname(os.path.abspath(hermes_cli.__file__)))
    sys.path.insert(0, root)
    from plugins.dashboard_auth.basic import hash_password
print(hash_password(sys.argv[1]))
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

step "4/8 merge dashboard.basic_auth into the Hermes config"

if [ "$SKIP_DASHBOARD" = "1" ]; then
  info "skipped"
else
  CONFIG_YAML="$HERMES_HOME_DIR/config.yaml"
  info "target: $CONFIG_YAML"
  if dry; then
    printf 'DRY   merge dashboard.basic_auth {username, password_hash} into %s\n' "$CONFIG_YAML"
  else
    mkdir -p "$HERMES_HOME_DIR"
    # Back up only when the merge can actually change something. A re-run on a finished box would
    # otherwise litter the human's Hermes home with a new backup every time.
    if [ -f "$CONFIG_YAML" ] && ! grep -qF "$PASSWORD_HASH" "$CONFIG_YAML"; then
      BACKUP="$CONFIG_YAML.bak-agent-install-$(date +%Y%m%d%H%M%S)"
      cp "$CONFIG_YAML" "$BACKUP"
      ok "backed up the existing config to $BACKUP"
    fi
    DASHBOARD_BASIC_USER="$BRIDGE_USER" DASHBOARD_BASIC_PASSWORD_HASH="$PASSWORD_HASH" \
      "$HERMES_PY" - "$CONFIG_YAML" <<'PY'
import os
import sys

import yaml

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
except FileNotFoundError:
    cfg = {}
except yaml.YAMLError as exc:
    raise SystemExit(f"agent-install: {path} is not parseable YAML; refusing to overwrite it: {exc}")
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
    ok "config.yaml carries exactly one dashboard.basic_auth block, mode 600"
  fi
fi

# ---------------------------------------------------------------------------- 5. dashboard

step "5/8 start the hermes dashboard"

dashboard_healthy() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://127.0.0.1:$DASHBOARD_PORT/api/health" 2>/dev/null || echo 000)"
  # 401 is a HEALTHY answer here: the process is up and auth is on, which is the point.
  [ "$code" = "200" ] || [ "$code" = "401" ]
}

if [ "$SKIP_DASHBOARD" = "1" ] || [ "$NO_START" = "1" ]; then
  info "skipped (--skip-dashboard or --no-start)"
elif dry; then
  printf 'DRY   nohup hermes dashboard --host %s --port %s --no-open > %s 2>&1 &\n' \
    "$DASHBOARD_HOST" "$DASHBOARD_PORT" "$DASH_LOG"
elif dashboard_healthy; then
  ok "a dashboard is already answering on 127.0.0.1:$DASHBOARD_PORT"
else
  if lsof -nP -iTCP:"$DASHBOARD_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "port $DASHBOARD_PORT is taken by something that is not a healthy dashboard. Free it or pass --dashboard-port."
  fi
  ( cd "$HOME" && HERMES_HOME="$HERMES_HOME_DIR" nohup hermes dashboard \
      --host "$DASHBOARD_HOST" --port "$DASHBOARD_PORT" --no-open >"$DASH_LOG" 2>&1 & )
  info "started; waiting up to 120s for /api/health (a first run may build the web UI)"
  for i in $(seq 1 120); do
    if dashboard_healthy; then break; fi
    if [ "$i" = "120" ]; then
      warn "dashboard did not become healthy; last 30 log lines follow"
      tail -30 "$DASH_LOG" >&2 || true
      die "hermes dashboard did not come up (see $DASH_LOG)"
    fi
    sleep 1
  done
  ok "dashboard healthy on 127.0.0.1:$DASHBOARD_PORT (log: $DASH_LOG)"
fi

# ---------------------------------------------------------------------------- 6. gateway config

step "6/8 write the gateway config"

HIDDEN_JSON="$(
  printf '%s' "$HIDDEN_PROFILES" | awk -F, '{
    out=""
    for (i = 1; i <= NF; i++) {
      gsub(/^[ \t]+|[ \t]+$/, "", $i)
      if ($i == "") continue
      out = (out == "" ? "" : out ", ") "\"" $i "\""
    }
    print out
  }'
)"

if [ "$RUNTIME" = "docker" ]; then
  DB_PATH="/data/cozygateway.db"
  BIND_HOST="0.0.0.0"
else
  DB_PATH="$LOCAL_DIR/cozygateway.db"
  BIND_HOST="0.0.0.0"
fi

CONFIG_BODY="$(cat <<JSON
{
  "name": "$GATEWAY_NAME",
  "port": $GATEWAY_PORT,
  "host": "$BIND_HOST",
  "dbPath": "$DB_PATH",
  "agents": [],
  "hermes": {
    "url": "ws://$HERMES_WS_HOST:$DASHBOARD_PORT/api/ws",
    "authMode": "password",
    "username": "$BRIDGE_USER",
    "passwordEnv": "COZYGATEWAY_HERMES_PASSWORD",
    "hiddenProfiles": [$HIDDEN_JSON]
  }
}
JSON
)"

if dry; then
  printf 'DRY   write %s:\n%s\n' "$CONFIG_JSON" "$CONFIG_BODY"
else
  printf '%s\n' "$CONFIG_BODY" > "$CONFIG_JSON"
  ok "wrote $CONFIG_JSON (agents: [], hermes block present)"
fi

# .env: compose reads it, and every value in it goes through interpolation.
if dry; then
  printf 'DRY   write %s with COZYGATEWAY_HERMES_PASSWORD and a random COZYGATEWAY_ATTACH_TOKEN\n' "$ENV_FILE"
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
  {
    printf '# Generated by scripts/agent-install.sh. Values here are interpolated by compose:\n'
    printf '# any literal $ must be written as $$.\n'
    printf 'COZYGATEWAY_ATTACH_TOKEN=%s\n' "$ATTACH_TOKEN"
    printf 'COZYGATEWAY_HERMES_PASSWORD=%s\n' "$ESCAPED_PASSWORD"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "wrote $ENV_FILE (mode 600, '\$' doubled for compose)"
fi

# ---------------------------------------------------------------------------- 7. start gateway

step "7/8 start the gateway"

gateway_health() {
  curl -fsS --max-time 5 "http://127.0.0.1:$GATEWAY_PORT/health" 2>/dev/null
}

if [ "$NO_START" = "1" ]; then
  info "--no-start: configured but not started"
elif dry; then
  if [ "$RUNTIME" = "docker" ]; then
    printf 'DRY   (cd %s && docker compose -f docker-compose.yml -f %s up -d --build gateway)\n' \
      "$GATEWAY_DIR" "$OVERRIDE_REL"
  else
    printf 'DRY   (cd %s && pnpm install && pnpm build && node packages/gateway/dist/cli.js serve --config %s)\n' \
      "$GATEWAY_DIR" "$CONFIG_JSON"
  fi
elif [ "$RUNTIME" = "docker" ]; then
  [ -f "$GATEWAY_DIR/$OVERRIDE_REL" ] || die "missing $OVERRIDE_REL in the checkout; pull a newer main"
  ( cd "$GATEWAY_DIR" && docker compose -f docker-compose.yml -f "$OVERRIDE_REL" up -d --build gateway )
  ok "compose brought up the gateway service"
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
LAN_ADDR="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -n "${LAN_ADDR:-}" ] || LAN_ADDR="$(hostname)"
info "Gateway:   http://$LAN_ADDR:$GATEWAY_PORT  (the address the app pairs against, not 127.0.0.1)"
info "Dashboard: http://127.0.0.1:$DASHBOARD_PORT  (user $BRIDGE_USER)"
info "Read docs/agent-install.md for the verification steps this script does not do."

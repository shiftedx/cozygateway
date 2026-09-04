# Simple Service Install (one-liner, no Docker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-technical user install cozygateway as a persistent background service with one pasted line (`curl -fsSL https://cozylabs.ai/install.sh | bash`), no Docker, no git, no pnpm — while the existing Docker compose path remains the homelab/self-hoster track, untouched.

**Architecture:** Three pieces. (1) A single-file esbuild bundle of the gateway CLI (`cozygateway.mjs`), built by a new script and attached to GitHub Releases by a new tag-driven workflow — Node ≥24 is the only runtime dependency (sqlite is `node:sqlite`). (2) `scripts/agent-install.sh` grows two orthogonal capabilities: `--bundle <path>` (run the prebuilt bundle instead of cloning/building the repo) and `--service` (register launchd LaunchAgents on macOS / systemd user units on Linux for the gateway AND the hermes dashboard, replacing the nohup path, plus `--uninstall-service`). (3) A thin bootstrap `scripts/install.sh` that checks Node, downloads the latest release bundle + `agent-install.sh` with sha256 verification, and execs the installer with `--gateway-dir ~/.cozygateway --bundle ... --service`. The website gains a `/install.sh` 302 beside the existing `/install`.

**Tech Stack:** bash (POSIX-leaning, `set -euo pipefail`), esbuild, GitHub Actions, launchd (LaunchAgent plists), systemd user units, nginx (website repo).

**Spec:** This document's header + Global Constraints are the spec (designed by the orchestrator; there is no separate spec file). The existing behavior contract is `docs/agent-install.md` + `scripts/agent-install.sh` — read both before touching either.

## Global Constraints

- Repo: `<repository-root>` (branch off `main`; one PR per task group as stated in each task; never push to `main` directly; merge with `gh pr merge <N> -R shiftedx/cozygateway --squash`).
- Website repository: `<website-repository-root>` (Task 8 only).
- Node floor is **24** everywhere (engines field, installer checks). The dev machine's default `node` is v22 — use a Node 24 (`brew` or nvm) for any step that must RUN gateway code; document which node you used.
- `scripts/agent-install.sh` is battle-tested. Extend it; do not restructure working phases. Every existing flag and the Docker path must behave byte-for-byte identically when the new flags are absent.
- All shell code must pass `shellcheck` with no new errors (warnings existing on main are acceptable; do not add new ones). If shellcheck is not installed: `brew install shellcheck`.
- Secrets discipline (already established in the script): passwords never in argv, generated files mode 600, `$` doubled in `.env`.
- Install layouts: simple track uses `~/.cozygateway` (no repo checkout inside); repo track keeps `~/cozygateway`.
- Service labels: `ai.cozylabs.cozygateway` and `ai.cozylabs.hermes-dashboard` (launchd); unit names `cozygateway.service` and `cozygateway-hermes-dashboard.service` (systemd user).
- No em-dashes in any user-facing copy (Kyle brand rule).
- Commit messages: conventional (`feat(install): ...`), each ends with the Claude Code trailer block used in this repo's history.

---

### Task 1: esbuild bundle script (`scripts/build-bundle.mjs`)

**Files:**
- Create: `scripts/build-bundle.mjs`
- Modify: `package.json` (root: add `esbuild` devDependency, add `bundle` script)
- Branch: `feat/bundle-build` (PR A, combined with Task 6)

**Interfaces:**
- Consumes: `packages/gateway/dist/cli.js` (product of `pnpm build`).
- Produces: `dist-bundle/cozygateway.mjs` (self-contained ESM, runnable as `node cozygateway.mjs <serve|pair> --config <path>`) and `dist-bundle/cozygateway.mjs.sha256` (format: `<hex>  cozygateway.mjs`, shasum-compatible). Task 5's installer and Task 6's workflow rely on exactly these two filenames.

- [ ] **Step 1: Add esbuild and the script wiring**

Root `package.json`: add `"esbuild": "^0.25.0"` to devDependencies and `"bundle": "node scripts/build-bundle.mjs"` to scripts. Run `pnpm install`.

- [ ] **Step 2: Write `scripts/build-bundle.mjs`**

```js
#!/usr/bin/env node
// Build the single-file gateway bundle the simple-install track ships.
// Input: packages/gateway/dist/cli.js (run `pnpm build` first).
// Output: dist-bundle/cozygateway.mjs + .sha256 (the exact names
// scripts/install.sh downloads from a GitHub Release).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const entry = "packages/gateway/dist/cli.js";
if (!existsSync(entry)) {
  console.error(`build-bundle: ${entry} not found; run 'pnpm build' first`);
  process.exit(1);
}
mkdirSync("dist-bundle", { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "dist-bundle/cozygateway.mjs",
  // ws optionally requires these native accelerators; without them it
  // falls back to pure JS, which is fine for a single-user gateway.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    // CJS deps inside an ESM bundle still call require/__dirname.
    js: "import { createRequire as __cgwCreateRequire } from 'node:module';\nconst require = __cgwCreateRequire(import.meta.url);",
  },
});
const body = readFileSync("dist-bundle/cozygateway.mjs");
const sha = createHash("sha256").update(body).digest("hex");
writeFileSync("dist-bundle/cozygateway.mjs.sha256", `${sha}  cozygateway.mjs\n`);
console.log(`bundled ${(body.length / 1024 / 1024).toFixed(1)}MB, sha256 ${sha}`);
```

- [ ] **Step 3: Build and smoke-test the bundle with Node 24**

```sh
cd ~/Documents/repos/cozygateway && pnpm build && pnpm bundle
```

Then, with a Node ≥24 binary (call it `$NODE24`), write a throwaway mock config and prove serve + pair work:

```sh
cat > /tmp/cgw-bundle-smoke.json <<'EOF'
{ "name": "bundle-smoke", "port": 18787, "host": "127.0.0.1",
  "dbPath": "/tmp/cgw-bundle-smoke.db",
  "agents": [{ "id": "mock", "name": "Mock", "adapter": "mock" }] }
EOF
$NODE24 dist-bundle/cozygateway.mjs serve --config /tmp/cgw-bundle-smoke.json &
sleep 2 && curl -s http://127.0.0.1:18787/health
$NODE24 dist-bundle/cozygateway.mjs pair --config /tmp/cgw-bundle-smoke.json
kill %1; rm -f /tmp/cgw-bundle-smoke.*
```

Expected: `/health` returns 200 JSON with `"contract":"v1"`; `pair` prints a setupCode JSON line. If the mock agent config shape above is wrong, read `packages/gateway/src/config.ts` and `src/adapters/mock.ts` and use the real shape — do not skip the smoke test.

- [ ] **Step 4: Ensure `dist-bundle/` is git-ignored** (add to root `.gitignore` if not covered).

- [ ] **Step 5: Commit** (`feat(build): esbuild single-file gateway bundle for the service install track`).

---

### Task 2: `agent-install.sh --bundle <path>` runtime

**Files:**
- Modify: `scripts/agent-install.sh`
- Branch: `feat/service-install` (PR B, shared by Tasks 2-5 and 7)

**Interfaces:**
- Consumes: a prebuilt `cozygateway.mjs` at the given path; `COZYGATEWAY_NODE` env var optionally naming the node binary (default `node`).
- Produces: `RUNTIME=bundle` mode where every place the script runs gateway code (`mint_pair_raw`, phase 7 start, config `dbPath`/ws host decisions) uses `"$COZY_NODE" "$BUNDLE_PATH"` instead of docker/`node packages/gateway/dist/cli.js`; `install-env.sh` gains `COZY_BUNDLE_PATH` and `COZY_NODE`. Task 3/4's service units exec exactly `"$COZY_NODE" "$BUNDLE_PATH" serve --config "$CONFIG_JSON"`.

- [ ] **Step 1: Add the flag and preflight.** New vars `BUNDLE_PATH=""`, `COZY_NODE="${COZYGATEWAY_NODE:-node}"`. Flag `--bundle PATH` (need_value). When set: force `RUNTIME=bundle`; error if `--runtime` was also passed with a different value. Preflight for bundle mode replaces the docker/node checks: require `$BUNDLE_PATH` exists and `"$COZY_NODE"` is ≥24 (same major check as the node path, run against `$COZY_NODE` not `node`); pnpm NOT required. `HERMES_WS_HOST=127.0.0.1`, dashboard bind logic treats `bundle` exactly like `node` (loopback default).

- [ ] **Step 2: Skip the clone.** In phase 2, when `RUNTIME=bundle`: do not clone; just `mkdir -p "$GATEWAY_DIR" "$LOCAL_DIR"`, write the self-ignoring `.gitignore` only if `$GATEWAY_DIR` is a git checkout (it normally is not on this path). The `--pair-only` and phase-7 paths use:

```sh
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
```

- [ ] **Step 3: Config + env.** Phase 6: `DB_PATH="$LOCAL_DIR/cozygateway.db"` for bundle mode (same as node). Phase 7 start for bundle mode (non-service; service comes in Task 3):

```sh
elif [ "$RUNTIME" = "bundle" ]; then
  ( COZYGATEWAY_HERMES_PASSWORD="$BRIDGE_PASSWORD" nohup "$COZY_NODE" \
      "$BUNDLE_PATH" serve --config "$CONFIG_JSON" >"$GW_LOG" 2>&1 & )
  ok "started the gateway from the bundle (log: $GW_LOG)"
```

`write_install_env` additionally records `COZY_BUNDLE_PATH` and `COZY_NODE` (always; empty is fine).

- [ ] **Step 4: Verify no regression + dry-run.** `bash -n scripts/agent-install.sh && shellcheck scripts/agent-install.sh` (no new findings vs `git stash`-ed main run). Then `bash scripts/agent-install.sh --dry-run` output must be unchanged from main's for the default invocation (diff the two outputs; timestamps aside). Then `bash scripts/agent-install.sh --dry-run --bundle /tmp/x.mjs --skip-dashboard --password p --gateway-dir /tmp/cgw-test` narrates a bundle plan with no clone and no pnpm.

- [ ] **Step 5: Commit** (`feat(install): --bundle runtime, prebuilt single-file gateway, no clone or pnpm`).

---

### Task 3: `agent-install.sh --service` on macOS (launchd) + `--uninstall-service`

**Files:**
- Modify: `scripts/agent-install.sh`
- Branch: `feat/service-install` (PR B)

**Interfaces:**
- Consumes: Task 2's `RUNTIME`/`BUNDLE_PATH`/`COZY_NODE`; existing `BRIDGE_PASSWORD`, `CONFIG_JSON`, `DASHBOARD_*`, `GW_LOG`, `DASH_LOG`, `SKIP_DASHBOARD`.
- Produces: flag `--service` (valid with runtime bundle or node; **error with docker**: "docker already supervises the gateway; --service is for the no-docker path"); flag `--uninstall-service`; files `$LOCAL_DIR/run-gateway.sh` and `$LOCAL_DIR/run-dashboard.sh` (mode 700); `~/Library/LaunchAgents/ai.cozylabs.cozygateway.plist` (+ `ai.cozylabs.hermes-dashboard.plist` unless `--skip-dashboard`). Task 5 passes `--service` from install.sh.

- [ ] **Step 1: Wrapper scripts.** Launchd plists cannot source env files, so each unit execs a wrapper. Written in the service phase (before starting), mode 700, umask 077:

`$LOCAL_DIR/run-gateway.sh`:
```sh
#!/usr/bin/env bash
# Generated by agent-install.sh --service. Reads the dashboard password at
# exec time so it never sits in the plist (which is world-readable).
set -euo pipefail
. "__INSTALL_ENV__"
COZYGATEWAY_HERMES_PASSWORD="$(sed -n 's/^password=//p' "$COZY_CRED_FILE" | head -1)"
export COZYGATEWAY_HERMES_PASSWORD
if [ "$COZY_RUNTIME" = "bundle" ]; then
  exec "$COZY_NODE" "$COZY_BUNDLE_PATH" serve --config "$COZY_CONFIG_JSON"
else
  cd "$COZY_GATEWAY_DIR" && exec node packages/gateway/dist/cli.js serve --config "$COZY_CONFIG_JSON"
fi
```
(`__INSTALL_ENV__` substituted with the real `$INSTALL_ENV` path at write time. With `--skip-dashboard` the cred file may not exist: guard with `[ -f "$COZY_CRED_FILE" ]` and fall back to `COZYGATEWAY_HERMES_PASSWORD="${COZYGATEWAY_HERMES_PASSWORD:-}"`.)

`$LOCAL_DIR/run-dashboard.sh` (only when `SKIP_DASHBOARD=0`):
```sh
#!/usr/bin/env bash
set -euo pipefail
. "__INSTALL_ENV__"
export HERMES_HOME="$COZY_HERMES_HOME"
exec "__HERMES_BIN__" dashboard --host "$COZY_DASHBOARD_HOST" --port "$COZY_DASHBOARD_PORT" --no-open --skip-build
```
(`__HERMES_BIN__` = `command -v hermes` resolved at install time; launchd PATH is minimal.)

- [ ] **Step 2: Plist writer + loader.** One function, called per (label, wrapper, log):

```sh
write_launchd_plist() { # $1 label  $2 wrapper  $3 log
  local plist="$HOME/Library/LaunchAgents/$1.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$2</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$3</string>
  <key>StandardErrorPath</key><string>$3</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load -w "$plist"
}
```

- [ ] **Step 3: Wire into the flow.** New `SERVICE=0` / `--service` flag; `UNINSTALL_SERVICE=0` / `--uninstall-service` flag (handled right after arg parsing: bootout + rm both plists (or systemd equivalents on Linux, Task 4), print what was removed, exit 0; it must not require hermes or docker present). In phase 5 (dashboard): when `SERVICE=1` and not skip-dashboard, do NOT nohup; instead stop any running dashboard exactly as today (`hermes dashboard --stop` when the credential check fails), write wrapper + plist, then poll `dashboard_answering`/`dashboard_credential_works` with the same timeouts. In phase 7: when `SERVICE=1`, write gateway wrapper + plist instead of nohup; the existing 90s `/health` poll and the roster/pair checks run unchanged. Dispatch on `uname -s`: `Darwin` → launchd (this task), `Linux` → systemd (Task 4), else die with a clear message.

- [ ] **Step 4: Verify.** `bash -n` + shellcheck clean. `--dry-run --service` narrates plist writes. Real launchd round-trip using a bundle-mode throwaway (no hermes needed):

```sh
bash scripts/agent-install.sh --bundle <abs path to dist-bundle/cozygateway.mjs> \
  --gateway-dir /tmp/cgw-svc-test --skip-dashboard --password dummy \
  --gateway-port 18788 --service
launchctl print "gui/$(id -u)/ai.cozylabs.cozygateway" | head -5
curl -s http://127.0.0.1:18788/health
kill <gateway pid printed by launchctl>   # prove KeepAlive restarts it
sleep 12 && curl -s http://127.0.0.1:18788/health
bash scripts/agent-install.sh --uninstall-service --gateway-dir /tmp/cgw-svc-test
```
Expected: health 200 before and after the kill; uninstall leaves no plist and no listener. Set `COZYGATEWAY_NODE` to the Node 24 binary. Note: with `--skip-dashboard` the bridge will log connect failures; the gateway must stay up regardless (it retries; if it instead crash-loops, that is a real finding to report, not to paper over).

- [ ] **Step 5: Commit** (`feat(install): --service, launchd LaunchAgents supervise the gateway and dashboard on macOS`).

---

### Task 4: `--service` on Linux (systemd user units)

**Files:**
- Modify: `scripts/agent-install.sh`
- Branch: `feat/service-install` (PR B)

**Interfaces:**
- Consumes: Task 3's `SERVICE` flag, wrapper scripts (identical on Linux).
- Produces: `~/.config/systemd/user/cozygateway.service` and (unless skip-dashboard) `cozygateway-hermes-dashboard.service`; `--uninstall-service` removes them.

- [ ] **Step 1: Unit writer.**

```sh
write_systemd_unit() { # $1 unit-name  $2 wrapper  $3 description
  local dir="$HOME/.config/systemd/user"
  mkdir -p "$dir"
  cat > "$dir/$1" <<UNIT
[Unit]
Description=$3

[Service]
ExecStart=/bin/bash $2
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$1"
}
```

After enabling, attempt `loginctl enable-linger "$USER" 2>/dev/null || warn "could not enable lingering; the service stops at logout. Run: sudo loginctl enable-linger $USER"`. If `systemctl --user` itself fails (no user bus, e.g. some SSH setups), die with that exact diagnosis and the linger command.

- [ ] **Step 2: Wire the Darwin/Linux dispatch** from Task 3 step 3 to call this on Linux, and extend `--uninstall-service` (`systemctl --user disable --now` both units, `rm -f`, `daemon-reload`).

- [ ] **Step 3: Verify on real Linux via container.** launchd cannot test this; docker can:

```sh
docker run --rm -v "$PWD":/repo -w /repo ubuntu:24.04 bash -c \
  'apt-get update -qq && apt-get install -y -qq shellcheck >/dev/null && shellcheck scripts/agent-install.sh && bash -n scripts/agent-install.sh && bash scripts/agent-install.sh --dry-run --service --bundle /tmp/x.mjs --skip-dashboard --password p 2>&1 | tail -20'
```
Expected: dry-run narrates systemd unit writes (systemctl itself will not run under dry-run so a bus-less container is fine). A full live systemd test needs a systemd container; if `docker run --rm --tmpfs /run --tmpfs /tmp -v /sys/fs/cgroup:/sys/fs/cgroup:rw --cgroupns=host jrei/systemd-ubuntu:24.04` (or `almalinux/9-init`) works within ~10 minutes of effort, run the Task 3 step-4 round-trip inside it with a Node 24 install; otherwise record in the task report that Linux was validated dry-run + syntax only and file a follow-up issue on shiftedx/cozygateway titled "live-validate systemd --service path on Linux".

- [ ] **Step 4: Commit** (`feat(install): --service systemd user units on Linux`).

---

### Task 5: `scripts/install.sh` — the one-liner bootstrap

**Files:**
- Create: `scripts/install.sh`
- Branch: `feat/service-install` (PR B)

**Interfaces:**
- Consumes: GitHub Release assets `cozygateway.mjs` + `cozygateway.mjs.sha256` (Task 1 names, Task 6 publishes); `scripts/agent-install.sh` with Task 2/3/4 flags.
- Produces: the flow `curl -fsSL https://cozylabs.ai/install.sh | bash`. Env overrides for testing: `COZYGATEWAY_INSTALL_REPO` (default `shiftedx/cozygateway`), `COZYGATEWAY_INSTALL_TAG` (default: latest release), `COZYGATEWAY_INSTALL_ASSET_BASE` (full URL base overriding the release lookup, may be `file:///...` — curl handles file URLs), `COZYGATEWAY_HOME` (default `$HOME/.cozygateway`). All extra argv is passed through to agent-install.sh (`bash install.sh --hidden-profiles default,ops` works, and so does `curl ... | bash -s -- --hidden-profiles ...`).

- [ ] **Step 1: Write it.**

```sh
#!/usr/bin/env bash
#
# install.sh: the simple-track cozygateway installer.
#
#   curl -fsSL https://cozylabs.ai/install.sh | bash
#
# No Docker, no git, no build tools. It downloads the latest released
# single-file gateway bundle, verifies its sha256, and hands off to
# agent-install.sh (same tag) with --bundle --service, so the gateway and
# the hermes dashboard run as login services that survive reboots.
# Homelab users who want the container instead: https://cozylabs.ai/install
# (the Docker/agent playbook). Everything lands in ~/.cozygateway.
set -euo pipefail

REPO="${COZYGATEWAY_INSTALL_REPO:-shiftedx/cozygateway}"
CGW_HOME="${COZYGATEWAY_HOME:-$HOME/.cozygateway}"
say()  { printf '%s\n' "$*"; }
die()  { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

# --- Node >= 24 ------------------------------------------------------------
NODE_BIN="${COZYGATEWAY_NODE:-}"
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"; fi
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ -z "$NODE_BIN" ] || [ "$(node_major "$NODE_BIN")" -lt 24 ]; then
  # A newer node may be installed but not first on PATH (Homebrew keg, nvm).
  for cand in /opt/homebrew/opt/node/bin/node /usr/local/opt/node/bin/node \
              "$HOME"/.nvm/versions/node/v2[4-9]*/bin/node; do
    [ -x "$cand" ] && [ "$(node_major "$cand")" -ge 24 ] && { NODE_BIN="$cand"; break; }
  done
fi
if [ -z "$NODE_BIN" ] || [ "$(node_major "$NODE_BIN")" -lt 24 ]; then
  case "$(uname -s)" in
    Darwin) HINT="brew install node   (from https://brew.sh)" ;;
    *)      HINT="https://nodejs.org/en/download - or your distro's nodejs 24 package" ;;
  esac
  die "cozygateway needs Node.js 24 or newer. Install it, then re-run this line.
      $HINT"
fi
say "Using node: $NODE_BIN ($("$NODE_BIN" -v))"

# --- Resolve the release ---------------------------------------------------
TAG="${COZYGATEWAY_INSTALL_TAG:-}"
if [ -z "$TAG" ] && [ -z "${COZYGATEWAY_INSTALL_ASSET_BASE:-}" ]; then
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/^  "tag_name": "\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$TAG" ] || die "could not resolve the latest release of $REPO (offline? rate-limited?). Set COZYGATEWAY_INSTALL_TAG=vX.Y.Z and re-run."
fi
ASSET_BASE="${COZYGATEWAY_INSTALL_ASSET_BASE:-https://github.com/$REPO/releases/download/$TAG}"
RAW_BASE="https://raw.githubusercontent.com/$REPO/${TAG:-main}"

# --- Download + verify -----------------------------------------------------
mkdir -p "$CGW_HOME/bin"
say "Downloading cozygateway ${TAG:-} ..."
curl -fsSL "$ASSET_BASE/cozygateway.mjs" -o "$CGW_HOME/bin/cozygateway.mjs.new"
curl -fsSL "$ASSET_BASE/cozygateway.mjs.sha256" -o "$CGW_HOME/bin/cozygateway.mjs.sha256"
EXPECT="$(awk '{print $1}' "$CGW_HOME/bin/cozygateway.mjs.sha256")"
GOT="$(shasum -a 256 "$CGW_HOME/bin/cozygateway.mjs.new" 2>/dev/null | awk '{print $1}')"
[ -z "$GOT" ] && GOT="$(sha256sum "$CGW_HOME/bin/cozygateway.mjs.new" | awk '{print $1}')"
[ "$EXPECT" = "$GOT" ] || die "bundle sha256 mismatch (expected $EXPECT, got $GOT); refusing to run it"
mv "$CGW_HOME/bin/cozygateway.mjs.new" "$CGW_HOME/bin/cozygateway.mjs"
say "Verified sha256: $GOT"

curl -fsSL "$RAW_BASE/scripts/agent-install.sh" -o "$CGW_HOME/bin/agent-install.sh"

# --- Hand off --------------------------------------------------------------
exec env COZYGATEWAY_NODE="$NODE_BIN" bash "$CGW_HOME/bin/agent-install.sh" \
  --gateway-dir "$CGW_HOME" \
  --bundle "$CGW_HOME/bin/cozygateway.mjs" \
  --service \
  "$@"
```

- [ ] **Step 2: Verify locally without the network path.** shellcheck + `bash -n`. Then end-to-end against local files:

```sh
mkdir -p /tmp/cgw-assets && cp dist-bundle/cozygateway.mjs* /tmp/cgw-assets/
COZYGATEWAY_INSTALL_ASSET_BASE="file:///tmp/cgw-assets" \
COZYGATEWAY_HOME=/tmp/cgw-home COZYGATEWAY_NODE=<node24> \
  bash scripts/install.sh --skip-dashboard --password dummy --gateway-port 18789
curl -s http://127.0.0.1:18789/health
bash scripts/agent-install.sh --uninstall-service --gateway-dir /tmp/cgw-home
```
Note: `RAW_BASE` still fetches agent-install.sh from GitHub main in this test, which is fine (or temporarily copy the local one over `$CGW_HOME/bin/agent-install.sh` and re-exec if main lacks the new flags yet: `COZYGATEWAY_INSTALL_ASSET_BASE` testing before PR B merges MUST use the local copy - in that case run agent-install.sh directly as in Task 3 step 4 and treat install.sh's own test as: it downloads, verifies sha, and *would* exec; assert by replacing the final `exec env ...` with `echo` via `COZYGATEWAY_INSTALL_DRYRUN=1` support — add that env: when set, print the exec line instead of running it).

Also test the failure modes: corrupt the local sha256 file → installer refuses; point at a bogus repo with no releases → clear FAIL message.

- [ ] **Step 3: Commit** (`feat(install): one-liner bootstrap installer for the no-docker service track`).

---

### Task 6: Release workflow + cut v0.1.0

**Files:**
- Create: `.github/workflows/release.yml`
- Branch: `feat/bundle-build` (PR A, with Task 1)

**Interfaces:**
- Consumes: `pnpm bundle` (Task 1).
- Produces: on tag push `v*`, a GitHub Release carrying `cozygateway.mjs` + `cozygateway.mjs.sha256`. Task 5 downloads these.

- [ ] **Step 1: Write the workflow.**

```yaml
name: release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - run: pnpm bundle
      - name: smoke the bundle
        run: |
          cat > /tmp/smoke.json <<'EOF'
          { "name": "smoke", "port": 18787, "host": "127.0.0.1",
            "dbPath": "/tmp/smoke.db",
            "agents": [{ "id": "mock", "name": "Mock", "adapter": "mock" }] }
          EOF
          node dist-bundle/cozygateway.mjs serve --config /tmp/smoke.json &
          sleep 2
          curl -fsS http://127.0.0.1:18787/health | grep -q '"contract":"v1"'
          kill %1
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            dist-bundle/cozygateway.mjs
            dist-bundle/cozygateway.mjs.sha256
          generate_release_notes: true
```
(Use the same mock-config shape Task 1 proved correct. Note memory: repo CI may be billing-limited; if Actions cannot run, fall back to a manual release: `pnpm build && pnpm bundle && gh release create v0.1.0 dist-bundle/cozygateway.mjs dist-bundle/cozygateway.mjs.sha256 -R shiftedx/cozygateway --title v0.1.0 --generate-notes` — and say so in the task report.)

- [ ] **Step 2: Commit, PR A, merge.** After PR A AND PR B are both merged to main: `git tag v0.1.0 && git push origin v0.1.0` (tag push is allowed; only branch main is protected by policy). Verify the release exists with both assets (`gh release view v0.1.0 -R shiftedx/cozygateway`), workflow-built or manually created per the fallback.

---

### Task 7: Docs — two-track story

**Files:**
- Modify: `README.md` (Install section), `docs/agent-install.md` (Step 0/1: mention the simple track and the new flags; Step 8/appendix: `--service` notes)
- Create: `docs/install-service.md`
- Branch: `feat/service-install` (PR B)

- [ ] **Step 1: README.** Replace the single "Install with your agent" section with two clearly-labeled tracks:
  - **Simple (recommended): one line, runs as a service.** `curl -fsSL https://cozylabs.ai/install.sh | bash` — needs Node 24+, installs to `~/.cozygateway`, registers login services (launchd/systemd) for the gateway and the hermes dashboard, survives reboots, prints a pairing code. Uninstall: `bash ~/.cozygateway/bin/agent-install.sh --uninstall-service --gateway-dir ~/.cozygateway`.
  - **Homelab (Docker) / agent-driven:** the existing paragraph, unchanged content, plus a line that the same playbook now accepts `--service` on the node path.

- [ ] **Step 2: `docs/install-service.md`.** A short HUMAN-readable page (the playbook stays agent-facing): what the one-liner does step by step, where files live (`~/.cozygateway`, LaunchAgents/systemd paths, log paths), how to check status (`launchctl print gui/$UID/ai.cozylabs.cozygateway` / `systemctl --user status cozygateway`), restart, view logs, update (re-run the one-liner; it is idempotent and reuses the recorded password), uninstall, and the security posture (loopback dashboard, password file modes, sha256-verified bundle). Under 120 lines. No em-dashes.

- [ ] **Step 3: `docs/agent-install.md`.** Surgical edits only: Step 0 gains the runtime question "Docker, Node checkout, or prebuilt bundle?" and a pointer that non-technical humans should be given the one-liner instead of this playbook; the flags table gains `--bundle`, `--service`, `--uninstall-service`; Troubleshooting gains three rows (service not running after reboot on Linux → linger; launchd job crashed → `launchctl print` + ThrottleInterval; bundle sha mismatch → re-download / release asset tampered).

- [ ] **Step 4: Commit** (`docs: two-track install story, service-install human guide`).

---

### Task 8: Website — `/install.sh` short URL + copy

**Files (CozyLabs-Website repo):**
- Modify: `nginx.conf`, `src/pages/gateway.astro`, `test/links.test.ts`
- Branch: `feat/install-sh-shorturl` in `~/Documents/repos/CozyLabs-Website`; separate PR there; after merge, deploy to .106 per that repo's deploy runbook (read its README/docs for the exact command; memory says .106 serves the public website).

- [ ] **Step 1: nginx.** Beside the existing `/install` blocks:

```nginx
    # Short URL for the simple-track service installer. Piped to bash, so it
    # must 302 to the raw script on main, exactly like /install does.
    location = /install.sh {
        return 302 https://raw.githubusercontent.com/shiftedx/cozygateway/main/scripts/install.sh;
    }
```

- [ ] **Step 2: gateway.astro.** Present both tracks: the one-liner (`curl -fsSL https://cozylabs.ai/install.sh | bash`) labeled for "just want it running" users with the Node 24 requirement, and the existing agent/Docker install labeled for homelab/self-hosters. Match the page's existing tone and styles; no em-dashes.

- [ ] **Step 3: tests + deploy.** Extend `test/links.test.ts` to cover `/install.sh` the same way `/install` is covered. Run the repo's test suite. PR, merge, deploy to .106, then verify live: `curl -fsSL -o /dev/null -w '%{http_code} %{redirect_url}\n' https://cozylabs.ai/install.sh` → `302 https://raw.githubusercontent.com/.../scripts/install.sh` (and once PR B is on cozygateway main, `curl -fsSL https://cozylabs.ai/install.sh | head -5` shows the script).

---

### Task 9: Live end-to-end validation (orchestrator-led, after all merges + release)

**Files:** none (validation only; fixes loop back as new commits on a branch).

- [ ] **Step 1:** On this Mac, run the real line: `curl -fsSL https://cozylabs.ai/install.sh | bash -s -- <flags>`. If the local machine has a working `hermes` (check `hermes --version`), run it for real with no skip flags and validate the full bridge (Steps 4-7 of the playbook: credential login 200, `/health` has `com.cozylabs.bots`, paired `/bots` 200, revoke). If no local hermes, run with `--skip-dashboard --password dummy` and validate service mechanics only (health, KeepAlive restart after kill, `launchctl print` shows both state, uninstall clean) and say exactly that in the final report.
- [ ] **Step 2:** Reboot-equivalence: `launchctl bootout gui/$(id -u)/ai.cozylabs.cozygateway && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.cozylabs.cozygateway.plist` → health 200 again.
- [ ] **Step 3:** Re-run the one-liner (idempotency: no new config.yaml backup when nothing changed, same password reused, service still healthy).
- [ ] **Step 4:** Docker regression: `bash scripts/docker-smoke.sh` (or the repo's documented docker smoke) still passes on main.
- [ ] **Step 5:** Clean up throwaway installs (`--uninstall-service`, rm /tmp/cgw-*), leave the real one only if hermes was real and Kyle would want it (do not leave a dummy-password install running: uninstall it).

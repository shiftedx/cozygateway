#!/usr/bin/env bash
# Regression coverage for plugin rollout.  The helpers below deliberately use
# fake launchd/SSH endpoints: this test proves the local decision making and
# never touches a real Hermes profile or gateway.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cozy-plugin-rollout-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_contains() { grep -Fq -- "$2" "$1" || fail "expected $1 to contain: $2"; }

make_fake_bin() {
  local bin="$1"
  mkdir -p "$bin"
  cat > "$bin/launchctl" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$COZY_TEST_LAUNCHCTL_LOG"
case "$1" in
  print|list) exit 0 ;;
  *) exit 0 ;;
esac
SH
  cat > "$bin/ssh" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$COZY_TEST_SSH_LOG"
# The rollout tests exercise an already provisioned profile, so the remote
# token check must succeed.  All other remote mutations are harmless no-ops.
case "$*" in
  *"python3 - "*) printf 'already present\n' ;;
esac
exit 0
SH
  chmod +x "$bin/launchctl" "$bin/ssh"
}

copy_stale_plugin() {
  local dest="$1"
  mkdir -p "$(dirname "$dest")"
  cp -R "$ROOT/integrations/attach-plugin" "$dest"
  printf '\n# deliberately stale test copy\n' >> "$dest/plugin.yaml"
}

make_profile() {
  local hermes="$1" name="$2"
  mkdir -p "$hermes/profiles/$name/plugin-data/cozygateway"
  cat > "$hermes/profiles/$name/config.yaml" <<'YAML'
plugins:
  enabled:
    - cozygateway
YAML
  cat > "$hermes/profiles/$name/.env" <<EOF
COZYGATEWAY_TOKEN=test-token
COZYGATEWAY_SPOOL_PATH=$hermes/profiles/$name/plugin-data/cozygateway/attach-v1.sqlite
EOF
}

# The host runner has no PyYAML. Hermes supplies it through its venv in
# production; this small stand-in only answers the two structural queries the
# scripts issue and makes the shell test independent of host packages.
make_fake_python() {
  local hermes="$1" profiles="$2"
  mkdir -p "$hermes/hermes-agent/venv/bin"
  cat > "$hermes/hermes-agent/venv/bin/python" <<SH
#!/bin/sh
if [ "\$1" = "-" ] && [ "\$2" = "$hermes" ]; then
  printf '%s\\n' '$profiles'
fi
if [ "\$1" = "-c" ]; then
  printf '%s\\n' "\${COZY_TEST_READY_COUNTS:--1 -1}"
fi
exit 0
SH
  chmod +x "$hermes/hermes-agent/venv/bin/python"
}

test_watcher_repairs_content_drift() {
  local hermes="$TMP/watcher-hermes" bin="$TMP/watcher-bin" log="$TMP/watcher.log" calls="$TMP/watcher-calls"
  make_fake_bin "$bin"
  make_profile "$hermes" drift
  make_fake_python "$hermes" ''
  copy_stale_plugin "$hermes/profiles/drift/plugins/cozygateway"
  cat > "$bin/provision" <<'SH'
#!/bin/sh
printf '%s\n' "$*" > "$COZY_TEST_PROVISION_CALLS"
SH
  chmod +x "$bin/provision"
  mkdir -p "$TMP/watcher-runtime"
  date +%s > "$TMP/watcher-runtime/cozylabs-bot-provisioner.reconcile"

  HOME="$TMP/watcher-home" TMPDIR="$TMP/watcher-runtime" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/watcher-launchctl" COZY_TEST_SSH_LOG="$TMP/watcher-ssh" \
    COZY_TEST_PROVISION_CALLS="$calls" COZY_PROVISION_COMMAND="$bin/provision" \
    COZY_PROVISIONER_LOCK="$TMP/watcher.lock" COZY_PROVISIONER_RECONCILE_SECONDS=999999 \
    "$ROOT/scripts/bot-provisioner-watch.sh" --dry-run --hermes-home "$hermes" --log "$log"

  assert_contains "$log" 'pending: drift (plugin content differs from staged source)'
  assert_contains "$calls" '--dry-run drift'
}

test_provisioner_restarts_loaded_service_after_sync() {
  local hermes="$TMP/provision-hermes" bin="$TMP/provision-bin" launch_log="$TMP/provision-launchctl"
  make_fake_bin "$bin"
  make_profile "$hermes" already-wired
  make_fake_python "$hermes" ''
  copy_stale_plugin "$hermes/profiles/already-wired/plugins/cozygateway"

  HOME="$TMP/provision-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_LAUNCHCTL_LOG="$launch_log" COZY_TEST_SSH_LOG="$TMP/provision-ssh" \
    "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake already-wired >/dev/null

  assert_contains "$launch_log" 'kickstart -k gui/'
  cmp "$ROOT/integrations/attach-plugin/plugin.yaml" "$hermes/profiles/already-wired/plugins/cozygateway/plugin.yaml" \
    || fail 'provisioner did not replace stale plugin content'
}

test_deploy_discovers_every_opted_in_profile() {
  local hermes="$TMP/deploy-hermes" bin="$TMP/deploy-bin" output="$TMP/deploy.out"
  make_fake_bin "$bin"
  make_profile "$hermes" alpha
  make_profile "$hermes" beta
  make_fake_python "$hermes" $'alpha\nbeta'

  HOME="$TMP/deploy-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/deploy-launchctl" COZY_TEST_SSH_LOG="$TMP/deploy-ssh" \
    "$ROOT/scripts/deploy-plugin-local.sh" --dry-run --hermes-home "$hermes" > "$output"

  assert_contains "$output" '=== alpha ==='
  assert_contains "$output" '=== beta ==='
  assert_contains "$output" 'configured >= 2'
}

test_deploy_rejects_partial_configured_fleet() {
  local hermes="$TMP/partial-hermes" bin="$TMP/partial-bin" output="$TMP/partial.out"
  make_fake_bin "$bin"
  make_profile "$hermes" alpha
  make_profile "$hermes" beta
  make_fake_python "$hermes" $'alpha\nbeta'
  cat > "$bin/curl" <<'SH'
#!/bin/sh
printf '%s\n' '{"attach":{"configured":8,"online":6}}'
SH
  chmod +x "$bin/curl"

  if HOME="$TMP/partial-home" PATH="$bin:/usr/bin:/bin" COZY_TEST_READY_COUNTS='8 6' \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/partial-launchctl" COZY_TEST_SSH_LOG="$TMP/partial-ssh" \
    "$ROOT/scripts/deploy-plugin-local.sh" --hermes-home "$hermes" --quiet-window 0 --max-wait 0 --ready-timeout 0 > "$output" 2>&1; then
    fail 'deploy accepted six online profiles when eight were configured'
  fi
  assert_contains "$output" 'did not report all configured profiles online'
}

test_watcher_repairs_content_drift
test_provisioner_restarts_loaded_service_after_sync
test_deploy_discovers_every_opted_in_profile
test_deploy_rejects_partial_configured_fleet
printf 'plugin rollout: ok\n'

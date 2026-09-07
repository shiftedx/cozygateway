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

# The scripts under test read a profile's config.yaml structurally, and PyYAML
# is NOT a requirement for that: with it they get the exact answer, without it
# they fall back to a conservative stdlib probe. A hosted runner (and plenty of
# user machines) has a python3 with no PyYAML, so these cases run the reader
# under `python3 -S`, which skips site-packages and therefore CANNOT import
# PyYAML on any host. That makes the no-PyYAML path the one this suite always
# exercises, rather than whatever the machine happens to have installed.
command -v python3 >/dev/null 2>&1 || fail 'python3 is required to run these tests'
if python3 -S -c 'import yaml' >/dev/null 2>&1; then
  fail 'python3 -S can still import yaml, so this suite cannot prove the no-PyYAML path'
fi
# Set only for the cases that also want the PyYAML answer, and empty when this
# host has no PyYAML at all: those cases then report that they could not run it.
YAML_PYTHON=""
for candidate in /usr/bin/python3 "$(command -v python3 || true)"; do
  [ -n "$candidate" ] || continue
  if "$candidate" -c 'import yaml' >/dev/null 2>&1; then YAML_PYTHON="$candidate"; break; fi
done

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
  # The provisioner delegates every config write to Hermes' own `config set`, so
  # the fake records the commands AND applies them: the caller must be able to
  # tell a writer that wrote from one that only said it did.
  #
  #   COZY_TEST_HERMES_NOOP_WRITER: exit 0 and write nothing, which is what real
  #     Hermes does on a package-managed install (`is_managed()`).
  #   COZY_TEST_HERMES_WRITER_FAILS: exit 1, a write that could not happen.
  cat > "$bin/hermes" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "${COZY_TEST_HERMES_LOG:-/dev/null}"
if [ "$1" = "-p" ] && [ "$3" = "config" ] && [ "$4" = "set" ]; then
  [ -n "${COZY_TEST_HERMES_WRITER_FAILS:-}" ] && exit 1
  [ -n "${COZY_TEST_HERMES_NOOP_WRITER:-}" ] && exit 0
  # The caller is expected to pass the value the reader named for each key, so a
  # bare "true" over a cadence knob is a bug this fake refuses rather than hides.
  case "$5=$6" in
    display.streaming=true|display.platforms.cozygateway.streaming=true) ;;
    streaming.edit_interval=0.05|streaming.buffer_threshold=1) ;;
    *) exit 2 ;;
  esac
  dir="$COZY_TEST_HERMES_HOME/profiles/$2"
  : > "$dir/.wrote-$5"
  # Rewrite ONLY the block this key lives in, from the keys written so far, and
  # leave the other one exactly as the fixture wrote it. Only these four keys are
  # ever set here, so a real YAML writer (and a YAML library) is not needed to
  # prove the caller reads the file back.
  case "$5" in
    display.*)
      awk '/^display:/ { skip = 1; next } skip && ($0 ~ /^[ \t]/ || $0 == "") { next } { skip = 0; print }' \
        "$dir/config.yaml" > "$dir/config.yaml.tmp"
      printf 'display:\n' >> "$dir/config.yaml.tmp"
      [ -f "$dir/.wrote-display.streaming" ] && printf '  streaming: true\n' >> "$dir/config.yaml.tmp"
      [ -f "$dir/.wrote-display.platforms.cozygateway.streaming" ] \
        && printf '  platforms:\n    cozygateway:\n      streaming: true\n' >> "$dir/config.yaml.tmp"
      ;;
    streaming.*)
      awk '/^streaming:/ { skip = 1; next } skip && ($0 ~ /^[ \t]/ || $0 == "") { next } { skip = 0; print }' \
        "$dir/config.yaml" > "$dir/config.yaml.tmp"
      printf 'streaming:\n' >> "$dir/config.yaml.tmp"
      [ -f "$dir/.wrote-streaming.edit_interval" ] && printf '  edit_interval: 0.05\n' >> "$dir/config.yaml.tmp"
      [ -f "$dir/.wrote-streaming.buffer_threshold" ] && printf '  buffer_threshold: 1\n' >> "$dir/config.yaml.tmp"
      ;;
  esac
  mv "$dir/config.yaml.tmp" "$dir/config.yaml"
fi
exit 0
SH
  chmod +x "$bin/launchctl" "$bin/ssh" "$bin/hermes"
}

# A profile created before the seed wrote the display keys: reachable, and mute.
make_mute_config() {
  cat > "$1/config.yaml" <<'YAML'
plugins:
  enabled:
    - cozygateway
YAML
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
display:
  streaming: true
  platforms:
    cozygateway:
      streaming: true
streaming:
  edit_interval: 0.05
  buffer_threshold: 1
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
# The streaming-key read is a REAL structural read. \`python3 -S\` skips
# site-packages, so PyYAML is guaranteed absent and the reader's stdlib probe is
# what answers, which is the shape a hosted runner has.
if [ "\$2" = "--streaming-keys" ]; then
  exec python3 -S "\$@"
fi
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
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/watcher-launchctl" COZY_TEST_SSH_LOG="$TMP/watcher-ssh" \
    COZY_TEST_PROVISION_CALLS="$calls" COZY_PROVISION_COMMAND="$bin/provision" \
    COZY_PROVISIONER_LOCK="$TMP/watcher.lock" COZY_PROVISIONER_RECONCILE_SECONDS=999999 \
    "$ROOT/scripts/bot-provisioner-watch.sh" --dry-run --hermes-home "$hermes" --log "$log"

  assert_contains "$log" 'pending: drift (plugin content differs from staged source)'
  assert_contains "$calls" '--dry-run drift'
}

test_watcher_ignores_checkout_pytest_cache() {
  local repo="$TMP/cache-repo" hermes="$TMP/cache-hermes" bin="$TMP/cache-bin" log="$TMP/cache.log" calls="$TMP/cache-calls"
  mkdir -p "$repo/scripts" "$repo/integrations/attach-plugin/.pytest_cache/v/cache"
  cp "$ROOT/scripts/bot-provisioner-watch.sh" "$repo/scripts/"
  printf 'name: cozygateway\n' > "$repo/integrations/attach-plugin/plugin.yaml"
  printf '[]\n' > "$repo/integrations/attach-plugin/.pytest_cache/v/cache/nodeids"
  make_fake_bin "$bin"
  make_profile "$hermes" current
  mkdir -p "$hermes/profiles/current/plugins/cozygateway"
  cp "$repo/integrations/attach-plugin/plugin.yaml" "$hermes/profiles/current/plugins/cozygateway/plugin.yaml"
  make_fake_python "$hermes" ''
  cat > "$bin/provision" <<'SH'
#!/bin/sh
printf '%s\n' "$*" > "$COZY_TEST_PROVISION_CALLS"
SH
  chmod +x "$bin/provision"
  mkdir -p "$TMP/cache-runtime"
  date +%s > "$TMP/cache-runtime/cozylabs-bot-provisioner.reconcile"

  HOME="$TMP/cache-home" TMPDIR="$TMP/cache-runtime" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/cache-launchctl" COZY_TEST_SSH_LOG="$TMP/cache-ssh" \
    COZY_TEST_PROVISION_CALLS="$calls" COZY_PROVISION_COMMAND="$bin/provision" \
    COZY_PROVISIONER_LOCK="$TMP/cache.lock" COZY_PROVISIONER_RECONCILE_SECONDS=999999 \
    "$repo/scripts/bot-provisioner-watch.sh" --dry-run --hermes-home "$hermes" --log "$log"

  [ ! -e "$calls" ] || fail 'watcher treated excluded .pytest_cache as plugin drift'
}

test_provisioner_ignores_checkout_pytest_cache() {
  local repo="$TMP/provision-cache-repo" hermes="$TMP/provision-cache-hermes" bin="$TMP/provision-cache-bin" launch_log="$TMP/provision-cache-launchctl"
  mkdir -p "$repo/scripts" "$repo/integrations/attach-plugin/.pytest_cache/v/cache"
  cp "$ROOT/scripts/provision-bot.sh" "$repo/scripts/"
  printf 'name: cozygateway\n' > "$repo/integrations/attach-plugin/plugin.yaml"
  printf '[]\n' > "$repo/integrations/attach-plugin/.pytest_cache/v/cache/nodeids"
  make_fake_bin "$bin"
  make_profile "$hermes" current
  mkdir -p "$hermes/profiles/current/plugins/cozygateway"
  cp "$repo/integrations/attach-plugin/plugin.yaml" "$hermes/profiles/current/plugins/cozygateway/plugin.yaml"
  make_fake_python "$hermes" ''

  HOME="$TMP/provision-cache-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$launch_log" COZY_TEST_SSH_LOG="$TMP/provision-cache-ssh" \
    "$repo/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake current >/dev/null

  if grep -Fq 'kickstart -k' "$launch_log"; then
    fail 'provisioner restarted an unchanged plugin because checkout .pytest_cache was present'
  fi
}

test_provisioner_restarts_loaded_service_after_sync() {
  local hermes="$TMP/provision-hermes" bin="$TMP/provision-bin" launch_log="$TMP/provision-launchctl"
  make_fake_bin "$bin"
  make_profile "$hermes" already-wired
  make_fake_python "$hermes" ''
  copy_stale_plugin "$hermes/profiles/already-wired/plugins/cozygateway"

  HOME="$TMP/provision-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$launch_log" COZY_TEST_SSH_LOG="$TMP/provision-ssh" \
    "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake already-wired >/dev/null

  assert_contains "$launch_log" 'kickstart -k gui/'
  cmp "$ROOT/integrations/attach-plugin/plugin.yaml" "$hermes/profiles/already-wired/plugins/cozygateway/plugin.yaml" \
    || fail 'provisioner did not replace stale plugin content'
}

test_provisioner_copies_existing_chat_registry_to_new_profile() {
  local hermes="$TMP/chat-registry-hermes" bin="$TMP/chat-registry-bin"
  make_fake_bin "$bin"
  make_profile "$hermes" established
  make_profile "$hermes" newly-created
  make_fake_python "$hermes" ''
  cat >> "$hermes/profiles/established/.env" <<'EOF'
HERMES_CHAT_COMPUTER_ID=hermes:test-mac
HERMES_CHAT_COMPUTER_NAME=Test Mac
HERMES_CHAT_PROJECTS_JSON=[{"computerId":"hermes:test-mac","projectId":"project","root":"/tmp/project","name":"Project"}]
EOF

  HOME="$TMP/chat-registry-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/chat-registry-launchctl" COZY_TEST_SSH_LOG="$TMP/chat-registry-ssh" \
    "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake newly-created >/dev/null

  assert_contains "$hermes/profiles/newly-created/.env" 'HERMES_CHAT_COMPUTER_ID=hermes:test-mac'
  assert_contains "$hermes/profiles/newly-created/.env" 'HERMES_CHAT_COMPUTER_NAME=Test Mac'
  assert_contains "$hermes/profiles/newly-created/.env" 'HERMES_CHAT_PROJECTS_JSON=[{"computerId":"hermes:test-mac","projectId":"project","root":"/tmp/project","name":"Project"}]'
}

test_provisioner_preserves_partial_chat_registry() {
  local hermes="$TMP/partial-chat-registry-hermes" bin="$TMP/partial-chat-registry-bin"
  make_fake_bin "$bin"
  make_profile "$hermes" established
  make_profile "$hermes" operator-owned
  make_fake_python "$hermes" ''
  cat >> "$hermes/profiles/established/.env" <<'EOF'
HERMES_CHAT_COMPUTER_ID=hermes:test-mac
HERMES_CHAT_COMPUTER_NAME=Test Mac
HERMES_CHAT_PROJECTS_JSON=[{"computerId":"hermes:test-mac","projectId":"project","root":"/tmp/project","name":"Project"}]
EOF
  printf 'HERMES_CHAT_COMPUTER_ID=operator-selected\n' >> "$hermes/profiles/operator-owned/.env"

  HOME="$TMP/partial-chat-registry-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/partial-chat-registry-launchctl" COZY_TEST_SSH_LOG="$TMP/partial-chat-registry-ssh" \
    "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake operator-owned >/dev/null

  assert_contains "$hermes/profiles/operator-owned/.env" 'HERMES_CHAT_COMPUTER_ID=operator-selected'
  if grep -q '^HERMES_CHAT_COMPUTER_NAME=' "$hermes/profiles/operator-owned/.env" \
    || grep -q '^HERMES_CHAT_PROJECTS_JSON=' "$hermes/profiles/operator-owned/.env"; then
    fail 'provisioner mixed an operator-owned partial registry with another profile registry'
  fi
}

test_deploy_discovers_every_opted_in_profile() {
  local hermes="$TMP/deploy-hermes" bin="$TMP/deploy-bin" output="$TMP/deploy.out"
  make_fake_bin "$bin"
  make_profile "$hermes" alpha
  make_profile "$hermes" beta
  make_fake_python "$hermes" $'alpha\nbeta'

  HOME="$TMP/deploy-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
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
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/partial-launchctl" COZY_TEST_SSH_LOG="$TMP/partial-ssh" \
    "$ROOT/scripts/deploy-plugin-local.sh" --hermes-home "$hermes" --quiet-window 0 --max-wait 0 --ready-timeout 0 > "$output" 2>&1; then
    fail 'deploy accepted six online profiles when eight were configured'
  fi
  assert_contains "$output" 'did not report all configured profiles online'
}

# The reader itself, both ways round. PyYAML gives the exact answer; a host
# without it (a hosted CI runner, a plain system python) falls back to a stdlib
# probe, and the two must agree on every config an ordinary profile has. Where
# the probe cannot be certain it must answer "nothing absent", so the caller
# writes nothing.
test_streaming_reader_answers_without_pyyaml() {
  local dir="$TMP/reader" answer
  mkdir -p "$dir/mute" "$dir/both" "$dir/off" "$dir/telegram-only" "$dir/unjudgeable"
  printf 'plugins:\n  enabled:\n    - cozygateway\n' > "$dir/mute/config.yaml"
  # Every shape that must answer "nothing absent" carries the cadence knobs too:
  # the reader now looks for four keys, not two.
  printf 'display:\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming: true\nstreaming:\n  edit_interval: 0.05\n  buffer_threshold: 1\n' > "$dir/both/config.yaml"
  printf 'display:\n  streaming: false\n  platforms:\n    cozygateway:\n      streaming: false\nstreaming:\n  edit_interval: 0.05\n  buffer_threshold: 1\n' > "$dir/off/config.yaml"
  printf 'display:\n  streaming: true\n  platforms:\n    telegram:\n      streaming: false\n  runtime_footer:\n    fields:\n      - model\n' > "$dir/telegram-only/config.yaml"
  printf 'display: {streaming: true}\n' > "$dir/unjudgeable/config.yaml"
  mkdir -p "$dir/nested-block" "$dir/nested-block-top" "$dir/null-value"
  # An operator who tuned streaming as a BLOCK. PyYAML reads a mapping, which is
  # not absence, and writing `true` over it would throw their settings away.
  printf 'display:\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming:\n        enabled: true\n        min_interval_ms: 400\nstreaming:\n  edit_interval: 0.05\n  buffer_threshold: 1\n' \
    > "$dir/nested-block/config.yaml"
  printf 'display:\n  streaming:\n    a: b\n  platforms:\n    cozygateway:\n      streaming: true\nstreaming:\n  edit_interval: 0.05\n  buffer_threshold: 1\n' \
    > "$dir/nested-block-top/config.yaml"
  # A key with nothing under it at all IS absent, the way PyYAML reads it, so
  # this one is still repaired.
  printf 'display:\n  streaming:\n  platforms:\n    cozygateway:\n      streaming: true\n' \
    > "$dir/null-value/config.yaml"
  mkdir -p "$dir/tagged-display" "$dir/tagged-platform" "$dir/tagged-scalar"
  # A YAML tag in front of a block mapping. The block still opens on the line
  # BELOW, so a probe that reads the tag as an ordinary value walks straight
  # past the keys inside it and calls them absent.
  printf 'display: !!map\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming: true\nstreaming:\n  edit_interval: 0.05\n  buffer_threshold: 1\n' \
    > "$dir/tagged-display/config.yaml"
  printf 'display:\n  streaming: true\n  platforms:\n    cozygateway: !!map\n      streaming: true\nstreaming:\n  edit_interval: 0.05\n  buffer_threshold: 1\n' \
    > "$dir/tagged-platform/config.yaml"
  # A tagged SCALAR is a value like any other, so both keys are present.
  printf 'display:\n  streaming: !!bool true\n  platforms:\n    cozygateway:\n      streaming: !!bool false\nstreaming:\n  edit_interval: 0.05\n  buffer_threshold: 1\n' \
    > "$dir/tagged-scalar/config.yaml"

  # F16. The two cadence knobs are a SEPARATE top-level key from the two display
  # switches, so a profile ST1 already repaired is still edit-rate-limited to
  # Telegram's envelope and must be reported; an operator who tuned them keeps
  # every value they chose.
  mkdir -p "$dir/cadence-absent" "$dir/cadence-tuned" "$dir/cadence-partial"
  printf 'display:\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming: true\n' \
    > "$dir/cadence-absent/config.yaml"
  printf 'display:\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming: true\nstreaming:\n  edit_interval: 2.0\n  buffer_threshold: 200\n' \
    > "$dir/cadence-tuned/config.yaml"
  printf 'display:\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming: true\nstreaming:\n  enabled: true\n  edit_interval: 2.0\n' \
    > "$dir/cadence-partial/config.yaml"
  mkdir -p "$dir/cadence-partial-threshold"
  printf 'display:\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming: true\nstreaming:\n  buffer_threshold: 200\n' \
    > "$dir/cadence-partial-threshold/config.yaml"

  read_with() {
    PYTHON="$1" bash -c '
      eval "$(sed -n "/^streaming_keys_absent()/,/^}/p" "$1")"
      streaming_keys_absent "$2"
    ' _ "$ROOT/scripts/provision-bot.sh" "$2"
  }

  # Without PyYAML, guaranteed: -S skips site-packages.
  cat > "$TMP/python3-nosite" <<'SH'
#!/bin/sh
exec python3 -S "$@"
SH
  chmod +x "$TMP/python3-nosite"

  answer="$(read_with "$TMP/python3-nosite" "$dir/mute" | tr '\n' ' ')"
  [ "$answer" = 'display.streaming=true display.platforms.cozygateway.streaming=true streaming.edit_interval=0.05 streaming.buffer_threshold=1 ' ] \
    || fail "stdlib probe on a mute profile answered: $answer"
  answer="$(read_with "$TMP/python3-nosite" "$dir/both" | tr '\n' ' ')"
  [ -z "$answer" ] || fail "stdlib probe on a streaming profile answered: $answer"
  answer="$(read_with "$TMP/python3-nosite" "$dir/off" | tr '\n' ' ')"
  [ -z "$answer" ] || fail "stdlib probe treated an explicit false as absent: $answer"
  answer="$(read_with "$TMP/python3-nosite" "$dir/telegram-only" | tr '\n' ' ')"
  [ "$answer" = 'display.platforms.cozygateway.streaming=true streaming.edit_interval=0.05 streaming.buffer_threshold=1 ' ] \
    || fail "stdlib probe beside another platform answered: $answer"
  # A flow mapping is not something this probe judges, so it says nothing is
  # absent and the caller leaves the file alone.
  answer="$(read_with "$TMP/python3-nosite" "$dir/unjudgeable" | tr '\n' ' ')"
  [ -z "$answer" ] || fail "stdlib probe judged a flow mapping it cannot read: $answer"

  answer="$(read_with "$TMP/python3-nosite" "$dir/nested-block" | tr '\n' ' ')"
  [ -z "$answer" ] || fail "stdlib probe called a nested block absent: $answer"
  answer="$(read_with "$TMP/python3-nosite" "$dir/nested-block-top" | tr '\n' ' ')"
  [ -z "$answer" ] || fail "stdlib probe called a nested block absent: $answer"
  answer="$(read_with "$TMP/python3-nosite" "$dir/null-value" | tr '\n' ' ')"
  [ "$answer" = 'display.streaming=true streaming.edit_interval=0.05 streaming.buffer_threshold=1 ' ] \
    || fail "stdlib probe on a key with no value answered: $answer"

  # F16 ruling 2. The cadence knobs are TOP-LEVEL: Hermes has no per-platform
  # override for them, so seeding them on a profile that also runs Telegram or
  # Discord speeds those bots' edits into their own flood limits. A profile that
  # serves anything else keeps its cadence and says so; the per-platform display
  # switches are unaffected. Answered from the env token Hermes itself gates on,
  # and from a platform plugin sitting in the profile.
  mkdir -p "$dir/shared-env" "$dir/shared-plugin/plugins/telegramish" "$dir/shared-decided/plugins/telegramish"
  printf 'plugins:\n  enabled:\n    - cozygateway\n' > "$dir/shared-env/config.yaml"
  printf 'COZYGATEWAY_TOKEN=x\nTELEGRAM_BOT_TOKEN=abc123\n' > "$dir/shared-env/.env"
  printf 'display:\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming: true\n' \
    > "$dir/shared-plugin/config.yaml"
  printf 'name: telegramish\nkind: platform\n' > "$dir/shared-plugin/plugins/telegramish/plugin.yaml"
  # An empty token assigns nothing, so it is not another platform.
  mkdir -p "$dir/shared-empty-token"
  printf 'plugins:\n  enabled:\n    - cozygateway\n' > "$dir/shared-empty-token/config.yaml"
  printf 'TELEGRAM_BOT_TOKEN=\n' > "$dir/shared-empty-token/.env"
  # Cadence already decided beside another platform: nothing to say and nothing
  # to write, so no note either.
  printf 'display:\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming: true\nstreaming:\n  edit_interval: 2.0\n  buffer_threshold: 200\n' \
    > "$dir/shared-decided/config.yaml"
  printf 'name: telegramish\nkind: platform\n' > "$dir/shared-decided/plugins/telegramish/plugin.yaml"

  answer="$(read_with "$TMP/python3-nosite" "$dir/shared-env" | tr '\n' ' ')"
  [ "$answer" = '!another-chat-platform:TELEGRAM_BOT_TOKEN display.streaming=true display.platforms.cozygateway.streaming=true ' ] \
    || fail "reader beside a Telegram token answered: $answer"
  answer="$(read_with "$TMP/python3-nosite" "$dir/shared-plugin" | tr '\n' ' ')"
  [ "$answer" = '!another-chat-platform:telegramish ' ] \
    || fail "reader beside a platform plugin answered: $answer"
  answer="$(read_with "$TMP/python3-nosite" "$dir/shared-empty-token" | tr '\n' ' ')"
  [ "$answer" = 'display.streaming=true display.platforms.cozygateway.streaming=true streaming.edit_interval=0.05 streaming.buffer_threshold=1 ' ] \
    || fail "reader treated an unset Telegram token as another platform: $answer"
  answer="$(read_with "$TMP/python3-nosite" "$dir/shared-decided" | tr '\n' ' ')"
  [ -z "$answer" ] || fail "reader said something about a profile with nothing to repair: $answer"

  answer="$(read_with "$TMP/python3-nosite" "$dir/cadence-absent" | tr '\n' ' ')"
  [ "$answer" = 'streaming.edit_interval=0.05 streaming.buffer_threshold=1 ' ] \
    || fail "stdlib probe on a streaming-but-slow profile answered: $answer"
  answer="$(read_with "$TMP/python3-nosite" "$dir/cadence-tuned" | tr '\n' ' ')"
  [ -z "$answer" ] || fail "stdlib probe reported cadence an operator had tuned: $answer"
  # The two cadence keys are ONE setting, read as a disjunction: writing a
  # threshold of 1 beside an operator's deliberate 2.0 second interval makes that
  # interval unreachable. Half set means neither is written, and it says so.
  answer="$(read_with "$TMP/python3-nosite" "$dir/cadence-partial" | tr '\n' ' ')"
  [ "$answer" = '!cadence-partly-set:streaming.edit_interval ' ] \
    || fail "stdlib probe on a half-tuned streaming block answered: $answer"
  answer="$(read_with "$TMP/python3-nosite" "$dir/cadence-partial-threshold" | tr '\n' ' ')"
  [ "$answer" = '!cadence-partly-set:streaming.buffer_threshold ' ] \
    || fail "stdlib probe on the other half-tuned block answered: $answer"

  local tagged
  for tagged in tagged-display tagged-platform tagged-scalar; do
    answer="$(read_with "$TMP/python3-nosite" "$dir/$tagged" | tr '\n' ' ')"
    [ -z "$answer" ] || fail "stdlib probe called a tagged shape absent ($tagged): $answer"
  done

  # A Windows interpreter writes CRLF on a text stream. The reader writes bytes
  # so it does not, and the caller strips a carriage return anyway; neither may
  # be dropped, because a "\r" glued to a key name is written into a config file
  # as part of the key. Emulated with an interpreter that ends every line the
  # Windows way.
  cat > "$TMP/python3-crlf" <<'SH'
#!/bin/sh
python3 -S "$@" | sed 's/$/\r/'
SH
  chmod +x "$TMP/python3-crlf"
  answer="$(read_with "$TMP/python3-crlf" "$dir/mute")"
  case "$answer" in
    *$'\r'*) fail 'a carriage return from a Windows interpreter reached the caller' ;;
  esac
  [ "$(printf '%s' "$answer" | tr '\n' ' ')" = 'display.streaming=true display.platforms.cozygateway.streaming=true streaming.edit_interval=0.05 streaming.buffer_threshold=1' ] \
    || fail "the CRLF interpreter answered: $answer"

  if [ -z "$YAML_PYTHON" ]; then
    printf 'note: no PyYAML on this host, so the agreement half of the reader case did not run\n'
    return 0
  fi
  local case_dir
  for case_dir in mute both off telegram-only nested-block nested-block-top null-value \
    tagged-display tagged-platform tagged-scalar cadence-absent cadence-tuned cadence-partial \
    cadence-partial-threshold shared-env shared-plugin shared-empty-token shared-decided; do
    [ "$(read_with "$YAML_PYTHON" "$dir/$case_dir" | tr '\n' ' ')" \
      = "$(read_with "$TMP/python3-nosite" "$dir/$case_dir" | tr '\n' ' ')" ] \
      || fail "the two readers disagree on $case_dir"
  done
}

# Streaming is off in Hermes by default (`StreamingConfig.enabled` is false and
# `_setup_stream_consumer` resolves the per-platform `display` key), so a
# profile created before the seed wrote those keys is fully wired and still
# never emits a draft frame. The sweep is what repairs it without hand edits.
test_watcher_picks_up_a_wired_profile_that_cannot_stream() {
  local repo="$TMP/stream-repo" hermes="$TMP/stream-hermes" bin="$TMP/stream-bin" log="$TMP/stream.log" calls="$TMP/stream-calls"
  mkdir -p "$repo/scripts" "$repo/integrations/attach-plugin"
  cp "$ROOT/scripts/bot-provisioner-watch.sh" "$repo/scripts/"
  printf 'name: cozygateway\n' > "$repo/integrations/attach-plugin/plugin.yaml"
  make_fake_bin "$bin"
  make_profile "$hermes" silent
  make_mute_config "$hermes/profiles/silent"
  mkdir -p "$hermes/profiles/silent/plugins/cozygateway"
  cp "$repo/integrations/attach-plugin/plugin.yaml" "$hermes/profiles/silent/plugins/cozygateway/plugin.yaml"
  make_fake_python "$hermes" ''
  cat > "$bin/provision" <<'SH'
#!/bin/sh
printf '%s\n' "$*" > "$COZY_TEST_PROVISION_CALLS"
SH
  chmod +x "$bin/provision"
  mkdir -p "$TMP/stream-runtime"
  date +%s > "$TMP/stream-runtime/cozylabs-bot-provisioner.reconcile"

  HOME="$TMP/stream-home" TMPDIR="$TMP/stream-runtime" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/stream-launchctl" COZY_TEST_SSH_LOG="$TMP/stream-ssh" \
    COZY_TEST_PROVISION_CALLS="$calls" COZY_PROVISION_COMMAND="$bin/provision" \
    COZY_PROVISIONER_LOCK="$TMP/stream.lock" COZY_PROVISIONER_RECONCILE_SECONDS=999999 \
    "$repo/scripts/bot-provisioner-watch.sh" --dry-run --hermes-home "$hermes" --log "$log"

  assert_contains "$log" 'pending: silent (streaming settings are incomplete in config.yaml)'

  # And a profile that already carries both keys is steady state, not work.
  make_profile "$hermes" silent
  rm -f "$calls" "$log"
  HOME="$TMP/stream-home" TMPDIR="$TMP/stream-runtime" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/stream-launchctl" COZY_TEST_SSH_LOG="$TMP/stream-ssh" \
    COZY_TEST_PROVISION_CALLS="$calls" COZY_PROVISION_COMMAND="$bin/provision" \
    COZY_PROVISIONER_LOCK="$TMP/stream.lock" COZY_PROVISIONER_RECONCILE_SECONDS=999999 \
    "$repo/scripts/bot-provisioner-watch.sh" --dry-run --hermes-home "$hermes" --log "$log"
  [ ! -e "$calls" ] || fail 'watcher re-provisioned a profile that already streams'
}

test_provisioner_turns_streaming_on_and_restarts_once() {
  local hermes="$TMP/stream-fix-hermes" bin="$TMP/stream-fix-bin" launch_log="$TMP/stream-fix-launchctl" hermes_log="$TMP/stream-fix-hermes-calls"
  make_fake_bin "$bin"
  make_profile "$hermes" silent
  make_mute_config "$hermes/profiles/silent"
  make_fake_python "$hermes" ''
  # Wired and current: only the display keys are missing, so a restart here is
  # for the config change and nothing else.
  mkdir -p "$hermes/profiles/silent/plugins"
  cp -R "$ROOT/integrations/attach-plugin" "$hermes/profiles/silent/plugins/cozygateway"

  HOME="$TMP/stream-fix-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$launch_log" COZY_TEST_SSH_LOG="$TMP/stream-fix-ssh" \
    COZY_TEST_HERMES_LOG="$hermes_log" \
    "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake silent >/dev/null

  assert_contains "$hermes_log" '-p silent config set display.streaming true'
  assert_contains "$hermes_log" '-p silent config set display.platforms.cozygateway.streaming true'
  # F16. Streaming ON is only half of it: without these the profile still flushes
  # at most one frame per 0.8 seconds, which is two frames for a minute-long
  # reply on the wire TB2 measured.
  assert_contains "$hermes_log" '-p silent config set streaming.edit_interval 0.05'
  assert_contains "$hermes_log" '-p silent config set streaming.buffer_threshold 1'
  # Exactly one restart, not one per key and not one per sweep.
  local restarts
  restarts="$(grep -c 'kickstart -k gui/' "$launch_log" || true)"
  [ "$restarts" = 1 ] || fail "expected exactly one restart after the config repair, got $restarts"
}

# `config set` exiting 0 is not proof of a write: real Hermes returns 0 without
# writing on a package-managed install. Trusting the exit code would kickstart
# this profile on every sweep, forever.
test_provisioner_does_not_restart_when_the_write_did_not_land() {
  local hermes="$TMP/noop-hermes" bin="$TMP/noop-bin" launch_log="$TMP/noop-launchctl" output="$TMP/noop.out"
  make_fake_bin "$bin"
  make_profile "$hermes" silent
  make_mute_config "$hermes/profiles/silent"
  make_fake_python "$hermes" ''
  mkdir -p "$hermes/profiles/silent/plugins"
  cp -R "$ROOT/integrations/attach-plugin" "$hermes/profiles/silent/plugins/cozygateway"

  HOME="$TMP/noop-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" COZY_TEST_HERMES_NOOP_WRITER=1 \
    COZY_TEST_LAUNCHCTL_LOG="$launch_log" COZY_TEST_SSH_LOG="$TMP/noop-ssh" \
    "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake silent > "$output" 2>&1

  assert_contains "$output" 'is still absent; leaving streaming off and not restarting'
  if grep -Fq 'kickstart -k' "$launch_log"; then
    fail 'provisioner restarted a profile whose config was never actually written'
  fi
}

# A write that fails is one mute bot, not a dead sweep: the profiles after it
# still get provisioned.
test_provisioner_keeps_sweeping_when_a_write_fails() {
  local hermes="$TMP/writefail-hermes" bin="$TMP/writefail-bin" output="$TMP/writefail.out"
  make_fake_bin "$bin"
  make_profile "$hermes" first-mute
  make_mute_config "$hermes/profiles/first-mute"
  make_profile "$hermes" second-wired
  make_fake_python "$hermes" ''
  mkdir -p "$hermes/profiles/first-mute/plugins" "$hermes/profiles/second-wired/plugins"
  cp -R "$ROOT/integrations/attach-plugin" "$hermes/profiles/first-mute/plugins/cozygateway"
  cp -R "$ROOT/integrations/attach-plugin" "$hermes/profiles/second-wired/plugins/cozygateway"

  HOME="$TMP/writefail-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" COZY_TEST_HERMES_WRITER_FAILS=1 \
    COZY_TEST_LAUNCHCTL_LOG="$TMP/writefail-launchctl" COZY_TEST_SSH_LOG="$TMP/writefail-ssh" \
    "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake first-mute second-wired > "$output" 2>&1

  assert_contains "$output" 'hermes could not set display.streaming, leaving streaming off for this profile'
  assert_contains "$output" '=== second-wired ==='
  assert_contains "$output" 'provision-bot: all profiles provisioned'
}

# F16. ST1 turned streaming ON for every profile it swept, and those profiles
# are still edit-rate-limited to one frame per 0.8 seconds. The cadence half is
# the same repair through the same kickstart path: once, then never again.
test_provisioner_repairs_cadence_on_an_already_streaming_profile_once() {
  local hermes="$TMP/cadence-hermes" bin="$TMP/cadence-bin" launch_log="$TMP/cadence-launchctl" hermes_log="$TMP/cadence-hermes-calls"
  make_fake_bin "$bin"
  make_profile "$hermes" already-streaming
  make_fake_python "$hermes" ''
  mkdir -p "$hermes/profiles/already-streaming/plugins"
  cp -R "$ROOT/integrations/attach-plugin" "$hermes/profiles/already-streaming/plugins/cozygateway"
  # Exactly what ST1 leaves behind: both display keys, no cadence block at all.
  cat > "$hermes/profiles/already-streaming/config.yaml" <<'YAML'
plugins:
  enabled:
    - cozygateway
display:
  streaming: true
  platforms:
    cozygateway:
      streaming: true
YAML

  run_sweep() {
    HOME="$TMP/cadence-home" PATH="$bin:/usr/bin:/bin" \
      COZY_TEST_HERMES_HOME="$hermes" \
      COZY_TEST_LAUNCHCTL_LOG="$launch_log" COZY_TEST_SSH_LOG="$TMP/cadence-ssh" \
      COZY_TEST_HERMES_LOG="$hermes_log" \
      "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake already-streaming >/dev/null
  }
  run_sweep

  assert_contains "$hermes_log" '-p already-streaming config set streaming.edit_interval 0.05'
  assert_contains "$hermes_log" '-p already-streaming config set streaming.buffer_threshold 1'
  if grep -q 'config set display' "$hermes_log"; then
    fail 'provisioner rewrote display keys the profile already carried'
  fi
  local restarts
  restarts="$(grep -c 'kickstart -k gui/' "$launch_log" || true)"
  [ "$restarts" = 1 ] || fail "expected exactly one restart for the cadence repair, got $restarts"

  # Second sweep: the keys are there now, so nothing is written and nothing is
  # restarted. A repair that runs every tick is a restart loop.
  : > "$hermes_log"
  run_sweep
  if grep -q 'config set' "$hermes_log"; then
    fail 'provisioner repaired the cadence a second time'
  fi
  restarts="$(grep -c 'kickstart -k gui/' "$launch_log" || true)"
  [ "$restarts" = 1 ] || fail "expected no further restart on the second sweep, got $restarts"
}

# F16 ruling 2, at the sweep. Streaming still gets turned ON for a profile that
# also serves Telegram; only the profile-wide cadence is left alone, and the
# profile is not swept again for it.
test_provisioner_leaves_cadence_alone_beside_another_platform() {
  local hermes="$TMP/shared-hermes" bin="$TMP/shared-bin" launch_log="$TMP/shared-launchctl" hermes_log="$TMP/shared-hermes-calls" output="$TMP/shared.out"
  make_fake_bin "$bin"
  make_profile "$hermes" shared-bot
  make_mute_config "$hermes/profiles/shared-bot"
  make_fake_python "$hermes" ''
  mkdir -p "$hermes/profiles/shared-bot/plugins"
  cp -R "$ROOT/integrations/attach-plugin" "$hermes/profiles/shared-bot/plugins/cozygateway"
  printf 'COZYGATEWAY_TOKEN=test-token\nCOZYGATEWAY_SPOOL_PATH=%s\nTELEGRAM_BOT_TOKEN=abc123\n' \
    "$hermes/profiles/shared-bot/plugin-data/cozygateway/attach-v1.sqlite" \
    > "$hermes/profiles/shared-bot/.env"

  HOME="$TMP/shared-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$launch_log" COZY_TEST_SSH_LOG="$TMP/shared-ssh" \
    COZY_TEST_HERMES_LOG="$hermes_log" \
    "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake shared-bot > "$output" 2>&1

  assert_contains "$hermes_log" '-p shared-bot config set display.streaming true'
  assert_contains "$output" 'profile also serves TELEGRAM_BOT_TOKEN'
  if grep -q 'config set streaming' "$hermes_log"; then
    fail 'provisioner tightened a profile-wide cadence on a profile serving another platform'
  fi
  # And a left-alone cadence must never read as pending work: the display keys
  # landed, so a second sweep writes nothing and restarts nothing.
  : > "$hermes_log"
  local restarts_before
  restarts_before="$(grep -c 'kickstart -k gui/' "$launch_log" || true)"
  HOME="$TMP/shared-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$launch_log" COZY_TEST_SSH_LOG="$TMP/shared-ssh" \
    COZY_TEST_HERMES_LOG="$hermes_log" \
    "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake shared-bot >/dev/null 2>&1
  if grep -q 'config set' "$hermes_log"; then
    fail 'provisioner wrote streaming settings a second time on a shared profile'
  fi
  [ "$(grep -c 'kickstart -k gui/' "$launch_log" || true)" = "$restarts_before" ] \
    || fail 'provisioner restarted a shared profile again for a cadence it will never write'
}

test_provisioner_leaves_streaming_turned_off_on_purpose() {
  local hermes="$TMP/stream-off-hermes" bin="$TMP/stream-off-bin" launch_log="$TMP/stream-off-launchctl" hermes_log="$TMP/stream-off-hermes-calls"
  make_fake_bin "$bin"
  make_profile "$hermes" quiet-on-purpose
  make_fake_python "$hermes" ''
  mkdir -p "$hermes/profiles/quiet-on-purpose/plugins"
  cp -R "$ROOT/integrations/attach-plugin" "$hermes/profiles/quiet-on-purpose/plugins/cozygateway"
  cat > "$hermes/profiles/quiet-on-purpose/config.yaml" <<'YAML'
plugins:
  enabled:
    - cozygateway
display:
  streaming: false
  platforms:
    cozygateway:
      streaming: false
streaming:
  edit_interval: 2.0
  buffer_threshold: 200
YAML

  HOME="$TMP/stream-off-home" PATH="$bin:/usr/bin:/bin" \
    COZY_TEST_HERMES_HOME="$hermes" \
    COZY_TEST_LAUNCHCTL_LOG="$launch_log" COZY_TEST_SSH_LOG="$TMP/stream-off-ssh" \
    COZY_TEST_HERMES_LOG="$hermes_log" \
    "$ROOT/scripts/provision-bot.sh" --no-verify --hermes-home "$hermes" --box fake quiet-on-purpose >/dev/null

  if [ -e "$hermes_log" ] && grep -q 'config set display' "$hermes_log"; then
    fail 'provisioner overrode a streaming setting the operator turned off'
  fi
  if [ -e "$hermes_log" ] && grep -q 'config set streaming' "$hermes_log"; then
    fail 'provisioner overrode a streaming cadence the operator had tuned'
  fi
  if grep -Fq 'kickstart -k' "$launch_log"; then
    fail 'provisioner restarted a profile it had no reason to change'
  fi
}

test_watcher_repairs_content_drift
test_streaming_reader_answers_without_pyyaml
test_watcher_picks_up_a_wired_profile_that_cannot_stream
test_provisioner_turns_streaming_on_and_restarts_once
test_provisioner_repairs_cadence_on_an_already_streaming_profile_once
test_provisioner_leaves_cadence_alone_beside_another_platform
test_provisioner_leaves_streaming_turned_off_on_purpose
test_provisioner_does_not_restart_when_the_write_did_not_land
test_provisioner_keeps_sweeping_when_a_write_fails
test_watcher_ignores_checkout_pytest_cache
test_provisioner_ignores_checkout_pytest_cache
test_provisioner_restarts_loaded_service_after_sync
test_provisioner_copies_existing_chat_registry_to_new_profile
test_provisioner_preserves_partial_chat_registry
test_deploy_discovers_every_opted_in_profile
test_deploy_rejects_partial_configured_fleet
printf 'plugin rollout: ok\n'

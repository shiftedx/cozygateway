#!/usr/bin/env bash
# The harness choice, the CozyAgents branch of the all-in-one installer, the model
# and provider questions it asks, the network question, and the QR rule.
#
# Everything the CozyAgents branch reaches out to is stubbed here: the CozyAgents installer is a
# local file behind COZYAGENTS_INSTALL_URL, the cozyagents command it leaves behind is a log, and
# the gateway bundle answers `pair` without a gateway. Nothing in this file touches the network.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
installer="$repo_root/scripts/agent-install.sh"
real_node="$(command -v node)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cozygateway-harness-test.XXXXXX")"
tmp="$(cd -P "$tmp" && pwd)"
trap 'rm -rf "$tmp"' EXIT
trap 'status=$?; [ "$status" -eq 0 ] || printf "FAIL  line %s exited %s: %s\n" "$LINENO" "$status" "$BASH_COMMAND" >&2' ERR

expect_contains() {
  local haystack="$1" needle="$2"
  if ! grep -Fq -e "$needle" <<<"$haystack"; then
    printf 'FAIL  expected output to contain: %s\n--- actual output ---\n%s\n--- end ---\n' "$needle" "$haystack" >&2
    return 1
  fi
}
expect_missing() {
  local haystack="$1" needle="$2"
  if grep -Fq -e "$needle" <<<"$haystack"; then
    printf 'FAIL  expected output NOT to contain: %s\n--- actual output ---\n%s\n--- end ---\n' "$needle" "$haystack" >&2
    return 1
  fi
}

mkdir -p "$tmp/bin" "$tmp/hermes-bin"

# The gateway bundle: `pair` is the only command the installer runs through it.
cat > "$tmp/gateway.mjs" <<'BUNDLE'
import { existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pair') {
  const configAt = args.indexOf('--config');
  const config = configAt === -1 ? 'cozygateway.config.json' : args[configAt + 1];
  if (!existsSync(config)) process.exit(2);
  const configured = JSON.parse(readFileSync(config, 'utf8'));
  const kindAt = args.indexOf('--kind');
  const kind = kindAt === -1 ? 'device' : args[kindAt + 1];
  const wildcard = configured.host === '0.0.0.0' || configured.host === '::';
  const host = wildcard ? (process.env.COZYGATEWAY_TEST_PAIRING_LAN_ADDRESS ?? '127.0.0.1') : configured.host;
  const gatewayUrl = configured.publicUrl ?? `http://${host}:${configured.port}`;
  const code = kind === 'runner' ? 'RUNNER-TEST-CODE' : 'TEST-CODE';
  process.stdout.write('█▀▀▀▀▀█ fake-qr █▀▀▀▀▀█\n');
  process.stdout.write(JSON.stringify(kind === 'runner' ? { gatewayUrl, setupCode: code, kind } : { gatewayUrl, setupCode: code }) + '\n');
  process.stdout.write('Gateway URL: ' + gatewayUrl + '\n');
  process.stdout.write('Setup code:  ' + code + '\n');
}
BUNDLE

# A Hermes that is only ever asked whether it has a model.
cat > "$tmp/hermes-bin/hermes" <<'HERMES'
#!/usr/bin/env bash
if [ "$1" = status ]; then printf 'Current model: test/model\nActive provider: test-provider\n'; exit 0; fi
exit 0
HERMES
chmod 700 "$tmp/hermes-bin/hermes"

# launchd and curl, so a live run needs neither a service manager nor a listener.
cat > "$tmp/bin/launchctl" <<'LAUNCHCTL'
#!/usr/bin/env bash
exit 0
LAUNCHCTL
cat > "$tmp/bin/curl" <<'CURL'
#!/usr/bin/env bash
[ -z "${COZYGATEWAY_TEST_CURL_LOG:-}" ] || printf '%s\n' "$*" >> "$COZYGATEWAY_TEST_CURL_LOG"
case "$*" in
  *runners/self*)
    # The token arrives on stdin (-H @-), never in argv.
    cat >/dev/null 2>&1 || true
    [ "${COZYGATEWAY_TEST_RUNNER_SELF_DOWN:-}" = 1 ] && exit 7
    printf '{"id":"r-1","name":"test-runner","lastSeenAt":1756771200000,"attached":true}'
    ;;
  *health*) if [[ "$*" == *"-o /dev/null"* ]]; then printf '200'; else printf '{"attach":{"configured":0,"online":0,"deadLetters":0}}'; fi ;;
  *) exit 1 ;;
esac
CURL
chmod 700 "$tmp/bin/launchctl" "$tmp/bin/curl"

# The stubbed CozyAgents installer: it writes the launcher the real one writes, and that launcher
# records every command this installer gives it. `runner pair` writes the runner credential, so a
# rerun can prove the pairing is kept.
cat > "$tmp/agents.sh" <<'AGENTS'
#!/usr/bin/env bash
set -euo pipefail
home="${COZYAGENTS_HOME:?}"
printf 'install %s\n' "$*" >> "${COZYAGENTS_TEST_LOG:?}"
mkdir -p "$home/bin"
cat > "$home/bin/cozyagents" <<LAUNCHER
#!/usr/bin/env bash
printf 'argv %s\n' "\$*" >> "${COZYAGENTS_TEST_LOG}"
printf 'env COZYAGENTS_PAIR_CODE=%s\n' "\${COZYAGENTS_PAIR_CODE:-}" >> "${COZYAGENTS_TEST_LOG}"
if [ "\${1:-}" = runner ] && [ "\${2:-}" = pair ]; then
  printf 'COZYRUNNER_TOKEN=paired-token\nCOZYRUNNER_NAME=test-runner\nCOZYRUNNER_GATEWAY_URL=http://127.0.0.1:8787\n' >> "$home/runner.env"
  chmod 600 "$home/runner.env"
fi
exit 0
LAUNCHER
chmod 700 "$home/bin/cozyagents"
AGENTS
chmod 700 "$tmp/agents.sh"

cozy_env=(
  COZYGATEWAY_NODE="$real_node"
  COZYGATEWAY_SERVICE_PLATFORM=Darwin
  COZYAGENTS_INSTALL_URL="$tmp/agents.sh"
)

# ---------------------------------------------------------------------------
# 1. The harness question
# ---------------------------------------------------------------------------
printf '\n' > "$tmp/answer-enter"
printf '2\n' > "$tmp/answer-two"
printf 'nonsense\n1\n' > "$tmp/answer-retry"

enter_output="$(HOME="$tmp/home-enter" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT="$tmp/answer-enter" bash "$installer" --dry-run --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-enter" 2>&1)"
expect_contains "$enter_output" 'Which harness runs your bots? [1] CozyAgents (recommended) [2] Hermes Agent [1]'
expect_contains "$enter_output" 'harness: cozyagents'

two_output="$(HOME="$tmp/home-two" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT="$tmp/answer-two" bash "$installer" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-two" 2>&1)"
expect_contains "$two_output" 'harness: hermes'
expect_contains "$two_output" 'install Hermes Agent with the verified official tagged NousResearch installer'

retry_output="$(HOME="$tmp/home-retry" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT="$tmp/answer-retry" bash "$installer" --dry-run --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-retry" 2>&1)"
expect_contains "$retry_output" 'Please answer 1 or 2.'
expect_contains "$retry_output" 'harness: cozyagents'

# A machine that already has Hermes is never asked. The stub Hermes cannot answer the profile
# discovery that follows, so the run is allowed to stop there: the harness decision is the subject.
present_output="$(HOME="$tmp/home-present" PATH="$tmp/hermes-bin:$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN=hermes COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT="$tmp/answer-two" bash "$installer" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-present" 2>&1 || true)"
expect_missing "$present_output" 'Which harness runs your bots?'
expect_contains "$present_output" 'Hermes Agent is already installed; keeping it as the harness'

# `--harness` answers it, and so does having no terminal at all.
flag_output="$(HOME="$tmp/home-flag" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT="$tmp/answer-two" bash "$installer" --dry-run --harness cozyagents --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-flag" 2>&1)"
expect_missing "$flag_output" 'Which harness runs your bots?'
expect_contains "$flag_output" 'harness: cozyagents (from --harness)'

silent_output="$(HOME="$tmp/home-silent" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" bash "$installer" --dry-run --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-silent" 2>&1)"
expect_missing "$silent_output" 'Which harness runs your bots?'
expect_contains "$silent_output" 'your bots run on this computer under the CozyAgents runner'

if bad_harness_output="$(HOME="$tmp/home-bad" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" bash "$installer" --dry-run --harness whatever --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-bad" 2>&1)"; then
  echo 'an unknown --harness must fail' >&2; exit 1
fi
expect_contains "$bad_harness_output" '--harness must be cozyagents or hermes'

# ---------------------------------------------------------------------------
# 2. The CozyAgents dry-run plan names nothing Hermes owns
# ---------------------------------------------------------------------------
plan_output="$silent_output"
expect_contains "$plan_output" 'CozyAgents-only gateway config'
expect_contains "$plan_output" 'no Hermes endpoint'
expect_contains "$plan_output" 'install CozyAgents from'
expect_missing "$plan_output" 'Profiles:'
expect_missing "$plan_output" 'attach plugin'
expect_missing "$plan_output" 'Dashboard'
test ! -e "$tmp/gw-silent"

# A CozyAgents install needs no plugin archive at all.
if missing_plugin_output="$(HOME="$tmp/home-plugin" PATH="$tmp/hermes-bin:$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN=hermes bash "$installer" --dry-run --harness hermes --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-plugin" 2>&1)"; then
  echo 'the Hermes harness must still require a plugin archive' >&2; exit 1
fi
expect_contains "$missing_plugin_output" '--plugin-archive must name the verified release archive'

# ---------------------------------------------------------------------------
# 3. A live CozyAgents install: model onboarding, the LAN question, the QR
# ---------------------------------------------------------------------------
live_home="$tmp/live-home"
mkdir -p "$live_home/.pi/agent"
printf '{"stub":true}\n' > "$live_home/.pi/agent/auth.json"
# provider, model id, share the Codex login, and then the LAN answer.
printf 'openai-codex\ngpt-5.6-luna\ny\n' > "$tmp/model-answers"
printf 'yes\n' > "$tmp/lan-yes"
: > "$tmp/agents.log"
live_output="$(HOME="$live_home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" \
  COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" \
  COZYAGENTS_HOME="$live_home/.cozyagents" COZYAGENTS_TEST_LOG="$tmp/agents.log" \
  COZYGATEWAY_TEST_MODEL_PROMPT_INPUT="$tmp/model-answers" \
  COZYGATEWAY_TEST_LAN_PROMPT_INPUT="$tmp/lan-yes" \
  COZYGATEWAY_TEST_PAIRING_LAN_ADDRESS=192.0.2.10 \
  bash "$installer" --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-live" 2>&1)"

# The questions, in the approved order: harness, model, network, then the QR.
expect_contains "$live_output" 'Which provider should new bots use?'
expect_contains "$live_output" 'Share the Codex login on this computer'
expect_contains "$live_output" 'Allow CozyChat to access this Gateway over your local network? [y/N]'
expect_contains "$live_output" 'default model for new bots: gpt-5.6-luna on openai-codex'

# The gateway config is the CozyAgents-only one.
config="$tmp/gw-live/local/cozygateway.config.json"
grep -Fq '"host": "0.0.0.0"' "$config"
if grep -q 'hermesEndpoints' "$config"; then echo 'a CozyAgents gateway must have no hermesEndpoints' >&2; exit 1; fi
grep -Fq 'harness=cozyagents' "$tmp/gw-live/local/install-state"

# The model answers landed in the runner env CozyAgents reads, at 0600, with no key.
runner_env="$live_home/.cozyagents/runner.env"
grep -Fq 'COZYRUNNER_MODEL_ID=gpt-5.6-luna' "$runner_env"
grep -Fq 'COZYRUNNER_MODEL_PROVIDER=openai-codex' "$runner_env"
grep -Fq 'COZYRUNNER_SHARE_HOST_MODEL_AUTH=1' "$runner_env"
if grep -q 'COZYRUNNER_MODEL_ENDPOINT' "$runner_env"; then echo 'a provider answer must not also write an endpoint' >&2; exit 1; fi
if grep -qi 'api_key' "$runner_env"; then echo 'the installer must never write a model key' >&2; exit 1; fi
test "$(stat -f %Lp "$runner_env" 2>/dev/null || stat -c %a "$runner_env")" = 600

# The person typed no pairing code: the installer minted a runner code and handed it over in the
# environment. A credential in waiting never reaches argv, where any process on this machine
# could read it.
expect_contains "$(cat "$tmp/agents.log")" 'install --no-pair'
expect_contains "$(cat "$tmp/agents.log")" 'argv runner pair --gateway http://127.0.0.1:8787 --name'
expect_contains "$(cat "$tmp/agents.log")" 'env COZYAGENTS_PAIR_CODE=RUNNER-TEST-CODE'
if grep '^argv ' "$tmp/agents.log" | grep -Fq 'RUNNER-TEST-CODE'; then
  echo 'the pairing code must never reach argv' >&2; exit 1
fi

# First-time setup ends on the QR, and the LAN answer is what it encodes.
expect_contains "$live_output" 'fake-qr'
expect_contains "$live_output" '"setupCode":"TEST-CODE"'
expect_contains "$live_output" '"gatewayUrl":"http://192.0.2.10:8787"'
expect_contains "$live_output" 'for devices on your local network'
expect_missing "$live_output" 'Dashboard'

# ---------------------------------------------------------------------------
# 4. The second run: no harness question, no LAN question, no new pairing
# ---------------------------------------------------------------------------
printf 'no\n' > "$tmp/pair-no"
: > "$tmp/agents.log"
rerun_output="$(HOME="$live_home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" \
  COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" \
  COZYAGENTS_HOME="$live_home/.cozyagents" COZYAGENTS_TEST_LOG="$tmp/agents.log" \
  COZYGATEWAY_TEST_HARNESS_PROMPT_INPUT="$tmp/answer-two" \
  COZYGATEWAY_TEST_PAIR_PROMPT_INPUT="$tmp/pair-no" \
  bash "$installer" --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-live" 2>&1)"
expect_missing "$rerun_output" 'Which harness runs your bots?'
expect_contains "$rerun_output" 'harness: cozyagents (already installed here)'
expect_missing "$rerun_output" 'Allow CozyChat to access this Gateway over your local network?'
expect_contains "$rerun_output" 'Create a new CozyChat pairing code? [y/N]'
expect_contains "$rerun_output" 'no new pairing code created'
expect_missing "$rerun_output" 'fake-qr'
expect_contains "$rerun_output" 'already paired to CozyGateway as a runner'
if grep -Fq 'runner pair' "$tmp/agents.log"; then echo 'a rerun must not re-pair the runner' >&2; exit 1; fi

# The QR question answered yes mints a new code; --no-qr never asks or prints one.
printf 'yes\n' > "$tmp/pair-yes"
yes_output="$(HOME="$live_home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" \
  COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" \
  COZYAGENTS_HOME="$live_home/.cozyagents" COZYAGENTS_TEST_LOG="$tmp/agents.log" \
  COZYGATEWAY_TEST_PAIR_PROMPT_INPUT="$tmp/pair-yes" \
  bash "$installer" --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-live" 2>&1)"
expect_contains "$yes_output" 'fake-qr'

no_qr_output="$(HOME="$live_home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" \
  COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" \
  COZYAGENTS_HOME="$live_home/.cozyagents" COZYAGENTS_TEST_LOG="$tmp/agents.log" \
  COZYGATEWAY_TEST_PAIR_PROMPT_INPUT="$tmp/pair-yes" \
  bash "$installer" --no-qr --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-live" 2>&1)"
expect_missing "$no_qr_output" 'fake-qr'
expect_missing "$no_qr_output" 'Create a new CozyChat pairing code?'
expect_contains "$no_qr_output" 'no pairing QR was printed (--no-qr)'

# `--status` names the harness this install owns, and reports the runner's own row rather than
# attach health. The runner token reaches curl on stdin, never in argv.
: > "$tmp/curl.log"
status_output="$(HOME="$live_home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYAGENTS_HOME="$live_home/.cozyagents" COZYGATEWAY_TEST_CURL_LOG="$tmp/curl.log" bash "$installer" --status --gateway-dir "$tmp/gw-live" 2>&1 || true)"
expect_contains "$status_output" 'harness: CozyAgents'
expect_contains "$status_output" 'runner "test-runner", last seen 2025-09-02T00:00:00.000Z, attached'
expect_contains "$(cat "$tmp/curl.log")" '/runners/self'
if grep -Fq 'paired-token' "$tmp/curl.log"; then echo 'the runner token must never reach argv' >&2; exit 1; fi

# With the gateway unreachable, the local runner state is what it reports.
down_output="$(HOME="$live_home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYAGENTS_HOME="$live_home/.cozyagents" COZYGATEWAY_TEST_RUNNER_SELF_DOWN=1 bash "$installer" --status --gateway-dir "$tmp/gw-live" 2>&1 || true)"
expect_contains "$down_output" 'the gateway did not answer /runners/self'
expect_contains "$down_output" 'runner "test-runner" is paired to http://127.0.0.1:8787'

# ---------------------------------------------------------------------------
# 5. A loopback answer stays loopback, and a local endpoint is written as one
# ---------------------------------------------------------------------------
loopback_home="$tmp/loopback-home"
printf 'http://127.0.0.1:1234/v1\nqwen3-coder\n' > "$tmp/endpoint-answers"
printf 'no\n' > "$tmp/lan-no"
: > "$tmp/agents.log"
loopback_output="$(HOME="$loopback_home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" \
  COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" \
  COZYAGENTS_HOME="$loopback_home/.cozyagents" COZYAGENTS_TEST_LOG="$tmp/agents.log" \
  COZYGATEWAY_CODEX_AUTH_PATH="$tmp/no-such-auth.json" \
  COZYGATEWAY_TEST_MODEL_PROMPT_INPUT="$tmp/endpoint-answers" \
  COZYGATEWAY_TEST_LAN_PROMPT_INPUT="$tmp/lan-no" \
  bash "$installer" --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-loopback" 2>&1)"
grep -Fq '"host": "127.0.0.1"' "$tmp/gw-loopback/local/cozygateway.config.json"
expect_contains "$loopback_output" '"gatewayUrl":"http://127.0.0.1:8787"'
grep -Fq 'COZYRUNNER_MODEL_ENDPOINT=http://127.0.0.1:1234/v1' "$loopback_home/.cozyagents/runner.env"
if grep -q 'COZYRUNNER_MODEL_PROVIDER' "$loopback_home/.cozyagents/runner.env"; then echo 'an endpoint answer must not also write a provider' >&2; exit 1; fi
# No Codex login on this machine, so the opt-in is never offered.
expect_missing "$loopback_output" 'Share the Codex login on this computer'

# A provider and an endpoint together are refused by name.
if both_output="$(HOME="$tmp/home-both" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" bash "$installer" --dry-run --harness cozyagents --runner-model-provider openai-codex --runner-model-endpoint http://127.0.0.1:1234/v1 --runner-model-id x --bundle "$tmp/gateway.mjs" --gateway-dir "$tmp/gw-both" 2>&1)"; then
  echo 'a provider and an endpoint together must fail' >&2; exit 1
fi
expect_contains "$both_output" '--runner-model-provider and --runner-model-endpoint are mutually exclusive'

# ---------------------------------------------------------------------------
# 6. An install made before the harness question existed is a Hermes install
# ---------------------------------------------------------------------------
# Its state file records a Hermes root and no harness line, and its Hermes binary has since moved,
# so the scan finds nothing. It must still be read as Hermes, and its Hermes bridge must survive.
legacy_dir="$tmp/gw-legacy"
mkdir -p "$legacy_dir/local"
cat > "$legacy_dir/local/install-state" <<STATE
profiles=default
profile_scope=all
hermes_root=$tmp/legacy-hermes-root
dashboard_port=9119
hermes_bin=$tmp/legacy-hermes-root/bin/hermes
service_default=installed
STATE
cat > "$legacy_dir/local/cozygateway.config.json" <<CONFIG
{
  "name": "cozygateway",
  "host": "127.0.0.1",
  "port": 8787,
  "dbPath": "$legacy_dir/local/cozygateway.sqlite",
  "hermesEndpoints": [{ "id": "default", "url": "ws://127.0.0.1:9119/api/ws", "authMode": "token", "tokenEnv": "COZYGATEWAY_HERMES_TOKEN", "profile": "default", "profiles": { "default": { "tokenEnv": "COZYGATEWAY_ATTACH_TOKEN_DEFAULT" } } }]
}
CONFIG
legacy_output="$(HOME="$tmp/legacy-home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" COZYAGENTS_HOME="$tmp/legacy-home/.cozyagents" COZYAGENTS_TEST_LOG="$tmp/agents.log" bash "$installer" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/gateway.mjs" --gateway-dir "$legacy_dir" 2>&1 || true)"
expect_contains "$legacy_output" 'harness: hermes (already installed here)'
expect_missing "$legacy_output" 'Which harness runs your bots?'
expect_missing "$legacy_output" 'CozyAgents'
grep -Fq 'hermesEndpoints' "$legacy_dir/local/cozygateway.config.json"

# A config with a Hermes bridge and no state file at all is not evidence that anybody chose
# CozyAgents. The default taken with no terminal keeps the bridge and says so.
orphan_dir="$tmp/gw-orphan"
mkdir -p "$orphan_dir/local"
sed "s|$legacy_dir|$orphan_dir|g" "$legacy_dir/local/cozygateway.config.json" > "$orphan_dir/local/cozygateway.config.json"
: > "$tmp/agents.log"
orphan_output="$(HOME="$tmp/orphan-home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" COZYAGENTS_HOME="$tmp/orphan-home/.cozyagents" COZYAGENTS_TEST_LOG="$tmp/agents.log" bash "$installer" --bundle "$tmp/gateway.mjs" --gateway-dir "$orphan_dir" 2>&1)"
expect_contains "$orphan_output" 'keeping it. Rerun with --harness cozyagents to replace it.'
grep -Fq 'hermesEndpoints' "$orphan_dir/local/cozygateway.config.json"
# It records Hermes, not CozyAgents, so it cannot read its own state back as a choice nobody made.
grep -Fq 'harness=hermes' "$orphan_dir/local/install-state"

# The path stays frozen: a later run with no flag and no answer leaves the bridge alone.
frozen_output="$(HOME="$tmp/orphan-home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" COZYAGENTS_HOME="$tmp/orphan-home/.cozyagents" COZYAGENTS_TEST_LOG="$tmp/agents.log" bash "$installer" --dry-run --bundle "$tmp/gateway.mjs" --plugin-archive "$tmp/gateway.mjs" --gateway-dir "$orphan_dir" 2>&1 || true)"
expect_contains "$frozen_output" 'harness: hermes (already installed here)'
grep -Fq 'hermesEndpoints' "$orphan_dir/local/cozygateway.config.json"

# Asking for it outright is the one thing that takes the bridge out.
chosen_output="$(HOME="$tmp/orphan-home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" COZYGATEWAY_HERMES_BIN="$tmp/absent-hermes" HERMES_HOME="$tmp/absent-hermes-home" COZYAGENTS_HOME="$tmp/orphan-home/.cozyagents" COZYAGENTS_TEST_LOG="$tmp/agents.log" bash "$installer" --harness cozyagents --no-qr --bundle "$tmp/gateway.mjs" --gateway-dir "$orphan_dir" 2>&1)"
expect_missing "$chosen_output" 'keeping it. Rerun with --harness cozyagents'
if grep -q 'hermesEndpoints' "$orphan_dir/local/cozygateway.config.json"; then
  echo 'an explicit CozyAgents choice must replace the Hermes bridge' >&2; exit 1
fi

# ---------------------------------------------------------------------------
# 7. Uninstall gives the harness back to its own uninstaller
# ---------------------------------------------------------------------------
: > "$tmp/agents.log"
uninstall_output="$(HOME="$loopback_home" PATH="$tmp/bin:$PATH" env "${cozy_env[@]}" \
  COZYAGENTS_HOME="$loopback_home/.cozyagents" COZYAGENTS_TEST_LOG="$tmp/agents.log" \
  bash "$installer" --uninstall --gateway-dir "$tmp/gw-loopback" 2>&1)"
expect_contains "$(cat "$tmp/agents.log")" 'uninstall --home'
expect_contains "$uninstall_output" 'removed the CozyAgents harness through its own uninstaller'
test ! -e "$tmp/gw-loopback"

# The bootstrap refuses root before it fetches anything. Running as root is not something this
# suite can do, so the check is asserted where it is: ahead of the first curl.
grep -Fq 'never needs sudo' "$repo_root/scripts/install.sh"
grep -Fq 'never needs sudo' "$installer"
# It refuses before the first fetch: the check is above the curl requirement in main.
root_line="$(grep -n 'never needs sudo' "$repo_root/scripts/install.sh" | cut -d: -f1)"
curl_line="$(grep -n 'curl is required' "$repo_root/scripts/install.sh" | cut -d: -f1)"
test "$root_line" -lt "$curl_line"

printf 'harness choice tests passed\n'

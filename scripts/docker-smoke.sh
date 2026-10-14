#!/usr/bin/env bash
# Build the gateway image and prove its explicit Hermes-config package/start/health/pair path. This
# deliberately does not embed a fake Hermes or echo runtime; attach-v1 conformance covers that seam.
set -euo pipefail

IMAGE="cozygateway:smoke"
NAME="cozygateway-smoke-$$"
PORT=18787
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
CONFIG_DIR="$TMP_DIR/config"
CONFIG_PATH="$CONFIG_DIR/cozygateway.config.json"
PAIR_RESPONSE="$TMP_DIR/pair-response.json"
SETTINGS_RESPONSE="$TMP_DIR/settings-response.json"
RENAME_REQUEST="$TMP_DIR/rename-request.json"
RENAME_RESPONSE="$TMP_DIR/rename-response.json"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$CONFIG_DIR"
# The production image runs as UID 1000. This disposable directory intentionally grants that user
# replacement rights; real deployments should chown the config directory as documented.
chmod 0777 "$CONFIG_DIR"

cat >"$CONFIG_PATH" <<'JSON'
{
  "name": "docker-smoke",
  "host": "0.0.0.0",
  "port": 8787,
  "dbPath": "/data/cozygateway.db",
  "hermesEndpoints": [{
    "id": "default",
    "url": "ws://127.0.0.1:1/api/ws",
    "tokenEnv": "SMOKE_HERMES_TOKEN",
    "profiles": {
      "smoke": { "tokenEnv": "SMOKE_ATTACH_TOKEN", "name": "Smoke" }
    }
  }]
}
JSON
chmod 0666 "$CONFIG_PATH"

echo "==> building gateway image"
docker build -f "$ROOT/packages/gateway/Dockerfile" -t "$IMAGE" "$ROOT"

echo "==> running container"
docker run -d --name "$NAME" -p "$PORT:8787" \
  -v "$CONFIG_DIR:/config:rw" \
  -e SMOKE_HERMES_TOKEN=smoke-control-token \
  -e SMOKE_ATTACH_TOKEN=smoke-attach-token \
  "$IMAGE" >/dev/null

echo "==> waiting for /health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = "30" ]; then echo "gateway did not become healthy"; docker logs "$NAME"; exit 1; fi
  sleep 1
done

echo "==> minting a setup code inside the container"
# Capture the full pair output first, then find the machine-readable line locally. Piping the
# docker exec through a selector makes the selector close the pipe early; any later CLI output then
# hits SIGPIPE, and under `set -o pipefail` the 141 kills the whole smoke (seen on Linux CI).
PAIR_OUTPUT="$(docker exec "$NAME" node dist/cli.js pair --config /config/cozygateway.config.json --url "http://127.0.0.1:$PORT")"
PAIR_JSON="$(printf '%s\n' "$PAIR_OUTPUT" | node -e '
let output = "";
process.stdin.on("data", chunk => output += chunk).on("end", () => {
  let jsonLine;
  for (const line of output.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line);
      if (typeof value?.setupCode === "string" && typeof value?.gatewayUrl === "string") {
        jsonLine = line;
        break;
      }
    } catch {}
  }
  if (!jsonLine) {
    console.error(`failed to find pairing JSON line in output:\n${output}`);
    process.exit(1);
  }
  process.stdout.write(jsonLine);
});
')"
SETUP_CODE="$(printf '%s' "$PAIR_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).setupCode))")"
if [ -z "$SETUP_CODE" ]; then echo "failed to mint a setup code"; docker logs "$NAME"; exit 1; fi
PAIR_URL="$(printf '%s' "$PAIR_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).gatewayUrl))")"
if [ "$PAIR_URL" != "http://127.0.0.1:$PORT" ]; then echo "pair advertised unexpected URL: $PAIR_URL"; exit 1; fi

echo "==> redeeming setup code"
PAIR_STATUS="$(curl -sS -o "$PAIR_RESPONSE" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/pair" \
  -H 'content-type: application/json' \
  --data "{\"setupCode\":\"$SETUP_CODE\",\"deviceName\":\"docker-smoke\"}")"
if [ "$PAIR_STATUS" != "200" ]; then echo "pair redemption failed: HTTP $PAIR_STATUS"; docker logs "$NAME"; exit 1; fi

DEVICE_TOKEN="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).deviceToken)' "$PAIR_RESPONSE")"

echo "==> renaming through the authenticated management API"
SETTINGS_STATUS="$(curl -sS -o "$SETTINGS_RESPONSE" -w '%{http_code}' \
  "http://127.0.0.1:$PORT/gateway/settings" -H "authorization: Bearer $DEVICE_TOKEN")"
if [ "$SETTINGS_STATUS" != "200" ]; then echo "settings read failed: HTTP $SETTINGS_STATUS"; exit 1; fi
node -e '
const fs = require("fs");
const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
fs.writeFileSync(process.argv[2], JSON.stringify({ ...settings, name: "docker-smoke-renamed" }));
' "$SETTINGS_RESPONSE" "$RENAME_REQUEST"
RENAME_STATUS="$(curl -sS -o "$RENAME_RESPONSE" -w '%{http_code}' -X PUT \
  "http://127.0.0.1:$PORT/gateway/settings" \
  -H "authorization: Bearer $DEVICE_TOKEN" \
  -H 'content-type: application/json' \
  --data-binary "@$RENAME_REQUEST")"
if [ "$RENAME_STATUS" != "200" ]; then echo "settings rename failed: HTTP $RENAME_STATUS"; cat "$RENAME_RESPONSE"; exit 1; fi
node -e '
const fs = require("fs");
const before = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const after = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (after.name !== "docker-smoke-renamed" || after.restartRequired !== true) process.exit(1);
if (JSON.stringify(after.hermesEndpoints) !== JSON.stringify(before.hermesEndpoints)) process.exit(1);
console.log(`rename response: HTTP 200 ${JSON.stringify(after)}`);
' "$SETTINGS_RESPONSE" "$RENAME_RESPONSE"

echo "==> restarting with the renamed host configuration"
docker restart "$NAME" >/dev/null
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = "30" ]; then echo "gateway did not recover after restart"; docker logs "$NAME"; exit 1; fi
  sleep 1
done
HEALTH_NAME="$(curl -fsS "http://127.0.0.1:$PORT/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).name))')"
if [ "$HEALTH_NAME" != "docker-smoke-renamed" ]; then echo "health did not retain renamed gateway"; exit 1; fi
RESTARTED_NAME="$(curl -fsS "http://127.0.0.1:$PORT/gateway/settings" \
  -H "authorization: Bearer $DEVICE_TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).name))')"
if [ "$RESTARTED_NAME" != "docker-smoke-renamed" ]; then echo "settings did not retain renamed gateway"; exit 1; fi
node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log(`host config after restart: ${JSON.stringify({ name: config.name, endpointIds: config.hermesEndpoints.map(endpoint => endpoint.id) })}`);
' "$CONFIG_PATH"

echo "==> smoke passed"

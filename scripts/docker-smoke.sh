#!/usr/bin/env bash
# Build the gateway image and prove its explicit Hermes-config package/start/health/pair path. This
# deliberately does not embed a fake Hermes or echo runtime; attach-v1 conformance covers that seam.
set -euo pipefail

IMAGE="cozygateway:smoke"
NAME="cozygateway-smoke-$$"
PORT=18787
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
CONFIG_PATH="$TMP_DIR/cozygateway.config.json"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat >"$CONFIG_PATH" <<'JSON'
{
  "name": "docker-smoke",
  "host": "0.0.0.0",
  "port": 8787,
  "dbPath": "/data/cozygateway.db",
  "hermes": {
    "url": "ws://127.0.0.1:1/api/ws",
    "tokenEnv": "SMOKE_HERMES_TOKEN",
    "profiles": {
      "smoke": { "tokenEnv": "SMOKE_ATTACH_TOKEN", "name": "Smoke" }
    }
  }
}
JSON

echo "==> building gateway image"
docker build -f "$ROOT/packages/gateway/Dockerfile" -t "$IMAGE" "$ROOT"

echo "==> running container"
docker run -d --name "$NAME" -p "$PORT:8787" \
  -v "$CONFIG_PATH:/config/cozygateway.config.json:ro" \
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
PAIR_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/pair" \
  -H 'content-type: application/json' \
  --data "{\"setupCode\":\"$SETUP_CODE\",\"deviceName\":\"docker-smoke\"}")"
if [ "$PAIR_STATUS" != "200" ]; then echo "pair redemption failed: HTTP $PAIR_STATUS"; docker logs "$NAME"; exit 1; fi

echo "==> smoke passed"

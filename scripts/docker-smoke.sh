#!/usr/bin/env bash
# Build the gateway image, run it with the baked mock config, and drive a full pair/send/observe
# round trip against the reference echo backend INSIDE the container. No LLM, no external services.
set -euo pipefail

IMAGE="cozygateway:smoke"
NAME="cozygateway-smoke-$$"
PORT=18787
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> building gateway image"
docker build -f "$ROOT/packages/gateway/Dockerfile" -t "$IMAGE" "$ROOT"

echo "==> running container"
docker run -d --name "$NAME" -p "$PORT:8787" -e COZYGATEWAY_HOST=0.0.0.0 "$IMAGE" >/dev/null

echo "==> waiting for /health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = "30" ]; then echo "gateway did not become healthy"; docker logs "$NAME"; exit 1; fi
  sleep 1
done

echo "==> minting a setup code inside the container"
# Capture the full pair output first, then take the first line locally. Piping the docker exec
# straight into `head -1` makes head close the pipe after one line; any further CLI output then
# hits SIGPIPE, and under `set -o pipefail` the 141 kills the whole smoke (seen on Linux CI).
PAIR_OUTPUT="$(docker exec "$NAME" node dist/cli.js pair --config /app/cozygateway.config.json)"
PAIR_JSON="$(printf '%s\n' "$PAIR_OUTPUT" | head -1)"
SETUP_CODE="$(printf '%s' "$PAIR_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).setupCode))")"
if [ -z "$SETUP_CODE" ]; then echo "failed to mint a setup code"; docker logs "$NAME"; exit 1; fi

echo "==> driving pair/send/observe"
SMOKE_GATEWAY_URL="http://127.0.0.1:$PORT" SMOKE_SETUP_CODE="$SETUP_CODE" \
  node "$ROOT/packages/gateway/scripts/smoke-driver.mjs"

echo "==> smoke passed"

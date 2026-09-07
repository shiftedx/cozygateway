#!/usr/bin/env bash
# What of the TB1 burner bed is up right now.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
. ./env.sh

echo "== burner gateway =="
curl -fsS -m 5 "$TB1_GATEWAY/ready" 2>/dev/null \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("ready:",d["ready"],"| hermes bridge:",d["bridges"]["hermes"],"| attach:",d["attach"]["configured"],"configured",d["attach"]["online"],"online")' \
  || echo "  not answering on $TB1_GATEWAY"

echo "== bots =="
TOK="$(tb1_device_token 2>/dev/null)" || TOK=""
if [ -n "$TOK" ]; then
  curl -fsS -m 5 -H "authorization: Bearer $TOK" "$TB1_GATEWAY/bots" 2>/dev/null \
    | python3 -c 'import json,sys;[print("  ",b["name"],b.get("runtime","hermes"),b["syncState"]) for b in json.load(sys.stdin)["bots"]]' \
    || echo "  could not list bots"
  echo "== runners =="
  curl -fsS -m 5 -H "authorization: Bearer $TOK" "$TB1_GATEWAY/runners" 2>/dev/null \
    | python3 -c 'import json,sys;[print("  ",r["name"],"online" if r["online"] else "offline",r["botCount"],"bots") for r in json.load(sys.stdin)["runners"]]' \
    || echo "  could not list runners"
else
  echo "  no device token in \$TB1_SCRATCH/tokens/validation-device.json"
fi

echo "== burner processes =="
pgrep -f -- "--profile burnerhermes" >/dev/null 2>&1 \
  && pgrep -fl -- "--profile burnerhermes" | sed 's/^/   /' || echo "   no burner Hermes profile gateway"
lsof -nP -iTCP:"$TB1_DASHBOARD_PORT" -sTCP:LISTEN >/dev/null 2>&1 \
  && echo "   burner dashboard listening on $TB1_DASHBOARD_PORT" || echo "   no burner dashboard"
[ -n "$(tb1_runner_pids)" ] \
  && echo "   burner CozyAgents runner up" || echo "   no burner CozyAgents runner"

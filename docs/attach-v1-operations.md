# Operating attach-v1

## Gateway configuration

Classic attach agents keep their existing config. The gateway serves both `/attach` and
`/attach/v1`; the plugin selects its version.

For native Bot Mode, keep the `hermes` Dashboard bridge configured for management and add a
per-profile gate:

```json
{
  "hermes": {
    "url": "ws://hermes:8790/api/ws",
    "tokenEnv": "HERMES_DASHBOARD_TOKEN",
    "nativeDataPlane": {
      "sage": {
        "tokenEnv": "SAGE_ATTACH_TOKEN",
        "mode": "shadow",
        "features": {
          "media": true,
          "tools": true,
          "interactions": true,
          "clarify": true,
          "scheduled": true
        }
      }
    }
  }
}
```

Set every named environment variable in the gateway service. Tokens must be non-empty and unique;
startup fails closed on a missing or colliding token. Promote one bot at a time by changing
`shadow` to `native` and restarting the gateway. Roll back by removing the entry or returning it to
`shadow`; do not run two authoritative chat planes for one bot.

Each feature gate is independently reversible. Omit `features` (or any individual field) for the
backward-compatible enabled default. The gateway intersects these gates with the plugin's hello
offer, refuses disabled event/command routing, and returns 403 from the media side channel when
media is disabled. Scheduled delivery accepts only the durable canonical Bot Chat session minted
by the gateway for that profile.

## Plugin environment

```sh
COZYGATEWAY_URL=https://gateway.example
COZYGATEWAY_TOKEN=<same per-profile token>
COZYGATEWAY_ATTACH_VERSION=1
COZYGATEWAY_SPOOL_PATH=/var/lib/hermes/cozygateway-attach-v1.sqlite
COZYGATEWAY_HOME_CHANNEL=thread
```

The spool directory must be writable and persistent across plugin/container restarts. Run exactly
one active plugin instance per token. The HTTP origin must be reachable for media even when the WS
is connected through a proxy; preserve `Authorization` and Range headers and allow `/attach/v1`
WebSocket upgrades.

## Deployment sequence

1. Deploy the gateway with schema changes and v0 compatibility first.
2. Deploy the v1-capable plugin with version still set to `0`; verify ordinary chat. CozyLabs'
   `integrations/hermes/attach` copy is lockstep vendored: after this cozygateway change has a
   commit, re-vendor the complete plugin directory and record that exact cozygateway ref in the
   paired CozyLabs change. Never patch the vendored copy independently.
3. Set version `1` and configure a `shadow` bot. Verify hello, presence, ACK progress, replay after a
   forced reconnect, and spool growth returning to steady state.
4. Promote that bot to `native`. Verify text, interrupt, tool/approval/clarify (including restart
   recovery and expiry), one scheduled message/push across a forced retry, and media range download
   from a paired client.
5. Expand per bot. Retain `/attach` and the v0 plugin setting until every classic agent has migrated.

On recovery, preserve both the gateway SQLite database and plugin spool. Deleting either side's
journal destroys its dedupe/replay history and requires an operator reconciliation; it is not a
routine way to clear a stuck turn.

Monitor projection dead letters in `attach_event_inbox` (`dead_lettered_at`,
`projection_attempts`, `projection_error`). A transient failure retries automatically in process;
a dead letter is terminal/degraded operator work and blocks every later projection for that
identity, including after restart. Correct the cause, then release only the earliest dead letter
through the gateway's controlled `releaseProjectionDeadLetter` service seam; it retries the failed
event before any later sequence.

Monitor `attach_command_outbox.cancelled_at` and `cancel_reason` as well. If a plugin reconnects
without a capability needed by an already queued command, the gateway durably converts that row to
a `discard` tombstone. The plugin ACKs the sequence without invoking the unsupported action, and
compatible later commands continue normally instead of remaining head-of-line blocked.

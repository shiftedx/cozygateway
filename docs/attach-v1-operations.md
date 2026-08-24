# Operating Hermes attach-v1

The Hermes installer creates one native attach identity per selected Hermes
profile. Its gateway config keeps the local Dashboard control URL and uses the
profile map, not a parallel `agents[]` identity or `nativeDataPlane` rollout
entry:

```json
{
  "hermes": {
    "profiles": {
      "ops": { "tokenEnv": "COZYGATEWAY_ATTACH_TOKEN_OPS" }
    }
  }
}
```

Every profile gets a unique bearer token and a persistent spool at
`<profile-home>/plugin-data/cozygateway/attach-v1.sqlite`. Preserve that spool
and the gateway SQLite database during backups and recovery. Do not run two
plugin instances with the same token.

Tokens appear only in the selected profile `.env` and the gateway's mode-600
runtime env file. The attach plugin connects out to the local gateway over
loopback; it exposes no listener on a Hermes host.

Gateway transition diagnostics are JSON lines on stderr. They record connection,
presence, queue, terminal, and relay outcome transitions—not heartbeat traffic.
Identifiers are truncated SHA-256 values; tokens, message text, tool arguments,
and push payloads are never included.

Create or delete the profile with Hermes, then rerun the one-line installer;
its default `--profiles all` selection reconciles the current set. Use an
explicit `--profiles default,ops` only to narrow coverage. Do not hand-edit
token values into JSON or service units. Gateway health plus each Hermes
profile gateway status are the relevant operational checks.

## Local plugin deploy

Deploying a plugin change from a checkout by hand (`cp` the files, then
`launchctl kickstart -k`) restarts a profile's gateway process immediately,
which SIGTERMs whatever turn that process is mid-send on. Use
`scripts/deploy-plugin-local.sh` instead: it syncs
`integrations/attach-plugin/` into each profile's `plugins/cozygateway/` and
the global `~/.hermes/plugins/cozygateway/`, waits for the profile's attach-v1
spool to go quiet before restarting it, kickstarts the profile's launchd
gateway job, and verifies reconnect against `https://warm.cozylabs.ai/ready`.

```sh
# see the plan, change nothing
scripts/deploy-plugin-local.sh -n

# deploy the default profile set
scripts/deploy-plugin-local.sh

# deploy a subset
scripts/deploy-plugin-local.sh cleo night-owl
```

It refuses to run if it finds a `*.pre-*` backup directory inside any
`plugins/` dir it is about to touch. Hermes loads any dir under `plugins/`
that contains a matching `plugin.yaml`, picked by scan-order, so a leftover
backup with the same manifest `name:` can silently shadow the real plugin
across every restart. Keep backups outside `plugins/`. The script's header
comment documents the quiescence heuristic (spool sequence quiet-window
polling) and its known false-quiet / false-busy limits in detail.

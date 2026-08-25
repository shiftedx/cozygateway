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

## Blank slate bots

A bot created through `POST /bots` starts as a **blank slate**: two toolsets,
and permission to ask for the rest. The gateway seeds the profile Hermes just
created, through the same profile-aware Dashboard config surface the model
routes use (`PUT /api/config?profile=<name>`, which deep-merges):

```yaml
platform_toolsets:
  cozygateway: [file, terminal]
  cli: [file, terminal]
approvals:
  mode: manual
```

**Why write anything at all.** A fresh Hermes profile with no
`platform_toolsets` entry does not get a small toolset, it gets the platform's
broad default composite: `_get_platform_tools` falls through to
`PLATFORMS[platform]["default_toolset"]` when the key is missing. A blank
config file is the opposite of a blank slate. Naming configurable toolset keys
flips the resolver's `has_explicit_config` branch, and that branch resolves to
exactly the names listed, with no default re-expansion.

**Why two platforms.** `cozygateway` is the platform the attach plugin
registers, so it covers every turn that comes from the phone. `cli` covers a
cron job or a terminal session on the box, which resolve under their own
platform key and would otherwise fall through to the broad default. Seeding one
without the other gives you a bot that is blank on the phone and fully armed
from cron.

**Why not `agent.disabled_toolsets`.** Hermes' own Blank Slate install adds a
second layer there, listing every toolset except the two it keeps.
`_get_platform_tools` subtracts that list LAST, after `platform_toolsets`, so a
toolset named there cannot be switched back on from the Toolsets UI at all
(upstream issue #49995; `save_platform_toolsets` now reconciles the two, but
only for toolsets re-enabled through that one code path and only for the
platform being saved). A floor whose defining feature is that raising it fights
back is not an earn-a-tool product, so the seed uses the `platform_toolsets`
allowlist alone. The known cost, stated rather than hidden: the resolver still
runs its "recover non-configurable platform toolsets" pass under an explicit
list, so a toolset that is not in `CONFIGURABLE_TOOLSETS` but whose tools live
inside the platform composite can reappear. A slightly leaky floor a user can
raise beats an airtight one they cannot.

**The earn-a-tool loop.** `approvals.mode: manual` is what makes the floor a
starting point instead of a ceiling. The bot runs `hermes tools` or `hermes mcp`
through its terminal tool, that raises a `surface="gateway"` approval, the attach
plugin forwards it (`ANSWERABLE_APPROVAL_SURFACES`), and the app draws a card the
user taps. Under `smart` an auxiliary LLM answers first and the hook fires with
`surface="smart"`, which the plugin deliberately does not forward: the request
the user was supposed to grant would be decided without them.

**Inherited MCP servers.** A new profile arrives carrying a copy of the launch
profile's `mcp_servers` definitions, and a server with no `enabled` flag reads as
ON (`_parse_enabled_flag(..., default=True)`). The seed writes
`enabled: false` for each inherited server that has no explicit flag yet, which
is the same key `enabled_mcp_server_names` reads. Note this is NOT the
`PATCH /bots/:name/profile` path: that one writes the per-server `disabled` key,
which only `profiles.describe` reads, and is reported as runtime-inert for
exactly that reason.

### Choosing tools at creation time

`POST /bots` accepts two optional additive lists (capability 33):

```json
{ "name": "night-owl", "toolsets": ["web", "memory"], "mcpServers": ["github"] }
```

They are granted ON TOP of the floor, never instead of it: `file` and `terminal`
are always in the written list, because a bot that cannot read a file or run a
command cannot ask for anything else. A toolset name Hermes does not report for
that profile, or an MCP server the profile's own config does not define, is
skipped and named back in the reply's `warnings` array. A skipped name never
fails the create.

Because both request fields are optional and the request schema is not closed, a
gateway older than capability 33 accepts them and ignores them silently. A client
that offers the picker should gate it on `com.cozylabs.bots >= 33`.

### Turning it off

```json
{ "hermes": { "seedBlankSlateBots": false } }
```

Default `true`. With it off, a created profile keeps Hermes' broad platform
defaults and the gateway writes nothing, not even the config read. An explicit
`toolsets` / `mcpServers` selection is still honoured with the flag off: that is
the user saying what this bot should have, and no gateway default overrules it.
What the flag off does drop is the parts nobody asked for, the approval mode and
the quieting of inherited MCP servers.

**Idempotency.** The seed reads the profile config first and writes only keys
that are absent. A retried create, or a second pass over a profile a user has
since armed, is a no-op rather than a demotion back to two toolsets. A failed
seed never fails the create: the bot exists, the failure is logged, and the reply
carries a warning.

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

# Operating Hermes attach-v1

The Hermes installer creates one native attach identity per selected Hermes
profile. Its gateway config keeps the local Dashboard control URL and uses the
profile map, not a parallel `agents[]` identity or `nativeDataPlane` rollout
entry:

```json
{
  "hermesEndpoints": [{
    "id": "default",
    "profiles": {
      "ops": { "tokenEnv": "COZYGATEWAY_ATTACH_TOKEN_OPS" }
    }
  }]
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

A bot created through `POST /bots` starts as a **blank slate**: two toolsets, no
playbooks, and permission to ask for the rest. The gateway seeds the profile Hermes just
created, through the same profile-aware Dashboard config surface the model
routes use (`PUT /api/config?profile=<name>`, which deep-merges):

```yaml
platform_toolsets:
  cozygateway: [file, terminal]
  cli: [file, terminal]
approvals:
  mode: manual
skills:
  disabled: [<every skill this profile has, minus the floor>]
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

**Skills.** Skills (playbooks) are gated by a per-profile OFF-list:
`skills.disabled` in that profile's `config.yaml`, read by
`agent.skill_utils.get_disabled_skill_names` and by every consumer of
`tools/skills_tool.py::_find_all_skills`. There is no enabled allowlist anywhere
behind it, so a profile that names nothing has every installed skill ON. A fresh
profile arrives with a skills directory copied from the launch profile and no
`skills` stanza at all, which is why a brand-new bot's New Bot sheet used to
read "199 on". The floor has to be written down here too.

The catalog the OFF-list is derived from is that profile's own
`profiles.describe` reply, the same read the app's create sheet enumerates skills
with (`GET /bots/:name/profile` -> `mapProfileDescribe(...).skills`). Upstream
builds those rows by walking `<profile>/skills/**/SKILL.md` under that profile's
`HERMES_HOME`, so the names come out spelled exactly the way the runtime matches
them: verbatim, case-sensitive. If that read fails, the seed writes **no**
`skills` key at all rather than a partial guess, logs
`skills NOT seeded`, and returns a warning saying the bot starts with every
installed skill on. An empty catalog is treated the same way: upstream drops the
skills section wholesale on a bad read, so "no skills reported" is not proof a
profile has none.

Keep specific skills on with `hermesEndpoints[].blankSlateSkillsOn` (a list of skill names,
default `[]`):

```json
{ "hermesEndpoints": [{ "id": "default", "blankSlateSkillsOn": ["tdd", "brainstorming"], "url": "ws://127.0.0.1:9119/api/ws", "profiles": { "ops": { "tokenEnv": "COZYGATEWAY_ATTACH_TOKEN_OPS" } } }] }
```

Default empty on purpose. Autonomy rides on the toolset floor, not on playbooks:
`file` + `terminal` are what let the bot run `hermes skills` and ask for one, and
a skill is then one approval away through the same earn-a-tool loop, or one tap
away in the app's searchable skills picker. Unlike toolsets and MCP servers, the
skills path is runtime-effective end to end:
`PATCH /bots/:name/profile disabledSkills` -> `profiles.configure
disabled_skills` -> this same `skills.disabled` key, replace-whole. A name in the
floor that the profile does not actually have is not invented into either list.

**Ordering, and why a user's choice still wins.** The seed runs inside
`POST /bots`, before the create response is assembled. The app's create sheet
then PATCHes the bot it just got back, and that patch is a diff against the
baseline the sheet loaded: `disabledSkills` is absent unless the user actually
touched the skills section. So an untouched create keeps the floor the seed
wrote, and an explicit selection lands on top of it and wins wholesale, because
`disabled_skills` is replace-whole. There is deliberately no `skills` field on
`POST /bots`: the PATCH already covers it.

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
{ "hermesEndpoints": [{ "id": "default", "seedBlankSlateBots": false, "url": "ws://127.0.0.1:9119/api/ws", "profiles": { "ops": { "tokenEnv": "COZYGATEWAY_ATTACH_TOKEN_OPS" } } }] }
```

Default `true`. With it off, a created profile keeps Hermes' broad platform
defaults and the gateway writes nothing, not even the config read. An explicit
`toolsets` / `mcpServers` selection is still honoured with the flag off: that is
the user saying what this bot should have, and no gateway default overrules it.
What the flag off does drop is the parts nobody asked for: the approval mode, the
quieting of inherited MCP servers, and the skills OFF-list. Skills mirror the
toolset floor exactly there. With the flag off the bot keeps Hermes' own default,
which for skills means every installed one on, and `blankSlateSkillsOn` is not
read at all.

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

### Coordinated matched-version rollout

Gateway and plugin release versions must match. The canonical installer is the
preferred upgrade path: it resolves one checksum-verified release and installs
both sides from that release. Capability negotiation does not make arbitrary
mixed versions a safe rolling-upgrade pair. The old v0.4.3 Gateway rejects a
hello capability it does not know, and tagged v0.5.2 rejects the divergent
capability offer from its prerelease plugin. The intersection exists only after
both peers have accepted the hello.

For a manual production rollout, prepare everything before disturbing either
live side:

1. Resolve one exact release tag and pre-stage its Gateway image or binary and
   its matching plugin source. Confirm both embedded versions agree.
2. Capture rollback copies of the current Gateway revision or image, Gateway
   config, provisioner payload, and installed plugin tree. Store plugin backups
   outside every `plugins/` directory so Hermes cannot scan a duplicate manifest.
   Preserve the Gateway database and each profile's attach spool.
3. Migrate the Gateway config for the target release and validate the staged
   config with that release before restart. Resolve stale configured profiles;
   final health requires every configured attach identity to be online.
4. Run the supported plugin plan without changing the live install:

   ```sh
   scripts/deploy-plugin-local.sh -n
   ```

5. Begin a bounded maintenance window after active work and spools are quiet.
   Cut over the pre-staged Gateway and immediately install the clean matching
   plugin with `scripts/deploy-plugin-local.sh`. Refresh the staged provisioner
   from the same release when automatic provisioning is enabled. Do not wait for
   or route work through either mixed-version intermediate: it may truthfully be
   unavailable until both ends have switched.

Only after the coordinated cutover, use the configured public or local origin
to verify process health and delivery readiness:

```sh
curl -fsS "$GATEWAY_URL/health"
curl -fsS "$GATEWAY_URL/ready"
```

The health response must report the released Gateway version,
`capabilities["com.cozylabs.bots"]` at `42` or later, equal
`attach.configured` and `attach.online`, and zero `attach.degraded`,
`attach.absent`, and `attach.deadLetters`. `/ready` must answer `200` with
`ready: true`. Confirm the final `hello_ack` negotiation includes
`memory_management` and `memory_setup` before using capability-42 setup. If the
capability is missing or setup returns the bounded unavailable error, the
cutover is incomplete: stop sending work, correct or roll back the matched pair,
and repeat the checks. Do not retry the mutation until `memory_setup` has
negotiated.

Rollback is coordinated too. Restore the captured config before starting the
captured Gateway revision or image, restore the captured plugin tree with no
duplicate manifests left under `plugins/`, restore the captured provisioner
payload when applicable, and restart both sides inside the same maintenance
window. Re-run the health, readiness, attach-count, dead-letter, queue, and
negotiated-capability checks before ending maintenance.

## Automatic bot provisioning

`POST /bots` creates a Hermes profile and a roster row. Neither makes the bot
reachable. Chat rides a native attach binding with three halves, and until all
three exist the new bot is a name in a list nobody can talk to (issue #183):

1. **The gateway must know the profile.** `NativeBotDataPlane`'s native-bot set
   is built at BOOT from `hermes.profiles` in the mounted config, and each entry
   names a `tokenEnv` whose variable has to exist in the box's `.env`.
2. **The Mac must have the plugin.** `~/.hermes/profiles/<p>/plugins/cozygateway`
   has to hold the attach plugin, and the profile's own `.env` has to carry that
   profile's `COZYGATEWAY_TOKEN`, `COZYGATEWAY_URL` and a `COZYGATEWAY_SPOOL_PATH`
   pointing inside that profile.
3. **The profile needs its own gateway process.** `ai.hermes.gateway-<p>` is what
   dials the attach stream. No process, no stream.

The gateway seed writes the profile's half of (2) at create time: every new
profile gets `plugins.enabled: [cozygateway]` (see
`packages/gateway/src/hermes-bridge/blank-slate-seed.ts`). That stanza is the
profile saying it wants the phone surface. The rest is Mac-side and box-side
work, which is what these two scripts do.

### One profile, by hand

```bash
scripts/provision-bot.sh -n provcheck   # see the plan, change nothing
scripts/provision-bot.sh provcheck      # do it
```

It is idempotent: every step checks real state first, so a re-run is a no-op and
a run that died halfway is repaired by the next one. It ends by waiting for the
box log to show an attach hello for the profile, so a green exit means the bot
really is connected, not merely configured.

### The watcher

`scripts/bot-provisioner-watch.sh` is one sweep: it provisions every profile
that has opted in but is not yet wired, and leaves everything else alone.
`docs/ai.cozylabs.bot-provisioner.plist` runs that sweep every 30 seconds, so a
bot created from the phone becomes chattable without anyone at a terminal.

The plist is a template and is NOT installed by default. Do not install it with
the checkout path: a macOS LaunchAgent is denied TCC access to `~/Documents`,
`~/Desktop`, and `~/Downloads` without an interactive privacy grant. That would
block both the watcher script and the provisioner's later read of
`integrations/attach-plugin`.

Instead, run the installer once from Terminal:

```bash
scripts/install-bot-provisioner.sh
```

It copies the watcher, provisioner, and attach-plugin source to
`~/Library/Application Support/cozylabs/provisioner`, points the LaunchAgent at
that self-contained payload, and reloads it in the current Aqua user session.
The staged payload is deliberately a snapshot: launchd cannot safely refresh it
from a protected checkout. Re-run the same command after every checkout update
that changes either provisioner script or `integrations/attach-plugin`; refresh
is atomic for future sweeps and the staged `STAGED_FROM` file records its source
revision.

To stop it: `launchctl bootout "gui/$(id -u)/ai.cozylabs.bot-provisioner"`.
The log is `~/Library/Logs/cozylabs-bot-provisioner.log`.

### What a fresh profile inherits, and why it has to be undone

A new Hermes profile arrives holding a COPY of the launch profile's `.env`. That
copy is the source of three traps the provisioner exists to defuse, all three
observed live while building it:

- **An attach token it did not mint.** Every bot created this way inherits the
  same one and would attach as the same identity. So the presence of a
  `COZYGATEWAY_TOKEN` proves nothing, and the box is treated as the authority:
  a profile the box already names keeps its token, and a profile it does not
  gets a freshly minted one.
- **A spool path pointing at the GLOBAL spool.** Two profiles that both kept it
  would read and acknowledge each other's events out of one file. It is
  rewritten to the profile's own path.
- **The launch profile's `DISCORD_BOT_TOKEN`.** Only one gateway may hold a
  Discord session. Two that claim it take it from each other with `--replace`
  handoffs that SIGTERM the loser, whose launchd job restarts it and takes it
  back, and every takeover tears down the attach adapter with it. Live, a new
  bot ping-ponged with `cleo` every ~30 seconds and both were unusable. Single
  holder credentials are blanked on first provisioning only.

### Gotchas

- **`hermes gateway install` is a no-op when the plist already exists**, so a
  profile whose service was booted out gets a cheerful "installed" and stays
  dead. The provisioner asserts the load with `launchctl print` and bootstraps
  the plist itself rather than trusting the installer's exit code.
- **Backups never go inside `plugins/`.** Hermes loads any directory there with
  a matching `plugin.yaml` name by scan-order luck, so a backup can silently win
  over the real plugin. The provisioner refuses to run when it finds one.
- **`docker compose up -d gateway`, not `--build`.** Only the env and the mounted
  config changed; a recreate re-reads both, and a rebuild is a deploy.
- **Never point this LaunchAgent at a protected checkout.** Terminal and launchd
  have different TCC identities. Re-run `scripts/install-bot-provisioner.sh`
  after relevant repo updates instead of teaching the background job to read
  `~/Documents`.

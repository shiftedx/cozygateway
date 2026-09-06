# ST1: phone-created Hermes bots stream by default

Branch `codex/st1-seed-streaming` in the cozygateway worktree, cut from `origin/main` at f3d70ef.
No Hermes core change, no wire change, no new capability row.

## What Hermes actually decides, traced first

`gateway/run_turn_runner.py::_setup_stream_consumer` asks the runner for stream deltas only when
`ctx.resolve_display_setting(user_config, platform_key, "streaming")` is true, and falls back to
the top-level `streaming.enabled` when that key is `None`. `gateway/config.py::StreamingConfig`
defaults `enabled` to false, and `gateway/display_config.py::_PLATFORM_DEFAULTS` has no
`cozygateway` entry, so a profile that names neither key resolves to silence and never emits a
`draft` frame. The attach plugin was ready the whole time:
`integrations/attach-plugin/cozygateway/adapter.py::supports_draft_streaming` answers true for
every chat type and `send_draft` is a full replace of the turn's live message.

`display.interim_assistant_messages` is deliberately NOT seeded: Hermes'
`hermes_cli/config_defaults.py::DEFAULT_CONFIG` already carries it as true, so writing it would
write down a default that is already the default. Verified in the Hermes checkout, not assumed.

## The exact YAML written

Into a new profile's `config.yaml`, as a deep merge beside `plugins`:

```yaml
display:
  streaming: true
  platforms:
    cozygateway:
      streaming: true
```

`display.platforms.cozygateway.streaming` is the key a phone turn resolves. `display.streaming` is
the same choice for a terminal session on that profile, so one bot does not behave two ways.

Only ABSENT keys are ever written, at the seed and at every repair. An explicit `false` is an
operator decision and stays false; that is the documented way to turn the default off.

## Files

- `packages/gateway/src/hermes-bridge/blank-slate-seed.ts`: `STREAMING_SEED`, `planStreamingDisplay`,
  and the `display` patch in `planBlankSlateSeed`. Written beside the plugin binding and NOT behind
  `seedBlankSlateBots`, for the same reason the binding is not: that flag is toolset policy, and
  how a reply is delivered is not a toolset. `BLANK_SLATE_SEED` now carries `display`, so the
  create test still asserts the whole seed as one value.
- `packages/gateway/test/bots-create-blank-slate.test.ts`: four new cases, plus four existing
  fixtures updated to the profile shape the current seed produces.
- `scripts/bot-provisioner-watch.sh`: `streaming_keys_absent` and a fourth wiring reason,
  `streaming is off in config.yaml`, so a wired but mute profile is picked up by the sweep.
- `scripts/provision-bot.sh`: `streaming_keys_absent` plus `ensure_streaming_config`, which writes
  the absent keys through Hermes' own `config set` and sets `STREAMING_CONFIG_CHANGED`. The restart
  flag handed to `ensure_service` is now `plugin changed OR config changed`, so a repaired profile
  is kickstarted exactly ONCE whichever moved.
- `scripts/agent-install.sh`: the same read and the same write for native installs, run once per
  selected profile after `enable_plugin`, recording the profile on the existing restart list so
  `ensure_hermes_gateways` restarts it once. `record_plugin_change`/`plugin_changed_for` renamed to
  `record_profile_change`/`profile_changed_for`, since the list is now "this gateway must come
  back", plugin or config.
- `scripts/test/plugin-rollout.test.sh`, `scripts/test/hermes-installer.test.sh`: coverage below.
- `docs/agent-install.md` (new "Bots stream by default" section) and `CHANGELOG.md` (Unreleased).

The read is structural in all three scripts (PyYAML, like the `plugins.enabled` read they already
do) because a grep cannot tell an absent key from one an operator set to false. The write is always
Hermes' own `config set`, so no script here owns a YAML writer.

## RED then GREEN

Seed, `pnpm --filter cozygateway` vitest on `test/bots-create-blank-slate.test.ts`:

- RED, new cases against the unchanged seed: `Tests 3 failed | 23 passed (26)`, each failing on
  `expected undefined to deeply equal { streaming: true, platforms: { cozygateway: ... } }`.
- After the seed change, before the existing fixtures were updated: `5 failed | 21 passed (26)`,
  the four new ones green and four "nothing more is written" fixtures now correctly seeing the
  display patch. Those fixtures were updated to profiles that already stream (and, for the
  already-tuned case, to an explicit `false`), which is the honest shape of "carries everything".
- GREEN: `Tests 26 passed (26)`.

Repair, `bash scripts/test/plugin-rollout.test.sh` (8 existing cases, 3 new, 11 total):

- RED, the three new cases run against the committed pre-change scripts:
  - `test_watcher_picks_up_a_wired_profile_that_cannot_stream`:
    `FAIL: expected .../stream.log to contain: pending: silent (streaming is off in config.yaml)`
    (the sweep logged nothing at all: a mute profile read as steady state).
  - `test_provisioner_turns_streaming_on_and_restarts_once`:
    `FAIL: expected .../stream-fix-hermes-calls to contain: -p silent config set display.streaming true`.
  - `test_provisioner_leaves_streaming_turned_off_on_purpose` passed vacuously before the change,
    as a guard test must: it is the case that would break if the repair ever wrote over a false.
- GREEN: `plugin rollout: ok`, all 11.

The streaming read in those tests is a REAL structural read: the fake venv python delegates the
`--streaming-keys` query to a PyYAML-capable interpreter found in a preflight (with the real HOME
handed back, since the cases fake HOME and a faked HOME hides user site-packages). The preflight
fails the suite loudly when no such interpreter exists rather than letting an unavailable parser
read as a pass.

Native install, `bash scripts/test/hermes-installer.test.sh`:

- RED, the new assertions run against the pre-change `agent-install.sh` (restored from the previous
  commit for the run, then put back):
  `FAIL  expected output to contain: streaming is already decided in config.yaml for Hermes profile active`,
  suite exit 1.
- GREEN: `hermes installer dry-run tests passed`.
- New assertions: a profile with an explicit `false` reports
  `streaming is already decided in config.yaml for Hermes profile active`; a profile whose config
  names neither key reports both `DRY set display.<key> to true for Hermes profile ops` lines. The
  three fixture profiles were given the shape the current seed produces so every other case in that
  long suite keeps testing what it was testing.

Types: `pnpm -r typecheck` under Node 24, all four projects `Done`. Per Kyle's ruling for this run,
the full `pnpm -r test` was not run; it is the lead's gate.

## Operator steps for the three existing profiles

`night-owl`, `polished-satellite` and `dewy-bayberry` are live bots and were NOT touched by this
work. Nothing under `<home>/.hermes` was modified. On the Mac that owns them:

1. Restage the provisioner from the cozygateway checkout, so the LaunchAgent runs the new sweep and
   provisioner rather than the staged copies from before this change:

   ```sh
   bash scripts/install-bot-provisioner.sh
   ```

2. See what the next sweep would do, without doing it:

   ```sh
   bash scripts/bot-provisioner-watch.sh --dry-run --log /tmp/cozy-sweep-dry.log
   grep pending /tmp/cozy-sweep-dry.log
   ```

   Each of the three should appear as `pending: <profile> (streaming is off in config.yaml)`.

3. Let the LaunchAgent's next tick run (30 seconds), or run one sweep by hand. Each profile gets
   both keys written and its `ai.hermes.gateway-<profile>` service kickstarted exactly once. The
   log is `<home>/Library/Logs/cozylabs-bot-provisioner.log`.

4. Confirm per profile:

   ```sh
   hermes -p <profile> config get --json display.platforms.cozygateway.streaming   # true
   hermes -p <profile> config get --json display.streaming                          # true
   ```

   Then send that bot one message from the phone and watch the reply build.

A native install repairs the same way with an ordinary installer rerun; the installer writes the
absent keys and restarts each repaired profile once, in the pass it already uses for a changed
plugin.

To keep one bot quiet, set both keys to `false` explicitly and restart it; neither the seed nor any
later sweep or rerun overrules an explicit value.

## Self-review and concerns

- `hermes config get` cannot be used for the "is it absent" question: `display.streaming` resolves
  through `DEFAULT_CONFIG` and answers `false` for an absent key, which is indistinguishable from
  an operator's `false`. That is why the read is a raw structural one and why `hermes config get`
  appears only in the operator verification steps above, where the resolved value is what matters.
- `agent-install.sh` needs an interpreter with PyYAML for the repair. It prefers the Hermes venv
  python (which always has it, since it is the interpreter Hermes itself runs under) and falls back
  to `python3` and `/usr/bin/python3`. If none can import yaml it prints a NOTE and leaves the
  profile alone rather than failing an install over a display default. `ponytail:` the ceiling is
  that a native install with a broken venv silently keeps the old behaviour; the upgrade path is a
  Hermes-side `config get --raw` (or a `--absent` exit code), which would remove the parser
  dependency from all three scripts at once.
- No live model run: the .121 endpoint is unavailable, so "the phone shows a live draft" is
  UNKNOWN here. What is proven is the config the runner reads, and the plugin's draft surface was
  read, not assumed. The reproducible check is step 4 above plus one phone message.

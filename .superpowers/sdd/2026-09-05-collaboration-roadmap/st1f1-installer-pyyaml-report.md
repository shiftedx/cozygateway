# ST1-F1: the streaming repair must not need PyYAML on the host

Branch `codex/st1f1-installer-pyyaml`, cut from `origin/main` at e0dccc8. Scripts and their tests
only: no TypeScript, no contract, no plugin, no Hermes change.

## The failure

Hosted CI (windows-installer job, run 34023124129) ran `scripts/test/hermes-installer.test.sh` and
died on `FAIL  no python3 with PyYAML on this host, and the installer needs one to read profile
config`. The runner has Python 3.11 without PyYAML. Two separate faults sat behind that one line:

- the two shell suites had a preflight that REQUIRED a PyYAML-capable interpreter and failed the
  run when there was none;
- the scripts themselves treated PyYAML as the only way to answer the question, so on such a host
  the repair could never run at all, even when the answer was obvious.

## The fix

One reader program, two modes, shared verbatim by `scripts/agent-install.sh`,
`scripts/provision-bot.sh` and `scripts/bot-provisioner-watch.sh`:

- PyYAML when the interpreter has it. `agent-install.sh::streaming_python` still tries Hermes' own
  `<hermes root>/hermes-agent/venv/bin/python` FIRST, and that one always has PyYAML because Hermes
  depends on it, so a real install keeps the exact answer it had. The candidate scan no longer
  filters on `import yaml`, only on being a usable python3.
- A conservative stdlib probe otherwise. It walks the block mapping by indentation and answers
  which of `display.streaming` and `display.platforms.cozygateway.streaming` the file certainly
  does not carry. It refuses to answer (which reads as "the keys are present", so nothing is
  written) for anything it cannot judge WHERE ONE OF THOSE KEYS COULD BE: a flow mapping, an
  anchor, an alias, a merge key, a sequence in the path, a line it cannot parse, and for a tab or a
  second document anywhere. A block scalar's body is skipped wholesale rather than read as
  structure. Everything outside `display` is skipped rather than judged, so a `runtime_footer`
  list or a `soul` block scalar costs nothing.

Being unsure now means writing nothing, which is the only safe direction: the repair can be
skipped, it can never overwrite an operator's setting and it can never fail an install.

`provision-bot.sh` lost its `die "no PyYAML available"` for this read (the reader no longer has a
"no parser" exit at all), and `agent-install.sh`'s note now says "no usable python found".

## Evidence that the two readers agree

Cross-checked with a real 981-line profile config (a COPY of `<home>/.hermes/profiles/cleo/config.yaml`
taken into the scratch directory; nothing under the Hermes home was written) plus 13 hand-written
shapes. Both readers give the same answer for every ordinary profile, including the real one and a
version of it with the cozygateway platform key removed. The only divergences are the three
deliberately unjudgeable shapes (a flow mapping at `display:`, a sequence where `platforms` would
be, a top-level `{}` document), where the stdlib probe answers "nothing absent" and PyYAML answers
precisely. That is the conservative direction by design.

## RED then GREEN

RED, reproducing the runner on macOS by hiding the user site-packages (`HOME` pointed at an empty
directory, which is what makes `/usr/bin/python3` PyYAML-free here):

- `HOME=<empty> bash scripts/test/plugin-rollout.test.sh`:
  `FAIL: no python3 with PyYAML on this host, and the provisioner needs one to read profile config`.
- `HOME=<empty> bash scripts/test/hermes-installer.test.sh`:
  `FAIL  no python3 with PyYAML on this host, and the installer needs one to read profile config`,
  `exit=1`. This is the hosted CI line verbatim.

GREEN, after the change:

- `bash scripts/test/plugin-rollout.test.sh`: `plugin rollout: ok` (14 cases, one new).
- `HOME=<empty> bash scripts/test/plugin-rollout.test.sh`: `plugin rollout: ok`, with the honest
  line `note: no PyYAML on this host, so the agreement half of the reader case did not run`.
- `bash scripts/test/hermes-installer.test.sh`: `hermes installer dry-run tests passed`, `exit=0`.
- `HOME=<empty> bash scripts/test/hermes-installer.test.sh`: same, `exit=0`.
- `pnpm test:installer` (the whole chain: windows-dual-state, bootstrap-transaction,
  bootstrap-runtime-rollback, attach-health-diagnosis, hermes-installer, harness-choice,
  bot-provisioner-installer, plugin-rollout): `exit=0`.
- `pnpm -r typecheck` under Node 24: 4 of 4 projects `Done`.

## How the tests now prove the no-PyYAML path

Both suites run the reader through an interpreter fixture that execs `python3 -S`. `-S` skips
site-packages, so PyYAML cannot be imported on ANY host, which makes the stdlib probe the path the
suites always exercise rather than whatever the machine happens to have installed. Each suite
asserts up front that `python3 -S -c 'import yaml'` really does fail, so the guarantee cannot rot
silently. Nothing macOS-only was added: `python3 -S`, `awk`, `sed` and `printf` are all available
under Git Bash.

The new case `test_streaming_reader_answers_without_pyyaml` in `plugin-rollout.test.sh` pins the
probe directly: a mute profile reports both keys, a streaming profile reports none, an explicit
`false` is never reported as absent, a profile with a telegram override and a `runtime_footer` list
reports only the cozygateway key, and a flow mapping reports nothing at all. When the host DOES
have PyYAML it then asserts the two readers give identical answers for the first four; when it does
not, it prints that the agreement half did not run rather than claiming a pass.

The fake `hermes` writer in that suite no longer needs a YAML library either: it rewrites the
`display` block from marker files with `awk` and `printf`, which is enough to prove the caller
reads the file back after a write.

## Concerns

- On a host with no PyYAML, a profile whose config uses a shape the probe will not judge is left
  unrepaired and says so. That is deliberate, and the production path (Hermes' venv python) is not
  affected. `ponytail:` the ceiling is a hand-rolled probe rather than a parser; the upgrade path is
  a Hermes-side raw config read (`config get --raw`, or a documented "key is absent" exit code),
  which would delete the probe and the PyYAML branch together.
- The tests deliberately cannot exercise the PyYAML branch on a runner without PyYAML. That branch
  is unchanged from the merged ST1 work and is what every real install uses; the suite reports when
  it could not run rather than counting it as covered.

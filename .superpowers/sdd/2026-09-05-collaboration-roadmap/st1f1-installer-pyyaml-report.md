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

## Fix round 1 (the three Windows-runner failures on PR #381)

Run 34037156600 got past the PyYAML preflight and then printed three `FAIL` lines. Only one of
them actually failed the job: the log's single `##[error] Process completed with exit code 1`
follows the streaming assertion at line 461. The other two are lines the suite prints and carries
on past, which is why the job was green with them before. All three are addressed.

### 1. `bootstrap recovery cannot restart an unsupported service platform`

Not ST1's, and not a test-guard question: `scripts/install.sh` has said this since cbc0129 and
neither ST1 (bbbd5fb8) nor ST1-F1 touched that file (`git diff 9698186e..bbbd5fb8 -- scripts/`
lists five files, install.sh is not one). `bootstrap_service_platform` knew only `Darwin` and
`Linux`, so on Git Bash (`uname -s` is `MINGW64_NT-...`) it died. The callers tolerate the failure,
so the run continues, which is exactly why this could sit in a green job printing a scary line.

Reproduced locally by putting a fake `uname` that answers `MINGW64_NT-10.0-22631` ahead of PATH and
running `scripts/install.sh` against a scratch home: `FAIL  bootstrap recovery cannot restart an
unsupported service platform`, twice.

Fixed in the product, because the guard was answering the wrong question. Git Bash IS a supported
host for this half of the install and has no POSIX service at all: persistence on Windows is the
current-user Scheduled Task the Windows bootstrap owns, which this script must never touch. So
`MINGW*|MSYS*|CYGWIN*|Windows*` is now the `Windows` platform, its service registration path is
empty (which every reader already treats as "nothing registered", so the transaction records
`service:absent:-`), and `restart_existing_owned_service`,
`remove_new_owned_service_registration` and `bootstrap_service_is_owned_or_absent` return early
instead of falling through to the systemd branch. Same fake-uname run after the fix: zero
occurrences of that message.

RED then GREEN: a new case at the end of `scripts/test/bootstrap-transaction.test.sh` (which
sources install.sh's helpers directly) sets `COZYGATEWAY_SERVICE_PLATFORM=MINGW64_NT-10.0-22631`
and asserts the platform, the empty path, the recorded absence and the no-op restart. Against the
previous install.sh: `FAIL  bootstrap recovery cannot restart an unsupported service platform`
then `FAIL: Git Bash is not recognised as a service platform`. After:
`bootstrap transaction tests passed`.

### 2. `line 403 exited 137: ... COZYGATEWAY_TEST_BOOTSTRAP_KILL_AFTER_PROMOTION=cozygateway.mjs`

Not a failure at all: that run is killed on purpose, mid-promotion, to prove the bootstrap
transaction recovers. The suite's own ERR trap printed it as a failure, and the same line prints on
a fully green macOS run (it is in the round-0 log of this packet, above a `hermes installer dry-run
tests passed`). Pre-existing, and a false alarm that costs a reader a round of chasing.

Fixed in the test: the ERR trap is lifted for exactly that command and restored straight after.
Written out inline rather than as a helper pair, because bash restores an ERR trap when a function
that changed it returns, so a helper clears nothing (verified before relying on it). A green
installer run now prints zero `FAIL` lines, where it printed one before.

### 3. `expected output to contain: set display.streaming to true for Hermes profile ops`

The real bug in our code, and the only one that failed the job. The runner's log shows the answer
in the wrapping: `DRY   set display.streaming` then a new line beginning ` to true for Hermes
profile ops`. A Windows interpreter translates `\n` into CRLF on a text stream, so every key the
reader printed reached the shell with a carriage return glued to it. The installer would have gone
on to run `hermes config set "display.streaming<CR>" true`, writing a key nobody can read back.

Not the interpreter selection, not `python3 -S`, not the stdlib probe, not path handling: those all
worked, as the same log shows (`streaming is already decided` for the two profiles that carry the
keys, and both keys named for the profile that does not).

Fixed twice over: the reader writes its answer through `sys.stdout.buffer` as bytes, which no
interpreter newline convention can touch, and each caller pipes the read through `tr -d '\r'` (all
three scripts run under `pipefail`, so a failing read still surfaces). RED then GREEN: the reader
case in `plugin-rollout.test.sh` gained an interpreter that ends every line the Windows way. Against
the previous reader: `FAIL: a carriage return from a Windows interpreter reached the caller`. After:
`plugin rollout: ok`.

### Tests

Every suite below was run twice, once normally and once with `HOME` pointed at an empty directory,
which hides the user site-packages and makes this machine PyYAML-free like the runner.

- `scripts/test/plugin-rollout.test.sh`: `plugin rollout: ok` both ways, 14 cases (one new).
- `scripts/test/hermes-installer.test.sh`: `hermes installer dry-run tests passed` both ways,
  `exit=0`, and now zero `FAIL` lines in the output.
- `scripts/test/bootstrap-transaction.test.sh`: `bootstrap transaction tests passed` both ways
  (one new case).
- `pnpm test:installer`, the whole chain: `exit=0`.
- `pnpm -r typecheck` under Node 24: 4 of 4 projects `Done`.

### Independent review r0, folded into this same round

Review verdict on 7295458 was FAIL on spec. Disposition of every finding:

- **C1 (Critical), fixed.** The probe called a wanted key ABSENT when its value was a nested block
  mapping: such a key line carries no value, so it opened a stack frame and was never recorded as
  present, while PyYAML reads a mapping there. The caller would then have run `config set` over an
  operator's tuned block and replaced it with a boolean, which is exactly the overwrite the
  conservative rule exists to prevent. Every mapping that has a key under it is now recorded, and a
  wanted key counts as present when anything was parsed inside it. A key with nothing under it at
  all stays absent, which is what PyYAML reads (`None`) and what a repair should fix, so the null
  repair is not lost.
  RED then GREEN at the reader (M4 below), and differentially: the reviewer's own fuzz harness,
  same seed 7, same 3243 comparable documents, went from 209 unsafe to **0 unsafe**; a second run
  at seed 4242 compared 3260 documents with **0 unsafe**; the reviewer's 64 hand-built shapes give
  **exact 48, conservative 16, unsafe 0** (was 2 unsafe, both C1).
- **I1 (Important), fixed** in the same change as the third CI failure above: the reader answers in
  UTF-8 bytes so no interpreter's newline convention can reach a key name, and each caller strips a
  carriage return at the boundary as well.
- **I2 (Important), narrowed rather than widened.** `provision-bot.sh` and `bot-provisioner-watch.sh`
  still require PyYAML for their pre-existing `plugins.enabled` read and still stop the run without
  it. That is deliberate and unchanged: those two are the dev-box provisioner, they run beside a
  Hermes venv that always has PyYAML, and "is this profile opted in" decides whether a bot is
  touched at all, which is not a question to answer conservatively from a partial parse. Both
  scripts now say so at that read, and the guarantee this packet makes is stated for what it is:
  the shipped installer, and the streaming keys, need no host PyYAML.
- **M1, fixed.** The merge-key test in the value branch could never fire (the key regex cannot
  match `<<`), and a `<<: *defaults` line is already caught by the unparsable-line branch. The dead
  condition is gone and the docstring says which branch actually handles it.
- **M2, fixed.** The config file is read with `encoding="utf-8"` rather than the locale's encoding.
- **M3, left alone as instructed.** `BOX_SSH` and `BOX_REPO` in `scripts/provision-bot.sh` carry an
  operator default; they are pre-existing at base e0dccc8, untouched by this packet, and consistent
  with the dev-box-only ruling for that script.
- **M4, fixed.** `test_streaming_reader_answers_without_pyyaml` gained the C1 shapes: a nested block
  under the platform key, a nested block under the top-level key, and a key with no value at all
  (which must still be reported absent). Against the pre-fix reader:
  `FAIL: stdlib probe called a nested block absent: display.platforms.cozygateway.streaming`.
  The agreement half now covers all seven shapes.

The reader remains byte identical in all three scripts (same md5 for the extracted body).

### Tests after the review fixes

Each suite run twice, normally and with `HOME` pointed at an empty directory (no PyYAML anywhere):

- `plugin-rollout.test.sh`: exit 0 both ways, 14 cases, zero `FAIL` lines.
- `hermes-installer.test.sh`: exit 0 both ways, zero `FAIL` lines.
- `bootstrap-transaction.test.sh`: exit 0 both ways.
- `pnpm test:installer`: exit 0.
- `pnpm -r typecheck` under Node 24: 4 of 4 `Done`.
- Differential against PyYAML: fuzz seed 7, 3243 comparable, 0 unsafe; fuzz seed 4242, 3260
  comparable, 0 unsafe; 64 hand-built shapes, 0 unsafe.

## Fix round 2 (re-review r1)

### C2 (Critical), fixed: a YAML tag in front of a block mapping

`elif value[:1] in ("{", "[", "&", "*"):` did not name `!`. A tagged block (`display: !!map`, or
`cozygateway: !!map`, with the mapping opening on the lines below) therefore read as an ordinary
scalar value: no frame was opened, the keys inside were walked past at the wrong path, and the
probe answered ABSENT where PyYAML answers present. That is C1's overwrite reached through a
different token. `!` is now in that set in all three scripts, so a tag on the way to a wanted key
ends the judgement and nothing is written.

A tagged SCALAR (`streaming: !!bool true`) still counts as present, which is what PyYAML reads.

Differential over a matrix of 16 comparable tagged shapes (tag at `display`, at `platforms`, at
`cozygateway`, and at both, for `!!map`, `!map`-style custom, `!!omap` and `!!set`):

- before: **12 unsafe** (every `!!map` / custom-tag / `!!omap` position, both keys or the platform
  key depending on where the tag sat)
- after: **0 unsafe**, every one of them conservative.

The earlier fuzz harnesses do not reach this shape (their generator only ever emits a tag as a leaf
value, never in front of a block), which is why it took an adversarial read to find. Rerun with
tags in the value list anyway: seed 7, 2475 comparable, **0 unsafe**; with tags also emitted in
front of blocks, seed 11, 2172 comparable, **0 unsafe**. The nested-block fuzz from round 1 still
answers 0 unsafe out of 3243 (seed 7) and 3260 (seed 4242).

RED then GREEN in the suite: `test_streaming_reader_answers_without_pyyaml` gained
`tagged-display`, `tagged-platform` and `tagged-scalar` fixtures, and the PyYAML agreement loop now
covers ten shapes. Against the previous reader:
`FAIL: stdlib probe called a tagged shape absent (tagged-display): display.streaming display.platforms.cozygateway.streaming`.

The reader stays byte identical across the three scripts: md5 `1aa0e9f10180cbfa0371c3888b27ae4d`
for the extracted body in `provision-bot.sh`, `bot-provisioner-watch.sh` and `agent-install.sh`.

### N1, fixed

This report said "15 cases" for `plugin-rollout.test.sh` in two places; it has 14. Corrected above.

### Tests after fix round 2

Each shell suite run twice, normally and with `HOME` pointed at an empty directory (no PyYAML
anywhere):

- `plugin-rollout.test.sh`: exit 0 both ways, 14 cases, zero `FAIL` lines.
- `hermes-installer.test.sh`: exit 0 both ways, zero `FAIL` lines.
- `bootstrap-transaction.test.sh`: exit 0 both ways.
- `pnpm test:installer`: exit 0.
- `pnpm -r typecheck` under Node 24: 4 of 4 `Done`.

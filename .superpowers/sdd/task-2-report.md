# Task 2 implementation report

## Status

Task 2 is implemented and verified on branch
`codex/windows-elevated-dashboard-recovery` from starting commit
`d2d4afc8e27e577e5787d6aa57fb79c73816e83c`.

Implementation commit:
`5b945ffb1e16ab7c7ef829e43685286bad823af6`
(`fix: elevate stale Dashboard recovery helper`).

## Red evidence

The Task 2 assertions were added before the production implementation. The
required focused command was then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
```

It exited `1` for the expected missing behavior:

```text
ASSERT: normal 43 followed by elevated 0 must continue: FAIL  Dashboard port 9119 is owned by a process this installer cannot safely stop
```

This proved that the existing wrapper treated helper exit `43` as the generic
ownership failure and did not request scoped elevation.

## Implementation

### `scripts/agent-install.sh`

- Added a protected generated Windows PowerShell 5.1 elevation wrapper at
  `dashboard-owner-elevate.ps1`.
- Kept the first ownership-helper invocation non-elevated.
- Mapped normal exit `0` to continue, `42` to the existing ownership-safety
  failure, `43` to exactly one scoped elevation attempt, and `45`/unexpected
  values to a verified-Dashboard recovery failure.
- Uses a PowerShell 5.1-compatible sterile launcher followed by a RunAs stage:
  the first `Start-Process powershell.exe -UseNewEnvironment -Wait -PassThru`
  strips inherited secrets, then the sterile process uses
  `Start-Process powershell.exe -Verb RunAs -Wait -PassThru`. Both stages use
  explicit argument arrays; the elevated child receives `-NoProfile`,
  `-NonInteractive`, `-ExecutionPolicy Bypass`, `-File`, helper path, expected
  root, Hermes executable, launcher, port, and `-ElevatedChild`.
- Preserved elevated helper exit codes and reserved `46` for UAC cancellation,
  denial, unavailability, or launch failure.
- Added a manual-close/rerun instruction for scoped-UAC launch failure and
  elevated metadata failure.
- Added the optional terminal elevated-child marker to the ownership helper;
  that helper never launches another process or requests elevation.

### `scripts/test/windows-bootstrap.test.ps1`

- Added a compiled `powershell.exe` double for deterministic Bash wrapper
  exit-code and invocation-count tests.
- Added a `Start-Process` double that records `RunAs`, `Wait`, `PassThru`, and
  the argument array, then launches a harmless Windows PowerShell 5.1 child to
  exercise real command-line parsing without showing UAC.
- Covered normal codes `0`, `42`, `43`, `45`, and unexpected values; elevated
  codes `0`, `42`, `43`, `45`, and unexpected values; and cancellation/launch
  failure.
- Asserted one normal helper call plus exactly one elevation-wrapper call only
  for normal `43`, with no retry after any elevated failure.

## Green verification

Fresh, bounded final runs used a 30-second per-test limit. Both completed well
inside the limit.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
```

Exit `0`:

```text
windows bootstrap tests passed
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-dashboard-owner.test.ps1
```

Exit `0`:

```text
windows dashboard ownership tests passed
```

Additional checks:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -n scripts/agent-install.sh
git diff --check
```

Both exited `0`. Git printed only its Windows LF-to-CRLF working-copy warning;
there were no syntax or whitespace errors.

## PowerShell 5.1 quoting and secret hygiene

The test fixtures use all four required values with spaces and apostrophes:

- expected root: `C:\Users\O'Brien\Hermes Root`
- Hermes executable: `C:\Users\O'Brien\Hermes Root\bin\hermes agent.exe`
- helper path: a temporary `O'Brien Cozy Gateway\dashboard owner.ps1`
- launcher: `C:\Users\O'Brien\Hermes Root\bin\hermes.exe`

The generated wrapper's argument array was flattened using the same command-line
shape as Windows PowerShell 5.1 `Start-Process`, then parsed by an actual
`powershell.exe` child. The child bound each path to its original distinct
parameter, received port `9119`, received `-ElevatedChild`, and had zero extra
or merged arguments.

The harness placed sentinel values in `DASHBOARD_SESSION_TOKEN` and
`PROVIDER_API_KEY`, captured shell arguments, `Start-Process` arguments, child
bindings, and diagnostic output, and asserted that neither sentinel appeared.
Production elevation arguments contain only paths, the Dashboard port, fixed
PowerShell switches, and the elevated-child marker.

## Files changed

- `scripts/agent-install.sh`
- `scripts/test/windows-bootstrap.test.ps1`
- `.superpowers/sdd/task-2-report.md` (this report, committed separately from
  the implementation so the report can record the implementation SHA)

No release-version source or release metadata was edited.

## Self-review

- Re-read the Task 2 brief and the approved design against the final diff.
- Confirmed normal `42`, `45`, and unexpected values never elevate.
- Confirmed only normal `43` reaches one elevation-wrapper invocation.
- Confirmed elevated `42`, `43`, `45`, and unexpected values fail without a
  second wrapper invocation.
- Confirmed the elevated helper independently reacquires and validates the
  listener through Task 1's unchanged helper behavior; no PID or ownership
  result crosses the elevation boundary.
- Confirmed the wrapper uses the exact required `RunAs`, `Wait`, and `PassThru`
  flags and forwards the elevated child's exit code.
- Confirmed UAC/launch failure is caught and maps to a scoped-helper,
  manual-close, rerun instruction.
- Confirmed no environment secret is read, copied into arguments, or logged by
  production elevation code.
- Confirmed Bash syntax, PowerShell 5.1 parsing, diff hygiene, and changed-file
  scope.
- No Critical, Important, or minor correctness findings remained.

## Concerns and validation boundary

The deterministic harness validates invocation construction, PS5.1 parsing,
one-shot behavior, cancellation mapping, and secret hygiene without presenting
a real UAC prompt. Approval of an actual UAC prompt against a real
higher-integrity stale Hermes Dashboard remains the Task 3/host acceptance
boundary described by the approved design.

## Task 2 review fixes

### Findings addressed

- The original RunAs launch inherited the installer's complete environment.
  The generated elevation flow now uses two PowerShell 5.1-compatible stages
  because `-UseNewEnvironment` and `-Verb RunAs` belong to different
  `Start-Process` parameter sets in Windows PowerShell 5.1. The first stage
  starts from the default environment with `-UseNewEnvironment`; only that
  sterile stage requests RunAs for the ownership helper.
- Root, Hermes executable, launcher, owner-helper path, RunAs-helper path, and
  port remain explicit process arguments. No provider/session credential is
  copied into either argument list or reconstructed in the sterile process.
- Test fixture controls are embedded in generated harness scripts or passed as
  file paths/arguments. They do not rely on environment variables that
  `-UseNewEnvironment` is expected to remove.
- A real compiled child process now records its environment after the generated
  sterile wrapper requests `-UseNewEnvironment`; sentinel
  `DASHBOARD_SESSION_TOKEN` and `PROVIDER_API_KEY` values are both absent.
- `write_dashboard_elevation_helper` has an internal Windows guard, and `main`
  invokes it only behind `is_windows &&`, so neither generated elevation file
  is written on macOS or Linux.

### Review-fix RED evidence

After replacing inherited test controls with explicit scripts/files and adding
the actual-child environment assertions, this command exited `1`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
```

Expected security failure:

```text
ASSERT: actual child process must not inherit the Dashboard session token
```

After shaping the final two-stage regression, the same command remained red
against the old implementation:

```text
ASSERT: shared installer must generate a sterile-context RunAs wrapper
```

### Review-fix GREEN evidence

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
```

Exit `0`:

```text
windows bootstrap tests passed
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-dashboard-owner.test.ps1
```

Exit `0`:

```text
windows dashboard ownership tests passed
```

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -n scripts/agent-install.sh
git diff --check
```

Both exited `0` with no syntax or whitespace errors. Git emitted only its
working-copy LF-to-CRLF warning.

### Review-fix self-review and concerns

- Confirmed normal exit `43` still causes exactly one scoped recovery attempt;
  no elevated failure recurses.
- Confirmed the sterile stage uses `-UseNewEnvironment` without `-Verb`, while
  the following sterile-context stage uses `-Verb RunAs`; this avoids the
  Windows PowerShell 5.1 ambiguous-parameter-set failure.
- Confirmed the final elevated ownership helper receives all required values as
  distinct arguments under Windows PowerShell 5.1 parsing.
- Confirmed sentinel provider/session secrets are absent in an actual child
  process, not merely absent from argument and diagnostic captures.
- Confirmed no release-version source was edited.
- This host's Windows PowerShell 5.1 reports managed-loader error `8009001d`
  when `powershell.exe` itself is launched directly with a default environment.
  The regression therefore executes the generated sterile wrapper with a
  `Start-Process` capture and a real compiled environment-probe child. A real
  UAC-approved end-to-end run on the target host remains the acceptance
  boundary; launch failure continues to fail closed with manual recovery
  instructions.

## Task 2 clarified re-review fixes

This section supersedes the rejected two-stage `-UseNewEnvironment` design and
its validation boundary above.

### Clarified design implemented

- Removed the generated `dashboard-owner-runas.ps1` stage and every use of
  `-UseNewEnvironment`.
- The already-loaded non-elevated wrapper captures the absolute Windows
  PowerShell executable path from `$PSHOME` before changing its environment.
- It snapshots every Process-scope environment entry, removes every current
  entry, and restores only the documented launch allowlist: `SystemRoot`,
  `WINDIR`, `COMSPEC`, `TEMP`, and `TMP`. It does not preserve `PATH` or read
  User/Machine-scope environment blocks.
- It makes exactly one `Start-Process` call using the captured full executable
  path with `-Verb RunAs -Wait -PassThru` and the existing explicit non-secret
  helper arguments.
- A `finally` block clears the temporary launch block and restores the exact
  original Process environment after child success, child failure, or launch
  exception. Restoration uses the already-loaded .NET Framework internal
  Win32 environment setter so an originally present empty-valued entry remains
  present rather than being converted into a missing entry by
  `Environment.SetEnvironmentVariable`.
- Launch/loader exceptions and UAC cancellation map to helper exit `46` and the
  existing manual-recovery path. The elevation-helper writer retains its
  internal Windows guard, and `main` invokes it only on Windows.

### Clarified re-review RED evidence

The new regression was first run against commit `72a7657`, before changing the
two-stage implementation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
```

Exit `1`:

```text
ASSERT: shared installer must not generate a second PowerShell elevation stage
```

This demonstrates that the regression rejects the prior
`-UseNewEnvironment`/second-wrapper implementation.

### Clarified re-review GREEN evidence

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
```

Exit `0`:

```text
windows bootstrap tests passed
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-dashboard-owner.test.ps1
```

Exit `0`:

```text
windows dashboard ownership tests passed
```

The default `bash` command on this Windows host routes through an unavailable
WSL `/bin/bash` and exited `1` with `execvpe(/bin/bash) failed`. The required
syntax check was therefore run with the installed native Git Bash executable:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -n scripts/agent-install.sh
```

Exit `0`, no output.

```powershell
git diff --check
```

Exit `0`; Git emitted only LF-to-CRLF working-copy warnings and reported no
whitespace errors.

### Regression coverage and secret hygiene

- The harness places `DASHBOARD_SESSION_TOKEN`, `PROVIDER_API_KEY`, and the
  unrelated `TASK2_REVIEW_ARBITRARY_SECRET` sentinel in Process scope.
- Under the same sanitized block captured at the production `RunAs` boundary,
  the test double launches the exact full-path `powershell.exe` without UAC.
  That real Windows PowerShell process loads successfully, binds root, Hermes,
  launcher, helper, port, and `-ElevatedChild` correctly despite spaces and
  apostrophes, receives no extra arguments, and sees none of the three
  sentinels.
- Fixture controls are embedded in generated scripts or passed through files
  and arguments; none depend on inherited environment values.
- The old compiled environment-probe substitution was removed. The generated
  owner-helper fixture itself runs in the real PowerShell child and records its
  bindings and environment.
- Static assertions require production to enumerate and clear all current
  Process entries, reject a known-secret denylist, reject User/Machine
  environment reads, reject `UseNewEnvironment`, and retain the Windows-only
  guard. No persistent User/Machine environment was mutated by the tests.
- Captures prove exactly one `Start-Process` call, the full executable path,
  `RunAs`/`Wait`/`PassThru`, the documented allowlist only, and explicit
  non-secret arguments.
- Full before/after Process-environment snapshots prove exact restoration after
  success, each propagated helper result (`42`, `43`, `45`, and `99`), and a
  simulated launch exception that maps to `46`.

### Clarified re-review self-review

- Rechecked the final diff against every clarified finding and the original
  Task 2 scope. Only `scripts/agent-install.sh`,
  `scripts/test/windows-bootstrap.test.ps1`, and this report changed.
- Confirmed there is no generated second-stage helper, no
  `UseNewEnvironment`, no retained `PATH`, and no User/Machine environment
  reconstruction.
- Confirmed the wrapper is already loaded before sanitization and invokes one
  full-path Windows PowerShell process at the UAC boundary.
- Confirmed all required paths remain explicit arguments and pass Windows
  PowerShell 5.1 quoting tests with spaces and apostrophes.
- Confirmed all Process variables are removed generically, sentinel secrets
  are absent inside the actual child, and the wrapper's exact environment is
  restored in `finally` on success and exception.
- Confirmed helper exit propagation, launch-exception mapping to `46`, Bash
  syntax, both Windows suites, diff hygiene, and no release-version edits.
- No Critical, Important, or minor correctness findings remain.

### Clarified re-review concern

The deterministic regression exercises the exact production sanitization and a
real full-path Windows PowerShell 5.1 child, but substitutes the UAC operation
itself to avoid an interactive elevation prompt. A real approved UAC launch
against a higher-integrity stale Dashboard remains the host acceptance boundary.

Clarified re-review implementation commit: `4c2c99a`.

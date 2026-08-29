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
- Used `Start-Process powershell.exe -Verb RunAs -Wait -PassThru` with an
  explicit argument array containing `-NoProfile`, `-NonInteractive`,
  `-ExecutionPolicy Bypass`, `-File`, helper path, expected root, Hermes
  executable, launcher, port, and `-ElevatedChild`.
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

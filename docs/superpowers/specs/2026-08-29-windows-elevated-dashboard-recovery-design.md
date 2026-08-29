# Windows elevated Hermes Dashboard recovery design

## Problem

CozyGateway v0.3.9 cannot recover a stale Hermes Dashboard when Windows hides
the listener process's `ExecutablePath` and `CommandLine` from the normal,
non-elevated installer. The generated ownership helper treats missing metadata
the same as a conclusive foreign-process mismatch and exits with the generic
"cannot safely stop" error.

The reported host has a healthy Hermes Dashboard on `127.0.0.1:9119`, a stale
session token, four live `python.exe` ancestors ending in `hermes.exe`, and the
same Windows user/session throughout. Non-elevated CIM, WMI, and `Get-Process`
can read names, PIDs, parent PIDs, session, and owner, but not image paths or
command lines. A non-elevated process also cannot reliably terminate this
higher-integrity process tree.

## Goal

Allow the one-paste Windows installer to recover this specific
higher-integrity stale-Dashboard state with one narrowly scoped UAC prompt,
while preserving the v0.3.9 rule that a port, process name, owner, or HTTP
response alone never authorizes termination.

The normal installation remains non-elevated. macOS and Linux behavior remains
unchanged.

## Chosen approach

Change the generated Windows ownership helper from a boolean ownership test to
a tri-state classifier:

- `Owned`: complete metadata proves one of the accepted Hermes Dashboard
  process shapes and the exact Dashboard port argument.
- `Foreign`: readable metadata conclusively contradicts the expected Hermes
  root, executable, command grammar, or port.
- `Indeterminate`: a listener exists, but Windows withheld metadata required to
  distinguish `Owned` from `Foreign`.

The normal helper invocation reacquires the loopback listener and classifies
it. It terminates only `Owned`. For `Indeterminate`, the shared installer
launches a second invocation of the same generated helper with
`Start-Process powershell.exe -Verb RunAs -Wait -PassThru`. Only this helper is
elevated; the bootstrap, Git Bash installer, Hermes configuration, files, and
service registration remain in the original current-user context.

The elevated helper does not trust a PID or ownership result supplied by the
non-elevated caller. It independently reacquires the listener, resolves the
current process tree, and applies the full strict classifier.

## Ownership and race safety

Before termination, the helper must require all existing v0.3.9 ownership
conditions:

- the listener is bound to exact loopback address `127.0.0.1` and the requested
  Dashboard port;
- the process shape is a direct expected Hermes launcher, an accepted
  under-root Python/module chain, or an accepted under-root `main.py` chain;
- the `dashboard` subcommand is in the expected command position;
- `--port PORT` or `--port=PORT` matches the requested port; and
- Hermes root and executable comparisons use normalized absolute paths.

The helper records the initially classified listener PID and process creation
time, then immediately reacquires the listener and process before termination.
The second snapshot must have the same PID and creation time and must classify
as `Owned` again. Any listener change, PID reuse, metadata loss, or second-pass
mismatch fails closed without termination.

The elevated helper must validate independently; elevation is not evidence of
ownership. A conclusively foreign listener never triggers UAC.

## Recovery flow

1. The installer finds a listening Dashboard whose `/api/config` rejects the
   installer-owned session token.
2. It asks Hermes, under the expected `HERMES_HOME`, to stop its Dashboard and
   waits for port release. This preserves the existing non-elevated fast path.
3. If port 9119 remains occupied on Windows, the generated ownership helper
   runs non-elevated.
4. `Owned` is stopped with the existing task-tree termination and verified port
   release.
5. `Foreign` fails immediately without UAC or termination.
6. `Indeterminate` emits an informational message and requests one scoped UAC
   elevation of the ownership helper.
7. The elevated helper reacquires and strictly validates ownership twice. It
   stops the process tree only if both snapshots remain `Owned` and stable.
8. The original installer verifies port release, starts Hermes Dashboard with
   `HERMES_DASHBOARD_SESSION_TOKEN`, verifies authenticated `/api/config`, and
   continues the normal Gateway install.

UAC cancellation, denial, unavailability, or elevated validation failure leaves
the existing listener untouched and exits with a specific recovery message.
The user can then close the elevated Hermes Dashboard manually and rerun the
same installer command.

## Helper and installer contract

The helper uses stable exit codes:

- `0`: no listener exists, or a strictly verified owned listener was stopped
  and released the port.
- `42`: a listener exists and is conclusively foreign or mismatched.
- `43`: required process metadata is inaccessible in the current helper
  context.
- `45`: ownership was verified, but the listener changed, termination failed,
  or the port did not release.

The shell recovery wrapper maps them as follows:

- `0`: continue.
- `42`: fail with the existing ownership-safety error and do not elevate.
- `43`: request one elevated helper run; map UAC cancellation or launch failure
  to a clear message explaining that only the recovery helper requested
  elevation.
- `45` or any unexpected code: fail with a verified-owner recovery error and
  do not retry indefinitely.

The elevated child returns the same helper exit codes. The shell never loops
back into another UAC request.

## PowerShell compatibility and argument safety

The generated helper remains compatible with Windows PowerShell 5.1. Expected
root, resolved Hermes executable, root launcher, and port are passed as
separate `-File` arguments. The UAC launcher constructs a PowerShell argument
list using Windows-safe quoting and does not interpolate paths into executable
script text.

The helper file remains under the protected CozyGateway local directory. No
credential, session token, setup code, or provider secret is passed to the
elevated process or printed in diagnostics.

## Testing

Tests are written before production changes and must first fail against
v0.3.9.

The extracted PowerShell classifier tests cover:

- the reported four-Python-to-`hermes.exe` snapshot with null paths and command
  lines returns `Indeterminate`;
- the same process shape with readable valid metadata returns `Owned`;
- readable wrong path, command, subcommand, or port remains `Foreign`;
- null metadata does not become `Owned` from process names, owner, session, or
  port alone;
- a changed PID or creation time between validation passes prevents
  termination.

The Windows installer harness covers:

- `Indeterminate` invokes exactly one scoped elevated helper;
- an elevated `Owned` result stops once and installation continues;
- a foreign result never invokes UAC;
- UAC cancellation or denial leaves the listener untouched and reports the
  explicit recovery instruction;
- elevated `Foreign`, `Indeterminate`, race, or stop failure leaves the listener
  untouched;
- paths containing spaces survive `Start-Process` argument quoting; and
- no secret values appear in command logs.

Existing Windows bootstrap, Dashboard ownership, cold-start, foreign-listener,
stale-PID, ACL, rerun, macOS/Linux installer, monorepo, bundle, and release
tests remain required.

## Validation boundary

Local validation can prove classifier behavior, UAC invocation construction,
cancel/failure handling, and the normal Windows lifecycle without prompting
for elevation. Final acceptance requires the reported host or an equivalent
medium-integrity/elevated-Dashboard matrix to approve the UAC prompt and confirm:

- strict elevated ownership classification succeeds;
- only the stale Hermes Dashboard tree stops;
- the new session-token Dashboard starts;
- authenticated `/api/config` returns 200;
- CozyGateway health and attach state become ready; and
- no full installer or installed file changes ownership due to elevation.

## Rejected alternatives

### Manual-only failure

Failing with instructions to close the elevated Dashboard is safe and small,
but leaves the one-paste install unable to recover a common Windows state that
can be handled safely with scoped elevation.

### Weakened ownership heuristics

Authorizing termination from loopback port, HTTP behavior, process names,
owner, session, or ancestry names without readable paths/commands would improve
automation by discarding the primary safety invariant. It is rejected.

### Elevating the full installer

Running the bootstrap or shared installer as administrator could alter file
ownership, profile discovery, environment, PATH, and persistence registration.
Only the minimal read/validate/stop helper may elevate.

### Alternate Dashboard port

Starting a second Dashboard would require persisted port allocation, leave the
stale process running, and assume Hermes supports concurrent Dashboards for one
home. It is outside this fix.

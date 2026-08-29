# Task 8 report: fixed verified Windows helper

## Status

Implemented the versioned fixed-command Windows helper, its bounded TypeScript client, release
asset/checksum plumbing, bootstrap verification/install, and Windows/TypeScript test gates.

## Scope delivered

- Added a PowerShell 5.1-compatible helper with seven exact commands and a single version-1 JSON
  envelope. Requests and responses are UTF-8 and capped at 64 KiB; failures expose only fixed reason
  codes, never exception text or browser URLs.
- Discovery ignores `PATH`, parses the `Tailscale` service image, requires the correlated
  `%ProgramFiles%\Tailscale\tailscaled.exe` plus sibling `tailscale.exe`, rejects reparse points,
  verifies Authenticode status and the exact `Tailscale Inc.` organization, and classifies the
  legacy IPN binary as manual/unsupported.
- Installation uses only the fixed official stable URL, manually permits at most three exact-origin
  HTTPS redirects, caps the response at 256 MiB with timeouts, uses a private unique temp directory,
  verifies the downloaded signature, and launches the interactive signed installer once through
  UAC with no silent flags. Exit 1223 is a stable cancellation reason.
- Preference mutation accepts only unattended and shields-up, constructs one fixed `tailscale set`
  flag, elevates only that executable, then verifies through targeted `get --json`. Browser opening
  accepts only the purpose-specific exact login/console HTTPS hosts, default port, and no credentials
  or fragment; URLs never appear in the response or test event log.
- Pending initialization writes the fixed `pending_choice` projection atomically and protects its
  directory, sibling temp, and destination. Path protection requires absolute root containment and
  rejects reparse ancestors before applying a current-user/SYSTEM-only protected DACL.
- Adapter inventory uses stable interface GUIDs, numeric CIM media/state fields, hardware-interface
  metadata, and IPv4 rows. Localized names are presentation-only.
- Added `WindowsHelperClient`, which requires absolute Windows helper/PowerShell paths, invokes with
  `shell:false` and a hidden window, bounds stdin/stdout/time, decodes strict UTF-8, and rejects
  schema versions, commands, keys, reason codes, or command results outside the fixed contract.
- The bundle now copies and checksums `cozygateway-windows-helper.ps1`; releases upload both files.
  The Windows bootstrap verifies the checksum and installs the helper beside `cozygateway.mjs`
  before handing off to the shared installer. CI runs the native helper harness on Windows.

## TDD evidence

Observed RED/GREEN slices included:

1. The client suite initially failed because `src/windows-helper.ts` did not exist; the absolute,
   no-shell runner and strict schema implementation made its first five behaviors green.
2. Release and bootstrap tests failed because the helper was neither bundled/uploaded nor installed;
   bundle, workflow, and checksum-verified bootstrap wiring made both green.
3. PowerShell discovery/browser/preference/installer/path/pending/inventory cases were introduced
   through a dot-sourced fake backend. No production environment switch enables the fake seam.
4. Follow-up cases covered scalar `get --json`, preference UAC cancellation, exact empty-command
   requests, DACL calls at every pending-file boundary, and unexpected inventory keys.

One early harness defect omitted the fake UAC result for the preference case. It attempted to start
the inert placeholder executable with `RunAs`; the harness timed out and killed it. No installer,
service, preference, or network mutation completed. The fake backend now fails closed if a fixture
does not provide the UAC result, preventing any test fixture from reaching live UAC.

## Verification

Fresh final commands and exact results are recorded after review remediation. The pre-review gates
already established:

- Windows helper harness: passed.
- Windows bootstrap harness: passed.
- Focused Vitest helper/release suites: 2 files, 9 tests passed.
- Gateway typecheck and build: exit 0.
- Bundle: created the helper and matching SHA-256 sidecar.
- Full Gateway suite with one thread worker: 94 files passed, 1 skipped; 953 tests passed, 2 skipped.

The first default-concurrency full-suite attempt hit the repository's previously observed Vitest
worker `ERR_IPC_CHANNEL_CLOSED` infrastructure failure. The complete one-worker rerun passed.

## Self-review

- Production code cannot activate the fake backend through environment inheritance. Tests dot-source
  the helper and inject a fixture object explicitly; doing that already requires arbitrary local
  PowerShell execution, which is inside the documented same-user trust boundary.
- All executable paths used for automatic Tailscale operations come from correlated signed Program
  Files artifacts. `PATH`, localized service names, and localized adapter display names do not make
  trust or selection decisions.
- Download and browser redirect/URL checks compare parsed URI components, not suffix strings.
- Installer, preference, browser, ACL, and pending mutations are fixed operations; Node cannot send
  arbitrary PowerShell, executable arguments, paths outside the declared root, or browser purposes.
- Real transport, live installer, and service mutation remain outside this task.

## Independent review remediation

The mandatory independent review initially returned **not ready** and identified one critical and
six important issues. All were handled before commit:

- Replaced the fixture-invented adapter fields with the documented real `MSFT_NetAdapter`
  `NdisMedium`, `NdisPhysicalMedium`, `InterfaceOperationalStatus`, and `InterfaceAdminStatus`
  fields. Up is now exactly operational/admin `1`; admin `2` is disabled. The fixture mirrors the
  real CIM schema, and a read-only real invocation returned schema 1 with six normalized adapters.
- Replaced unbounded CLI capture with an absolute-path, no-shell bounded process runner that drains
  stdout/stderr concurrently, kills on 15-second timeout or output overflow, and returns only the
  fixed preference verification reason.
- Required an absolute pending root and separated missing/invalid roots from reparse-point reasons.
- Added `installer_reboot_required` for standard exits 1641 and 3010.
- Added a bounded duplicate-aware top-level JSON guard before Windows PowerShell 5.1's
  last-key-wins `ConvertFrom-Json`, including case-variant and Unicode-escaped duplicate tests.
- Restricted discovery pauses and every failure envelope to per-command reason sets, and required
  success/zero versus failure/nonzero exit correlation in the TypeScript client.
- Confirmed stdin is read incrementally as raw bytes and stopped at 64 KiB before strict UTF-8/JSON
  decoding; the old `ReadToEnd()` observation was already stale when review returned.
- The focused re-review cleared those items and found one final Windows-path issue: `IsPathRooted`
  accepts `C:relative` and `\relative`. Both pending and path protection now require an explicitly
  fully-qualified drive-rooted or UNC path, with regressions for both context-dependent forms.

# Task 11 onboarding UX and verification-resource remediation

## Scope

This slice remediates the onboarding orchestrator/CLI and the low-authority verification resource.
It changes only the assigned Gateway modules and directly corresponding tests. No live installer,
Tailscale process, browser, UAC prompt, or external network was invoked; behavioral network tests
use bounded loopback listeners.

## Behavior delivered

- Every incomplete or changed setup run returns to the four route choices instead of silently
  continuing a projected mode. A matching complete authoritative posture remains idempotent.
- Later/Cancel and route switches conditionally roll back an inspected endpoint. If inspection
  cannot produce an endpoint, the orchestrator invokes the adapter's endpoint-independent durable
  reconciliation. A missing adapter or reconciliation failure preserves the prior projection and
  fails closed; no verification challenge or pairing output is created. This is covered across a
  recreated process with durable LAN ownership.
- Healthy `legacy_unreviewed` upgrades enter the route review before any phone check. The explicit
  legacy `pair` compatibility gate is unchanged and remains covered by the CLI suite.
- `OnboardingIo.showNetworkDisclosure(mode, signal?)` is awaited before rollback, preparation, or
  QR output. The CLI discloses LAN plaintext/wildcard exposure and Tailscale phone, peer,
  administrator, sleep, and Windows-session requirements. The optional prepared-endpoint seam
  renders the LAN adapter's concrete wildcard interface message before challenge/QR creation.
  Verification URLs are described as short-lived and one-time, with an explicit browser-history
  warning before the QR.
- Status now carries discriminated pause, inspection, and mode-specific readiness issues. Every
  real `TailscaleModeReadinessError` and `LanModeReadinessError` reason is preserved, and the CLI
  maps each one to an exact repair action instead of collapsing it to `inspection_failed`.
- One fixed five-second budget now covers TCP-accept-to-upgrade and first-frame authentication
  cumulatively. The dispatcher re-arms an absolute deadline after an ordinary keep-alive response,
  so an incomplete second upgrade cannot bypass the guard. A completed upgrade passes its
  remaining deadline into `PhoneVerification` rather than starting another five seconds.
  Ordinary response work remains unaffected, and confirmation bodies retain their bounded read.
- The hidden `cleanup-owned-network --config <path>` command exposes the durable Windows
  reconciliation API to healthy uninstall. It requires an explicit config path, refuses non-Windows
  execution, prints no cleanup details or secrets, returns nonzero on every failure, and closes
  CLI/controller resources in `finally`; the reconciliation API itself closes SQLite on success
  and rejection before the installer may delete it.

## TDD evidence

The first NetworkOnboarding RED run failed five new cases: no resume choice, Later/Cancel continuing
the old route, healthy legacy auto-continuation, and discarded typed inspection pause. The focused
GREEN run passed 42/42 tests. Windows integration then exposed a narrower legacy bug: after showing
the choice, a healthy legacy endpoint was incorrectly considered reusable. A new RED test reproduced
the skipped prepare; excluding `legacy_unreviewed` from reuse produced the final 43/43 GREEN run.

The first CLI RED run failed three new cases: both disclosure render paths were absent and status
discarded the typed repair reason. The focused GREEN run passed 83/83 CLI tests and 42/42
orchestrator tests.

The first upgrade-deadline RED run failed all three new deadline assertions because the constant
and installer did not exist. The Gateway integration RED timed out on incomplete upgrade headers.
The slow confirmation RED likewise timed out. Final focused verification-resource GREEN evidence:
4 files passed, 40 tests passed.

The second review added RED coverage for endpointless Later/Cancel/switch cleanup, durable LAN
process recreation, failed reconciliation, all fourteen real readiness-error reasons, a slow
second upgrade on a reused keep-alive socket, and an upgrade that tried to spend nearly two auth
budgets. The failures reproduced the review precisely: reconciliation was never called, readiness
became `inspection_failed`, the second incomplete upgrade remained open, and the combined header
plus first-frame interval reached 415 ms against a scaled 240 ms budget. The focused GREEN run
passed 174/174 orchestration, CLI, dispatcher, and verification-WebSocket tests. Disclosure-copy
changes were also exercised RED then GREEN, including removal of the unsupported "after logout"
promise.

The internal cleanup command was likewise added RED then GREEN. Five focused cases cover injected
runtime dispatch, resource closure, redaction and nonzero rejection, non-Windows refusal, and the
explicit-config and malformed-argument requirements.

## Technical review and justified pushback

The external findings were technically valid where the saved-mode branch bypassed user choice,
where `status()` collapsed adapter errors, and where the five-second timer began only after a
successful WebSocket handshake. Each was reproduced before implementation.

Follow-up technical review found that storing a remaining duration at the first upgrade listener
allowed synchronous listener work to extend the absolute budget before PhoneVerification consumed
it. A scaled 90 ms RED regression still exposed 89 ms after 35 ms of synchronous work. The
dispatcher now stores an absolute performance-clock deadline and subtracts at consumption; the
same regression is GREEN. This finding was accepted rather than pushed back because it violated
the singular cumulative-budget invariant even though ordinary network timing made the window
small. The final independent review reported no remaining Critical or Important findings and
independently passed the 174-test focused slice plus workspace typecheck and build.

Two broad interpretations were intentionally rejected:

1. Removing legacy explicit pairing would contradict the approved compatibility section. The fix
   changes setup review only and preserves the explicit `legacy_unreviewed` pair exception.
2. Applying a five-second lifetime to every completed Gateway HTTP response would break ordinary
   long-running authenticated traffic. The guard is cleared while ordinary response work runs and
   is re-armed only after response completion for the next keep-alive header interval. Verification
   upgrades inherit the original absolute deadline while authenticated sockets retain their
   separate sixty-second total lifetime.

Similarly, re-selection does not erase persistence or unconditionally reset network state. The
saved endpoint is inspected when possible, the new disclosure is shown, and adapter-owned
conditional rollback or durable endpoint-independent reconciliation runs only after the explicit
choice. This preserves concurrent and unowned network state while failing closed when ownership
safety cannot be established.

## Final diagnostics review

The final review identified four additional boundary cases and one copy audit. Each behavior was
reproduced before its implementation changed:

- Later, Cancel, and route switching previously passed a live-but-changed endpoint into conditional
  rollback. A changed deployment fingerprint now makes that snapshot untrusted, so the orchestrator
  invokes endpoint-independent durable reconciliation and fails closed if reconciliation cannot
  prove safety. Matching healthy snapshots still use conditional rollback.
- Repeating setup after an in-memory operator challenge expired rotated SQLite's verification epoch
  before trying to replace the old active row. The resulting `not_found` left setup unable to issue
  a fresh QR until restart. SQLite now invalidates the prior proof first, the expired capability is
  then removed from memory, and the new epoch uses the ordinary session/challenge creation path.
  A regression expires and replaces the challenge twice in one Gateway process.
- Authenticated operator JSON bodies now have a five-second bounded read. Timeout or caller abort
  cancels the stream reader, returns the same uniform not-found response, removes the abort listener,
  and clears its timer. Size, UTF-8, and exact-schema bounds remain unchanged.
- The internal cleanup command renders only the exported typed safe code, using an exhaustive map
  for all cleanup outcomes. Each code has one concrete operator repair step; unknown exceptions are
  redacted to an installer-Repair action and raw exception messages are never emitted. Malformed
  cleanup arguments likewise print the exact required config form instead of a generic failure.
- Status/setup copy now covers `custom_control_server`, `preference_rollback_failed`,
  `account_changed`, Advanced port conflicts and unreachable origins, in addition to the existing
  mapping-conflict guidance.

Focused RED evidence included: changed endpoints calling `rollbackOwned`, repeated expiry throwing
`failed to replace expired phone verification challenge`, an incomplete authenticated body that
remained pending beyond five seconds, `account_changed` collapsing to `inspection_failed`, and safe
cleanup codes producing only the old generic error. The focused final-diagnostics GREEN run passed
217/217 tests across orchestration, CLI, operator control, phone HTTP/WebSocket, and Gateway server
integration.

Independent read-only review reported no remaining Critical or Important findings in this slice.
It specifically confirmed durable reconciliation for changed/unhealthy snapshots, SQLite-before-
memory expiry replacement order, bounded reader cancellation and timer/listener cleanup, exhaustive
safe cleanup diagnostics, and explicit readiness/pause copy.

## Verification

- Focused final-diagnostics slice: PASS — 6 files, 217 tests.
- Gateway build: PASS.
- Gateway typecheck: PASS.
- Full Gateway suite: PASS — 100 files passed, 1 skipped; 1,204 tests passed, 2 skipped.
- Owned-path `git diff --check`: PASS (Git emitted only LF-to-CRLF working-copy notices).

Full-suite attempts during concurrent shared-worktree edits that ended in an unrelated LAN rollback
failure or Vitest `ERR_IPC_CHANNEL_CLOSED` were intentionally not accepted as evidence. After the
shared seams settled and the other agents reported quiescence, the standalone authoritative rerun
completed with the passing counts above.

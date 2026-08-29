# Task 11 onboarding UX and verification-resource remediation

## Scope

This slice remediates the onboarding orchestrator/CLI and the low-authority verification resource.
It changes only the assigned Gateway modules and directly corresponding tests. No live installer,
Tailscale process, browser, UAC prompt, or external network was invoked; behavioral network tests
use bounded loopback listeners.

## Behavior delivered

- Every incomplete or changed setup run returns to the four route choices instead of silently
  continuing a projected mode. A matching complete authoritative posture remains idempotent.
- Later/Cancel and route switches conditionally roll back only the previously inspected endpoint.
  Rollback failure preserves the prior projection and fails closed; no verification challenge or
  pairing output is created.
- Healthy `legacy_unreviewed` upgrades enter the route review before any phone check. The explicit
  legacy `pair` compatibility gate is unchanged and remains covered by the CLI suite.
- `OnboardingIo.showNetworkDisclosure(mode, signal?)` is awaited before rollback, preparation, or
  QR output. The CLI discloses LAN plaintext/wildcard exposure and Tailscale phone, peer, and
  administrator visibility requirements.
- Status now carries a discriminated pause/inspection issue with the bounded typed reason and
  optional detail. The CLI prints the reason plus concrete repair guidance instead of only
  `changed`.
- One fixed five-second constant now covers TCP-accept-to-upgrade and first-frame authentication.
  Incomplete/slow HTTP headers are destroyed on an absolute deadline. Completed ordinary Gateway
  request headers clear that timer, while the low-authority onboarding HTTP resource remains
  bounded through response completion. Confirmation bodies also have a bounded read.

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

## Technical review and justified pushback

The external findings were technically valid where the saved-mode branch bypassed user choice,
where `status()` collapsed adapter errors, and where the five-second timer began only after a
successful WebSocket handshake. Each was reproduced before implementation.

Two broad interpretations were intentionally rejected:

1. Removing legacy explicit pairing would contradict the approved compatibility section. The fix
   changes setup review only and preserves the explicit `legacy_unreviewed` pair exception.
2. Applying a five-second lifetime to every completed Gateway HTTP request would break ordinary
   long-running authenticated traffic. The absolute timer therefore bounds header parsing and the
   low-authority onboarding resource, but transfers ordinary completed requests to their existing
   route-specific lifecycle. Upgraded verification sockets transfer synchronously to the existing
   five-second first-frame and sixty-second lifetime timers.

Similarly, re-selection does not erase persistence or unconditionally reset network state. The
saved endpoint is inspected, the new disclosure is shown, and adapter-owned conditional rollback
is invoked only after the explicit choice. This preserves concurrent and unowned network state.

## Verification

- Focused onboarding/CLI: PASS — 2 files, 126 tests.
- Focused ordinary HTTP/TLS/app-WS/attach traffic: PASS — 3 files, 41 tests.
- Focused verification HTTP/WS/abuse/dispatcher: PASS — 4 files, 40 tests.
- Gateway build: PASS.
- Gateway typecheck: PASS.
- Full Gateway suite: PASS — 100 files passed, 1 skipped; 1,110 tests passed, 2 skipped.
- Owned-path `git diff --check`: PASS (Git emitted only LF-to-CRLF working-copy notices).

One full-suite attempt during concurrent shared-worktree edits was intentionally not accepted as
evidence: a durable-network LAN rollback test failed, followed by Vitest
`ERR_IPC_CHANNEL_CLOSED`. The owning agent was notified; after the shared seams settled, the
standalone authoritative rerun completed with the passing counts above.

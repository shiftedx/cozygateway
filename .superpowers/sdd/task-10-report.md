# Task 10 report: Windows onboarding integration

## Status

Implemented the complete Windows setup and installer flow across the approved LAN, personal
Tailscale, onboarding-authority, helper, and pairing components. The interactive CLI now provides
the four approved route choices, resumable typed pauses, safe status output, and the Task 6 pairing
gate. Noninteractive Windows installs remain healthy on loopback, emit no pairing material, and
print exactly one native PowerShell resume command. POSIX installation and legacy non-Windows CLI
behavior remain unchanged.

## Authorized scope expansion

The task now includes the concrete cross-process seam between setup and the running Gateway. A
narrow local operator onboarding control surface exposes only begin, status, and cancel. It is
absent unless a token-file path is configured, accepts only loopback clients (including supported
IPv4-mapped IPv6 forms), uses constant-time Bearer authentication, exact bounded JSON, fixed
uniform failures, and never returns or logs credentials or general administrative capabilities.

Fresh Windows bootstrap generates a 256-bit base64url token outside Gateway configuration under
install-local state, stores only its path in config, and protects it with the signed Windows helper.
Setup prepares and restarts the selected adapter first, asks the live Gateway to begin verification,
polls authoritative status and phrase state, and still finalizes pairing locally through the SQLite
Task 6 gate. The bridge is disabled for legacy and non-Windows installations unless explicitly
configured.

## Scope delivered

- Added production Windows setup/status wiring with real SQLite authority, signed-helper ACL and
  adapter operations, LAN and personal-Tailscale adapters, listener restart/probes, and the local
  operator client. Managed route changes clear stale advanced public URLs.
- Added interactive choices for Remote with personal Tailscale, Same Wi-Fi, Set up later, and
  advanced settings. Model/provider selection remains before Gateway setup when configuration is
  missing.
- Added actionable typed pause copy for UAC cancellation, reboot, login/browser/account and machine
  approval, policy refusal, missing or ambiguous adapters with explicit selection, listener races,
  and mapping conflicts. Output intentionally excludes troubleshooting dumps and secrets.
- Added mode, readiness stage, expiry, and one-command resume status in the existing setup/status
  surface without adding a doctor command.
- Enforced fresh pending-marker, complete matching-posture, changed-posture, and
  `legacy_unreviewed` compatibility rules. The connectivity QR contains only the verification URL;
  noninteractive runs contain neither QR nor code.
- Changed Windows Git Bash installation to return to the original PowerShell process for native
  setup. It never invokes unconditional pairing or a fallback after cancellation. Fresh markers and
  operator tokens are created before configuration can permit pairing, and completed bootstrap
  steps are reusable on resume.
- Added HTTP/control/client/config/bootstrap coverage for absent/bad credentials, oversized or
  inexact bodies, wildcard-listener non-loopback rejection, concurrency/replay, cancellation,
  restart/resume, final-origin rebasing, token generation, token-path-only config, and helper ACLs.
- Updated the approved design, Windows installer documentation, and README for the concrete bridge
  and final user flow.

## Compatibility

- Fresh Windows: pending before configuration, guided setup required before pairing.
- Matching completed Windows posture: explicit later pairing remains available.
- Changed Windows posture: routed back through setup.
- Existing `legacy_unreviewed`: explicit pairing remains compatible, including when the prior
  endpoint is temporarily unhealthy.
- Windows noninteractive/headless: loopback install only, no QR/code, exactly one resume command.
- POSIX, Docker/App Review, advanced public URL, legacy pairing TTL, and non-Windows behavior:
  unchanged.

## TDD and verification

The implementation was driven by failing CLI, control-surface, storage, HTTP, configuration,
installer, and bootstrap tests. All network, Tailscale, helper, browser, service, and installer
effects are represented by fakes, injected runners, disposable databases, or bounded local test
listeners; no live install, UAC, Tailscale, browser, or external-network mutation occurred.

- Full Gateway suite: 99 files passed, 1 skipped; 1,027 tests passed, 2 skipped.
- Gateway build: passed.
- Gateway typecheck: passed.
- Full Hermes installer dry-run suite: passed.
- Windows bootstrap regression suite: passed.
- `git diff --check`: clean apart from Git's LF-to-CRLF working-copy notices.

## Self-review

The review found and fixed three compatibility/safety regressions before the final gate: legacy
explicit pairing had incorrectly required a currently healthy endpoint; the hardened Windows LAN
selector had accidentally replaced the more permissive existing POSIX address discovery; and
managed route switches could retain an advanced public URL. Separate legacy discovery and explicit
managed-route clearing now preserve the intended boundaries. The final review found no unresolved
critical or important issue and confirmed that the production CLI/installer path uses the concrete
running-Gateway bridge rather than an injected-only test seam.

## Review-finding remediation

Every finding in `task-10-review-findings.md` was reproduced and resolved test-first:

1. Managed listener changes now snapshot the complete persisted config text, install state, and
   actual Hermes environment-file targets. All production writers share an exclusive local writer
   lock and use flushed temporary files plus rename. Forward changes and rollback compare the exact
   snapshot; public URL, TLS, unknown future fields, Hermes contents, or another writer changing
   any coordinate makes the CAS fail, and rollback never overwrites a later edit.
2. Operator-control requests and production health/TLS/WebSocket probes always have fixed deadlines
   composed with caller cancellation. An absent/restarting control endpoint is a typed
   `gateway_restarting` pause; authoritative `not_found` and `expired` remain distinct live-Gateway
   results. Restart pauses retain the prepared route and emit no setup code or pairing output.
3. Advanced setup now configures and activates the basic bind address and port. Its second route
   enters Same Wi-Fi adapter selection, shows only normalized physical candidates, rejects invalid
   choices, and feeds the explicit adapter ID into LAN preparation. Ambiguous adapters are never
   guessed.
4. Operator challenge state and setup status now read SQLite on every call and across independent
   storage/process handles. Only live active, WebSocket-probed, or phone-confirmed challenges expose
   expiry; cancellation, completion, and expiry clear the live projection. The process-local expiry
   cache was removed.
5. The CLI now has concrete, resumable copy for every typed Tailscale, LAN, and operator pause,
   including install/support/service, login/machine approval, account rejection, preference policy/
   cancellation/verification, HTTPS consent/no safe port, mapping inspection/mutation/conflict,
   listener races, adapter absence/ambiguity, operator concurrency, and Gateway restart. Copy and
   safe LAN candidate display contain no token, capability, account identity, auth URL, or diagnostic
   dump.
6. `createWindowsOnboardingController` now exposes narrow injection boundaries for its helper,
   storage, control client, state, CLI runner, probes, clock, delay, and output. Integration tests
   exercise the actual factory composition with the real Tailscale adapter, explicit LAN selection,
   real advanced config/Hermes synchronization, transient restart/resume, complete and expiring
   SQLite status, the fresh pair gate, and concurrent CAS refusal. All boundaries are inert fakes or
   disposable local files/databases.
7. Disabled, wrong-method, and bad-auth operator-control requests now return the same status,
   content type, cache policy, and body. Authenticated status can still return a bounded typed
   `not_found`, which lets the CLI distinguish authority state from endpoint absence.

The RED runs failed on stale process-local status, non-uniform route responses, absent request
deadlines, rollback-on-restart, ambiguous LAN selection, missing advanced behavior, incomplete
pause copy, and config/Hermes CAS gaps. Final GREEN gates passed:

- Focused CLI/controller/control/storage/network suites: 8 files, 176 tests passed.
- Full Gateway suite: 100 files passed, 1 skipped; 1,065 tests passed, 2 skipped.
- Gateway build: passed.
- Gateway typecheck: passed.
- Full Hermes installer dry-run suite: passed.
- Windows bootstrap regression suite: passed.
- `git diff --check`: clean apart from Git's LF-to-CRLF working-copy notices.

No test invoked a live installer, UAC prompt, browser, Tailscale service, preference, Serve/Funnel
mutation, or external network. The only real listeners were bounded loopback/LAN-address test
listeners created inside the test process.

## Final durability closeout

Self-review added one last red/green regression for ambiguous LAN selections across process
boundaries. The chosen normalized adapter ID is now stored in a bounded, atomically replaced local
state sidecar, protected by the Task 8 helper before and after rename. A newly constructed real
Windows controller and newly opened SQLite handle reuse the explicit selection without guessing or
prompting again; a missing or invalid selection still pauses.

Fresh final verification after that change:

- Focused remediation suites: 8 files, 176 tests passed.
- Standalone full Gateway suite: 100 files passed, 1 skipped; 1,065 tests passed, 2 skipped.
- Gateway build and typecheck: passed.
- Windows bootstrap regression suite: passed.
- Full Hermes installer dry-run suite: passed.
- `git diff --check`: clean apart from Git's LF-to-CRLF working-copy notices.

One earlier full-suite attempt run concurrently with build/typecheck ended in Vitest worker shutdown
with `ERR_IPC_CHANNEL_CLOSED` and no assertion failure. The required standalone rerun completed with
the counts above and exit status zero.

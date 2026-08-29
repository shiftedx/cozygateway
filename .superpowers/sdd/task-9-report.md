# Task 9 report: personal Tailscale mode

## Status

Implemented the personal-account Tailscale CLI and network-mode adapter with conservative,
resumable handling for current public CLI shapes. All automated verification uses injected runners,
helpers, probes, and disposable SQLite databases; no live Tailscale state was mutated.

## Scope delivered

- Added an absolute-path, no-shell Tailscale runner with cancellation and timeouts, strict UTF-8,
  64 KiB per-object and 256 KiB total bounds, duplicate-key rejection, fixed/redacted errors, and
  incremental parsing for the multi-object `up --json` stream.
- Required both client and daemon version 1.102.1 or newer. Running status requires a healthy online
  untagged user node, a lowercase ASCII exact `.ts.net` DNS boundary matching the MagicDNS suffix,
  a resolvable current user profile, and exact certificate-domain membership when certificates are
  ready. Login, stopped, machine-approval, certificate-consent, malformed, and policy states fail
  closed with reasoned resumable outcomes.
- Added explicit confirmation of the already-running account and no account-switch operation. New
  authentication uses only `up --json` for login, exact `login.tailscale.com` URLs, and independent
  status polling. Targeted unattended and shields-up changes require separate consent and exact
  `get --json` verification; policy refusal pauses without broad preference rewrites.
- Added complete Serve/Funnel inspection across root TCP, L7 Web, foreground sessions, Tailscale
  Services, Funnel flags, and PROXY-bearing handlers. Only the exact TLS-terminated TCP 443 mapping
  to the Gateway loopback port is reusable; every other port-443 use is refused and other ports are
  preserved.
- Added the checked certificate-transparency path using a user-approved unused high port, a
  foreground HTTPS text mapping, an exact login/console URL, foreground-command cancellation,
  certificate polling, and complete post-consent state reinspection before continuing.
- Creation and removal use only the scoped public CLI forms. Final proof requires bounded loopback
  readiness, complete mapping reinspection, system-trust TLS for the requested exact host, exact SAN
  membership, no redirect, HTTP 200 health, no `h2`, and a WebSocket echo held for at least one
  second.
- Added conflict-safe SQLite ownership persistence over `onboarding_ownership`. Reused mappings stay
  unowned. Rollback revalidates account/tailnet, endpoint, exact live mapping, and post-removal state,
  and therefore preserves reused or concurrently changed mappings.
- Added failure-injection boundaries after installs, login/browser actions, each preference write,
  consent/browser actions, probes, mapping create/reinspection/removal, and ownership writes/removal.
- Added a labeled sanitized/synthetic fixture corpus for all requested version, status, preference,
  Serve/Funnel, and login stream shapes.

## TDD evidence

The implementation was developed in red/green slices. Initial suites failed on missing CLI and
adapter modules, then drove the trusted runner, version/status parsing, preference shapes, login
stream, mapping inspection, exact mutations, account flow, transport proof, ownership, and rollback.
Subsequent red cases exposed and fixed current full-config Funnel interpretation and JSON's default
last-key-wins handling; the parser now rejects duplicate keys including Unicode-escaped aliases.
Final slices added cancellation, invalid UTF-8, combined output overflow, separate preference
decline, and managed-policy refusal coverage.

## Verification

- Focused Task 9 suites: 2 files, 27 tests passed.
- Shared onboarding-storage suite: 1 file, 16 tests passed.
- Gateway typecheck: passed.
- Gateway build: passed.
- Full isolated Gateway suite: 96 files passed, 1 skipped; 980 tests passed, 2 skipped.
- `git diff --check`: clean apart from Git's existing LF-to-CRLF notice for `storage.ts`.

## Self-review

- The production adapter contains no Funnel mutation, logout, Serve reset, L7 reverse proxy, PROXY
  mode, debug preference, broad preference `up`, or raw identity/auth URL logging path. The only
  `up` invocation is the documented JSON login/resume operation while status is `NeedsLogin`.
- Install and elevated preference changes remain behind the fixed signed-helper contract; the CLI
  adapter receives only the helper-returned fully-qualified executable.
- Inspection is read-only. Preparation confirms the current account before preference or mapping
  changes, and every post-create failure conditionally removes only the exact mapping created by the
  current run. A reused mapping never acquires ownership.
- The temporary HTTPS-consent command is foreground-only and is aborted once a validated consent URL
  is captured. Complete state is reread and the approved temporary port must be absent before the
  durable mapping path proceeds.
- The remote probe contract makes system trust, exact requested host/SAN, redirect behavior, health,
  ALPN, and WebSocket lifetime explicit, allowing real bounded probe implementations to fail closed
  without any certificate bypass.
- Fixture identities, domains, URLs, targets, and node identifiers are synthetic or sanitized;
  browser URLs and identities are never incorporated into error messages.

## Review-finding remediation

All findings in `task-9-review-findings.md` were resolved test-first:

1. Added uncertain-outcome reconciliation around exact mapping creation and removal. A timed-out
   create proceeds only when complete reinspection finds the exact requested mapping, which is then
   proven and owned normally. Removal always reinspects; an already-applied removal clears matching
   SQLite ownership idempotently. Restart tests cover failures immediately after mapping removal and
   ownership removal, while concurrent conflicting state remains untouched.
2. Moved complete Serve/Funnel inspection to immediately after current-account confirmation. Both
   certificate-ready and certificate-consent paths now refuse every port-443 conflict before any
   preference, consent, probe, or mapping mutation.
3. Added structured retryable adapter reasons plus bounded helper/CLI detail codes for installer
   cancellation, reboot, signature verification, login, browser, preference cancellation/policy/
   verification, status, HTTPS consent, mapping inspection, and mapping mutation. `NetworkOnboarding`
   preserves these as a typed `paused` outcome instead of collapsing them to generic readiness.
4. Occupied temporary-consent ports now come from the complete Funnel document, including nested
   services and foreground state rather than only `AllowFunnel`.
5. Unified HTTPS consent with the trusted bounded runner. Pre-aborted signals never invoke a runner;
   streaming UTF-8 is fatal, per-stream/combined caps remain enforced even after a URL is observed,
   runner failures are redacted to fixed codes, and foreground termination is awaited before the URL
   is returned.
6. Removed trailing-dot normalization. `Self.DNSName` must now be the exact lowercase ASCII `.ts.net`
   value present in `CertDomains`; trailing-dot fixtures and mismatches are rejected.

The RED run produced nine failures spanning all six technical findings. The GREEN remediation gates
then passed:

- Task 9 CLI/mode suites: 2 files, 35 tests passed.
- Task 9 plus orchestration suites: 3 files, 68 tests passed.
- Focused suites plus onboarding storage: 4 files, 84 tests passed.
- Gateway typecheck and build: passed.
- Full isolated Gateway suite: 96 files passed, 1 skipped; 990 tests passed, 2 skipped.
- `git diff --check`: clean apart from LF-to-CRLF notices.

All cases use injected runners/helpers/probes or disposable SQLite files. No live Tailscale,
installer, UAC, browser, service, preference, Serve, Funnel, or network mutation was performed.

## Second review-finding remediation

Both findings in `task-9-review-findings-2.md` were reproduced and resolved test-first:

1. Exact create/remove outcome reconciliation no longer inherits an already-aborted caller signal.
   Complete read-only recovery inspection and conditional rollback use a fresh controller with a
   finite timeout capped at 30 seconds. Regression cases abort at the instant the fake CLI applies
   creation or removal: applied creation is detected and conditionally removed after the cancelled
   prepare, while applied removal is detected and matching SQLite ownership is cleared. Neither can
   become a silently reused unowned mapping.
2. HTTPS consent now flushes its fatal streaming `TextDecoder` after the foreground runner has fully
   terminated and before accepting the observed URL. A valid URL followed by an incomplete final
   multibyte sequence fails with the fixed `invalid_utf8` reason.

The RED run failed all three safety assertions (create-abort recovery, remove-abort recovery, and
decoder finalization). Fresh GREEN gates passed:

- Task 9 CLI/mode suites: 2 files, 36 tests passed.
- Focused Task 9/orchestration/storage suites: 4 files, 85 tests passed.
- Gateway typecheck and build: passed.
- Full isolated Gateway suite: 96 files passed, 1 skipped; 991 tests passed, 2 skipped.
- `git diff --check`: clean apart from LF-to-CRLF notices.

The first unchanged full-suite attempt ended with the repository's known Vitest worker
`ERR_IPC_CHANNEL_CLOSED` infrastructure failure and no assertion failure. The immediate identical
isolated rerun completed with the counts above. No live Tailscale or other host mutation was used.

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

# Task 6 report: posture state and network onboarding orchestration

## Status

Complete. Added the bounded resume projection and dependency-injected network onboarding
orchestrator, plus the narrow Task 3 pre-finalization hook required to order rendering before a
fresh live posture inspection and the authoritative SQLite transaction.

## Scope delivered

- Added `NetworkOnboardingStateFile` with an exact 4 KiB/versioned schema for the six approved
  projection stages. Unknown fields are rejected, so raw capabilities, verification/login URLs,
  account identities, setup codes, device tokens, and generic secrets cannot be added silently.
- State writes use a private, unpredictable sibling temp, exclusive/no-follow open, full write,
  file flush, close, explicit Windows ACL protection request, atomic rename, destination ACL
  request, and POSIX directory flush. Reads are bounded and use no-follow handle reads.
- Both construction and IO reject out-of-root paths, non-files, and reparse/symbolic-link parents
  or targets. On Windows, a write without the fixed helper-backed ACL protector fails closed.
- Added `NetworkModeAdapter`, `PreparedEndpoint`, `OnboardingIo`, SQLite-authority, phone-proof, and
  runtime-context boundaries. The orchestrator itself performs no host or network mutation.
- Network choice and readiness always precede Task 5 challenge creation. Later/cancel, readiness
  failure, automatic phone proof, default No, non-exact answers, display failures, and rollback
  failure cannot reach publication.
- The readiness QR receives only `verificationUrl`. The desktop displays the phrase returned by
  automatic confirmation only after it exactly matches Task 5's challenge phrase. Only exact
  lowercase `y` or `yes` enters publication.
- Extended Task 3's approved publication dependency with one optional asynchronous
  `beforeFinalize` hook. Candidate output renders first; the hook then re-inspects the adapter and
  current verification epoch/boot generation; SQLite finalization follows immediately without
  another yield.
- Reinspection compares mode, canonical origin, binding/port, durable fingerprint, keyed
  account/tailnet hash, physical adapter, DHCP address, Serve mapping, and readiness. Any change
  invalidates proof and invokes conditional adapter rollback without finalizing or writing output.
- Successful publication retains Task 3's one buffered write, post-write activation, and
  write-failure revocation. Only after SQLite completion does the orchestrator best-effort update
  the non-authoritative `complete` projection.
- `run`, `resume`, and `status` all consult the injected SQLite authority before the sidecar. A
  matching complete posture is live-inspected and not repeated; a contradictory or corrupt
  sidecar never overrides SQLite.
- A real SQLite integration race sends two complete orchestration sequences through the same
  phone-confirmed challenge and proves one `complete`, one `lost_race`, one terminal write, and one
  active setup-code row.

## TDD evidence

Observed RED -> GREEN cycles included:

1. Both new modules missing -> two suite-load failures.
2. Sidecar implementation present -> Windows directory-fsync and junction classification failures;
   corrected platform handling and reparse check order.
3. Orchestration implementation present -> signal-argument expectation mismatch, then 23/23 green.
4. New render/inspect/finalize ordering tests -> missing Task 3 hook and wrong
   inspect-before-render order; added the optional hook and moved inspection into it.
5. Challenge-start and proof-exception rollback tests -> zero rollback / rejected promise; added
   conditional rollback outcomes.
6. Connection-check display failure -> rejected promise; added rollback before any publication.
7. Repeat-run complete-posture test -> flow restarted and reached `not_confirmed`; added the
   authoritative complete guard.
8. Real SQLite two-orchestrator test passed with one winner on its first implementation run after
   the unit-level concurrency behavior was already RED/GREEN.

Every new production function/class behavior is covered by focused tests; network/host effects use
only fake adapters, while SQLite authority is exercised with a temporary real database.

## Final verification

```text
pnpm --filter cozygateway exec vitest run test/onboarding-state.test.ts test/network-onboarding.test.ts test/onboarding-storage.test.ts
Test Files  3 passed (3)
Tests       50 passed (50)

pnpm --filter cozygateway exec vitest run test/cli.test.ts test/pairing-output.test.ts test/qr.test.ts
Test Files  3 passed (3)
Tests       51 passed (51)

pnpm --filter cozygateway typecheck
tsc --noEmit (exit 0)
```

The CLI gate emitted only the existing expected fake-Hermes connection-refused/reconnect
diagnostics; no test failed.

## Self-review

- Security ordering: no choice/readiness/phone/default-No path calls publication. On exact Yes,
  strict render precedes live inspection, which precedes synchronous SQLite finalization. Phone
  confirmation itself still mints nothing.
- Concurrency: losing finalization does not roll back a shared endpoint, preventing one wizard
  from removing live state used by the SQLite winner. Pre-finalization failures retain conditional
  rollback.
- Projection safety: the sidecar has no compare-and-swap role, challenge coordinates, capability,
  identity, URL, or setup-code field. SQLite status always wins and successful progress repairs
  the projection atomically.
- Compatibility: Task 2 transition shapes and Task 5 challenge shape are unchanged. Task 3 gained
  only an optional hook; legacy and existing onboarding callers behave identically when it is
  omitted.
- Test quality: adapters are faked because host/network mutation is explicitly out of scope; the
  publication race uses real `Storage`, and no test-only production method was added.

## Concern / handoff

No Task 6 blocker remains. Task 10 must supply the concrete SQLite implementation of the
`OnboardingAuthority.status()` read boundary when it wires the CLI; Task 7 and Task 9 must provide
the LAN and Tailscale adapters with complete `PreparedEndpoint` coordinates. Task 8 must provide
the fixed helper-backed Windows ACL protector. Until those wiring tasks, this module remains an
inert, fully tested orchestration seam and performs no host/network mutation by itself.

# Task 7 report: strict physical-LAN mode

## Status

Complete. Added a strict, localization-independent physical LAN selector and an inert,
dependency-injected LAN mode adapter. No test or production path in this task performs actual host
mutation.

## Scope delivered

- Replaced `os.networkInterfaces()` inference with a versioned fixed-helper inventory contract.
  Helper-provided machine enums establish physical hardware, Up state, and Ethernet/Wi-Fi kind;
  localized display names are presentation-only.
- Accepted only exact RFC1918 IPv4 addresses from one Up physical Ethernet or Wi-Fi interface.
  Public, loopback, link-local, Tailscale 100.64/10, VPN, Hyper-V, WSL, container, other software,
  disabled, and disconnected candidates fail closed.
- Returned stable structured pause reasons and bounded safe candidate rows for no eligible address
  and ambiguity. The `LanModePause` bridge is explicitly retryable and preserves those details for
  Task 10's simple choice/resume UI; it never guesses.
- Added a `LanModeRuntime` seam covering fixed-helper inventory, the atomic listener/Hermes state,
  compare-and-swap persistence, restart/attach readiness, and health/WebSocket proof. Tests use only
  `FakeLanRuntime`.
- Prepared wildcard `0.0.0.0` binding and synchronized all managed Hermes targets to the exact
  loopback port as one compare-and-swap state. Plaintext/trusted-private-network disclosure and the
  names of other currently active interfaces accompany the endpoint.
- Re-read helper inventory and listener state around the final probe. Health, WebSocket, attach,
  listener, Hermes-target, physical-adapter, or DHCP drift makes the endpoint non-ready.
- Rollback owns one exact before/after transaction. It restores only while live state still equals
  the wizard-created state; concurrent edits cause the compare-and-swap to fail and survive intact.
- LAN endpoints include the selected physical adapter ID and DHCP address in the existing
  `PreparedEndpoint` coordinates and a deterministic SHA-256 durable fingerprint, so Task 6's
  pre-finalization inspection invalidates lease changes before pairing.

## TDD evidence

Observed RED -> GREEN cycles:

1. New selector calls failed with `selectPhysicalLanCandidate is not a function`, and the LAN mode
   suite failed to resolve `lan-mode.ts`. The initial implementation made 18 focused tests green.
2. New attach-readiness, single-probe, and Hermes-target drift cases failed: attach loss resolved
   ready, failed health/WebSocket probes ran twice, and drift remained ready. The adapter now uses
   one probe, requires attach readiness, and re-reads the full listener transaction after probing.
3. The wildcard disclosure regression failed because no message named the active Tailscale
   interface. The endpoint now carries both structured interface rows and explicit `0.0.0.0`
   disclosure text.

## Verification

Final verification commands:

```text
pnpm --filter cozygateway exec vitest run test/lan.test.ts test/lan-mode.test.ts
pnpm --filter cozygateway test
pnpm --filter cozygateway typecheck
pnpm --filter cozygateway build
git diff --check
```

The full package run passed 93 files / 941 tests with 1 file / 2 environment-dependent tests
skipped. Existing fake-Hermes reconnect diagnostics remained noisy but no test failed.

## Self-review

- Selection uses only helper enums and exact IPv4 parsing; no adapter-name or address-prefix
  heuristic remains.
- Ambiguity and absence expose retryable reason codes without changing state. Task 10 still needs
  to map the typed pause through its user-facing orchestration rather than a generic failure.
- Readiness covers listener, every Hermes target, health, WebSocket, attach, adapter ID, and DHCP
  address. A concurrent change during the probe is detected by the post-probe read.
- Rollback clears ownership after one conditional attempt, preventing a later ABA-shaped state from
  being overwritten. It does not restart when compare-and-swap observes a concurrent edit.
- The legacy no-argument `primaryLanAddress()` now safely returns undefined; legacy pairing falls
  back to loopback rather than inferring a physical adapter from Node-only inventory.
- No firewall, route, listener, config-file, service, or real network mutation was introduced.

## Handoff

Task 8's Windows helper should emit `WindowsLanInventory` exactly as normalized here. Task 10 should
surface `LanModePause.reason/candidates` as a resumable adapter-choice step and provide the concrete
atomic runtime implementation; Task 7 intentionally leaves both operations inert.

## Review-finding remediation

All findings in `.superpowers/sdd/task-7-review-findings.md` were addressed test-first.

### RED evidence

Five new final-probe regressions failed against `d3a63ff`:

```text
pnpm --filter cozygateway exec vitest run test/lan-mode.test.ts
Test Files  1 failed (1)
Tests       5 failed | 11 passed (16)
```

- A DHCP address changed inside `beforeProbe`, but prepare returned the stale address as ready.
- The physical adapter ID changed inside `beforeProbe`, but prepare returned the stale adapter.
- No-candidate and two-candidate post-probe snapshots both resolved stale-ready rather than
  returning typed retryable pauses.
- Wildcard disclosure omitted an active software interface added during the probe because it was
  built from the pre-probe inventory.

### GREEN changes

- The final inspection now validates helper inventory immediately before the probe and reads it
  again after health/WebSocket/attach proof, alongside the final listener read.
- A final single candidate must retain the expected stable adapter ID and address. A different
  single candidate is posture drift and causes conditional rollback.
- None or multiple candidates observed at initial prepare/inspect, immediately pre-probe, or
  post-probe remain `LanModePause` with their original stable reason and safe candidate rows.
- Endpoint identity, DHCP coordinate, durable fingerprint, and wildcard disclosure now come only
  from the verified final helper snapshot.
- A direct `inspect()` regression proves post-probe ambiguity remains retryable as well as the
  prepare path. The Task 7 focused suites instantiate no Hermes client and emit no fake-Hermes
  diagnostics to capture; all fake restart/attach behavior is captured through asserted runtime
  call arrays. Existing expected fake-Hermes diagnostics remain confined to the full package run.

### Post-review verification

```text
pnpm --filter cozygateway exec vitest run test/lan.test.ts test/lan-mode.test.ts
Test Files  2 passed (2)
Tests       27 passed (27)

pnpm --filter cozygateway exec vitest run --reporter=dot
Test Files  93 passed | 1 skipped (94)
Tests       947 passed | 2 skipped (949)

pnpm --filter cozygateway typecheck
tsc --noEmit (exit 0)

pnpm --filter cozygateway build
tsc -p tsconfig.build.json (exit 0)

git diff --check
exit 0
```

The first full-suite attempt, run concurrently with the other gates, hit the already recorded
Vitest worker `ERR_IPC_CHANNEL_CLOSED` without a test assertion. An immediate isolated rerun passed
all 947 runnable tests.

### Post-review self-review

- Both mutable coordinates that matter across a network proof are now bracketed: listener/Hermes
  transaction and fixed-helper physical inventory. The final endpoint never uses the earlier
  inventory object.
- Pause semantics are preserved at all three inventory observations; only a unique-but-different
  candidate is classified as posture drift.
- Conditional rollback behavior is unchanged: transient inventory failure restores only the exact
  wizard-created listener/Hermes state, and concurrent listener edits still survive.

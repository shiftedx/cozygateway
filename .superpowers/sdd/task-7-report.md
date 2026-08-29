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

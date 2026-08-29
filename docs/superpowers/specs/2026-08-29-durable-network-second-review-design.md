# Durable Network Second-Review Design

## Goal

Close the remaining crash windows in Tailscale preference and LAN listener recovery, and expose a bounded Windows production cleanup operation that uninstall can call before SQLite removal.

## Durable protocols

LAN keeps a complete before/after listener transaction in SQLite. The Windows runtime deterministically plans the exact replacement snapshot and full-snapshot revision before the filesystem CAS, while retaining token-bearing Hermes profile contents only in process memory. The provisional row therefore identifies the exact post-CAS state even if the process dies immediately after the write. Rollback first changes the ownership phase to `rollback-restart-required`; reconciliation then conditionally applies the reverse CAS if needed, always retries/verifies the restart, and removes authority only after restart succeeds. Legacy provisional rows without a planned revision remain recoverable by a one-time semantic adoption, but new production writes do not rely on that ambiguity.

Tailscale creates or validates provisional mapping ownership before either preference mutation. Before changing `unattended` or `shields-up`, it CAS-appends that preference's `{before, after}` restoration to SQLite. A crash after the preference write therefore leaves enough authority for conditional recovery. Mapping creation continues to use the same provisional record and exact state fingerprint.

An apparently successful Serve removal followed by the exact mapping still being present is a typed `mapping` failure in both public reconciliation and prepare-failure rollback.

## Windows cleanup boundary

`reconcileWindowsOwnedNetworkState(configPath: string, runtime: CliRuntime, signal?: AbortSignal): Promise<void>` loads installed config, derives the helper path and SQLite path, constructs the real Tailscale, LAN, and Advanced adapters without operator token/control/state, calls all three reconciliation methods while collecting failures, and closes storage in `finally`. It never deletes SQLite and rejects on discovery, reconciliation, restart, CAS, or close-preceding cleanup failure.

The wrapper adapters forward `reconcileOwned`. Advanced mode uses its own SQLite listener authority because it mutates the same managed config/Hermes CAS unit as LAN. Its ownership stores exact bounded before/after config text, Hermes target URLs, and precomputed full-snapshot revisions without storing token-bearing profile contents. It conditionally restores only an exact wizard-owned after state, retains a restart-required phase until Hermes restart succeeds, and fails closed on external changes.

## Tests

Tests cover the production Windows listener runtime's applied-revision adoption, crashes at both preference-write boundaries, restart-required authority retained across restart failure and cleared only after a successful retry, exact Serve state remaining after removal, wrapper forwarding, real installed-path cleanup construction, sequential cleanup, storage closure, and failure propagation. Existing focused, typecheck, build, and full Gateway gates remain required.

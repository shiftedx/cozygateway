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

## Final review hardening

Cleanup must never let SQLite create or select an authority database. It resolves `config.dbPath` relative to the configuration directory, requires the exact existing target to be a readable regular non-reparse file, rejects canonical-path indirection, asks the installed Windows helper to prove the path is contained by the protected install root and apply its private DACL, repeats the local file proof, and only then calls `openStorage`. Missing, unsafe, unreadable, or externally located authority fails closed without relocation, fallback creation, or deletion.

Preference restoration is account-scoped. Immediately before any rollback preference read or write, the adapter reads current Tailscale status, derives the keyed account/tailnet HMAC, and compares it with ownership. A mismatch throws typed `account_changed`, retains ownership, and performs no preference access or mutation.

Cleanup has a 120-second total deadline and bounded sequential per-adapter budgets. Tailscale, LAN, and Advanced are all attempted even after an earlier timeout. Runtime restart/readiness operations and helper/CLI child processes receive linked abort signals; killed children are awaited through actual close before an adapter settles. SQLite closes only after every started adapter operation and process has settled or terminated. Concurrent cleanup and race-only timeout designs are excluded because they can race listener state or leave continuations using closed authority.

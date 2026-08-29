# Durable Network Second-Review Design

## Goal

Close the remaining crash windows in Tailscale preference and LAN listener recovery, and expose a bounded Windows production cleanup operation that uninstall can call before SQLite removal.

## Durable protocols

LAN keeps a complete before/after listener transaction in SQLite. Because the new filesystem revision cannot exist before the filesystem CAS, a provisional record carries the intended semantic state; after CAS the adapter immediately replaces it with the observed exact revision. On restart, a semantic match under that prewritten intent is adopted into SQLite before further work. Rollback first changes the ownership phase to `rollback-restart-required`; reconciliation then conditionally applies the reverse CAS if needed, always retries/verifies the restart, and removes authority only after restart succeeds.

Tailscale creates or validates provisional mapping ownership before either preference mutation. Before changing `unattended` or `shields-up`, it CAS-appends that preference's `{before, after}` restoration to SQLite. A crash after the preference write therefore leaves enough authority for conditional recovery. Mapping creation continues to use the same provisional record and exact state fingerprint.

An apparently successful Serve removal followed by the exact mapping still being present is a typed `mapping` failure in both public reconciliation and prepare-failure rollback.

## Windows cleanup boundary

`reconcileWindowsOwnedNetworkState(configPath: string, runtime: CliRuntime, signal?: AbortSignal): Promise<void>` loads installed config, derives the helper path and SQLite path, constructs the real LAN and Tailscale adapters without operator token/control/state, calls both reconciliation methods sequentially, and closes storage in `finally`. It never deletes SQLite and rejects on discovery, reconciliation, restart, CAS, or close-preceding cleanup failure.

The wrapper adapters forward `reconcileOwned`. Advanced mode is a no-op because it has no durable ownership record and cannot prove ownership of a listener mutation after the process exits; claiming rollback would risk overwriting user configuration.

## Tests

Tests cover the production Windows listener runtime's applied-revision adoption, crashes at both preference-write boundaries, restart-required authority retained across restart failure and cleared only after a successful retry, exact Serve state remaining after removal, wrapper forwarding, real installed-path cleanup construction, sequential cleanup, storage closure, and failure propagation. Existing focused, typecheck, build, and full Gateway gates remain required.

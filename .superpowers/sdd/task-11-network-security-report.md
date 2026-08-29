# Task 11: durable network security remediation

## Outcome

The Tailscale and Same-Wi-Fi adapters now use SQLite as the durable authority for network mutations. A process can crash after an external mutation and a later process can determine whether the exact live state is still CozyGateway-owned, recover it, or preserve a concurrent/user-owned replacement. Preference restoration uses the same compare-before-write rule. Account/tailnet identity is now an installation-local keyed HMAC.

## Implemented findings

- Tailscale Serve writes a schema-v2 `provisional` ownership record before `tailscale serve --bg`. The record is promoted to `active` only after status, exact Serve state, remote TLS/health/WebSocket, and ownership CAS proof.
- A restart reconciles either side of the provisional boundary: an absent mapping can be created, and an exact already-created mapping can be verified and promoted without another mutation.
- Rollback/removal re-reads status and complete Serve/Funnel state. It removes only the exact account, DNS name, target, port, mode, non-PROXY, non-Funnel state described by the durable record. Changed or unrelated mappings are preserved. An exact mapping that remains after a reported-success removal is a typed `mapping` failure and retains ownership.
- Wizard changes to `unattended` and `shields-up` record `{before, after}` values. Rejection, cancellation, readiness failure, and durable cleanup restore a value only while its current value still equals the wizard's `after` value. External edits are not overwritten. Restore verification failures become `preference_rollback_failed`.
- Before login, preference, certificate-consent, or Serve mutation, the adapter runs bounded JSON parsing over `tailscale debug prefs` and accepts only Tailscale's two official control-server synonyms. Missing, malformed, custom, and Headscale URLs fail closed.
- Account/tailnet identity is `HMAC-SHA-256` with a random 32-byte installation-local key in `onboarding_local_secrets`. The existing Windows install boundary protects the local directory, SQLite database, WAL, and SHM with private ACLs. The key is returned by copy and never appears in ownership JSON, durable fingerprints, endpoint data, or logs.
- Mapping and endpoint fingerprints include the ownership subtype (`wizard-created` or `reused`). LAN fingerprints likewise include `wizard-listener-cas` or `preexisting-listener`.
- LAN listener changes persist a provisional exact before/after CAS unit in SQLite before the config/Hermes mutation. Resume handles both pre-CAS and post-CAS crashes. Exact rollback CAS failure, restart failure, ownership-CAS failure, or concurrent listener replacement is a typed `LanModeRollbackError` with reason `rollback_failed`; it is never reported as success.
- Unrelated Serve/Funnel entries, reused mappings, preferences changed by another actor, listener replacements, adapter selections, and other onboarding ownership keys are preserved.

## Uninstall/recovery production seam

These public operations are intentionally endpoint-independent so uninstall can reconcile before deleting SQLite:

```ts
TailscaleModeAdapter.reconcileOwned(signal?: AbortSignal): Promise<void>
LanModeAdapter.reconcileOwned(signal?: AbortSignal): Promise<void>
```

The Tailscale operation needs the existing adapter dependencies: SQLite-backed `TailscaleOwnershipStore`, Tailscale discovery/helper, bounded CLI runner, and gateway port. The LAN operation needs the SQLite-backed `LanOwnershipStore` plus exact listener read/CAS/restart operations. Uninstall must keep SQLite and stop on any rejection; delete the database only after both operations resolve. This task does not wire the CLI/uninstall caller because that path was explicitly outside its ownership boundary.

## Review-claim verification and pushback

The substantive findings were verified against the prior code: Serve ownership was recorded after mutation/proof, preference mutations had no conditional restore ledger, custom control servers were not checked, account identity used unkeyed SHA-256, ownership subtype was absent from fingerprints, and LAN ownership existed only in process memory with a failed rollback CAS treated as completion.

One requested characterization is technically false: `tailscale debug prefs` is not a stable CLI contract. Tailscale's own `cmd/tailscale/cli/debug.go` says debug commands are not a stable interface, even though `prefs` is an official command that emits JSON. No documented stable, read-only CLI command exposing the effective `ControlURL` was found, and status JSON does not supply an equivalent field. The implementation therefore uses the official debug command as a narrowly bounded, strict, fail-closed compatibility bridge behind the existing minimum-version check. Tailscale source defines both `https://controlplane.tailscale.com` and legacy `https://login.tailscale.com` as official synonyms; tests accept exactly those two. References: [Tailscale debug CLI source](https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/debug.go), [Tailscale preferences source](https://github.com/tailscale/tailscale/blob/main/ipn/prefs.go), and [Tailscale CLI documentation](https://tailscale.com/kb/1080/cli).

True atomicity across SQLite and a separate Tailscale daemon or filesystem/restart boundary is impossible through these public interfaces. The implemented protocol is write-ahead durable intent plus exact-state compare-and-swap/reconciliation, which closes the crash windows without claiming a cross-process transaction.

## Tests and verification

- Focused storage/Tailscale/LAN suite: `pnpm exec vitest run test/storage.test.ts test/onboarding-storage.test.ts test/tailscale-mode.test.ts test/lan-mode.test.ts test/tailscale-cli.test.ts`
- Gateway typecheck: `pnpm typecheck`
- Gateway build: `pnpm build`
- Full Gateway suite: `pnpm test` — 100 files passed, 1 skipped; 1,111 tests passed, 2 skipped.
- Diff hygiene: exact-path `git diff --check` and staged-path review.

Focused regressions cover write-before-mutate ordering, provisional crash resume, exact/conflicting/reused cleanup, uncertain command completion, conditional preference restoration and external edits, official/custom/missing control URL handling, per-install HMAC identity, secret absence from metadata, subtype fingerprints, SQLite ownership CAS, listener crash resume, listener rollback CAS races, and ownership retention on typed failure.

## Owned files

- `packages/gateway/src/lan-mode.ts`
- `packages/gateway/src/storage.ts`
- `packages/gateway/src/tailscale-cli.ts`
- `packages/gateway/src/tailscale-mode.ts`
- `packages/gateway/test/lan-mode.test.ts`
- `packages/gateway/test/tailscale-cli.test.ts`
- `packages/gateway/test/tailscale-mode.test.ts`
- `.superpowers/sdd/task-11-network-security-report.md`

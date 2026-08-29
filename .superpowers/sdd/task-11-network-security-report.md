# Task 11: durable network security remediation

## Outcome

The Tailscale and Same-Wi-Fi adapters now use SQLite as the durable authority for network mutations. A process can crash after an external mutation and a later process can determine whether the exact live state is still CozyGateway-owned, recover it, or preserve a concurrent/user-owned replacement. Preference restoration uses the same compare-before-write rule. Account/tailnet identity is now an installation-local keyed HMAC.

## Implemented findings

- Tailscale writes a schema-v2 `preferences` ownership record before either preference mutation, CAS-appends each `{before, after}` restoration before its helper write, then changes the record to `provisional` immediately before `tailscale serve --bg`. The record is promoted to `active` only after status, exact Serve state, remote TLS/health/WebSocket, and ownership CAS proof.
- A restart reconciles either side of the provisional boundary: an absent mapping can be created, and an exact already-created mapping can be verified and promoted without another mutation.
- Rollback/removal re-reads status and complete Serve/Funnel state. It removes only the exact account, DNS name, target, port, mode, non-PROXY, non-Funnel state described by the durable record. Changed or unrelated mappings are preserved. An exact mapping that remains after a reported-success removal is a typed `mapping` failure and retains ownership.
- Wizard changes to `unattended` and `shields-up` record `{before, after}` values. Rejection, cancellation, readiness failure, and durable cleanup restore a value only while its current value still equals the wizard's `after` value. External edits are not overwritten. Restore verification failures become `preference_rollback_failed`.
- Before login, preference, certificate-consent, or Serve mutation, the adapter runs bounded JSON parsing over `tailscale debug prefs` and accepts only Tailscale's two official control-server synonyms. Missing, malformed, custom, and Headscale URLs fail closed.
- Account/tailnet identity is `HMAC-SHA-256` with a random 32-byte installation-local key in `onboarding_local_secrets`. The existing Windows install boundary protects the local directory, SQLite database, WAL, and SHM with private ACLs. The key is returned by copy and never appears in ownership JSON, durable fingerprints, endpoint data, or logs.
- Mapping and endpoint fingerprints include the ownership subtype (`wizard-created` or `reused`). LAN fingerprints likewise include `wizard-listener-cas` or `preexisting-listener`.
- The production LAN runtime deterministically plans the exact post-CAS full-snapshot revision before persisting provisional ownership, while keeping token-bearing Hermes profile contents in memory only. Resume handles both pre-CAS and immediate post-CAS crashes without adopting a later same-shape external edit. Exact rollback CAS failure, restart failure, ownership-CAS failure, or concurrent listener replacement is a typed `LanModeRollbackError` with reason `rollback_failed`; it is never reported as success.
- LAN and Advanced change ownership to `rollback-restart-required` before reverse CAS. If reverse CAS succeeds but Hermes restart fails, SQLite retains explicit restart authority; later reconciliation retries and verifies restart before deleting the row.
- Advanced listener/public-origin changes now have independent SQLite authority (`advanced:listener`, subtype `advanced-listener-cas`). The record contains bounded exact before/after config text, exact full-snapshot revisions, and Hermes target URLs, but never token-bearing Hermes profile contents. Crash resume, phone rejection, mode switch, Later, and uninstall cleanup conditionally restore only the exact wizard-owned state and fail closed on external edits.
- Uninstall cleanup resolves the configured database path exactly and refuses to call `openStorage` unless the authority already exists as a readable regular file with stable `lstat`/open/`fstat` identity and no canonical-path indirection. The installed helper must then prove the configured path is inside the protected install root with safe DACLs, followed by a second local proof. The actual SQLite boundary uses URI `mode=rw`, so even a removal race cannot create a replacement. Missing, directory, junction/reparse, unreadable/DACL-rejected, and outside-root authorities fail with a generic repair instruction and cannot create a blank replacement. A valid configured custom authority inside the protected root is preserved.
- Every Tailscale preference rollback obtains a fresh status and installation-keyed account/tailnet HMAC at each preference read, helper write, and verification boundary. An account switch is a typed `account_changed` failure: preference values are untouched and ownership is retained even when the new account happens to expose the same boolean values. Paired Serve/Funnel inspections await both subprocess settlements before propagating either failure, and post-removal recovery inherits the caller's cleanup signal.
- Windows cleanup has a 120-second total cancellation budget and 30-second sequential budget per adapter. All Tailscale, LAN, and Advanced adapters are attempted, failures are collected, and a timed-out adapter is aborted and awaited to settlement before the next adapter starts. Hermes restart/readiness, helper, and Tailscale subprocess boundaries receive the signal. Production subprocess runners terminate and wait for `close`; SQLite closes only after adapter work has actually settled.
- Unrelated Serve/Funnel entries, reused mappings, preferences changed by another actor, listener replacements, adapter selections, and other onboarding ownership keys are preserved.

## Uninstall/recovery production seam

These public operations are intentionally endpoint-independent so uninstall can reconcile before deleting SQLite:

```ts
TailscaleModeAdapter.reconcileOwned(signal?: AbortSignal): Promise<void>
LanModeAdapter.reconcileOwned(signal?: AbortSignal): Promise<void>
AdvancedModeAdapter.reconcileOwned(signal?: AbortSignal): Promise<void>
reconcileWindowsOwnedNetworkState(
  configPath: string,
  runtime: CliRuntime,
  signal?: AbortSignal,
): Promise<void>
```

The bounded Windows operation loads installed config, derives the installed helper and exact configured SQLite path, proves the existing authority locally and through the installed helper, builds the real Tailscale, LAN, and Advanced adapters without operator token/control state, attempts all three reconciliations, aggregates multiple failures, and closes SQLite in `finally` only after in-flight work settles. It never deletes SQLite. The committed CLI cleanup command treats rejection as nonzero so the uninstall caller retains the authority database; deletion is safe only after this operation resolves.

## Review-claim verification and pushback

The substantive findings were verified against the prior code: Serve ownership was recorded after mutation/proof, preference mutations had no conditional restore ledger, custom control servers were not checked, account identity used unkeyed SHA-256, ownership subtype was absent from fingerprints, and LAN ownership existed only in process memory with a failed rollback CAS treated as completion.

One requested characterization is technically false: `tailscale debug prefs` is not a stable CLI contract. Tailscale's own `cmd/tailscale/cli/debug.go` says debug commands are not a stable interface, even though `prefs` is an official command that emits JSON. No documented stable, read-only CLI command exposing the effective `ControlURL` was found, and status JSON does not supply an equivalent field. The implementation therefore uses the official debug command as a narrowly bounded, strict, fail-closed compatibility bridge behind the existing minimum-version check. Tailscale source defines both `https://controlplane.tailscale.com` and legacy `https://login.tailscale.com` as official synonyms; tests accept exactly those two. References: [Tailscale debug CLI source](https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/debug.go), [Tailscale preferences source](https://github.com/tailscale/tailscale/blob/main/ipn/prefs.go), and [Tailscale CLI documentation](https://tailscale.com/kb/1080/cli).

True atomicity across SQLite and a separate Tailscale daemon or filesystem/restart boundary is impossible through these public interfaces. The implemented protocol is write-ahead durable intent plus exact-state compare-and-swap/reconciliation, which closes the crash windows without claiming a cross-process transaction.

## Tests and verification

- Final focused storage/Tailscale/LAN/Windows/helper suite: 6 files and 133 tests passed.
- Gateway typecheck: `pnpm typecheck`
- Gateway build: `pnpm build`
- Full Gateway suite: `pnpm test` — 100 files passed, 1 skipped; 1,170 tests passed, 2 skipped.
- Diff hygiene: exact-path `git diff --check` and staged-path review.

Focused regressions cover write-before-mutate ordering, crashes at both preference writes, provisional crash resume, exact/conflicting/reused cleanup, uncertain command completion, conditional preference restoration and external edits, switched-account rollback refusal, official/custom/missing control URL handling, per-install HMAC identity, secret absence from metadata, subtype fingerprints, exact planned listener revisions before CAS, rollback/restart authority, Advanced crash/rejection/switch/Later/uninstall recovery, safe existing/custom SQLite authority proof, sequential deadline settlement, real helper/Tailscale child termination, production cleanup construction, and ownership retention on typed failure.

## Owned files

The Windows onboarding source/test commit also includes the already-reviewed phone-reachable host normalization and firewall-guidance hunks produced during the parallel Windows field-readiness pass. Root requested that the two shared files be committed atomically here so neither pass would lose partial hunks.

- `packages/gateway/src/lan-mode.ts`
- `packages/gateway/src/storage.ts`
- `packages/gateway/src/cli.ts`
- `packages/gateway/src/windows-helper.ts`
- `packages/gateway/src/tailscale-cli.ts`
- `packages/gateway/src/tailscale-mode.ts`
- `packages/gateway/src/windows-onboarding.ts`
- `packages/gateway/test/lan-mode.test.ts`
- `packages/gateway/test/storage.test.ts`
- `packages/gateway/test/windows-helper-client.test.ts`
- `packages/gateway/test/tailscale-cli.test.ts`
- `packages/gateway/test/tailscale-mode.test.ts`
- `packages/gateway/test/windows-onboarding.test.ts`
- `docs/superpowers/specs/2026-08-29-durable-network-second-review-design.md`
- `docs/superpowers/plans/2026-08-29-durable-network-second-review.md`
- `.superpowers/sdd/task-11-network-security-report.md`

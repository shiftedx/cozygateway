# Task 11: durable network security remediation

## Outcome

The Tailscale and Same-Wi-Fi adapters now use SQLite as the durable authority for network mutations. Non-ambiguous state can be recovered or conditionally removed, while a process loss at the Tailscale POST boundary becomes a deliberately retained safe orphan rather than a guessed ownership claim. Preference restoration uses the same compare-before-write rule. Account/tailnet identity is now an installation-local keyed HMAC.

## Implemented findings

- Tailscale writes a schema-v3 `preferences` ownership record before either preference mutation and CAS-appends each `{before, after}` restoration before its helper write. Immediately before LocalAPI POST it journals `provisional` ownership plus the predicted complete post-create ServeConfig ETag; it promotes to `active` only after POST success, status, exact Serve state, remote TLS/health/WebSocket, and ownership CAS proof.
- A definite HTTP 412 removes the unsuccessful provisional intent and never attempts mapping rollback. A timeout, cancellation, or process loss after the pre-POST journal retains `provisional` ownership and any possible mapping as a safe orphan. Restart and uninstall refuse to adopt or remove that ambiguous state.
- Rollback/removal re-reads status and complete Serve/Funnel state. It removes only the exact account, DNS name, target, port, mode, non-PROXY, non-Funnel state described by an `active` durable record when the live complete ServeConfig ETag also equals the stored post-create ETag. Changed, unrelated, reused, or provisional mappings are preserved. An exact mapping that remains after a reported-success removal is a typed `mapping` failure and retains ownership.
- Wizard changes to `unattended` and `shields-up` record `{before, after}` values. Rejection, cancellation, readiness failure, and durable cleanup restore a value only while its current value still equals the wizard's `after` value. External edits are not overwritten. Restore verification failures become `preference_rollback_failed`.
- Before login, preference, certificate-consent, or Serve mutation, the adapter runs bounded JSON parsing over `tailscale debug prefs` and accepts only Tailscale's two official control-server synonyms. Missing, malformed, custom, and Headscale URLs fail closed.
- Account/tailnet identity is `HMAC-SHA-256` with a random 32-byte installation-local key in `onboarding_local_secrets`. The existing Windows install boundary protects the local directory, SQLite database, WAL, and SHM with private ACLs. The key is returned by copy and never appears in ownership JSON, durable fingerprints, endpoint data, or logs.
- Mapping and endpoint fingerprints include the ownership subtype (`wizard-created` or `reused`). LAN fingerprints likewise include `wizard-listener-cas` or `preexisting-listener`.
- The production LAN runtime deterministically plans the exact post-CAS full-snapshot revision before persisting provisional ownership, while keeping token-bearing Hermes profile contents in memory only. Resume handles both pre-CAS and immediate post-CAS crashes without adopting a later same-shape external edit. Exact rollback CAS failure, restart failure, ownership-CAS failure, or concurrent listener replacement is a typed `LanModeRollbackError` with reason `rollback_failed`; it is never reported as success.
- LAN and Advanced change ownership to `rollback-restart-required` before reverse CAS. If reverse CAS succeeds but Hermes restart fails, SQLite retains explicit restart authority; later reconciliation retries and verifies restart before deleting the row.
- Advanced listener/public-origin changes now have independent SQLite authority (`advanced:listener`, subtype `advanced-listener-cas`). The record contains bounded exact before/after config text, exact full-snapshot revisions, and Hermes target URLs, but never token-bearing Hermes profile contents. Crash resume, phone rejection, mode switch, Later, and uninstall cleanup conditionally restore only the exact wizard-owned state and fail closed on external edits.
- Uninstall cleanup resolves the configured database path exactly and refuses to call `openStorage` unless the authority already exists as a readable regular file with stable `lstat`/open/`fstat` identity and no canonical-path indirection. The installed helper must then prove the configured path is inside the protected install root with safe DACLs, followed by a second local proof. The actual SQLite boundary uses URI `mode=rw`, so even a removal race cannot create a replacement. Missing, directory, junction/reparse, unreadable/DACL-rejected, and outside-root authorities fail with a generic repair instruction and cannot create a blank replacement. A valid configured custom authority inside the protected root is preserved.
- Every Tailscale preference rollback obtains a fresh status and installation-keyed account/tailnet HMAC at each preference read, helper write, and verification boundary. An account switch is a typed `account_changed` failure: preference values are untouched and ownership is retained even when the new account happens to expose the same boolean values. Paired Serve/Funnel inspections await both subprocess settlements before propagating either failure, and post-removal recovery inherits the caller's cleanup signal.
- Windows cleanup has a 120-second total cancellation budget and 30-second sequential budget per adapter. All Tailscale, LAN, and Advanced adapters are attempted, failures are collected, and a timed-out adapter is aborted and awaited to settlement before the next adapter starts. Bounded non-interactive Hermes, helper, and Tailscale subprocess boundaries receive the signal and wait for `close`; SQLite closes only after adapter work has settled. Interactive helper commands that can launch UAC are deliberately outside this kill/timeout policy and remain awaited until the user completes or cancels them.
- Unrelated Serve/Funnel entries, reused mappings, preferences changed by another actor, listener replacements, adapter selections, and other onboarding ownership keys are preserved.
- Tailscale Serve creation and removal no longer issue port-scoped CLI mutations. The bounded named-pipe LocalAPI client verifies that SHA-256 of both the exact GET body and the pinned Tailscale 1.102.1 canonical ServeConfig encoding equals the received ETag. Creation requires port 443 to be empty across TCP, Web, AllowFunnel, Services, and Foreground, predicts and journals the post-create ETag before POST, clones and changes only the owned entry, then POSTs with `If-Match`. Removal additionally requires the live ETag to equal the durable owned ETag before parsing or mutating. HTTP 412 is never blindly retried and never causes rollback of a possible concurrent creation; there is no CLI mutation fallback.
- Cleanup preference restoration uses a dedicated helper command that checks elevation before trusted-CLI discovery and never calls `Start-Process -Verb RunAs`. It runs only in an already-elevated helper process or returns `preference_elevation_required`. Bounded non-UAC helper cancellation invokes `taskkill /T /F` and waits for the original child `close`; the real regression proves an ordinary spawned descendant is gone at settlement. This does not claim that a UAC-brokered elevated process is a killable descendant: interactive install/preference commands have no fixed 30-second parent timeout or abort kill and are awaited through user completion/cancellation.
- Relative SQLite paths are normalized once against the absolute config directory, independent of process CWD. Cleanup's second proof returns canonical path/device/inode identity and `openStorage(..., { mustExist: true, expectedFile })` compares it immediately after `mode=rw` open and before any PRAGMA/schema migration.
- Cleanup exports `WindowsOwnedNetworkCleanupError` with a bounded code union and safe per-adapter `{adapter, code}` failures. It exposes no path, account, secret, raw helper output, or subprocess diagnostic.
- Cleanup diagnostic classification is explicit: stopped/starting/status command failure and absent installs map to `tailscale_not_running`; login or machine authorization states map to `logged_out`; unsupported installs/versions map to `old_version`; custom control, account, mapping, preference, elevation, authority, helper, listener, and timeout failures retain their dedicated safe codes.
- LAN selection now persists `{adapterId,address}`. Legacy adapter-id-only files remain compatible only when that adapter has exactly one eligible address; multiple safe addresses on one adapter require and resume the exact chosen address.
- Tailscale status accepts exactly one customary terminal dot on `Self.DNSName`, canonicalizes it away, and retains strict lowercase ASCII `.ts.net` validation. Embedded, multiple, suffix-boundary, and Unicode ambiguity remain rejected.
- Advanced performs a real bind preflight before writing ownership or listener/config state. Local operator control derives its address from the actual configured bind (wildcard maps to loopback; concrete stays concrete); same-host concrete connections are checked by remote/local socket-address equality, and native TLS control requests trust and fingerprint only the exact configured certificate rather than disabling TLS globally.
- Common loopback/wildcard legacy listeners receive the `legacy_unreviewed` classification when there is no fresh SQLite authority/projection; a fresh pending flow still cannot bypass phone-reachable inspection.

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

True atomicity across SQLite and a separate Tailscale daemon or filesystem/restart boundary is impossible through these public interfaces. Tailscale 1.102.1 and current source define the ServeConfig ETag as a SHA-256 content hash, not a monotonic revision. Consequently, an exact-content ABA after active promotion is mathematically indistinguishable from the original state without an additional marker. CozyGateway does not invent an undocumented Tailscale marker: it rejects every non-identical replacement by ETag and treats crash-uncertain provisional state as a safe orphan requiring manual reconciliation. Schema-v2 ownership cannot be upgraded with proof that never existed and therefore fails closed.

## Tests and verification

- Latest ABA-focused suite: `tailscale-cli` and `tailscale-mode`; 67 tests passed.
- Gateway typecheck: `pnpm typecheck`
- Gateway build: `pnpm build`
- Full Gateway suite at the ABA commit: 99 files passed, 1 skipped; 1,226 tests passed, 2 skipped. One concurrently modified Windows onboarding expectation failed because the implementation now also returns `mode: "advanced"`; the ABA-focused files were green.
- Diff hygiene: exact-path `git diff --check` and staged-path review.

Focused regressions cover write-before-mutate ordering, crashes at both preference writes, crash after LocalAPI POST and before promotion, a lost successful response, identical concurrent creation returning 412 without rollback, complete port-443 conflict parity, durable ETag-gated removal, provisional restart/uninstall refusal, exact/conflicting/reused cleanup, uncertain command completion, conditional preference restoration and external edits, switched-account rollback refusal, official/custom/missing control URL handling, per-install HMAC identity, secret absence from metadata, subtype fingerprints, exact planned listener revisions before CAS, rollback/restart authority, Advanced crash/rejection/switch/Later/uninstall recovery, safe existing/custom SQLite authority proof, sequential deadline settlement, real helper/Tailscale child termination, production cleanup construction, and ownership retention on typed failure.

The LocalAPI behavior is verified against Tailscale 1.102.1 and current primary source: `ipn/localapi/serve.go` returns the GET ETag, accepts `If-Match`, and maps a mismatch to HTTP 412; `ipn/ipnlocal/serve.go` computes that ETag as hex SHA-256 of Go's JSON encoding of the complete ServeConfig and compares it under the backend lock; `ipn/serve.go` defines the pinned schema. Windows uses Tailscale's protected Administrators named pipe `\\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled`.

## Owned files

The Windows onboarding source/test commit also includes the already-reviewed phone-reachable host normalization and firewall-guidance hunks produced during the parallel Windows field-readiness pass. The operator-control source/test contain the UX deadline integration, and the Windows helper script contains the field-readiness `inspect-dashboard-port` implementation alongside cleanup's no-UAC preference command. Root requested these shared files be committed atomically; the producing agents will commit their matching remaining client/installer/test work afterward.

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

# Durable Network Second-Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LAN listener, Tailscale preference, and Windows uninstall reconciliation durable across every reviewed crash boundary.

**Architecture:** Extend existing SQLite ownership records rather than add a second journal. The production listener runtime plans the exact post-CAS revision before mutation and journals rollback/restart intent; Tailscale journals preference restorations before helper writes. A token-independent Windows factory builds the same production Tailscale, LAN, and Advanced adapters for onboarding and cleanup.

**Tech Stack:** TypeScript, Node.js SQLite, Vitest, Windows onboarding helper/runtime.

## Global Constraints

- Use test-first red/green cycles for every behavior change.
- Preserve unrelated mappings, preferences, listener state, and ownership rows.
- Cleanup closes but never deletes SQLite and rejects on any incomplete reconciliation.
- Do not modify shell uninstall wiring in this task.

---

### Task 1: LAN exact applied revision and restart authority

**Files:**
- Modify: `packages/gateway/src/lan-mode.ts`
- Test: `packages/gateway/test/lan-mode.test.ts`

**Interfaces:**
- Consumes: `LanModeRuntime.compareAndSwapListener`, `LanOwnershipStore.replace`.
- Produces: schema-v1 `LanListenerOwnership` with `provisional | active | rollback-restart-required` phase.

- [x] Add a failing resume test where the durable `after.persistenceRevision` is stale but all semantic listener fields match the post-CAS state; assert ownership adopts the observed revision before restart/promotion.
- [x] Run `pnpm exec vitest run test/lan-mode.test.ts -t "adopts the exact applied listener revision"` and confirm the current `rollback_failed` result.
- [x] Implement semantic intent matching plus CAS replacement with the exact observed state.
- [x] Add a failing test where reverse CAS succeeds, restart fails, and a new adapter's `reconcileOwned` must retry restart before removing ownership.
- [x] Run the focused test and confirm ownership is currently removed before restart.
- [x] Journal `rollback-restart-required` before reverse CAS; reconcile current `after` or `before`, restart `before`, then conditionally remove authority.
- [x] Run all LAN tests.

### Task 2: Production Windows LAN runtime regression

**Files:**
- Modify: `packages/gateway/src/windows-onboarding.ts`
- Test: `packages/gateway/test/windows-onboarding.test.ts`

**Interfaces:**
- Consumes: exact managed listener snapshot revisions.
- Produces: shared installed network-adapter construction used by controller and cleanup.

- [x] Add a failing production-runtime test that performs the real managed-listener CAS, interrupts before promotion, and resumes from SQLite with the new exact revision.
- [x] Confirm the test fails because the durable record lacks the exact planned post-CAS revision.
- [x] Extract the production LAN runtime builder and persist the exact planned applied revision before CAS.
- [x] Run the Windows onboarding and LAN focused tests.

### Task 3: Tailscale preference write-ahead journal

**Files:**
- Modify: `packages/gateway/src/tailscale-mode.ts`
- Test: `packages/gateway/test/tailscale-mode.test.ts`

**Interfaces:**
- Consumes: schema-v2 `TailscaleMappingOwnership` CAS.
- Produces: provisional ownership before preferences and a CAS-appended restoration before each helper write.

- [x] Add failing ordering tests for both preferences: ownership creation/replacement must occur before `setPreference`.
- [x] Add crash-resume tests using the durable row captured at each failure injection boundary; `reconcileOwned` must conditionally restore only the still-wizard value.
- [x] Confirm current tests fail because ownership is written after both preference changes.
- [x] Move ownership validation/creation before preferences and add a narrow CAS journal helper invoked before each mutation.
- [x] Run all Tailscale mode/CLI/storage tests.

### Task 4: Exact mapping remains after removal

**Files:**
- Modify: `packages/gateway/src/tailscale-mode.ts`
- Test: `packages/gateway/test/tailscale-mode.test.ts`

**Interfaces:**
- Produces: immediate `TailscaleModeReadinessError("mapping")` while retaining ownership.

- [x] Add a failing prepare-failure rollback test where removal returns success but reinspection still sees the exact mapping.
- [x] Confirm the original injected error currently escapes instead of typed `mapping`.
- [x] Throw typed mapping failure from exact rollback and keep ownership.
- [x] Run the focused Tailscale test.

### Task 5: Production cleanup and required wrapper forwarding

**Files:**
- Modify: `packages/gateway/src/windows-onboarding.ts`
- Test: `packages/gateway/test/windows-onboarding.test.ts`

**Interfaces:**
- Produces: `reconcileWindowsOwnedNetworkState(configPath: string, runtime: CliRuntime, signal?: AbortSignal): Promise<void>`.

- [x] Add failing tests proving Windows wrappers forward `reconcileOwned`; Advanced owns exact listener/public-origin mutations across crash, rejection, restart failure, mode switch, Later, and uninstall; cleanup constructs installed helper/SQLite adapters without an operator token, calls all modes sequentially, closes storage, and rejects without deletion when any mode fails.
- [x] Run focused tests and confirm the exported operation is missing.
- [x] Extract a shared production adapter builder; implement the exported bounded cleanup function with `try/finally` closure and no unlink/delete operation.
- [x] Run Windows onboarding, network onboarding, LAN, and Tailscale tests.

### Task 6: Verification and report

**Files:**
- Modify: `.superpowers/sdd/task-11-network-security-report.md`

- [x] Run focused network/storage/Windows tests.
- [x] Run Gateway typecheck and build.
- [x] Run the full Gateway suite.
- [x] Run exact-path `git diff --check`, inspect staged names/stat, and confirm no shell uninstall file is included.
- [x] Update the report with red/green evidence, cleanup signature, verified findings, and final gate counts.
- [x] Commit only owned implementation/tests/design/plan/report paths.

### Task 7: Existing authority database proof

**Files:**
- Modify: `packages/gateway/src/windows-onboarding.ts`
- Test: `packages/gateway/test/windows-onboarding.test.ts`

- [ ] Add failing tests for missing, directory, symlink/reparse, unreadable, and outside-install-root database paths; assert no blank database is created.
- [ ] Add a passing regression for an existing custom configured database path inside the protected install root.
- [ ] Implement pre-open local regular-file/readability/canonical proof, helper `protectPath` proof, and a second local proof immediately before `openStorage`.
- [ ] Run the Windows onboarding and cleanup CLI tests.

### Task 8: Account-scoped preference rollback

**Files:**
- Modify: `packages/gateway/src/tailscale-mode.ts`
- Test: `packages/gateway/test/tailscale-mode.test.ts`

- [ ] Add a failing account-switch rollback test with preference values matching the old wizard state; assert no preference getter/helper mutation, typed `account_changed`, and retained ownership.
- [ ] Route every preference rollback through a fresh keyed status/account guard.
- [ ] Run all Tailscale mode tests.

### Task 9: Settled cleanup deadlines

**Files:**
- Modify: `packages/gateway/src/cli.ts`
- Modify: `packages/gateway/src/windows-onboarding.ts`
- Modify: `packages/gateway/src/windows-helper.ts`
- Modify: `packages/gateway/src/tailscale-cli.ts`
- Test: `packages/gateway/test/windows-onboarding.test.ts`
- Test: `packages/gateway/test/windows-helper-client.test.ts`
- Test: `packages/gateway/test/tailscale-cli.test.ts`

- [ ] Add failing fake-runtime cleanup tests proving abort settlement precedes the next adapter and SQLite close while all three adapters are attempted.
- [ ] Add real spawned-process tests proving timeout/abort waits for child close.
- [ ] Add optional `AbortSignal` parameters to `CliRuntime` restart/readiness methods and pass them through production listener cleanup.
- [ ] Implement a 120-second total deadline with bounded sequential per-adapter controllers and collected failures.
- [ ] Make helper and Tailscale process runners kill then await child close before rejecting.
- [ ] Run focused cleanup/runtime/process tests, full Gateway tests, typecheck, build, diff check, and update the security report.

# Durable Network Second-Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LAN listener, Tailscale preference, and Windows uninstall reconciliation durable across every reviewed crash boundary.

**Architecture:** Extend existing SQLite ownership records rather than add a second journal. LAN adopts the exact post-CAS revision and journals rollback/restart intent; Tailscale journals preference restorations before helper writes. A token-independent Windows factory builds the same production adapters for onboarding and cleanup.

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
- Produces: schema-v2 `LanListenerOwnership` with `provisional | active | rollback-restart-required` phase.

- [ ] Add a failing resume test where the durable `after.persistenceRevision` is stale but all semantic listener fields match the post-CAS state; assert ownership adopts the observed revision before restart/promotion.
- [ ] Run `pnpm exec vitest run test/lan-mode.test.ts -t "adopts the exact applied listener revision"` and confirm the current `rollback_failed` result.
- [ ] Implement semantic intent matching plus CAS replacement with the exact observed state.
- [ ] Add a failing test where reverse CAS succeeds, restart fails, and a new adapter's `reconcileOwned` must retry restart before removing ownership.
- [ ] Run the focused test and confirm ownership is currently removed before restart.
- [ ] Journal `rollback-restart-required` before reverse CAS; reconcile current `after` or `before`, restart `before`, then conditionally remove authority.
- [ ] Run all LAN tests.

### Task 2: Production Windows LAN runtime regression

**Files:**
- Modify: `packages/gateway/src/windows-onboarding.ts`
- Test: `packages/gateway/test/windows-onboarding.test.ts`

**Interfaces:**
- Consumes: exact managed listener snapshot revisions.
- Produces: shared installed network-adapter construction used by controller and cleanup.

- [ ] Add a failing production-runtime test that performs the real managed-listener CAS, interrupts before promotion, and resumes from SQLite with the new exact revision.
- [ ] Confirm the test fails because the durable record contains the pre-CAS revision.
- [ ] Extract the production LAN runtime builder and ensure the adapter adopts/persists the applied revision.
- [ ] Run the Windows onboarding and LAN focused tests.

### Task 3: Tailscale preference write-ahead journal

**Files:**
- Modify: `packages/gateway/src/tailscale-mode.ts`
- Test: `packages/gateway/test/tailscale-mode.test.ts`

**Interfaces:**
- Consumes: schema-v2 `TailscaleMappingOwnership` CAS.
- Produces: provisional ownership before preferences and a CAS-appended restoration before each helper write.

- [ ] Add failing ordering tests for both preferences: ownership creation/replacement must occur before `setPreference`.
- [ ] Add crash-resume tests using the durable row captured at each failure injection boundary; `reconcileOwned` must conditionally restore only the still-wizard value.
- [ ] Confirm current tests fail because ownership is written after both preference changes.
- [ ] Move ownership validation/creation before preferences and add a narrow CAS journal helper invoked before each mutation.
- [ ] Run all Tailscale mode/CLI/storage tests.

### Task 4: Exact mapping remains after removal

**Files:**
- Modify: `packages/gateway/src/tailscale-mode.ts`
- Test: `packages/gateway/test/tailscale-mode.test.ts`

**Interfaces:**
- Produces: immediate `TailscaleModeReadinessError("mapping")` while retaining ownership.

- [ ] Add a failing prepare-failure rollback test where removal returns success but reinspection still sees the exact mapping.
- [ ] Confirm the original injected error currently escapes instead of typed `mapping`.
- [ ] Throw typed mapping failure from exact rollback and keep ownership.
- [ ] Run the focused Tailscale test.

### Task 5: Production cleanup and required wrapper forwarding

**Files:**
- Modify: `packages/gateway/src/windows-onboarding.ts`
- Test: `packages/gateway/test/windows-onboarding.test.ts`

**Interfaces:**
- Produces: `reconcileWindowsOwnedNetworkState(configPath: string, runtime: CliRuntime, signal?: AbortSignal): Promise<void>`.

- [ ] Add failing tests proving Windows wrappers forward `reconcileOwned`, Advanced is non-mutating, cleanup constructs installed helper/SQLite adapters without an operator token, calls both modes sequentially, closes storage, and rejects without deletion when either mode fails.
- [ ] Run focused tests and confirm the exported operation is missing.
- [ ] Extract a shared production adapter builder; implement the exported bounded cleanup function with `try/finally` closure and no unlink/delete operation.
- [ ] Run Windows onboarding, network onboarding, LAN, and Tailscale tests.

### Task 6: Verification and report

**Files:**
- Modify: `.superpowers/sdd/task-11-network-security-report.md`

- [ ] Run focused network/storage/Windows tests.
- [ ] Run Gateway typecheck and build.
- [ ] Run the full Gateway suite.
- [ ] Run exact-path `git diff --check`, inspect staged names/stat, and confirm no shell uninstall file is included.
- [ ] Update the report with red/green evidence, cleanup signature, verified findings, and final gate counts.
- [ ] Commit only owned implementation/tests/design/plan/report paths.

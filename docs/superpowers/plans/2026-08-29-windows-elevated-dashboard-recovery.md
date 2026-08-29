# Windows Elevated Dashboard Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the non-elevated Windows installer safely recover a stale higher-integrity Hermes Dashboard through one narrowly scoped UAC helper, then ship the validated result as CozyGateway v0.4.0.

**Architecture:** Keep the shared Bash installer in the current-user context. Extend its generated PowerShell 5.1 ownership helper with a strict `Owned | Foreign | Indeterminate` classifier, stable exit codes, and double-snapshot PID/creation-time validation; only an `Indeterminate` normal run may launch one elevated helper invocation. Preserve all macOS/Linux paths and the existing session-token lifecycle.

**Tech Stack:** Bash, Windows PowerShell 5.1, Pester-free PowerShell test harnesses, pnpm/TypeScript release checks, GitHub Actions/releases.

## Global Constraints

- Never authorize termination from port, HTTP behavior, process name, owner, session, or ancestry names alone.
- A conclusively foreign listener never triggers UAC and is never terminated.
- Only the generated ownership helper may elevate; the bootstrap and installer remain non-elevated.
- The elevated helper independently reacquires and validates the listener; it does not trust a caller-supplied PID or ownership result.
- Require matching listener PID and process creation time plus a second `Owned` classification immediately before tree termination.
- Exit codes are `0` for absent/released, `42` for foreign, `43` for inaccessible required metadata, and `45` for race/termination/port-release failure.
- The elevated child never requests another elevation.
- Remain compatible with Windows PowerShell 5.1 and safely handle paths containing spaces.
- Never pass or log credentials, session tokens, setup codes, or provider secrets in the elevated command.
- macOS and Linux behavior remains unchanged.

---

### Task 1: Tri-state ownership and race-safe stop helper

**Files:**
- Modify: `scripts/test/windows-dashboard-owner.test.ps1`
- Modify: `scripts/agent-install.sh`

**Interfaces:**
- Produces: `Test-CozyDashboardOwner` returning the strings `Owned`, `Foreign`, or `Indeterminate`.
- Produces: helper process exit codes `0`, `42`, `43`, and `45` as defined in Global Constraints.
- Produces: a second listener/process snapshot check keyed by PID and creation time before `taskkill.exe /T /F`.

- [ ] **Step 1: Add failing classifier cases**

Add table-driven snapshots to `windows-dashboard-owner.test.ps1` for Alex's four-`python.exe` ancestry ending in `hermes.exe`: null `ExecutablePath`/`CommandLine` must equal `Indeterminate`; the same readable under-root command chain must equal `Owned`; readable wrong root, command grammar, subcommand, and port must each equal `Foreign`. Assert that same-user/session/name/port evidence with missing paths never becomes `Owned`.

- [ ] **Step 2: Add failing race cases**

Extract the generated helper and stub listener/process snapshot acquisition so a changed PID, changed creation time, second-pass metadata loss, and second-pass mismatch each avoid `taskkill.exe` and exit `45`.

- [ ] **Step 3: Prove red**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-dashboard-owner.test.ps1
```

Expected: failures because the current boolean classifier maps hidden metadata to foreign and has no creation-time revalidation.

- [ ] **Step 4: Implement the minimal tri-state classifier**

In the PowerShell emitted by `write_dashboard_owner_helper`, return `Foreign` only when readable evidence contradicts an accepted Hermes shape; return `Indeterminate` when a required path or command line is inaccessible; return `Owned` only when the complete normalized path, command grammar, `dashboard` position, and exact port are proven. Preserve the currently accepted direct launcher, under-root Python/module, and under-root `main.py` shapes.

- [ ] **Step 5: Implement double-snapshot termination**

Capture the listener PID and process creation time, reacquire the loopback listener and process immediately before termination, require exact equality and a second `Owned` classification, then run the existing tree kill and verify port release. Map foreign, indeterminate, and race/stop failures to the exact exit codes above.

- [ ] **Step 6: Prove green and regression coverage**

Run both commands and require exit code 0:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-dashboard-owner.test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
```

- [ ] **Step 7: Commit**

```powershell
git add scripts/agent-install.sh scripts/test/windows-dashboard-owner.test.ps1
git commit -m "fix: classify Windows Dashboard ownership safely"
```

### Task 2: One-shot scoped UAC recovery

**Files:**
- Modify: `scripts/test/windows-bootstrap.test.ps1`
- Modify: `scripts/agent-install.sh`

**Interfaces:**
- Consumes: helper exit-code contract from Task 1.
- Produces: `stop_stubborn_windows_dashboard` behavior that elevates exactly once only after normal exit `43`.

- [ ] **Step 1: Add failing installer-harness cases**

Extend the bootstrap harness with deterministic `powershell.exe`/`Start-Process` doubles. Assert: normal `43` invokes exactly one `-Verb RunAs -Wait -PassThru` helper; elevated `0` continues; normal `42` never elevates; cancellation/launch failure reports a scoped-UAC recovery instruction; elevated `42`, `43`, `45`, and unexpected codes fail without retry; and no token/secret appears in captured arguments or logs.

- [ ] **Step 2: Add path-quoting cases**

Use expected root, Hermes executable, helper path, and launcher path fixtures containing spaces and apostrophes. Require the elevated helper to receive each original value as one distinct `-File` argument under Windows PowerShell 5.1 parsing.

- [ ] **Step 3: Prove red**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
```

Expected: failures because current wrapper treats `43` as a generic foreign-owner failure and never requests UAC.

- [ ] **Step 4: Implement the normal wrapper mapping**

Call the helper non-elevated first and branch on its exact code. Continue on `0`; preserve the ownership-safety failure on `42`; on `43`, print one informational line and launch a generated PowerShell 5.1 elevation wrapper; map `45`/unexpected values to a verified-owner recovery failure.

- [ ] **Step 5: Implement safe one-shot elevation**

Have the elevation wrapper call `Start-Process powershell.exe -Verb RunAs -Wait -PassThru` with an argument array carrying `-NoProfile`, `-NonInteractive`, `-ExecutionPolicy Bypass`, `-File`, helper path, expected root, Hermes executable, launcher, port, and an elevated-child marker. The child marker disables recursive elevation. Catch UAC cancellation/denial/unavailability and emit the manual-close/rerun instruction. Do not pass environment secrets.

- [ ] **Step 6: Prove green**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-dashboard-owner.test.ps1
```

Expected: both scripts exit 0 and report all assertions passing.

- [ ] **Step 7: Commit**

```powershell
git add scripts/agent-install.sh scripts/test/windows-bootstrap.test.ps1
git commit -m "fix: elevate stale Dashboard recovery helper"
```

### Task 3: Release metadata, full validation, and v0.4.0 delivery

**Files:**
- Modify: `packages/gateway/package.json`
- Modify: `integrations/attach-plugin/plugin.yaml`
- Modify: `packages/gateway/src/cli.ts`
- Modify only if current release convention requires it: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: completed installer recovery from Tasks 1-2.
- Produces: all three release-version sources set to plain semantic version `0.4.0`.

- [ ] **Step 1: Inspect and update the exact release-version sources**

Use `packages/gateway/test/release-version.test.ts` as the authority for the three locations, change each from `0.3.9` to `0.4.0`, and update the lockfile only through the repository package-manager workflow if it records the workspace version.

- [ ] **Step 2: Run focused Windows and release tests**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-dashboard-owner.test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-bootstrap.test.ps1
pnpm --filter @cozygateway/gateway test -- release-version.test.ts release-assets.test.ts
```

Expected: all commands exit 0.

- [ ] **Step 3: Run the complete repository verification**

```powershell
pnpm check
pnpm bundle
bash scripts/test/hermes-installer.test.sh
```

Expected: builds, typechecks, unit/integration tests, release bundle, and shared installer suite all exit 0.

- [ ] **Step 4: Validate the Windows lifecycle on this host**

Use disposable CozyGateway/Hermes homes and the local vLLM 27B provider. Validate clean install, authenticated Dashboard `/api/config`, Gateway `/health`, attach readiness, rerun, and uninstall. Then reproduce the higher-integrity stale-Dashboard case, approve the scoped UAC prompt, and confirm only that Dashboard tree stops and the installer-owned session-token Dashboard replaces it. Do not alter unrelated user profiles or the dirty main checkout.

- [ ] **Step 5: Commit release metadata**

```powershell
git add packages/gateway/package.json integrations/attach-plugin/plugin.yaml packages/gateway/src/cli.ts pnpm-lock.yaml
git commit -m "chore: release v0.4.0"
```

- [ ] **Step 6: Obtain final whole-branch review**

Package the diff from merge-base `602f89a` through `HEAD`. Require the reviewer to evaluate spec compliance and code quality, including ownership safety, PID-reuse protection, PS5.1 quoting, non-recursive elevation, secret hygiene, test validity, and release metadata. Resolve every Critical or Important finding and re-review.

- [ ] **Step 7: Publish upstream only after fresh verification**

Push the `codex/windows-elevated-dashboard-recovery` branch, open a PR targeting `main`, wait for required CI, merge only when green, tag the resulting main commit `v0.4.0`, push the tag, wait for the release workflow, and verify the published release assets and checksums from GitHub.

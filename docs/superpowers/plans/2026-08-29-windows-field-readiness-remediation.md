# Windows Field-Readiness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development task-by-task.

**Goal:** Close the bounded Windows installer and onboarding readiness findings without performing live installation, firewall, Task, or process mutation.

**Architecture:** Keep privileged/native inspection in the fixed PowerShell helper, bootstrap it from a checksum-verified temporary path, and keep the shared Bash installer responsible for early port ownership and recovery uninstall ordering. Keep onboarding policy in the Windows controller: show platform-specific disclosure, preserve Unicode labels, inspect LAN safety without changing firewall state, and refuse non-phone-reachable Advanced origins.

**Tech Stack:** Windows PowerShell 5.1, Bash, TypeScript, Vitest.

## Global Constraints

- Test-first red/green cycles are required for every behavior change.
- Do not mutate live firewall, Tailscale, Scheduled Task, Startup, or process state during verification.
- Do not touch network-onboarding, CLI, phone/server, tailscale, LAN, or storage implementation files.
- Defer Tailscale owned-mapping uninstall wiring until the durable-network slice exposes an exact bounded teardown command.

---

### Task 1: UTF-8 and installer trust boundary

**Files:** `scripts/test/windows-bootstrap.test.ps1`, `scripts/test/windows-helper.test.ps1`, `scripts/install.ps1`, `scripts/cozygateway-windows-helper.ps1`

- [ ] Add a real PowerShell 5.1 bootstrap-to-helper regression using a non-ASCII custom root and verify it fails for the transport bug.
- [ ] Add helper regressions for a dedicated safe install root, unsafe/reparse roots, and private root/bin/helper/runtime ACLs.
- [ ] Replace the text pipeline with explicit UTF-8 process stdin/stdout.
- [ ] Verify the helper in a temporary path, use it to validate and harden the root/bin before installing executable assets, then protect helper/runtime paths.
- [ ] Run both PowerShell suites after each red/green cycle.

### Task 2: Port preflight and damaged uninstall

**Files:** `scripts/test/hermes-installer.test.sh`, `scripts/agent-install.sh`

- [ ] Add an occupied-port regression that reports PID/process/action and leaves no installer state, plugins, Task, or Startup entry.
- [ ] Add a missing-install-state Windows uninstall regression proving Task, Startup, and managed process cleanup precede file deletion.
- [ ] Move the Windows port ownership check before state/plugin/service mutation and retain bounded managed-update behavior.
- [ ] Share Windows persistence/process teardown across normal and damaged uninstall paths.
- [ ] Run the installer suite.

### Task 3: Windows onboarding safety and disclosure

**Files:** `packages/gateway/test/windows-onboarding.test.ts`, `packages/gateway/src/windows-onboarding.ts`, `packages/gateway/test/windows-helper-client.test.ts`, `packages/gateway/src/windows-helper.ts`, `scripts/test/windows-helper.test.ps1`, `scripts/cozygateway-windows-helper.ps1`

- [ ] Add failing tests for the Windows LAN/Tailscale disclosure copy and removal of the after-logout promise.
- [ ] Add a failing Unicode adapter-name presentation test.
- [ ] Add failing Advanced tests for wildcard/loopback rejection and a concrete phone-reachable origin.
- [ ] Add helper/client regressions for network profile and active firewall-policy inspection.
- [ ] Implement read-only LAN safety inspection and specific guidance before verification QR publication.
- [ ] Run focused TypeScript and helper suites.

### Task 4: Documentation, verification, and report

**Files:** `docs/agent-install.md`, `docs/install-service.md`, `.superpowers/sdd/task-11-windows-report.md`

- [ ] Document usable Windows uninstall and the read-only network-profile/firewall guidance.
- [ ] Record requirement-by-requirement evidence, deferred owned-mapping integration, and any technically rejected review claims.
- [ ] Run focused PowerShell/helper/bootstrap/installer tests, gateway tests, build/typecheck, and diff checks.
- [ ] Commit the bounded Windows remediation and report the commit and fresh evidence.

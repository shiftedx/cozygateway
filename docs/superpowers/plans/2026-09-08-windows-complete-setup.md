# Windows complete setup implementation

1. Implement native same-user installer session handoff and its isolated tests; inline the functions into `scripts/install.ps1` so published one-liners need no unsigned helper download. Capture source/parameters at entry, call before install-home resolution, return child status without exiting an interactive caller.
2. Repair Windows bootstrap locking and transaction crash windows in `scripts/install.ps1`; test real concurrent processes and interrupted initialization in `scripts/test/windows-bootstrap-durability.test.ps1`.
3. Implement supported harness update wrappers (`Update-CozyAgentsHarness`, `Update-HermesHarness`) with strict success evidence and tests. Inline into the single-file Windows bootstrap.
4. Change Windows orchestration: recorded selection by default, no optional pairing prompt on updates, lock before Hermes changes, gateway transaction commit before Agents changes, and per-component non-secret receipts through `Invoke-WindowsSetupStage`. Preserve profiles and current custom homes. Test failure then rerun rather than pretending all products roll back together.
5. Retry transient Windows downloads into private sibling staging; verify bounds and permanent failure behavior.
6. Integrate session stubbing solely in fixture-generated installer source, update Windows bootstrap fixtures for real updater commands and successful JSON evidence, and add the new tests to Windows CI/package test command.
7. Bootstrap a private Git for Windows when Bash is missing. Require the official release asset's SHA-256, stage and validate Bash before promotion, preserve the previous private installation on failure, and avoid machine-wide installation or PATH changes.
8. Require the live Gateway version to match the verified bundle, with configured Hermes attachments online, before committing. Probe configured HTTP or pinned TLS with bounded requests. Stop only verified registered Gateway processes before restoring rollback assets.
9. Run targeted Windows tests under PS5.1/7 and native session smoke checks, perform independent review, and document real-elevation qualification limits. Verify the diff contains no shared shell/macOS/Linux installer changes.

Subagents own independent function ranges or separate staging files. Root owns integration and orchestration. No user credentials, databases, bot state or generated release artifacts are committed.

## Qualification boundaries

Fixture suites isolate service registration, PATH changes, pairing, and upstream installers. They exercise full Windows orchestration but do not substitute for a live supported Windows account updating real products. Native tests separately cover process locks, HTTP/TLS readiness, and official Portable Git download, digest verification, extraction and reuse.

The installer-session suite exposes `-ElevatedIntegration` for a Windows interactive desktop with UAC enabled. That check must run from an elevated shell to prove the desktop-parent handoff on the target environment. Native child launch tests from a limited-token shell cover the same process-creation path but cannot alone qualify the elevated transition. The installer refuses ambiguous account/session ownership rather than installing into another account. Initial real elevated tests exposed an identification-only linked token; direct token launch was replaced with the verified desktop parent process attribute.

Kyle ran `windows-installer-session.test.ps1 -ElevatedIntegration` from Administrator Windows PowerShell and supplied the passing console result on September 7, 2026 (local time). This confirms the real elevated transition, including the test child's identity, environment, arguments, working directory and exit status. It does not represent a full live update of third-party products.

Component receipts retain incomplete harness selection and custom homes. Gateway rollback covers its owned assets and registration. Hermes and CozyAgents use their own updater contracts; the bootstrap does not promise cross-product rollback or overwrite pairing and model state to recover an unrelated component failure.

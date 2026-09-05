# Windows qualification status — 2026-09-04

This change set addresses Windows installation and runtime compatibility, integration regressions, and test reliability. It is not a declaration that the release is fully Windows-qualified. All **29 final native acceptance cases remain pending**. Earlier partial native observations do not qualify the final candidate pair.

Fresh installation attempts using published predecessors exposed archive AppleDouble metadata and Windows MAX_PATH failures. No final paired deployment was achieved. Code integration and release qualification are separate decisions; merging these fixes does not close the native acceptance matrix.

## Changes covered by this work

- The Windows installer reloads a persisted absolute Node identity using native path semantics, with a regression wired into Windows CI.
- Runner-lane tests wait for the server to release pending connection capacity after a rejected or closed client, preserving the capacity assertions.
- Mobile request deadlines stay within the Gateway request budget. Hermes roster loading handles a connection established before bridge startup.
- The paired Agents work adds private native file creation and credential replacement, durable supervision recovery, Windows Git/path guards, and bounded journal/cache validation. These improvements require final paired native validation together with Gateway.

## Automated results

Final Gateway source: `d1fdcb6062924b93f9e235f3b2f061d9200fa71b`. The broad suites below preceded the final installer and CI changes; they are not represented as full-suite runs of the final revision.

| Check | Source | Result |
| --- | --- | --- |
| Full Windows check, including build and type checking | `f5dd56e` | 1,706 passed, 18 skipped |
| Full Linux/WSL check, including build and type checking | `6d4494d` | 1,708 passed, 16 skipped |
| Changed native Node-identity regression | `2b92500` | Exit 0 |
| Final bundle build | `d1fdcb6062924b93f9e235f3b2f061d9200fa71b` | Exit 0 |
| Paired smoke using the final new bundles | Final bundle pair | Exit 0; pairing/handshake, Gateway restart with automatic reconnect and retained pairing, runner restart with retained identity, and secret-free logs |

The Windows bootstrap, transaction, Agents bootstrap, Dashboard ownership, and spool checks passed, as did package lint and audit. The final changes after the broad suites concern the installer and CI. The final Linux installer suite passed at `d1fdcb6062924b93f9e235f3b2f061d9200fa71b` with all seven POSIX installer scripts complete (exit 0). The final full Windows Hermes installer suite also passed at this source (exit 0), including the historical native Node-identity and foreign-registration regressions.

Exclusions include macOS-only cases and 14 deliberate skips for unavailable optional Gateway conformance hooks. POSIX checks ran under WSL. Two Linux Hermes cases were skipped; two real Hermes tests passed on Windows with their prerequisites available. The paired Agents full gates passed at `ad7d78fa28abc71f6b65c369a8c7bf2e6d71667b`: Windows 2,973 passed/13 skipped and Linux 2,971 passed/15 skipped, using four workers and unchanged test deadlines. Native POSIX lifecycle was skipped because the systemd user manager was unavailable.

These automated and bounded smoke results do not qualify the 29 final installed-product native acceptance cases below.

## Native work still unverified

All 29 final native cases remain open, including real predecessor-to-candidate upgrades and preservation; checksum, locked/interrupted update, rollback and repair faults; credentials and nondefault ports; foreign registration/ownership refusal; uninstall; and actual user-session and machine transitions. Scheduler and Startup fallback are distinct paths and require separate evidence where supported. Fixture coverage and prepared fault scripts do not count as successful installed-product acceptance.

## Manual session and reboot checklist for Kyle

Logoff/logon and reboot are deferred. Perform them only after a real candidate Gateway and Agents deployment is installed, paired, and healthy. Record each product's exact source/release version and asset hashes with the result.

1. Establish the baseline in the intended Windows user account. Verify Gateway health on its configured address and port, the runner's attached state, and a ready Bot. Send a unique prompt through the paired client and confirm a new response from the configured real model. Record the runner/Bot identities and a workspace sentinel. Preserve config, pairing, and SQLite integrity/row baselines in private evidence; do not publish credentials or raw database contents.
2. Identify the actual launch mechanism for each installed product. For Scheduler, confirm its current-user task points to the intended installation and Node binary. For a supported Startup-fallback lane, confirm the owned Startup entry points to that installation and no duplicate task masks the fallback. Use separate evidence for each mechanism; do not alter unrelated registrations.
3. **Logoff/logon:** sign out of Windows through the account menu, then sign back into the same account. Closing a terminal, locking the screen, or restarting a process does not satisfy this step. Before manually launching either product, check that its installed launch mechanism started it. Verify Gateway health, runner attachment, and Bot readiness within the documented startup window.
4. Confirm the same configuration, pairing identities, persistent SQLite records, prior chat history, and workspace sentinel survived. Send another unique paired prompt and require a new real-model response. Record launch mechanism, observed processes, readiness, and preservation results. If manual repair was needed, record a failure for automatic recovery before repairing.
5. **Reboot:** after restoring a healthy baseline, use Windows Restart and sign back into the same account. Repeat the automatic-start, readiness, preservation, and real-model request checks before manually launching either product. Record this as a separate case from logoff/logon.
6. Repeat the applicable transitions for Scheduler and the supported Startup-fallback lane. A Scheduled Task result does not qualify Startup fallback, and vice versa. Keep each case pending or failed unless its actual transition and all checks were observed.

Successful completion of this checklist closes only the specific transition cases exercised. The remaining native matrix cases still require their own installed-product evidence.

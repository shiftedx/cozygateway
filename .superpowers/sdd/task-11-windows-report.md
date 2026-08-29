# Task 11 — Windows field-readiness remediation

## Scope and technical disposition

1. **PowerShell 5.1 UTF-8 transport:** reproduced with the real bootstrap/helper subprocess and a
   runtime-constructed `Gäteway 你好` root. Replaced the PowerShell text pipeline with explicit UTF-8
   bytes on redirected standard input and strict UTF-8 output decoding. The regression runs the
   release/bootstrap/helper pipeline, not a direct helper-only shortcut.
2. **Installer trust boundary:** the verified helper is staged outside the install root, validates
   the dedicated root, rejects reparse points and existing roots writable by an untrusted SID, and
   establishes current-user/SYSTEM-only protected DACLs before executable assets land in `bin`.
   Helper, installer, bundle, and present private runtime paths are protected idempotently. Custom
   roots use the same exact-root checks.
3. **Logout promise:** removed the unsupported “reachable after logout” wording. Consent now says
   only that Tailscale may run unattended in the background and that sleep disconnects it.
4. **Windows network/firewall:** implemented read-only selected-adapter network-category and active
   firewall-profile inspection. Public/unknown/disabled/default-block postures produce specific
   Windows Settings/Windows Security guidance. The installer creates no firewall rule. This is the
   safer bounded response because exact rule ownership, elevation consent, rollback, and uninstall
   metadata do not exist in the current installer contract; adding a broad or unowned rule would
   make the review finding worse.
5. **Unicode adapters:** removed ASCII scrubbing. Control characters are neutralized, while Unicode
   display names are preserved and code-point bounded in the selection UI.
6. **Advanced origin:** Advanced input rejects wildcard, localhost, IPv6 loopback, and all IPv4
   loopback addresses unless a separate concrete public origin exists. Inspection also fails closed
   on a non-phone-reachable origin, preventing it from reaching verification or pairing QR output.
7. **Gateway port:** new Windows installs inspect the target port before Node bootstrap or install
   state mutation. Existing installs inspect after their saved port is parsed but before config,
   plugin, Task, or Startup mutation. Conflicts report PID, process name, stop/process-or-`--port`
   action, and an explicit no-state-changed statement.
8. **Damaged uninstall:** missing/corrupt install state now follows the Windows recovery teardown:
   delete the exact `CozyGateway` Task, remove its exact Startup entry, stop only a process whose
   command line names this install's exact config path, remove the user PATH entry, then remove the
   root. Healthy Windows uninstall is also platform-guarded so it never invokes Linux `systemctl`.
   The public Windows PowerShell uninstall command is documented.
9. **Owned Tailscale mapping teardown:** intentionally deferred on root-agent direction. No
   speculative/no-op seam was added. The durable-network slice now exposes exact
   `reconcileOwned()` APIs; root will wire the sequential pre-uninstall integration after both
   slices, preserving unrelated Tailscale state.

The shared disclosure seam is integrated in the Windows tests and controller flow. Disclosure is
awaited by the orchestrator before adapter preparation; the shipped CLI copy covers LAN plaintext
and wildcard exposure plus the requirement that Tailscale be active on the phone/PC and that shared
peers/tailnet administrators may reach or observe the device.

## Test-first evidence

- The helper test first failed with `command:"invalid"` for `prepare-install-root` and
  `inspect-network-safety`, then passed after the fixed helper commands were implemented.
- The real bootstrap test first failed at `initialize-pending` for the non-ASCII PowerShell pipeline,
  then passed after byte-safe transport and idempotent DACL handling.
- The installer test first failed because damaged uninstall emitted no native teardown log, then
  advanced to the occupied-port diagnostic/no-partial-install assertions after teardown/preflight
  implementation.
- TypeScript tests first failed because `inspectNetworkSafety` did not exist, Unicode selection was
  scrubbed, and Advanced reused/advertised loopback. Focused Windows onboarding/helper-client tests
  now exercise those exact behaviors.

## Final verification

- `scripts/test/windows-helper.test.ps1` — passed.
- `scripts/test/windows-bootstrap.test.ps1` — passed, including the real non-ASCII bootstrap/helper
  pipeline and disposable-root DACL assertions.
- `scripts/test/windows-dashboard-owner.test.ps1` — passed.
- `scripts/test/hermes-installer.test.sh` — passed after the final uninstall platform guard.
- Windows onboarding/helper-client Vitest focus — 19/19 passed.
- Gateway package build and typecheck — passed.
- Full workspace recursive build and typecheck — passed.
- Bash syntax and `git diff --check` — passed (Git reported only the repository's expected Windows
  LF-to-CRLF checkout warnings).

## Verification boundary

All tests use fixtures/fake native tools or disposable paths. No live CozyGateway install,
Scheduled Task, Startup entry, process stop, firewall mutation, Tailscale preference, or Tailscale
Serve operation was performed.

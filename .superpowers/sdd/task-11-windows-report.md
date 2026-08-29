# Task 11 — Windows field-readiness remediation

## Scope and technical disposition

1. **PowerShell 5.1 UTF-8 transport:** reproduced with the real bootstrap/helper subprocess and a
   runtime-constructed `Gäteway 你好` root. Replaced the PowerShell text pipeline with explicit UTF-8
   bytes on redirected standard input and strict UTF-8 output decoding. The regression runs the
   release/bootstrap/helper pipeline, not a direct helper-only shortcut.
2. **Installer trust boundary:** the verified helper is staged outside the install root, validates
   the dedicated root, rejects untrusted root/parent owners, parent replace/DeleteChild,
   ChangePermissions, and TakeOwnership authority (including effective inherited ACEs), reparse
   points at root/bin/runtime/helper, and existing roots writable by an untrusted SID, and
   establishes current-user/SYSTEM-only protected DACLs before executable assets land in `bin`.
   Helper, installer, bundle, and present private runtime paths are protected idempotently. Custom
   roots use the same exact-root checks.
3. **Logout promise:** removed the unsupported “reachable after logout” wording. Consent now says
   the PC and Gateway must remain awake and the Windows user session must remain running.
4. **Windows network/firewall:** implemented read-only selected-adapter network-category and active
   firewall-profile inspection. Public/unknown/disabled/default-block postures produce specific
   Windows Settings/Windows Security guidance. The installer creates no firewall rule. This is the
   safer bounded response because exact rule ownership, elevation consent, rollback, and uninstall
   metadata do not exist in the current installer contract; adding a broad or unowned rule would
   make the review finding worse.
5. **Unicode adapters:** removed ASCII scrubbing. Control characters are neutralized, while Unicode
   display names are preserved and code-point bounded in the selection UI.
6. **Advanced origin:** Advanced input rejects wildcard, localhost (including a trailing dot), IPv6
   loopback/mapped-loopback, and URL-normalized IPv4 forms such as `127.1`, integer, octal, and hex
   loopback unless a separate concrete public origin exists. Inspection also fails closed
   on a non-phone-reachable origin, preventing it from reaching verification or pairing QR output.
7. **Gateway and Dashboard ports:** Windows PowerShell inspects the Gateway target port before Hermes/model setup, release
   assets, tokens, or install-state mutation. Existing installs use the saved port unless explicitly
   overridden. Conflicts report PID, process name, stop/process-or-`--port`
   action, and an explicit no-state-changed statement.
   The checksum-verified temporary helper also inspects the Hermes Dashboard port before model,
   install-root, Node runtime, token, state, env, config, plugin, or persistence mutation. It permits
   only a free port or the exact expected Hermes owner. The Bash payload repeats this preflight for
   direct/recovery use and preserves its exact-owned listener restart behavior.
8. **Damaged uninstall and shell cleanup:** database absence skips only network reconcile. When the
   installed shell payload remains, PowerShell still runs its full uninstall to remove plugins,
   profile variables, spools, recorded Hermes lifecycle changes, Task/Startup persistence, exact
   process, PATH, and safe files. Native file removal is limited to a genuinely missing shell
   payload with authority proven absent.
9. **Owned network teardown:** healthy PowerShell uninstall now runs the installed internal
   `cleanup-owned-network` command before any Bash/native persistence, process, PATH, database, or
   file deletion. A nonzero result aborts with the full authority intact. The command reconciles
   exact recorded LAN/Tailscale ownership and preserves unrelated Tailscale state. Native damaged
   fallback is limited to definitely absent database authority. New installs persist a protected
   `network-authority.json` with the exact database path. If config/locator damage makes a legacy
   external path unknowable, uninstall deactivates exact CozyGateway persistence/process and recorded
   Hermes activity but retains the root with repair guidance. If a configured/located/default
   database or SQLite WAL/SHM sidecar remains, missing/corrupt bundle, runtime, or config fails closed
   with the entire install preserved.

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
- Second-review helper regressions failed on hostile ownership, parent replacement authority, and
  child reparse boundaries before the owner-aware DACL and parent checks were added.
- The real PowerShell bootstrap accepted a live occupied port and proceeded into Hermes/assets
  before the native early preflight was added.
- Advanced accepted `127.1` and mapped IPv6 before URL canonicalization; LAN guidance omitted the
  exact port and Defender navigation before the focused copy regression.
- Healthy uninstall lacked pre-network ordering, while damaged uninstall required Git Bash. The
  bootstrap suite now covers cleanup failure preserving all authority, successful cleanup ordering,
  exact process ownership, and missing-shell native recovery.
- Follow-up parent regressions failed for an untrusted parent owner and effective explicit/inherited
  permission-control rights before the parent owner and full replacement-authority checks landed.
- Follow-up uninstall regressions proved a missing bundle/config could incorrectly classify a
  surviving database as authority-absent. The matrix now covers missing bundle, missing/unreadable
  config, default database, and sidecar-only authority, plus a real bootstrap-to-release-bundle
  cleanup command against a real SQLite database without the cleanup-log seam.
- Final uninstall regressions proved that known-absent network authority incorrectly bypassed the
  healthy shell uninstaller, leaving plugin/profile/spool/Hermes ownership behind. The matrix now
  distinguishes healthy-shell cleanup, protected-locator absence, legacy ambiguous external paths,
  and genuinely missing-shell native recovery.
- The Bash installer initially accepted an unrelated Dashboard listener until after Node/state work.
  The real PowerShell/helper listener regression and Bash fake-native regression now fail before
  model/runtime/state/env/config/plugin/persistence mutation, report exact port/PID/process/action,
  and verify an inspect-only pass never stops an exact-owned listener.

## Final verification

- `scripts/test/windows-helper.test.ps1` — passed.
- `scripts/test/windows-bootstrap.test.ps1` — passed, including the real non-ASCII bootstrap/helper
  pipeline and disposable-root DACL assertions.
- `scripts/test/windows-dashboard-owner.test.ps1` — passed.
- `scripts/test/hermes-installer.test.sh` — passed, including occupied Dashboard preflight,
  inspect-only exact-owner reuse, full shell uninstall, and repair-only deactivation fixtures.
- Windows onboarding/helper/Tailscale Vitest focus — 94/94 passed without unhandled rejections.
- Full workspace recursive test suite — passed.
- Full workspace recursive build and typecheck plus the release bundle — passed.
- Bash syntax and `git diff --check` — passed (Git reported only the repository's expected Windows
  LF-to-CRLF checkout warnings).

## Verification boundary

All tests use fixtures/fake native tools or disposable paths. No live CozyGateway install,
Scheduled Task, Startup entry, process stop, firewall mutation, Tailscale preference, or Tailscale
Serve operation was performed.

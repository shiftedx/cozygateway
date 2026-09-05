# Windows dual agent installation plan

**Goal:** Install Hermes and CozyAgents on the same gateway through the Windows one-liner, preserve either agent when adding the other, and prevent background console windows.

**Approved requirements:** The user selected an initial Hermes / CozyAgents / Both choice and additive later installs. Initial validation used a local model; the operator later moved inference to another host and repaired its tool calling. Follow-up validation uses that replacement host. Do not resume the original loopback endpoint. The initial installer terminal may be visible; background processes must remain hidden. Preserve credentials, profiles, pairing, and listener configuration on repair.

## Tasks

- [x] Extend `scripts/install.ps1` selection, dual orchestration, repair and uninstall state handling. Reuse the Hermes gateway installation and add the CozyAgents runner to that same listener. Explicit single-agent selections on an existing other-agent installation become additive. Show a choice on interactive reruns; unattended repair retains recorded selection. Test selection and orchestration with the Windows fixture suite, including both addition orders and repair.
- [x] Suppress consoles in generated gateway supervisors and CozyAgents command helpers. Use `windowsHide: true` on Windows child launches; review detached launches and persistence wrappers. Add regression coverage for production launch options, then run relevant Windows and runner tests.
- [ ] Inspect and execute the published installer entry point. Use verified release artifacts, document any local overrides needed to validate unreleased fixes. Configure both agents against the local model and verify both registrations and successful model activity.
- [ ] Record visible console window events through installation, runner startup, gateway restart, and agent activity. Keep observation logs outside the repo and report the actual observation interval and any remaining gaps. Leave both agents running and provide the resulting status and source changes.

## Validation

The dual installation and repair completed using local verified build artifacts. Both agents
returned replies through the same gateway before the inference host changed. Console flashes were
reproduced and hidden launchers added; later window snapshots contained no visible agent consoles.
The replacement host now passes a direct automatic tool call, Hermes replied through the gateway,
and the CozyAgents live tool-call readiness probe passes. Deletion of an old failed bot can still
wait behind its recovery retries; final lifecycle qualification and reboot/logon testing remain open.
A test-only WScript dialog was reproduced and its fixture launcher isolated. Hosted CozyAgents
CI could not start because of account billing; record local validation alongside that limitation.
Merging these fixes does not publish new installer release assets.

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-agents-bootstrap.test.ps1`, the Windows bootstrap suite, and relevant shell installer tests after changes. Run CozyAgents runner/process/exec tests and typecheck for its modified helpers. Do not publish releases until there is a concrete tested result and publication authorization.

### September 5 follow-up fixture qualification

An isolated worktree based on merged gateway commit `4f46f9a` exposed another test-only
console risk: the Hermes installer suite's real mock Dashboard child was detached on Windows
without `windowsHide`. The fixture now sets it explicitly. A VM regression executes that
exact fixture source with an injected child-process module; it failed on the missing option
before the fix and passes afterward without launching a process. This does not establish the
cause of the earlier unattributed WindowsTerminal/PseudoConsole observation.

Passing local checks:

- Hidden-supervisor and fixture launch tests: 4/4.
- Complete Windows bootstrap and Windows agents bootstrap suites. The latter covers fresh
  Both, both additive orders, one shared listener, saved Hermes profiles, runner pairing,
  and repair preserving the complete runner model/pairing environment.
- Windows PATH isolation, native transaction helper, Dashboard ownership, and legacy process suites.
- Shell hidden-task, dual-state, state-identity, legacy-wrapper, runtime rollback,
  attach-health diagnosis, and harness-choice suites.
- Complete Hermes installer shell suite, including real mock Dashboard lifecycle,
  duplicate-process ownership refusals, Scheduled Task registration and Startup fallback
  through stubbed service commands.

The process PATH was cleaned with the private validation helper and prepended with Git's
`bin` and `usr/bin`; the user PATH was not changed. The first bootstrap run lacked `cygpath`
on its process PATH; the complete rerun passed after that correction. The optional POSIX
transaction suite failed its symlinked-inventory refusal assertion because Git Bash `ln -s`
created a regular file copy on this host, confirmed with a separate disposable probe. The
native Windows transaction suite passed while explicitly skipping its symlink-privilege case;
the harness-choice suite likewise skipped POSIX mode-bit checks on NTFS.

Live lifecycle/window observations and the post-repair agent checks are recorded separately
by the machine owner. This fixture qualification does not prove a fresh public one-liner,
reboot/logon behavior, or release publication.

Fresh Hermes prerequisites also remain unqualified. `Resolve-Hermes` delegates to the
official Hermes Windows installer; this repository adds no Git long-path ZIP fallback or
Dashboard npm-version/build workaround, and Dashboard startup uses `--skip-build`. The
bootstrap resolves its default home from `LOCALAPPDATA` using `GetFullPath`; the shell
installer retains strict physical-directory ownership checks, but no explicit MSIX
virtualized-path migration is implemented here. The earlier installation needed manual
steps in these areas. The current upstream Hermes installer was not downloaded or executed
during this fixture-only follow-up.

### Repair retry-owner follow-up

A subsequent coordinated repair exposed a production lifecycle gap: stopping the Node
supervisor left its outer WScript launcher in the 60-second retry sleep. A new task run
could then be ignored by `MultipleInstancesPolicy=IgnoreNew`. Cleanup now includes every
exactly owned local/Startup WScript launcher, terminates those before Node, and rechecks
the executable, command arguments, and process creation time immediately before stopping
each process. Existing VBS content validation must succeed before its path becomes an
allowed process identity; foreign launchers and reused PIDs remain untouched.

The no-launch regression reproduces a lone sleeping launcher, multiple owned launchers,
launcher-before-child termination, forged executables, changed commands, and PID reuse.
Its stop loop uses an in-memory taskkill scriptblock, so it cannot launch or terminate a
real process. The original sleeping-launcher test failed before the change and passes
afterward. Legacy ownership and hidden-launch checks also pass. `pnpm build` and
`pnpm bundle` completed successfully; the updated installer artifact SHA-256 is
`46196fa453fe2226fd7de2aa631c51685325fcf74b6e076f3c736dd68787000e`.

The complete post-change Windows bootstrap, dual-agent and Hermes shell suites passed,
as did shell state-identity and hidden-task checks. All service commands in the Hermes
Windows cases were stubbed; the corrected real mock Dashboard lifecycle also passed.

The machine owner subsequently completed a coordinated live repair with installer hash
`46196fa453fe2226fd7de2aa631c51685325fcf74b6e076f3c736dd68787000e`. Settings and pairing
were preserved; the runner environment changed only in byte formatting. Both agents
completed actual tool calls through the gateway. Bot crash recovery returned to ready in
21 seconds. The two previously observed gateway WScript retry owners were replaced by one
gateway launcher and one instance of each expected Node role. This is local-artifact live
repair evidence, not publication or fresh public-installer qualification.

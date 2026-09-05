# Windows dual agent installation plan

**Goal:** Install Hermes and CozyAgents on the same gateway through the Windows one-liner, preserve either agent when adding the other, and prevent background console windows.

**Approved requirements:** The user selected an initial Hermes / CozyAgents / Both choice and additive later installs. Validation uses http://127.0.0.1:1234/v1 and its advertised qwen3.8-27b-nvfp4 model. The initial installer terminal may be visible; background processes must remain hidden. Preserve credentials, profiles, pairing, and listener configuration on repair.

## Tasks

- [ ] Extend `scripts/install.ps1` selection, dual orchestration, repair and uninstall state handling. Reuse the Hermes gateway installation and add the CozyAgents runner to that same listener. Explicit single-agent selections on an existing other-agent installation become additive. Show a choice on interactive reruns; unattended repair retains recorded selection. Test selection and orchestration with the Windows fixture suite, including both addition orders and repair.
- [ ] Suppress consoles in generated gateway supervisors and CozyAgents command helpers. Use `windowsHide: true` on Windows child launches; review detached launches and persistence wrappers. Add regression coverage for production launch options, then run relevant Windows and runner tests.
- [ ] Inspect and execute the published installer entry point. Use verified release artifacts, document any local overrides needed to validate unreleased fixes. Configure both agents against the local model and verify both registrations and successful model activity.
- [ ] Record visible console window events through installation, runner startup, gateway restart, and agent activity. Keep observation logs outside the repo and report the actual observation interval and any remaining gaps. Leave both agents running and provide the resulting status and source changes.

## Validation

Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test/windows-agents-bootstrap.test.ps1`, the Windows bootstrap suite, and relevant shell installer tests after changes. Run CozyAgents runner/process/exec tests and typecheck for its modified helpers. Do not publish releases until there is a concrete tested result and publication authorization.

# Public gateway split qualification — 2026-09-19

The public gateway retains Hermes administration, profiles, rooms, attach, notifications,
generic observer data, and Hermes execution on paired computers. CozyAgents provisioning,
its snapshot telemetry panels, and its installer product selection now belong to the embedded
`gateway/` in [CozyAgents PR #190](https://github.com/shiftedx/cozyagents/pull/190).
The shared relay remains canonical here. Existing generic attach contracts are retained;
this split does not introduce a new OpenClaw adapter.

Public bot creation advertises `botRuntimes: ["hermes"]` only with a configured Hermes endpoint,
and `[]` otherwise. Paired computers advertise `com.cozylabs.runners: 1` independently.
Only runners explicitly advertising Hermes execution receive Hermes work. Legacy CozyAgents
execution rows remain inert. Existing SQLite snapshot tables are not dropped.

POSIX and Windows installers refuse legacy `cozyagents` or `both` installation state before
modification. Existing `--harness hermes` automation remains accepted. Install another product
in its own state directory; this change does not migrate personal installations.

## Verification

Production source: `afb6c63eba058191583ee25ab36ac41cb1cfb5eb`, Node 24.19.0.

- `pnpm check`: all four package builds and type checks passed. Contract: 208 tests; relay: 164;
  gateway: 1,779 passed, 2 skipped; conformance: 116 passed, 20 skipped.
- `pnpm test:installer`: passed, captured directly with exit 0. Includes bootstrap transaction
  recovery, Hermes installation and native Windows path fixtures, plugin rollout, re-homing,
  and upgrade hygiene. Legacy state guards: 10 checks; final hygiene suite: 9 checks.
- Restored generic runner pairing/roster coverage: 51 tests passed.
- Full-history and final-delta secret scans, production dependency audit, and contract package
  validation passed. The final delta scan covered five commits and reported no leaks.

Durable logs are under `/Users/kmcdowell/Documents/repos/cozychat-audit-split-2026-09-19`:
`hermes-gateway-check-final.log`, `hermes-installer-parent-final.log`,
`hermes-gitleaks-final-delta.log`, and `hermes-gateway-legacy-state-guard.log`.
Earlier interrupted installer attempts are not passing evidence.

Windows behavior is covered with portable fixtures on macOS, including native-path HERMES_HOME
credential handling; no native Windows host or Docker daemon was available for qualification.
No personal service was reconfigured, and no deployment or release tag was created.
GitHub Actions jobs were rejected before execution by the account billing/spending limit;
local results are not hosted CI results.
